import assert from "node:assert/strict";
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
import { demandAutopilotStatus, runDemandAutopilot, updateDemandAutopilotSettings } from "../dist/demand-autopilot.js";

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
}

async function seedAsset() {
  const { rows } = await pool.query(`
    INSERT INTO monitored_assets (
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,
      source_price_usd_ton,fx_brl_usd,available_tons,min_order_kg,pricing_mode,availability_status,source_status,
      active,claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,
      commercial_valid_until,offer_expires_at,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      ccp_status,eligibility_checked_at,sourcing_score,sourcing_tier,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES (
      'Demand E2E Registry','Demand Autopilot Claim-ready Lot',$1,$2,'Demand E2E','Brasil','2026','carbon','premium',
      10,5.0,12000,1,'dynamic','confirmed','connected',
      TRUE,'voluntary_offset','eligible','Demand Autopilot test asset','tradable',CURRENT_DATE-INTERVAL '1 year',CURRENT_DATE,
      CURRENT_DATE+INTERVAL '30 days',NOW()+INTERVAL '30 days',$3,$4,$5,
      TRUE,TRUE,1,TRUE,'approved',NOW(),99,'A','verified_compensation',TRUE,NOW()
    ) RETURNING *`, [
    `demand-auto-e2e-${tag}`,
    `https://example.com/demand-auto/${tag}`,
    `DA-PROJECT-${tag}`,
    `DA-BATCH-${tag}`,
    `https://example.com/demand-auto/registry/${tag}`,
  ]);
  return rows[0];
}

async function seedCompany({suffix,name,scope1,scope2,leadScore}) {
  const account = (await pool.query(`
    INSERT INTO demand_accounts (
      source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
      contact_status,status,lead_score,metadata,last_checked_at
    ) VALUES ('demand_autopilot_e2e',$1,$2,$2,$3,'Industrial','Brasil',$4,$5,'not_contacted','scouted',$6,$7::jsonb,NOW())
    RETURNING *`, [
    `company-${suffix}-${tag}`,name,`00.000.00${suffix}/0001-00`, `Contato ${suffix}`,`buyer-${suffix}-${tag}@example.com`,leadScore,
    JSON.stringify({e2e:true}),
  ])).rows[0];
  const inventory = (await pool.query(`
    INSERT INTO demand_inventories (
      account_id,inventory_year,scope1_tonnes,scope2_market_tonnes,scope2_location_tonnes,scope3_tonnes,
      reported_total_tonnes,verification_level,verification_provider,source_url,metadata
    ) VALUES ($1,2026,$2,$3,$3,0,$4,'verified','Demand E2E Verifier',$5,$6::jsonb)
    RETURNING *`, [
    account.id,scope1,scope2,scope1+scope2,`https://example.com/demand-auto/inventory/${suffix}/${tag}`,JSON.stringify({e2e:true}),
  ])).rows[0];
  return {account,inventory};
}

async function run() {
  await init();
  await seedAsset();
  const coveredCompany = await seedCompany({suffix:"1",name:"Empresa Autopilot Coberta S.A.",scope1:3000,scope2:2000,leadScore:95});
  const gapCompany = await seedCompany({suffix:"2",name:"Empresa Autopilot Gap S.A.",scope1:20000,scope2:10000,leadScore:90});

  await updateDemandAutopilotSettings({
    enabled:false,minLeadScore:50,minOperationalTonnes:100,targetPercent:100,maxAccountsPerRun:100,intervalMinutes:360,
  });
  const before = await demandAutopilotStatus();
  assert.equal(before.live,false,"Worker recorrente deve permanecer desligado no teste");
  assert.equal(before.behavior.createsSupplyRfqsForCoverageGaps,true);

  const first = await runDemandAutopilot({triggerMode:"manual",force:true});
  assert.equal(first.skipped,false);
  assert.equal(first.summary.accountsQualified,2);
  assert.equal(first.summary.opportunitiesCreated,2);
  assert.equal(first.summary.proposalsCreated,1,"Somente a empresa 100% coberta deve ganhar proposta draft");
  assert.equal(first.summary.fullyCovered,1);
  assert.equal(first.summary.sourcingRequired,1);

  const coveredItem = first.items.find((item) => Number(item.accountId)===Number(coveredCompany.account.id));
  const gapItem = first.items.find((item) => Number(item.accountId)===Number(gapCompany.account.id));
  assert.ok(coveredItem);
  assert.ok(gapItem);
  assert.equal(coveredItem.fullyCovered,true);
  assert.equal(Number(coveredItem.targetTonnes),5000);
  assert.ok(Number(coveredItem.proposalId)>0);
  assert.equal(coveredItem.nextAction,"commercial_review");
  assert.equal(coveredItem.rfqStatus,"resolved_or_not_needed");
  assert.equal(gapItem.fullyCovered,false);
  assert.equal(Number(gapItem.targetTonnes),30000);
  assert.equal(Number(gapItem.uncoveredTonnes),18000);
  assert.equal(gapItem.proposalId,null);
  assert.ok(Number(gapItem.rfqId)>0,"Gap precisa materializar RFQ");
  assert.equal(gapItem.nextAction,"source_more_credits");

  const rfq = (await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[gapItem.rfqId])).rows[0];
  assert.ok(rfq);
  assert.equal(Number(rfq.target_tonnes),30000);
  assert.equal(Number(rfq.covered_tonnes),12000);
  assert.equal(Number(rfq.gap_tonnes),18000);
  assert.equal(rfq.status,"open","Sem Supply Desk candidato, RFQ deve ficar aberto");

  const gapOpportunity = (await pool.query(`SELECT * FROM demand_opportunities WHERE id=$1`,[gapItem.opportunityId])).rows[0];
  assert.equal(gapOpportunity.status,"sourcing_required");
  const coveredOpportunity = (await pool.query(`SELECT * FROM demand_opportunities WHERE id=$1`,[coveredItem.opportunityId])).rows[0];
  assert.equal(coveredOpportunity.status,"proposal_ready");

  const proposalCountBefore = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM demand_proposals`)).rows[0].count);
  const second = await runDemandAutopilot({triggerMode:"manual",force:true});
  const proposalCountAfter = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM demand_proposals`)).rows[0].count);
  assert.equal(second.summary.opportunitiesCreated,0,"Segundo run não pode duplicar oportunidades");
  assert.equal(second.summary.opportunitiesReused,2);
  assert.equal(second.summary.proposalsCreated,0,"Segundo run não pode duplicar proposta ainda válida");
  assert.equal(proposalCountAfter,proposalCountBefore);
  const secondGap = second.items.find((item) => Number(item.accountId)===Number(gapCompany.account.id));
  assert.equal(Number(secondGap.rfqId),Number(gapItem.rfqId),"Segundo run deve reutilizar o mesmo RFQ");

  const rfqCount = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM market_maker_rfqs`)).rows[0].count);
  assert.equal(rfqCount,1,"Autopilot não pode duplicar RFQs por oportunidade");

  const uniqueKeys = await pool.query(`
    SELECT COUNT(*)::int AS total,COUNT(DISTINCT autopilot_key)::int AS unique_keys
    FROM demand_opportunities WHERE autopilot_key IS NOT NULL`);
  assert.equal(Number(uniqueKeys.rows[0].total),2);
  assert.equal(Number(uniqueKeys.rows[0].unique_keys),2);

  const after = await demandAutopilotStatus();
  assert.equal(after.live,false);
  assert.equal(after.lastRun.status,"completed");

  console.log("Demand Autopilot smoke OK",{
    qualified:first.summary.accountsQualified,
    proposalReady:first.summary.fullyCovered,
    sourcingRequired:first.summary.sourcingRequired,
    coveredTargetTonnes:coveredItem.targetTonnes,
    gapTargetTonnes:gapItem.targetTonnes,
    gapUncoveredTonnes:gapItem.uncoveredTonnes,
    rfqId:gapItem.rfqId,
    secondRunReused:second.summary.opportunitiesReused,
    paymentOrOutreachSideEffects:false,
    recurringWorkerLive:after.live,
  });
}

try {
  await run();
} finally {
  await pool.end();
}
