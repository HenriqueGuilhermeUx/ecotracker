import crypto from "node:crypto";
import { createCarbonmarkQuote, carbonmarkStatus, type CarbonmarkQuote } from "./carbonmark.js";
import { carbonmarkOrderExecutionStatus } from "./commerce-providers.js";
import { pool } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

type Json=Record<string,unknown>;
type QuoteProvider=(assetPriceSourceId:string,quantityTonnes:number)=>Promise<CarbonmarkQuote>;

const num=(value:unknown,fallback=0)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;};
const actorName=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const sha256=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function details(asset:Json){return asset.monitor_details&&typeof asset.monitor_details==="object"&&!Array.isArray(asset.monitor_details)?asset.monitor_details as Json:{};}
function sourceId(asset:Json){const value=details(asset).assetPriceSourceId;return typeof value==="string"&&value?value:String(asset.source_reference||"").replace(/^carbonmark-/,"");}
function isCarbonmark(asset:Json){return String(details(asset).providerKey||"")==="carbonmark"||String(asset.source_reference||"").startsWith("carbonmark-");}

export async function carbonmarkRailControl(){
  const execution=carbonmarkOrderExecutionStatus();
  const provider=carbonmarkStatus();
  const {rows:assets}=await pool.query(`
    SELECT id,registry,project_name,source_reference,source_url,source_price_usd_ton,available_tons,min_order_kg,
      claim_category,eligibility_status,source_unit_status,sourcing_shelf,sourcing_executable,monitor_details,last_checked_at
    FROM monitored_assets
    WHERE active=TRUE AND (source_reference LIKE 'carbonmark-%' OR monitor_details->>'providerKey'='carbonmark')
    ORDER BY CASE WHEN eligibility_status='eligible' THEN 0 ELSE 1 END,source_price_usd_ton ASC NULLS LAST,id
    LIMIT 100`);
  const {rows:probes}=await pool.query(`
    SELECT q.*,a.registry,a.project_name,a.source_reference
    FROM carbonmark_shadow_quotes q
    JOIN monitored_assets a ON a.id=q.monitored_asset_id
    ORDER BY q.observed_at DESC LIMIT 50`);
  const eligibleAssets=assets.map((asset)=>{
    const requestedKg=Math.max(1,Number(asset.min_order_kg||1000));
    const decision=evaluateAssetEligibility(asset,"voluntary_offset",requestedKg);
    return {...asset,assetPriceSourceId:sourceId(asset),claimReady:decision.allowed,claimDecision:decision};
  });
  return {
    provider,
    execution,
    contract:{stableApiVersion:"v18",shadowQuoteEndpoint:"POST /quotes",orderEndpoint:"POST /orders",sellerListingCreationAutomated:false},
    summary:{assets:eligibleAssets.length,claimReady:eligibleAssets.filter((item)=>item.claimReady).length,shadowQuotes:probes.length,orderExecutionLive:execution.live},
    assets:eligibleAssets,
    shadowQuotes:probes,
  };
}

export async function createCarbonmarkShadowQuote(input:{assetId:number;requestedKg:number;createdBy?:string|null},quoteProvider:QuoteProvider=createCarbonmarkQuote){
  const execution=carbonmarkOrderExecutionStatus();
  if(!execution.configured) throw Object.assign(new Error("Carbonmark API não configurada para shadow quote"),{status:409});
  const actor=actorName(input.createdBy);
  const {rows}=await pool.query(`SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE`,[input.assetId]);
  const asset=rows[0] as Json|undefined;
  if(!asset||!isCarbonmark(asset)) throw Object.assign(new Error("Ativo Carbonmark não encontrado"),{status:404});
  const requestedKg=Math.round(num(input.requestedKg));
  if(requestedKg<=0) throw Object.assign(new Error("Quantidade inválida"),{status:400});
  const minimum=Math.max(1,num(asset.min_order_kg,1));
  if(requestedKg<minimum) throw Object.assign(new Error(`Pedido mínimo Carbonmark: ${minimum} kg`),{status:409});
  const availableTons=num(asset.available_tons);
  if(availableTons>0&&requestedKg/1000>availableTons+0.000001) throw Object.assign(new Error(`Volume monitorado insuficiente: ${availableTons} t`),{status:409});
  const decision=evaluateAssetEligibility(asset,"voluntary_offset",requestedKg);
  if(!decision.allowed) throw Object.assign(new Error(`Ativo não está claim-ready: ${decision.reason}`),{status:409,decision});
  const assetPriceSourceId=sourceId(asset);
  if(!assetPriceSourceId) throw Object.assign(new Error("asset_price_source_id Carbonmark ausente"),{status:409});

  const requestedTonnes=requestedKg/1000;
  const quote=await quoteProvider(assetPriceSourceId,requestedTonnes);
  const costPerTonne=quote.costUsdc/requestedTonnes;
  const provider=carbonmarkStatus();
  const snapshot={
    version:"ecotracker-carbonmark-shadow-quote-v1",
    monitoredAssetId:Number(asset.id),registry:asset.registry,projectName:asset.project_name,sourceReference:asset.source_reference,
    assetPriceSourceId,requestedKg,requestedTonnes,quoteUuid:quote.uuid,costUsdc:quote.costUsdc,costUsdcTonne:costPerTonne,
    environment:provider.environment,apiVersion:"v18",claimDecision:decision,executionGate:execution,
    createdBy:actor,observedAt:new Date().toISOString(),
    invariant:"Shadow quote does not create a Carbonmark order, spend funds, or retire carbon.",
  };
  const hash=sha256(snapshot);
  const inserted=(await pool.query(`
    INSERT INTO carbonmark_shadow_quotes(
      monitored_asset_id,asset_price_source_id,requested_kg,requested_tonnes,quote_uuid,cost_usdc,cost_usdc_tonne,
      environment,api_version,created_by,provider_snapshot,probe_snapshot,probe_sha256
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'v18',$9,$10::jsonb,$11::jsonb,$12)
    ON CONFLICT(quote_uuid) DO NOTHING
    RETURNING *`,[
    asset.id,assetPriceSourceId,requestedKg,requestedTonnes,quote.uuid,quote.costUsdc,costPerTonne,
    provider.environment,actor,JSON.stringify(quote.raw),JSON.stringify(snapshot),hash,
  ])).rows[0];
  const record=inserted||(await pool.query(`SELECT * FROM carbonmark_shadow_quotes WHERE quote_uuid=$1`,[quote.uuid])).rows[0];
  if(inserted){
    await pool.query(`INSERT INTO carbonmark_rail_events(shadow_quote_id,event_type,actor,payload)
      VALUES($1,'shadow_quote_created',$2,$3::jsonb)`,[record.id,actor,JSON.stringify({probeSha256:hash,quoteUuid:quote.uuid,orderExecutionLive:execution.live})]);
  }
  return {
    ...record,
    idempotent:!inserted,
    asset:{id:asset.id,registry:asset.registry,projectName:asset.project_name,sourceReference:asset.source_reference},
    claimDecision:decision,
    execution,
    orderCreated:false,
    retirementCreated:false,
    message:"Shadow quote registrada. Nenhum POST /orders foi executado.",
  };
}
