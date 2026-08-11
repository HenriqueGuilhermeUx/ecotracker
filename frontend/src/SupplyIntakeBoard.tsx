import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { SupplyEligibilityQueue } from "./SupplyEligibilityQueue";
import { ExecutionReadinessBoard } from "./ExecutionReadinessBoard";
import { DistributionBoard } from "./DistributionBoard";
import "./supply-intake.css";

type Json = Record<string, any>;

const num = (value:unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tons = (value:unknown) => new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));
const statusLabel = (value:unknown) => String(value || "unknown").replaceAll("_"," ");

export function SupplyIntakeBoard() {
  const [intakes,setIntakes]=useState<Json[]>([]);
  const [selections,setSelections]=useState<Json[]>([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    try {
      const [intakeData,selectionData]=await Promise.all([
        api<Json>("/admin/supply/intakes?limit=100"),
        api<Json>("/admin/market-maker/supply-selections?limit=100"),
      ]);
      setIntakes(Array.isArray(intakeData?.items)?intakeData.items:[]);
      setSelections(Array.isArray(selectionData?.items)?selectionData.items:[]);
    } catch(error){ setMessage((error as Error).message); }
    finally { setLoading(false); }
  },[]);

  useEffect(()=>{ void load(); },[load]);

  async function act(key:string,fn:()=>Promise<unknown>,success:string) {
    setBusy(key); setMessage("");
    try { await fn(); setMessage(success); await load(); }
    catch(error){ setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  const intakeBySelection=useMemo(()=>new Map(intakes.map((item)=>[Number(item.selection_id),item])),[intakes]);
  const awaiting=useMemo(()=>selections.filter((s)=>s.response_id&&num(s.confirmed_available_tonnes)>0&&!intakeBySelection.has(Number(s.id))),[selections,intakeBySelection]);
  const reviewQueue=useMemo(()=>intakes.filter((i)=>["draft","ready_for_review","approved"].includes(String(i.status))),[intakes]);
  const converted=useMemo(()=>intakes.filter((i)=>i.status==="converted"),[intakes]);

  return <>
    <section className="desk-card supply-intake-board">
      <header className="intake-board-head">
        <div><span>SUPPLY INTAKE GATE</span><h2>Seller-confirmed → elegibilidade</h2></div>
        <div className="intake-head-counts"><b>{awaiting.length} aguardando intake</b><b>{reviewQueue.length} em revisão</b><b>{converted.length} convertidos</b></div>
      </header>
      <div className="intake-integrity"><strong>MANDATO ≠ OFFSET</strong><span>Intake aprovado cria mandato, inventário e um monitored candidate restrito. Claim de compensação continua dependendo de revisão explícita de elegibilidade.</span></div>
      {message&&<div className="desk-notice">{message}</div>}
      {loading?<div className="desk-loading">Carregando Supply Intake...</div>:<>
        {awaiting.length>0&&<div className="intake-section"><h3>Seller-confirmed aguardando intake</h3><div className="intake-grid">{awaiting.map((selection)=><article className="intake-card" key={selection.id}>
          <div className="intake-card-head"><div><b>{selection.supplier_name||selection.project_name}</b><small>{selection.registry} · {selection.project_name}</small></div><span className="intake-status positive">seller confirmed</span></div>
          <div className="intake-metrics"><span><small>Confirmado</small><b>{tons(selection.confirmed_available_tonnes)} t</b></span><span><small>Preço</small><b>{selection.firm_price_usd_tonne?`US$ ${selection.firm_price_usd_tonne}/t`:"—"}</b></span><span><small>Retirement</small><b>{selection.retirement_supported?"sim":"não/n.d."}</b></span></div>
          <button disabled={!!busy} onClick={()=>void act(`open-${selection.id}`,()=>api(`/admin/market-maker/supply-selections/${selection.id}/intake`,{method:"POST",body:JSON.stringify({createdBy:"Carbon Desk"})}),"Supply Intake aberto.")}>{busy===`open-${selection.id}`?"Abrindo...":"Abrir intake"}</button>
        </article>)}</div></div>}

        <div className="intake-section"><h3>Diligência e aprovação</h3><div className="intake-grid">{reviewQueue.map((intake)=><IntakeCard key={intake.id} intake={intake} busy={busy} act={act}/>)}{!reviewQueue.length&&<div className="desk-empty">Nenhum intake em revisão.</div>}</div></div>

        {converted.length>0&&<div className="intake-section"><h3>Convertidos — seguem para Eligibility Queue abaixo</h3><div className="intake-grid compact">{converted.slice(0,20).map((intake)=><article className="intake-card converted" key={intake.id}>
          <div className="intake-card-head"><div><b>{intake.supplier_name}</b><small>{intake.registry} · {intake.project_name}</small></div><span className="intake-status">{statusLabel(intake.monitored_eligibility_status||"under_review")}</span></div>
          <div className="intake-metrics"><span><small>Autorizado</small><b>{tons(intake.authorized_tonnes)} t</b></span><span><small>Mandato</small><b>#{intake.mandate_id}</b></span><span><small>Ativo</small><b>#{intake.monitored_asset_id}</b></span></div>
          <div className="intake-claim-state">Claim: <b>{statusLabel(intake.monitored_claim_category||"climate_contribution")}</b> · shelf <b>{statusLabel(intake.monitored_sourcing_shelf||"restricted")}</b> · executable <b>{intake.monitored_sourcing_executable?"sim":"não"}</b></div>
          <span className="intake-link">Decisão climática disponível na Eligibility Queue ↓</span>
        </article>)}</div></div>}
      </>}
    </section>
    <SupplyEligibilityQueue />
    <ExecutionReadinessBoard />
    <DistributionBoard />
  </>;
}

function IntakeCard({intake,busy,act}:{intake:Json;busy:string;act:(key:string,fn:()=>Promise<unknown>,success:string)=>Promise<void>}) {
  const editable=["draft","ready_for_review"].includes(String(intake.status));
  const [expanded,setExpanded]=useState(intake.status==="draft");
  const [batch,setBatch]=useState(String(intake.batch_reference||""));
  const [vintage,setVintage]=useState(String(intake.vintage||""));
  const [serialStart,setSerialStart]=useState(String(intake.serial_start||""));
  const [serialEnd,setSerialEnd]=useState(String(intake.serial_end||""));
  const [evidence,setEvidence]=useState(String(intake.registry_evidence_url||""));
  const [validUntil,setValidUntil]=useState(intake.commercial_valid_until?String(intake.commercial_valid_until).slice(0,16):"");
  const [price,setPrice]=useState(String(intake.floor_price_usd_tonne||""));
  const [minOrder,setMinOrder]=useState(String(intake.min_order_tonnes||""));
  const [retirement,setRetirement]=useState(Boolean(intake.retirement_supported));
  const [beneficiary,setBeneficiary]=useState(Boolean(intake.beneficiary_retirement_supported));
  const [fractional,setFractional]=useState(Boolean(intake.fractional_retirement_supported));
  const [granularity,setGranularity]=useState(String(intake.retirement_granularity_kg||1000));
  const [kyc,setKyc]=useState(String(intake.legal_kyc_status||"pending"));
  const [registryStatus,setRegistryStatus]=useState(String(intake.registry_evidence_status||"pending"));
  const [terms,setTerms]=useState(String(intake.commercial_terms_status||"pending"));
  const [note,setNote]=useState(String(intake.review_note||""));

  async function save() {
    const body:Json={
      batchReference:batch||null,vintage:vintage||null,serialStart:serialStart||null,serialEnd:serialEnd||null,
      registryEvidenceUrl:evidence||null,retirementSupported:retirement,beneficiaryRetirementSupported:beneficiary,
      fractionalRetirementSupported:fractional,retirementGranularityKg:Math.max(1,num(granularity)),
      legalKycStatus:kyc,registryEvidenceStatus:registryStatus,commercialTermsStatus:terms,reviewNote:note||null,actor:"Carbon Desk",
    };
    if(price) body.floorPriceUsdTonne=num(price);
    if(minOrder) body.minOrderTonnes=num(minOrder);
    if(validUntil) body.commercialValidUntil=new Date(validUntil).toISOString();
    await act(`save-intake-${intake.id}`,()=>api(`/admin/supply/intakes/${intake.id}`,{method:"PATCH",body:JSON.stringify(body)}),"Diligência do intake salva.");
  }

  return <article className={`intake-card ${intake.status}`}>
    <div className="intake-card-head"><div><b>{intake.supplier_name}</b><small>{intake.registry} · {intake.project_name}</small></div><span className={`intake-status ${intake.status==="ready_for_review"?"warning":intake.status==="approved"?"positive":""}`}>{statusLabel(intake.status)}</span></div>
    <div className="intake-metrics"><span><small>Seller-confirmed</small><b>{tons(intake.confirmed_tonnes)} t</b></span><span><small>Autorizado</small><b>{tons(intake.authorized_tonnes)} t</b></span><span><small>Batch</small><b>{intake.batch_reference||"pendente"}</b></span></div>
    <div className="intake-gates"><GateChip label="KYC" value={intake.legal_kyc_status}/><GateChip label="Registry" value={intake.registry_evidence_status}/><GateChip label="Termos" value={intake.commercial_terms_status}/><GateChip label="Retirement" value={intake.retirement_supported?"approved":"pending"}/></div>
    {editable&&<button className="mini-button" onClick={()=>setExpanded(!expanded)}>{expanded?"Fechar diligência":"Editar diligência"}</button>}
    {editable&&expanded&&<div className="intake-form">
      <label>Batch / issuance<input value={batch} onChange={(e)=>setBatch(e.target.value)} placeholder="BATCH-..."/></label>
      <label>Vintage<input value={vintage} onChange={(e)=>setVintage(e.target.value)} placeholder="2026"/></label>
      <label>Serial inicial<input value={serialStart} onChange={(e)=>setSerialStart(e.target.value)}/></label>
      <label>Serial final<input value={serialEnd} onChange={(e)=>setSerialEnd(e.target.value)}/></label>
      <label>Evidência registral<input type="url" value={evidence} onChange={(e)=>setEvidence(e.target.value)} placeholder="https://"/></label>
      <label>Validade comercial<input type="datetime-local" value={validUntil} onChange={(e)=>setValidUntil(e.target.value)}/></label>
      <label>Preço US$/t<input type="number" min="0" step="0.01" value={price} onChange={(e)=>setPrice(e.target.value)}/></label>
      <label>Pedido mínimo t<input type="number" min="0" step="0.001" value={minOrder} onChange={(e)=>setMinOrder(e.target.value)}/></label>
      <label>KYC<select value={kyc} onChange={(e)=>setKyc(e.target.value)}><option value="pending">pending</option><option value="approved">approved</option><option value="rejected">rejected</option></select></label>
      <label>Evidência<select value={registryStatus} onChange={(e)=>setRegistryStatus(e.target.value)}><option value="pending">pending</option><option value="verified">verified</option><option value="rejected">rejected</option></select></label>
      <label>Termos comerciais<select value={terms} onChange={(e)=>setTerms(e.target.value)}><option value="pending">pending</option><option value="approved">approved</option><option value="rejected">rejected</option></select></label>
      <label>Granularidade kg<input type="number" min="1" step="1" value={granularity} onChange={(e)=>setGranularity(e.target.value)}/></label>
      <label className="check"><input type="checkbox" checked={retirement} onChange={(e)=>setRetirement(e.target.checked)}/> Retirement</label>
      <label className="check"><input type="checkbox" checked={beneficiary} onChange={(e)=>setBeneficiary(e.target.checked)}/> Beneficiário final</label>
      <label className="check"><input type="checkbox" checked={fractional} onChange={(e)=>setFractional(e.target.checked)}/> Fracionamento</label>
      <label className="intake-note">Nota<textarea value={note} onChange={(e)=>setNote(e.target.value)}/></label>
      <button disabled={!!busy} onClick={()=>void save()}>{busy===`save-intake-${intake.id}`?"Salvando...":"Salvar diligência"}</button>
    </div>}
    <footer className="intake-actions">
      {intake.status==="ready_for_review"&&<button disabled={!!busy} onClick={()=>void act(`approve-intake-${intake.id}`,()=>api(`/admin/supply/intakes/${intake.id}/approve`,{method:"POST",body:JSON.stringify({approvedBy:"Carbon Desk",note:"Aprovado pela Carbon Desk após diligência."})}),"Supply Intake aprovado e snapshot congelado.")}>{busy===`approve-intake-${intake.id}`?"Aprovando...":"Aprovar intake"}</button>}
      {intake.status==="approved"&&<button disabled={!!busy} onClick={()=>void act(`convert-intake-${intake.id}`,()=>api(`/admin/supply/intakes/${intake.id}/convert`,{method:"POST",body:JSON.stringify({convertedBy:"Carbon Desk"})}),"Mandato, inventory e monitored candidate restrito criados.")}>{busy===`convert-intake-${intake.id}`?"Convertendo...":"Criar mandato + candidato"}</button>}
      {intake.approval_sha256&&<small>SHA {String(intake.approval_sha256).slice(0,12)}…</small>}
    </footer>
  </article>;
}

function GateChip({label,value}:{label:string;value:unknown}) {
  const raw=String(value||"pending");
  const ok=["approved","verified"].includes(raw);
  const bad=raw==="rejected";
  return <span className={`intake-gate ${ok?"ok":bad?"bad":""}`}><small>{label}</small><b>{statusLabel(raw)}</b></span>;
}
