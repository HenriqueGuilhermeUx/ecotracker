import { useEffect, useState } from "react";
import { api } from "./api";
import "./client-agreement.css";

type Json = Record<string, any>;

export function ClientAgreementPage({ publicCode }: { publicCode: string }) {
  const [agreement,setAgreement]=useState<Json|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [representativeName,setRepresentativeName]=useState("");
  const [representativeEmail,setRepresentativeEmail]=useState("");
  const [representativeTitle,setRepresentativeTitle]=useState("");
  const [authorityConfirmed,setAuthorityConfirmed]=useState(false);
  const [termsAccepted,setTermsAccepted]=useState(false);

  async function load(){
    try{setAgreement(await api<Json>(`/market/agreements/${publicCode}`))}
    catch(error){setMessage((error as Error).message)}
  }
  useEffect(()=>{void load()},[publicCode]);

  async function accept(){
    setBusy(true);setMessage("");
    try{
      const result=await api<Json>(`/market/agreements/${publicCode}/accept`,{method:"POST",body:JSON.stringify({representativeName,representativeEmail,representativeTitle:representativeTitle||null,authorityConfirmed:true,termsAccepted:true})});
      setMessage(result.message||"Aceite registrado.");
      await load();
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  const accepted=agreement?.status==="accepted";
  const canAccept=Boolean(agreement?.acceptanceEnabled&&!accepted);
  return <main className="agreement-page">
    <header className="agreement-top"><a href="#home" className="agreement-brand"><span>eco</span>tracker</a><div><b>CLIENT AGREEMENT</b><small>Contrato de aquisição e aposentadoria de créditos de carbono</small></div></header>
    {message&&<div className="agreement-message">{message}</div>}
    {!agreement?<section className="agreement-loading">Carregando contrato…</section>:<>
      <section className={`agreement-status ${accepted?"accepted":agreement.status}`}>
        <div><small>CONTRATO</small><b>{String(agreement.publicCode||publicCode).slice(0,8)} · v{agreement.version}</b></div>
        <div><small>STATUS</small><b>{accepted?"ACEITO":agreement.status==="awaiting_signature"?"AGUARDANDO ACEITE":agreement.status==="draft"?"RASCUNHO":"SUBSTITUÍDO"}</b></div>
        <div><small>DOCUMENT SHA-256</small><code>{String(agreement.documentSha256||"").slice(0,18)}…</code></div>
      </section>
      {!agreement.current&&<div className="agreement-alert">Esta versão foi substituída porque preço, fonte, estoque ou condições comerciais mudaram. Solicite o contrato vigente.</div>}
      <section className="agreement-document"><iframe title="Contrato EcoTracker" src={`/api/market/agreements/${publicCode}/document`}/><a className="agreement-print" href={`/api/market/agreements/${publicCode}/document`} target="_blank" rel="noreferrer">Abrir versão para impressão / salvar PDF ↗</a></section>
      {accepted?<section className="agreement-accepted"><b>CONTRATO ACEITO ✓</b><span>Representante: {agreement.acceptedByName||"registrado"}</span><span>Aceito em: {agreement.acceptedAt?new Date(agreement.acceptedAt).toLocaleString("pt-BR"):"—"}</span><code>Documento {String(agreement.documentSha256||"")}</code><small>O aceite não cria cobrança por si só. O pagamento é uma etapa separada.</small></section>:<section className="agreement-accept">
        <div><span className="tag">ACEITE ELETRÔNICO</span><h2>Confirmar representação e concordância</h2><p>Revise o instrumento acima antes de confirmar.</p></div>
        <label>Nome completo do representante<input disabled={!canAccept} value={representativeName} onChange={e=>setRepresentativeName(e.target.value)} /></label>
        <label>E-mail do representante<input disabled={!canAccept} type="email" value={representativeEmail} onChange={e=>setRepresentativeEmail(e.target.value)} /></label>
        <label>Cargo / função<input disabled={!canAccept} value={representativeTitle} onChange={e=>setRepresentativeTitle(e.target.value)} /></label>
        <label className="agreement-check"><input disabled={!canAccept} type="checkbox" checked={authorityConfirmed} onChange={e=>setAuthorityConfirmed(e.target.checked)}/><span>Declaro possuir poderes para representar a CONTRATANTE nesta operação.</span></label>
        <label className="agreement-check"><input disabled={!canAccept} type="checkbox" checked={termsAccepted} onChange={e=>setTermsAccepted(e.target.checked)}/><span>Li o contrato e concordo com seus termos e com o documento identificado pelo SHA-256 exibido.</span></label>
        <button disabled={!canAccept||busy||representativeName.trim().length<2||!representativeEmail||!authorityConfirmed||!termsAccepted} onClick={()=>void accept()}>{busy?"Registrando...":"Confirmar aceite"}</button>
        {!canAccept&&agreement.status==="draft"&&<small className="agreement-disabled">Aceite desabilitado: a identidade jurídica da CONTRATADA ainda precisa ser configurada.</small>}
      </section>}
    </>}
  </main>;
}
