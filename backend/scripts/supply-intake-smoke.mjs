import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
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
import { createAdminToken } from "../dist/auth.js";
import { registerSupplyIntakeRoutes } from "../dist/supply-intake-routes.js";
import { registerEligibilityRoutes } from "../dist/eligibility-routes.js";
import { registerEligibilityReviewRoutes } from "../dist/eligibility-review-routes.js";
import { registerDemandSupplyRfqRoutes } from "../dist/demand-supply-rfq-routes.js";
import { evaluateAssetEligibility } from "../dist/eligibility-policy.js";

const tag = Date.now();
const futureDate = "2026-12-31";
const futureDateTime = "2026-12-31T23:59:59.000Z";

async function init() {
  await initDb();
  await initMarketDb();
  await initEligibilityDb();
  await initEligibilityReviewDb();
  await initCommerceDb();
  await initAssistedSourcingDb();
  await initSupplyDeskDb();
  await initDemandDeskDb();
  await initDemandProposalDb();
  await initDemandSupplyRfqDb();
  await initSupplyOutreachDb();
  await initSupplyIntakeDb();
}

async function seed() {
  await pool.query(`UPDATE monitored_assets SET active=FALSE WHERE active=TRUE`);

  const account = (await pool.query(`
    INSERT INTO demand_accounts(
      source,source_reference,company_name,legal_name,tax_id,sector,country,
      contact_name,contact_email,contact_status,status,lead_score,metadata,last_checked_at
    ) VALUES(
      'supply_intake_smoke',$1,'Empresa Intake Buyer S.A.','Empresa Intake Buyer S.A.',
      '50.000.000/0001-00','Industrial','Brasil','Diretoria ESG',$2,
      'qualified','qualified',99,$3::jsonb,NOW()
    ) RETURNING *`,[
    `buyer-${tag}`,`buyer-intake-${tag}@example.com`,JSON.stringify({smoke:true}),
  ])).rows[0];

  const opportunity = (await pool.query(`
    INSERT INTO demand_opportunities(
      account_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes
    ) VALUES($1,'sourcing_required',10000,'custom','voluntary_offset',2026,99,$2::jsonb,'Supply Intake smoke')
    RETURNING *`,[account.id,JSON.stringify({smoke:true})])).rows[0];

  const rfq = (await pool.query(`
    INSERT INTO market_maker_rfqs(
      opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,
      preferred_country,priority_score,requirements,source
    ) VALUES($1,$2,'open','voluntary_offset',2026,10000,0,10000,'Brasil',99,$3::jsonb,'supply_intake_smoke')
    RETURNING *`,[opportunity.id,account.id,JSON.stringify({claimReadyRequired:true})])).rows[0];

  const evidenceUrl = `https://example.com/intake/registry/${tag}`;
  const sourceUrl = `https://example.com/intake/source/${tag}`;
  const lead = (await pool.query(`
    INSERT INTO supply_leads(
      registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
      methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,
      confirmed_free_tonnes,evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
    ) VALUES(
      'Verra VCS',$1,'Projeto Intake Gate Smoke','Brasil','Mato Grosso','Fornecedor Intake Smoke Ltda',
      'Mesa Comercial',$2,'VM0047','2026',20000,10000,0,10000,10000,$3,$4,'supply_intake_smoke',
      'seller_confirmed','qualified','qualified','Seller-confirmed aguardando intake.',$5::jsonb,NOW()
    ) RETURNING *`,[
    `VCS-INTAKE-${tag}`,`supplier-intake-${tag}@example.com`,evidenceUrl,sourceUrl,
    JSON.stringify({smoke:true,claimReady:false}),
  ])).rows[0];

  const candidate = (await pool.query(`
    INSERT INTO market_maker_rfq_candidates(
      rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
      candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
    ) VALUES(
      $1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Intake Gate Smoke','Brasil','2026',
      10000,'seller_confirmed',95,'qualified',FALSE,$5::jsonb,$6::jsonb,NOW()
    ) RETURNING *`,[
    rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id,
    JSON.stringify({basis:"seller_confirmed_free_inventory",claimReady:false}),
    JSON.stringify({supplierName:lead.supplier_name,evidenceUrl}),
  ])).rows[0];

  const selection = (await pool.query(`
    INSERT INTO market_maker_supply_selections(
      rfq_id,candidate_id,supply_lead_id,requested_tonnes,status,response_due_at,selected_by,selected_note,snapshot
    ) VALUES($1,$2,$3,10000,'responded',NOW()+INTERVAL '5 days','Supply Intake Smoke','Seller respondeu',$4::jsonb)
    RETURNING *`,[
    rfq.id,candidate.id,lead.id,JSON.stringify({smoke:true,requestedTonnes:10000}),
  ])).rows[0];

  const response = (await pool.query(`
    INSERT INTO market_maker_supply_responses(
      selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,
      retirement_supported,beneficiary_retirement_supported,registry_evidence_url,valid_until,
      response_note,responded_by,response_snapshot
    ) VALUES(
      $1,'confirmed',10000,8.75,1,TRUE,TRUE,$2,$3::timestamptz,
      'Fornecedor confirmou 10.000 t com retirement.', 'Supply Intake Smoke',$4::jsonb
    ) RETURNING *`,[
    selection.id,evidenceUrl,futureDateTime,JSON.stringify({smoke:true,sellerConfirmed:true}),
  ])).rows[0];

  return {account,opportunity,rfq,lead,candidate,selection,response,evidenceUrl,sourceUrl};
}

async function startApi() {
  const app = express();
  app.use(express.json());
  registerSupplyIntakeRoutes(app);
  registerEligibilityRoutes(app);
  registerEligibilityReviewRoutes(app);
  registerDemandSupplyRfqRoutes(app);
  const server = app.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Falha ao abrir porta do Supply Intake smoke");
  const token = createAdminToken();
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call(path,options={}) {
    const response = await fetch(`${base}${path}`,{
      ...options,
      headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/json",
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    return {response,data};
  }
  return {server,call};
}

async function run() {
  await init();
  const seeded = await seed();
  const {server,call} = await startApi();
  try {
    const create = await call(`/admin/market-maker/supply-selections/${seeded.selection.id}/intake`,{
      method:"POST",body:JSON.stringify({createdBy:"Supply Intake Smoke"}),
    });
    assert.equal(create.response.status,201);
    const intake = create.data;
    assert.ok(Number(intake.id)>0);
    assert.equal(intake.status,"draft");
    assert.equal(Number(intake.confirmed_tonnes),10000);
    assert.equal(Number(intake.authorized_tonnes),10000);

    const createAgain = await call(`/admin/market-maker/supply-selections/${seeded.selection.id}/intake`,{
      method:"POST",body:JSON.stringify({createdBy:"Supply Intake Smoke"}),
    });
    assert.equal(createAgain.response.status,201);
    assert.equal(Number(createAgain.data.id),Number(intake.id),"Supply Intake creation must be idempotent");

    const premature = await call(`/admin/supply/intakes/${intake.id}/approve`,{
      method:"POST",body:JSON.stringify({approvedBy:"Supply Intake Smoke"}),
    });
    assert.equal(premature.response.status,409,"Incomplete intake must not be approvable");

    const patch = await call(`/admin/supply/intakes/${intake.id}`,{
      method:"PATCH",
      body:JSON.stringify({
        authorizedTonnes:10000,
        floorPriceUsdTonne:8.75,
        minOrderTonnes:1,
        batchReference:`BATCH-INTAKE-${tag}`,
        vintage:"2026",
        serialStart:`SERIAL-${tag}-000001`,
        serialEnd:`SERIAL-${tag}-010000`,
        methodology:"VM0047",
        registryEvidenceUrl:seeded.evidenceUrl,
        sourceUrl:seeded.sourceUrl,
        retirementSupported:true,
        beneficiaryRetirementSupported:true,
        fractionalRetirementSupported:true,
        retirementGranularityKg:1,
        commercialValidUntil:futureDateTime,
        legalKycStatus:"approved",
        registryEvidenceStatus:"verified",
        commercialTermsStatus:"approved",
        reviewNote:"KYC, registry evidence, batch, retirement e termos comerciais validados no smoke.",
        actor:"Supply Intake Smoke",
      }),
    });
    assert.equal(patch.response.status,200);
    assert.equal(patch.data.status,"ready_for_review");

    const approve = await call(`/admin/supply/intakes/${intake.id}/approve`,{
      method:"POST",body:JSON.stringify({approvedBy:"Supply Intake Smoke",note:"Aprovação humana do intake."}),
    });
    assert.equal(approve.response.status,200);
    assert.equal(approve.data.status,"approved");
    assert.equal(String(approve.data.approval_sha256).length,64);

    let immutableBlocked = false;
    try {
      await pool.query(`UPDATE supply_intake_reviews SET authorized_tonnes=9000,updated_at=NOW() WHERE id=$1`,[intake.id]);
    } catch (error) {
      immutableBlocked = String(error?.message || error).includes("approved_supply_intake_is_immutable");
    }
    assert.equal(immutableBlocked,true,"Approved intake must be immutable in PostgreSQL");

    const convert = await call(`/admin/supply/intakes/${intake.id}/convert`,{
      method:"POST",body:JSON.stringify({convertedBy:"Supply Intake Smoke"}),
    });
    assert.equal(convert.response.status,201);
    const conversion = convert.data;
    const assetId = Number(conversion.monitoredAsset.id);
    assert.ok(Number(conversion.mandate.id)>0 && Number(conversion.inventory.id)>0 && assetId>0);

    const secondConvert = await call(`/admin/supply/intakes/${intake.id}/convert`,{
      method:"POST",body:JSON.stringify({convertedBy:"Supply Intake Smoke"}),
    });
    assert.equal(secondConvert.response.status,201);
    assert.equal(Number(secondConvert.data.id),Number(conversion.id),"Conversion must be idempotent");

    const restricted = (await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];
    assert.equal(restricted.claim_category,"climate_contribution");
    assert.equal(restricted.eligibility_status,"under_review");
    assert.equal(restricted.source_unit_status,"unknown");
    assert.equal(restricted.sourcing_shelf,"restricted");
    assert.equal(restricted.sourcing_executable,false);
    assert.ok(restricted.eligibility_risk_flags.includes("supply-intake-awaiting-eligibility-review"));
    assert.equal(evaluateAssetEligibility(restricted,"voluntary_offset",10_000_000).allowed,false);

    const quoteBlocked = await call("/market/quotes",{
      method:"POST",body:JSON.stringify({assetId,requestedKg:10_000_000,purpose:"voluntary_offset"}),
    });
    assert.equal(quoteBlocked.response.status,409);

    const preEligibilityRfq = await call(`/admin/demand/opportunities/${seeded.opportunity.id}/rfq`,{
      method:"POST",body:"{}",
    });
    assert.ok([200,201].includes(preEligibilityRfq.response.status));
    assert.equal(preEligibilityRfq.data.matching.fullyCovered,false);
    assert.equal(Number(preEligibilityRfq.data.matching.uncoveredTonnes),10000);

    const proposal={
      claimCategory:"voluntary_offset",
      eligibilityStatus:"eligible",
      eligibilityBasis:"Revisão humana auditável após Supply Intake; registry, batch, tradability e retirement validados.",
      sourceUnitStatus:"tradable",
      vintageStart:"2026-01-01",
      vintageEnd:"2026-08-01",
      commercialValidUntil:futureDate,
      offerExpiresAt:futureDateTime,
      registryProjectId:seeded.lead.registry_project_id,
      registryBatchId:`BATCH-INTAKE-${tag}`,
      registryEvidenceUrl:seeded.evidenceUrl,
      retirementSupported:true,
      fractionalRetirementSupported:true,
      retirementGranularityKg:1,
      beneficiaryRetirementSupported:true,
      ccpStatus:"not_assessed",
      riskFlags:[],
    };

    const legacyBlocked = await call(`/admin/market/assets/${assetId}/eligibility`,{
      method:"PATCH",body:JSON.stringify({...proposal,reviewNow:true}),
    });
    assert.equal(legacyBlocked.response.status,409,"Direct verified-offset promotion must require ledger");
    assert.equal(legacyBlocked.data.code,"ELIGIBILITY_LEDGER_REQUIRED");

    const reviewCreated = await call(`/admin/market/assets/${assetId}/eligibility-reviews`,{
      method:"POST",
      body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Supply Intake Smoke",note:"Review auditável pós-intake.",proposal}),
    });
    assert.equal(reviewCreated.response.status,201);
    const eligibilityReview=reviewCreated.data;
    assert.equal(eligibilityReview.status,"pending");
    assert.equal(String(eligibilityReview.proposed_sha256).length,64);
    assert.equal(eligibilityReview.preview_decision.allowed,true);

    const sameReview = await call(`/admin/market/assets/${assetId}/eligibility-reviews`,{
      method:"POST",
      body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Supply Intake Smoke",note:"Review auditável pós-intake.",proposal}),
    });
    assert.equal(sameReview.response.status,201);
    assert.equal(Number(sameReview.data.id),Number(eligibilityReview.id),"Identical pending review must be idempotent");

    const reviewApproved = await call(`/admin/market/eligibility-reviews/${eligibilityReview.id}/approve`,{
      method:"POST",body:JSON.stringify({reviewedBy:"Supply Intake Smoke",note:"Evidências conferidas e promoção aprovada."}),
    });
    assert.equal(reviewApproved.response.status,200);
    assert.equal(reviewApproved.data.review.status,"approved");
    assert.equal(String(reviewApproved.data.review.applied_sha256).length,64);
    assert.equal(reviewApproved.data.decision.allowed,true);
    assert.equal(reviewApproved.data.asset.sourcing_shelf,"verified_compensation");
    assert.equal(reviewApproved.data.asset.sourcing_executable,true);

    const eligibleAsset = (await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];
    assert.equal(eligibleAsset.claim_category,"voluntary_offset");
    assert.equal(eligibleAsset.eligibility_status,"eligible");
    assert.equal(eligibleAsset.source_unit_status,"tradable");
    assert.equal(eligibleAsset.sourcing_shelf,"verified_compensation");
    assert.equal(eligibleAsset.sourcing_executable,true);
    assert.ok(eligibleAsset.eligibility_checked_at);

    const mutateVerifiedBlocked = await call(`/admin/market/assets/${assetId}/eligibility`,{
      method:"PATCH",body:JSON.stringify({eligibilityBasis:"Tentativa de mutação direta pós-aprovação."}),
    });
    assert.equal(mutateVerifiedBlocked.response.status,409,"Already verified asset must remain ledger-controlled");
    assert.equal(mutateVerifiedBlocked.data.code,"ELIGIBILITY_LEDGER_REQUIRED");

    const postEligibilityRfq = await call(`/admin/demand/opportunities/${seeded.opportunity.id}/rfq`,{
      method:"POST",body:"{}",
    });
    assert.equal(postEligibilityRfq.response.status,201);
    assert.equal(postEligibilityRfq.data.matching.fullyCovered,true);
    assert.equal(Number(postEligibilityRfq.data.matching.coveredTonnes),10000);
    assert.equal(Number(postEligibilityRfq.data.matching.uncoveredTonnes),0);

    const rfqAfter = (await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[seeded.rfq.id])).rows[0];
    assert.equal(rfqAfter.status,"resolved");
    assert.equal(Number(rfqAfter.gap_tonnes),0);

    const detail = await call(`/admin/supply/intakes/${intake.id}`);
    assert.equal(detail.response.status,200);
    assert.equal(detail.data.status,"converted");
    assert.equal(Number(detail.data.monitored_asset_id),assetId);

    console.log("Supply Intake smoke OK",{
      runtimeRoutes:true,
      intakeId:Number(intake.id),
      prematureApprovalBlocked:true,
      approvalSha256:String(approve.data.approval_sha256),
      approvedIntakeImmutable:immutableBlocked,
      mandateId:Number(conversion.mandate.id),
      inventoryId:Number(conversion.inventory.id),
      monitoredAssetId:assetId,
      directEligibilityPromotionBlocked:true,
      eligibilityReviewId:Number(eligibilityReview.id),
      eligibilityProposedSha256:String(eligibilityReview.proposed_sha256),
      eligibilityAppliedSha256:String(reviewApproved.data.review.applied_sha256),
      verifiedAssetDirectMutationBlocked:true,
      offsetBlockedBeforeReview:true,
      rfqResolvedBeforeEligibility:false,
      explicitLedgerEligibilityAllowed:true,
      rfqResolvedAfterEligibility:true,
    });
  } finally {
    await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  }
}

try { await run(); }
finally { await pool.end(); }
