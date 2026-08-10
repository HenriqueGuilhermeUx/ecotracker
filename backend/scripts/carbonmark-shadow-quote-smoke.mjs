import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initCarbonmarkRailDb } from "../dist/carbonmark-rail-db.js";
import { carbonmarkRailControl, createCarbonmarkShadowQuote } from "../dist/carbonmark-rail.js";

const tag=Date.now();

async function init(){await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initCarbonmarkRailDb();}

async function seedAsset(){
  const {rows}=await pool.query(`
    INSERT INTO monitored_assets(
      registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
      source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,
      availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,eligibility_basis,
      source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,registry_batch_id,registry_evidence_url,
      retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,
      eligibility_checked_at,eligibility_risk_flags,sourcing_shelf,sourcing_executable,sourcing_checked_at
    ) VALUES(
      'Verra VCS',$1,$2,$3,'VM0047','Brasil','2026','carbon','verified-offset','Shadow quote smoke asset',
      8.50,5.50,25,0,100,1000,'dynamic','confirmed','connected',$4::jsonb,NOW(),TRUE,'voluntary_offset','eligible',
      'Registry, vintage, tradability e retirement verificados no smoke.','tradable','2026-01-01','2026-12-31','2026-12-31',$5,$6,$3,
      TRUE,FALSE,1000,TRUE,NOW(),'[]'::jsonb,'verified_compensation',FALSE,NOW()
    ) RETURNING *`,[
    `Carbonmark Shadow Smoke ${tag}`,`carbonmark-shadow-${tag}`,`https://example.com/carbonmark/${tag}`,
    JSON.stringify({providerKey:"carbonmark",environment:"sandbox",assetPriceSourceId:`source-${tag}`,fractionalRetirement:false}),
    `VCS-SHADOW-${tag}`,`source-${tag}`,
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
  const beforeQuotes=Number((await pool.query(`SELECT COUNT(*)::int AS count FROM quote_requests`)).rows[0].count);
  let providerCalls=0;
  const fakeProvider=async(assetPriceSourceId,quantityTonnes)=>{
    providerCalls+=1;
    assert.equal(assetPriceSourceId,`source-${tag}`);
    assert.equal(quantityTonnes,1);
    return {uuid:`shadow-quote-${tag}`,assetPriceSourceId,quantityTonnes,costUsdc:9.25,raw:{uuid:`shadow-quote-${tag}`,cost_usdc:9.25,smoke:true}};
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

  const afterQuotes=Number((await pool.query(`SELECT COUNT(*)::int AS count FROM quote_requests`)).rows[0].count);
  assert.equal(afterQuotes,beforeQuotes,"Shadow quote must not create customer quote_request");
  assert.equal(providerCalls,1);

  const duplicate=await createCarbonmarkShadowQuote({assetId:Number(asset.id),requestedKg:1000,createdBy:"Carbonmark Shadow Smoke"},fakeProvider);
  assert.equal(duplicate.idempotent,true);
  assert.equal(Number(duplicate.id),Number(result.id));
  assert.equal(providerCalls,2,"Provider may return same quote UUID; persistence must remain idempotent");

  let immutable=false;
  try{await pool.query(`UPDATE carbonmark_shadow_quotes SET cost_usdc=1 WHERE id=$1`,[result.id]);}
  catch(error){immutable=String(error?.message||error).includes("carbonmark_shadow_quote_is_immutable");}
  assert.equal(immutable,true);

  const control=await carbonmarkRailControl();
  assert.equal(control.execution.live,false);
  assert.equal(control.contract.stableApiVersion,"v18");
  assert.equal(control.contract.sellerListingCreationAutomated,false);
  assert.ok(control.assets.some(item=>Number(item.id)===Number(asset.id)));
  assert.ok(control.shadowQuotes.some(item=>Number(item.id)===Number(result.id)));

  console.log("Carbonmark shadow quote smoke OK",{
    providerCalls,shadowQuotePersisted:true,sha256:true,customerQuoteCreated:false,orderCreated:false,retirementCreated:false,
    orderExecutionLive:false,stableApiVersion:"v18",immutable:true,controlDesk:true,
  });
}

try{await run();}finally{await pool.end();}
