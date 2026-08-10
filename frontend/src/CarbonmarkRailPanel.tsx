import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./carbonmark-rail.css";

type Json=Record<string,any>;
const num=(value:unknown)=>{const parsed=Number(value||0);return Number.isFinite(parsed)?parsed:0;};
const tons=(value:unknown)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));
const money=(value:unknown)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"USD",maximumFractionDigits:4}).format(num(value));

export function CarbonmarkRailPanel(){
  const [data,setData]=useState<Json>({});const [loading,setLoading]=useState(true);const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);
  const [assetId,setAssetId]=useState("");const [kg,setKg]=useState("1000");
  const load=useCallback(async()=>{try{const result=await api<Json>("/admin/market/carbonmark/control");setData(result);if(!assetId&&result.assets?.[0]?.id)setAssetId(String(result.assets[0].id));setMessage("");}
    catch(error){setMessage((error as Error).message);}finally{setLoading(false);}},[assetId]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),30000);return()=>window.clearInterval(timer);},[load]);
  const assets=Array.isArray(data.assets)?data.assets:[];const probes=Array.isArray(data.shadowQuotes)?data.shadowQuotes:[];const execution=data.execution||{};
  const selected=useMemo(()=>assets.find((item:Json)=>String(item.id)===assetId),[assets,assetId]);
  const validKg=Math.round(num(kg));const canQuote=Boolean(execution.configured)&&Boolean(selected?.claimReady)&&validKg>=num(selected?.min_order_kg||1)&&validKg>0;

  async function shadowQuote(){
    setBusy(true);setMessage("");
    try{
      const result=await api<Json>("/admin/market/carbonmark/shadow-quote",{method:"POST",body:JSON.stringify({assetId:Number(assetId),requestedKg:validKg,createdBy:"Carbon Desk"})});
      setMessage(`Shadow quote ${result.quote_uuid} criada: ${money(result.cost_usdc)} USDC. Nenhum order foi criado.`);await load();
    }catch(error){setMessage((error as Error).message);}finally{setBusy(false);}
  }

  return <section className="desk-card carbonmark-rail-panel">
    <header className="carbonmark-rail-head"><div><span>CARBONMARK RAIL · v18</span><h2>Shadow quote → prova de execução</h2></div>
      <div className={`rail-mode ${execution.live?"live":"blocked"}`}><b>{execution.live?"ORDER LIVE":"ORDER BLOQUEADO"}</b><small>{execution.environment||"sandbox"} · API {data.provider?.stableApiVersion||"v18"}</small></div></header>
    <div className="rail-safety"><strong>SHADOW QUOTE ≠ ORDER</strong><span>Esta mesa chama apenas <code>POST /quotes</code>. Ela não gasta USDC, não chama <code>POST /orders</code> e não aposenta crédito.</span></div>
    <div className="rail-status-grid">
      <span><small>API key</small><b>{execution.configured?"configurada":"ausente"}</b></span><span><small>Flag</small><b>{execution.enabled?"ON":"OFF"}</b></span><span><small>ACK</small><b>{execution.acknowledged?"OK":"DISABLED"}</b></span><span><small>Order</small><b>{execution.live?"LIVE":"BLOCKED"}</b></span>
      <span><small>Listings monitorados</small><b>{data.summary?.assets||0}</b></span><span><small>Claim-ready</small><b>{data.summary?.claimReady||0}</b></span><span><small>Shadow quotes</small><b>{data.summary?.shadowQuotes||0}</b></span><span><small>Seller publish API</small><b>não assumida</b></span>
    </div>
    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando Carbonmark Rail...</div>:<>
      <div className="shadow-quote-form">
        <label>Listing Carbonmark<select value={assetId} onChange={e=>setAssetId(e.target.value)}>{assets.map((item:Json)=><option key={item.id} value={item.id}>{item.project_name} · {item.registry} · {money(item.source_price_usd_ton)}/t · min {item.min_order_kg} kg</option>)}</select></label>
        <label>Quantidade kg<input type="number" min={selected?.min_order_kg||1} step="1" value={kg} onChange={e=>setKg(e.target.value)}/></label>
        <div className="shadow-preview"><small>Selecionado</small><b>{selected?.project_name||"—"}</b><span>{tons(validKg/1000)} t · source {selected?.assetPriceSourceId||"—"}</span></div>
        <button disabled={!canQuote||busy} onClick={()=>void shadowQuote()}>{busy?"Cotando...":"Executar shadow quote"}</button>
      </div>
      {!execution.configured&&<div className="rail-blocker">Configure <b>CARBONMARK_API_KEY</b> para cotar. Isso ainda não habilita orders.</div>}
      {execution.configured&&!execution.live&&<div className="rail-safe-ready">API pronta para quote. Aposentadoria permanece desarmada por dupla trava.</div>}
      <div className="shadow-history"><h3>Últimas shadow quotes</h3>{probes.slice(0,20).map((probe:Json)=><article key={probe.id}><div><b>{probe.project_name}</b><small>{probe.registry} · {probe.source_reference}</small></div><span><small>Volume</small><b>{tons(num(probe.requested_kg)/1000)} t</b></span><span><small>Custo</small><b>{money(probe.cost_usdc)}</b></span><span><small>USDC/t</small><b>{money(probe.cost_usdc_tonne)}</b></span><code>{String(probe.quote_uuid).slice(0,18)}…</code><em>SHA {String(probe.probe_sha256).slice(0,10)}…</em></article>)}{!probes.length&&<div className="desk-empty">Nenhuma shadow quote auditada ainda.</div>}</div>
    </>}
  </section>;
}
