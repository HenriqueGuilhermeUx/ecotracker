import assert from "node:assert/strict";
import { initDb,pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initCarbonmarkSandboxCertificationDb } from "../dist/carbonmark-sandbox-certification-db.js";
import { carbonmarkSandboxCertificationControl,carbonmarkSandboxCertificationGate,runCarbonmarkSandboxCertification } from "../dist/carbonmark-sandbox-certification.js";
const tag=Date.now();
async function init(){await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initCarbonmarkSandboxCertificationDb();}
async function seed({restricted=false}={}){
  const suffix=restricted?"restricted":"eligible";
  const {rows}=await pool.query(`INSERT INTO monitored_assets(registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,registry_batch_id,registry_evidence_url,retirement_supported,fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,eligibility_checked_at,eligibility_risk_flags,sourcing_shelf,sourcing_executable,sourcing_checked_at) VALUES('Verra VCS',$1,$2,$3,'VM0047','Brasil','2026','carbon','verified-offset','Sandbox certification smoke',8.5,5.5,25,0,100,$4,'dynamic','confirmed','connected',$5::jsonb,NOW(),TRUE,$6,$7,$8,'tradable','2026-01-01','2026-12-31','2026-12-31',$9,$10,$3,TRUE,$11,$4,TRUE,NOW(),$12::jsonb,$13,FALSE,NOW()) RETURNING *`,[
    `Carbonmark Sandbox ${suffix} ${tag}`,`carbonmark-sandbox-${suffix}-${tag}`,`https://example.com/${suffix}/${tag}`,restricted?1:1000,
    JSON.stringify({providerKey:"carbonmark",environment:"sandbox",assetPriceSourceId:`source-${suffix}-${tag}`}),
    restricted?"climate_contribution":"voluntary_offset",restricted?"restricted":"eligible",
    restricted?"Listing mantido fora de claims, disponível apenas para prova técnica sandbox.":"Registry/vintage/tradability verificados.",
    `VCS-${suffix}-${tag}`,`source-${suffix}-${tag}`,restricted?true:false,JSON.stringify(restricted?["manual-eligibility-review-required"]:[]),restricted?"restricted":"verified_compensation",
  ]);return rows[0];
}
async function run(){
  await init();
  process.env.CARBONMARK_API_KEY="cm_test_fake";process.env.CARBONMARK_ENVIRONMENT="sandbox";process.env.CARBONMARK_SANDBOX_E2E_ENABLED="true";process.env.CARBONMARK_SANDBOX_E2E_ACK="ENABLE_SANDBOX_CARBONMARK_RETIREMENTS";process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="false";process.env.CARBONMARK_ORDER_EXECUTION_ACK="DISABLED";process.env.CARBONMARK_SANDBOX_TECHNICAL_MAX_KG="1";
  assert.equal(carbonmarkSandboxCertificationGate().ready,true);assert.equal(carbonmarkSandboxCertificationGate().technicalMaxKg,1);
  const asset=await seed();const restricted=await seed({restricted:true});let quotes=0,orders=0;
  const quoteProvider=async(source,tonnes)=>{quotes++;const technical=source===`source-restricted-${tag}`;assert.equal(tonnes,technical?0.001:1);return{uuid:`sandbox-q-${technical?"technical-":""}${tag}`,assetPriceSourceId:source,quantityTonnes:tonnes,costUsdc:technical?0.10:7.77,raw:{sandbox:true,technical}};};
  const retirementProvider=async(input)=>{orders++;const technical=input.quoteUuid.includes("technical");return{status:"completed",reference:`retirement-${technical?"technical-":""}${tag}`,txHash:`0x${technical?"b":"a".repeat(64)}`,viewRetirementUrl:`https://sandbox.example/retirement/${technical?"technical-":""}${tag}`,certificateUrl:`https://sandbox.example/certificate/${technical?"technical-":""}${tag}`,provenanceUrl:`https://sandbox.example/provenance/${technical?"technical-":""}${tag}`,retirementId:`137-0x${(technical?"b":"a").repeat(64)}-0`,raw:{status:"COMPLETED",sandbox:true,technical}};};

  const result=await runCarbonmarkSandboxCertification({assetId:Number(asset.id),requestedKg:1000,beneficiaryName:"EcoTracker Sandbox",executedBy:"CI",certificationMode:"claim_ready"},quoteProvider,retirementProvider);
  assert.equal(result.certified,true);assert.equal(result.status,"completed");assert.equal(result.certification_mode,"claim_ready");assert.equal(String(result.certification_sha256).length,64);assert.ok(result.certificate_url);assert.ok(result.provenance_url);

  await assert.rejects(()=>runCarbonmarkSandboxCertification({assetId:Number(restricted.id),requestedKg:1,beneficiaryName:"Must Fail",certificationMode:"claim_ready"},quoteProvider,retirementProvider),/não claim-ready/i);
  const beforeRestricted=(await pool.query(`SELECT claim_category,eligibility_status,sourcing_shelf FROM monitored_assets WHERE id=$1`,[restricted.id])).rows[0];
  const technical=await runCarbonmarkSandboxCertification({assetId:Number(restricted.id),requestedKg:1,beneficiaryName:"EcoTracker Sandbox Technical Certification",certificationMode:"technical_probe",executedBy:"CI"},quoteProvider,retirementProvider);
  assert.equal(technical.certified,true);assert.equal(technical.certification_mode,"technical_probe");assert.equal(technical.claimDecision.allowed,false);assert.equal(Number(technical.requested_kg),1);assert.equal(Number(technical.cost_usdc),0.10);
  const afterRestricted=(await pool.query(`SELECT claim_category,eligibility_status,sourcing_shelf FROM monitored_assets WHERE id=$1`,[restricted.id])).rows[0];
  assert.deepEqual(afterRestricted,beforeRestricted,"Technical sandbox proof must not promote climate eligibility");
  await assert.rejects(()=>runCarbonmarkSandboxCertification({assetId:Number(restricted.id),requestedKg:2,beneficiaryName:"Too Large",certificationMode:"technical_probe"},quoteProvider,retirementProvider),/limitada a 1 kg/i);

  let immutable=false;try{await pool.query(`UPDATE carbonmark_sandbox_certifications SET cost_usdc=1 WHERE id=$1`,[technical.id]);}catch(e){immutable=String(e?.message||e).includes("completed_carbonmark_sandbox_certification_is_immutable");}assert.equal(immutable,true);
  const control=await carbonmarkSandboxCertificationControl();assert.equal(control.gate.ready,true);assert.equal(control.contract.technicalProbeChangesEligibility,false);assert.ok(control.certifications.some(x=>Number(x.id)===Number(technical.id)&&x.certification_mode==="technical_probe"));

  process.env.CARBONMARK_ENVIRONMENT="production";assert.equal(carbonmarkSandboxCertificationGate().ready,false);await assert.rejects(()=>runCarbonmarkSandboxCertification({assetId:Number(restricted.id),requestedKg:1,beneficiaryName:"No Production",certificationMode:"technical_probe"},quoteProvider,retirementProvider));
  process.env.CARBONMARK_ENVIRONMENT="sandbox";process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="true";process.env.CARBONMARK_ORDER_EXECUTION_ACK="ENABLE_LIVE_CARBONMARK_RETIREMENTS";assert.equal(carbonmarkSandboxCertificationGate().ready,false);await assert.rejects(()=>runCarbonmarkSandboxCertification({assetId:Number(restricted.id),requestedKg:1,beneficiaryName:"No Mixed Gate",certificationMode:"technical_probe"},quoteProvider,retirementProvider));
  assert.equal(quotes,2);assert.equal(orders,2);
  console.log("Carbonmark sandbox certification smoke OK",{claimReadyE2E:true,technicalProbeE2E:true,technicalProbeNoClimatePromotion:true,technicalMaxKg:1,quote:true,order:true,retirement:true,certificate:true,provenance:true,sha256:true,immutable:true,productionBlocked:true,mixedGateBlocked:true});
}
try{await run();}finally{await pool.end();}
