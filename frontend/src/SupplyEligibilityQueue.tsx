import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./supply-eligibility.css";

type Json=Record<string,any>;

const num=(value:unknown)=>{const parsed=Number(value||0);return Number.isFinite(parsed)?parsed:0;};
const tons=(value:unknown)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));
const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");

export function SupplyEligibilityQueue() {
  const [items,setItems]=useState<Json[]>([]);
  const [summary,setSummary]=useState<Json>({});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    try {
      const data=await api<Json>("/admin/supply/eligibility-queue");
      setItems(Array.isArray(data?.items)?data.items:[]);
      setSummary(data?.summary||{});
      setMessage("");
    } catch(error){setMessage((error as Error).message);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),20000);return()=>window.clearInterval(timer);},[load]);

  async function act(key:string,fn:()=>Promise<any>,success:string) {
    setBusy(key);setMessage("");
    try {
      const result=await fn();
      const matching=result?.matching;
      const suffix=matching
        ? matching.fullyCovered
          ? " Matching cobriu 100% e o RFQ pode ser encerrado."
          : ` Matching atualizado: ${tons(matching.uncoveredTonnes)} t ainda descobertas.`
        : "";
      setMessage(`${success}${suffix}`);
      await load();
    } catch(error){setMessage((error as Error).message);}
    finally{setBusy("");}
  }

  const pending=useMemo(()=>items.filter((item)=>!item.eligibility_review_id),[items]);
  const approved=useMemo(()=>items.filter((item)=>item.eligibility_review_status==="approved"),[items]);
  const restricted=useMemo(()=>items.filter((item)=>item.eligibility_review_status==="restricted"),[items]);

  return <section className="desk-card supply-eligibility-board">
    <header className="eligibility-board-head">
      <div><span>SUPPLY ELIGIBILITY GATE</span><h2>Monitored candidate → claim-ready</h2></div>
      <div className="eligibility-counts">
        <b>{pending.length} aguardando</b>
        <b>{approved.length} claim-ready</b>
        <b>{restricted.length} restritos</b>
      </div>
    </header>

    <div className="eligibility-integrity">
      <strong>CLAIM-READY ≠ EXECUÇÃO PROGRAMÁTICA</strong>
      <span>A revisão pode liberar o lote para compensação verificada. Carbonmark, Regen ou outra rail só vira automática quando a execução do provider estiver realmente comprovada.</span>
    </div>

    <div className="eligibility-volume-strip">
      <span><small>Em revisão</small><b>{tons(summary.pendingTonnes)} t</b></span>
      <span><small>Claim-ready</small><b>{tons(summary.approvedTonnes)} t</b></span>
      <span><small>Restrito</small><b>{tons(summary.restrictedTonnes)} t</b></span>
    </div>

    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando Eligibility Queue...</div>:<>
      <div className="eligibility-section">
        <h3>Aguardando revisão climática</h3>
        <div className="eligibility-grid">
          {pending.map((item)=><EligibilityReviewCard key={item.intake_review_id} item={item} busy={busy} act={act}/>) }
          {!pending.length&&<div className="desk-empty">Nenhum lote aguardando eligibility.</div>}
        </div>
      </div>

      {approved.length>0&&<div className="eligibility-section">
        <h3>Claim-ready</h3>
        <div className="eligibility-grid compact">{approved.slice(0,24).map((item)=><DecisionCard key={item.intake_review_id} item={item} positive/>)}</div>
      </div>}

      {restricted.length>0&&<div className="eligibility-section">
        <h3>Restritos / contribuição climática</h3>
        <div className="eligibility-grid compact">{restricted.slice(0,24).map((item)=><DecisionCard key={item.intake_review_id} item={item}/>)}</div>
      </div>}
    </>}
  </section>;
}

function EligibilityReviewCard({item,busy,act}:{item:Json;busy:string;act:(key:string,fn:()=>Promise<any>,success:string)=>Promise<void>}) {
  const [expanded,setExpanded]=useState(false);
  const [basis,setBasis]=useState("");
  const [tradable,setTradable]=useState(false);
  const [ccp,setCcp]=useState("not_assessed");
  const [override,setOverride]=useState(false);
  const [exception,setException]=useState("");
  const [risks,setRisks]=useState("");
  const [restrictReason,setRestrictReason]=useState("");
  const asset=item.asset||{};
  const canApprove=basis.trim().length>=20&&tradable&&(!override||exception.trim().length>0);

  const riskFlags=risks.split(/[\n,]/).map((value)=>value.trim()).filter(Boolean);

  return <article className="eligibility-card pending">
    <div className="eligibility-card-head">
      <div><b>{item.project_name}</b><small>{item.registry} · {item.supplier_name}</small></div>
      <span className="eligibility-status warning">under review</span>
    </div>

    <div className="eligibility-metrics">
      <span><small>Autorizado</small><b>{tons(item.authorized_tonnes)} t</b></span>
      <span><small>Buyer / RFQ</small><b>{item.buyer_company_name||"—"}</b></span>
      <span><small>Gap atual</small><b>{tons(item.gap_tonnes)} t</b></span>
      <span><small>Vintage</small><b>{item.vintage||"—"}</b></span>
    </div>

    <div className="eligibility-evidence">
      <span><small>Batch</small><b>{item.batch_reference||"—"}</b></span>
      <span><small>Project ID</small><b>{item.registry_project_id||"—"}</b></span>
      <span><small>Retirement</small><b>{item.retirement_supported?"sim":"não"}</b></span>
      <span><small>Beneficiário</small><b>{item.beneficiary_retirement_supported?"sim":"não"}</b></span>
    </div>

    <div className="eligibility-state-line">
      <span>claim <b>{label(asset.claim_category)}</b></span>
      <span>status <b>{label(asset.eligibility_status)}</b></span>
      <span>shelf <b>{label(asset.sourcing_shelf)}</b></span>
      <span>execução <b>{asset.sourcing_executable?"programática":"assistida/manual"}</b></span>
    </div>

    {(item.registry_evidence_url||asset.registry_evidence_url)&&<a className="eligibility-link" href={item.registry_evidence_url||asset.registry_evidence_url} target="_blank" rel="noreferrer">Abrir evidência registral ↗</a>}

    <button className="mini-button" onClick={()=>setExpanded(!expanded)}>{expanded?"Fechar revisão":"Revisar eligibility"}</button>

    {expanded&&<div className="eligibility-form">
      <label className="eligibility-basis">Fundamentação do claim<textarea value={basis} onChange={(e)=>setBasis(e.target.value)} placeholder="Descreva a verificação de registry, batch/serial, titularidade/tradability, vintage e capacidade de retirement..."/></label>
      <label className="check important"><input type="checkbox" checked={tradable} onChange={(e)=>setTradable(e.target.checked)}/> Confirmo que as unidades estão registralmente tradable e não aposentadas/canceladas</label>
      <label>CCP<select value={ccp} onChange={(e)=>setCcp(e.target.value)}><option value="not_assessed">não avaliado</option><option value="approved">aprovado</option><option value="eligible_program">programa elegível</option><option value="not_approved">não aprovado</option></select></label>
      <label className="check"><input type="checkbox" checked={override} onChange={(e)=>setOverride(e.target.checked)}/> Aplicar exceção documentada de vintage</label>
      {override&&<label>Justificativa da exceção<textarea value={exception} onChange={(e)=>setException(e.target.value)}/></label>}
      <label>Risk flags remanescentes<textarea value={risks} onChange={(e)=>setRisks(e.target.value)} placeholder="uma por linha; deixe vazio se nenhuma"/></label>
      <div className="eligibility-action-row">
        <button className="approve" disabled={!!busy||!canApprove} onClick={()=>void act(`eligibility-approve-${item.intake_review_id}`,()=>api(`/admin/supply/intakes/${item.intake_review_id}/eligibility/approve`,{method:"POST",body:JSON.stringify({reviewedBy:"Carbon Desk",eligibilityBasis:basis,tradabilityConfirmed:true,ccpStatus:ccp,vintagePolicyOverride:override,vintageExceptionReason:override?exception:null,riskFlags})}),"Lote aprovado como claim-ready.")}>{busy===`eligibility-approve-${item.intake_review_id}`?"Aprovando...":"Aprovar claim-ready"}</button>
      </div>
      <div className="eligibility-restrict-box">
        <label>Se não puder aprovar, registre o motivo<textarea value={restrictReason} onChange={(e)=>setRestrictReason(e.target.value)} placeholder="Ex.: saldo não comprovado, serial inconsistente, vintage fora da política..."/></label>
        <button className="restrict" disabled={!!busy||restrictReason.trim().length<10} onClick={()=>void act(`eligibility-restrict-${item.intake_review_id}`,()=>api(`/admin/supply/intakes/${item.intake_review_id}/eligibility/restrict`,{method:"POST",body:JSON.stringify({reviewedBy:"Carbon Desk",reason:restrictReason,riskFlags:riskFlags.length?riskFlags:["supply-eligibility-restricted"]})}),"Lote mantido na prateleira restrita.")}>{busy===`eligibility-restrict-${item.intake_review_id}`?"Registrando...":"Manter restrito"}</button>
      </div>
    </div>}
  </article>;
}

function DecisionCard({item,positive=false}:{item:Json;positive?:boolean}) {
  const asset=item.asset||{};
  return <article className={`eligibility-card decision ${positive?"approved":"restricted"}`}>
    <div className="eligibility-card-head"><div><b>{item.project_name}</b><small>{item.registry} · {item.supplier_name}</small></div><span className={`eligibility-status ${positive?"positive":""}`}>{positive?"claim-ready":"restricted"}</span></div>
    <div className="eligibility-metrics"><span><small>Volume</small><b>{tons(item.authorized_tonnes)} t</b></span><span><small>RFQ</small><b>{label(item.rfq_status)}</b></span><span><small>Execução</small><b>{asset.sourcing_executable?"programática":"assistida/manual"}</b></span></div>
    <p>{item.reviewed_eligibility_basis}</p>
    <footer><small>SHA {String(item.review_sha256||"").slice(0,12)}… · {item.reviewed_by||"—"}</small>{positive&&<b>{item.offsetDecision?.allowed?"offset permitido":"revisão exigida"}</b>}</footer>
  </article>;
}
