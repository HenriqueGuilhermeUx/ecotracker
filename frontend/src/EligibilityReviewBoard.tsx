import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./eligibility-review.css";

type Json=Record<string,any>;

const statusLabel=(value:unknown)=>String(value||"unknown").replaceAll("_"," ");
const shortSha=(value:unknown)=>String(value||"").slice(0,12);
const isVerified=(asset:Json)=>asset.claim_category==="voluntary_offset"&&asset.eligibility_status==="eligible";
const dateValue=(value:unknown)=>value?String(value).slice(0,10):"";
const dateTimeValue=(value:unknown)=>value?String(value).slice(0,16):"";

export function EligibilityReviewBoard(){
  const [assets,setAssets]=useState<Json[]>([]);
  const [reviews,setReviews]=useState<Json[]>([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    try{
      const [assetData,reviewData]=await Promise.all([
        api<Json[]>("/admin/market/eligibility"),
        api<Json>("/admin/market/eligibility-reviews?limit=150"),
      ]);
      setAssets(Array.isArray(assetData)?assetData:[]);
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

  const pendingByAsset=useMemo(()=>new Map(reviews.filter((r)=>r.status==="pending").map((r)=>[Number(r.asset_id),r])),[reviews]);
  const candidates=useMemo(()=>assets
    .filter((a)=>!isVerified(a)&&["under_review","restricted","ineligible"].includes(String(a.eligibility_status)))
    .sort((a,b)=>Number(String(b.source_reference||"").startsWith("supply-intake:"))-Number(String(a.source_reference||"").startsWith("supply-intake:"))),[assets]);
  const pending=useMemo(()=>reviews.filter((r)=>r.status==="pending"),[reviews]);
  const decided=useMemo(()=>reviews.filter((r)=>r.status!=="pending").slice(0,30),[reviews]);

  return <section className="desk-card eligibility-review-board" id="eligibility-review-board">
    <header className="eligibility-head">
      <div><span>ELIGIBILITY REVIEW LEDGER</span><h2>Evidence → review → claim-ready</h2></div>
      <div className="eligibility-counts"><b>{candidates.length} ativos restritos</b><b>{pending.length} reviews pendentes</b><b>{decided.length} decisões recentes</b></div>
    </header>
    <div className="eligibility-integrity"><strong>PATCH DIRETO BLOQUEADO</strong><span>Promoção para compensação verificada exige snapshot versionado, fingerprint do ativo, preview da policy, decisão humana e SHA-256 aplicado.</span></div>
    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando eligibility ledger...</div>:<>
      <div className="eligibility-section"><h3>Ativos aguardando review</h3><div className="eligibility-grid">{candidates.map((asset)=>{
        const review=pendingByAsset.get(Number(asset.id));
        return review?<PendingReviewCard key={`pending-${asset.id}`} review={review} busy={busy} act={act}/>:<AssetReviewCard key={asset.id} asset={asset} busy={busy} act={act}/>;
      })}{!candidates.length&&<div className="desk-empty">Nenhum ativo restrito aguardando review.</div>}</div></div>

      {pending.filter((r)=>!candidates.some((a)=>Number(a.id)===Number(r.asset_id))).length>0&&<div className="eligibility-section"><h3>Reviews pendentes adicionais</h3><div className="eligibility-grid">{pending.filter((r)=>!candidates.some((a)=>Number(a.id)===Number(r.asset_id))).map((review)=><PendingReviewCard key={review.id} review={review} busy={busy} act={act}/>)}</div></div>}

      {decided.length>0&&<div className="eligibility-section"><h3>Ledger de decisões</h3><div className="eligibility-ledger">{decided.map((review)=><article key={review.id} className={`eligibility-decision ${review.status}`}>
        <div><b>{review.project_name||`Ativo #${review.asset_id}`}</b><small>{review.registry} · review v{review.review_version}</small></div>
        <span className={`eligibility-pill ${review.status}`}>{statusLabel(review.status)}</span>
        <div className="eligibility-shas"><small>proposed</small><code>{shortSha(review.proposed_sha256)}…</code>{review.applied_sha256&&<><small>applied</small><code>{shortSha(review.applied_sha256)}…</code></>}</div>
        <div><small>Estado atual</small><b>{statusLabel(review.current_claim_category)} · {statusLabel(review.current_eligibility_status)}</b></div>
      </article>)}</div></div>}
    </>}
  </section>;
}

function AssetReviewCard({asset,busy,act}:{asset:Json;busy:string;act:(key:string,fn:()=>Promise<unknown>,success:string)=>Promise<void>}){
  const [expanded,setExpanded]=useState(String(asset.source_reference||"").startsWith("supply-intake:"));
  const [basis,setBasis]=useState(String(asset.eligibility_basis||"Registry, batch, vintage, tradability e retirement validados pela operação EcoTracker."));
  const [unitStatus,setUnitStatus]=useState(String(asset.source_unit_status==="unknown"?"tradable":asset.source_unit_status||"tradable"));
  const [vintageStart,setVintageStart]=useState(dateValue(asset.vintage_start)||(/^(19|20)\d{2}$/.test(String(asset.vintage||""))?`${asset.vintage}-01-01`:""));
  const [vintageEnd,setVintageEnd]=useState(dateValue(asset.vintage_end)||(/^(19|20)\d{2}$/.test(String(asset.vintage||""))?`${asset.vintage}-12-31`:""));
  const [commercialValid,setCommercialValid]=useState(dateValue(asset.commercial_valid_until));
  const [offerExpires,setOfferExpires]=useState(dateTimeValue(asset.offer_expires_at));
  const [projectId,setProjectId]=useState(String(asset.registry_project_id||""));
  const [batchId,setBatchId]=useState(String(asset.registry_batch_id||""));
  const [evidence,setEvidence]=useState(String(asset.registry_evidence_url||asset.source_url||""));
  const [retirement,setRetirement]=useState(Boolean(asset.retirement_supported));
  const [fractional,setFractional]=useState(Boolean(asset.fractional_retirement_supported));
  const [beneficiary,setBeneficiary]=useState(Boolean(asset.beneficiary_retirement_supported));
  const [granularity,setGranularity]=useState(String(asset.retirement_granularity_kg||1000));
  const [ccp,setCcp]=useState(String(asset.ccp_status||"not_assessed"));
  const [note,setNote]=useState("Review criada pela Carbon Desk. Aprovação separada obrigatória.");

  const sourceIntake=String(asset.source_reference||"").startsWith("supply-intake:");
  async function createReview(){
    const proposal:Json={
      claimCategory:"voluntary_offset",eligibilityStatus:"eligible",eligibilityBasis:basis||null,sourceUnitStatus:unitStatus,
      vintageStart:vintageStart||null,vintageEnd:vintageEnd||null,commercialValidUntil:commercialValid||null,
      offerExpiresAt:offerExpires?new Date(offerExpires).toISOString():null,registryProjectId:projectId||null,registryBatchId:batchId||null,
      registryEvidenceUrl:evidence||null,retirementSupported:retirement,fractionalRetirementSupported:fractional,
      retirementGranularityKg:Math.max(1,Number(granularity)||1000),beneficiaryRetirementSupported:beneficiary,
      ccpStatus:ccp,riskFlags:[],
    };
    await act(`create-review-${asset.id}`,()=>api(`/admin/market/assets/${asset.id}/eligibility-reviews`,{
      method:"POST",body:JSON.stringify({purpose:"voluntary_offset",createdBy:"Carbon Desk",note,proposal}),
    }),"Eligibility Review criada. Revise o preview antes de aprovar.");
  }

  return <article className={`eligibility-asset-card ${sourceIntake?"from-intake":""}`}>
    <div className="eligibility-card-head"><div><b>{asset.project_name}</b><small>{asset.registry} · ativo #{asset.id}</small></div><span className="eligibility-pill restricted">{statusLabel(asset.eligibility_status)}</span></div>
    <div className="eligibility-source"><span>{sourceIntake?"SUPPLY INTAKE":"MONITORED ASSET"}</span><code>{String(asset.source_reference||"").slice(0,48)}</code></div>
    <div className="eligibility-facts"><span><small>Claim atual</small><b>{statusLabel(asset.claim_category)}</b></span><span><small>Unit</small><b>{statusLabel(asset.source_unit_status)}</b></span><span><small>Retirement</small><b>{asset.retirement_supported?"sim":"não"}</b></span><span><small>Beneficiário</small><b>{asset.beneficiary_retirement_supported?"sim":"não"}</b></span></div>
    {Array.isArray(asset.eligibility_risk_flags)&&asset.eligibility_risk_flags.length>0&&<div className="eligibility-risks">{asset.eligibility_risk_flags.map((flag:string)=><span key={flag}>{flag}</span>)}</div>}
    <button className="mini-button" onClick={()=>setExpanded(!expanded)}>{expanded?"Fechar proposta":"Preparar review"}</button>
    {expanded&&<div className="eligibility-form">
      <label>Basis<textarea value={basis} onChange={(e)=>setBasis(e.target.value)}/></label>
      <label>Status da unidade<select value={unitStatus} onChange={(e)=>setUnitStatus(e.target.value)}><option value="tradable">tradable</option><option value="unknown">unknown</option><option value="suspended">suspended</option></select></label>
      <label>Vintage início<input type="date" value={vintageStart} onChange={(e)=>setVintageStart(e.target.value)}/></label>
      <label>Vintage fim<input type="date" value={vintageEnd} onChange={(e)=>setVintageEnd(e.target.value)}/></label>
      <label>Validade comercial<input type="date" value={commercialValid} onChange={(e)=>setCommercialValid(e.target.value)}/></label>
      <label>Oferta expira<input type="datetime-local" value={offerExpires} onChange={(e)=>setOfferExpires(e.target.value)}/></label>
      <label>Registry project ID<input value={projectId} onChange={(e)=>setProjectId(e.target.value)}/></label>
      <label>Batch / issuance ID<input value={batchId} onChange={(e)=>setBatchId(e.target.value)}/></label>
      <label className="eligibility-wide">Evidência registral<input type="url" value={evidence} onChange={(e)=>setEvidence(e.target.value)} placeholder="https://"/></label>
      <label>Granularidade kg<input type="number" min="1" value={granularity} onChange={(e)=>setGranularity(e.target.value)}/></label>
      <label>CCP<select value={ccp} onChange={(e)=>setCcp(e.target.value)}><option value="not_assessed">not assessed</option><option value="approved">approved</option><option value="eligible_program">eligible program</option><option value="not_approved">not approved</option></select></label>
      <label className="eligibility-check"><input type="checkbox" checked={retirement} onChange={(e)=>setRetirement(e.target.checked)}/> Retirement</label>
      <label className="eligibility-check"><input type="checkbox" checked={beneficiary} onChange={(e)=>setBeneficiary(e.target.checked)}/> Beneficiário final</label>
      <label className="eligibility-check"><input type="checkbox" checked={fractional} onChange={(e)=>setFractional(e.target.checked)}/> Fracionamento</label>
      <label className="eligibility-wide">Nota<textarea value={note} onChange={(e)=>setNote(e.target.value)}/></label>
      <button disabled={!!busy} onClick={()=>void createReview()}>{busy===`create-review-${asset.id}`?"Criando...":"Criar Eligibility Review"}</button>
    </div>}
  </article>;
}

function PendingReviewCard({review,busy,act}:{review:Json;busy:string;act:(key:string,fn:()=>Promise<unknown>,success:string)=>Promise<void>}){
  const preview=review.preview_decision||{};
  const proposed=review.proposed_snapshot?.fields||{};
  const [reason,setReason]=useState("Evidências insuficientes / review rejeitada pela Carbon Desk.");
  return <article className={`eligibility-review-card ${preview.allowed?"allowed":"blocked"}`}>
    <div className="eligibility-card-head"><div><b>{review.project_name||`Ativo #${review.asset_id}`}</b><small>{review.registry} · review v{review.review_version}</small></div><span className="eligibility-pill pending">pending</span></div>
    <div className={`eligibility-preview ${preview.allowed?"allowed":"blocked"}`}><strong>{preview.allowed?"POLICY PREVIEW: ALLOWED":"POLICY PREVIEW: BLOCKED"}</strong><span>{preview.reason||"Sem motivo retornado"}</span></div>
    <div className="eligibility-facts"><span><small>Claim proposto</small><b>{statusLabel(proposed.claimCategory)}</b></span><span><small>Status</small><b>{statusLabel(proposed.eligibilityStatus)}</b></span><span><small>Unit</small><b>{statusLabel(proposed.sourceUnitStatus)}</b></span><span><small>Shelf preview</small><b>{statusLabel(preview.shelf)}</b></span></div>
    <div className="eligibility-hash"><small>Fingerprint base</small><code>{shortSha(review.base_fingerprint)}…</code><small>Proposed SHA</small><code>{shortSha(review.proposed_sha256)}…</code></div>
    {Array.isArray(preview.warnings)&&preview.warnings.length>0&&<div className="eligibility-risks">{preview.warnings.map((warning:string)=><span key={warning}>{warning}</span>)}</div>}
    <footer className="eligibility-actions">
      <button className="reject" disabled={!!busy} onClick={()=>void act(`reject-review-${review.id}`,()=>api(`/admin/market/eligibility-reviews/${review.id}/reject`,{method:"POST",body:JSON.stringify({reason,reviewedBy:"Carbon Desk"})}),"Eligibility Review rejeitada e congelada no ledger.")}>Rejeitar</button>
      <button disabled={!!busy||!preview.allowed} onClick={()=>void act(`approve-review-${review.id}`,()=>api(`/admin/market/eligibility-reviews/${review.id}/approve`,{method:"POST",body:JSON.stringify({reviewedBy:"Carbon Desk",note:"Aprovação humana após conferência do preview e evidências."})}),"Eligibility Review aprovada e aplicada ao ativo.")}>{busy===`approve-review-${review.id}`?"Aplicando...":"Aprovar eligibility"}</button>
    </footer>
    <details><summary>Motivo de rejeição</summary><textarea value={reason} onChange={(e)=>setReason(e.target.value)}/></details>
  </article>;
}
