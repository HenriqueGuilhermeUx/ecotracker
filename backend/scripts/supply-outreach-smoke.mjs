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
import {
  createSupplyOutbox,
  dispatchSupplyOutbox,
  recordSupplyResponse,
  selectSupplyCandidate,
  supplyOutreachStatus,
} from "../dist/supply-outreach.js";

const tag = Date.now();

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
}

async function seed() {
  const account = (await pool.query(`
    INSERT INTO demand_accounts(
      source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,status,lead_score,metadata,last_checked_at
    ) VALUES('supply_outreach_e2e',$1,'Comprador Secreto E2E S.A.','Comprador Secreto E2E S.A.','40.000.000/0001-00',
      'Industrial','Brasil','Diretoria ESG',$2,'qualified',99,$3::jsonb,NOW()) RETURNING *`,[
    `buyer-${tag}`,`buyer-hidden-${tag}@example.com`,JSON.stringify({e2e:true}),
  ])).rows[0];
  const inventory = (await pool.query(`
    INSERT INTO demand_inventories(account_id,inventory_year,scope1_tonnes,scope2_market_tonnes,scope2_location_tonnes,scope3_tonnes,reported_total_tonnes,verification_level,verification_provider,source_url,metadata)
    VALUES($1,2026,20000,10000,10000,5000,35000,'verified','Supply Outreach E2E',$2,$3::jsonb) RETURNING *`,[
    account.id,`https://example.com/supply-outreach/buyer/${tag}`,JSON.stringify({e2e:true}),
  ])).rows[0];
  const opportunity = (await pool.query(`
    INSERT INTO demand_opportunities(account_id,inventory_id,status,target_tonnes,target_basis,claim_purpose,target_year,max_price_usd_tonne,preferred_country,priority_score,constraints,notes)
    VALUES($1,$2,'sourcing_required',30000,'scope1_2','voluntary_offset',2026,15,'Brasil',100,$3::jsonb,'Supply outreach smoke') RETURNING *`,[
    account.id,inventory.id,JSON.stringify({e2e:true}),
  ])).rows[0];
  const rfq = (await pool.query(`
    INSERT INTO market_maker_rfqs(opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,preferred_country,max_price_usd_tonne,priority_score,requirements,source,last_match_at)
    VALUES($1,$2,'partially_sourced','voluntary_offset',2026,30000,12000,18000,'Brasil',15,100,$3::jsonb,'supply_outreach_e2e',NOW()) RETURNING *`,[
    opportunity.id,account.id,JSON.stringify({strictRule:"claim-ready required",e2e:true}),
  ])).rows[0];
  const lead = (await pool.query(`
    INSERT INTO supply_leads(
      registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,supplier_phone,
      methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,confirmed_free_tonnes,
      evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
    ) VALUES('Verra VCS',$1,'Projeto Cerrado Supplier E2E','Brasil','Mato Grosso','Fornecedor Carbono E2E Ltda','Originação E2E',$2,'+5511999999999',
      'VM0047','2026',50000,25000,0,25000,20000,$3,$4,'supply_outreach_e2e','seller_confirmed','qualified','qualified',
      'Saldo comercial confirmado, ainda não claim-ready.',$5::jsonb,NOW()) RETURNING *`,[
    `VCS-SUPPLY-${tag}`,`supplier-${tag}@example.com`,
    `https://example.com/supply-outreach/evidence/${tag}`,
    `https://example.com/supply-outreach/source/${tag}`,
    JSON.stringify({e2e:true,claimReady:false}),
  ])).rows[0];
  const candidate = (await pool.query(`
    INSERT INTO market_maker_rfq_candidates(
      rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
      candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
    ) VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Cerrado Supplier E2E','Brasil','2026',20000,
      'seller_confirmed',85,'identified',FALSE,$5::jsonb,$6::jsonb,NOW()) RETURNING *`,[
    rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id,
    JSON.stringify({basis:"seller_confirmed_free_inventory",claimReady:false,mandateRequired:true}),
    JSON.stringify({supplierName:lead.supplier_name,supplierEmail:lead.supplier_email,e2e:true}),
  ])).rows[0];
  return {account,inventory,opportunity,rfq,lead,candidate};
}

async function expectFailure(fn,regex) {
  let failed=false;
  try { await fn(); }
  catch (error) { failed=true; assert.match(String(error?.message || error),regex); }
  assert.equal(failed,true,`Era esperada falha ${regex}`);
}

async function run() {
  await init();
  const data = await seed();
  const before = await supplyOutreachStatus();
  assert.equal(before.live,false,"Supply outreach real deve iniciar desligado");
  assert.equal(before.behavior.sellerResponseIsNotClaimReady,true);

  const selection = await selectSupplyCandidate({
    rfqId:Number(data.rfq.id),candidateId:Number(data.candidate.id),requestedTonnes:18000,maxPriceUsdTonne:15,
    responseDays:5,selectedBy:"ci-supply-desk",note:"Selecionado para RFQ E2E",
  });
  assert.equal(selection.status,"approved");
  assert.equal(Number(selection.requested_tonnes),18000);
  assert.match(String(selection.snapshot_sha256),/^[a-f0-9]{64}$/);
  assert.equal(selection.snapshot.integrity.claimReady,false);
  assert.equal(selection.snapshot.rfq.buyerCompanyInternal,"Comprador Secreto E2E S.A.");

  const duplicateSelection = await selectSupplyCandidate({rfqId:Number(data.rfq.id),candidateId:Number(data.candidate.id),selectedBy:"ci-supply-desk"});
  assert.equal(Number(duplicateSelection.id),Number(selection.id));
  const selectedCandidate = (await pool.query(`SELECT * FROM market_maker_rfq_candidates WHERE id=$1`,[data.candidate.id])).rows[0];
  assert.equal(selectedCandidate.status,"selected");
  assert.equal(selectedCandidate.auto_close_eligible,false);

  const outbox = await createSupplyOutbox({selectionId:Number(selection.id),createdBy:"ci-supply-desk"});
  assert.equal(outbox.status,"ready");
  assert.equal(outbox.recipient_email,data.lead.supplier_email);
  assert.match(String(outbox.idempotency_key),/^ecotracker-supply-rfq\/[0-9a-f-]{36}$/);
  assert.match(String(outbox.text_body),/não representa compromisso de compra/i);
  assert.match(String(outbox.text_body),/gates de elegibilidade/i);
  assert.equal(String(outbox.text_body).includes("Comprador Secreto E2E"),false,"E-mail ao fornecedor não pode revelar o comprador");
  const duplicateOutbox = await createSupplyOutbox({selectionId:Number(selection.id)});
  assert.equal(Number(duplicateOutbox.id),Number(outbox.id));

  await expectFailure(()=>dispatchSupplyOutbox(Number(outbox.id)),/Supply outreach está desligado/);

  let calls=0;
  let idem=null;
  const fakeSender = async (input) => {
    calls+=1; idem=input.idempotencyKey;
    assert.equal(input.to,data.lead.supplier_email);
    assert.match(input.subject,/EcoTracker RFQ/);
    return {providerReference:`fake-supply-resend-${tag}`};
  };
  const sent = await dispatchSupplyOutbox(Number(outbox.id),{sender:fakeSender,testBypassGate:true,actor:"ci-supply-dispatch"});
  assert.equal(sent.alreadySent,false);
  assert.equal(sent.outbox.status,"sent");
  assert.equal(calls,1);
  assert.equal(idem,outbox.idempotency_key);
  const sentAgain = await dispatchSupplyOutbox(Number(outbox.id),{sender:fakeSender,testBypassGate:true,actor:"ci-supply-dispatch"});
  assert.equal(sentAgain.alreadySent,true);
  assert.equal(calls,1,"Retry de dispatch não pode chamar provider novamente");
  const contacting = (await pool.query(`SELECT status,auto_close_eligible FROM market_maker_rfq_candidates WHERE id=$1`,[data.candidate.id])).rows[0];
  assert.equal(contacting.status,"contacting");
  assert.equal(contacting.auto_close_eligible,false);

  const response = await recordSupplyResponse({
    selectionId:Number(selection.id),confirmedAvailableTonnes:18500,firmPriceUsdTonne:11.25,minOrderTonnes:1000,
    retirementSupported:true,beneficiaryRetirementSupported:true,
    registryEvidenceUrl:`https://example.com/supply-outreach/response-evidence/${tag}`,
    offerValidUntil:new Date(Date.now()+7*86_400_000).toISOString(),
    responseNote:"Fornecedor confirma disponibilidade e retirement on behalf.",recordedBy:"ci-supply-desk",
    rawResponse:{channel:"email",e2e:true},
  });
  assert.equal(Number(response.confirmed_available_tonnes),18500);
  assert.equal(Number(response.firm_price_usd_tonne),11.25);
  assert.equal(response.retirement_supported,true);

  const duplicateResponse = await recordSupplyResponse({selectionId:Number(selection.id),confirmedAvailableTonnes:1,recordedBy:"ci"});
  assert.equal(Number(duplicateResponse.id),Number(response.id),"Resposta registrada deve ser idempotente por seleção");

  const candidateAfter = (await pool.query(`SELECT * FROM market_maker_rfq_candidates WHERE id=$1`,[data.candidate.id])).rows[0];
  assert.equal(candidateAfter.status,"qualified");
  assert.equal(candidateAfter.confidence,"seller_confirmed");
  assert.equal(Number(candidateAfter.candidate_tonnes),18500);
  assert.equal(candidateAfter.auto_close_eligible,false);
  assert.equal(candidateAfter.rationale.claimReady,false);
  assert.equal(candidateAfter.rationale.sellerResponseRecorded,true);

  const leadAfter = (await pool.query(`SELECT * FROM supply_leads WHERE id=$1`,[data.lead.id])).rows[0];
  assert.equal(Number(leadAfter.confirmed_free_tonnes),18500);
  assert.equal(leadAfter.availability_confidence,"seller_confirmed");

  const rfqAfter = (await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[data.rfq.id])).rows[0];
  assert.equal(rfqAfter.status,"partially_sourced","Resposta comercial não pode resolver RFQ climático");
  assert.equal(Number(rfqAfter.gap_tonnes),18000,"Gap climático permanece até claim-ready matching");
  assert.equal(Number(rfqAfter.covered_tonnes),12000);

  const claimReadyFromSupplier = Number((await pool.query(`
    SELECT COUNT(*)::int AS count FROM monitored_assets
    WHERE registry_project_id=$1 OR source_reference=$2`,[data.lead.registry_project_id,`lead:${data.lead.id}`])).rows[0].count);
  assert.equal(claimReadyFromSupplier,0,"Resposta do fornecedor não pode publicar monitored asset automaticamente");
  const mandateCount = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM supplier_mandates WHERE lead_id=$1`,[data.lead.id])).rows[0].count);
  assert.equal(mandateCount,0,"Resposta do fornecedor não pode criar mandato automaticamente");

  const events = (await pool.query(`SELECT event_type FROM supply_outreach_events WHERE rfq_id=$1 ORDER BY id`,[data.rfq.id])).rows.map((row)=>row.event_type);
  assert.deepEqual(events,["candidate_selected","supply_outbox_created","supply_outbox_sent","supplier_response_recorded"]);

  const after = await supplyOutreachStatus();
  assert.equal(after.live,false);
  assert.equal(Number(after.counts.selected),1);
  assert.equal(Number(after.counts.sent),1);
  assert.equal(Number(after.counts.responses),1);

  console.log("Supply Outreach smoke OK",{
    rfqId:Number(data.rfq.id),candidateId:Number(data.candidate.id),selectionId:Number(selection.id),
    requestedTonnes:18000,supplierConfirmedTonnes:18500,firmPriceUsdTonne:11.25,
    emailSentWithFakeProvider:true,providerCalls:calls,buyerIdentityExposed:false,
    claimReadyAutoPromotion:false,autoMandate:false,rfqStatus:rfqAfter.status,gapTonnes:Number(rfqAfter.gap_tonnes),liveOutreach:after.live,
  });
}

try { await run(); }
finally { await pool.end(); }
