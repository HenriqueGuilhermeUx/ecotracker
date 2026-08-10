import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initEligibilityReviewDb } from "../dist/eligibility-review-db.js";
import { createAdminToken } from "../dist/auth.js";
import { registerEligibilityRoutes } from "../dist/eligibility-routes.js";
import { registerEligibilityReviewRoutes } from "../dist/eligibility-review-routes.js";

const tag=Date.now();
const futureDate="2026-12-31";
const futureDateTime="2026-12-31T23:59:59.000Z";

async function init(){
  await initDb();
  await initMarketDb();
  await initEligibilityDb();
  await initEligibilityReviewDb();
}

async function seedAsset(name,{valid=true}={}){
  const evidence=`https://example.com/eligibility/${name}/${tag}`;
  const {rows}=await pool.query(`
    INSERT INTO monitored_assets(
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,
      source_price_usd_ton,available_tons,min_order_kg,pricing_mode,availability_status,source_status,active,
      claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,
      commercial_valid_until,offer_expires_at,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      ccp_status,eligibility_risk_flags,sourcing_shelf,sourcing_executable
    ) VALUES(
      'Verra VCS',$1,$2,$3,'VM0047','Brasil','2026','carbon','screening',
      8.50,10000,1,'dynamic','confirmed','manual',TRUE,
      'climate_contribution','under_review','Aguardando Eligibility Review Ledger','unknown','2026-01-01','2026-08-01',
      $4::date,$5::timestamptz,$6,$7,$8,
      $9,$10,1,$11,'not_assessed',$12::jsonb,'restricted',FALSE
    ) RETURNING *`,[
    `Eligibility ${name}`,
    `eligibility-${name}-${tag}`,
    `https://example.com/source/${name}/${tag}`,
    futureDate,futureDateTime,`PROJECT-${name}-${tag}`,`BATCH-${name}-${tag}`,
    valid?evidence:null,
    valid,valid,valid,
    JSON.stringify(["awaiting-ledger-review"]),
  ]);
  return {...rows[0],evidence};
}

function validProposal(asset){
  return {
    claimCategory:"voluntary_offset",
    eligibilityStatus:"eligible",
    eligibilityBasis:"Registry, batch, vintage, tradability e retirement validados via Eligibility Review Ledger.",
    sourceUnitStatus:"tradable",
    vintageStart:"2026-01-01",
    vintageEnd:"2026-08-01",
    commercialValidUntil:futureDate,
    offerExpiresAt:futureDateTime,
    registryProjectId:asset.registry_project_id,
    registryBatchId:asset.registry_batch_id,
    registryEvidenceUrl:asset.evidence,
    retirementSupported:true,
    fractionalRetirementSupported:true,
    retirementGranularityKg:1,
    beneficiaryRetirementSupported:true,
    ccpStatus:"not_assessed",
    riskFlags:[],
  };
}

async function startApi(){
  const app=express();
  app.use(express.json());
  registerEligibilityRoutes(app);
  registerEligibilityReviewRoutes(app);
  const server=app.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address=server.address();
  if(!address||typeof address==="string")throw new Error("Falha ao abrir porta do Eligibility Review smoke");
  const token=createAdminToken();
  const base=`http://127.0.0.1:${address.port}/api`;
  async function call(path,options={}){
    const response=await fetch(`${base}${path}`,{
      ...options,
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...(options.headers||{})},
    });
    const data=await response.json().catch(()=>({}));
    return {response,data};
  }
  return {server,call};
}

async function run(){
  await init();
  const valid=await seedAsset("valid",{valid:true});
  const stale=await seedAsset("stale",{valid:true});
  const invalid=await seedAsset("invalid",{valid:false});
  const {server,call}=await startApi();
  try{
    // A. Promoção válida precisa passar pelo ledger.
    const legacy=await call(`/admin/market/assets/${valid.id}/eligibility`,{
      method:"PATCH",body:JSON.stringify({...validProposal(valid),reviewNow:true}),
    });
    assert.equal(legacy.response.status,409);
    assert.equal(legacy.data.code,"ELIGIBILITY_LEDGER_REQUIRED");

    const created=await call(`/admin/market/assets/${valid.id}/eligibility-reviews`,{
      method:"POST",body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Eligibility Smoke",note:"Review válida",proposal:validProposal(valid)}),
    });
    assert.equal(created.response.status,201);
    assert.equal(created.data.status,"pending");
    assert.equal(created.data.preview_decision.allowed,true);
    assert.equal(String(created.data.proposed_sha256).length,64);
    const reviewId=Number(created.data.id);

    const duplicate=await call(`/admin/market/assets/${valid.id}/eligibility-reviews`,{
      method:"POST",body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Eligibility Smoke",note:"Review válida",proposal:validProposal(valid)}),
    });
    assert.equal(duplicate.response.status,201);
    assert.equal(Number(duplicate.data.id),reviewId);

    const approve=await call(`/admin/market/eligibility-reviews/${reviewId}/approve`,{
      method:"POST",body:JSON.stringify({reviewedBy:"Eligibility Smoke",note:"Aprovada após conferência."}),
    });
    assert.equal(approve.response.status,200);
    assert.equal(approve.data.review.status,"approved");
    assert.equal(approve.data.decision.allowed,true);
    assert.equal(String(approve.data.review.applied_sha256).length,64);
    assert.equal(approve.data.asset.claim_category,"voluntary_offset");
    assert.equal(approve.data.asset.eligibility_status,"eligible");
    assert.equal(approve.data.asset.sourcing_shelf,"verified_compensation");
    assert.equal(approve.data.asset.sourcing_executable,true);

    const approveAgain=await call(`/admin/market/eligibility-reviews/${reviewId}/approve`,{
      method:"POST",body:JSON.stringify({reviewedBy:"Eligibility Smoke"}),
    });
    assert.equal(approveAgain.response.status,200);
    assert.equal(approveAgain.data.alreadyApproved,true);

    let immutable=false;
    try{
      await pool.query(`UPDATE asset_eligibility_reviews SET review_note='mutação indevida' WHERE id=$1`,[reviewId]);
    }catch(error){immutable=String(error?.message||error).includes("decided_eligibility_review_is_immutable");}
    assert.equal(immutable,true,"Decided review must be immutable in PostgreSQL");

    const directAfter=await call(`/admin/market/assets/${valid.id}/eligibility`,{
      method:"PATCH",body:JSON.stringify({eligibilityBasis:"mutação direta pós-ledger"}),
    });
    assert.equal(directAfter.response.status,409);
    assert.equal(directAfter.data.code,"ELIGIBILITY_LEDGER_REQUIRED");

    // B. Review obsoleta não pode aplicar snapshot antigo.
    const staleCreate=await call(`/admin/market/assets/${stale.id}/eligibility-reviews`,{
      method:"POST",body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Eligibility Smoke",proposal:validProposal(stale)}),
    });
    assert.equal(staleCreate.response.status,201);
    assert.equal(staleCreate.data.preview_decision.allowed,true);
    await pool.query(`UPDATE monitored_assets SET registry_evidence_url=$2,updated_at=NOW() WHERE id=$1`,[
      stale.id,`https://example.com/eligibility/stale/changed/${tag}`,
    ]);
    const staleApprove=await call(`/admin/market/eligibility-reviews/${staleCreate.data.id}/approve`,{
      method:"POST",body:JSON.stringify({reviewedBy:"Eligibility Smoke"}),
    });
    assert.equal(staleApprove.response.status,409);
    const staleRow=(await pool.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1`,[staleCreate.data.id])).rows[0];
    assert.equal(staleRow.status,"stale");
    const staleAsset=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[stale.id])).rows[0];
    assert.equal(staleAsset.eligibility_status,"under_review");
    assert.equal(staleAsset.sourcing_executable,false);

    // C. Review inválida pode existir para análise, mas não pode promover.
    const invalidProposal={
      ...validProposal(invalid),
      registryEvidenceUrl:null,
      retirementSupported:false,
      beneficiaryRetirementSupported:false,
      riskFlags:["missing-registry-evidence","retirement-not-confirmed"],
    };
    const invalidCreate=await call(`/admin/market/assets/${invalid.id}/eligibility-reviews`,{
      method:"POST",body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Eligibility Smoke",proposal:invalidProposal}),
    });
    assert.equal(invalidCreate.response.status,201);
    assert.equal(invalidCreate.data.preview_decision.allowed,false);
    const invalidApprove=await call(`/admin/market/eligibility-reviews/${invalidCreate.data.id}/approve`,{
      method:"POST",body:JSON.stringify({reviewedBy:"Eligibility Smoke"}),
    });
    assert.equal(invalidApprove.response.status,409);
    const invalidReview=(await pool.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1`,[invalidCreate.data.id])).rows[0];
    assert.equal(invalidReview.status,"pending","Invalid policy decision must not be auto-rejected or applied");
    const invalidAsset=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[invalid.id])).rows[0];
    assert.equal(invalidAsset.eligibility_status,"under_review");
    assert.equal(invalidAsset.sourcing_executable,false);

    const list=await call(`/admin/market/eligibility-reviews?limit=20`);
    assert.equal(list.response.status,200);
    assert.ok(list.data.items.some((item)=>Number(item.id)===reviewId&&item.status==="approved"));
    assert.ok(list.data.items.some((item)=>Number(item.id)===Number(staleCreate.data.id)&&item.status==="stale"));

    console.log("Eligibility Review smoke OK",{
      runtimeRoutes:true,
      directPromotionBlocked:true,
      approvedReviewId:reviewId,
      proposedSha256:String(created.data.proposed_sha256),
      appliedSha256:String(approve.data.review.applied_sha256),
      decidedReviewImmutable:immutable,
      verifiedAssetDirectMutationBlocked:true,
      staleReviewBlocked:true,
      invalidPromotionBlocked:true,
      invalidReviewRemainsPending:true,
    });
  }finally{
    await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  }
}

try{await run();}
finally{await pool.end();}
