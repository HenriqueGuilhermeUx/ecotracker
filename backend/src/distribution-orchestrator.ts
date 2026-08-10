import crypto from "node:crypto";
import { pool, withTransaction } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

export const distributionChannels=["carbonmark","regen","otc","direct","toucan","other"] as const;
export type DistributionChannel=typeof distributionChannels[number];
type Json=Record<string,unknown>;

const num=(value:unknown,fallback=0)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:fallback;};
const bool=(value:unknown)=>value===true||value==="true"||value===1||value==="1";
const actorName=(value?:string|null)=>(String(value||"").trim()||String(process.env.ADMIN_EMAIL||"ecotracker-admin")).slice(0,255);
const hash=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizeChannels(values:unknown):DistributionChannel[]{
  if(!Array.isArray(values)) return [];
  return [...new Set(values.map((value)=>String(value).toLowerCase()).filter((value):value is DistributionChannel=>(distributionChannels as readonly string[]).includes(value)))];
}

export function distributionChannelCapabilities(){
  return {
    direct:{publishMode:"internal_manual",automaticPublish:false,externalConfirmationRequired:false},
    otc:{publishMode:"manual_otc",automaticPublish:false,externalConfirmationRequired:false},
    carbonmark:{publishMode:"external_marketplace",automaticPublish:false,externalConfirmationRequired:true,orderExecutionEnabled:process.env.CARBONMARK_ORDER_EXECUTION_ENABLED==="true"},
    regen:{publishMode:"external_onboarding",automaticPublish:false,externalConfirmationRequired:true},
    toucan:{publishMode:"external_onboarding",automaticPublish:false,externalConfirmationRequired:true},
    other:{publishMode:"external_manual",automaticPublish:false,externalConfirmationRequired:true},
  } as Record<DistributionChannel,Json>;
}

async function expireReservations(){
  await pool.query(`UPDATE supply_reservations SET status='expired',updated_at=NOW()
    WHERE status IN ('active','pending') AND reserved_until IS NOT NULL AND reserved_until<NOW()`);
}

async function contextForInventory(client:{query:(text:string,values?:unknown[])=>Promise<{rows:any[]}>},inventoryId:number,lock=false){
  const lockSql=lock?"FOR UPDATE OF i,m,ma":"";
  const {rows}=await client.query(`
    SELECT i.*,m.supplier_name,m.status AS mandate_status,m.floor_price_usd_tonne,m.allowed_channels,m.valid_until AS mandate_valid_until,
      l.project_name,l.country,l.region,
      conv.review_id AS intake_review_id,conv.monitored_asset_id,
      er.id AS eligibility_review_id,er.status AS eligibility_review_status,er.review_sha256 AS eligibility_review_sha256,
      to_jsonb(ma) AS asset,
      COALESCE((SELECT SUM(r.reserved_tonnes) FROM supply_reservations r WHERE r.inventory_id=i.id AND r.status IN ('active','pending')),0) AS reserved_tonnes,
      GREATEST(0,i.authorized_tonnes-i.sold_tonnes-COALESCE((SELECT SUM(r.reserved_tonnes) FROM supply_reservations r WHERE r.inventory_id=i.id AND r.status IN ('active','pending')),0)) AS available_tonnes
    FROM supply_inventory i
    JOIN supplier_mandates m ON m.id=i.mandate_id
    JOIN supply_leads l ON l.id=m.lead_id
    LEFT JOIN supply_intake_conversions conv ON conv.inventory_id=i.id
    LEFT JOIN supply_eligibility_reviews er ON er.intake_review_id=conv.review_id
    LEFT JOIN monitored_assets ma ON ma.id=conv.monitored_asset_id
    WHERE i.id=$1 ${lockSql}`,[inventoryId]);
  return rows[0]||null;
}

function claimDecision(row:any){
  if(!row?.asset||row.eligibility_review_status!=="approved") return {allowed:false,reason:"Supply inventory ainda não possui eligibility review aprovada"};
  const asset=row.asset as Json;
  const granularity=Math.max(1,num(asset.retirement_granularity_kg,1000));
  return evaluateAssetEligibility(asset,"voluntary_offset",granularity);
}

export async function distributionDesk(){
  await expireReservations();
  const {rows}=await pool.query(`SELECT id FROM supply_inventory WHERE status<>'cancelled' ORDER BY updated_at DESC LIMIT 300`);
  const caps=distributionChannelCapabilities();
  const items=[] as any[];
  for(const record of rows){
    const row=await contextForInventory(pool,Number(record.id));
    if(!row) continue;
    const listings=(await pool.query(`SELECT * FROM supply_channel_listings WHERE inventory_id=$1 ORDER BY channel`,[record.id])).rows;
    const deployments=(await pool.query(`SELECT * FROM distribution_deployments WHERE inventory_id=$1 ORDER BY revision DESC LIMIT 5`,[record.id])).rows;
    const reservations=(await pool.query(`SELECT * FROM supply_reservations WHERE inventory_id=$1 AND status IN ('active','pending') ORDER BY created_at DESC`,[record.id])).rows;
    const decision=claimDecision(row);
    items.push({...row,claimReady:Boolean(decision.allowed),claimDecision:decision,listings,deployments,reservations,
      allowedChannels:normalizeChannels(row.allowed_channels),channelCapabilities:caps,
      integrityNote:"Todos os canais anunciam o mesmo saldo econômico global; reservas e vendas debitam supply_inventory uma única vez."});
  }
  return {count:items.length,channelCapabilities:caps,items};
}

export async function amendMandateChannels(input:{mandateId:number;allowedChannels:DistributionChannel[];evidenceUrl:string;note:string;amendedBy?:string|null}){
  const actor=actorName(input.amendedBy);
  const channels=normalizeChannels(input.allowedChannels);
  if(!channels.length) throw Object.assign(new Error("Selecione pelo menos um canal autorizado"),{status:400});
  if(!/^https?:\/\//i.test(String(input.evidenceUrl||""))) throw Object.assign(new Error("Evidência pública/contratual do amendment é obrigatória"),{status:400});
  if(String(input.note||"").trim().length<20) throw Object.assign(new Error("Descreva a autorização comercial do fornecedor"),{status:400});
  return withTransaction(async client=>{
    const mandate=(await client.query(`SELECT * FROM supplier_mandates WHERE id=$1 FOR UPDATE`,[input.mandateId])).rows[0];
    if(!mandate) throw Object.assign(new Error("Mandato não encontrado"),{status:404});
    if(mandate.status!=="active") throw Object.assign(new Error("Somente mandato ativo pode receber autorização de canais"),{status:409});
    const before=normalizeChannels(mandate.allowed_channels);
    const snapshot={version:"ecotracker-distribution-mandate-amendment-v1",mandateId:Number(mandate.id),supplierName:mandate.supplier_name,
      beforeChannels:before,afterChannels:channels,evidenceUrl:input.evidenceUrl,note:String(input.note).trim(),amendedBy:actor,amendedAt:new Date().toISOString()};
    const sha=hash(snapshot);
    const amendment=(await client.query(`
      INSERT INTO distribution_mandate_amendments(mandate_id,before_channels,after_channels,evidence_url,note,amended_by,amendment_snapshot,amendment_sha256)
      VALUES($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[
      mandate.id,JSON.stringify(before),JSON.stringify(channels),input.evidenceUrl,String(input.note).trim(),actor,JSON.stringify(snapshot),sha,
    ])).rows[0];
    await client.query(`UPDATE supplier_mandates SET allowed_channels=$2::jsonb,updated_at=NOW() WHERE id=$1`,[mandate.id,JSON.stringify(channels)]);
    const inventories=(await client.query(`SELECT id FROM supply_inventory WHERE mandate_id=$1`,[mandate.id])).rows;
    for(const inventory of inventories){
      await client.query(`INSERT INTO distribution_events(inventory_id,channel,event_type,actor,payload)
        VALUES($1,NULL,'mandate_channels_amended',$2,$3::jsonb)`,[inventory.id,actor,JSON.stringify({amendmentId:amendment.id,amendmentSha256:sha,before,after:channels})]);
    }
    return {...amendment,sha256:sha};
  });
}

export async function planDistribution(input:{inventoryId:number;channels:DistributionChannel[];markupPct?:number;askPriceUsdTonne?:number|null;preparedBy?:string|null}){
  await expireReservations();
  const actor=actorName(input.preparedBy);
  const requested=normalizeChannels(input.channels);
  if(!requested.length) throw Object.assign(new Error("Selecione pelo menos um canal"),{status:400});
  return withTransaction(async client=>{
    const row=await contextForInventory(client,input.inventoryId,true);
    if(!row) throw Object.assign(new Error("Inventário não encontrado"),{status:404});
    if(row.status!=="available") throw Object.assign(new Error("Inventário não está disponível para distribuição"),{status:409});
    if(row.mandate_status!=="active") throw Object.assign(new Error("Mandato do fornecedor não está ativo"),{status:409});
    if(row.mandate_valid_until&&new Date(String(row.mandate_valid_until)).getTime()<=Date.now()) throw Object.assign(new Error("Mandato do fornecedor expirou"),{status:409});
    const decision=claimDecision(row);
    if(!decision.allowed) throw Object.assign(new Error(`Inventário não é claim-ready: ${decision.reason}`),{status:409,decision});
    const allowed=normalizeChannels(row.allowed_channels);
    const unauthorized=requested.filter(channel=>!allowed.includes(channel));
    if(unauthorized.length) throw Object.assign(new Error(`Canais sem autorização no mandato: ${unauthorized.join(", ")}`),{status:409,unauthorized});
    const available=num(row.available_tonnes);
    if(available<=0) throw Object.assign(new Error("Sem saldo global disponível para anunciar"),{status:409});
    const markup=Math.max(0,Math.min(500,num(input.markupPct,num(process.env.ECOT_DISTRIBUTION_MARKUP_PCT,15))));
    const floor=num(row.floor_price_usd_tonne);
    const explicit=num(input.askPriceUsdTonne);
    const ask=explicit>0?explicit:floor>0?Number((floor*(1+markup/100)).toFixed(4)):0;
    if(ask<=0) throw Object.assign(new Error("Defina ask price ou floor price no mandato"),{status:409});
    if(floor>0&&ask+0.000001<floor) throw Object.assign(new Error("Ask price não pode ficar abaixo do floor do fornecedor"),{status:409});
    const revision=Number((await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS revision FROM distribution_deployments WHERE inventory_id=$1`,[row.id])).rows[0].revision);
    const snapshot={version:"ecotracker-distribution-v1",inventoryId:Number(row.id),mandateId:Number(row.mandate_id),monitoredAssetId:Number(row.monitored_asset_id),
      eligibilityReviewId:Number(row.eligibility_review_id),eligibilityReviewSha256:row.eligibility_review_sha256,revision,
      channels:requested,allowedChannels:allowed,authorizedTonnes:num(row.authorized_tonnes),soldTonnes:num(row.sold_tonnes),reservedTonnes:num(row.reserved_tonnes),
      globalAvailableTonnes:available,advertisedTonnesPerChannel:available,floorPriceUsdTonne:floor||null,markupPct:markup,askPriceUsdTonne:ask,
      preparedBy:actor,preparedAt:new Date().toISOString(),
      economicInvariant:"Cross-channel advertised volumes are exposure, not additive inventory. Global capacity remains supply_inventory authorized-sold-reserved."};
    const sha=hash(snapshot);
    const deployment=(await client.query(`
      INSERT INTO distribution_deployments(inventory_id,mandate_id,monitored_asset_id,eligibility_review_id,revision,requested_channels,
        advertised_tonnes,floor_price_usd_tonne,markup_pct,ask_price_usd_tonne,prepared_by,deployment_snapshot,deployment_sha256)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`,[
      row.id,row.mandate_id,row.monitored_asset_id,row.eligibility_review_id,revision,JSON.stringify(requested),available,floor||null,markup,ask,actor,JSON.stringify(snapshot),sha,
    ])).rows[0];
    for(const channel of requested){
      await client.query(`
        INSERT INTO supply_channel_listings(inventory_id,channel,advertised_tonnes,ask_price_usd_tonne,status,metadata)
        VALUES($1,$2,$3,$4,'planned',$5::jsonb)
        ON CONFLICT(inventory_id,channel) DO UPDATE SET
          advertised_tonnes=EXCLUDED.advertised_tonnes,ask_price_usd_tonne=EXCLUDED.ask_price_usd_tonne,
          status=CASE WHEN supply_channel_listings.status='active' THEN 'active' ELSE 'planned' END,
          metadata=supply_channel_listings.metadata||EXCLUDED.metadata,updated_at=NOW()`,[
        row.id,channel,available,ask,JSON.stringify({distributionDeploymentId:Number(deployment.id),deploymentSha256:sha,claimReady:true}),
      ]);
      await client.query(`INSERT INTO distribution_events(inventory_id,deployment_id,channel,event_type,actor,payload)
        VALUES($1,$2,$3,'channel_planned',$4,$5::jsonb)`,[row.id,deployment.id,channel,actor,JSON.stringify({advertisedTonnes:available,askPriceUsdTonne:ask})]);
    }
    return {...deployment,channels:requested,globalAvailableTonnes:available,askPriceUsdTonne:ask,claimDecision:decision,
      note:"O mesmo saldo pode ser exposto em vários canais; capacidade econômica continua global e única."};
  });
}

export async function activateDistributionChannel(input:{inventoryId:number;channel:DistributionChannel;externalListingId?:string|null;externalUrl?:string|null;actor?:string|null}){
  await expireReservations();
  const actor=actorName(input.actor);
  return withTransaction(async client=>{
    const row=await contextForInventory(client,input.inventoryId,true);
    if(!row) throw Object.assign(new Error("Inventário não encontrado"),{status:404});
    const decision=claimDecision(row);
    if(!decision.allowed) throw Object.assign(new Error(`Inventário deixou de ser claim-ready: ${decision.reason}`),{status:409});
    const allowed=normalizeChannels(row.allowed_channels);
    if(!allowed.includes(input.channel)) throw Object.assign(new Error("Canal não autorizado pelo mandato"),{status:409});
    const listing=(await client.query(`SELECT * FROM supply_channel_listings WHERE inventory_id=$1 AND channel=$2 FOR UPDATE`,[row.id,input.channel])).rows[0];
    if(!listing) throw Object.assign(new Error("Canal ainda não foi incluído em um plano de distribuição"),{status:409});
    const caps=distributionChannelCapabilities()[input.channel];
    if(bool(caps.externalConfirmationRequired)&&!String(input.externalListingId||input.externalUrl||"").trim()){
      throw Object.assign(new Error("Canal externo exige referência ou URL da listagem confirmada"),{status:409});
    }
    const updated=(await client.query(`UPDATE supply_channel_listings SET status='active',external_listing_id=COALESCE($3,external_listing_id),
      external_url=COALESCE($4,external_url),metadata=metadata||$5::jsonb,updated_at=NOW() WHERE inventory_id=$1 AND channel=$2 RETURNING *`,[
      row.id,input.channel,input.externalListingId??null,input.externalUrl??null,JSON.stringify({activatedBy:actor,activatedAt:new Date().toISOString(),automaticPublish:false}),
    ])).rows[0];
    await client.query(`INSERT INTO distribution_events(inventory_id,channel,event_type,actor,payload) VALUES($1,$2,'channel_activated',$3,$4::jsonb)`,[
      row.id,input.channel,actor,JSON.stringify({listingId:updated.id,externalListingId:updated.external_listing_id,externalUrl:updated.external_url,automaticPublish:false}),
    ]);
    return {...updated,capabilities:caps,warning:"Ativação confirma exposição comercial; não significa execução/retirement automático do provider."};
  });
}

export async function reserveDistribution(input:{inventoryId:number;channel:DistributionChannel;externalOrderId:string;reservedTonnes:number;reservedUntil?:string|null;actor?:string|null}){
  await expireReservations();
  const actor=actorName(input.actor);
  return withTransaction(async client=>{
    const row=await contextForInventory(client,input.inventoryId,true);
    if(!row) throw Object.assign(new Error("Inventário não encontrado"),{status:404});
    const decision=claimDecision(row);
    if(!decision.allowed) throw Object.assign(new Error(`Inventário não é claim-ready: ${decision.reason}`),{status:409});
    const listing=(await client.query(`SELECT * FROM supply_channel_listings WHERE inventory_id=$1 AND channel=$2 FOR UPDATE`,[row.id,input.channel])).rows[0];
    if(!listing||listing.status!=="active") throw Object.assign(new Error("Canal não está ativo para receber reserva"),{status:409});
    const orderId=String(input.externalOrderId||"").trim();
    if(orderId.length<3) throw Object.assign(new Error("externalOrderId/idempotency key é obrigatório"),{status:400});
    const existing=(await client.query(`SELECT * FROM supply_reservations WHERE inventory_id=$1 AND channel=$2 AND external_order_id=$3 FOR UPDATE`,[row.id,input.channel,orderId])).rows[0];
    if(existing) return {...existing,idempotent:true};
    const tonnes=num(input.reservedTonnes);
    if(tonnes<=0) throw Object.assign(new Error("Volume de reserva inválido"),{status:400});
    if(tonnes>num(row.available_tonnes)+0.000001) throw Object.assign(new Error(`Saldo global insuficiente: ${row.available_tonnes} t disponíveis`),{status:409});
    const reservedUntil=input.reservedUntil||new Date(Date.now()+30*60_000).toISOString();
    const reservation=(await client.query(`
      INSERT INTO supply_reservations(inventory_id,channel,external_order_id,reserved_tonnes,status,reserved_until,metadata)
      VALUES($1,$2,$3,$4,'active',$5::timestamptz,$6::jsonb) RETURNING *`,[
      row.id,input.channel,orderId,tonnes,reservedUntil,JSON.stringify({distributionOrchestrator:true,actor}),
    ])).rows[0];
    await client.query(`INSERT INTO distribution_events(inventory_id,channel,event_type,actor,payload) VALUES($1,$2,'global_inventory_reserved',$3,$4::jsonb)`,[
      row.id,input.channel,actor,JSON.stringify({reservationId:reservation.id,externalOrderId:orderId,reservedTonnes:tonnes,reservedUntil}),
    ]);
    return {...reservation,idempotent:false};
  });
}
