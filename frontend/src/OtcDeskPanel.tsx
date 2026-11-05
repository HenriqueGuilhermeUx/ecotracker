import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";

type Json=Record<string,any>;
const n=(v:unknown)=>{const x=Number(v||0);return Number.isFinite(x)?x:0};
const brl=(v:unknown)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(n(v));
const usd=(v:unknown)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"USD"}).format(n(v));

export function OtcDeskPanel({opportunityId}:{opportunityId:number}){
  const [request,setRequest]=useState<Json|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [projectName,setProjectName]=useState("");
  const [registry,setRegistry]=useState("");
  const [country,setCountry]=useState("");
  const [vintage,setVintage]=useState("");
  const [availableTonnes,setAvailableTonnes]=useState("");
  const [sourcePriceUsdTonne,setSourcePriceUsdTonne]=useState("");
  const [fxBrlUsd,setFxBrlUsd]=useState("");
  const [sellPriceBrlTonne,setSellPriceBrlTonne]=useState("");
  const [validityUntil,setValidityUntil]=useState("");

  async function load(){
    const list=await api<Json>(`/admin/deal-desk/otc?opportunityId=${opportunityId}`);
    const first=Array.isArray(list.items)?list.items[0]:null;
    if(!first){setRequest(null);return}
    setRequest(await api<Json>(`/admin/deal-desk/otc/${first.id}`));
  }

  useEffect(()=>{void load().catch(()=>setRequest(null))},[opportunityId]);

  async function openDesk(){
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/opportunities/${opportunityId}/otc`,{method:"POST",body:"{}"});
      setRequest(data);setMessage("Mesa OTC aberta. Nenhuma solicitação foi enviada ao parceiro automaticamente.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function copyPackage(){
    if(!request?.id)return;
    setBusy(true);setMessage("");
    try{
      const pack=await api<Json>(`/admin/deal-desk/otc/${request.id}/package`);
      const text=`${pack.subject}\n\n${pack.body}`;
      await navigator.clipboard.writeText(text);
      setMessage("RFQ copiado. O pacote não inclui identidade, e-mail ou CNPJ do cliente.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function setStatus(status:string){
    if(!request?.id)return;
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/otc/${request.id}/status`,{method:"POST",body:JSON.stringify({status})});
      setRequest(data);setMessage(`Mesa OTC atualizada: ${status}.`);
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function addOption(event:FormEvent){
    event.preventDefault();if(!request?.id)return;
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/otc/${request.id}/options`,{method:"POST",body:JSON.stringify({
        projectName,registry:registry||null,country:country||null,vintage:vintage||null,
        availableTonnes:Number(availableTonnes),sourcePriceUsdTonne:Number(sourcePriceUsdTonne),
        fxBrlUsd:fxBrlUsd?Number(fxBrlUsd):null,sellPriceBrlTonne:sellPriceBrlTonne?Number(sellPriceBrlTonne):null,
        validityUntil:validityUntil?new Date(validityUntil).toISOString():null,
        retirementSupported:true,beneficiarySupported:true,
      })});
      setRequest(data);setProjectName("");setRegistry("");setCountry("");setVintage("");setAvailableTonnes("");setSourcePriceUsdTonne("");setSellPriceBrlTonne("");setValidityUntil("");
      setMessage("Opção OTC registrada. Nenhum dado foi enviado ao cliente.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function setOptionStatus(optionId:number,status:string){
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/otc/options/${optionId}/status`,{method:"POST",body:JSON.stringify({status})});
      setRequest(data);setMessage(status==="selected"?"Opção selecionada. ERPA passa a ser o próximo gate.":"Opção atualizada.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  const options:Array<Json>=Array.isArray(request?.options)?request.options:[];
  return <section className="deal-otc">
    <div className="deal-otc-head">
      <div><small>MESA OTC · ADMIN</small><h3>Liquidez para grandes demandas</h3><p>Use quando o catálogo/matching não for suficiente ou quando a operação exigir RFP, tender ou portfólio dedicado.</p></div>
      {!request&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void openDesk()}>{busy?"Abrindo...":"Abrir Mesa OTC"}</button>}
    </div>
    {message&&<div className="deal-otc-message">{message}</div>}
    {!request?<div className="deal-otc-empty">Nenhum pedido OTC interno para esta oportunidade.</div>:<>
      <div className="deal-otc-state">
        <span><small>Status</small><b>{String(request.status||"").replaceAll("_"," ")}</b></span>
        <span><small>Volume</small><b>{n(request.requested_tonnes).toLocaleString("pt-BR",{maximumFractionDigits:3})} t</b></span>
        <span><small>Parceiro</small><b>Infra de liquidez</b></span>
        <span><small>Cliente no RFQ</small><b>NÃO EXPOSTO</b></span>
      </div>
      <div className="deal-otc-actions">
        <button type="button" className="deal-secondary" disabled={busy} onClick={()=>void copyPackage()}>Copiar RFQ protegido</button>
        {request.status==="ready_to_send"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setStatus("sent")}>Marcar como enviado</button>}
        {request.status==="erpa_pending"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setStatus("erpa_signed")}>Marcar ERPA assinado</button>}
        {request.status==="erpa_signed"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setStatus("funding_pending")}>Aguardar funding</button>}
        {request.status==="funding_pending"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setStatus("paid")}>Marcar parceiro pago</button>}
        {request.status==="paid"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setStatus("delivered")}>Marcar créditos entregues</button>}
        {request.status==="delivered"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setStatus("retired")}>Marcar retirement concluído</button>}
      </div>

      <div className="deal-otc-divider">OPÇÕES RECEBIDAS</div>
      {options.length===0&&<div className="deal-otc-empty">Registre aqui as opções recebidas do desk de liquidez. Elas permanecem internas até a proposta EcoTracker ser aprovada.</div>}
      {options.map(option=><article className="deal-otc-option" key={option.id}>
        <div><small>{option.registry||"Registry em validação"} · {option.country||"região aberta"}</small><b>{option.project_name}</b><span>Vintage {option.vintage||"flexível"} · {n(option.available_tonnes).toLocaleString("pt-BR",{maximumFractionDigits:3})} t disponíveis</span></div>
        <div className="deal-otc-pricing">
          <span><small>Custo fonte</small><b>{usd(option.source_price_usd_tonne)}/t</b></span>
          <span><small>Preço EcoTracker</small><b>{option.sell_price_brl_tonne?brl(option.sell_price_brl_tonne)+"/t":"a definir"}</b></span>
          <span><small>Margem</small><b>{option.margin_pct==null?"a definir":`${n(option.margin_pct).toFixed(1)}%`}</b></span>
        </div>
        <div className="deal-otc-option-actions">
          {option.status!=="selected"&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void setOptionStatus(Number(option.id),"shortlisted")}>Shortlist</button>}
          {option.status!=="selected"&&<button type="button" className="deal-primary" disabled={busy} onClick={()=>void setOptionStatus(Number(option.id),"selected")}>Selecionar / iniciar ERPA</button>}
          <span>{String(option.status||"").toUpperCase()}</span>
        </div>
      </article>)}

      <form className="deal-otc-form" onSubmit={addOption}>
        <div className="deal-otc-divider">REGISTRAR OPÇÃO DO DESK</div>
        <div className="deal-two"><label>Projeto<input required value={projectName} onChange={e=>setProjectName(e.target.value)} placeholder="Projeto / portfolio option"/></label><label>Registry<input value={registry} onChange={e=>setRegistry(e.target.value)} placeholder="Verra, Gold Standard..."/></label></div>
        <div className="deal-two"><label>País<input value={country} onChange={e=>setCountry(e.target.value)} placeholder="Brasil / outro"/></label><label>Vintage<input value={vintage} onChange={e=>setVintage(e.target.value)} placeholder="2024"/></label></div>
        <div className="deal-two"><label>Volume disponível t<input required type="number" min="0.001" step="0.001" value={availableTonnes} onChange={e=>setAvailableTonnes(e.target.value)}/></label><label>Custo fonte US$/t<input required type="number" min="0" step="0.01" value={sourcePriceUsdTonne} onChange={e=>setSourcePriceUsdTonne(e.target.value)}/></label></div>
        <div className="deal-two"><label>FX BRL/USD<input type="number" min="0.01" step="0.0001" value={fxBrlUsd} onChange={e=>setFxBrlUsd(e.target.value)} placeholder="opcional"/></label><label>Preço EcoTracker R$/t<input type="number" min="0.01" step="0.01" value={sellPriceBrlTonne} onChange={e=>setSellPriceBrlTonne(e.target.value)} placeholder="opcional"/></label></div>
        <label>Validade da opção<input type="datetime-local" value={validityUntil} onChange={e=>setValidityUntil(e.target.value)}/></label>
        <button className="deal-secondary" disabled={busy}>{busy?"Salvando...":"Registrar opção OTC"}</button>
      </form>
      <small className="deal-otc-footnote">Safe mode: criar RFQ, registrar opção, selecionar projeto ou avançar status não compra créditos, não cobra o cliente e não executa retirement automaticamente.</small>
    </>}
  </section>;
}
