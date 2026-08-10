import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
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
import { createSupplyIntakeFromSelection, updateSupplyIntake, approveSupplyIntake, convertApprovedSupplyIntake } from "../dist/supply-intake.js";
import { registerSupplyEligibilityRoutes } from "../dist/supply-eligibility-routes.js";
import { createAdminToken } from "../dist/auth.js";

const tag=Date.now();
const futureDateTime="2026-12-31T23:59:59.000Z";

async function init() {
  await initDb();
  await initMarketDb();
  await initEligibilityDb();
  await initCommerceDb();
  await initAssistedSourcingDb();
  await initSupplyDeskDb();
  await initDemandDeskDb();
  await initDemandProposalDb();
  await initDemandSupplyRfqDb();
  await initSupplyOutreachDb();
  await initSupplyIntakeDb();
  await initSupplyEligibilityDb();
}

async function seedSellerConfirmed() {
  await pool.query(`UPDATE monitored_assets SET active=FALSE WHERE active=TRUE`);
  const account=(await pool.query(`
    INSERT INTO demand_accounts(
      source,source_reference,company_name,legal_name,tax_id,sector,country,
      contact_name,contact_email,contact_status,status,lead_score,metadata,last_checked_at
    ) VALUES('supply_eligibility_smoke',$1,'Buyer Eligibility S.A.','Buyer Eligibility S.A.',
      '51.000.000/0001-00','Industrial','Brasil','Diretoria ESG',$2,'qualified','qualified',99,$3::jsonb,NOW()) RETURNING *`,[
    `buyer-${tag}`,`buyer-${tag}@example.com`,JSON.stringify({smoke:true}),
  ])).rows[0];
  const opportunity=(await pool.query(`
    INSERT INTO demand_opportunities(account_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes)
    VALUES($1,'sourcing_required',10000,'custom','voluntary_offset',2026,99,$2::jsonb,'Supply Eligibility smoke') RETURNING *`,[
    account.id,JSON.stringify({smoke:true}),
  ])).rows[0];
  const rfq=(await pool.query(`
    INSERT INTO market_maker_rfqs(
      opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,
      preferred_country,priority_score,requirements,source
    ) VALUES($1,$2,'open','voluntary_offset',2026,10000,0,10000,'Brasil',99,$3::jsonb,'supply_eligibility_smoke') RETURNING *`,[
    opportunity.id,account.id,JSON.stringify({claimReadyRequired:true}),
  ])).rows[0];
  const evidence=`https://example.com/registry/${tag}`;
  const source=`https://example.com/source/${tag}`;
  const lead=(await pool.query(`
    INSERT INTO supply_leads(
      registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
      methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,
      confirmed_free_tonnes,evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
    ) VALUES('Verra VCS',$1,'Projeto Eligibility Smoke','Brasil','Mato Grosso','Fornecedor Eligibility Ltda','Mesa Comercial',$2,
      'VM0047','2026',20000,10000,0,10000,10000,$3,$4,'supply_eligibility_smoke','seller_confirmed','qualified','qualified',
      'Seller-confirmed aguardando intake.',$5::jsonb,NOW()) RETURNING *`,[
    `VCS-ELIG-${tag}`,`supplier-${tag}@example.com`,evidence,source,JSON.stringify({smoke:true}),
  ])).rows[0];
  const candidate=(await pool.query(`
    INSERT INTO market_maker_rfq_candidates(
      rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
      candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
    ) VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Eligibility Smoke','Brasil','2026',10000,
      'seller_confirmed',95,'qualified',FALSE,$5::jsonb,$6::jsonb,NOW()) RETURNING *`,[
    rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id,
    JSON.stringify({basis:"seller_confirmed",claimReady:false}),JSON.stringify({supplierName:lead.supplier_name,evidenceUrl:evidence}),
  ])).rows[0];
  const selection=(await pool.query(`
    INSERT INTO market_maker_supply_selections(
      rfq_id,candidate_id,supply_lead_id,requested_tonnes,status,response_due_at,selected_by,selected_note,snapshot
    ) VALUES($1,$2,$3,10000,'responded',NOW()+INTERVAL '5 days','Eligibility Smoke','Seller respondeu',$4::jsonb) RETURNING *`,[
    rfq.id,candidate.id,lead.id,JSON.stringify({smoke:true}),
  ])).rows[0];
  await pool.query(`
    INSERT INTO market_maker_supply_responses(
      selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,
      retirement_supported,beneficiary_retirement_supported,registry_evidence_url,valid_until,
      response_note,responded_by,response_snapshot
    ) VALUES($1,'confirmed',10000,8.75,1,TRUE,TRUE,$2,$3::timestamptz,'Confirmado','Eligibility Smoke',$4::jsonb)`,[
    selection.id,evidence,futureDateTime,JSON.stringify({smoke:true}),
  ]);
  return {account,opportunity,rfq,lead,selection,evidence,source};
}

async function prepareConvertedIntake(seed) {
  const intake=await createSupplyIntakeFromSelection({selectionId:Number(seed.selection.id),createdBy:"Eligibility Smoke"});
  await updateSupplyIntake({
    reviewId:Number(intake.id),authorizedTonnes:10000,floorPriceUsdTonne:8.75,minOrderTonnes:1,
    batchReference:`BATCH-ELIG-${tag}`,vintage:"2026",serialStart:`SERIAL-${tag}-1`,serialEnd:`SERIAL-${tag}-10000`,
    methodology:"VM0047",registryEvidenceUrl:seed.evidence,sourceUrl:seed.source,
    retirementSupported:true,beneficiaryRetirementSupported:true,fractionalRetirementSupported:true,retirementGranularityKg:1,
    commercialValidUntil:futureDateTime,legalKycStatus:"approved",registryEvidenceStatus:"verified",commercialTermsStatus:"approved",
    reviewNote:"Diligência completa para smoke de eligibility.",actor:"Eligibility Smoke",
  });
  await approveSupplyIntake({reviewId:Number(intake.id),approvedBy:"Eligibility Smoke",note:"Intake aprovado."});
  const conversion=await convertApprovedSupplyIntake({reviewId:Number(intake.id),convertedBy:"Eligibility Smoke"});
  return {intake,conversion};
}

async function startApi() {
  const app=express();app.use(express.json());registerSupplyEligibilityRoutes(app);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string") throw new Error("Falha ao abrir API smoke");
  const token=createAdminToken();const base=`http://127.0.0.1:${address.port}/api`;
  async function call(path,options={}) {
    const response=await fetch(`${base}${path}`,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...(options.headers||{})}});
    const data=await response.json().catch(()=>({}));return {response,data};
  }
  return {server,call};
}

async function run() {
  await init();
  const seed=await seedSellerConfirmed();
  const {intake,conversion}=await prepareConvertedIntake(seed);
  const assetId=Number(conversion.monitoredAsset.id);
  const {server,call}=await startApi();
  try {
    const before=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];
    assert.equal(before.claim_category,"climate_contribution");
    assert.equal(before.eligibility_status,"under_review");
    assert.equal(before.sourcing_shelf,"restricted");
    assert.equal(before.sourcing_executable,false);

    const queue=await call("/admin/supply/eligibility-queue");
    assert.equal(queue.response.status,200);
    const pending=queue.data.items.find((item)=>Number(item.intake_review_id)===Number(intake.id));
    assert.ok(pending,"Converted intake must appear in eligibility queue");
    assert.equal(pending.eligibility_review_id,null);

    const invalid=await call(`/admin/supply/intakes/${intake.id}/eligibility/approve`,{
      method:"POST",body:JSON.stringify({eligibilityBasis:"Fundamentação registral completa para o teste.",tradabilityConfirmed:false}),
    });
    assert.equal(invalid.response.status,400,"Approval must require explicit tradability confirmation");

    const approved=await call(`/admin/supply/intakes/${intake.id}/eligibility/approve`,{
      method:"POST",body:JSON.stringify({
        reviewedBy:"Eligibility Smoke",tradabilityConfirmed:true,
        eligibilityBasis:"Revisão humana confirmou registry, batch/serial, saldo tradable, vintage, retirement e evidência do projeto.",
        ccpStatus:"not_assessed",riskFlags:[],
      }),
    });
    assert.equal(approved.response.status,200);
    assert.equal(approved.data.review.status,"approved");
    assert.equal(String(approved.data.review.review_sha256).length,64);
    assert.equal(approved.data.offsetDecision.allowed,true);
    assert.equal(approved.data.asset.claim_category,"voluntary_offset");
    assert.equal(approved.data.asset.eligibility_status,"eligible");
    assert.equal(approved.data.asset.source_unit_status,"tradable");
    assert.equal(approved.data.asset.sourcing_shelf,"verified_compensation");
    assert.equal(approved.data.asset.sourcing_executable,false,"Climate approval must never activate programmatic execution");
    assert.equal(approved.data.matching.fullyCovered,true,"Matching must refresh automatically after claim-ready approval");
    assert.equal(Number(approved.data.matching.uncoveredTonnes),0);

    const rfq=(await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[seed.rfq.id])).rows[0];
    assert.equal(rfq.status,"resolved","Linked RFQ must resolve automatically after full claim-ready coverage");
    assert.equal(Number(rfq.gap_tonnes),0);

    const duplicate=await call(`/admin/supply/intakes/${intake.id}/eligibility/approve`,{
      method:"POST",body:JSON.stringify({
        reviewedBy:"Eligibility Smoke",tradabilityConfirmed:true,
        eligibilityBasis:"Revisão humana confirmou registry, batch/serial, saldo tradable, vintage, retirement e evidência do projeto.",riskFlags:[],
      }),
    });
    assert.equal(duplicate.response.status,200);
    assert.equal(duplicate.data.idempotent,true);
    assert.equal(Number(duplicate.data.review.id),Number(approved.data.review.id));

    let immutable=false;
    try { await pool.query(`UPDATE supply_eligibility_reviews SET eligibility_basis='mutated' WHERE id=$1`,[approved.data.review.id]); }
    catch(error){ immutable=String(error?.message||error).includes("supply_eligibility_review_is_immutable"); }
    assert.equal(immutable,true,"Eligibility decision must be immutable in PostgreSQL");

    const afterQueue=await call("/admin/supply/eligibility-queue");
    const final=afterQueue.data.items.find((item)=>Number(item.intake_review_id)===Number(intake.id));
    assert.equal(final.eligibility_review_status,"approved");
    assert.equal(final.executionState,"assisted_or_manual");

    console.log("Supply Eligibility smoke OK",{
      queue:true,tradabilityGate:true,reviewSha256:String(approved.data.review.review_sha256),
      claimReady:true,programmaticExecution:false,matchingAutoRefresh:true,rfqResolved:true,idempotent:true,immutable:true,
    });
  } finally {
    await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  }
}

try { await run(); }
finally { await pool.end(); }
