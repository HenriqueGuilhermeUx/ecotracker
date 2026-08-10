import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

type Json=Record<string,unknown>;
type Queryable={query:(text:string,values?:unknown[])=>Promise<{rows:any[]}>};

type ExecutionReviewInput={
  supplierSettlementMode:"supplier_invoice"|"prepaid"|"postpaid"|"manual_contract";
  proofSlaHours:number;
  authorizationTtlHours?:number;
  sourceAdapter?:string;
  retirementAdapter?:string;
  note?:string|null;
  actor?:string|null;
};

const hash=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const secretHash=(value:string)=>value?hash({secret:value}):"missing";
const actor=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const num=(value:unknown,fallback=0)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;};
const bool=(value:unknown)=>value===true||value==="true"||value===1||value==="1";

function endpoint(base:string|undefined,override:string|undefined,path:string){
  const direct=String(override||"").trim();if(direct)return direct;
  const raw=String(base||"").trim();if(!raw)return "";
  return `${raw.replace(/\/+$/,"")}/${path.replace(/^\/+/,"")}`;
}

function safeEndpoint(value:string){
  if(!value)return null;
  try{const url=new URL(value);return `${url.protocol}//${url.host}${url.pathname}`;}catch{return "invalid-url";}
}

function executionConfig(){
  const sourceBase=String(process.env.SOURCE_EXECUTOR_URL||"").trim();
  const sourceToken=String(process.env.SOURCE_EXECUTOR_TOKEN||"").trim();
  const retirementBase=String(process.env.RETIREMENT_EXECUTOR_URL||"").trim();
  const retirementToken=String(process.env.RETIREMENT_EXECUTOR_TOKEN||"").trim();
  const sourceHealth=endpoint(sourceBase,process.env.SOURCE_EXECUTOR_HEALTH_URL,"health");
  const sourceDryRun=endpoint(sourceBase,process.env.SOURCE_EXECUTOR_DRY_RUN_URL,"dry-run");
  const retirementHealth=endpoint(retirementBase,process.env.RETIREMENT_EXECUTOR_HEALTH_URL,"health");
  const retirementDryRun=endpoint(retirementBase,process.env.RETIREMENT_EXECUTOR_DRY_RUN_URL,"dry-run");
  const timeoutMs=Math.max(500,Math.min(15000,Math.round(num(process.env.ECOT_EXECUTION_PROBE_TIMEOUT_MS,5000))));
  const snapshot={
    source:{configured:Boolean(sourceBase&&sourceToken),base:safeEndpoint(sourceBase),health:safeEndpoint(sourceHealth),dryRun:safeEndpoint(sourceDryRun),tokenFingerprint:secretHash(sourceToken)},
    retirement:{configured:Boolean(retirementBase&&retirementToken),base:safeEndpoint(retirementBase),health:safeEndpoint(retirementHealth),dryRun:safeEndpoint(retirementDryRun),tokenFingerprint:secretHash(retirementToken)},
    timeoutMs,
  };
  return{sourceBase,sourceToken,retirementBase,retirementToken,sourceHealth,sourceDryRun,retirementHealth,retirementDryRun,timeoutMs,snapshot,fingerprint:hash(snapshot)};
}

async function executionBundle(assetId:number,q:Queryable=pool as unknown as Queryable){
  const {rows}=await q.query(`
    SELECT a.*,
           c.review_id AS intake_review_id,c.inventory_id,c.mandate_id,
           i.status AS intake_status,i.supplier_name,i.commercial_valid_until AS intake_commercial_valid_until,
           inv.status AS inventory_status,inv.authorized_tonnes AS inventory_authorized_tonnes,inv.sold_tonnes,
           GREATEST(0,inv.authorized_tonnes-inv.sold_tonnes-
             COALESCE((SELECT SUM(sr.reserved_tonnes) FROM supply_reservations sr
                       WHERE sr.inventory_id=inv.id AND sr.status IN ('active','pending')),0)) AS inventory_available_tonnes,
           m.status AS mandate_status,m.valid_until AS mandate_valid_until,m.floor_price_usd_tonne,
           er.id AS climate_review_id,er.applied_sha256 AS climate_review_applied_sha256,er.approved_at AS climate_review_approved_at
    FROM monitored_assets a
    LEFT JOIN supply_intake_conversions c ON c.monitored_asset_id=a.id
    LEFT JOIN supply_intake_reviews i ON i.id=c.review_id
    LEFT JOIN supply_inventory inv ON inv.id=c.inventory_id
    LEFT JOIN supplier_mandates m ON m.id=c.mandate_id
    LEFT JOIN LATERAL (
      SELECT r.id,r.applied_sha256,r.approved_at
      FROM asset_eligibility_reviews r
      WHERE r.asset_id=a.id AND r.status='approved'
      ORDER BY r.review_version DESC LIMIT 1
    ) er ON TRUE
    WHERE a.id=$1`,[assetId]);
  return rows[0]||null;
}

function baseState(row:Json){
  return{
    assetId:Number(row.id),sourceReference:row.source_reference,active:Boolean(row.active),registry:row.registry,
    registryProjectId:row.registry_project_id,registryBatchId:row.registry_batch_id,claimCategory:row.claim_category,
    eligibilityStatus:row.eligibility_status,sourceUnitStatus:row.source_unit_status,eligibilityCheckedAt:row.eligibility_checked_at,
    commercialValidUntil:row.commercial_valid_until,retirementSupported:Boolean(row.retirement_supported),
    beneficiaryRetirementSupported:Boolean(row.beneficiary_retirement_supported),sourcingShelf:row.sourcing_shelf,
    sourcingExecutable:Boolean(row.sourcing_executable),intakeReviewId:row.intake_review_id,inventoryId:row.inventory_id,mandateId:row.mandate_id,
    intakeStatus:row.intake_status,inventoryStatus:row.inventory_status,inventoryAuthorizedTonnes:num(row.inventory_authorized_tonnes),
    inventorySoldTonnes:num(row.sold_tonnes),inventoryAvailableTonnes:num(row.inventory_available_tonnes),mandateStatus:row.mandate_status,
    mandateValidUntil:row.mandate_valid_until,climateReviewId:row.climate_review_id,climateReviewAppliedSha256:row.climate_review_applied_sha256,
  };
}

async function probe(url:string,token:string,method:"GET"|"POST",payload?:Json,timeoutMs=5000){
  if(!url||!token)return{ok:false,configured:false,status:null,latencyMs:0,endpoint:safeEndpoint(url),reason:"executor_not_configured"};
  const started=Date.now();
  try{
    const response=await fetch(url,{
      method,headers:{Authorization:`Bearer ${token}`,Accept:"application/json",...(method==="POST"?{"Content-Type":"application/json"}:{})},
      body:method==="POST"?JSON.stringify(payload||{}):undefined,signal:AbortSignal.timeout(timeoutMs),
    });
    const raw=(await response.text()).slice(0,1500);let body:unknown=raw;
    try{body=raw?JSON.parse(raw):null;}catch{}
    const bodyOk=typeof body==="object"&&body!==null&&"ok" in body?(body as {ok:unknown}).ok!==false:true;
    return{ok:response.ok&&bodyOk,configured:true,status:response.status,latencyMs:Date.now()-started,endpoint:safeEndpoint(url),body};
  }catch(error){return{ok:false,configured:true,status:null,latencyMs:Date.now()-started,endpoint:safeEndpoint(url),reason:error instanceof Error?error.message:String(error)};}
}

function dryRunPayload(row:Json,operation:"acquisition"|"retirement"){
  return{mode:"dry_run",operation,noSideEffects:true,requestedKg:Math.max(1,Math.round(num(row.min_order_kg,1000))),asset:{
    id:Number(row.id),sourceReference:row.source_reference,registry:row.registry,registryProjectId:row.registry_project_id,
    registryBatchId:row.registry_batch_id,projectName:row.project_name,
  },beneficiary:operation==="retirement"?"EcoTracker execution readiness validation":undefined};
}

async function probeAdapters(row:Json){
  const config=executionConfig();
  const [sourceHealth,sourceDryRun,retirementHealth,retirementDryRun]=await Promise.all([
    probe(config.sourceHealth,config.sourceToken,"GET",undefined,config.timeoutMs),
    probe(config.sourceDryRun,config.sourceToken,"POST",dryRunPayload(row,"acquisition"),config.timeoutMs),
    probe(config.retirementHealth,config.retirementToken,"GET",undefined,config.timeoutMs),
    probe(config.retirementDryRun,config.retirementToken,"POST",dryRunPayload(row,"retirement"),config.timeoutMs),
  ]);
  return{config,source:{health:sourceHealth,dryRun:sourceDryRun,ready:sourceHealth.ok&&sourceDryRun.ok},retirement:{health:retirementHealth,dryRun:retirementDryRun,ready:retirementHealth.ok&&retirementDryRun.ok}};
}

function preview(row:Json,probes:Awaited<ReturnType<typeof probeAdapters>>,input:ExecutionReviewInput){
  const reasons:string[]=[];
  const supplyDirect=String(row.source_reference||"").startsWith("supply-intake:");
  const climate=evaluateAssetEligibility(row,"voluntary_offset",Number(row.min_order_kg||1000));
  const mandateActive=row.mandate_status==="active"&&(!row.mandate_valid_until||new Date(String(row.mandate_valid_until)).getTime()>Date.now());
  const inventoryReady=row.inventory_status==="available"&&num(row.inventory_available_tonnes)>0;
  const climateLedgerReady=Number(row.climate_review_id)>0&&String(row.climate_review_applied_sha256||"").length===64;
  if(!supplyDirect)reasons.push("execution_gate_v1_applies_only_to_supply_intake_assets");
  if(!climate.allowed)reasons.push(`climate_eligibility:${climate.reason}`);
  if(!climateLedgerReady)reasons.push("approved_climate_ledger_review_required");
  if(row.intake_status!=="converted")reasons.push("converted_supply_intake_required");
  if(!mandateActive)reasons.push("active_supplier_mandate_required");
  if(!inventoryReady)reasons.push("available_supply_inventory_required");
  if(!bool(row.retirement_supported)||!bool(row.beneficiary_retirement_supported))reasons.push("retirement_and_beneficiary_support_required");
  if(!probes.config.snapshot.source.configured)reasons.push("source_executor_not_configured");
  if(!probes.config.snapshot.retirement.configured)reasons.push("retirement_executor_not_configured");
  if(!probes.source.ready)reasons.push("source_executor_probe_failed");
  if(!probes.retirement.ready)reasons.push("retirement_executor_probe_failed");
  if(input.sourceAdapter!==undefined&&input.sourceAdapter!=="external_http_executor")reasons.push("unsupported_source_adapter");
  if(input.retirementAdapter!==undefined&&input.retirementAdapter!=="external_http_executor")reasons.push("unsupported_retirement_adapter");
  return{ready:reasons.length===0,reasons,supplyDirect,climateAllowed:climate.allowed,climateDecision:climate,climateLedgerReady,mandateActive,inventoryReady,
    sourceAdapterReady:probes.source.ready,retirementAdapterReady:probes.retirement.ready,executionAuthorization:false};
}

async function event(client:pg.PoolClient,input:{assetId:number;reviewId?:number|null;authorizationId?:number|null;type:string;actor?:string|null;payload?:Json}){
  await client.query(`INSERT INTO asset_execution_readiness_events(asset_id,review_id,authorization_id,event_type,actor,payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[input.assetId,input.reviewId||null,input.authorizationId||null,input.type,input.actor||null,JSON.stringify(input.payload||{})]);
}

export async function executionReadinessEnvironmentStatus(){
  const config=executionConfig();return{configFingerprint:config.fingerprint,source:config.snapshot.source,retirement:config.snapshot.retirement,timeoutMs:config.timeoutMs,
    note:"Config fingerprints hash executor tokens; raw credentials are never persisted or returned."};
}

export async function createExecutionReadinessReview(input:ExecutionReviewInput&{assetId:number}){
  const pending=(await pool.query(`SELECT * FROM asset_execution_readiness_reviews WHERE asset_id=$1 AND status='pending'`,[input.assetId])).rows[0];
  if(pending)return{review:pending,idempotent:true};
  const row=await executionBundle(input.assetId);if(!row)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
  if(!String(row.source_reference||"").startsWith("supply-intake:"))throw Object.assign(new Error("Execution Readiness Gate v1 é obrigatório apenas para ativos supply-intake"),{status:409});
  const proofSlaHours=Math.max(1,Math.min(720,Math.round(num(input.proofSlaHours))));
  const authorizationTtlHours=Math.max(1,Math.min(168,Math.round(num(input.authorizationTtlHours,Number(process.env.ECOT_EXECUTION_AUTH_TTL_HOURS||24)))));
  const normalized:ExecutionReviewInput={...input,proofSlaHours,authorizationTtlHours,sourceAdapter:input.sourceAdapter||"external_http_executor",retirementAdapter:input.retirementAdapter||"external_http_executor"};
  const probes=await probeAdapters(row);const pre=preview(row,probes,normalized);
  const baseFingerprint=hash(baseState(row));
  const snapshot={version:"ecotracker-execution-readiness-v1",asset:baseState(row),execution:{mode:"programmatic",sourceAdapter:normalized.sourceAdapter,
    retirementAdapter:normalized.retirementAdapter,supplierSettlementMode:normalized.supplierSettlementMode,proofSlaHours,authorizationTtlHours},
    configFingerprint:probes.config.fingerprint,config:probes.config.snapshot,sourceProbe:probes.source,retirementProbe:probes.retirement,preview:pre,createdAt:new Date().toISOString()};
  const proposedSha=hash(snapshot);const reviewedBy=actor(input.actor);
  const result=await withTransaction(async client=>{
    const locked=await executionBundle(input.assetId,client as unknown as Queryable);if(!locked)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
    if(hash(baseState(locked))!==baseFingerprint)throw Object.assign(new Error("Estado do ativo mudou durante os probes; recrie a review"),{status:409});
    const version=Number((await client.query(`SELECT COALESCE(MAX(review_version),0)+1 AS version FROM asset_execution_readiness_reviews WHERE asset_id=$1`,[input.assetId])).rows[0].version);
    const review=(await client.query(`INSERT INTO asset_execution_readiness_reviews(
      asset_id,review_version,status,execution_mode,source_adapter,retirement_adapter,supplier_settlement_mode,proof_sla_hours,
      authorization_ttl_hours,base_fingerprint,config_fingerprint,proposed_snapshot,proposed_sha256,source_probe,retirement_probe,preview,review_note
    ) VALUES($1,$2,'pending','programmatic',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15) RETURNING *`,[
      input.assetId,version,normalized.sourceAdapter,normalized.retirementAdapter,normalized.supplierSettlementMode,proofSlaHours,authorizationTtlHours,
      baseFingerprint,probes.config.fingerprint,JSON.stringify(snapshot),proposedSha,JSON.stringify(probes.source),JSON.stringify(probes.retirement),JSON.stringify(pre),input.note||null,
    ])).rows[0];
    await event(client,{assetId:input.assetId,reviewId:Number(review.id),type:"execution_review_created",actor:reviewedBy,payload:{proposedSha256:proposedSha,preview:pre}});
    return review;
  });
  return{review:result,preview:pre,idempotent:false};
}

export async function approveExecutionReadinessReview(input:{reviewId:number;reviewedBy?:string|null;note?:string|null}){
  const review=(await pool.query(`SELECT * FROM asset_execution_readiness_reviews WHERE id=$1`,[input.reviewId])).rows[0];
  if(!review)throw Object.assign(new Error("Execution Readiness Review não encontrada"),{status:404});
  if(review.status==="approved")return{review,authorization:(await pool.query(`SELECT * FROM asset_execution_authorizations WHERE review_id=$1`,[review.id])).rows[0]||null,alreadyApproved:true};
  if(review.status!=="pending")throw Object.assign(new Error(`Execution Readiness Review não pode ser aprovada em status ${review.status}`),{status:409});
  const row=await executionBundle(Number(review.asset_id));if(!row)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
  const config=executionConfig();
  if(hash(baseState(row))!==review.base_fingerprint||config.fingerprint!==review.config_fingerprint){
    const stale=(await pool.query(`UPDATE asset_execution_readiness_reviews SET status='stale',stale_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`,[review.id])).rows[0];
    throw Object.assign(new Error("Execution Readiness Review ficou obsoleta; ativo ou configuração mudou"),{status:409,review:stale});
  }
  const probes=await probeAdapters(row);const pre=preview(row,probes,{supplierSettlementMode:review.supplier_settlement_mode,proofSlaHours:Number(review.proof_sla_hours),
    authorizationTtlHours:Number(review.authorization_ttl_hours),sourceAdapter:review.source_adapter,retirementAdapter:review.retirement_adapter});
  if(!pre.ready)throw Object.assign(new Error(`Execution Readiness bloqueada: ${pre.reasons.join("; ")}`),{status:409,preview:pre});
  const reviewer=actor(input.reviewedBy);const validUntil=new Date(Date.now()+Number(review.authorization_ttl_hours)*3600_000);
  return withTransaction(async client=>{
    const lockedReview=(await client.query(`SELECT * FROM asset_execution_readiness_reviews WHERE id=$1 FOR UPDATE`,[review.id])).rows[0];
    if(!lockedReview||lockedReview.status!=="pending")throw Object.assign(new Error("Execution Readiness Review já foi decidida"),{status:409});
    const locked=await executionBundle(Number(review.asset_id),client as unknown as Queryable);if(!locked)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
    const currentConfig=executionConfig();
    if(hash(baseState(locked))!==lockedReview.base_fingerprint||currentConfig.fingerprint!==lockedReview.config_fingerprint){
      const stale=(await client.query(`UPDATE asset_execution_readiness_reviews SET status='stale',stale_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.id])).rows[0];
      await event(client,{assetId:Number(review.asset_id),reviewId:Number(review.id),type:"execution_review_stale",actor:reviewer,payload:{reason:"state_or_config_changed_after_probe"}});
      throw Object.assign(new Error("Execution Readiness Review ficou obsoleta após os probes"),{status:409,review:stale});
    }
    const authorization=(await client.query(`INSERT INTO asset_execution_authorizations(
      asset_id,review_id,status,execution_mode,source_adapter,retirement_adapter,supplier_settlement_mode,proof_sla_hours,
      config_fingerprint,authorized_by,authorized_at,valid_until,revoked_at,revoke_reason
    ) VALUES($1,$2,'active','programmatic',$3,$4,$5,$6,$7,$8,NOW(),$9,NULL,NULL)
    ON CONFLICT(asset_id) DO UPDATE SET review_id=EXCLUDED.review_id,status='active',execution_mode='programmatic',source_adapter=EXCLUDED.source_adapter,
      retirement_adapter=EXCLUDED.retirement_adapter,supplier_settlement_mode=EXCLUDED.supplier_settlement_mode,proof_sla_hours=EXCLUDED.proof_sla_hours,
      config_fingerprint=EXCLUDED.config_fingerprint,authorized_by=EXCLUDED.authorized_by,authorized_at=NOW(),valid_until=EXCLUDED.valid_until,
      revoked_at=NULL,revoke_reason=NULL,updated_at=NOW() RETURNING *`,[
      review.asset_id,review.id,review.source_adapter,review.retirement_adapter,review.supplier_settlement_mode,review.proof_sla_hours,
      lockedReview.config_fingerprint,reviewer,validUntil.toISOString(),
    ])).rows[0];
    const asset=(await client.query(`UPDATE monitored_assets SET sourcing_executable=TRUE,sourcing_checked_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.asset_id])).rows[0];
    const applied={version:"ecotracker-execution-authorization-v1",assetId:Number(review.asset_id),authorizationId:Number(authorization.id),
      configFingerprint:lockedReview.config_fingerprint,sourceProbe:probes.source,retirementProbe:probes.retirement,validUntil:authorization.valid_until,
      executionAuthorization:true,appliedAt:new Date().toISOString()};
    const appliedSha=hash(applied);
    const approved=(await client.query(`UPDATE asset_execution_readiness_reviews SET status='approved',reviewed_by=$2,review_note=COALESCE($3,review_note),
      approved_at=NOW(),applied_snapshot=$4::jsonb,applied_sha256=$5,source_probe=$6::jsonb,retirement_probe=$7::jsonb,preview=$8::jsonb,updated_at=NOW()
      WHERE id=$1 RETURNING *`,[review.id,reviewer,input.note||null,JSON.stringify(applied),appliedSha,JSON.stringify(probes.source),JSON.stringify(probes.retirement),JSON.stringify(pre)])).rows[0];
    await event(client,{assetId:Number(review.asset_id),reviewId:Number(review.id),authorizationId:Number(authorization.id),type:"execution_authorized",actor:reviewer,
      payload:{appliedSha256:appliedSha,validUntil:authorization.valid_until,configFingerprint:lockedReview.config_fingerprint}});
    return{review:approved,authorization,asset,preview:pre,alreadyApproved:false};
  });
}

export async function rejectExecutionReadinessReview(input:{reviewId:number;reason:string;reviewedBy?:string|null}){
  return withTransaction(async client=>{
    const review=(await client.query(`SELECT * FROM asset_execution_readiness_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if(!review)throw Object.assign(new Error("Execution Readiness Review não encontrada"),{status:404});
    if(review.status==="rejected")return review;if(review.status!=="pending")throw Object.assign(new Error(`Review não pode ser rejeitada em status ${review.status}`),{status:409});
    const reviewer=actor(input.reviewedBy);const rejected=(await client.query(`UPDATE asset_execution_readiness_reviews SET status='rejected',reviewed_by=$2,
      rejection_reason=$3,rejected_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.id,reviewer,input.reason])).rows[0];
    await event(client,{assetId:Number(review.asset_id),reviewId:Number(review.id),type:"execution_review_rejected",actor:reviewer,payload:{reason:input.reason}});return rejected;
  });
}

async function deactivateAuthorization(assetId:number,status:"revoked"|"expired",reason:string,who?:string|null){
  return withTransaction(async client=>{
    const authorization=(await client.query(`SELECT * FROM asset_execution_authorizations WHERE asset_id=$1 FOR UPDATE`,[assetId])).rows[0];
    if(!authorization)return null;
    const updated=(await client.query(`UPDATE asset_execution_authorizations SET status=$2::varchar(30),revoked_at=NOW(),revoke_reason=$3,updated_at=NOW() WHERE id=$1 RETURNING *`,[
      authorization.id,status,reason,
    ])).rows[0];
    await client.query(`UPDATE monitored_assets SET sourcing_executable=FALSE,sourcing_checked_at=NOW(),updated_at=NOW() WHERE id=$1`,[assetId]);
    await event(client,{assetId,reviewId:Number(authorization.review_id),authorizationId:Number(authorization.id),type:status==="expired"?"execution_authorization_expired":"execution_authorization_revoked",actor:actor(who),payload:{reason}});
    return updated;
  });
}

export async function revokeExecutionAuthorization(input:{assetId:number;reason:string;revokedBy?:string|null}){
  const updated=await deactivateAuthorization(input.assetId,"revoked",input.reason,input.revokedBy);
  if(!updated)throw Object.assign(new Error("Autorização de execução não encontrada"),{status:404});return updated;
}

export async function executionReadinessForAsset(assetId:number){
  const row=await executionBundle(assetId);if(!row)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
  const supplyDirect=String(row.source_reference||"").startsWith("supply-intake:");
  if(!supplyDirect)return{assetId,required:false,managedBy:"source_adapter",sourcingExecutable:Boolean(row.sourcing_executable)};
  let authorization=(await pool.query(`SELECT * FROM asset_execution_authorizations WHERE asset_id=$1`,[assetId])).rows[0]||null;
  if(authorization?.status==="active"&&new Date(authorization.valid_until).getTime()<=Date.now()){
    await deactivateAuthorization(assetId,"expired","authorization_ttl_expired","execution-readiness-worker");authorization={...authorization,status:"expired"};
  }
  const currentConfig=executionConfig();
  if(authorization?.status==="active"&&authorization.config_fingerprint!==currentConfig.fingerprint){
    await deactivateAuthorization(assetId,"revoked","executor_configuration_changed","execution-readiness-runtime");authorization={...authorization,status:"revoked"};
  }
  const ready=authorization?.status==="active"&&new Date(authorization.valid_until).getTime()>Date.now();
  if(!ready&&Boolean(row.sourcing_executable))await pool.query(`UPDATE monitored_assets SET sourcing_executable=FALSE,sourcing_checked_at=NOW(),updated_at=NOW() WHERE id=$1`,[assetId]);
  return{assetId,required:true,ready,authorization:authorization||null,configFingerprint:currentConfig.fingerprint,climateReviewId:row.climate_review_id,
    climateReviewAppliedSha256:row.climate_review_applied_sha256,sourcingExecutable:ready};
}

export async function assertAssetExecutionReady(assetId:number){
  const status=await executionReadinessForAsset(assetId);
  if(status.required&&status.ready!==true)throw Object.assign(new Error("Ativo supply-intake não possui Execution Readiness ativa"),{status:409,code:"EXECUTION_READINESS_REQUIRED",executionReadiness:status});
  return status;
}

export async function executionReadinessQueue(limit=100){
  const safeLimit=Math.max(1,Math.min(300,Math.round(limit)));
  const {rows}=await pool.query(`
    SELECT a.id AS asset_id,a.registry,a.project_name,a.source_reference,a.claim_category,a.eligibility_status,a.source_unit_status,
           a.sourcing_shelf,a.sourcing_executable,a.available_tons,a.registry_project_id,a.registry_batch_id,
           c.review_id AS intake_review_id,c.inventory_id,c.mandate_id,i.supplier_name,
           x.status AS authorization_status,x.valid_until,x.review_id AS authorization_review_id,
           r.id AS pending_review_id,r.status AS pending_review_status,r.preview AS pending_preview,r.proposed_sha256
    FROM monitored_assets a
    JOIN supply_intake_conversions c ON c.monitored_asset_id=a.id
    JOIN supply_intake_reviews i ON i.id=c.review_id
    LEFT JOIN asset_execution_authorizations x ON x.asset_id=a.id
    LEFT JOIN asset_execution_readiness_reviews r ON r.asset_id=a.id AND r.status='pending'
    WHERE a.active=TRUE AND a.source_reference LIKE 'supply-intake:%'
    ORDER BY CASE WHEN a.claim_category='voluntary_offset' AND a.eligibility_status='eligible' THEN 1 ELSE 2 END,
             CASE WHEN x.status='active' AND x.valid_until>NOW() THEN 2 ELSE 1 END,a.updated_at DESC LIMIT $1`,[safeLimit]);
  return rows;
}

export async function listExecutionReadinessReviews(input:{status?:string;limit?:number}={}){
  const status=String(input.status||"").trim();const limit=Math.max(1,Math.min(300,Math.round(input.limit||100)));
  const {rows}=await pool.query(`SELECT r.*,a.registry,a.project_name,a.source_reference,a.claim_category,a.eligibility_status,a.sourcing_shelf,a.sourcing_executable,
    x.status AS authorization_status,x.valid_until FROM asset_execution_readiness_reviews r JOIN monitored_assets a ON a.id=r.asset_id
    LEFT JOIN asset_execution_authorizations x ON x.review_id=r.id WHERE ($1='' OR r.status=$1)
    ORDER BY CASE r.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 WHEN 'stale' THEN 3 ELSE 4 END,r.created_at DESC LIMIT $2`,[status,limit]);return rows;
}

export async function expireExecutionAuthorizations(){
  const {rows}=await pool.query(`SELECT asset_id FROM asset_execution_authorizations WHERE status='active' AND valid_until<=NOW()`);
  for(const row of rows)await deactivateAuthorization(Number(row.asset_id),"expired","authorization_ttl_expired","execution-readiness-worker");
  return{expired:rows.length};
}

let timer:NodeJS.Timeout|null=null;
export function startExecutionReadinessWorker(){
  if(timer)return;
  const interval=Math.max(60_000,Math.min(3_600_000,Math.round(num(process.env.ECOT_EXECUTION_READINESS_INTERVAL_MS,300_000))));
  timer=setInterval(()=>void expireExecutionAuthorizations().catch(error=>console.warn("[execution-readiness] expiry sweep failed",error)),interval);
  timer.unref?.();
}
