import crypto from "node:crypto";
import { pool, withTransaction } from "./db.js";
import { generateDemandMatches } from "./demand-matching.js";
import { upsertDemandSupplyRfq } from "./demand-supply-rfq.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

type Json = Record<string,unknown>;

type ApprovalInput = {
  intakeReviewId:number;
  reviewedBy?:string|null;
  eligibilityBasis:string;
  tradabilityConfirmed:boolean;
  ccpStatus?:"approved"|"eligible_program"|"not_approved"|"not_assessed";
  vintagePolicyOverride?:boolean;
  vintageExceptionReason?:string|null;
  riskFlags?:string[];
};

type RestrictInput = {
  intakeReviewId:number;
  reviewedBy?:string|null;
  reason:string;
  riskFlags?:string[];
};

const num = (value:unknown,fallback=0) => {
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:fallback;
};

const bool = (value:unknown) => value===true || value==="true" || value===1 || value==="1";

function actorName(value?:string|null) {
  const explicit=String(value||"").trim();
  return (explicit || String(process.env.ADMIN_EMAIL || "ecotracker-admin")).slice(0,255);
}

function sha256(value:unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanRiskFlags(values:unknown) {
  if (!Array.isArray(values)) return [] as string[];
  return [...new Set(values.map((item)=>String(item||"").trim()).filter(Boolean))].slice(0,30);
}

async function queueRows() {
  const {rows}=await pool.query(`
    SELECT
      r.id AS intake_review_id,r.public_code AS intake_public_code,r.status AS intake_status,
      r.registry,r.registry_project_id,r.project_name,r.supplier_name,r.authorized_tonnes,
      r.batch_reference,r.vintage,r.methodology,r.registry_evidence_url,r.source_url,
      r.retirement_supported,r.beneficiary_retirement_supported,r.fractional_retirement_supported,
      r.retirement_granularity_kg,r.commercial_valid_until,r.approval_sha256 AS intake_approval_sha256,
      conv.mandate_id,conv.inventory_id,conv.monitored_asset_id,
      rfq.id AS rfq_id,rfq.public_code AS rfq_public_code,rfq.status AS rfq_status,
      rfq.opportunity_id,rfq.gap_tonnes,rfq.target_tonnes,
      a.company_name AS buyer_company_name,
      er.id AS eligibility_review_id,er.public_code AS eligibility_public_code,
      er.status AS eligibility_review_status,er.eligibility_basis AS reviewed_eligibility_basis,
      er.reviewed_by,er.reviewed_at,er.review_sha256,er.risk_flags AS reviewed_risk_flags,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'eventType',ee.event_type,'actor',ee.actor,'payload',ee.payload,'createdAt',ee.created_at
      ) ORDER BY ee.id) FROM supply_eligibility_events ee WHERE ee.review_id=er.id),'[]'::jsonb) AS eligibility_events,
      to_jsonb(ma) AS asset
    FROM supply_intake_reviews r
    JOIN supply_intake_conversions conv ON conv.review_id=r.id
    JOIN monitored_assets ma ON ma.id=conv.monitored_asset_id
    JOIN market_maker_rfqs rfq ON rfq.id=r.rfq_id
    JOIN demand_accounts a ON a.id=rfq.account_id
    LEFT JOIN supply_eligibility_reviews er ON er.intake_review_id=r.id
    WHERE r.status='converted'
    ORDER BY CASE
      WHEN er.id IS NULL AND ma.eligibility_status='under_review' THEN 1
      WHEN er.status='approved' THEN 2
      WHEN er.status='restricted' THEN 3
      ELSE 4 END,
      r.updated_at DESC
  `);
  return rows;
}

export async function listSupplyEligibilityQueue() {
  const rows=await queueRows();
  return rows.map((row)=>{
    const asset=(row.asset && typeof row.asset==="object" ? row.asset : {}) as Json;
    const requestedKg=Math.max(1,Math.round(num(row.authorized_tonnes)*1000));
    return {
      ...row,
      offsetDecision:evaluateAssetEligibility(asset,"voluntary_offset",requestedKg),
      executionState:bool(asset.sourcing_executable)?"programmatic":"assisted_or_manual",
      integrityNote:"Claim-ready e execução programática são gates independentes.",
    };
  });
}

async function lockedContext(client:Parameters<Parameters<typeof withTransaction>[0]>[0],intakeReviewId:number) {
  const {rows}=await client.query(`
    SELECT r.*,conv.monitored_asset_id,conv.mandate_id,conv.inventory_id,
           rfq.opportunity_id,rfq.status AS current_rfq_status,rfq.gap_tonnes AS current_gap_tonnes,
           ma.claim_category AS asset_claim_category,ma.eligibility_status AS asset_eligibility_status,
           ma.eligibility_basis AS asset_eligibility_basis,ma.source_unit_status AS asset_source_unit_status,
           ma.vintage_start,ma.vintage_end,ma.commercial_valid_until AS asset_commercial_valid_until,
           ma.registry_project_id AS asset_registry_project_id,ma.registry_batch_id AS asset_registry_batch_id,
           ma.registry_evidence_url AS asset_registry_evidence_url,ma.source_url AS asset_source_url,
           ma.retirement_supported AS asset_retirement_supported,
           ma.beneficiary_retirement_supported AS asset_beneficiary_retirement_supported,
           ma.fractional_retirement_supported AS asset_fractional_retirement_supported,
           ma.retirement_granularity_kg AS asset_retirement_granularity_kg,
           ma.sourcing_shelf AS asset_sourcing_shelf,ma.sourcing_executable AS asset_sourcing_executable,
           ma.eligibility_risk_flags AS asset_risk_flags
    FROM supply_intake_reviews r
    JOIN supply_intake_conversions conv ON conv.review_id=r.id
    JOIN market_maker_rfqs rfq ON rfq.id=r.rfq_id
    JOIN monitored_assets ma ON ma.id=conv.monitored_asset_id
    WHERE r.id=$1
    FOR UPDATE OF r,rfq,ma`,[intakeReviewId]);
  return rows[0] || null;
}

function approvalProblems(row:Json,input:ApprovalInput) {
  const problems:string[]=[];
  if (String(row.status)!=="converted") problems.push("Supply Intake ainda não foi convertido");
  if (String(row.legal_kyc_status)!=="approved") problems.push("KYC/legal não aprovado no intake");
  if (String(row.registry_evidence_status)!=="verified") problems.push("evidência registral do intake não verificada");
  if (String(row.commercial_terms_status)!=="approved") problems.push("termos comerciais do intake não aprovados");
  if (!String(row.batch_reference||"").trim()) problems.push("batch/reference ausente");
  if (!String(row.registry_project_id||"").trim()) problems.push("registry project id ausente");
  if (!String(row.asset_registry_evidence_url||row.registry_evidence_url||row.asset_source_url||row.source_url||"").trim()) problems.push("evidência pública do registry/projeto ausente");
  if (!bool(row.asset_retirement_supported)) problems.push("retirement não suportado");
  if (!bool(row.asset_beneficiary_retirement_supported)) problems.push("retirement em nome do beneficiário não suportado");
  if (!input.tradabilityConfirmed) problems.push("tradability não confirmada explicitamente");
  if (String(input.eligibilityBasis||"").trim().length<20) problems.push("fundamentação de elegibilidade insuficiente");
  const validUntil=row.asset_commercial_valid_until || row.commercial_valid_until;
  if (!validUntil) problems.push("validade comercial ausente");
  else if (new Date(String(validUntil)).getTime()<=Date.now()) problems.push("validade comercial expirada");
  if (input.vintagePolicyOverride && !String(input.vintageExceptionReason||"").trim()) problems.push("override de vintage exige justificativa");
  return problems;
}

async function refreshLinkedDemand(input:{opportunityId:number;reviewId:number;actor:string}) {
  try {
    const matching=await generateDemandMatches(input.opportunityId);
    const rfq=await upsertDemandSupplyRfq({
      opportunityId:input.opportunityId,
      targetTonnes:Number(matching.targetTonnes||0),
      coveredTonnes:Number(matching.coveredTonnes||0),
      gapTonnes:Number(matching.uncoveredTonnes||0),
      source:"supply_eligibility_review",
    });
    await pool.query(`
      INSERT INTO supply_eligibility_events(review_id,event_type,actor,payload)
      VALUES($1,'matching_refreshed',$2,$3::jsonb)`,[
      input.reviewId,input.actor,JSON.stringify({
        fullyCovered:Boolean(matching.fullyCovered),coveredTonnes:Number(matching.coveredTonnes||0),
        uncoveredTonnes:Number(matching.uncoveredTonnes||0),rfqId:rfq?.id??null,rfqStatus:rfq?.status??null,
      }),
    ]);
    return {matching,rfq,error:null};
  } catch(error) {
    const message=error instanceof Error?error.message:String(error);
    await pool.query(`
      INSERT INTO supply_eligibility_events(review_id,event_type,actor,payload)
      VALUES($1,'matching_refresh_failed',$2,$3::jsonb)`,[
      input.reviewId,input.actor,JSON.stringify({error:message}),
    ]).catch(()=>undefined);
    return {matching:null,rfq:null,error:message};
  }
}

export async function approveSupplyEligibility(input:ApprovalInput) {
  const actor=actorName(input.reviewedBy);
  const decision=await withTransaction(async(client)=>{
    const row=await lockedContext(client,input.intakeReviewId);
    if(!row) throw Object.assign(new Error("Supply Intake convertido não encontrado"),{status:404});

    const existing=(await client.query(`SELECT * FROM supply_eligibility_reviews WHERE intake_review_id=$1 FOR UPDATE`,[input.intakeReviewId])).rows[0];
    if(existing) {
      if(existing.status!=="approved") throw Object.assign(new Error("Eligibility deste intake já recebeu decisão restritiva final"),{status:409});
      return {review:existing,assetId:Number(row.monitored_asset_id),opportunityId:Number(row.opportunity_id),idempotent:true};
    }

    const problems=approvalProblems(row,input);
    if(problems.length) throw Object.assign(new Error(`Supply Eligibility ainda não aprovável: ${problems.join("; ")}`),{status:409,problems});

    const riskFlags=cleanRiskFlags(input.riskFlags);
    const ccpStatus=input.ccpStatus||"not_assessed";
    const basis=String(input.eligibilityBasis).trim();
    const updated=(await client.query(`
      UPDATE monitored_assets SET
        claim_category='voluntary_offset',
        eligibility_status='eligible',
        eligibility_basis=$2,
        source_unit_status='tradable',
        ccp_status=$3,
        vintage_policy_override=$4,
        vintage_exception_reason=$5,
        eligibility_risk_flags=$6::jsonb,
        eligibility_checked_at=NOW(),
        sourcing_shelf='verified_compensation',
        sourcing_executable=FALSE,
        sourcing_checked_at=NOW(),
        updated_at=NOW()
      WHERE id=$1 RETURNING *`,[
      row.monitored_asset_id,basis,ccpStatus,Boolean(input.vintagePolicyOverride),input.vintageExceptionReason??null,JSON.stringify(riskFlags),
    ])).rows[0];

    const requestedKg=Math.max(1,Math.round(num(row.authorized_tonnes)*1000));
    const offsetDecision=evaluateAssetEligibility(updated,"voluntary_offset",requestedKg);
    if(!offsetDecision.allowed) {
      throw Object.assign(new Error(`Ativo continua não elegível após a revisão: ${offsetDecision.reason}`),{status:409,decision:offsetDecision});
    }
    if(bool(updated.sourcing_executable)) throw new Error("Integridade violada: eligibility não pode ativar execução programática");

    const snapshot={
      version:"ecotracker-supply-eligibility-v1",
      intakeReviewId:Number(row.id),monitoredAssetId:Number(row.monitored_asset_id),rfqId:Number(row.rfq_id),opportunityId:Number(row.opportunity_id),
      supplierName:row.supplier_name,registry:row.registry,registryProjectId:row.registry_project_id,batchReference:row.batch_reference,
      authorizedTonnes:num(row.authorized_tonnes),claimCategory:updated.claim_category,eligibilityStatus:updated.eligibility_status,
      sourceUnitStatus:updated.source_unit_status,eligibilityBasis:basis,ccpStatus,
      vintagePolicyOverride:Boolean(input.vintagePolicyOverride),vintageExceptionReason:input.vintageExceptionReason??null,
      riskFlags,sourcingShelf:updated.sourcing_shelf,sourcingExecutable:Boolean(updated.sourcing_executable),
      offsetDecision,reviewedBy:actor,reviewedAt:new Date().toISOString(),
      integrityDisclosure:"Claim-ready approval does not activate a provider rail or programmatic execution.",
    };
    const hash=sha256(snapshot);
    const review=(await client.query(`
      INSERT INTO supply_eligibility_reviews(
        intake_review_id,monitored_asset_id,rfq_id,opportunity_id,status,eligibility_basis,source_unit_status,
        ccp_status,vintage_policy_override,vintage_exception_reason,risk_flags,reviewed_by,review_snapshot,review_sha256,matching_snapshot
      ) VALUES($1,$2,$3,$4,'approved',$5,'tradable',$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13::jsonb)
      RETURNING *`,[
      row.id,row.monitored_asset_id,row.rfq_id,row.opportunity_id,basis,ccpStatus,Boolean(input.vintagePolicyOverride),
      input.vintageExceptionReason??null,JSON.stringify(riskFlags),actor,JSON.stringify(snapshot),hash,
      JSON.stringify({before:{rfqStatus:row.current_rfq_status,gapTonnes:num(row.current_gap_tonnes)}}),
    ])).rows[0];
    await client.query(`INSERT INTO supply_eligibility_events(review_id,event_type,actor,payload) VALUES($1,'eligibility_approved',$2,$3::jsonb)`,[
      review.id,actor,JSON.stringify({reviewSha256:hash,offsetDecision,sourcingExecutable:false}),
    ]);
    return {review,assetId:Number(row.monitored_asset_id),opportunityId:Number(row.opportunity_id),idempotent:false};
  });

  const linked=await refreshLinkedDemand({opportunityId:decision.opportunityId,reviewId:Number(decision.review.id),actor});
  const asset=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[decision.assetId])).rows[0];
  return {...decision,asset,offsetDecision:evaluateAssetEligibility(asset,"voluntary_offset",Math.max(1,Number(asset.min_order_kg||1000))),...linked};
}

export async function restrictSupplyEligibility(input:RestrictInput) {
  const actor=actorName(input.reviewedBy);
  return withTransaction(async(client)=>{
    const row=await lockedContext(client,input.intakeReviewId);
    if(!row) throw Object.assign(new Error("Supply Intake convertido não encontrado"),{status:404});
    const existing=(await client.query(`SELECT * FROM supply_eligibility_reviews WHERE intake_review_id=$1 FOR UPDATE`,[input.intakeReviewId])).rows[0];
    if(existing) {
      if(existing.status!=="restricted") throw Object.assign(new Error("Eligibility deste intake já foi aprovada e é imutável"),{status:409});
      return {review:existing,idempotent:true};
    }
    const reason=String(input.reason||"").trim();
    if(reason.length<10) throw Object.assign(new Error("Justificativa de restrição muito curta"),{status:400});
    const riskFlags=cleanRiskFlags(input.riskFlags?.length?input.riskFlags:["supply-eligibility-restricted"]);
    const asset=(await client.query(`
      UPDATE monitored_assets SET
        claim_category='climate_contribution',eligibility_status='restricted',eligibility_basis=$2,
        eligibility_risk_flags=$3::jsonb,eligibility_checked_at=NOW(),sourcing_shelf='restricted',
        sourcing_executable=FALSE,sourcing_checked_at=NOW(),updated_at=NOW()
      WHERE id=$1 RETURNING *`,[row.monitored_asset_id,reason,JSON.stringify(riskFlags)])).rows[0];
    const snapshot={
      version:"ecotracker-supply-eligibility-v1",intakeReviewId:Number(row.id),monitoredAssetId:Number(row.monitored_asset_id),
      rfqId:Number(row.rfq_id),opportunityId:Number(row.opportunity_id),status:"restricted",reason,riskFlags,
      claimCategory:asset.claim_category,eligibilityStatus:asset.eligibility_status,sourcingShelf:asset.sourcing_shelf,
      sourcingExecutable:Boolean(asset.sourcing_executable),reviewedBy:actor,reviewedAt:new Date().toISOString(),
    };
    const hash=sha256(snapshot);
    const review=(await client.query(`
      INSERT INTO supply_eligibility_reviews(
        intake_review_id,monitored_asset_id,rfq_id,opportunity_id,status,eligibility_basis,source_unit_status,
        risk_flags,reviewed_by,review_snapshot,review_sha256,matching_snapshot
      ) VALUES($1,$2,$3,$4,'restricted',$5,$6,$7::jsonb,$8,$9::jsonb,$10,'{}'::jsonb) RETURNING *`,[
      row.id,row.monitored_asset_id,row.rfq_id,row.opportunity_id,reason,String(asset.source_unit_status||"unknown"),
      JSON.stringify(riskFlags),actor,JSON.stringify(snapshot),hash,
    ])).rows[0];
    await client.query(`INSERT INTO supply_eligibility_events(review_id,event_type,actor,payload) VALUES($1,'eligibility_restricted',$2,$3::jsonb)`,[
      review.id,actor,JSON.stringify({reviewSha256:hash,reason,riskFlags}),
    ]);
    return {review,asset,idempotent:false};
  });
}
