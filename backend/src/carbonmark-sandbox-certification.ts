import crypto from "node:crypto";
import { carbonmarkStatus, createCarbonmarkQuote, executeCarbonmarkRetirement, type CarbonmarkQuote, type CarbonmarkOrderResult } from "./carbonmark.js";
import { carbonmarkOrderExecutionStatus } from "./commerce-providers.js";
import { pool } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

type Json=Record<string,unknown>;
type QuoteProvider=(assetPriceSourceId:string,quantityTonnes:number)=>Promise<CarbonmarkQuote>;
type RetirementProvider=(input:{quoteUuid:string;beneficiaryName:string;retirementMessage:string})=>Promise<CarbonmarkOrderResult>;
const sha256=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actor=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const details=(asset:Json)=>asset.monitor_details&&typeof asset.monitor_details==="object"&&!Array.isArray(asset.monitor_details)?asset.monitor_details as Json:{};
const sourceId=(asset:Json)=>String(details(asset).assetPriceSourceId||String(asset.source_reference||"").replace(/^carbonmark-/,""));

export function carbonmarkSandboxCertificationGate(){
  const provider=carbonmarkStatus();
  const live=carbonmarkOrderExecutionStatus();
  const environment=String(process.env.CARBONMARK_ENVIRONMENT||"sandbox").toLowerCase();
  const enabled=process.env.CARBONMARK_SANDBOX_E2E_ENABLED==="true";
  const acknowledged=process.env.CARBONMARK_SANDBOX_E2E_ACK==="ENABLE_SANDBOX_CARBONMARK_RETIREMENTS";
  const configured=Boolean(process.env.CARBONMARK_API_KEY?.trim());
  const safeEnvironment=environment==="sandbox";
  const productionGateDisarmed=!live.live;
  return {
    configured,enabled,acknowledged,environment,safeEnvironment,productionGateDisarmed,
    ready:configured&&enabled&&acknowledged&&safeEnvironment&&productionGateDisarmed,
    apiVersion:"v18",provider,
    requiredAck:"ENABLE_SANDBOX_CARBONMARK_RETIREMENTS",
    invariant:"Sandbox certification refuses to run if environment is not sandbox or production order gate is live.",
  };
}

export async function carbonmarkSandboxCertificationControl(){
  const gate=carbonmarkSandboxCertificationGate();
  const {rows}=await pool.query(`SELECT c.*,a.registry,a.project_name,a.source_reference FROM carbonmark_sandbox_certifications c JOIN monitored_assets a ON a.id=c.monitored_asset_id ORDER BY c.created_at DESC LIMIT 30`);
  return {gate,summary:{runs:rows.length,completed:rows.filter(r=>r.status==='completed').length,processing:rows.filter(r=>r.status==='processing').length},certifications:rows};
}

export async function runCarbonmarkSandboxCertification(input:{assetId:number;requestedKg:number;beneficiaryName:string;retirementMessage?:string;executedBy?:string|null},quoteProvider:QuoteProvider=createCarbonmarkQuote,retirementProvider:RetirementProvider=executeCarbonmarkRetirement){
  const gate=carbonmarkSandboxCertificationGate();
  if(!gate.ready) throw Object.assign(new Error("Carbonmark sandbox E2E não está armado com segurança"),{status:409,gate});
  const {rows}=await pool.query(`SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE`,[input.assetId]);
  const asset=rows[0] as Json|undefined;
  if(!asset||!(String(asset.source_reference||"").startsWith("carbonmark-")||details(asset).providerKey==="carbonmark")) throw Object.assign(new Error("Ativo Carbonmark não encontrado"),{status:404});
  const requestedKg=Math.round(Number(input.requestedKg));
  if(!Number.isFinite(requestedKg)||requestedKg<=0) throw Object.assign(new Error("Quantidade inválida"),{status:400});
  const minimum=Math.max(1,Number(asset.min_order_kg||1));
  if(requestedKg<minimum) throw Object.assign(new Error(`Pedido mínimo Carbonmark: ${minimum} kg`),{status:409});
  const decision=evaluateAssetEligibility(asset,"voluntary_offset",requestedKg);
  if(!decision.allowed) throw Object.assign(new Error(`Ativo não claim-ready: ${decision.reason}`),{status:409,decision});
  const assetPriceSourceId=sourceId(asset);
  if(!assetPriceSourceId) throw Object.assign(new Error("asset_price_source_id ausente"),{status:409});
  const executedBy=actor(input.executedBy);
  const beneficiaryName=String(input.beneficiaryName||"EcoTracker Sandbox Certification").trim().slice(0,255);
  const retirementMessage=String(input.retirementMessage||`EcoTracker sandbox certification · ${requestedKg} kg CO2e`).trim().slice(0,500);
  const quote=await quoteProvider(assetPriceSourceId,requestedKg/1000);
  const order=await retirementProvider({quoteUuid:quote.uuid,beneficiaryName,retirementMessage});
  const snapshot={
    version:"ecotracker-carbonmark-sandbox-certification-v1",apiVersion:"v18",environment:"sandbox",
    monitoredAssetId:Number(asset.id),registry:asset.registry,projectName:asset.project_name,sourceReference:asset.source_reference,
    assetPriceSourceId,requestedKg,quoteUuid:quote.uuid,costUsdc:quote.costUsdc,beneficiaryName,retirementMessage,
    orderStatus:order.status,reference:order.reference,retirementId:order.retirementId,txHash:order.txHash,
    retirementUrl:order.viewRetirementUrl,certificateUrl:order.certificateUrl,provenanceUrl:order.provenanceUrl,
    claimDecision:decision,gate,executedBy,certifiedAt:new Date().toISOString(),
    invariant:"This certification is sandbox-only and cannot enable production execution.",
  };
  const hash=sha256(snapshot);
  const inserted=(await pool.query(`
    INSERT INTO carbonmark_sandbox_certifications(monitored_asset_id,asset_price_source_id,requested_kg,quote_uuid,cost_usdc,beneficiary_name,retirement_message,status,provider_reference,retirement_id,retirement_tx_hash,retirement_url,certificate_url,provenance_url,executed_by,execution_snapshot,provider_snapshot,certification_sha256,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::varchar,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,CASE WHEN $8::varchar='completed' THEN NOW() ELSE NULL END)
    ON CONFLICT(quote_uuid) DO NOTHING RETURNING *`,[
      asset.id,assetPriceSourceId,requestedKg,quote.uuid,quote.costUsdc,beneficiaryName,retirementMessage,order.status,
      order.reference,order.retirementId,order.txHash,order.viewRetirementUrl,order.certificateUrl,order.provenanceUrl,executedBy,
      JSON.stringify(snapshot),JSON.stringify({quote:quote.raw,order:order.raw}),hash,
    ])).rows[0];
  const record=inserted||(await pool.query(`SELECT * FROM carbonmark_sandbox_certifications WHERE quote_uuid=$1`,[quote.uuid])).rows[0];
  if(inserted) await pool.query(`INSERT INTO carbonmark_sandbox_certification_events(certification_id,event_type,actor,payload) VALUES($1,$2,$3,$4::jsonb)`,[record.id,order.status==='completed'?'sandbox_retirement_completed':'sandbox_retirement_processing',executedBy,JSON.stringify({quoteUuid:quote.uuid,certificationSha256:hash,retirementId:order.retirementId})]);
  return {...record,idempotent:!inserted,asset:{id:asset.id,registry:asset.registry,projectName:asset.project_name},claimDecision:decision,gate,order,certified:order.status==='completed'};
}
