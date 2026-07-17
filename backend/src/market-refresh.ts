import { pool } from "./db.js";
let lastAttempt=0;

async function refreshFx():Promise<number|null>{
  try{
    const r=await fetch("https://api.frankfurter.app/latest?from=USD&to=BRL",{signal:AbortSignal.timeout(8000),headers:{Accept:"application/json"}});
    if(!r.ok)return null;
    const data=await r.json() as {rates?:{BRL?:number}};
    const rate=Number(data.rates?.BRL);
    if(!Number.isFinite(rate)||rate<=0)return null;
    await pool.query("UPDATE monitored_assets SET fx_brl_usd=$1,updated_at=NOW() WHERE active=TRUE",[rate]);
    return rate;
  }catch(e){console.warn("[market] FX refresh failed",e);return null;}
}

async function refreshRegen():Promise<{orders:number;availableTons:number}|null>{
  const base=(process.env.REGEN_REST_URL||"https://rest.cosmos.directory/regen").replace(/\/$/,"");
  try{
    const r=await fetch(`${base}/regen/ecocredit/marketplace/v1/sell-orders?pagination.limit=200`,{signal:AbortSignal.timeout(10000),headers:{Accept:"application/json"}});
    if(!r.ok)throw new Error(`Regen REST ${r.status}`);
    const data=await r.json() as {sell_orders?:Array<Record<string,unknown>>;sellOrders?:Array<Record<string,unknown>>};
    const now=Date.now();
    const orders=(data.sell_orders||data.sellOrders||[]).filter(o=>!o.expiration||Date.parse(String(o.expiration))>now);
    const availableTons=orders.reduce((sum,o)=>sum+(Number.isFinite(Number(o.quantity))?Number(o.quantity):0),0);
    await pool.query(`UPDATE monitored_assets SET available_tons=$1,availability_status=$2,source_status='connected',monitor_details=$3::jsonb,last_checked_at=NOW(),updated_at=NOW() WHERE source_reference='regen-marketplace'`,[availableTons,orders.length?"indicative":"monitoring",JSON.stringify({orderCount:orders.length,endpoint:base,checkedAt:new Date().toISOString(),note:"Preço executável deve ser confirmado por ordem e denominação."})]);
    return {orders:orders.length,availableTons};
  }catch(e){
    const message=e instanceof Error?e.message:"Unknown error";
    console.warn("[market] Regen refresh failed",e);
    await pool.query(`UPDATE monitored_assets SET source_status='degraded',monitor_details=jsonb_build_object('error',$1::text,'checkedAt',NOW()),last_checked_at=NOW(),updated_at=NOW() WHERE source_reference='regen-marketplace'`,[message]);
    return null;
  }
}

export async function refreshMarketData(){lastAttempt=Date.now();const [fx,regen]=await Promise.all([refreshFx(),refreshRegen()]);return {fx,regen,refreshedAt:new Date().toISOString()};}
export function refreshIfStale(){if(Date.now()-lastAttempt<30*60*1000)return;void refreshMarketData().catch(e=>console.warn("[market] background refresh failed",e));}
