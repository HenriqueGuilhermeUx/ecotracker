import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./carbonmark-rail.css";

type Json=Record<string,any>;
const num=(value:unknown)=>{const parsed=Number(value||0);return Number.isFinite(parsed)?parsed:0;};
const tons=(value:unknown)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));
const money=(value:unknown)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"USD",maximumFractionDigits:4}).format(num(value));

export function CarbonmarkRailPanel(){
  const [data,setData]=useState<Json>({});const [cert,setCert]=useState<Json>({});const [loading,setLoading]=useState(true);const [message,setMessage]=useState("");const [busy,setBusy]=useState("");
  const [assetId,setAssetId]=useState("");const [kg,setKg]=useState("1000");const [beneficiary,setBeneficiary]=useState("EcoTracker Sandbox Certification");
  const load=useCallback(async()=>{try{const [rail,certification]=await Promise.all([api<Json>("/admin/market/carbonmark/control"),api<Json>("/admin/market/carbonmark/sandbox-certification")]);setData(rail);setCert(certification);if(!assetId&&rail.assets?.[0]?.id)setAssetId(String(rail.assets[0].id));setMessage("");}
    catch(error){setMessage((error as Error).message);}finally{setLoading(false);}},[assetId]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),30000);return()=>window.clearInterval(timer);},[load]);
  const assets=Array.isArray(data.assets)?data.assets:[];const probes=Array.isArray(data.shadowQuotes)?data.shadowQuotes:[];const certifications=Array.isArray(cert.certifications)?cert.certifications:[];const execution=data.execution||{};const sandboxGate=cert.gate||{};
  const selected=useMemo(()=>assets.find((item:Json)=>String(item.id)===assetId),[assets,assetId]);
  const validKg=Math.round(num(kg));const validVolume=Boolean(selected?.claimReady)&&validKg>=num(selected?.min_order_kg||1)&&validKg>0;const canQuote=Boolean(execution.configured)&&validVolume;const canCertify=Boolean(sandboxGate.ready)&&validVolume&&beneficiary.trim().length>=2;

  async function shadowQuote(){setBusy("quote");setMessage("");try{const result=await api<Json>("/admin/market/carbonmark/shadow-quote",{method:"POST",body:JSON.stringify({assetId:Number(assetId),requestedKg:validKg,createdBy:"Carbon Desk"})});setMessage(`Shadow quote ${result.quote_uuid} criada: ${money(result.cost_usdc)} USDC. Nenhum order foi criado.`);await load();}catch(error){setMessage((error as Error).message);}finally{setBusy("");}}
  async function certifySandbox(){setBusy("cert");setMessage("");try{const result=await api<Json>("/admin/market/carbonmark/sandbox-certification/run",{method:"POST",body:JSON.stringify({assetId:Number(assetId),requestedKg:validKg,beneficiaryName:beneficiary,retirementMessage:`EcoTracker sandbox certification · ${validKg} kg CO2e`,executedBy:"Carbon Desk"})});setMessage(result.certified?`SANDBOX CERTIFICADO: retirement ${result.retirement_id||result.provider_reference} concluído e evidências gravadas.`:`Sandbox order criado e ainda processando: ${result.provider_reference}.`);await load();}catch(error){setMessage((error as Error).message);}finally{setBusy("");}}

  return <section className="desk-card carbonmark-rail-panel">
    <header className="carbonmark-rail-head"><div><span>CARBONMARK RAIL · v18</span><h2>Shadow quote → sandbox certification → produção controlada</h2></div><div className={`rail-mode ${execution.live?"live":"blocked"}`}><b>{execution.live?"ORDER LIVE":"PRODUÇÃO BLOQUEADA"}</b><small>{execution.environment||"sandbox"} · API {data.provider?.stableApiVersion||"v18"}</small></div></header>
    <div className="rail-safety"><strong>AMBIENTES SEPARADOS</strong><span>Shadow quote nunca cria order. Sandbox Certification usa gate próprio e recusa execução se o ambiente não for <code>sandbox</code> ou se o gate live estiver armado.</span></div>
    <div className="rail-status-grid">
      <span><small>API key</small><b>{execution.configured?"configurada":"ausente"}</b></span><span><small>Prod flag</small><b>{execution.enabled?"ON":"OFF"}</b></span><span><small>Prod ACK</small><b>{execution.acknowledged?"OK":"DISABLED"}</b></span><span><small>Produção</small><b>{execution.live?"LIVE":"BLOCKED"}</b></span>
      <span><small>Sandbox flag</small><b>{sandboxGate.enabled?"ON":"OFF"}</b></span><span><small>Sandbox ACK</small><b>{sandboxGate.acknowledged?"OK":"DISABLED"}</b></span><span><small>Sandbox safe</small><b>{sandboxGate.ready?"ARMADO":"BLOCKED"}</b></span><span><small>Certificações</small><b>{cert.summary?.completed||0}</b></span>
    </div>
    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando Carbonmark Rail...</div>:<>
      <div className="shadow-quote-form">
        <label>Listing Carbonmark<select value={assetId} onChange={e=>setAssetId(e.target.value)}>{assets.map((item:Json)=><option key={item.id} value={item.id}>{item.project_name} · {item.registry} · {money(item.source_price_usd_ton)}/t · min {item.min_order_kg} kg</option>)}</select></label>
        <label>Quantidade kg<input type="number" min={selected?.min_order_kg||1} step="1" value={kg} onChange={e=>setKg(e.target.value)}/></label>
        <div className="shadow-preview"><small>Selecionado</small><b>{selected?.project_name||"—"}</b><span>{tons(validKg/1000)} t · source {selected?.assetPriceSourceId||"—"}</span></div>
        <button disabled={!canQuote||busy!==""} onClick={()=>void shadowQuote()}>{busy==="quote"?"Cotando...":"Executar shadow quote"}</button>
      </div>
      <div className="shadow-quote-form">
        <label>Beneficiário sandbox<input value={beneficiary} onChange={e=>setBeneficiary(e.target.value)}/></label>
        <div className="shadow-preview"><small>Sandbox E2E</small><b>{sandboxGate.ready?"Pronto para certificar":"Gate desarmado"}</b><span>quote → order → retirement → certificate → provenance</span></div>
        <button disabled={!canCertify||busy!==""} onClick={()=>void certifySandbox()}>{busy==="cert"?"Certificando...":"Certificar E2E sandbox"}</button>
      </div>
      {!execution.configured&&<div className="rail-blocker">Configure <b>CARBONMARK_API_KEY</b>. API key sozinha não habilita produção.</div>}
      {execution.configured&&!sandboxGate.ready&&<div className="rail-safe-ready">Para sandbox E2E: <b>CARBONMARK_SANDBOX_E2E_ENABLED=true</b> + ACK <b>ENABLE_SANDBOX_CARBONMARK_RETIREMENTS</b>. Produção continua separada.</div>}
      <div className="shadow-history"><h3>Certificações sandbox</h3>{certifications.slice(0,10).map((item:Json)=><article key={item.id}><div><b>{item.project_name}</b><small>{item.registry} · {item.status}</small></div><span><small>Volume</small><b>{tons(num(item.requested_kg)/1000)} t</b></span><span><small>Custo</small><b>{money(item.cost_usdc)}</b></span><code>{String(item.retirement_id||item.provider_reference||item.quote_uuid).slice(0,22)}…</code><em>SHA {String(item.certification_sha256).slice(0,10)}…</em></article>)}{!certifications.length&&<div className="desk-empty">Nenhuma certificação sandbox concluída ainda.</div>}</div>
      <div className="shadow-history"><h3>Últimas shadow quotes</h3>{probes.slice(0,10).map((probe:Json)=><article key={probe.id}><div><b>{probe.project_name}</b><small>{probe.registry} · {probe.source_reference}</small></div><span><small>Volume</small><b>{tons(num(probe.requested_kg)/1000)} t</b></span><span><small>Custo</small><b>{money(probe.cost_usdc)}</b></span><span><small>USDC/t</small><b>{money(probe.cost_usdc_tonne)}</b></span><code>{String(probe.quote_uuid).slice(0,18)}…</code><em>SHA {String(probe.probe_sha256).slice(0,10)}…</em></article>)}{!probes.length&&<div className="desk-empty">Nenhuma shadow quote auditada ainda.</div>}</div>
    </>}
  </section>;
}
