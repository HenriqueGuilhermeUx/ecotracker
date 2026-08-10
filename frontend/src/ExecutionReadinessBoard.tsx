import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./execution-readiness.css";

type Json=Record<string,any>;
const statusLabel=(value:unknown)=>String(value||"unknown").replaceAll("_"," ");
const shortSha=(value:unknown)=>String(value||"").slice(0,12);
const dateTime=(value:unknown)=>value?new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(String(value))):"—";

export function ExecutionReadinessBoard(){
  const [environment,setEnvironment]=useState<Json>({});
  const [items,setItems]=useState<Json[]>([]);
  const [reviews,setReviews]=useState<Json[]>([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    try{
      const [envData,queueData,reviewData]=await Promise.all([
        api<Json>("/admin/execution-readiness/status"),
        api<Json>("/admin/execution-readiness/queue?limit=100"),
        api<Json>("/admin/execution-readiness/reviews?limit=100"),
      ]);
      setEnvironment(envData||{});
      setItems(Array.isArray(queueData?.items)?queueData.items:[]);
      setReviews(Array.isArray(reviewData?.items)?reviewData.items:[]);
      setMessage("");
    }catch(error){setMessage((error as Error).message);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();},[load]);

  async function act(key:string,fn:()=>Promise<unknown>,success:string){
    setBusy(key);setMessage("");
    try{await fn();setMessage(success);await load();}
    catch(error){setMessage((error as Error).message);}
    finally{setBusy("");}
  }

  const claimReady=useMemo(()=>items.filter((item)=>item.claim_category==="voluntary_offset"&&item.eligibility_status==="eligible"),[items]);
  const active=useMemo(()=>items.filter((item)=>item.authorization_status==="active"&&item.sourcing_executable),[items]);
  const pending=useMemo(()=>reviews.filter((review)=>review.status==="pending"),[reviews]);

  return <section className="desk-card execution-readiness-board" id="execution-readiness-board">
    <header className="execution-head">
      <div><span>EXECUTION READINESS GATE</span><h2>Claim-ready → execução programática</h2></div>
      <div className="execution-counts"><b>{claimReady.length} claim-ready</b><b>{pending.length} reviews pendentes</b><b>{active.length} execution-ready</b></div>
    </header>

    <div className="execution-integrity"><strong>CLAIM-READY ≠ EXECUTION-READY</strong><span>Climate eligibility autoriza a alegação climática. Execução programática exige outro gate: adapters saudáveis, dry-run sem efeitos colaterais, mandato/inventory e autorização com TTL.</span></div>

    <div className="execution-env">
      <EnvGate title="Source executor" configured={Boolean(environment?.source?.configured)} endpoint={environment?.source?.base}/>
      <EnvGate title="Source health" configured={Boolean(environment?.source?.health)} endpoint={environment?.source?.health}/>
      <EnvGate title="Source dry-run" configured={Boolean(environment?.source?.dryRun)} endpoint={environment?.source?.dryRun}/>
      <EnvGate title="Retirement executor" configured={Boolean(environment?.retirement?.configured)} endpoint={environment?.retirement?.base}/>
      <EnvGate title="Retirement health" configured={Boolean(environment?.retirement?.health)} endpoint={environment?.retirement?.health}/>
      <EnvGate title="Retirement dry-run" configured={Boolean(environment?.retirement?.dryRun)} endpoint={environment?.retirement?.dryRun}/>
    </div>
    <div className="execution-fingerprint"><small>Config fingerprint</small><code>{shortSha(environment?.configFingerprint)}…</code><span>Tokens não são exibidos nem persistidos.</span></div>

    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando Execution Readiness...</div>:<div className="execution-grid">
      {items.map((item)=><ExecutionAssetCard key={item.asset_id} item={item} busy={busy} act={act}/>)}
      {!items.length&&<div className="desk-empty">Nenhum ativo supply-intake convertido.</div>}
    </div>}

    {reviews.some((review)=>review.status!=="pending")&&<div className="execution-ledger-section"><h3>Decisões recentes</h3><div className="execution-ledger">
      {reviews.filter((review)=>review.status!=="pending").slice(0,20).map((review)=><article key={review.id}>
        <div><b>{review.project_name||`Ativo #${review.asset_id}`}</b><small>review v{review.review_version}</small></div>
        <span className={`execution-pill ${review.status}`}>{statusLabel(review.status)}</span>
        <div><small>proposed</small><code>{shortSha(review.proposed_sha256)}…</code></div>
        <div><small>applied</small><code>{review.applied_sha256?`${shortSha(review.applied_sha256)}…`:"—"}</code></div>
        <div><small>autorização</small><b>{statusLabel(review.authorization_status||"none")}</b><small>{review.valid_until?`até ${dateTime(review.valid_until)}`:""}</small></div>
      </article>)}
    </div></div>}
  </section>;
}

function ExecutionAssetCard({item,busy,act}:{item:Json;busy:string;act:(key:string,fn:()=>Promise<unknown>,success:string)=>Promise<void>}){
  const [settlement,setSettlement]=useState("supplier_invoice");
  const [proofSla,setProofSla]=useState("24");
  const [ttl,setTtl]=useState("24");
  const [note,setNote]=useState("Execution Readiness revisada pela Carbon Desk.");
  const [rejectReason,setRejectReason]=useState("Execution Readiness rejeitada pela Carbon Desk.");
  const climateReady=item.claim_category==="voluntary_offset"&&item.eligibility_status==="eligible";
  const authActive=item.authorization_status==="active"&&item.sourcing_executable===true;
  const pendingId=Number(item.pending_review_id||0);
  const preview=item.pending_preview||{};

  async function createReview(){
    await act(`create-exec-${item.asset_id}`,()=>api(`/admin/market/assets/${item.asset_id}/execution-reviews`,{
      method:"POST",body:JSON.stringify({supplierSettlementMode:settlement,proofSlaHours:Number(proofSla),authorizationTtlHours:Number(ttl),note,actor:"Carbon Desk"}),
    }),"Execution Readiness Review criada. Os probes foram executados; aprove somente se o preview estiver verde.");
  }

  return <article className={`execution-card ${authActive?"active":climateReady?"claim-ready":"restricted"}`}>
    <div className="execution-card-head"><div><b>{item.project_name}</b><small>{item.registry} · {item.supplier_name||"supplier"} · ativo #{item.asset_id}</small></div>
      <span className={`execution-pill ${authActive?"approved":climateReady?"pending":"restricted"}`}>{authActive?"execution-ready":climateReady?"claim-ready":"climate blocked"}</span></div>

    <div className="execution-stages">
      <Stage label="Climate" ok={climateReady} value={`${statusLabel(item.claim_category)} · ${statusLabel(item.eligibility_status)}`}/>
      <Stage label="Mandato" ok={Boolean(item.mandate_id)} value={item.mandate_id?`#${item.mandate_id}`:"ausente"}/>
      <Stage label="Inventory" ok={Boolean(item.inventory_id)} value={item.inventory_id?`#${item.inventory_id}`:"ausente"}/>
      <Stage label="Execution" ok={authActive} value={authActive?`ativa até ${dateTime(item.valid_until)}`:"manual / assistida"}/>
    </div>

    {authActive?<div className="execution-active-box"><strong>PROGRAMMATIC EXECUTION AUTORIZADA</strong><span>TTL até {dateTime(item.valid_until)}. Mudança de URL/token ou expiração revoga esta autorização.</span><button disabled={!!busy} onClick={()=>void act(`revoke-${item.asset_id}`,()=>api(`/admin/market/assets/${item.asset_id}/execution-revoke`,{method:"POST",body:JSON.stringify({reason:"Revogada manualmente pela Carbon Desk",revokedBy:"Carbon Desk"})}),"Autorização de execução revogada.")}>Revogar execução</button></div>:
    pendingId?<div className={`execution-preview ${preview.ready?"ready":"blocked"}`}>
      <strong>{preview.ready?"PREVIEW: READY":"PREVIEW: BLOCKED"}</strong>
      <div className="execution-probe-grid">
        <Stage label="Climate ledger" ok={Boolean(preview.climateLedgerReady)} value={preview.climateLedgerReady?"ok":"ausente"}/>
        <Stage label="Mandato" ok={Boolean(preview.mandateActive)} value={preview.mandateActive?"ativo":"bloqueado"}/>
        <Stage label="Inventory" ok={Boolean(preview.inventoryReady)} value={preview.inventoryReady?"disponível":"bloqueado"}/>
        <Stage label="Source adapter" ok={Boolean(preview.sourceAdapterReady)} value={preview.sourceAdapterReady?"health + dry-run ok":"não pronto"}/>
        <Stage label="Retirement" ok={Boolean(preview.retirementAdapterReady)} value={preview.retirementAdapterReady?"health + dry-run ok":"não pronto"}/>
      </div>
      {Array.isArray(preview.reasons)&&preview.reasons.length>0&&<div className="execution-reasons">{preview.reasons.map((reason:string)=><span key={reason}>{statusLabel(reason)}</span>)}</div>}
      <div className="execution-actions"><button className="reject" disabled={!!busy} onClick={()=>void act(`reject-exec-${pendingId}`,()=>api(`/admin/execution-readiness/reviews/${pendingId}/reject`,{method:"POST",body:JSON.stringify({reason:rejectReason,reviewedBy:"Carbon Desk"})}),"Execution Readiness rejeitada.")}>Rejeitar</button>
        <button disabled={!!busy||!preview.ready} onClick={()=>void act(`approve-exec-${pendingId}`,()=>api(`/admin/execution-readiness/reviews/${pendingId}/approve`,{method:"POST",body:JSON.stringify({reviewedBy:"Carbon Desk",note:"Health, dry-run, supply e climate gates conferidos."})}),"Execução programática autorizada com TTL.")}>{busy===`approve-exec-${pendingId}`?"Autorizando...":"Autorizar execução"}</button></div>
      <details><summary>Motivo de rejeição</summary><textarea value={rejectReason} onChange={(e)=>setRejectReason(e.target.value)}/></details>
    </div>:
    <div className="execution-review-form">
      <label>Settlement<select value={settlement} onChange={(e)=>setSettlement(e.target.value)}><option value="supplier_invoice">supplier invoice</option><option value="prepaid">prepaid</option><option value="postpaid">postpaid</option><option value="manual_contract">manual contract</option></select></label>
      <label>Proof SLA horas<input type="number" min="1" max="720" value={proofSla} onChange={(e)=>setProofSla(e.target.value)}/></label>
      <label>TTL autorização horas<input type="number" min="1" max="168" value={ttl} onChange={(e)=>setTtl(e.target.value)}/></label>
      <label className="execution-note">Nota<textarea value={note} onChange={(e)=>setNote(e.target.value)}/></label>
      <button disabled={!!busy||!climateReady} onClick={()=>void createReview()}>{busy===`create-exec-${item.asset_id}`?"Executando probes...":"Criar review + rodar dry-runs"}</button>
      {!climateReady&&<small>Climate eligibility precisa ser aprovada antes desta etapa.</small>}
    </div>}
  </article>;
}

function Stage({label,value,ok}:{label:string;value:string;ok:boolean}){return <div className={`execution-stage ${ok?"ok":""}`}><span className="execution-dot"/><div><small>{label}</small><b>{value}</b></div></div>;}
function EnvGate({title,configured,endpoint}:{title:string;configured:boolean;endpoint?:string|null}){return <div className={configured?"configured":"missing"}><span/><div><b>{title}</b><small>{configured?(endpoint||"configurado"):"aguardando configuração"}</small></div></div>;}
