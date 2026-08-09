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
import { runDemandAutopilot, updateDemandAutopilotSettings } from "../dist/demand-autopilot.js";
import { marketMakerSummary } from "../dist/demand-supply-rfq.js";

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

async function seedClaimReadyAsset({suffix,tonnes,price=10,score=99}) {
  return (await pool.query(`
    INSERT INTO monitored_assets (
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,
      source_price_usd_ton,fx_brl_usd,available_tons,min_order_kg,pricing_mode,availability_status,source_status,
      active,claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,
      commercial_valid_until,offer_expires_at,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      ccp_status,eligibility_checked_at,sourcing_score,sourcing_tier,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES (
      'Market Maker Test Registry',$1,$2,$3,'Market Maker E2E','Brasil','2026','carbon','premium',
      $4,5.0,$5,1,'dynamic','confirmed','connected',
      TRUE,'voluntary_offset','eligible','Market Maker smoke claim-ready asset','tradable',CURRENT_DATE-INTERVAL '1 year',CURRENT_DATE,
      CURRENT_DATE+INTERVAL '30 days',NOW()+INTERVAL '30 days',$6,$7,$8,
      TRUE,TRUE,1,TRUE,'approved',NOW(),$9,'A','verified_compensation',TRUE,NOW()
    ) RETURNING *`,[
    `Market Maker Claim-ready ${suffix}`,
    `market-maker-${suffix}-${tag}`,
    `https://example.com/market-maker/${suffix}/${tag}`,
    price,
    tonnes,
    `MM-PROJECT-${suffix}-${tag}`,
    `MM-BATCH-${suffix}-${tag}`,
    `https://example.com/market-maker/registry/${suffix}/${tag}`,
    score,
  ])).rows[0];
}

async function seedBuyer() {
  const account = (await pool.query(`
    INSERT INTO demand_accounts(
      source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
      contact_status,status,lead_score,metadata,last_checked_at
    ) VALUES('market_maker_e2e',$1,'Empresa Market Maker 30K S.A.','Empresa Market Maker 30K S.A.',
      '30.000.000/0001-00','Industrial','Brasil','Diretoria ESG',$2,'not_contacted','qualified',98,$3::jsonb,NOW())
    RETURNING *`,[
    `buyer-${tag}`,
    `buyer-market-maker-${tag}@example.com`,
    JSON.stringify({e2e:true,marketMaker:true}),
  ])).rows[0];

  const inventory = (await pool.query(`
    INSERT INTO demand_inventories(
      account_id,inventory_year,scope1_tonnes,scope2_market_tonnes,scope2_location_tonnes,scope3_tonnes,
      reported_total_tonnes,verification_level,verification_provider,source_url,metadata
    ) VALUES($1,2026,20000,10000,10000,5000,35000,'verified','Market Maker E2E Verifier',$2,$3::jsonb)
    RETURNING *`,[
    account.id,
    `https://example.com/market-maker/buyer-inventory/${tag}`,
    JSON.stringify({e2e:true}),
  ])).rows[0];
  return {account,inventory};
}

async function seedSellerConfirmedLead() {
  return (await pool.query(`
    INSERT INTO supply_leads(
      registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
      methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,
      confirmed_free_tonnes,evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at
    ) VALUES(
      'Verra VCS',$1,'Projeto Brasileiro Seller Confirmed','Brasil','Mato Grosso','Fornecedor Carbono Brasil Ltda',
      'Originação Carbono',$2,'VM0047','2026',50000,25000,0,25000,20000,$3,$4,'market_maker_e2e',
      'seller_confirmed','qualified','qualified','Saldo comercial confirmado, ainda sem mandato e sem promoção automática a claim-ready.',$5::jsonb,NOW()
    ) RETURNING *`,[
    `VCS-MM-${tag}`,
    `supplier-market-maker-${tag}@example.com`,
    `https://example.com/market-maker/seller-evidence/${tag}`,
    `https://example.com/market-maker/seller-source/${tag}`,
    JSON.stringify({e2e:true,commerciallyConfirmed:true,claimReady:false}),
  ])).rows[0];
}

async function run() {
  await init();
  await seedClaimReadyAsset({suffix:"initial-12k",tonnes:12000,price:9,score:99});
  const buyer = await seedBuyer();
  const sellerLead = await seedSellerConfirmedLead();

  await updateDemandAutopilotSettings({
    enabled:false,minLeadScore:50,minOperationalTonnes:100,targetPercent:100,maxAccountsPerRun:100,intervalMinutes:360,
  });

  const first = await runDemandAutopilot({triggerMode:"manual",force:true});
  assert.equal(first.skipped,false);
  assert.equal(first.summary.accountsQualified,1);
  assert.equal(first.summary.fullyCovered,0);
  assert.equal(first.summary.sourcingRequired,1);
  assert.equal(first.summary.proposalsCreated,0,"Gap não pode virar proposta antes de cobertura claim-ready integral");

  const item1 = first.items.find((item) => Number(item.accountId)===Number(buyer.account.id));
  assert.ok(item1);
  assert.equal(Number(item1.targetTonnes),30000);
  assert.equal(Number(item1.coveredTonnes),12000);
  assert.equal(Number(item1.uncoveredTonnes),18000);
  assert.equal(item1.fullyCovered,false);
  assert.equal(item1.proposalId,null);
  assert.ok(Number(item1.rfqId)>0);
  assert.equal(item1.nextAction,"source_more_credits");

  const rfq1 = (await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[item1.rfqId])).rows[0];
  assert.equal(Number(rfq1.target_tonnes),30000);
  assert.equal(Number(rfq1.covered_tonnes),12000);
  assert.equal(Number(rfq1.gap_tonnes),18000);
  assert.equal(rfq1.status,"partially_sourced","Supply Desk candidato deve tornar RFQ parcialmente sourced, não resolvido");

  const candidates1 = (await pool.query(`
    SELECT * FROM market_maker_rfq_candidates WHERE rfq_id=$1 AND status<>'stale' ORDER BY sourcing_score DESC`,[rfq1.id])).rows;
  assert.equal(candidates1.length,1);
  const candidate = candidates1[0];
  assert.equal(candidate.candidate_type,"seller_confirmed");
  assert.equal(Number(candidate.supply_lead_id),Number(sellerLead.id));
  assert.equal(Number(candidate.candidate_tonnes),20000);
  assert.equal(candidate.confidence,"seller_confirmed");
  assert.equal(candidate.auto_close_eligible,false,"Seller-confirmed inventory cannot auto-close carbon demand");
  assert.equal(candidate.rationale.claimReady,false);
  assert.equal(candidate.rationale.mandateRequired,true);

  const opportunity1 = (await pool.query(`SELECT status FROM demand_opportunities WHERE id=$1`,[item1.opportunityId])).rows[0];
  assert.equal(opportunity1.status,"sourcing_required");
  const proposalCount1 = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM demand_proposals`)).rows[0].count);
  assert.equal(proposalCount1,0);

  const secondBeforeSupply = await runDemandAutopilot({triggerMode:"manual",force:true});
  const item2 = secondBeforeSupply.items.find((item) => Number(item.accountId)===Number(buyer.account.id));
  assert.equal(Number(item2.rfqId),Number(item1.rfqId),"Repeated gap must reuse the same RFQ");
  assert.equal(secondBeforeSupply.summary.proposalsCreated,0);
  const rfqCount = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM market_maker_rfqs`)).rows[0].count);
  assert.equal(rfqCount,1);
  const candidateCount = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM market_maker_rfq_candidates WHERE rfq_id=$1`,[rfq1.id])).rows[0].count);
  assert.equal(candidateCount,1,"Repeated RFQ refresh cannot duplicate supply candidate");

  await seedClaimReadyAsset({suffix:"new-18k",tonnes:18000,price:10,score:98});

  const third = await runDemandAutopilot({triggerMode:"manual",force:true});
  const item3 = third.items.find((item) => Number(item.accountId)===Number(buyer.account.id));
  assert.ok(item3);
  assert.equal(item3.fullyCovered,true,"Only claim-ready monitored inventory should close the gap");
  assert.equal(Number(item3.coveredTonnes),30000);
  assert.equal(Number(item3.uncoveredTonnes),0);
  assert.ok(Number(item3.proposalId)>0,"Resolved claim-ready coverage must create proposal draft");
  assert.equal(item3.nextAction,"commercial_review");
  assert.equal(item3.rfqStatus,"resolved_or_not_needed");

  const rfqFinal = (await pool.query(`SELECT * FROM market_maker_rfqs WHERE id=$1`,[rfq1.id])).rows[0];
  assert.equal(rfqFinal.status,"resolved");
  assert.equal(Number(rfqFinal.gap_tonnes),0);
  assert.equal(Number(rfqFinal.covered_tonnes),30000);
  assert.ok(rfqFinal.resolved_at);

  const opportunityFinal = (await pool.query(`SELECT status FROM demand_opportunities WHERE id=$1`,[item3.opportunityId])).rows[0];
  assert.equal(opportunityFinal.status,"proposal_ready");
  const proposalFinal = (await pool.query(`SELECT * FROM demand_proposals WHERE id=$1`,[item3.proposalId])).rows[0];
  assert.equal(proposalFinal.status,"draft");
  assert.equal(Number(proposalFinal.coverage_pct),100);
  assert.equal(Number(proposalFinal.uncovered_tonnes),0);

  const summary = await marketMakerSummary();
  assert.equal(Number(summary.rfqs.open_rfqs),0);
  assert.equal(Number(summary.rfqs.open_gap_tonnes),0);
  assert.equal(Number(summary.rfqs.resolved_rfqs),1);

  console.log("Market Maker RFQ smoke OK",{
    buyer:"Empresa Market Maker 30K S.A.",
    targetTonnes:30000,
    initialClaimReadyTonnes:12000,
    initialGapTonnes:18000,
    sellerConfirmedCandidateTonnes:20000,
    sellerCandidateAutoCloseEligible:false,
    repeatedRfqId:Number(item1.rfqId),
    finalClaimReadyCoverageTonnes:30000,
    rfqStatus:rfqFinal.status,
    proposalId:Number(item3.proposalId),
    nextAction:item3.nextAction,
  });
}

try { await run(); }
finally { await pool.end(); }
