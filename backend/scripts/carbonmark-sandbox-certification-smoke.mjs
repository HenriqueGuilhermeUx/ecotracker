import assert from "node:assert/strict";
import { initDb,pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initCarbonmarkSandboxCertificationDb } from "../dist/carbonmark-sandbox-certification-db.js";
import { carbonmarkSandboxCertificationControl,carbonmarkSandboxCertificationGate,runCarbonmarkSandboxCertification } from "../dist/carbonmark-sandbox-certification.js";
const tag=Date.now();
async function init(){await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initCarbonmarkSandboxCertificationDb();}
async function seed(){const {rows}=await pool.query(`INSERT INTO monitored_assets(registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,registry_batch_id,registry_evidence_url,retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,eligibility_checked_at,eligibility_risk_flags,sourcing_shelf,sourcing_executable,sourcing_checked_at) VALUES('Verra VCS',$1,$2,$3,'VM0047','Brasil','2026','carbon','verified-offset','Sandbox certification smoke',8.5,5.5,25,0,100,1000,'dynamic','confirmed','connected',$4::jsonb,NOW(),TRUE,'voluntary_offset','eligible','Registry/vintage/tradability verificados.','tradable','2026-01-01','2026-12-31','2026-12-31',$5,$6,$3,TRUE,FALSE,1000,TRUE,NOW(),'[]'::jsonb,'verified_compensation',FALSE,NOW()) RETURNING *`,[`Carbonmark Sandbox ${tag}`,`carbonmark-sandbox-${tag}`,`https://example.com/${tag}`,JSON.stringify({providerKey:"carbonmark",environment:"sandbox",assetPriceSourceId:`source-${tag}`}),`VCS-${tag}`,`source-${tag}`]);return rows[0];}
async function run(){
  await init();
  process.env.CARBONMARK_API_KEY="cm_test_fake";process.env.CARBONMARK_ENVIRONMENT="sandbox";process.env.CARBONMARK_SANDBOX_E2E_ENABLED="true";process.env.CARBONMARK_SANDBOX_E2E_ACK="ENABLE_SANDBOX_CARBONMARK_RETIREMENTS";process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="false";process.env.CARBONMARK_ORDER_EXECUTION_ACK="DISABLED";
  assert.equal(carbonmarkSandboxCertificationGate().ready,true);
  const asset=await seed();let quotes=0,orders=0;
  const quoteProvider=async(source,tonnes)=>{quotes++;assert.equal(source,`source-${tag}`);assert.equal(tonnes,1);return{uuid:`sandbox-q-${tag}`,assetPriceSourceId:source,quantityTonnes:tonnes,costUsdc:7.77,raw:{sandbox:true}};};
  const retirementProvider=async(input)=>{orders++;assert.equal(input.quoteUuid,`sandbox-q-${tag}`);return{status:"completed",reference:`retirement-${tag}`,txHash:`0x${"a".repeat(64)}`,viewRetirementUrl:`https://sandbox.example/retirement/${tag}`,certificateUrl:`https://sandbox.example/certificate/${tag}`,provenanceUrl:`https://sandbox.example/provenance/${tag}`,retirementId:`137-0x${"a".repeat(64)}-0`,raw:{status:"COMPLETED",sandbox:true}};};
  const result=await runCarbonmarkSandboxCertification({assetId:Number(asset.id),requestedKg:1000,beneficiaryName:"EcoTracker Sandbox",executedBy:"CI"},quoteProvider,retirementProvider);
  assert.equal(result.certified,true);assert.equal(result.status,"completed");assert.equal(String(result.certification_sha256).length,64);assert.equal(quotes,1);assert.equal(orders,1);assert.ok(result.certificate_url);assert.ok(result.provenance_url);
  let immutable=false;try{await pool.query(`UPDATE carbonmark_sandbox_certifications SET cost_usdc=1 WHERE id=$1`,[result.id]);}catch(e){immutable=String(e?.message||e).includes("completed_carbonmark_sandbox_certification_is_immutable");}assert.equal(immutable,true);
  const control=await carbonmarkSandboxCertificationControl();assert.equal(control.gate.ready,true);assert.ok(control.certifications.some(x=>Number(x.id)===Number(result.id)));
  process.env.CARBONMARK_ENVIRONMENT="production";assert.equal(carbonmarkSandboxCertificationGate().ready,false);await assert.rejects(()=>runCarbonmarkSandboxCertification({assetId:Number(asset.id),requestedKg:1000,beneficiaryName:"No Production"},quoteProvider,retirementProvider));
  process.env.CARBONMARK_ENVIRONMENT="sandbox";process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="true";process.env.CARBONMARK_ORDER_EXECUTION_ACK="ENABLE_LIVE_CARBONMARK_RETIREMENTS";assert.equal(carbonmarkSandboxCertificationGate().ready,false);await assert.rejects(()=>runCarbonmarkSandboxCertification({assetId:Number(asset.id),requestedKg:1000,beneficiaryName:"No Mixed Gate"},quoteProvider,retirementProvider));
  console.log("Carbonmark sandbox certification smoke OK",{quote:true,order:true,retirement:true,certificate:true,provenance:true,sha256:true,immutable:true,productionBlocked:true,mixedGateBlocked:true});
}
try{await run();}finally{await pool.end();}
