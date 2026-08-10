import { pool } from "./db.js";
import { assertAssetExecutionReady } from "./execution-readiness.js";

type Json=Record<string,unknown>;

const num=(value:unknown)=>{const parsed=Number(value);return Number.isInteger(parsed)&&parsed>0?parsed:null;};
const text=(value:unknown)=>typeof value==="string"&&value.trim()?value.trim():null;

function requestUrl(input:Parameters<typeof fetch>[0]){
  if(typeof input==="string")return input;
  if(input instanceof URL)return input.toString();
  return input.url;
}

function executorKind(url:string){
  const source=String(process.env.SOURCE_EXECUTOR_URL||"").trim().replace(/\/+$/,"");
  const retirement=String(process.env.RETIREMENT_EXECUTOR_URL||"").trim().replace(/\/+$/,"");
  if(source&&(url===source||url.startsWith(`${source}/`)))return"source";
  if(retirement&&(url===retirement||url.startsWith(`${retirement}/`)))return"retirement";
  return null;
}

function parseBody(init?:RequestInit):Json|null{
  const body=init?.body;
  if(typeof body!=="string"||!body.trim())return null;
  try{const parsed=JSON.parse(body);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Json:null;}catch{return null;}
}

function pick(obj:unknown,keys:string[],depth=0):unknown{
  if(!obj||typeof obj!=="object"||depth>4)return undefined;
  const record=obj as Json;
  for(const key of keys)if(record[key]!==undefined&&record[key]!==null)return record[key];
  for(const key of ["asset","quote","leg","item","order","payload","data","context"]){
    if(record[key]&&typeof record[key]==="object"){
      const found=pick(record[key],keys,depth+1);if(found!==undefined)return found;
    }
  }
  return undefined;
}

async function assetIdFromQuote(quoteId:number){
  try{return num((await pool.query(`SELECT asset_id FROM market_quotes WHERE id=$1`,[quoteId])).rows[0]?.asset_id);}catch{return null;}
}

async function assetIdFromLeg(legId:number){
  try{
    const {rows}=await pool.query(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='asset_id'
        AND table_name LIKE 'corporate_basket%leg%'
      INTERSECT
      SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='id'
        AND table_name LIKE 'corporate_basket%leg%'
      ORDER BY table_name`);
    for(const row of rows){
      const table=String(row.table_name);
      if(!/^[a-z0-9_]+$/.test(table))continue;
      const result=await pool.query(`SELECT asset_id FROM "${table}" WHERE id=$1`,[legId]);
      const assetId=num(result.rows[0]?.asset_id);if(assetId)return assetId;
    }
  }catch{}
  return null;
}

async function resolveAssetId(body:Json|null){
  if(!body)return null;
  const direct=num(pick(body,["assetId","asset_id","monitoredAssetId","monitored_asset_id"]));
  if(direct)return direct;
  const sourceReference=text(pick(body,["sourceReference","source_reference"]));
  if(sourceReference){
    const row=(await pool.query(`SELECT id FROM monitored_assets WHERE source_reference=$1 ORDER BY id DESC LIMIT 1`,[sourceReference])).rows[0];
    const id=num(row?.id);if(id)return id;
  }
  const registryProjectId=text(pick(body,["registryProjectId","registry_project_id"]));
  const registryBatchId=text(pick(body,["registryBatchId","registry_batch_id","batchReference","batch_reference"]));
  if(registryProjectId||registryBatchId){
    const row=(await pool.query(`SELECT id FROM monitored_assets
      WHERE ($1::text IS NULL OR registry_project_id=$1)
        AND ($2::text IS NULL OR registry_batch_id=$2)
      ORDER BY id DESC LIMIT 1`,[registryProjectId,registryBatchId])).rows[0];
    const id=num(row?.id);if(id)return id;
  }
  const quoteId=num(pick(body,["quoteId","quote_id"]));
  if(quoteId){const id=await assetIdFromQuote(quoteId);if(id)return id;}
  const legId=num(pick(body,["legId","leg_id","basketLegId","basket_leg_id"]));
  if(legId){const id=await assetIdFromLeg(legId);if(id)return id;}
  return null;
}

export async function guardedExecutorFetch(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1]){
  const url=requestUrl(input);
  const kind=executorKind(url);
  if(!kind)return fetch(input,init);

  const body=parseBody(init);
  const assetId=await resolveAssetId(body);
  if(assetId){
    await assertAssetExecutionReady(assetId);
  }else{
    throw Object.assign(new Error("Não foi possível resolver o ativo antes da chamada ao executor genérico"),{
      status:409,code:"EXECUTION_ASSET_IDENTITY_REQUIRED",executorKind:kind,
    });
  }
  return fetch(input,init);
}
