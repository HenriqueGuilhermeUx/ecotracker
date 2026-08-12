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
  const load=useCallback(async()=>{try{const [rail,certification]=await Promise.all([api<Json>("/admin/market/carbonmark/control"),api<Json>("/admin/market/carbonmark/sandbox-certification")]);setData(rail);setCert(certification);if(!assetId&&rail.assets?.[0]?.id)setAssetId(String(rail.assets[0].id));}
    catch(error){setMessage((error as Error).message);}finally{setLoading(false);}},[assetId]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),30000);return()=>window.clearInterval(timer);},[load]);
  const assets=Array.isArray(data.assets)?data.assets:[];const probes=Array.isArray(data.shadowQuotes)?data.shadowQuotes:[];const certifications=Array.isArray(cert.certifications)?cert.certifications:[];const execution=data.execution||{};const sandboxGate=cert.gate||{};
  const selected=useMemo(()=>assets.find((item:Json)=>String(item.id)===assetId),[assets,assetId]);
  const validKg=Math.round(num(kg));
  const quoteVolume=Boolean(selected)&&validKg>=num(selected?.min_order_kg||1)&&validKg>0;
  const certificationMode=selected?.claimReady?"claim_ready":"technical_probe";
  const technicalMaxKg=Math.max(1,num(sandboxGate.technicalMaxKg||1));
  const certifyVolume=quoteVolume&&(certificationMode==="claim_ready"||validKg<=technicalMaxKg);
  const canQuote=Boolean(execution.configured)&&quoteVolume;
  const canCertify=Boolean(sandboxGate.ready)&&certifyVolume&&beneficiary.trim().length>=2;

  async function shadowQuote(){
    setBusy("quote");setMessage("");
    try{
      const result=await api<Json>("/admin/market/carbonmark/shadow-quote",{method:"POST",body:JSON.stringify({assetId:Number(assetId),requestedKg:validKg,createdBy:"Carbon Desk"})});
      await load();
      setMessage(`Shadow quote ${result.quote_uuid} criada: ${money(result.cost_usdc)} USDC. Nenhum order foi criado.`);
    }catch(error){setMessage((error as Error).message);}finally{setBusy("");}
  }
  async function certifySandbox(){
    setBusy("cert");setMessage("");
    try{
      const technical=certificationMode==="technical_probe";
      const result=await api<Json>("/admin/market/carbonmark/sandbox-certification/run",{method:"POST",body:JSON.stringify({
        assetId:Number(assetId),requestedKg:validKg,beneficiaryName:technical?"EcoTracker Sandbox Technical Certification":beneficiary,
        retirementMessage:technical?`EcoTracker technical sandbox rail test · ${validKg} kg CO2e · NO CLIMATE CLAIM`:`EcoTracker sandbox certification · ${validKg} kg CO2e`,
        certificationMode,executedBy:"Carbon Desk",
      })});
      await load();
      setMessage(result.certified
        ? technical
          ? `RAIL TÉCNICA CERTIFICADA: retirement sandbox ${result.retirement_id||result.provider_reference} concluído. Nenhum claim climático foi aprovado.`
          : `SANDBOX CERTIFICADO: retirement ${result.retirement_id||result.provider_reference} concluído e evidências gravadas.`
        : `Sandbox order criado e ainda processando: ${result.provider_reference}.`);
    }catch(error){setMessage((error as Error).message);}finally{setBusy("");}
  }

  return <section className="desk-card carbonmark-rail-panel">
    <header className="carbonmark-rail-head"><div><span>CARBONMARK RAIL · v18</span><h2>Shadow quote → sandbox certification → produção controlada</h2></div><div className={`rail-mode ${execution.live?"live":"blocked"}`}><b>{execution.live?"ORDER LIVE":"PRODUÇÃO BLOQUEADA"}</b><small>{execution.environment||"sandbox"} · API {data.provider?.stableApiVersion||"v18"}</small></div></header>
    <div className="rail-safety"><strong>AMBIENTES SEPARADOS</strong><span>Shadow quote nunca cria order. O sandbox pode provar a rail tecnicamente sem transformar um listing restrito em <code>claim-ready</code>; execução comercial continua exigindo elegibilidade aprovada e gate de produção separado.</span></div>
    <div className="rail-status-grid">
      <span><small>API key</small><b>{execution.configured?"configurada":"ausente"}</b></span><span><small>Prod flag</small><b>{execution.enabled?"ON":"OFF"}</b></span><span><small>Prod ACK</small><b>{execution.acknowledged?"OK":"DISABLED"}</b></span><span><small>Produção</small><b>{execution.live?"LIVE":"BLOCKED"}</b></span>
      <span><small>Sandbox flag</small><b>{sandboxGate.enabled?"ON":"OFF"}</b></span><span><small>Sandbox ACK</small><b>{sandboxGate.acknowledged?"OK":"DISABLED"}</b></span><span><small>Sandbox safe</small><b>{sandboxGate.ready?"ARMADO":"BLOCKED"}</b></span><span><small>Certificações</small><b>{cert.summary?.completed||0}</b></span>
    </div>
    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando Carbonmark Rail...</div>:<>
      <div className="shadow-quote-form">
        <label>Listing Carbonmark<select value={assetId} onChange={e=>setAssetId(e.target.value)}>{assets.map((item:Json)=><option key={item.id} value={item.id}>{item.project_name} · {item.registry} · {money(item.source_price_usd_ton)}/t · min {item.min_order_kg} kg</option>)}</select></label>
        <label>Quantidade kg<input type="number" min={selected?.min_order_kg||1} step="1" value={kg} onChange={e=>setKg(e.target.value)}/></label>
        <div className="shadow-preview"><small>Selecionado</small><b>{selected?.project_name||"—"}</b><span>{tons(validKg/1000)} t · source {selected?.assetPriceSourceId||"—"}</span>{selected&&!selected.claimReady&&<span>Cotação permitida · order comercial continua bloqueado por elegibilidade.</span>}</div>
        <button disabled={!canQuote||busy!==""} onClick={()=>void shadowQuote()}>{busy==="quote"?"Cotando...":"Executar shadow quote"}</button>
      </div>
      <div className="shadow-quote-form">
        <label>Beneficiário sandbox<input value={beneficiary} onChange={e=>setBeneficiary(e.target.value)} disabled={certificationMode==="technical_probe"}/></label>
        <div className="shadow-preview"><small>Sandbox E2E</small><b>{sandboxGate.ready?(certificationMode==="claim_ready"?"Claim-ready: pronto para certificar":`Prova técnica: máximo ${technicalMaxKg} kg`):"Gate desarmado"}</b><span>quote → order → retirement → certificate → provenance</span>{certificationMode==="technical_probe"&&<span>NO CLIMATE CLAIM · elegibilidade permanece inalterada.</span>}</div>
        <button disabled={!canCertify||busy!==""} onClick={()=>void certifySandbox()}>{busy==="cert"?"Certificando...":certificationMode==="technical_probe"?"Certificar rail técnica (sandbox)":"Certificar E2E sandbox"}</button>
      </div>
      {certificationMode==="technical_probe"&&validKg>technicalMaxKg&&<div className="rail-blocker">Prova técnica de listing não claim-ready limitada a <b>{technicalMaxKg} kg</b>. Reduza a quantidade; isso não altera a elegibilidade do ativo.</div>}
      {!execution.configured&&<div className="rail-blocker">Configure <b>CARBONMARK_API_KEY</b>. API key sozinha não habilita produção.</div>}
      {execution.configured&&!sandboxGate.ready&&<div className="rail-safe-ready">Para sandbox E2E: <b>CARBONMARK_SANDBOX_E2E_ENABLED=true</b> + ACK <b>ENABLE_SANDBOX_CARBONMARK_RETIREMENTS</b>. Produção continua separada.</div>}
      <div className="shadow-history"><h3>Certificações sandbox</h3>{certifications.slice(0,10).map((item:Json)=><article key={item.id}><div><b>{item.project_name}</b><small>{item.registry} · {item.status} · {item.certification_mode==="technical_probe"?"prova técnica":"claim-ready"}</small></div><span><small>Volume</small><b>{tons(num(item.requested_kg)/1000)} t</b></span><span><small>Custo</small><b>{money(item.cost_usdc)}</b></span><code>{String(item.retirement_id||item.provider_reference||item.quote_uuid).slice(0,22)}…</code><em>SHA {String(item.certification_sha256).slice(0,10)}…</em></article>)}{!certifications.length&&<div className="desk-empty">Nenhuma certificação sandbox concluída ainda.</div>}</div>
      <div className="shadow-history"><h3>Últimas shadow quotes</h3>{probes.slice(0,10).map((probe:Json)=><article key={probe.id}><div><b>{probe.project_name}</b><small>{probe.registry} · {probe.source_reference}</small></div><span><small>Volume</small><b>{tons(num(probe.requested_kg)/1000)} t</b></span><span><small>Custo</small><b>{money(probe.cost_usdc)}</b></span><span><small>USDC/t</small><b>{money(probe.cost_usdc_tonne)}</b></span><code>{String(probe.quote_uuid).slice(0,18)}…</code><em>SHA {String(probe.probe_sha256).slice(0,10)}…</em></article>)}{!probes.length&&<div className="desk-empty">Nenhuma shadow quote auditada ainda.</div>}</div>
    </>}
  </section>;
}
