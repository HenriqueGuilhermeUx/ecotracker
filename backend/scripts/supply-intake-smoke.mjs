import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initAssistedSourcingDb } from "../dist/assisted-sourcing-db.js";
import { initSupplyDeskDb } from "../dist/supply-desk-db.js";
import { initDemandDeskDb } from "../dist/demand-desk-db.js";
import { initDemandProposalDb } from "../dist/demand-proposal-db.js";
import { initDemandSupplyRfqDb } from "../dist/demand-supply-rfq-db.js";
import { initSupplyOutreachDb } from "../dist/supply-outreach-db.js";
import { initSupplyIntakeDb } from "../dist/supply-intake-db.js";
import { initSupplyEligibilityDb } from "../dist/supply-eligibility-db.js";
import {
  approveSupplyIntake,
  convertApprovedSupplyIntake,
  createSupplyIntakeFromSelection,
  updateSupplyIntake,
} from "../dist/supply-intake.js";
import { approveSupplyEligibility } from "../dist/supply-eligibility.js";
import { evaluateAssetEligibility } from "../dist/eligibility-policy.js";
import { generateDemandMatches } from "../dist/demand-matching.js";

const tag=Date.now();
const futureDateTime="2026-12-31T23:59:59.000Z";

async function init(){
  await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initAssistedSourcingDb();
  await initSupplyDeskDb();await initDemandDeskDb();await initDemandProposalDb();await initDemandSupplyRfqDb();
  await initSupplyOutreachDb();await initSupplyIntakeDb();await initSupplyEligibilityDb();
}

async function seed(){
  await pool.query(`UPDATE monitored_assets SET active=FALSE WHERE active=TRUE`);
  const account=(await pool.query(`INSERT INTO demand_accounts(
    source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
    contact_status,status,lead_score,metadata,last_checked_at
  ) VALUES('supply_intake_smoke',$1,'Empresa Intake Buyer S.A.','Empresa Intake Buyer S.A.','50.000.000/0001-00',
    'Industrial','Brasil','Diretoria ESG',$2,'qualified','qualified',99,$3::jsonb,NOW()) RETURNING *`,[
    `buyer-${tag}`,`buyer-intake-${tag}@example.com`,JSON.stringify({smoke:true}),
  ])).rows[0];
  const opportunity=(await pool.query(`INSERT INTO demand_opportunities(
    account_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes
  ) VALUES($1,'sourcing_required',10000,'custom','voluntary_offset',2026,99,$2::jsonb,'Supply Intake smoke') RETURNING *`,[
    account.id,JSON.stringify({smoke:true}),
  ])).rows[0];
  const rfq=(await pool.query(`INSERT INTO market_maker_rfqs(
    opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,
    preferred_country,priority_score,requirements,source
  ) VALUES($1,$2,'open','voluntary_offset',2026,10000,0,10000,'Brasil',99,$3::jsonb,'supply_intake_smoke') RETURNING *`,[
    opportunity.id,account.id,JSON.stringify({claimReadyRequired:true}),
  ])).rows[0];
  const evidenceUrl=`https://example.com/intake/registry/${tag}`;
  const sourceUrl=`https://example.com/intake/source/${tag}`;
  const lead=(await pool.query(`INSERT INTO supply_leads(
    registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
    methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,confirmed_free_tonnes,
    evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
  ) VALUES('Verra VCS',$1,'Projeto Intake Gate Smoke','Brasil','Mato Grosso','Fornecedor Intake Smoke Ltda','Mesa Comercial',$2,
    'VM0047','2026',20000,10000,0,10000,10000,$3,$4,'supply_intake_smoke','seller_confirmed','qualified','qualified',
    'Seller-confirmed aguardando intake.',$5::jsonb,NOW()) RETURNING *`,[
    `VCS-INTAKE-${tag}`,`supplier-intake-${tag}@example.com`,evidenceUrl,sourceUrl,JSON.stringify({smoke:true,claimReady:false}),
  ])).rows[0];
  const candidate=(await pool.query(`INSERT INTO market_maker_rfq_candidates(
    rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
    candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
  ) VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Intake Gate Smoke','Brasil','2026',10000,
    'seller_confirmed',95,'qualified',FALSE,$5::jsonb,$6::jsonb,NOW()) RETURNING *`,[
    rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id,
    JSON.stringify({basis:"seller_confirmed_free_inventory",claimReady:false}),
    JSON.stringify({supplierName:lead.supplier_name,evidenceUrl}),
  ])).rows[0];
  const selection=(await pool.query(`INSERT INTO market_maker_supply_selections(
    rfq_id,candidate_id,supply_lead_id,requested_tonnes,status,response_due_at,selected_by,selected_note,snapshot
  ) VALUES($1,$2,$3,10000,'responded',NOW()+INTERVAL '5 days','Supply Intake Smoke','Seller respondeu',$4::jsonb) RETURNING *`,[
    rfq.id,candidate.id,lead.id,JSON.stringify({smoke:true,requestedTonnes:10000}),
  ])).rows[0];
  const response=(await pool.query(`INSERT INTO market_maker_supply_responses(
    selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,retirement_supported,
    beneficiary_retirement_supported,registry_evidence_url,valid_until,response_note,responded_by,response_snapshot
  ) VALUES($1,'confirmed',10000,8.75,1,TRUE,TRUE,$2,$3::timestamptz,'Fornecedor confirmou 10.000 t com retirement.',
    'Supply Intake Smoke',$4::jsonb) RETURNING *`,[
    selection.id,evidenceUrl,futureDateTime,JSON.stringify({smoke:true,sellerConfirmed:true}),
  ])).rows[0];
  return{account,opportunity,rfq,lead,candidate,selection,response,evidenceUrl,sourceUrl};
}

async function run(){
  await init();const seeded=await seed();
  const intake=await createSupplyIntakeFromSelection({selectionId:Number(seeded.selection.id),createdBy:"Supply Intake Smoke"});
  assert.equal(intake.status,"draft");assert.equal(Number(intake.confirmed_tonnes),10000);assert.equal(Number(intake.authorized_tonnes),10000);
  const same=await createSupplyIntakeFromSelection({selectionId:Number(seeded.selection.id),createdBy:"Supply Intake Smoke"});
  assert.equal(Number(same.id),Number(intake.id),"Intake creation must be idempotent");

  let prematureBlocked=false;try{await approveSupplyIntake({reviewId:Number(intake.id),approvedBy:"Supply Intake Smoke"});}catch{prematureBlocked=true;}
  assert.equal(prematureBlocked,true,"Incomplete intake must not be approved");

  const ready=await updateSupplyIntake({
    reviewId:Number(intake.id),authorizedTonnes:10000,floorPriceUsdTonne:8.75,minOrderTonnes:1,
    batchReference:`BATCH-INTAKE-${tag}`,vintage:"2026",serialStart:`SERIAL-${tag}-000001`,serialEnd:`SERIAL-${tag}-010000`,
    methodology:"VM0047",registryEvidenceUrl:seeded.evidenceUrl,sourceUrl:seeded.sourceUrl,retirementSupported:true,
    beneficiaryRetirementSupported:true,fractionalRetirementSupported:true,retirementGranularityKg:1,
    commercialValidUntil:futureDateTime,legalKycStatus:"approved",registryEvidenceStatus:"verified",commercialTermsStatus:"approved",
    reviewNote:"KYC, registry evidence, batch, retirement e termos comerciais validados no smoke.",actor:"Supply Intake Smoke",
  });
  assert.equal(ready.status,"ready_for_review");
  const approved=await approveSupplyIntake({reviewId:Number(intake.id),approvedBy:"Supply Intake Smoke",note:"Aprovação humana do intake."});
  assert.equal(approved.status,"approved");assert.equal(String(approved.approval_sha256).length,64);
  let immutable=false;try{await pool.query(`UPDATE supply_intake_reviews SET authorized_tonnes=9000,updated_at=NOW() WHERE id=$1`,[intake.id]);}catch(error){immutable=String(error?.message||error).includes("approved_supply_intake_is_immutable");}
  assert.equal(immutable,true);

  const conversion=await convertApprovedSupplyIntake({reviewId:Number(intake.id),convertedBy:"Supply Intake Smoke"});
  const assetId=Number(conversion.monitoredAsset.id);assert.ok(Number(conversion.mandate.id)>0&&Number(conversion.inventory.id)>0&&assetId>0);
  const secondConversion=await convertApprovedSupplyIntake({reviewId:Number(intake.id),convertedBy:"Supply Intake Smoke"});
  assert.equal(Number(secondConversion.id),Number(conversion.id),"Conversion must be idempotent");

  const restricted=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];
  assert.equal(restricted.claim_category,"climate_contribution");assert.equal(restricted.eligibility_status,"under_review");
  assert.equal(restricted.sourcing_shelf,"restricted");assert.equal(restricted.sourcing_executable,false);
  assert.equal(evaluateAssetEligibility(restricted,"voluntary_offset",10_000_000).allowed,false);
  const before=await generateDemandMatches(Number(seeded.opportunity.id));assert.equal(before.fullyCovered,false);assert.equal(Number(before.uncoveredTonnes),10000);

  const climate=await approveSupplyEligibility({
    intakeReviewId:Number(intake.id),tradabilityConfirmed:true,reviewedBy:"Supply Intake Smoke",
    eligibilityBasis:"Supply Eligibility Queue: registry, batch, vintage, tradability e retirement confirmados.",
    ccpStatus:"not_assessed",vintagePolicyOverride:false,riskFlags:[],
  });
  assert.equal(climate.claimReady,true);assert.equal(climate.executionAuthorization,false);assert.equal(climate.executionState,"assisted_or_manual");
  assert.equal(String(climate.review.review_sha256).length,64);assert.ok(Number(climate.review.asset_eligibility_review_id)>0);
  assert.equal(String(climate.assetEligibilityReview.proposed_sha256).length,64);assert.equal(String(climate.assetEligibilityReview.applied_sha256).length,64);

  const claimReady=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];
  assert.equal(claimReady.claim_category,"voluntary_offset");assert.equal(claimReady.eligibility_status,"eligible");assert.equal(claimReady.source_unit_status,"tradable");
  assert.equal(claimReady.sourcing_shelf,"verified_compensation");assert.equal(claimReady.sourcing_executable,false,"Climate eligibility must not authorize programmatic execution");
  assert.equal(evaluateAssetEligibility(claimReady,"voluntary_offset",10_000_000).allowed,true);
  assert.equal(climate.matching.fullyCovered,true);assert.equal(Number(climate.matching.coveredTonnes),10000);assert.equal(Number(climate.matching.uncoveredTonnes),0);
  const rfqAfter=(await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[seeded.rfq.id])).rows[0];assert.equal(rfqAfter.status,"resolved");assert.equal(Number(rfqAfter.gap_tonnes),0);

  const generic=(await pool.query(`SELECT * FROM asset_eligibility_reviews WHERE id=$1`,[climate.review.asset_eligibility_review_id])).rows[0];
  assert.equal(generic.status,"approved");assert.equal(String(generic.proposed_sha256).length,64);assert.equal(String(generic.applied_sha256).length,64);
  let genericImmutable=false;try{await pool.query(`UPDATE asset_eligibility_reviews SET review_note='x' WHERE id=$1`,[generic.id]);}catch(error){genericImmutable=String(error?.message||error).includes("decided_eligibility_review_is_immutable");}
  assert.equal(genericImmutable,true);

  console.log("Supply Intake smoke OK",{
    intakeId:Number(intake.id),prematureApprovalBlocked:prematureBlocked,intakeApprovalSha256:approved.approval_sha256,
    approvedIntakeImmutable:immutable,mandateId:Number(conversion.mandate.id),inventoryId:Number(conversion.inventory.id),monitoredAssetId:assetId,
    supplyEligibilityReviewId:Number(climate.review.id),assetEligibilityReviewId:Number(generic.id),eligibilityProposedSha256:generic.proposed_sha256,
    eligibilityAppliedSha256:generic.applied_sha256,genericReviewImmutable:genericImmutable,claimReady:true,executionAuthorization:false,rfqResolved:true,
  });
}

try{await run();}finally{await pool.end();}
