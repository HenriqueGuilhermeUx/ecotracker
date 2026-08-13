import assert from "node:assert/strict";
import express from "express";

process.env.JWT_SECRET="client-agreement-smoke-secret";
process.env.ECOT_LEGAL_NAME="EcoTracker Test Ltda";
process.env.ECOT_LEGAL_TAX_ID="00.000.000/0001-00";
process.env.ECOT_LEGAL_ADDRESS="Rua Teste, 100 - Brasil";
process.env.ECOT_LEGAL_EMAIL="legal@example.com";
process.env.ECOT_CONTRACT_FORUM_CITY="São Paulo";
process.env.ECOT_CONTRACT_FORUM_STATE="SP";

const { initDb,pool }=await import("../dist/db.js");
const { initMarketDb }=await import("../dist/market-db.js");
const { initEligibilityDb }=await import("../dist/eligibility-db.js");
const { initCommerceDb }=await import("../dist/commerce-db.js");
const { initAssistedSourcingDb }=await import("../dist/assisted-sourcing-db.js");
const { createAdminToken }=await import("../dist/auth.js");
const { registerClientAgreementRoutes }=await import("../dist/client-agreement-routes.js");

await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initAssistedSourcingDb();
const tag=Date.now();
const asset=(await pool.query(`INSERT INTO monitored_assets(
  registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,
  source_price_usd_ton,fx_brl_usd,available_tons,min_order_kg,pricing_mode,availability_status,source_status,
  active,claim_category,eligibility_status,source_unit_status,commercial_valid_until,offer_expires_at,
  registry_evidence_url,retirement_supported,fractional_retirement_supported,retirement_granularity_kg,eligibility_checked_at
) VALUES('Gold Standard','Agreement Smoke Solar',$1,$2,'Solar','India','2021','carbon','standard',10,5,12000,1,'quote','monitoring','manual',TRUE,'voluntary_offset','eligible','tradable',NOW()+INTERVAL '30 days',NOW()+INTERVAL '30 days',$2,TRUE,TRUE,1,NOW()) RETURNING *`,[`agreement-smoke-${tag}`,`https://example.com/agreement/${tag}`])).rows[0];

const quote=(await pool.query(`INSERT INTO quote_requests(
  asset_id,buyer_name,buyer_email,company_name,tax_id,requested_kg,purpose,status,automation_enabled,sourcing_status,
  sourcing_provider,sourcing_reference,source_cost_brl,final_total,gross_profit_brl,net_profit_brl,quote_expires_at,pricing_snapshot
) VALUES($1,'Henrique Teste','henrique@example.com','Compradora Teste S.A.','11.111.111/0001-11',10000000,'voluntary_offset','quoted',FALSE,'manual_source_confirmed','gold-standard',$2,600000,690000,90000,90000,NOW()+INTERVAL '60 minutes',$3::jsonb) RETURNING *`,[
  asset.id,`GS-QUOTE-${tag}`,JSON.stringify({pricingMode:"assisted_confirmed",sourceProvider:"gold-standard",sourceReference:`GS-QUOTE-${tag}`,sourceEvidenceUrl:`https://example.com/evidence/${tag}`,sourceAvailableKg:10000000,sourceCostBrl:600000,serviceRevenueBrl:90000,markupTier:{key:"enterprise"},confirmedByAdmin:true,confirmedAt:new Date().toISOString()})
])).rows[0];

const reviewSnapshot={
  version:"ecotracker-assisted-quote-commercial-v1",
  quote:{id:Number(quote.id),publicCode:quote.public_code,status:"quoted",requestedKg:10000000,purpose:"voluntary_offset",expiresAt:quote.quote_expires_at},
  buyer:{name:"Henrique Teste",email:"henrique@example.com",companyName:"Compradora Teste S.A.",taxId:"11.111.111/0001-11"},
  asset:{id:Number(asset.id),registry:"Gold Standard",projectName:"Agreement Smoke Solar",vintage:"2021",sourceReference:asset.source_reference},
  sourcing:{status:"manual_source_confirmed",provider:"gold-standard",confirmedReference:`GS-QUOTE-${tag}`,confirmedAvailableKg:10000000,evidenceUrl:`https://example.com/evidence/${tag}`,confirmedAt:new Date().toISOString(),confirmedByAdmin:true},
  commercial:{sourceCostBrl:600000,finalTotalBrl:690000,pricePerTonneBrl:69,grossProfitBrl:90000,taxReserveBrl:0,netProfitBrl:90000,markupTier:{key:"enterprise"},serviceRevenueBrl:90000},
};
await pool.query(`INSERT INTO assisted_quote_reviews(quote_id,status,reviewed_by,snapshot,snapshot_sha256,approved_at) VALUES($1,'approved','ci',$2::jsonb,$3,NOW())`,[quote.id,JSON.stringify(reviewSnapshot),"a".repeat(64)]);

const app=express();app.use(express.json());registerClientAgreementRoutes(app);
app.post("/api/market/quotes/:publicCode/checkout",(_req,res)=>res.status(201).json({checkout:true}));
const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))});
const port=server.address().port;const base=`http://127.0.0.1:${port}`;const admin={Authorization:`Bearer ${createAdminToken()}`,"Content-Type":"application/json"};

try{
  const generatedResponse=await fetch(`${base}/api/admin/market/assisted-sourcing/${quote.id}/agreement/generate`,{method:"POST",headers:admin,body:"{}"});
  assert.equal(generatedResponse.status,201);const generated=await generatedResponse.json();
  assert.equal(generated.agreement.status,"awaiting_signature");assert.match(generated.agreement.document_sha256,/^[a-f0-9]{64}$/);assert.equal(generated.acceptanceEnabled,true);

  const blocked=await fetch(`${base}/api/market/quotes/${quote.public_code}/checkout`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"pix"})});
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).code,"CLIENT_AGREEMENT_REQUIRED");

  const publicBefore=await (await fetch(`${base}/api/market/agreements/${generated.agreement.public_code}`)).json();
  assert.equal(publicBefore.current,true);assert.equal(publicBefore.acceptanceEnabled,true);

  const acceptedResponse=await fetch(`${base}/api/market/agreements/${generated.agreement.public_code}/accept`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({representativeName:"Diretora Teste",representativeEmail:"diretora@example.com",representativeTitle:"Diretora",authorityConfirmed:true,termsAccepted:true})});
  assert.equal(acceptedResponse.status,200);const accepted=await acceptedResponse.json();assert.equal(accepted.status,"accepted");assert.match(accepted.acceptanceSha256,/^[a-f0-9]{64}$/);

  const allowed=await fetch(`${base}/api/market/quotes/${quote.public_code}/checkout`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"pix"})});
  assert.equal(allowed.status,201);assert.equal((await allowed.json()).checkout,true);

  await pool.query("UPDATE quote_requests SET final_total=final_total+1000 WHERE id=$1",[quote.id]);
  const stale=await (await fetch(`${base}/api/market/agreements/${generated.agreement.public_code}`)).json();assert.equal(stale.current,false);assert.equal(stale.status,"superseded");
  const blockedAgain=await fetch(`${base}/api/market/quotes/${quote.public_code}/checkout`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"pix"})});assert.equal(blockedAgain.status,409);
  console.log("Client Agreement Gate smoke OK",{quote:quote.public_code,agreement:generated.agreement.public_code});
}finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
