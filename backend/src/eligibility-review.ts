import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { evaluateAssetEligibility, normalizeClaimPurpose } from "./eligibility-policy.js";

type Json=Record<string,unknown>;
export type EligibilityProposal={
  claimCategory?:string; eligibilityStatus?:string; eligibilityBasis?:string|null; sourceUnitStatus?:string;
  vintageStart?:string|null; vintageEnd?:string|null; issuanceDate?:string|null; commercialValidUntil?:string|null;
  offerExpiresAt?:string|null; registryProjectId?:string|null; registryBatchId?:string|null; registryEvidenceUrl?:string|null;
  retirementSupported?:boolean; fractionalRetirementSupported?:boolean; retirementGranularityKg?:number;
  beneficiaryRetirementSupported?:boolean; ccpStatus?:string; corsiaStatus?:string; article6Status?:string;
  vintagePolicyOverride?:boolean; vintageExceptionReason?:string|null; riskFlags?:string[];
};

const hash=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actor=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const iso=(value:unknown)=>value instanceof Date?value.toISOString():value==null?null:String(value);
const own=(obj:object,key:string)=>Object.prototype.hasOwnProperty.call(obj,key);

function state(asset:Json){return{
  id:Number(asset.id),active:Boolean(asset.active),sourceStatus:asset.source_status,registry:asset.registry,projectName:asset.project_name,
  sourceReference:asset.source_reference,claimCategory:asset.claim_category,eligibilityStatus:asset.eligibility_status,
  eligibilityBasis:asset.eligibility_basis,sourceUnitStatus:asset.source_unit_status,vintageStart:iso(asset.vintage_start),
  vintageEnd:iso(asset.vintage_end),issuanceDate:iso(asset.issuance_date),commercialValidUntil:iso(asset.commercial_valid_until),
  offerExpiresAt:iso(asset.offer_expires_at),registryProjectId:asset.registry_project_id,registryBatchId:asset.registry_batch_id,
  registryEvidenceUrl:asset.registry_evidence_url,retirementSupported:Boolean(asset.retirement_supported),
  fractionalRetirementSupported:Boolean(asset.fractional_retirement_supported),retirementGranularityKg:Number(asset.retirement_granularity_kg||1000),
  beneficiaryRetirementSupported:Boolean(asset.beneficiary_retirement_supported),ccpStatus:asset.ccp_status,corsiaStatus:asset.corsia_status,
  article6Status:asset.article6_status,vintagePolicyOverride:Boolean(asset.vintage_policy_override),vintageExceptionReason:asset.vintage_exception_reason,
  riskFlags:Array.isArray(asset.eligibility_risk_flags)?asset.eligibility_risk_flags:[],
};}

function proposed(asset:Json,p:EligibilityProposal){const c=state(asset);return{
  version:"ecotracker-eligibility-review-v2",
  asset:{id:Number(asset.id),registry:asset.registry,projectName:asset.project_name,sourceReference:asset.source_reference},
  fields:{
    claimCategory:own(p,"claimCategory")?p.claimCategory:c.claimCategory,
    eligibilityStatus:own(p,"eligibilityStatus")?p.eligibilityStatus:c.eligibilityStatus,
    eligibilityBasis:own(p,"eligibilityBasis")?p.eligibilityBasis:c.eligibilityBasis,
    sourceUnitStatus:own(p,"sourceUnitStatus")?p.sourceUnitStatus:c.sourceUnitStatus,
    vintageStart:own(p,"vintageStart")?p.vintageStart:c.vintageStart,vintageEnd:own(p,"vintageEnd")?p.vintageEnd:c.vintageEnd,
    issuanceDate:own(p,"issuanceDate")?p.issuanceDate:c.issuanceDate,commercialValidUntil:own(p,"commercialValidUntil")?p.commercialValidUntil:c.commercialValidUntil,
    offerExpiresAt:own(p,"offerExpiresAt")?p.offerExpiresAt:c.offerExpiresAt,registryProjectId:own(p,"registryProjectId")?p.registryProjectId:c.registryProjectId,
    registryBatchId:own(p,"registryBatchId")?p.registryBatchId:c.registryBatchId,registryEvidenceUrl:own(p,"registryEvidenceUrl")?p.registryEvidenceUrl:c.registryEvidenceUrl,
    retirementSupported:own(p,"retirementSupported")?Boolean(p.retirementSupported):c.retirementSupported,
    fractionalRetirementSupported:own(p,"fractionalRetirementSupported")?Boolean(p.fractionalRetirementSupported):c.fractionalRetirementSupported,
    retirementGranularityKg:own(p,"retirementGranularityKg")?Number(p.retirementGranularityKg):c.retirementGranularityKg,
    beneficiaryRetirementSupported:own(p,"beneficiaryRetirementSupported")?Boolean(p.beneficiaryRetirementSupported):c.beneficiaryRetirementSupported,
    ccpStatus:own(p,"ccpStatus")?p.ccpStatus:c.ccpStatus,corsiaStatus:own(p,"corsiaStatus")?p.corsiaStatus:c.corsiaStatus,
    article6Status:own(p,"article6Status")?p.article6Status:c.article6Status,
    vintagePolicyOverride:own(p,"vintagePolicyOverride")?Boolean(p.vintagePolicyOverride):c.vintagePolicyOverride,
    vintageExceptionReason:own(p,"vintageExceptionReason")?p.vintageExceptionReason:c.vintageExceptionReason,
    riskFlags:own(p,"riskFlags")?(p.riskFlags||[]):c.riskFlags,
  }
};}

function candidate(asset:Json,s:Json){const f=(s.fields||{}) as Json;return{...asset,
  claim_category:f.claimCategory,eligibility_status:f.eligibilityStatus,eligibility_basis:f.eligibilityBasis,source_unit_status:f.sourceUnitStatus,
  vintage_start:f.vintageStart,vintage_end:f.vintageEnd,issuance_date:f.issuanceDate,commercial_valid_until:f.commercialValidUntil,
  offer_expires_at:f.offerExpiresAt,registry_project_id:f.registryProjectId,registry_batch_id:f.registryBatchId,registry_evidence_url:f.registryEvidenceUrl,
  retirement_supported:f.retirementSupported,fractional_retirement_supported:f.fractionalRetirementSupported,
  retirement_granularity_kg:f.retirementGranularityKg,beneficiary_retirement_supported:f.beneficiaryRetirementSupported,
  ccp_status:f.ccpStatus,corsia_status:f.corsiaStatus,article6_status:f.article6Status,vintage_policy_override:f.vintagePolicyOverride,
  vintage_exception_reason:f.vintageExceptionReason,eligibility_risk_flags:f.riskFlags,eligibility_checked_at:new Date(),
};}

async function event(client:pg.PoolClient,input:{reviewId:number;assetId:number;type:string;actor?:string|null;payload?:Json}){
  await client.query(`INSERT INTO asset_eligibility_review_events(review_id,asset_id,event_type,actor,payload) VALUES($1,$2,$3,$4,$5::jsonb)`,[
    input.reviewId,input.assetId,input.type,input.actor||null,JSON.stringify(input.payload||{}),
  ]);
}

export async function createEligibilityReview(input:{assetId:number;proposal:EligibilityProposal;purpose?:string;createdBy?:string|null;note?:string|null}){
  return withTransaction(async client=>{
    const asset=(await client.query(`SELECT * FROM monitored_assets WHERE id=$1 FOR UPDATE`,[input.assetId])).rows[0];
    if(!asset)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
    const snapshot=proposed(asset,input.proposal); const proposedSha=hash(snapshot);
    const pending=(await client.query(`SELECT * FROM asset_eligibility_reviews WHERE asset_id=$1 AND status='pending' FOR UPDATE`,[input.assetId])).rows[0];
    if(pending){if(pending.proposed_sha256===proposedSha)return pending;throw Object.assign(new Error("Já existe uma Eligibility Review pendente para este ativo"),{status:409});}
    const purpose=normalizeClaimPurpose(input.purpose||String((snapshot.fields as Json).claimCategory||"voluntary_offset"));
    const preview=evaluateAssetEligibility(candidate(asset,snapshot),purpose,Number(asset.min_order_kg||1000));
    const version=Number((await client.query(`SELECT COALESCE(MAX(review_version),0)+1 AS version FROM asset_eligibility_reviews WHERE asset_id=$1`,[input.assetId])).rows[0].version);
    const row=(await client.query(`INSERT INTO asset_eligibility_reviews(asset_id,review_version,status,purpose,base_fingerprint,proposed_snapshot,proposed_sha256,preview_decision,review_note)
      VALUES($1,$2,'pending',$3,$4,$5::jsonb,$6,$7::jsonb,$8) RETURNING *`,[
      input.assetId,version,purpose,hash(state(asset)),JSON.stringify(snapshot),proposedSha,JSON.stringify(preview),input.note||null,
    ])).rows[0];
    await event(client,{reviewId:Number(row.id),assetId:input.assetId,type:"eligibility_review_created",actor:actor(input.createdBy),payload:{version,purpose,proposedSha256:proposedSha,preview}});
    return row;
  });
}

export async function approveEligibilityReview(input:{reviewId:number;reviewedBy?:string|null;note?:string|null}){
  const result=await withTransaction(async client=>{
    const review=(await client.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if(!review)throw Object.assign(new Error("Eligibility Review não encontrada"),{status:404});
    if(review.status==='approved')return{review,alreadyApproved:true};
    if(review.status!=='pending')throw Object.assign(new Error(`Eligibility Review não pode ser aprovada em status ${review.status}`),{status:409});
    const asset=(await client.query(`SELECT * FROM monitored_assets WHERE id=$1 FOR UPDATE`,[review.asset_id])).rows[0];
    if(!asset)throw Object.assign(new Error("Ativo não encontrado"),{status:404});
    const current=hash(state(asset));
    if(current!==review.base_fingerprint){
      const stale=(await client.query(`UPDATE asset_eligibility_reviews SET status='stale',stale_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.id])).rows[0];
      await event(client,{reviewId:Number(review.id),assetId:Number(asset.id),type:"eligibility_review_stale",actor:actor(input.reviewedBy),payload:{expected:review.base_fingerprint,current}});
      return{review:stale,stale:true};
    }
    const snapshot=review.proposed_snapshot as Json; const fields=(snapshot.fields||{}) as Json;
    const decision=evaluateAssetEligibility(candidate(asset,snapshot),normalizeClaimPurpose(review.purpose),Number(asset.min_order_kg||1000));
    const verified=fields.claimCategory==='voluntary_offset'&&fields.eligibilityStatus==='eligible';
    if(verified&&!decision.allowed)throw Object.assign(new Error(`Review não pode promover este ativo: ${decision.reason}`),{status:409,decision});
    const shelf=verified&&decision.allowed?'verified_compensation':decision.shelf==='climate_contribution'?'climate_contribution':'restricted';
    const updated=(await client.query(`UPDATE monitored_assets SET
      claim_category=$2::varchar(40),eligibility_status=$3::varchar(40),eligibility_basis=$4,source_unit_status=$5::varchar(40),
      vintage_start=$6::date,vintage_end=$7::date,issuance_date=$8::date,commercial_valid_until=$9::date,offer_expires_at=$10::timestamptz,
      registry_project_id=$11,registry_batch_id=$12,registry_evidence_url=$13,retirement_supported=$14,fractional_retirement_supported=$15,
      retirement_granularity_kg=$16,beneficiary_retirement_supported=$17,ccp_status=$18::varchar(40),corsia_status=$19::varchar(40),article6_status=$20::varchar(40),
      vintage_policy_override=$21,vintage_exception_reason=$22,eligibility_risk_flags=$23::jsonb,eligibility_checked_at=NOW(),
      sourcing_shelf=$24::varchar(40),sourcing_executable=FALSE,sourcing_checked_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[
      asset.id,fields.claimCategory,fields.eligibilityStatus,fields.eligibilityBasis,fields.sourceUnitStatus,fields.vintageStart,fields.vintageEnd,fields.issuanceDate,
      fields.commercialValidUntil,fields.offerExpiresAt,fields.registryProjectId,fields.registryBatchId,fields.registryEvidenceUrl,
      Boolean(fields.retirementSupported),Boolean(fields.fractionalRetirementSupported),Number(fields.retirementGranularityKg||1000),Boolean(fields.beneficiaryRetirementSupported),
      fields.ccpStatus,fields.corsiaStatus,fields.article6Status,Boolean(fields.vintagePolicyOverride),fields.vintageExceptionReason,JSON.stringify(fields.riskFlags||[]),shelf,
    ])).rows[0];
    const applied={version:"ecotracker-eligibility-applied-v2",asset:state(updated),decision,executionAuthorization:false,appliedAt:new Date().toISOString()};
    const appliedSha=hash(applied); const reviewer=actor(input.reviewedBy);
    const approved=(await client.query(`UPDATE asset_eligibility_reviews SET status='approved',review_note=COALESCE($2,review_note),reviewed_by=$3,approved_at=NOW(),applied_snapshot=$4::jsonb,applied_sha256=$5,decision=$6::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,[
      review.id,input.note||null,reviewer,JSON.stringify(applied),appliedSha,JSON.stringify(decision),
    ])).rows[0];
    await event(client,{reviewId:Number(review.id),assetId:Number(asset.id),type:"eligibility_review_approved",actor:reviewer,payload:{proposedSha256:review.proposed_sha256,appliedSha256:appliedSha,decision,executionAuthorization:false}});
    return{review:approved,asset:updated,decision,alreadyApproved:false};
  });
  if(result.stale)throw Object.assign(new Error("Eligibility Review ficou obsoleta porque o ativo mudou; crie uma nova review"),{status:409,review:result.review});
  return result;
}

export async function rejectEligibilityReview(input:{reviewId:number;reason:string;reviewedBy?:string|null}){
  return withTransaction(async client=>{
    const review=(await client.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if(!review)throw Object.assign(new Error("Eligibility Review não encontrada"),{status:404});
    if(review.status==='rejected')return review;
    if(review.status!=='pending')throw Object.assign(new Error(`Eligibility Review não pode ser rejeitada em status ${review.status}`),{status:409});
    const reviewer=actor(input.reviewedBy);
    const row=(await client.query(`UPDATE asset_eligibility_reviews SET status='rejected',rejection_reason=$2,reviewed_by=$3,rejected_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.id,input.reason,reviewer])).rows[0];
    await event(client,{reviewId:Number(review.id),assetId:Number(review.asset_id),type:"eligibility_review_rejected",actor:reviewer,payload:{reason:input.reason}});return row;
  });
}

export async function listEligibilityReviews(input:{status?:string;assetId?:number;limit?:number}={}){
  const status=String(input.status||'').trim(),assetId=Number(input.assetId||0),limit=Math.max(1,Math.min(300,Math.round(input.limit||100)));
  const {rows}=await pool.query(`SELECT r.*,a.registry,a.project_name,a.source_reference,a.claim_category AS current_claim_category,a.eligibility_status AS current_eligibility_status,
    a.source_unit_status AS current_source_unit_status,a.sourcing_shelf,a.sourcing_executable
    FROM asset_eligibility_reviews r JOIN monitored_assets a ON a.id=r.asset_id
    WHERE ($1='' OR r.status=$1) AND ($2=0 OR r.asset_id=$2)
    ORDER BY CASE r.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 WHEN 'stale' THEN 3 ELSE 4 END,r.created_at DESC LIMIT $3`,[status,assetId,limit]);
  return rows;
}

export async function getEligibilityReview(reviewId:number){
  const {rows}=await pool.query(`SELECT r.*,a.registry,a.project_name,a.source_reference,a.claim_category AS current_claim_category,a.eligibility_status AS current_eligibility_status,
    a.source_unit_status AS current_source_unit_status,a.sourcing_shelf,a.sourcing_executable,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'eventType',e.event_type,'actor',e.actor,'payload',e.payload,'createdAt',e.created_at) ORDER BY e.id)
      FROM asset_eligibility_review_events e WHERE e.review_id=r.id),'[]'::jsonb) AS events
    FROM asset_eligibility_reviews r JOIN monitored_assets a ON a.id=r.asset_id WHERE r.id=$1`,[reviewId]);return rows[0]||null;
}

export function directMutationRequiresLedger(asset:Json,p:EligibilityProposal){
  const s=proposed(asset,p),f=(s.fields||{}) as Json;
  return (asset.claim_category==='voluntary_offset'&&asset.eligibility_status==='eligible')||(f.claimCategory==='voluntary_offset'&&f.eligibilityStatus==='eligible');
}
