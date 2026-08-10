import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initEligibilityReviewDb } from "../dist/eligibility-review-db.js";
import { createEligibilityReview,approveEligibilityReview } from "../dist/eligibility-review.js";

const tag=Date.now();
const futureDate="2026-12-31";
const futureDateTime="2026-12-31T23:59:59.000Z";

async function seed(name,{valid=true}={}){
  const evidence=valid?`https://example.com/eligibility/${name}/${tag}`:null;
  return (await pool.query(`INSERT INTO monitored_assets(
    registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,
    source_price_usd_ton,available_tons,min_order_kg,pricing_mode,availability_status,source_status,active,
    claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,offer_expires_at,
    registry_project_id,registry_batch_id,registry_evidence_url,retirement_supported,fractional_retirement_supported,retirement_granularity_kg,
    beneficiary_retirement_supported,ccp_status,eligibility_risk_flags,sourcing_shelf,sourcing_executable
  ) VALUES('Verra VCS',$1,$2,$3,'VM0047','Brasil','2026','carbon','screening',8.5,10000,1,'dynamic','confirmed','manual',TRUE,
    'climate_contribution','under_review','Aguardando ledger','unknown','2026-01-01','2026-08-01',$4::date,$5::timestamptz,$6,$7,$8,$9,$10,1,$11,'not_assessed',$12::jsonb,'restricted',FALSE) RETURNING *`,[
    `Eligibility ${name}`,`eligibility-${name}-${tag}`,`https://example.com/source/${name}/${tag}`,futureDate,futureDateTime,
    `PROJECT-${name}-${tag}`,`BATCH-${name}-${tag}`,evidence,valid,valid,valid,JSON.stringify(["awaiting-ledger-review"]),
  ])).rows[0];
}

function proposal(asset,{valid=true}={}){return{
  claimCategory:"voluntary_offset",eligibilityStatus:"eligible",eligibilityBasis:"Review ledger smoke.",sourceUnitStatus:"tradable",
  vintageStart:"2026-01-01",vintageEnd:"2026-08-01",commercialValidUntil:futureDate,offerExpiresAt:futureDateTime,
  registryProjectId:asset.registry_project_id,registryBatchId:asset.registry_batch_id,registryEvidenceUrl:valid?asset.registry_evidence_url:null,
  retirementSupported:valid,fractionalRetirementSupported:true,retirementGranularityKg:1,beneficiaryRetirementSupported:valid,ccpStatus:"not_assessed",
  riskFlags:valid?[]:["missing-registry-evidence","retirement-not-confirmed"],
};}

async function run(){
  await initDb();await initMarketDb();await initEligibilityDb();await initEligibilityReviewDb();
  const valid=await seed("valid",{valid:true});const stale=await seed("stale",{valid:true});const invalid=await seed("invalid",{valid:false});

  const created=await createEligibilityReview({assetId:Number(valid.id),purpose:"voluntary_offset",createdBy:"Eligibility Smoke",proposal:proposal(valid)});
  assert.equal(created.status,"pending");assert.equal(created.preview_decision.allowed,true);assert.equal(String(created.proposed_sha256).length,64);
  const duplicate=await createEligibilityReview({assetId:Number(valid.id),purpose:"voluntary_offset",createdBy:"Eligibility Smoke",proposal:proposal(valid)});
  assert.equal(Number(duplicate.id),Number(created.id));
  const approved=await approveEligibilityReview({reviewId:Number(created.id),reviewedBy:"Eligibility Smoke"});
  assert.equal(approved.review.status,"approved");assert.equal(approved.decision.allowed,true);assert.equal(String(approved.review.applied_sha256).length,64);
  assert.equal(approved.asset.claim_category,"voluntary_offset");assert.equal(approved.asset.eligibility_status,"eligible");
  assert.equal(approved.asset.sourcing_shelf,"verified_compensation");assert.equal(approved.asset.sourcing_executable,false,"Climate eligibility must not enable programmatic execution");
  const again=await approveEligibilityReview({reviewId:Number(created.id),reviewedBy:"Eligibility Smoke"});assert.equal(again.alreadyApproved,true);
  let immutable=false;try{await pool.query(`UPDATE asset_eligibility_reviews SET review_note='x' WHERE id=$1`,[created.id]);}catch(error){immutable=String(error?.message||error).includes("decided_eligibility_review_is_immutable");}assert.equal(immutable,true);

  const staleReview=await createEligibilityReview({assetId:Number(stale.id),purpose:"voluntary_offset",createdBy:"Eligibility Smoke",proposal:proposal(stale)});
  await pool.query(`UPDATE monitored_assets SET registry_evidence_url=$2,updated_at=NOW() WHERE id=$1`,[stale.id,`https://example.com/changed/${tag}`]);
  let staleBlocked=false;try{await approveEligibilityReview({reviewId:Number(staleReview.id),reviewedBy:"Eligibility Smoke"});}catch(error){staleBlocked=String(error?.message||error).includes("obsoleta");}assert.equal(staleBlocked,true);
  assert.equal((await pool.query(`SELECT status FROM asset_eligibility_reviews WHERE id=$1`,[staleReview.id])).rows[0].status,"stale");

  const invalidReview=await createEligibilityReview({assetId:Number(invalid.id),purpose:"voluntary_offset",createdBy:"Eligibility Smoke",proposal:proposal(invalid,{valid:false})});
  assert.equal(invalidReview.preview_decision.allowed,false);
  let invalidBlocked=false;try{await approveEligibilityReview({reviewId:Number(invalidReview.id),reviewedBy:"Eligibility Smoke"});}catch{invalidBlocked=true;}assert.equal(invalidBlocked,true);
  assert.equal((await pool.query(`SELECT status FROM asset_eligibility_reviews WHERE id=$1`,[invalidReview.id])).rows[0].status,"pending");

  console.log("Eligibility Review smoke OK",{approvedReviewId:Number(created.id),proposedSha256:created.proposed_sha256,appliedSha256:approved.review.applied_sha256,decidedReviewImmutable:immutable,staleReviewBlocked:staleBlocked,invalidPromotionBlocked:invalidBlocked,executionAuthorization:false});
}

try{await run();}finally{await pool.end();}
