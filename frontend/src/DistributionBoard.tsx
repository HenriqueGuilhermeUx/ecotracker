import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./distribution-board.css";

type Json=Record<string,any>;
type Channel="carbonmark"|"regen"|"otc"|"direct"|"toucan"|"other";
const channels:Channel[]=["carbonmark","regen","otc","direct","toucan","other"];
const num=(value:unknown)=>{const parsed=Number(value||0);return Number.isFinite(parsed)?parsed:0;};
const tons=(value:unknown)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));
const usd=(value:unknown)=>value?new Intl.NumberFormat("pt-BR",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(num(value)):"—";
const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");

export function DistributionBoard(){
  const [items,setItems]=useState<Json[]>([]);const [caps,setCaps]=useState<Json>({});const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState("");const [message,setMessage]=useState("");
  const load=useCallback(async()=>{try{const data=await api<Json>("/admin/distribution/desk");setItems(Array.isArray(data?.items)?data.items:[]);setCaps(data?.channelCapabilities||{});}
    catch(error){setMessage((error as Error).message);}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),20000);return()=>window.clearInterval(timer);},[load]);
  async function act(key:string,fn:()=>Promise<any>,success:string){setBusy(key);setMessage("");try{await fn();setMessage(success);await load();}catch(error){setMessage((error as Error).message);}finally{setBusy("");}}

  const ready=useMemo(()=>items.filter(item=>item.claimReady),[items]);
  const globalAvailable=useMemo(()=>ready.reduce((sum,item)=>sum+num(item.available_tonnes),0),[ready]);
  const activeListings=useMemo(()=>items.flatMap(item=>item.listings||[]).filter((listing:Json)=>listing.status==="active").length,[items]);
  const activeReservations=useMemo(()=>items.flatMap(item=>item.reservations||[]).length,[items]);

  return <section className="desk-card distribution-board">
    <header className="distribution-head"><div><span>DISTRIBUTION ORCHESTRATOR</span><h2>Claim-ready → Carbonmark / Regen / OTC</h2></div>
      <div className="distribution-kpis"><b>{ready.length} lotes claim-ready</b><b>{tons(globalAvailable)} t globais</b><b>{activeListings} canais ativos</b><b>{activeReservations} reservas</b></div></header>
    <div className="distribution-integrity"><strong>EXPOSIÇÃO MULTICANAL ≠ ESTOQUE MULTIPLICADO</strong><span>30.000 t anunciadas em Carbonmark, Regen e OTC continuam sendo 30.000 t econômicas — não 90.000. Toda reserva debita o saldo global único do Supply Desk.</span></div>
    <div className="distribution-execution-warning"><b>PUBLICAR ≠ EXECUTAR</b><span>O Orchestrator v1 prepara e confirma exposição. Nenhum canal externo é marcado como publicação automática e eligibility não liga retirement programático.</span></div>
    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando Distribution Desk...</div>:<div className="distribution-grid">
      {items.map(item=><InventoryDistributionCard key={item.id} item={item} caps={caps} busy={busy} act={act}/>) }
      {!items.length&&<div className="desk-empty">Nenhum inventário de Supply convertido ainda.</div>}
    </div>}
  </section>;
}

function InventoryDistributionCard({item,caps,busy,act}:{item:Json;caps:Json;busy:string;act:(key:string,fn:()=>Promise<any>,success:string)=>Promise<void>}){
  const [amendOpen,setAmendOpen]=useState(false);const [planOpen,setPlanOpen]=useState(false);
  const [amendChannels,setAmendChannels]=useState<Channel[]>(Array.isArray(item.allowedChannels)?item.allowedChannels:[]);
  const [evidence,setEvidence]=useState("");const [note,setNote]=useState("");
  const [planChannels,setPlanChannels]=useState<Channel[]>([]);const [markup,setMarkup]=useState("15");const [ask,setAsk]=useState("");
  const [activation,setActivation]=useState<Record<string,{id:string;url:string}>>({});
  const listings=Array.isArray(item.listings)?item.listings:[];const allowed=(Array.isArray(item.allowedChannels)?item.allowedChannels:[]) as Channel[];
  const unavailable=channels.filter(channel=>!allowed.includes(channel));
  const toggle=(list:Channel[],set:(value:Channel[])=>void,channel:Channel)=>set(list.includes(channel)?list.filter(v=>v!==channel):[...list,channel]);

  return <article className={`distribution-card ${item.claimReady?"ready":"restricted"}`}>
    <div className="distribution-card-head"><div><b>{item.project_name||item.registry_project_id}</b><small>{item.registry} · {item.supplier_name}</small></div>
      <span className={`distribution-state ${item.claimReady?"positive":"warning"}`}>{item.claimReady?"claim-ready":label(item.asset?.eligibility_status||"restricted")}</span></div>

    <div className="inventory-ledger">
      <span><small>Autorizado</small><b>{tons(item.authorized_tonnes)} t</b></span><span><small>Vendido</small><b>{tons(item.sold_tonnes)} t</b></span>
      <span><small>Reservado</small><b>{tons(item.reserved_tonnes)} t</b></span><span className="available"><small>Disponível global</small><b>{tons(item.available_tonnes)} t</b></span>
    </div>
    <div className="distribution-meta"><span>Floor <b>{usd(item.floor_price_usd_tonne)}/t</b></span><span>Mandato <b>#{item.mandate_id}</b></span><span>Asset <b>#{item.monitored_asset_id||"—"}</b></span><span>Execução <b>{item.asset?.sourcing_executable?"programática":"manual/assistida"}</b></span></div>

    <div className="allowed-channels"><small>Canais autorizados no mandato</small><div>{allowed.map(channel=><span key={channel}>{channel}</span>)}{!allowed.length&&<i>nenhum</i>}</div></div>
    {unavailable.length>0&&<button className="mini-button" onClick={()=>setAmendOpen(!amendOpen)}>{amendOpen?"Fechar amendment":"Autorizar novos canais"}</button>}
    {amendOpen&&<div className="distribution-form amendment">
      <div className="channel-selector">{channels.map(channel=><label key={channel}><input type="checkbox" checked={amendChannels.includes(channel)} onChange={()=>toggle(amendChannels,setAmendChannels,channel)}/>{channel}</label>)}</div>
      <label>Evidência da autorização<input type="url" value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="https://..."/></label>
      <label>Nota contratual/comercial<textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Fornecedor autorizou distribuição não exclusiva..."/></label>
      <button disabled={!!busy||amendChannels.length===0||!evidence||note.trim().length<20} onClick={()=>void act(`amend-${item.mandate_id}`,()=>api(`/admin/distribution/mandates/${item.mandate_id}/channels`,{method:"POST",body:JSON.stringify({allowedChannels:amendChannels,evidenceUrl:evidence,note,amendedBy:"Carbon Desk"})}),"Canais do mandato atualizados com trilha SHA-256.")}>{busy===`amend-${item.mandate_id}`?"Salvando...":"Salvar autorização de canais"}</button>
    </div>}

    {item.claimReady&&num(item.available_tonnes)>0&&<button className="mini-button plan" onClick={()=>setPlanOpen(!planOpen)}>{planOpen?"Fechar plano":"Planejar distribuição"}</button>}
    {planOpen&&<div className="distribution-form plan-form">
      <div className="channel-selector">{allowed.map((channel:Channel)=><label key={channel}><input type="checkbox" checked={planChannels.includes(channel)} onChange={()=>toggle(planChannels,setPlanChannels,channel)}/>{channel}</label>)}</div>
      <label>Markup %<input type="number" min="0" max="500" value={markup} onChange={e=>setMarkup(e.target.value)}/></label>
      <label>Ask US$/t opcional<input type="number" min="0" step="0.01" value={ask} onChange={e=>setAsk(e.target.value)} placeholder="usa floor + markup"/></label>
      <button disabled={!!busy||!planChannels.length} onClick={()=>void act(`plan-${item.id}`,()=>api(`/admin/distribution/inventory/${item.id}/plan`,{method:"POST",body:JSON.stringify({channels:planChannels,markupPct:num(markup),askPriceUsdTonne:ask?num(ask):null,preparedBy:"Carbon Desk"})}),`Plano multicanal criado sobre ${tons(item.available_tonnes)} t de saldo global.`)}>{busy===`plan-${item.id}`?"Planejando...":"Criar plano multicanal"}</button>
    </div>}

    {listings.length>0&&<div className="channel-listings"><h4>Canais</h4>{listings.map((listing:Json)=>{
      const channel=listing.channel as Channel;const external=Boolean(caps?.[channel]?.externalConfirmationRequired);const values=activation[channel]||{id:"",url:""};
      return <div className="channel-row" key={listing.id}><div className="channel-row-main"><b>{channel}</b><span>{tons(listing.advertised_tonnes)} t expostas</span><span>{usd(listing.ask_price_usd_tonne)}/t</span><em className={listing.status}>{listing.status}</em></div>
        {listing.status!=="active"&&<div className="channel-activate">{external&&<><input placeholder="External listing ID" value={values.id} onChange={e=>setActivation({...activation,[channel]:{...values,id:e.target.value}})}/><input placeholder="https://listing..." value={values.url} onChange={e=>setActivation({...activation,[channel]:{...values,url:e.target.value}})}/></>}
          <button disabled={!!busy||(external&&!values.id&&!values.url)} onClick={()=>void act(`activate-${item.id}-${channel}`,()=>api(`/admin/distribution/inventory/${item.id}/channels/${channel}/activate`,{method:"POST",body:JSON.stringify({externalListingId:values.id||null,externalUrl:values.url||null,actor:"Carbon Desk"})}),`${channel} marcado como exposição ativa.`)}>{busy===`activate-${item.id}-${channel}`?"Ativando...":"Confirmar exposição"}</button></div>}
        <small>{caps?.[channel]?.automaticPublish?"publicação automática":"publicação automática: NÃO"} · {caps?.[channel]?.publishMode||"manual"}</small>
      </div>;})}</div>}

    {Array.isArray(item.reservations)&&item.reservations.length>0&&<div className="distribution-reservations"><h4>Reservas globais ativas</h4>{item.reservations.map((r:Json)=><span key={r.id}><b>{r.channel}</b> {tons(r.reserved_tonnes)} t · {r.external_order_id||r.public_code}</span>)}</div>}
  </article>;
}
