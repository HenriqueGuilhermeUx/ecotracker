import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initAssistedSourcingDb } from "../dist/assisted-sourcing-db.js";
import { initSupplyDeskDb } from "../dist/supply-desk-db.js";
import { initDemandDeskDb } from "../dist/demand-desk-db.js";
import { initDemandProposalDb } from "../dist/demand-proposal-db.js";
import { initCommercialOutreachDb } from "../dist/commercial-outreach-db.js";
import { createDemandProposal } from "../dist/demand-proposal.js";
import {
  approveDemandProposal,
  commercialOutreachStatus,
  createDemandProposalOutbox,
  dispatchDemandOutbox,
  rejectDemandProposal,
} from "../dist/commercial-outreach.js";

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
  await initCommercialOutreachDb();
}

async function seedAsset() {
  return (await pool.query(`
    INSERT INTO monitored_assets (
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,
      source_price_usd_ton,fx_brl_usd,available_tons,min_order_kg,pricing_mode,availability_status,source_status,
      active,claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,
      commercial_valid_until,offer_expires_at,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      ccp_status,eligibility_checked_at,sourcing_score,sourcing_tier,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES (
      'Commercial E2E Registry','Commercial Outreach Claim-ready Lot',$1,$2,'Commercial E2E','Brasil','2026','carbon','premium',
      9,5.0,5000,1,'dynamic','confirmed','connected',
      TRUE,'voluntary_offset','eligible','Commercial Outreach test asset','tradable',CURRENT_DATE-INTERVAL '1 year',CURRENT_DATE,
      CURRENT_DATE+INTERVAL '30 days',NOW()+INTERVAL '30 days',$3,$4,$5,
      TRUE,TRUE,1,TRUE,'approved',NOW(),99,'A','verified_compensation',TRUE,NOW()
    ) RETURNING *`,[
    `commercial-e2e-${tag}`,
    `https://example.com/commercial-e2e/${tag}`,
    `COMMERCIAL-PROJECT-${tag}`,
    `COMMERCIAL-BATCH-${tag}`,
    `https://example.com/commercial-e2e/registry/${tag}`,
  ])).rows[0];
}

async function seedOpportunity({suffix,name,targetTonnes}) {
  const account = (await pool.query(`
    INSERT INTO demand_accounts(
      source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
      status,lead_score,metadata,last_checked_at
    ) VALUES('commercial_e2e',$1,$2,$2,$3,'Industrial','Brasil',$4,$5,'qualified',95,$6::jsonb,NOW())
    RETURNING *`,[
    `account-${suffix}-${tag}`,name,`00.100.00${suffix}/0001-00`,`Diretor Sustentabilidade ${suffix}`,
    `commercial-${suffix}-${tag}@example.com`,JSON.stringify({e2e:true}),
  ])).rows[0];
  const inventory = (await pool.query(`
    INSERT INTO demand_inventories(
      account_id,inventory_year,scope1_tonnes,scope2_market_tonnes,scope2_location_tonnes,scope3_tonnes,
      reported_total_tonnes,verification_level,verification_provider,source_url,metadata
    ) VALUES($1,2026,$2,0,0,0,$2,'verified','Commercial E2E Verifier',$3,$4::jsonb)
    RETURNING *`,[
    account.id,targetTonnes,`https://example.com/commercial-e2e/inventory/${suffix}/${tag}`,JSON.stringify({e2e:true}),
  ])).rows[0];
  const opportunity = (await pool.query(`
    INSERT INTO demand_opportunities(
      account_id,inventory_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes
    ) VALUES($1,$2,'identified',$3,'scope1_2','voluntary_offset',2026,100,$4::jsonb,'Commercial E2E')
    RETURNING *`,[account.id,inventory.id,targetTonnes,JSON.stringify({e2e:true})])).rows[0];
  return {account,inventory,opportunity};
}

async function expectFailure(fn,match) {
  let failed = false;
  try { await fn(); }
  catch (error) {
    failed = true;
    assert.match(String(error?.message || error),match);
  }
  assert.equal(failed,true,`Era esperada falha compatível com ${match}`);
}

async function run() {
  await init();
  await seedAsset();

  const live = await commercialOutreachStatus();
  assert.equal(live.live,false,"Outreach real deve iniciar desligado");

  const covered = await seedOpportunity({suffix:"1",name:"Empresa Comercial Coberta S.A.",targetTonnes:5000});
  const proposal = await createDemandProposal({opportunityId:Number(covered.opportunity.id),validityMinutes:1440,notes:"Commercial outreach E2E"});
  assert.equal(proposal.status,"draft");
  assert.equal(Number(proposal.coverage_pct),100);
  assert.equal(Number(proposal.uncovered_tonnes),0);

  const review = await approveDemandProposal({proposalId:Number(proposal.id),reviewedBy:"ci-commercial-review",note:"Aprovada no smoke E2E"});
  assert.equal(review.status,"approved");
  assert.match(String(review.snapshot_sha256),/^[a-f0-9]{64}$/);
  assert.equal(Number(review.snapshot.commercial.finalTotalBrl),Number(proposal.final_total_brl));
  assert.equal(review.snapshot.items.length,1);

  const duplicateReview = await approveDemandProposal({proposalId:Number(proposal.id),reviewedBy:"ci-commercial-review"});
  assert.equal(Number(duplicateReview.id),Number(review.id),"Aprovação repetida deve ser idempotente");

  await expectFailure(
    () => pool.query(`UPDATE demand_proposals SET final_total_brl=final_total_brl+1 WHERE id=$1`,[proposal.id]),
    /Approved commercial proposal is immutable/,
  );
  const itemId = Number((await pool.query(`SELECT id FROM demand_proposal_items WHERE proposal_id=$1 LIMIT 1`,[proposal.id])).rows[0].id);
  await expectFailure(
    () => pool.query(`DELETE FROM demand_proposal_items WHERE id=$1`,[itemId]),
    /Approved commercial proposal items are immutable/,
  );

  const outbox = await createDemandProposalOutbox({proposalId:Number(proposal.id),actor:"ci-commercial-review"});
  assert.equal(outbox.status,"ready");
  assert.match(String(outbox.idempotency_key),/^ecotracker-proposal\/[0-9a-f-]{36}$/);
  assert.match(String(outbox.subject),/EcoTracker/);
  assert.match(String(outbox.text_body),/aposentadoria exclusiva/);
  const duplicateOutbox = await createDemandProposalOutbox({proposalId:Number(proposal.id)});
  assert.equal(Number(duplicateOutbox.id),Number(outbox.id));

  await expectFailure(
    () => dispatchDemandOutbox(Number(outbox.id)),
    /Commercial outreach está desligado/,
  );

  let senderCalls = 0;
  let observedIdempotencyKey = null;
  const fakeSender = async (input) => {
    senderCalls += 1;
    observedIdempotencyKey = input.idempotencyKey;
    assert.equal(input.to,outbox.recipient_email);
    assert.match(input.subject,/EcoTracker/);
    return {providerReference:`fake-resend-${tag}`};
  };
  const sent = await dispatchDemandOutbox(Number(outbox.id),{
    sender:fakeSender,testBypassGate:true,actor:"ci-commercial-dispatch",
  });
  assert.equal(sent.alreadySent,false);
  assert.equal(sent.outbox.status,"sent");
  assert.equal(sent.outbox.provider_reference,`fake-resend-${tag}`);
  assert.equal(observedIdempotencyKey,outbox.idempotency_key);
  assert.equal(senderCalls,1);

  const sentAgain = await dispatchDemandOutbox(Number(outbox.id),{
    sender:fakeSender,testBypassGate:true,actor:"ci-commercial-dispatch",
  });
  assert.equal(sentAgain.alreadySent,true);
  assert.equal(senderCalls,1,"Segundo dispatch não pode chamar provider novamente");
  const sentProposal = (await pool.query(`SELECT status FROM demand_proposals WHERE id=$1`,[proposal.id])).rows[0];
  assert.equal(sentProposal.status,"sent");

  const partialCase = await seedOpportunity({suffix:"2",name:"Empresa Comercial Parcial S.A.",targetTonnes:8000});
  const partial = await createDemandProposal({opportunityId:Number(partialCase.opportunity.id),validityMinutes:1440,notes:"Partial commercial E2E"});
  assert.equal(partial.status,"partial");
  assert.ok(Number(partial.uncovered_tonnes)>0);
  await expectFailure(
    () => approveDemandProposal({proposalId:Number(partial.id),reviewedBy:"ci-commercial-review"}),
    /Apenas propostas draft|cobertura integral/,
  );
  const rejected = await rejectDemandProposal({proposalId:Number(partial.id),reviewedBy:"ci-commercial-review",reason:"Cobertura insuficiente para proposta comercial"});
  assert.equal(rejected.status,"rejected");
  await expectFailure(
    () => createDemandProposalOutbox({proposalId:Number(partial.id)}),
    /aprovação comercial/,
  );

  const finalStatus = await commercialOutreachStatus();
  assert.equal(finalStatus.live,false);
  assert.equal(Number(finalStatus.counts.approved),1);
  assert.equal(Number(finalStatus.counts.sent),1);

  const events = (await pool.query(`SELECT event_type FROM demand_outreach_events WHERE proposal_id=$1 ORDER BY id`,[proposal.id])).rows.map((row) => row.event_type);
  assert.deepEqual(events,["proposal_approved","outbox_created","outbox_sent"]);

  console.log("Commercial Outreach smoke OK",{
    proposalId:Number(proposal.id),
    snapshotSha256:review.snapshot_sha256,
    approvedProposalImmutable:true,
    approvedItemsImmutable:true,
    outboxStatus:sent.outbox.status,
    providerCalls:senderCalls,
    providerReference:sent.outbox.provider_reference,
    idempotencyKey:outbox.idempotency_key,
    partialProposalRejected:true,
    liveOutreach:false,
  });
}

try { await run(); }
finally { await pool.end(); }
