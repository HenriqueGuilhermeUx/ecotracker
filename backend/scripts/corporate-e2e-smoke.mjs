import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initAssistedSourcingDb } from "../dist/assisted-sourcing-db.js";
import { initSupplyDeskDb } from "../dist/supply-desk-db.js";
import { initDemandDeskDb } from "../dist/demand-desk-db.js";
import { initDemandProposalDb } from "../dist/demand-proposal-db.js";
import { initCorporateBasketDb } from "../dist/corporate-basket-db.js";
import { initCorporateBasketPaymentDb, corporateBasketPaymentStatus } from "../dist/corporate-basket-payment-db.js";
import { initCorporateBasketFulfillmentDb } from "../dist/corporate-basket-fulfillment-db.js";
import { generateDemandMatches } from "../dist/demand-matching.js";
import { createDemandProposal } from "../dist/demand-proposal.js";
import { createCorporateBasket, confirmCorporateBasketLeg } from "../dist/corporate-basket-service.js";
import { reserveCorporateBasket } from "../dist/corporate-basket-reservations.js";
import { reconcileCorporateBasketPaymentApproved } from "../dist/corporate-basket-payment-reconciliation.js";
import {
  startCorporateBasketFulfillment,
  recordCorporateBasketAcquisition,
  recordCorporateBasketRetirement,
  flagCorporateBasketFulfillmentLegReview,
  finalizeCorporateBasketFulfillment,
  recordCorporateBasketDocument,
  getCorporateBasketEvidence,
} from "../dist/corporate-basket-fulfillment.js";
import {
  resolveCorporateBasketFulfillmentLegReview,
  markCorporateBasketEcotDelivered,
} from "../dist/corporate-basket-fulfillment-extra.js";

const TARGET_TONNES = 10_000;
const TARGET_KG = TARGET_TONNES * 1000;
const nowTag = Date.now();

async function init() {
  await initDb();
  await initMarketDb();
  await initEligibilityDb();
  await initCommerceDb();
  await initAssistedSourcingDb();
  await initSupplyDeskDb();
  await initDemandDeskDb();
  await initDemandProposalDb();
  await initCorporateBasketDb();
  await initCorporateBasketPaymentDb();
  await initCorporateBasketFulfillmentDb();
}

async function seedEligibleAsset({ suffix, registry, projectName, priceUsd, availableTonnes, score }) {
  const { rows } = await pool.query(`
    INSERT INTO monitored_assets (
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
      source_price_usd_ton,fx_brl_usd,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,availability_status,source_status,
      monitor_details,last_checked_at,active,claim_category,eligibility_status,eligibility_basis,source_unit_status,
      vintage_start,vintage_end,commercial_valid_until,offer_expires_at,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      ccp_status,eligibility_checked_at,eligibility_risk_flags,sourcing_score,sourcing_tier,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES (
      $1,$2,$3,$4,'E2E methodology','Brasil','2026','carbon','premium','Ativo sintético exclusivo do CI E2E.',
      $5,5.00,0,$6,1,'dynamic','confirmed','connected',
      $7::jsonb,NOW(),TRUE,'voluntary_offset','eligible','E2E claim-ready asset','tradable',
      CURRENT_DATE-INTERVAL '1 year',CURRENT_DATE,CURRENT_DATE+INTERVAL '30 days',NOW()+INTERVAL '30 days',$8,$9,$10,
      TRUE,TRUE,1,TRUE,'approved',NOW(),'[]'::jsonb,$11,'A','verified_compensation',TRUE,NOW()
    ) RETURNING *`, [
      registry,
      projectName,
      `e2e-${nowTag}-${suffix}`,
      `https://example.com/e2e/source/${nowTag}/${suffix}`,
      priceUsd,
      availableTonnes,
      JSON.stringify({ providerKey:`e2e-${suffix}`,country:"Brasil",testOnly:true }),
      `E2E-PROJECT-${suffix}-${nowTag}`,
      `E2E-BATCH-${suffix}-${nowTag}`,
      `https://example.com/e2e/registry/${nowTag}/${suffix}`,
      score,
    ]);
  return rows[0];
}

async function seedDemand() {
  const account = (await pool.query(`
    INSERT INTO demand_accounts (
      source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,
      contact_status,status,lead_score,metadata,last_checked_at
    ) VALUES (
      'e2e_ci',$1,'Empresa E2E Carbono S.A.','Empresa E2E Carbono S.A.','00.000.000/0001-00','Industrial','Brasil',
      'Comprador E2E','comprador-e2e@example.com','qualified','qualified',100,$2::jsonb,NOW()
    ) RETURNING *`, [`company-${nowTag}`,JSON.stringify({ e2e:true })])).rows[0];

  const inventory = (await pool.query(`
    INSERT INTO demand_inventories (
      account_id,inventory_year,scope1_tonnes,scope2_location_tonnes,scope2_market_tonnes,scope3_tonnes,
      reported_total_tonnes,verification_level,verification_provider,source_url,metadata
    ) VALUES ($1,2026,6000,4000,4000,2500,12500,'verified','E2E Verifier',$2,$3::jsonb)
    RETURNING *`, [account.id,`https://example.com/e2e/inventory/${nowTag}`,JSON.stringify({ e2e:true })])).rows[0];

  const opportunity = (await pool.query(`
    INSERT INTO demand_opportunities (
      account_id,inventory_id,status,target_tonnes,target_basis,claim_purpose,target_year,max_price_usd_tonne,
      preferred_country,priority_score,constraints,notes
    ) VALUES ($1,$2,'identified',$3,'scope1_2','voluntary_offset',2026,50,'Brasil',100,$4::jsonb,'E2E corporate operation')
    RETURNING *`, [account.id,inventory.id,TARGET_TONNES,JSON.stringify({ e2e:true })])).rows[0];

  return { account, inventory, opportunity };
}

async function run() {
  await init();

  const paymentFeature = await corporateBasketPaymentStatus();
  assert.equal(paymentFeature.live,false,"Basket Payment precisa permanecer desligado no E2E");
  assert.equal(paymentFeature.database?.payment_enabled,false,"Feature gate de pagamento no banco precisa permanecer desligado");

  const assetA = await seedEligibleAsset({
    suffix:"a",registry:"E2E Registry A",projectName:"E2E Brazilian Forest A",priceUsd:8,availableTonnes:6000,score:99,
  });
  const assetB = await seedEligibleAsset({
    suffix:"b",registry:"E2E Registry B",projectName:"E2E Brazilian Forest B",priceUsd:9,availableTonnes:6000,score:98,
  });
  assert.ok(assetA.id && assetB.id);

  const { opportunity } = await seedDemand();

  const matching = await generateDemandMatches(Number(opportunity.id));
  assert.equal(matching.fullyCovered,true,"Matching precisa cobrir 100% da oportunidade");
  assert.equal(Number(matching.coveredTonnes),TARGET_TONNES);
  assert.equal(matching.readyMatches.length,2,"O E2E precisa forçar basket com dois lotes");
  assert.equal(Math.round(matching.readyMatches.reduce((sum,item) => sum+Number(item.matchedTonnes || 0),0)*1000),TARGET_KG);

  const proposal = await createDemandProposal({ opportunityId:Number(opportunity.id),validityMinutes:60,notes:"E2E no-money" });
  assert.equal(proposal.checkout_mode,"basket_quote_required","Proposta multi-lote precisa seguir para basket");
  assert.equal(Number(proposal.uncovered_tonnes),0);

  const basket = await createCorporateBasket(Number(proposal.id),"E2E no-money basket");
  assert.equal(basket.legs.length,2);
  assert.equal(Number(basket.covered_kg),TARGET_KG);

  for (const [index,leg] of basket.legs.entries()) {
    const requestedKg = Number(leg.requestedKg);
    await confirmCorporateBasketLeg({
      basketId:Number(basket.id),
      legId:Number(leg.id),
      sourceCostBrl:Number(((requestedKg/1000)*(index===0 ? 40 : 45)).toFixed(2)),
      sourceReference:`E2E-SOURCE-CONFIRM-${index+1}-${nowTag}`,
      sourceAvailableKg:requestedKg+1_000_000,
      sourceEvidenceUrl:`https://example.com/e2e/source-confirm/${nowTag}/${index+1}`,
      quoteTtlMinutes:30,
      confirmedBy:"ci-e2e",
    });
  }

  const reserved = await reserveCorporateBasket({ basketId:Number(basket.id),reservationMinutes:15 });
  assert.equal(reserved.status,"reserved");
  assert.equal(reserved.reservations.length,2);
  assert.equal(reserved.reservations.reduce((sum,item) => sum+Number(item.reservedKg),0),TARGET_KG);

  const currentBasket = (await pool.query(`SELECT * FROM corporate_baskets WHERE id=$1`,[basket.id])).rows[0];
  assert.ok(Number(currentBasket.final_total_brl)>0,"Basket cotado precisa ter valor final");

  await pool.query(`
    INSERT INTO corporate_basket_payment_attempts (
      basket_id,provider,method,external_reference,provider_reference,status,amount_brl,expires_at,raw_payload
    ) VALUES ($1,'e2e-test','pix',$2,$3,'pending',$4,NOW()+INTERVAL '10 minutes',$5::jsonb)`, [
    basket.id,
    `basket:${basket.public_code}`,
    `e2e-payment-${nowTag}`,
    Number(currentBasket.final_total_brl),
    JSON.stringify({ e2e:true,noRealMoney:true }),
  ]);

  const paid = await reconcileCorporateBasketPaymentApproved({
    basketCode:String(basket.public_code),
    provider:"e2e-test",
    providerReference:`e2e-payment-${nowTag}`,
    paidAmountBrl:Number(currentBasket.final_total_brl),
    providerFeeBrl:0,
    raw:{ e2e:true,noRealMoney:true },
    eventKey:`e2e-payment-approved-${nowTag}`,
  });
  assert.equal(paid.reviewRequired,false);
  assert.equal(paid.status,"paid_awaiting_fulfillment");
  assert.equal(paid.reservationsCommitted,true);

  const duplicatePayment = await reconcileCorporateBasketPaymentApproved({
    basketCode:String(basket.public_code),
    provider:"e2e-test",
    providerReference:`e2e-payment-${nowTag}`,
    paidAmountBrl:Number(currentBasket.final_total_brl),
    providerFeeBrl:0,
    raw:{ e2e:true,duplicate:true },
    eventKey:`e2e-payment-approved-duplicate-${nowTag}`,
  });
  assert.equal(duplicatePayment.alreadyPaid,true,"Webhook duplicado precisa ser idempotente");

  let fulfillment = await startCorporateBasketFulfillment(Number(basket.id));
  assert.equal(fulfillment.legs.length,2);
  assert.equal(fulfillment.basket_status,"fulfillment_in_progress");

  for (let index=0;index<fulfillment.legs.length;index+=1) {
    const leg = fulfillment.legs[index];
    const requestedKg = Number(leg.requestedKg);
    fulfillment = await recordCorporateBasketAcquisition({
      basketId:Number(basket.id),
      fulfillmentLegId:Number(leg.id),
      sourceReference:`E2E-ACQUISITION-${index+1}-${nowTag}`,
      sourceTxHash:`0xe2eacquisition${index+1}${nowTag}`,
      sourceEvidenceUrl:`https://example.com/e2e/acquisition/${nowTag}/${index+1}`,
      acquiredKg:requestedKg,
    });

    if (index===0) {
      fulfillment = await flagCorporateBasketFulfillmentLegReview({
        basketId:Number(basket.id),fulfillmentLegId:Number(leg.id),reason:"E2E: validar recuperação de revisão antes do retirement",
      });
      assert.equal(fulfillment.status,"review_required");
      fulfillment = await resolveCorporateBasketFulfillmentLegReview({
        basketId:Number(basket.id),fulfillmentLegId:Number(leg.id),
      });
      const restored = fulfillment.legs.find((item) => Number(item.id)===Number(leg.id));
      assert.equal(restored.status,"acquired","Resolve review precisa restaurar leg já adquirida");
    }

    fulfillment = await recordCorporateBasketRetirement({
      basketId:Number(basket.id),
      fulfillmentLegId:Number(leg.id),
      retirementReference:`E2E-RETIREMENT-${index+1}-${nowTag}`,
      retirementTxHash:`0xe2eretirement${index+1}${nowTag}`,
      retirementEvidenceUrl:`https://example.com/e2e/retirement/${nowTag}/${index+1}`,
      certificateUrl:`https://example.com/e2e/certificate/${nowTag}/${index+1}`,
      retiredKg:requestedKg,
      beneficiaryName:"Empresa E2E Carbono S.A.",
      beneficiaryTaxId:"00.000.000/0001-00",
      evidence:{ e2e:true,registryAssertion:"retired exclusively for beneficiary" },
    });
  }

  assert.equal(Number(fulfillment.total_retired_kg),TARGET_KG);
  assert.equal(fulfillment.legs.every((leg) => leg.status==="retired"),true);

  const finalized = await finalizeCorporateBasketFulfillment(Number(basket.id));
  assert.equal(finalized.status,"completed");
  assert.equal(finalized.ecotAllocatedKg,TARGET_KG);
  assert.match(finalized.bundleSha256,/^[a-f0-9]{64}$/);
  assert.equal(finalized.bundle.legs.length,2);
  assert.equal(finalized.bundle.legs.reduce((sum,leg) => sum+Number(leg.retiredKg),0),TARGET_KG);

  const delivered = await markCorporateBasketEcotDelivered(Number(basket.id));
  assert.equal(delivered.status,"delivered");
  assert.equal(delivered.amountKg,TARGET_KG);

  await recordCorporateBasketDocument({
    basketId:Number(basket.id),documentType:"receipt",provider:"e2e",providerReference:`receipt-${nowTag}`,
    documentUrl:`https://example.com/e2e/receipt/${nowTag}`,data:{ e2e:true },
  });
  await recordCorporateBasketDocument({
    basketId:Number(basket.id),documentType:"nfse",provider:"e2e",providerReference:`nfse-${nowTag}`,
    documentUrl:`https://example.com/e2e/nfse/${nowTag}`,data:{ e2e:true },
  });

  const evidence = await getCorporateBasketEvidence(String(basket.public_code));
  assert.ok(evidence);
  assert.equal(evidence.totalKg,TARGET_KG);
  assert.equal(evidence.totalRetiredKg,TARGET_KG);
  assert.equal(evidence.ecotAllocation.status,"delivered");
  assert.equal(evidence.ecotAllocation.amountKg,TARGET_KG);
  assert.equal(evidence.documents.length,2);
  assert.match(evidence.bundleSha256,/^[a-f0-9]{64}$/);

  const reservationSummary = (await pool.query(`
    SELECT status,COUNT(*)::int AS count,COALESCE(SUM(reserved_kg),0)::bigint AS kg
    FROM corporate_basket_reservations WHERE basket_id=$1 GROUP BY status`,[basket.id])).rows;
  const consumed = reservationSummary.find((row) => row.status==="consumed");
  assert.equal(Number(consumed?.count || 0),2);
  assert.equal(Number(consumed?.kg || 0),TARGET_KG);

  const finalBasket = (await pool.query(`SELECT status,payment_status FROM corporate_baskets WHERE id=$1`,[basket.id])).rows[0];
  assert.equal(finalBasket.status,"completed");
  assert.equal(finalBasket.payment_status,"paid");

  const finalPaymentFeature = await corporateBasketPaymentStatus();
  assert.equal(finalPaymentFeature.live,false,"E2E não pode habilitar pagamento real");

  console.log("Corporate E2E smoke OK", {
    company:"Empresa E2E Carbono S.A.",
    targetTonnes:TARGET_TONNES,
    matchedLots:matching.readyMatches.length,
    proposalMode:proposal.checkout_mode,
    basketId:Number(basket.id),
    paymentProvider:"e2e-test/no-real-money",
    retiredKg:evidence.totalRetiredKg,
    ecotDeliveredKg:evidence.ecotAllocation.amountKg,
    documents:evidence.documents.length,
    bundleSha256:evidence.bundleSha256,
    paymentRailLive:finalPaymentFeature.live,
  });
}

try {
  await run();
} finally {
  await pool.end();
}
