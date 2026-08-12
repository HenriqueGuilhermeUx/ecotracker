import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb, assetProjection } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initCarbonmarkRailDb } from "../dist/carbonmark-rail-db.js";
import { carbonmarkRailControl, createCarbonmarkShadowQuote } from "../dist/carbonmark-rail.js";

const tag=Date.now();

async function init(){await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initCarbonmarkRailDb();}

async function seedAsset({restricted=false,description="Shadow quote smoke asset"}={}){
  const suffix=restricted?"restricted":"eligible";
  const {rows}=await pool.query(`
    INSERT INTO monitored_assets(
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
      source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,
      availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,eligibility_basis,
      source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      eligibility_checked_at,eligibility_risk_flags,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES(
      'Verra VCS',$1,$2,$3,'VM0047','Brasil','2026','carbon','verified-offset',$4,
      8.50,5.50,25,0,100,1000,'dynamic','confirmed','connected',$5::jsonb,NOW(),TRUE,$6,$7,$8,
      'tradable','2026-01-01','2026-12-31','2026-12-31',$9,$10,$3,
      TRUE,FALSE,1000,TRUE,NOW(),$11::jsonb,$12,FALSE,NOW()
    ) RETURNING *`,[
    `Carbonmark Shadow Smoke ${suffix} ${tag}`,`carbonmark-shadow-${suffix}-${tag}`,`https://example.com/carbonmark/${suffix}/${tag}`,description,
    JSON.stringify({providerKey:"carbonmark",environment:"sandbox",assetPriceSourceId:`source-${suffix}-${tag}`,fractionalRetirement:false}),
    restricted?"climate_contribution":"voluntary_offset",restricted?"restricted":"eligible",
    restricted?"Listing monitorado para preço, ainda sem aprovação de compensação.":"Registry, vintage, tradability e retirement verificados no smoke.",
    `VCS-SHADOW-${suffix}-${tag}`,`source-${suffix}-${tag}`,JSON.stringify(restricted?["manual-eligibility-review-required"]:[]),
    restricted?"restricted":"verified_compensation",
  ]);
  return rows[0];
}

async function run(){
  await init();
  process.env.CARBONMARK_API_KEY="cm_api_fake_shadow_smoke";
  process.env.CARBONMARK_ENVIRONMENT="sandbox";
  process.env.CARBONMARK_API_BASE="https://v18.api.carbonmark.com";
  process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="false";
  process.env.CARBONMARK_ORDER_EXECUTION_ACK="DISABLED";

  const asset=await seedAsset();
  const restricted=await seedAsset({restricted:true,description:"Award winning EVAS project prevents deforestation and increases environmental conservation."});
  const beforeQuotes=Number((await pool.query(`SELECT COUNT(*)::int AS count FROM quote_requests`)).rows[0].count);
  let providerCalls=0;
  const fakeProvider=async(assetPriceSourceId,quantityTonnes)=>{
    providerCalls+=1;
    assert.equal(quantityTonnes,1);
    const restrictedCall=assetPriceSourceId===`source-restricted-${tag}`;
    assert.ok(restrictedCall||assetPriceSourceId===`source-eligible-${tag}`);
    return {
      uuid:restrictedCall?`shadow-quote-restricted-${tag}`:`shadow-quote-${tag}`,
      assetPriceSourceId,quantityTonnes,costUsdc:restrictedCall?7.75:9.25,
      raw:{uuid:restrictedCall?`shadow-quote-restricted-${tag}`:`shadow-quote-${tag}`,cost_usdc:restrictedCall?7.75:9.25,smoke:true},
    };
  };

  const result=await createCarbonmarkShadowQuote({assetId:Number(asset.id),requestedKg:1000,createdBy:"Carbonmark Shadow Smoke"},fakeProvider);
  assert.equal(result.idempotent,false);
  assert.equal(result.orderCreated,false);
  assert.equal(result.retirementCreated,false);
  assert.equal(result.execution.live,false);
  assert.equal(result.api_version,"v18");
  assert.equal(result.quote_uuid,`shadow-quote-${tag}`);
  assert.equal(Number(result.cost_usdc),9.25);
  assert.equal(Number(result.cost_usdc_tonne),9.25);
  assert.equal(String(result.probe_sha256).length,64);
  assert.equal(result.claimDecision.allowed,true);

  const restrictedResult=await createCarbonmarkShadowQuote({assetId:Number(restricted.id),requestedKg:1000,createdBy:"Carbonmark Restricted Probe Smoke"},fakeProvider);
  assert.equal(restrictedResult.claimDecision.allowed,false,"Restricted listing must remain non-claim-ready");
  assert.equal(restrictedResult.orderCreated,false);
  assert.equal(restrictedResult.retirementCreated,false);
  assert.equal(restrictedResult.quote_uuid,`shadow-quote-restricted-${tag}`);
  assert.equal(Number(restrictedResult.cost_usdc),7.75);

  const projected=(await pool.query(`SELECT ${assetProjection} FROM monitored_assets a WHERE a.id=$1`,[restricted.id])).rows[0];
  assert.match(String(projected.description),/Projeto EVAS premiado/i);
  assert.match(String(projected.description_original),/Award winning EVAS project/i);

  const afterQuotes=Number((await pool.query(`SELECT COUNT(*)::int AS count FROM quote_requests`)).rows[0].count);
  assert.equal(afterQuotes,beforeQuotes,"Shadow quote must not create customer quote_request");
  assert.equal(providerCalls,2);

  const duplicate=await createCarbonmarkShadowQuote({assetId:Number(asset.id),requestedKg:1000,createdBy:"Carbonmark Shadow Smoke"},fakeProvider);
  assert.equal(duplicate.idempotent,true);
  assert.equal(Number(duplicate.id),Number(result.id));
  assert.equal(providerCalls,3,"Provider may return same quote UUID; persistence must remain idempotent");

  let immutable=false;
  try{await pool.query(`UPDATE carbonmark_shadow_quotes SET cost_usdc=1 WHERE id=$1`,[result.id]);}
  catch(error){immutable=String(error?.message||error).includes("carbonmark_shadow_quote_is_immutable");}
  assert.equal(immutable,true);

  const control=await carbonmarkRailControl();
  assert.equal(control.execution.live,false);
  assert.equal(control.contract.stableApiVersion,"v18");
  assert.equal(control.contract.sellerListingCreationAutomated,false);
  assert.equal(control.contract.shadowQuoteRequiresClaimReady,false);
  assert.equal(control.contract.orderRequiresClaimReady,true);
  const restrictedControl=control.assets.find(item=>Number(item.id)===Number(restricted.id));
  assert.equal(restrictedControl?.claimReady,false);
  assert.ok(control.assets.some(item=>Number(item.id)===Number(asset.id)));
  assert.ok(control.shadowQuotes.some(item=>Number(item.id)===Number(result.id)));
  assert.ok(control.shadowQuotes.some(item=>Number(item.id)===Number(restrictedResult.id)));

  console.log("Carbonmark shadow quote smoke OK",{
    providerCalls,shadowQuotePersisted:true,restrictedMarketProbe:true,restrictedOrderStillBlocked:true,
    portugueseMarketplaceDescription:true,originalDescriptionPreserved:true,sha256:true,customerQuoteCreated:false,
    orderCreated:false,retirementCreated:false,orderExecutionLive:false,stableApiVersion:"v18",immutable:true,controlDesk:true,
  });
}

try{await run();}finally{await pool.end();}
