import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initEligibilityReviewDb } from "../dist/eligibility-review-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initAssistedSourcingDb } from "../dist/assisted-sourcing-db.js";
import { initSupplyDeskDb } from "../dist/supply-desk-db.js";
import { initDemandDeskDb } from "../dist/demand-desk-db.js";
import { initDemandProposalDb } from "../dist/demand-proposal-db.js";
import { initDemandSupplyRfqDb } from "../dist/demand-supply-rfq-db.js";
import { initSupplyOutreachDb } from "../dist/supply-outreach-db.js";
import { initSupplyIntakeDb } from "../dist/supply-intake-db.js";
import { initSupplyEligibilityDb } from "../dist/supply-eligibility-db.js";
import { initExecutionReadinessDb } from "../dist/execution-readiness-db.js";
import {
  createSupplyIntakeFromSelection,
  updateSupplyIntake,
  approveSupplyIntake,
  convertApprovedSupplyIntake,
} from "../dist/supply-intake.js";
import { approveSupplyEligibility } from "../dist/supply-eligibility.js";
import {
  createExecutionReadinessReview,
  approveExecutionReadinessReview,
  rejectExecutionReadinessReview,
  executionReadinessForAsset,
  assertAssetExecutionReady,
} from "../dist/execution-readiness.js";

let serial=0;
const futureDateTime="2026-12-31T23:59:59.000Z";

async function init(){
  await initDb();await initMarketDb();await initEligibilityDb();await initEligibilityReviewDb();await initCommerceDb();
  await initAssistedSourcingDb();await initSupplyDeskDb();await initDemandDeskDb();await initDemandProposalDb();
  await initDemandSupplyRfqDb();await initSupplyOutreachDb();await initSupplyIntakeDb();await initSupplyEligibilityDb();await initExecutionReadinessDb();
}

async function seedClaimReadySupplyAsset(label){
  serial+=1;const tag=`${Date.now()}-${serial}`;
  const account=(await pool.query(`INSERT INTO demand_accounts(
    source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
    contact_status,status,lead_score,metadata,last_checked_at
  ) VALUES('execution_readiness_smoke',$1,$2,$2,$3,'Industrial','Brasil','ESG',$4,'qualified','qualified',99,$5::jsonb,NOW()) RETURNING *`,[
    `buyer-${tag}`,`Execution Buyer ${label}`,`60.000.00${serial}/0001-00`,`buyer-${tag}@example.com`,JSON.stringify({smoke:true}),
  ])).rows[0];
  const opportunity=(await pool.query(`INSERT INTO demand_opportunities(
    account_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes
  ) VALUES($1,'sourcing_required',10000,'custom','voluntary_offset',2026,99,$2::jsonb,'Execution readiness smoke') RETURNING *`,[
    account.id,JSON.stringify({smoke:true}),
  ])).rows[0];
  const rfq=(await pool.query(`INSERT INTO market_maker_rfqs(
    opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,
    preferred_country,priority_score,requirements,source
  ) VALUES($1,$2,'open','voluntary_offset',2026,10000,0,10000,'Brasil',99,$3::jsonb,'execution_readiness_smoke') RETURNING *`,[
    opportunity.id,account.id,JSON.stringify({claimReadyRequired:true}),
  ])).rows[0];
  const evidence=`https://example.com/execution/registry/${tag}`;
  const lead=(await pool.query(`INSERT INTO supply_leads(
    registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
    methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,confirmed_free_tonnes,
    evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
  ) VALUES('Verra VCS',$1,$2,'Brasil','Mato Grosso',$3,'Mesa Comercial',$4,'VM0047','2026',20000,0,0,20000,10000,
    $5,$6,'execution_readiness_smoke','seller_confirmed','qualified','qualified','Execution readiness smoke',$7::jsonb,NOW()) RETURNING *`,[
    `VCS-EXEC-${tag}`,`Execution Project ${label}`,`Execution Supplier ${label}`,`supplier-${tag}@example.com`,evidence,
    `https://example.com/execution/source/${tag}`,JSON.stringify({smoke:true}),
  ])).rows[0];
  const candidate=(await pool.query(`INSERT INTO market_maker_rfq_candidates(
    rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
    candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
  ) VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,$5,'Brasil','2026',10000,'seller_confirmed',95,'qualified',FALSE,
    $6::jsonb,$7::jsonb,NOW()) RETURNING *`,[
    rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id,lead.project_name,
    JSON.stringify({claimReady:false}),JSON.stringify({supplierName:lead.supplier_name}),
  ])).rows[0];
  const selection=(await pool.query(`INSERT INTO market_maker_supply_selections(
    rfq_id,candidate_id,supply_lead_id,requested_tonnes,status,response_due_at,selected_by,selected_note,snapshot
  ) VALUES($1,$2,$3,10000,'responded',NOW()+INTERVAL '5 days','Execution Smoke','Responded',$4::jsonb) RETURNING *`,[
    rfq.id,candidate.id,lead.id,JSON.stringify({smoke:true}),
  ])).rows[0];
  await pool.query(`INSERT INTO market_maker_supply_responses(
    selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,retirement_supported,
    beneficiary_retirement_supported,registry_evidence_url,valid_until,response_note,responded_by,response_snapshot
  ) VALUES($1,'confirmed',10000,8.75,1,TRUE,TRUE,$2,$3::timestamptz,'Confirmed','Execution Smoke',$4::jsonb)`,[
    selection.id,evidence,futureDateTime,JSON.stringify({smoke:true}),
  ]);
  const intake=await createSupplyIntakeFromSelection({selectionId:Number(selection.id),createdBy:"Execution Smoke"});
  await updateSupplyIntake({
    reviewId:Number(intake.id),authorizedTonnes:10000,floorPriceUsdTonne:8.75,minOrderTonnes:1,batchReference:`BATCH-${tag}`,
    vintage:"2026",serialStart:`SERIAL-${tag}-1`,serialEnd:`SERIAL-${tag}-10000`,methodology:"VM0047",registryEvidenceUrl:evidence,
    sourceUrl:`https://example.com/execution/source/${tag}`,retirementSupported:true,beneficiaryRetirementSupported:true,
    fractionalRetirementSupported:true,retirementGranularityKg:1,commercialValidUntil:futureDateTime,
    legalKycStatus:"approved",registryEvidenceStatus:"verified",commercialTermsStatus:"approved",reviewNote:"Execution gate diligence",actor:"Execution Smoke",
  });
  await approveSupplyIntake({reviewId:Number(intake.id),approvedBy:"Execution Smoke"});
  const conversion=await convertApprovedSupplyIntake({reviewId:Number(intake.id),convertedBy:"Execution Smoke"});
  const assetId=Number(conversion.monitoredAsset.id);
  const climate=await approveSupplyEligibility({
    intakeReviewId:Number(intake.id),tradabilityConfirmed:true,reviewedBy:"Execution Smoke",
    eligibilityBasis:"Climate eligibility approved before execution readiness.",ccpStatus:"not_assessed",vintagePolicyOverride:false,riskFlags:[],
  });
  assert.equal(climate.claimReady,true);assert.equal(climate.executionAuthorization,false);
  const asset=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];
  assert.equal(asset.eligibility_status,"eligible");assert.equal(asset.sourcing_shelf,"verified_compensation");assert.equal(asset.sourcing_executable,false);
  return{assetId,intakeId:Number(intake.id),inventoryId:Number(conversion.inventory.id),mandateId:Number(conversion.mandate.id)};
}

async function mockExecutors(){
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):null;
    calls.push({method:req.method,url:req.url,authorization:req.headers.authorization,body});
    if(req.method==="GET"&&(req.url==="/source/health"||req.url==="/retirement/health")){
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,service:req.url.includes("source")?"source":"retirement"}));return;
    }
    if(req.method==="POST"&&(req.url==="/source/dry-run"||req.url==="/retirement/dry-run")){
      assert.equal(body?.mode,"dry_run");assert.equal(body?.noSideEffects,true);assert.ok(["acquisition","retirement"].includes(body?.operation));
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,dryRun:true,noSideEffects:true}));return;
    }
    res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({ok:false}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw new Error("Mock executor port unavailable");
  return{server,calls,base:`http://127.0.0.1:${address.port}`};
}

async function run(){
  await init();
  for(const key of ["SOURCE_EXECUTOR_URL","SOURCE_EXECUTOR_TOKEN","RETIREMENT_EXECUTOR_URL","RETIREMENT_EXECUTOR_TOKEN","SOURCE_EXECUTOR_HEALTH_URL","SOURCE_EXECUTOR_DRY_RUN_URL","RETIREMENT_EXECUTOR_HEALTH_URL","RETIREMENT_EXECUTOR_DRY_RUN_URL"])delete process.env[key];

  const first=await seedClaimReadySupplyAsset("A");
  let dbBypassBlocked=false;try{await pool.query(`UPDATE monitored_assets SET sourcing_executable=TRUE WHERE id=$1`,[first.assetId]);}
  catch(error){dbBypassBlocked=String(error?.message||error).includes("execution_readiness_authorization_required");}
  assert.equal(dbBypassBlocked,true,"DB must block direct executable enable for supply-intake");

  const missing=await createExecutionReadinessReview({assetId:first.assetId,supplierSettlementMode:"supplier_invoice",proofSlaHours:24,authorizationTtlHours:24,actor:"Execution Smoke"});
  assert.equal(missing.preview.ready,false);assert.ok(missing.preview.reasons.includes("source_executor_not_configured"));assert.ok(missing.preview.reasons.includes("retirement_executor_not_configured"));
  let missingApprovalBlocked=false;try{await approveExecutionReadinessReview({reviewId:Number(missing.review.id),reviewedBy:"Execution Smoke"});}catch{missingApprovalBlocked=true;}
  assert.equal(missingApprovalBlocked,true);assert.equal((await pool.query(`SELECT status FROM asset_execution_readiness_reviews WHERE id=$1`,[missing.review.id])).rows[0].status,"pending");
  await rejectExecutionReadinessReview({reviewId:Number(missing.review.id),reason:"Executors não configurados",reviewedBy:"Execution Smoke"});

  const mock=await mockExecutors();
  try{
    process.env.SOURCE_EXECUTOR_URL=`${mock.base}/source`;process.env.SOURCE_EXECUTOR_TOKEN="source-token-a";
    process.env.RETIREMENT_EXECUTOR_URL=`${mock.base}/retirement`;process.env.RETIREMENT_EXECUTOR_TOKEN="retirement-token-a";
    process.env.ECOT_EXECUTION_PROBE_TIMEOUT_MS="3000";

    const readyReview=await createExecutionReadinessReview({assetId:first.assetId,supplierSettlementMode:"supplier_invoice",proofSlaHours:24,authorizationTtlHours:24,actor:"Execution Smoke"});
    assert.equal(readyReview.preview.ready,true);assert.equal(String(readyReview.review.proposed_sha256).length,64);
    const proposedText=JSON.stringify(readyReview.review.proposed_snapshot);assert.equal(proposedText.includes("source-token-a"),false);assert.equal(proposedText.includes("retirement-token-a"),false);

    const authorized=await approveExecutionReadinessReview({reviewId:Number(readyReview.review.id),reviewedBy:"Execution Smoke",note:"Dry-runs e saúde confirmados."});
    assert.equal(authorized.review.status,"approved");assert.equal(String(authorized.review.applied_sha256).length,64);
    assert.equal(authorized.authorization.status,"active");assert.ok(new Date(authorized.authorization.valid_until).getTime()>Date.now());
    assert.equal(String(authorized.authorization.config_fingerprint).length,64);assert.equal(authorized.asset.sourcing_executable,true);
    const runtimeReady=await assertAssetExecutionReady(first.assetId);assert.equal(runtimeReady.ready,true);
    assert.ok(mock.calls.filter(call=>call.url?.endsWith("/health")).length>=4);assert.ok(mock.calls.filter(call=>call.url?.endsWith("/dry-run")).length>=4);

    let reviewImmutable=false;try{await pool.query(`UPDATE asset_execution_readiness_reviews SET review_note='tamper' WHERE id=$1`,[readyReview.review.id]);}
    catch(error){reviewImmutable=String(error?.message||error).includes("decided_execution_readiness_review_is_immutable");}
    assert.equal(reviewImmutable,true);

    process.env.SOURCE_EXECUTOR_TOKEN="source-token-rotated";
    const afterRotation=await executionReadinessForAsset(first.assetId);assert.equal(afterRotation.ready,false);
    assert.equal((await pool.query(`SELECT sourcing_executable FROM monitored_assets WHERE id=$1`,[first.assetId])).rows[0].sourcing_executable,false);
    assert.equal((await pool.query(`SELECT status FROM asset_execution_authorizations WHERE asset_id=$1`,[first.assetId])).rows[0].status,"revoked");
    let runtimeBlocked=false;try{await assertAssetExecutionReady(first.assetId);}catch(error){runtimeBlocked=String(error?.code||"")==="EXECUTION_READINESS_REQUIRED";}
    assert.equal(runtimeBlocked,true);
    let bypassAfterRevoke=false;try{await pool.query(`UPDATE monitored_assets SET sourcing_executable=TRUE WHERE id=$1`,[first.assetId]);}catch(error){bypassAfterRevoke=String(error?.message||error).includes("execution_readiness_authorization_required");}
    assert.equal(bypassAfterRevoke,true);

    process.env.SOURCE_EXECUTOR_TOKEN="source-token-a";
    const second=await seedClaimReadySupplyAsset("B");
    const staleReview=await createExecutionReadinessReview({assetId:second.assetId,supplierSettlementMode:"supplier_invoice",proofSlaHours:24,authorizationTtlHours:24,actor:"Execution Smoke"});
    assert.equal(staleReview.preview.ready,true);
    await pool.query(`UPDATE supply_inventory SET sold_tonnes=1,updated_at=NOW() WHERE id=$1`,[second.inventoryId]);
    let staleBlocked=false;try{await approveExecutionReadinessReview({reviewId:Number(staleReview.review.id),reviewedBy:"Execution Smoke"});}catch(error){staleBlocked=String(error?.message||error).includes("obsoleta");}
    assert.equal(staleBlocked,true);assert.equal((await pool.query(`SELECT status FROM asset_execution_readiness_reviews WHERE id=$1`,[staleReview.review.id])).rows[0].status,"stale");
    assert.equal((await pool.query(`SELECT sourcing_executable FROM monitored_assets WHERE id=$1`,[second.assetId])).rows[0].sourcing_executable,false);

    const provider=(await pool.query(`INSERT INTO monitored_assets(
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,source_price_usd_ton,
      available_tons,min_order_kg,pricing_mode,availability_status,source_status,active,claim_category,eligibility_status,eligibility_basis,
      source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,ccp_status,
      eligibility_checked_at,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES('Verra VCS','Provider Managed Smoke',$1,$2,'Provider','Brasil','2026','carbon','screening',10,1000,1,'dynamic','confirmed','connected',TRUE,
      'voluntary_offset','eligible','Provider managed','tradable','2026-01-01','2026-08-01','2026-12-31','P-MANAGED','P-BATCH',$3,TRUE,TRUE,1,TRUE,
      'not_assessed',NOW(),'verified_compensation',FALSE,NOW()) RETURNING *`,[
      `carbonmark:provider-managed-${Date.now()}`,`https://example.com/provider/${Date.now()}`,`https://example.com/provider/evidence/${Date.now()}`,
    ])).rows[0];
    await pool.query(`UPDATE monitored_assets SET sourcing_executable=TRUE WHERE id=$1`,[provider.id]);
    const providerStatus=await executionReadinessForAsset(Number(provider.id));assert.equal(providerStatus.required,false);assert.equal(providerStatus.managedBy,"source_adapter");

    console.log("Execution Readiness smoke OK",{
      directDbBypassBlocked:dbBypassBlocked,missingExecutorsBlocked:missingApprovalBlocked,readyPreview:true,
      executionReviewId:Number(readyReview.review.id),proposedSha256:readyReview.review.proposed_sha256,appliedSha256:authorized.review.applied_sha256,
      authorizationId:Number(authorized.authorization.id),authorizationTtlFuture:true,rawSecretsPersisted:false,reviewImmutable,
      configRotationRevoked:true,runtimeGuardBlockedAfterRotation:runtimeBlocked,directDbBypassBlockedAfterRevoke:bypassAfterRevoke,
      staleReviewBlocked:staleBlocked,providerManagedUnaffected:true,dryRunCalls:mock.calls.filter(call=>call.url?.endsWith("/dry-run")).length,
    });
  }finally{await new Promise((resolve,reject)=>mock.server.close(error=>error?reject(error):resolve()));}
}

try{await run();}finally{await pool.end();}
