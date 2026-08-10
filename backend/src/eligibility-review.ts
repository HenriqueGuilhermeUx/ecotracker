import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { evaluateAssetEligibility, normalizeClaimPurpose } from "./eligibility-policy.js";

type Json = Record<string,unknown>;

export type EligibilityProposal = {
  claimCategory?:string;
  eligibilityStatus?:string;
  eligibilityBasis?:string|null;
  sourceUnitStatus?:string;
  vintageStart?:string|null;
  vintageEnd?:string|null;
  issuanceDate?:string|null;
  commercialValidUntil?:string|null;
  offerExpiresAt?:string|null;
  registryProjectId?:string|null;
  registryBatchId?:string|null;
  registryEvidenceUrl?:string|null;
  retirementSupported?:boolean;
  fractionalRetirementSupported?:boolean;
  retirementGranularityKg?:number;
  beneficiaryRetirementSupported?:boolean;
  ccpStatus?:string;
  corsiaStatus?:string;
  article6Status?:string;
  vintagePolicyOverride?:boolean;
  vintageExceptionReason?:string|null;
  riskFlags?:string[];
};

const sha256=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actorName=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const iso=(value:unknown)=>value instanceof Date?value.toISOString():value==null?null:String(value);

function baseState(asset:Json) {
  return {
    id:Number(asset.id),active:Boolean(asset.active),sourceStatus:asset.source_status,
    registry:asset.registry,projectName:asset.project_name,sourceReference:asset.source_reference,
    claimCategory:asset.claim_category,eligibilityStatus:asset.eligibility_status,eligibilityBasis:asset.eligibility_basis,
    sourceUnitStatus:asset.source_unit_status,vintageStart:iso(asset.vintage_start),vintageEnd:iso(asset.vintage_end),issuanceDate:iso(asset.issuance_date),
    commercialValidUntil:iso(asset.commercial_valid_until),offerExpiresAt:iso(asset.offer_expires_at),
    registryProjectId:asset.registry_project_id,registryBatchId:asset.registry_batch_id,registryEvidenceUrl:asset.registry_evidence_url,
    retirementSupported:Boolean(asset.retirement_supported),fractionalRetirementSupported:Boolean(asset.fractional_retirement_supported),
    retirementGranularityKg:Number(asset.retirement_granularity_kg||1000),beneficiaryRetirementSupported:Boolean(asset.beneficiary_retirement_supported),
    ccpStatus:asset.ccp_status,corsiaStatus:asset.corsia_status,article6Status:asset.article6_status,
    vintagePolicyOverride:Boolean(asset.vintage_policy_override),vintageExceptionReason:asset.vintage_exception_reason,
    riskFlags:Array.isArray(asset.eligibility_risk_flags)?asset.eligibility_risk_flags:[],
  };
}

function proposedState(asset:Json,proposal:EligibilityProposal) {
  const current=baseState(asset);
  const own=(key:keyof EligibilityProposal)=>Object.prototype.hasOwnProperty.call(proposal,key);
  return {
    version:"ecotracker-eligibility-review-v1",
    asset:{id:Number(asset.id),registry:asset.registry,projectName:asset.project_name,sourceReference:asset.source_reference},
    fields:{
      claimCategory:own("claimCategory")?proposal.claimCategory:current.claimCategory,
      eligibilityStatus:own("eligibilityStatus")?proposal.eligibilityStatus:current.eligibilityStatus,
      eligibilityBasis:own("eligibilityBasis")?proposal.eligibilityBasis:current.eligibilityBasis,
      sourceUnitStatus:own("sourceUnitStatus")?proposal.sourceUnitStatus:current.sourceUnitStatus,
      vintageStart:own("vintageStart")?proposal.vintageStart:current.vintageStart,
      vintageEnd:own("vintageEnd")?proposal.vintageEnd:current.vintageEnd,
      issuanceDate:own("issuanceDate")?proposal.issuanceDate:current.issuanceDate,
      commercialValidUntil:own("commercialValidUntil")?proposal.commercialValidUntil:current.commercialValidUntil,
      offerExpiresAt:own("offerExpiresAt")?proposal.offerExpiresAt:current.offerExpiresAt,
      registryProjectId:own("registryProjectId")?proposal.registryProjectId:current.registryProjectId,
      registryBatchId:own("registryBatchId")?proposal.registryBatchId:current.registryBatchId,
      registryEvidenceUrl:own("registryEvidenceUrl")?proposal.registryEvidenceUrl:current.registryEvidenceUrl,
      retirementSupported:own("retirementSupported")?Boolean(proposal.retirementSupported):current.retirementSupported,
      fractionalRetirementSupported:own("fractionalRetirementSupported")?Boolean(proposal.fractionalRetirementSupported):current.fractionalRetirementSupported,
      retirementGranularityKg:own("retirementGranularityKg")?Number(proposal.retirementGranularityKg):current.retirementGranularityKg,
      beneficiaryRetirementSupported:own("beneficiaryRetirementSupported")?Boolean(proposal.beneficiaryRetirementSupported):current.beneficiaryRetirementSupported,
      ccpStatus:own("ccpStatus")?proposal.ccpStatus:current.ccpStatus,
      corsiaStatus:own("corsiaStatus")?proposal.corsiaStatus:current.corsiaStatus,
      article6Status:own("article6Status")?proposal.article6Status:current.article6Status,
      vintagePolicyOverride:own("vintagePolicyOverride")?Boolean(proposal.vintagePolicyOverride):current.vintagePolicyOverride,
      vintageExceptionReason:own("vintageExceptionReason")?proposal.vintageExceptionReason:current.vintageExceptionReason,
      riskFlags:own("riskFlags")?(proposal.riskFlags||[]):current.riskFlags,
    },
  };
}

function candidateFromSnapshot(asset:Json,snapshot:Json) {
  const fields=(snapshot.fields||{}) as Json;
  return {
    ...asset,
    claim_category:fields.claimCategory,
    eligibility_status:fields.eligibilityStatus,
    eligibility_basis:fields.eligibilityBasis,
    source_unit_status:fields.sourceUnitStatus,
    vintage_start:fields.vintageStart,
    vintage_end:fields.vintageEnd,
    issuance_date:fields.issuanceDate,
    commercial_valid_until:fields.commercialValidUntil,
    offer_expires_at:fields.offerExpiresAt,
    registry_project_id:fields.registryProjectId,
    registry_batch_id:fields.registryBatchId,
    registry_evidence_url:fields.registryEvidenceUrl,
    retirement_supported:fields.retirementSupported,
    fractional_retirement_supported:fields.fractionalRetirementSupported,
    retirement_granularity_kg:fields.retirementGranularityKg,
    beneficiary_retirement_supported:fields.beneficiaryRetirementSupported,
    ccp_status:fields.ccpStatus,
    corsia_status:fields.corsiaStatus,
    article6_status:fields.article6Status,
    vintage_policy_override:fields.vintagePolicyOverride,
    vintage_exception_reason:fields.vintageExceptionReason,
    eligibility_risk_flags:fields.riskFlags,
    eligibility_checked_at:new Date(),
  };
}

async function reviewEvent(client:pg.PoolClient,input:{reviewId:number;assetId:number;eventType:string;actor?:string|null;payload?:Json}) {
  await client.query(`INSERT INTO asset_eligibility_review_events(review_id,asset_id,event_type,actor,payload) VALUES($1,$2,$3,$4,$5::jsonb)`,[
    input.reviewId,input.assetId,input.eventType,input.actor||null,JSON.stringify(input.payload||{}),
  ]);
}

export async function createEligibilityReview(input:{assetId:number;proposal:EligibilityProposal;purpose?:string;createdBy?:string|null;note?:string|null}) {
  return withTransaction(async(client)=>{
    const asset=(await client.query(`SELECT * FROM monitored_assets WHERE id=$1 FOR UPDATE`,[input.assetId])).rows[0];
    if(!asset) throw Object.assign(new Error("Ativo não encontrado"),{status:404});
    const existing=(await client.query(`SELECT * FROM asset_eligibility_reviews WHERE asset_id=$1 AND status='pending' FOR UPDATE`,[input.assetId])).rows[0];
    const snapshot=proposedState(asset,input.proposal);
    const proposedSha=sha256(snapshot);
    if(existing){
      if(existing.proposed_sha256===proposedSha) return existing;
      throw Object.assign(new Error("Já existe uma Eligibility Review pendente para este ativo; decida ou rejeite antes de abrir outra"),{status:409});
    }
    const purpose=normalizeClaimPurpose(input.purpose||String((snapshot.fields as Json).claimCategory||"voluntary_offset"));
    const candidate=candidateFromSnapshot(asset,snapshot);
    const preview=evaluateAssetEligibility(candidate,purpose,Number(asset.min_order_kg||1000));
    const version=Number((await client.query(`SELECT COALESCE(MAX(review_version),0)+1 AS version FROM asset_eligibility_reviews WHERE asset_id=$1`,[input.assetId])).rows[0].version);
    const baseFingerprint=sha256(baseState(asset));
    const actor=actorName(input.createdBy);
    const review=(await client.query(`
      INSERT INTO asset_eligibility_reviews(
        asset_id,review_version,status,purpose,base_fingerprint,proposed_snapshot,proposed_sha256,preview_decision,review_note
      ) VALUES($1,$2,'pending',$3,$4,$5::jsonb,$6,$7::jsonb,$8) RETURNING *`,[
      input.assetId,version,purpose,baseFingerprint,JSON.stringify(snapshot),proposedSha,JSON.stringify(preview),input.note||null,
    ])).rows[0];
    await reviewEvent(client,{reviewId:Number(review.id),assetId:input.assetId,eventType:"eligibility_review_created",actor,payload:{version,purpose,proposedSha256:proposedSha,preview}});
    return review;
  });
}

export async function approveEligibilityReview(input:{reviewId:number;reviewedBy?:string|null;note?:string|null}) {
  const result=await withTransaction(async(client)=>{
    const review=(await client.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if(!review) throw Object.assign(new Error("Eligibility Review não encontrada"),{status:404});
    if(review.status==='approved') return {review,alreadyApproved:true};
    if(review.status!=='pending') throw Object.assign(new Error(`Eligibility Review não pode ser aprovada em status ${review.status}`),{status:409});
    const asset=(await client.query(`SELECT * FROM monitored_assets WHERE id=$1 FOR UPDATE`,[review.asset_id])).rows[0];
    if(!asset) throw Object.assign(new Error("Ativo não encontrado"),{status:404});
    const currentFingerprint=sha256(baseState(asset));
    if(currentFingerprint!==review.base_fingerprint){
      const stale=(await client.query(`UPDATE asset_eligibility_reviews SET status='stale',stale_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.id])).rows[0];
      await reviewEvent(client,{reviewId:Number(review.id),assetId:Number(review.asset_id),eventType:"eligibility_review_stale",actor:actorName(input.reviewedBy),payload:{expected:review.base_fingerprint,current:currentFingerprint}});
      return {review:stale,stale:true};
    }
    const snapshot=review.proposed_snapshot as Json;
    const fields=(snapshot.fields||{}) as Json;
    const candidate=candidateFromSnapshot(asset,snapshot);
    const purpose=normalizeClaimPurpose(review.purpose);
    const decision=evaluateAssetEligibility(candidate,purpose,Number(asset.min_order_kg||1000));
    const requestsVerifiedOffset=fields.claimCategory==='voluntary_offset'&&fields.eligibilityStatus==='eligible';
    if(requestsVerifiedOffset&&!decision.allowed){
      throw Object.assign(new Error(`Review não pode promover este ativo: ${decision.reason}`),{status:409,decision});
    }
    const shelf=requestsVerifiedOffset&&decision.allowed?'verified_compensation':decision.shelf==='climate_contribution'?'climate_contribution':'restricted';
    const executable=requestsVerifiedOffset&&decision.allowed;
    const updated=(await client.query(`
      UPDATE monitored_assets SET
        claim_category=$2::varchar(40),eligibility_status=$3::varchar(40),eligibility_basis=$4,
        source_unit_status=$5::varchar(40),vintage_start=$6::date,vintage_end=$7::date,issuance_date=$8::date,
        commercial_valid_until=$9::date,offer_expires_at=$10::timestamptz,
        registry_project_id=$11,registry_batch_id=$12,registry_evidence_url=$13,
        retirement_supported=$14,fractional_retirement_supported=$15,retirement_granularity_kg=$16,
        beneficiary_retirement_supported=$17,ccp_status=$18::varchar(40),corsia_status=$19::varchar(40),article6_status=$20::varchar(40),
        vintage_policy_override=$21,vintage_exception_reason=$22,eligibility_risk_flags=$23::jsonb,
        eligibility_checked_at=NOW(),sourcing_shelf=$24::varchar(40),sourcing_executable=$25,sourcing_checked_at=NOW(),updated_at=NOW()
      WHERE id=$1 RETURNING *`,[
      asset.id,fields.claimCategory,fields.eligibilityStatus,fields.eligibilityBasis,fields.sourceUnitStatus,
      fields.vintageStart,fields.vintageEnd,fields.issuanceDate,fields.commercialValidUntil,fields.offerExpiresAt,
      fields.registryProjectId,fields.registryBatchId,fields.registryEvidenceUrl,
      Boolean(fields.retirementSupported),Boolean(fields.fractionalRetirementSupported),Number(fields.retirementGranularityKg||1000),
      Boolean(fields.beneficiaryRetirementSupported),fields.ccpStatus,fields.corsiaStatus,fields.article6Status,
      Boolean(fields.vintagePolicyOverride),fields.vintageExceptionReason,JSON.stringify(fields.riskFlags||[]),shelf,executable,
    ])).rows[0];
    const applied={version:"ecotracker-eligibility-applied-v1",asset:baseState(updated),decision,appliedAt:new Date().toISOString()};
    const appliedSha=sha256(applied);
    const actor=actorName(input.reviewedBy);
    const approved=(await client.query(`
      UPDATE asset_eligibility_reviews SET status='approved',review_note=COALESCE($2,review_note),reviewed_by=$3,approved_at=NOW(),
        applied_snapshot=$4::jsonb,applied_sha256=$5,decision=$6::jsonb,updated_at=NOW()
      WHERE id=$1 RETURNING *`,[review.id,input.note||null,actor,JSON.stringify(applied),appliedSha,JSON.stringify(decision)])).rows[0];
    await reviewEvent(client,{reviewId:Number(review.id),assetId:Number(asset.id),eventType:"eligibility_review_approved",actor,payload:{proposedSha256:review.proposed_sha256,appliedSha256:appliedSha,decision}});
    return {review:approved,asset:updated,decision,alreadyApproved:false};
  });
  if(result.stale) throw Object.assign(new Error("Eligibility Review ficou obsoleta porque o ativo mudou; crie uma nova review"),{status:409,review:result.review});
  return result;
}

export async function rejectEligibilityReview(input:{reviewId:number;reason:string;reviewedBy?:string|null}) {
  return withTransaction(async(client)=>{
    const review=(await client.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if(!review) throw Object.assign(new Error("Eligibility Review não encontrada"),{status:404});
    if(review.status==='rejected') return review;
    if(review.status!=='pending') throw Object.assign(new Error(`Eligibility Review não pode ser rejeitada em status ${review.status}`),{status:409});
    const actor=actorName(input.reviewedBy);
    const rejected=(await client.query(`UPDATE asset_eligibility_reviews SET status='rejected',rejection_reason=$2,reviewed_by=$3,rejected_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[review.id,input.reason,actor])).rows[0];
    await reviewEvent(client,{reviewId:Number(review.id),assetId:Number(review.asset_id),eventType:"eligibility_review_rejected",actor,payload:{reason:input.reason}});
    return rejected;
  });
}

export async function listEligibilityReviews(input:{status?:string;assetId?:number;limit?:number}={}) {
  const status=String(input.status||'').trim();
  const assetId=Number(input.assetId||0);
  const limit=Math.max(1,Math.min(300,Math.round(input.limit||100)));
  const {rows}=await pool.query(`
    SELECT r.*,a.registry,a.project_name,a.source_reference,a.claim_category AS current_claim_category,
           a.eligibility_status AS current_eligibility_status,a.source_unit_status AS current_source_unit_status,
           a.sourcing_shelf,a.sourcing_executable
    FROM asset_eligibility_reviews r JOIN monitored_assets a ON a.id=r.asset_id
    WHERE ($1='' OR r.status=$1) AND ($2=0 OR r.asset_id=$2)
    ORDER BY CASE r.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 WHEN 'stale' THEN 3 ELSE 4 END,r.created_at DESC
    LIMIT $3`,[status,assetId,limit]);
  return rows;
}

export async function getEligibilityReview(reviewId:number) {
  const {rows}=await pool.query(`
    SELECT r.*,a.registry,a.project_name,a.source_reference,a.claim_category AS current_claim_category,
           a.eligibility_status AS current_eligibility_status,a.source_unit_status AS current_source_unit_status,
           a.sourcing_shelf,a.sourcing_executable,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'eventType',e.event_type,'actor',e.actor,'payload',e.payload,'createdAt',e.created_at) ORDER BY e.id)
             FROM asset_eligibility_review_events e WHERE e.review_id=r.id),'[]'::jsonb) AS events
    FROM asset_eligibility_reviews r JOIN monitored_assets a ON a.id=r.asset_id WHERE r.id=$1`,[reviewId]);
  return rows[0]||null;
}

export function directMutationRequiresLedger(asset:Json,proposal:EligibilityProposal) {
  const snapshot=proposedState(asset,proposal);
  const fields=(snapshot.fields||{}) as Json;
  return (asset.claim_category==='voluntary_offset'&&asset.eligibility_status==='eligible')
    || (fields.claimCategory==='voluntary_offset'&&fields.eligibilityStatus==='eligible');
}
