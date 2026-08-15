import crypto from "node:crypto";
import { pool, withTransaction } from "./db.js";
import { createCarbonmarkShadowQuote } from "./carbonmark-rail.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";
import { generateDemandMatches } from "./demand-matching.js";
import { upsertDemandSupplyRfq } from "./demand-supply-rfq.js";

type Json=Record<string,unknown>;

type ApprovalInput={
  qualificationId:number;
  reviewedBy?:string|null;
  eligibilityBasis:string;
  tradabilityConfirmed:boolean;
  commercialValidUntil:string;
  registryEvidenceUrl?:string|null;
  retirementSupported:boolean;
  beneficiaryRetirementSupported:boolean;
  fractionalRetirementSupported?:boolean;
  retirementGranularityKg?:number;
  ccpStatus?:"approved"|"eligible_program"|"not_approved"|"not_assessed";
  vintageStart?:string|null;
  vintageEnd?:string|null;
  riskFlags?:string[];
};

const num=(value:unknown,fallback=0)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;};
const bool=(value:unknown)=>value===true||value==="true"||value===1||value==="1";
const actorName=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const sha256=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const details=(asset:Json)=>asset.monitor_details&&typeof asset.monitor_details==="object"&&!Array.isArray(asset.monitor_details)?asset.monitor_details as Json:{};
const providerKey=(asset:Json)=>String(details(asset).providerKey||"").trim().toLowerCase()||String(asset.source_reference||"").split("-")[0].toLowerCase();
const isCarbonmark=(asset:Json)=>providerKey(asset)==="carbonmark"||String(asset.source_reference||"").startsWith("carbonmark-");
const cleanRiskFlags=(values:unknown)=>Array.isArray(values)?[...new Set(values.map((item)=>String(item||"").trim()).filter(Boolean))].slice(0,30):[];

async function candidateContext(assetId:number){
  const {rows}=await pool.query(`
    SELECT c.id AS candidate_id,c.rfq_id,r.opportunity_id,r.gap_tonnes,r.priority_score,r.status AS rfq_status,
           c.candidate_tonnes,c.status AS candidate_status
    FROM market_maker_rfq_candidates c
    JOIN market_maker_rfqs r ON r.id=c.rfq_id
    WHERE c.monitored_asset_id=$1 AND c.candidate_type='market_signal' AND c.status<>'stale'
      AND r.status IN ('open','partially_sourced')
    ORDER BY r.priority_score DESC,r.gap_tonnes DESC,c.sourcing_score DESC,c.id
    LIMIT 1`,[assetId]);
  return rows[0]||null;
}

async function qualificationView(id:number){
  const {rows}=await pool.query(`
    SELECT q.*,a.registry,a.project_name,a.source_reference,a.source_url,a.registry_evidence_url,
           a.claim_category,a.eligibility_status,a.source_unit_status,a.sourcing_shelf,a.sourcing_executable,
           a.retirement_supported,a.beneficiary_retirement_supported,a.available_tons,a.min_order_kg,
           r.public_code AS rfq_public_code,r.status AS rfq_status,r.gap_tonnes,
           c.public_code AS candidate_public_code,c.sourcing_score,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'eventType',e.event_type,'actor',e.actor,'payload',e.payload,'createdAt',e.created_at
           ) ORDER BY e.id) FROM market_signal_qualification_events e WHERE e.qualification_id=q.id),'[]'::jsonb) AS events
    FROM market_signal_qualifications q
    JOIN monitored_assets a ON a.id=q.monitored_asset_id
    LEFT JOIN market_maker_rfqs r ON r.id=q.rfq_id
    LEFT JOIN market_maker_rfq_candidates c ON c.id=q.candidate_id
    WHERE q.id=$1`,[id]);
  return rows[0]||null;
}

async function event(qualificationId:number,eventType:string,actor:string,payload:Json={}){
  await pool.query(`INSERT INTO market_signal_qualification_events(qualification_id,event_type,actor,payload)
    VALUES($1,$2,$3,$4::jsonb)`,[qualificationId,eventType,actor,JSON.stringify(payload)]);
}

async function insertProbeRecord(input:{
  asset:Json;context:Json|null;actor:string;requestedKg:number;probedKg:number;status:string;
  commercialVolumeProven:boolean;shadowQuote?:Json|null;error?:string|null;
}){
  const provider=providerKey(input.asset)||"unknown";
  const shadow=input.shadowQuote||{};
  const evidenceUrl=String(input.asset.registry_evidence_url||input.asset.source_url||"").trim()||null;
  const snapshot={
    version:"ecotracker-market-signal-qualification-v1",
    monitoredAssetId:Number(input.asset.id),provider,registry:input.asset.registry,projectName:input.asset.project_name,
    sourceReference:input.asset.source_reference,requestedKg:input.requestedKg,probedKg:input.probedKg,
    commercialVolumeProven:input.commercialVolumeProven,
    candidateContext:input.context?{
      candidateId:Number(input.context.candidate_id),rfqId:Number(input.context.rfq_id),opportunityId:Number(input.context.opportunity_id),
      gapTonnes:num(input.context.gap_tonnes),candidateTonnes:num(input.context.candidate_tonnes),
    }:null,
    shadowQuoteId:shadow.id??null,quoteUuid:shadow.quote_uuid??null,costUsdcTonne:shadow.cost_usdc_tonne??null,
    evidenceUrl,error:input.error||null,createdBy:input.actor,observedAt:new Date().toISOString(),
    invariant:"Provider quote is evidence of a quotable market path, not seller-confirmed inventory and not climate eligibility. No order, payment or retirement is created.",
  };
  const hash=sha256(snapshot);
  const {rows}=await pool.query(`
    INSERT INTO market_signal_qualifications(
      monitored_asset_id,rfq_id,candidate_id,opportunity_id,provider,status,requested_kg,probed_kg,
      commercial_volume_proven,shadow_quote_id,provider_quote_uuid,provider_cost_usdc_tonne,
      observed_available_tonnes,evidence_url,created_by,probe_snapshot,probe_sha256
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
    RETURNING *`,[
    input.asset.id,input.context?.rfq_id??null,input.context?.candidate_id??null,input.context?.opportunity_id??null,
    provider,input.status,input.requestedKg,input.probedKg,input.commercialVolumeProven,shadow.id??null,
    shadow.quote_uuid??null,shadow.cost_usdc_tonne??null,num(input.asset.available_tons,0),evidenceUrl,input.actor,JSON.stringify(snapshot),hash,
  ]);
  const record=rows[0];
  await event(Number(record.id),"market_signal_probe_recorded",input.actor,{status:input.status,probeSha256:hash,commercialVolumeProven:input.commercialVolumeProven,error:input.error||null});
  return qualificationView(Number(record.id));
}

export async function probeMarketSignal(input:{assetId:number;requestedKg?:number;createdBy?:string|null}){
  const actor=actorName(input.createdBy);
  const {rows}=await pool.query(`SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE`,[input.assetId]);
  const asset=rows[0] as Json|undefined;
  if(!asset) throw Object.assign(new Error("Ativo monitorado não encontrado"),{status:404});
  if(!isCarbonmark(asset)) throw Object.assign(new Error("Provider ainda não possui probe automatizado neste gate"),{status:409,code:"PROVIDER_PROBE_NOT_AUTOMATED",provider:providerKey(asset)});
  const context=await candidateContext(input.assetId);
  if(!context) throw Object.assign(new Error("Ativo não está associado a um market signal ativo em RFQ aberto"),{status:409,code:"ACTIVE_MARKET_SIGNAL_REQUIRED"});

  const minimum=Math.max(1,Math.round(num(asset.min_order_kg,1)));
  const naturalKg=Math.max(minimum,Math.round(Math.min(num(context.gap_tonnes),num(context.candidate_tonnes),num(asset.available_tons))*1000));
  const requestedKg=Math.max(minimum,Math.min(10_000_000,Math.round(num(input.requestedKg,naturalKg))));
  if(requestedKg<=0) throw Object.assign(new Error("Quantidade de probe inválida"),{status:400});

  try{
    const quote=await createCarbonmarkShadowQuote({assetId:input.assetId,requestedKg,createdBy:actor}) as unknown as Json;
    return insertProbeRecord({asset,context,actor,requestedKg,probedKg:requestedKg,status:"probed",commercialVolumeProven:true,shadowQuote:quote});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    const maxExceeded=/maximum quotable quantity exceeded/i.test(message);
    const diagnosticKg=Math.max(minimum,1);
    if(maxExceeded&&diagnosticKg<requestedKg){
      try{
        const diagnostic=await createCarbonmarkShadowQuote({assetId:input.assetId,requestedKg:diagnosticKg,createdBy:actor}) as unknown as Json;
        return insertProbeRecord({
          asset,context,actor,requestedKg,probedKg:diagnosticKg,status:"diagnostic_only",commercialVolumeProven:false,
          shadowQuote:diagnostic,error:`Volume total não cotável nesta chamada: ${message}`,
        });
      }catch(diagnosticError){
        const diagnosticMessage=diagnosticError instanceof Error?diagnosticError.message:String(diagnosticError);
        const record=await insertProbeRecord({asset,context,actor,requestedKg,probedKg:diagnosticKg,status:"probe_failed",commercialVolumeProven:false,error:`${message}; diagnóstico: ${diagnosticMessage}`});
        throw Object.assign(new Error("Carbonmark respondeu, mas o market signal não pôde ser qualificado nem no volume diagnóstico"),{status:409,code:"MARKET_SIGNAL_PROBE_FAILED",qualification:record});
      }
    }
    const record=await insertProbeRecord({asset,context,actor,requestedKg,probedKg:requestedKg,status:"probe_failed",commercialVolumeProven:false,error:message});
    throw Object.assign(new Error(`Market signal não qualificado: ${message}`),{status:409,code:"MARKET_SIGNAL_PROBE_FAILED",qualification:record});
  }
}

export async function submitMarketSignalEligibilityReview(input:{qualificationId:number;submittedBy?:string|null}){
  const actor=actorName(input.submittedBy);
  const result=await withTransaction(async(client)=>{
    const {rows}=await client.query(`
      SELECT q.*,a.active,a.eligibility_status,a.claim_category
      FROM market_signal_qualifications q JOIN monitored_assets a ON a.id=q.monitored_asset_id
      WHERE q.id=$1 FOR UPDATE OF q,a`,[input.qualificationId]);
    const row=rows[0];
    if(!row) throw Object.assign(new Error("Qualificação não encontrada"),{status:404});
    if(row.status==="qualified") return {qualificationId:Number(row.id),assetId:Number(row.monitored_asset_id),idempotent:true};
    if(row.status==="eligibility_review") return {qualificationId:Number(row.id),assetId:Number(row.monitored_asset_id),idempotent:true};
    if(row.status!=="probed"||row.commercial_volume_proven!==true) {
      throw Object.assign(new Error("Eligibility review exige shadow quote válida para o volume solicitado"),{status:409,code:"FULL_VOLUME_PROBE_REQUIRED"});
    }
    await client.query(`UPDATE market_signal_qualifications SET status='eligibility_review',submitted_for_review_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.id]);
    await client.query(`UPDATE monitored_assets SET eligibility_status='under_review',sourcing_shelf='restricted',sourcing_executable=FALSE,updated_at=NOW() WHERE id=$1`,[row.monitored_asset_id]);
    return {qualificationId:Number(row.id),assetId:Number(row.monitored_asset_id),idempotent:false};
  });
  if(!result.idempotent) await event(result.qualificationId,"eligibility_review_submitted",actor,{assetId:result.assetId,sourcingExecutable:false});
  return qualificationView(result.qualificationId);
}

function approvalProblems(row:Json,input:ApprovalInput){
  const problems:string[]=[];
  if(String(row.status)!=="eligibility_review") problems.push("qualificação ainda não está em eligibility review");
  if(row.commercial_volume_proven!==true) problems.push("volume comercial solicitado não foi provado por shadow quote");
  if(!input.tradabilityConfirmed) problems.push("tradability não confirmada explicitamente");
  if(String(input.eligibilityBasis||"").trim().length<20) problems.push("fundamentação de elegibilidade insuficiente");
  if(!input.retirementSupported) problems.push("retirement precisa estar confirmado");
  if(!input.beneficiaryRetirementSupported) problems.push("retirement em nome do beneficiário precisa estar confirmado");
  const validUntil=Date.parse(input.commercialValidUntil);
  if(!Number.isFinite(validUntil)||validUntil<=Date.now()) problems.push("validade comercial precisa ser futura");
  const evidence=String(input.registryEvidenceUrl||row.registry_evidence_url||row.source_url||"").trim();
  if(!evidence) problems.push("evidência pública de registry/projeto ausente");
  return problems;
}

async function refreshLinkedDemand(opportunityId:number|null){
  if(!opportunityId) return {matching:null,rfq:null,error:null};
  try{
    const matching=await generateDemandMatches(opportunityId);
    const rfq=await upsertDemandSupplyRfq({
      opportunityId,targetTonnes:Number(matching.targetTonnes||0),coveredTonnes:Number(matching.coveredTonnes||0),
      gapTonnes:Number(matching.uncoveredTonnes||0),source:"market_signal_qualification",
    });
    return {matching,rfq,error:null};
  }catch(error){return {matching:null,rfq:null,error:error instanceof Error?error.message:String(error)};}
}

export async function approveMarketSignalEligibility(input:ApprovalInput){
  const actor=actorName(input.reviewedBy);
  const decision=await withTransaction(async(client)=>{
    const {rows}=await client.query(`
      SELECT q.*,a.*,
        q.id AS qualification_id,q.status AS qualification_status,q.requested_kg AS qualification_requested_kg,
        q.commercial_volume_proven AS qualification_commercial_volume_proven,q.opportunity_id AS qualification_opportunity_id
      FROM market_signal_qualifications q JOIN monitored_assets a ON a.id=q.monitored_asset_id
      WHERE q.id=$1 FOR UPDATE OF q,a`,[input.qualificationId]);
    const row=rows[0] as Json|undefined;
    if(!row) throw Object.assign(new Error("Qualificação não encontrada"),{status:404});
    if(String(row.qualification_status)==="qualified") return {qualificationId:Number(row.qualification_id),assetId:Number(row.monitored_asset_id),opportunityId:num(row.qualification_opportunity_id,0)||null,idempotent:true};
    const normalizedRow={...row,status:row.qualification_status,commercial_volume_proven:row.qualification_commercial_volume_proven};
    const problems=approvalProblems(normalizedRow,input);
    if(problems.length) throw Object.assign(new Error(`Market signal ainda não está claim-ready: ${problems.join("; ")}`),{status:409,code:"MARKET_SIGNAL_ELIGIBILITY_BLOCKED",problems});

    const riskFlags=cleanRiskFlags(input.riskFlags);
    const evidence=String(input.registryEvidenceUrl||row.registry_evidence_url||row.source_url||"").trim();
    const basis=String(input.eligibilityBasis).trim();
    const ccpStatus=input.ccpStatus||"not_assessed";
    const granularity=Math.max(1,Math.round(num(input.retirementGranularityKg,row.retirement_granularity_kg||1000)));
    const {rows:updatedRows}=await client.query(`
      UPDATE monitored_assets SET
        claim_category='voluntary_offset',eligibility_status='eligible',eligibility_basis=$2,
        source_unit_status='tradable',commercial_valid_until=$3::date,registry_evidence_url=$4,
        retirement_supported=$5,beneficiary_retirement_supported=$6,
        fractional_retirement_supported=$7,retirement_granularity_kg=$8,
        ccp_status=$9,vintage_start=COALESCE($10::date,vintage_start),vintage_end=COALESCE($11::date,vintage_end),
        eligibility_risk_flags=$12::jsonb,eligibility_checked_at=NOW(),sourcing_shelf='verified_compensation',
        sourcing_executable=FALSE,sourcing_checked_at=NOW(),updated_at=NOW()
      WHERE id=$1 RETURNING *`,[
      row.monitored_asset_id,basis,input.commercialValidUntil,evidence,input.retirementSupported,input.beneficiaryRetirementSupported,
      Boolean(input.fractionalRetirementSupported),granularity,ccpStatus,input.vintageStart??null,input.vintageEnd??null,JSON.stringify(riskFlags),
    ]);
    const asset=updatedRows[0];
    const requestedKg=Math.max(1,Math.round(num(row.qualification_requested_kg)));
    const offsetDecision=evaluateAssetEligibility(asset,"voluntary_offset",requestedKg);
    if(!offsetDecision.allowed) throw Object.assign(new Error(`Ativo continua não elegível após revisão: ${offsetDecision.reason}`),{status:409,code:"POST_REVIEW_POLICY_BLOCK",decision:offsetDecision});
    if(bool(asset.sourcing_executable)) throw new Error("Integridade violada: claim-ready não pode ativar execução programática");

    const snapshot={
      version:"ecotracker-market-signal-eligibility-v1",qualificationId:Number(row.qualification_id),monitoredAssetId:Number(row.monitored_asset_id),
      requestedKg,provider:row.provider,providerQuoteUuid:row.provider_quote_uuid,probeSha256:row.probe_sha256,
      registry:asset.registry,projectName:asset.project_name,registryProjectId:asset.registry_project_id,
      claimCategory:asset.claim_category,eligibilityStatus:asset.eligibility_status,sourceUnitStatus:asset.source_unit_status,
      commercialValidUntil:asset.commercial_valid_until,registryEvidenceUrl:asset.registry_evidence_url,
      retirementSupported:Boolean(asset.retirement_supported),beneficiaryRetirementSupported:Boolean(asset.beneficiary_retirement_supported),
      fractionalRetirementSupported:Boolean(asset.fractional_retirement_supported),retirementGranularityKg:Number(asset.retirement_granularity_kg),
      ccpStatus:asset.ccp_status,riskFlags,eligibilityBasis:basis,offsetDecision,reviewedBy:actor,reviewedAt:new Date().toISOString(),
      sourcingExecutable:false,
      invariant:"Claim-ready approval is independent from Carbonmark production execution. No order, payment or retirement is created by this review.",
    };
    const hash=sha256(snapshot);
    await client.query(`UPDATE market_signal_qualifications SET status='qualified',approval_snapshot=$2::jsonb,approval_sha256=$3,qualified_at=NOW(),updated_at=NOW() WHERE id=$1`,[
      row.qualification_id,JSON.stringify(snapshot),hash,
    ]);
    return {qualificationId:Number(row.qualification_id),assetId:Number(row.monitored_asset_id),opportunityId:num(row.qualification_opportunity_id,0)||null,idempotent:false,approvalSha256:hash,offsetDecision};
  });

  if(!decision.idempotent) await event(decision.qualificationId,"market_signal_claim_ready_approved",actor,{approvalSha256:decision.approvalSha256,offsetDecision:decision.offsetDecision,sourcingExecutable:false});
  const linked=await refreshLinkedDemand(decision.opportunityId);
  return {...await qualificationView(decision.qualificationId),...linked};
}

export async function listMarketSignalQualifications(input:{status?:string;limit?:number}={}){
  const status=String(input.status||"").trim();
  const limit=Math.max(1,Math.min(200,Math.round(input.limit||100)));
  const {rows}=await pool.query(`
    SELECT q.*,a.registry,a.project_name,a.source_reference,a.claim_category,a.eligibility_status,a.source_unit_status,
           a.sourcing_shelf,a.sourcing_executable,a.available_tons,a.min_order_kg,
           r.public_code AS rfq_public_code,r.status AS rfq_status,r.gap_tonnes,
           c.public_code AS candidate_public_code,c.sourcing_score
    FROM market_signal_qualifications q
    JOIN monitored_assets a ON a.id=q.monitored_asset_id
    LEFT JOIN market_maker_rfqs r ON r.id=q.rfq_id
    LEFT JOIN market_maker_rfq_candidates c ON c.id=q.candidate_id
    WHERE ($1='' OR q.status=$1)
    ORDER BY q.created_at DESC LIMIT $2`,[status,limit]);
  return rows;
}
