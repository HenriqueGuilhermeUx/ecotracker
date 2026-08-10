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
import { initDemandAutopilotDb } from "../dist/demand-autopilot-db.js";
import { initDemandSupplyRfqDb } from "../dist/demand-supply-rfq-db.js";
import { initSupplyOutreachDb } from "../dist/supply-outreach-db.js";
import { createAdminToken } from "../dist/auth.js";
import { registerSupplyOutreachRoutes } from "../dist/supply-outreach-routes.js";
import { dispatchSupplyOutbox, supplyOutreachStatus } from "../dist/supply-outreach.js";

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
  await initDemandAutopilotDb();
  await initDemandSupplyRfqDb();
  await initSupplyOutreachDb();
}

async function seed() {
  const account = (await pool.query(`
    INSERT INTO demand_accounts(
      source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
      contact_status,status,lead_score,metadata,last_checked_at
    ) VALUES('supply_outreach_smoke',$1,'Comprador Supply Outreach S.A.','Comprador Supply Outreach S.A.',
      '40.000.000/0001-00','Industrial','Brasil','Diretoria ESG',$2,'qualified','qualified',99,$3::jsonb,NOW())
    RETURNING *`,[
    `buyer-${tag}`,
    `buyer-supply-${tag}@example.com`,
    JSON.stringify({smoke:true}),
  ])).rows[0];

  const opportunity = (await pool.query(`
    INSERT INTO demand_opportunities(
      account_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes
    ) VALUES($1,'sourcing_required',10000,'custom','voluntary_offset',2026,95,$2::jsonb,'Supply outreach smoke')
    RETURNING *`,[account.id,JSON.stringify({smoke:true})])).rows[0];

  const rfq = (await pool.query(`
    INSERT INTO market_maker_rfqs(
      opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,
      preferred_country,priority_score,requirements,source
    ) VALUES($1,$2,'open','voluntary_offset',2026,10000,0,10000,'Brasil',95,$3::jsonb,'supply_outreach_smoke')
    RETURNING *`,[opportunity.id,account.id,JSON.stringify({claimReadyRequired:true})])).rows[0];

  const lead = (await pool.query(`
    INSERT INTO supply_leads(
      registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
      methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,
      confirmed_free_tonnes,evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
    ) VALUES(
      'Verra VCS',$1,'Projeto Supply Outreach Smoke','Brasil','Mato Grosso','Fornecedor Supply Smoke Ltda',
      'Mesa Comercial',$2,'VM0047','2026',20000,8000,0,12000,12000,$3,$4,'supply_outreach_smoke',
      'seller_confirmed','qualified','qualified','Seller-confirmed, ainda não claim-ready.',$5::jsonb,NOW())
    RETURNING *`,[
    `VCS-SUPPLY-${tag}`,
    `supplier-${tag}@example.com`,
    `https://example.com/supply/evidence/${tag}`,
    `https://example.com/supply/source/${tag}`,
    JSON.stringify({smoke:true,claimReady:false}),
  ])).rows[0];

  const candidate = (await pool.query(`
    INSERT INTO market_maker_rfq_candidates(
      rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
      candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
    ) VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Supply Outreach Smoke','Brasil','2026',
      12000,'seller_confirmed',95,'identified',FALSE,$5::jsonb,$6::jsonb,NOW())
    RETURNING *`,[
    rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id,
    JSON.stringify({basis:"seller_confirmed_free_inventory",claimReady:false,mandateRequired:true}),
    JSON.stringify({supplierName:lead.supplier_name,supplierEmail:lead.supplier_email}),
  ])).rows[0];

  const overflowCandidate = (await pool.query(`
    INSERT INTO market_maker_rfq_candidates(
      rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
      candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
    ) VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Supply Outreach Smoke Backup','Brasil','2026',
      12000,'seller_confirmed',80,'identified',FALSE,$5::jsonb,$6::jsonb,NOW())
    RETURNING *`,[
    rfq.id,`lead-backup:${lead.id}`,lead.id,lead.registry_project_id,
    JSON.stringify({basis:"seller_confirmed_free_inventory",claimReady:false}),
    JSON.stringify({supplierName:lead.supplier_name,supplierEmail:lead.supplier_email}),
  ])).rows[0];

  return {account,opportunity,rfq,lead,candidate,overflowCandidate};
}

async function startApi() {
  const app = express();
  app.use(express.json());
  registerSupplyOutreachRoutes(app);
  const server = app.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Falha ao abrir porta do smoke HTTP");
  const base = `http://127.0.0.1:${address.port}/api`;
  const token = createAdminToken();
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
  const monitoredBefore = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM monitored_assets`)).rows[0].count);
  const {server,call} = await startApi();
  try {
    const statusHttp = await call("/admin/market-maker/supply-outreach/status");
    assert.equal(statusHttp.response.status,200,"Supply Outreach status route must exist at runtime");
    assert.equal(statusHttp.data.live,false,"Live supplier email must start OFF");

    const selectedHttp = await call(`/admin/market-maker/rfqs/${seeded.rfq.id}/candidates/${seeded.candidate.id}/select`,{
      method:"POST",
      body:JSON.stringify({requestedTonnes:10000,responseDays:5,selectedBy:"Supply Outreach Smoke",note:"Smoke selection"}),
    });
    assert.equal(selectedHttp.response.status,201);
    const selection = selectedHttp.data;
    assert.ok(Number(selection.id)>0);
    assert.equal(Number(selection.requested_tonnes),10000);

    let overflowBlocked = false;
    try {
      await pool.query(`
        INSERT INTO market_maker_supply_selections(
          rfq_id,candidate_id,supply_lead_id,requested_tonnes,status,response_due_at,selected_by,snapshot
        ) VALUES($1,$2,$3,10000.01,'selected',NOW()+INTERVAL '5 days','DB trigger smoke','{}'::jsonb)`,[
        seeded.rfq.id,seeded.overflowCandidate.id,seeded.lead.id,
      ]);
    } catch (error) {
      overflowBlocked = String(error?.message || error).includes("market_maker_supply_selection_overallocated");
    }
    assert.equal(overflowBlocked,true,"PostgreSQL trigger must block supplier RFQ volume above demand gap");

    const outboxHttp = await call(`/admin/market-maker/supply-selections/${selection.id}/outbox`,{
      method:"POST",body:JSON.stringify({createdBy:"Supply Outreach Smoke"}),
    });
    assert.equal(outboxHttp.response.status,201);
    const outbox = outboxHttp.data;
    assert.ok(Number(outbox.id)>0);
    assert.equal(outbox.status,"ready");
    assert.equal(outbox.recipient_email,seeded.lead.supplier_email);

    const outboxAgain = await call(`/admin/market-maker/supply-selections/${selection.id}/outbox`,{
      method:"POST",body:JSON.stringify({createdBy:"Supply Outreach Smoke"}),
    });
    assert.equal(outboxAgain.response.status,201);
    assert.equal(Number(outboxAgain.data.id),Number(outbox.id),"Outbox creation must be idempotent");

    const blockedDispatch = await call(`/admin/market-maker/supply-outbox/${outbox.id}/dispatch`,{
      method:"POST",body:JSON.stringify({actor:"Supply Outreach Smoke"}),
    });
    assert.equal(blockedDispatch.response.status,409,"Live dispatch must be blocked by feature gate");

    let providerCalls = 0;
    const fakeSender = async (input) => {
      providerCalls += 1;
      assert.equal(input.to,seeded.lead.supplier_email);
      assert.ok(input.idempotencyKey.startsWith("ecotracker-supply-rfq/"));
      return {providerReference:`fake-supply-${tag}`};
    };
    const sent = await dispatchSupplyOutbox(Number(outbox.id),{
      sender:fakeSender,testBypassGate:true,actor:"Supply Outreach Smoke",
    });
    assert.equal(sent.alreadySent,false);
    assert.equal(sent.outbox.status,"sent");
    assert.equal(providerCalls,1);
    const sentAgain = await dispatchSupplyOutbox(Number(outbox.id),{
      sender:fakeSender,testBypassGate:true,actor:"Supply Outreach Smoke",
    });
    assert.equal(sentAgain.alreadySent,true);
    assert.equal(providerCalls,1,"Second dispatch must not call provider again");

    const responseHttp = await call(`/admin/market-maker/supply-selections/${selection.id}/response`,{
      method:"POST",
      body:JSON.stringify({
        confirmedAvailableTonnes:9500,
        firmPriceUsdTonne:8.75,
        minOrderTonnes:100,
        retirementSupported:true,
        beneficiaryRetirementSupported:true,
        registryEvidenceUrl:`https://example.com/supply/confirmed/${tag}`,
        responseNote:"Fornecedor confirmou 9.500 t livres.",
        respondedBy:"Supply Outreach Smoke",
      }),
    });
    assert.equal(responseHttp.response.status,201);
    assert.equal(responseHttp.data.status,"confirmed");
    assert.equal(Number(responseHttp.data.confirmed_available_tonnes),9500);

    const leadAfter = (await pool.query(`SELECT * FROM supply_leads WHERE id=$1`,[seeded.lead.id])).rows[0];
    assert.equal(Number(leadAfter.confirmed_free_tonnes),9500);
    assert.equal(leadAfter.availability_confidence,"seller_confirmed");
    assert.equal(leadAfter.contact_status,"qualified");

    const selectionList = await call("/admin/market-maker/supply-selections?limit=20");
    assert.equal(selectionList.response.status,200);
    const listed = selectionList.data.items.find((item) => Number(item.id)===Number(selection.id));
    assert.ok(listed);
    assert.ok(Number(listed.response_id)>0);
    assert.equal(Number(listed.confirmed_available_tonnes),9500);
    assert.equal(listed.retirement_supported,true);

    const outboxList = await call("/admin/market-maker/supply-outbox?limit=20");
    assert.equal(outboxList.response.status,200);
    const listedOutbox = outboxList.data.items.find((item) => Number(item.id)===Number(outbox.id));
    assert.ok(listedOutbox);
    assert.equal(listedOutbox.status,"sent");

    const monitoredAfter = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM monitored_assets`)).rows[0].count);
    assert.equal(monitoredAfter,monitoredBefore,"Seller confirmation must not create a monitored claim-ready asset");

    const rfqAfter = (await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[seeded.rfq.id])).rows[0];
    assert.notEqual(rfqAfter.status,"resolved","Seller confirmation alone must not resolve the carbon RFQ");
    assert.equal(Number(rfqAfter.gap_tonnes),10000);

    const status = await supplyOutreachStatus();
    assert.equal(status.live,false);
    assert.equal(Number(status.counts.sent),1);
    assert.equal(Number(status.counts.confirmed_responses),1);

    console.log("Supply Outreach smoke OK",{
      runtimeRoutes:true,
      rfqId:Number(seeded.rfq.id),
      selectionId:Number(selection.id),
      requestedTonnes:10000,
      overflowBlocked,
      liveDispatchBlocked:true,
      providerCalls,
      sellerConfirmedTonnes:Number(leadAfter.confirmed_free_tonnes),
      sellerConfirmationCreatedClaimReadyAsset:false,
      rfqResolvedBySellerConfirmation:false,
      supplyOutreachLive:status.live,
    });
  } finally {
    await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  }
}

try { await run(); }
finally { await pool.end(); }
