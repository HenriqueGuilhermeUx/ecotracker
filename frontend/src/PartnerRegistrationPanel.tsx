import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";

type Json=Record<string,any>;
const tons=(v:unknown)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(Number(v||0));
const dt=(v:unknown)=>v?new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(new Date(String(v))):"—";

export function PartnerRegistrationPanel({opportunityId}:{opportunityId:number}){
  const [registration,setRegistration]=useState<Json|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [clientLegalName,setClientLegalName]=useState("");
  const [clientCountry,setClientCountry]=useState("Brazil");
  const [affiliates,setAffiliates]=useState("");
  const [nature,setNature]=useState("");
  const [strategic,setStrategic]=useState(false);
  const [creditType,setCreditType]=useState("");
  const [volume,setVolume]=useState("");
  const [timing,setTiming]=useState("");
  const [partnerContact,setPartnerContact]=useState("");
  const [declineGround,setDeclineGround]=useState("3.2(a)");

  function hydrate(data:Json){
    setRegistration(data);
    setClientLegalName(String(data.client_legal_name||data.company_name||""));
    setClientCountry(String(data.client_country||"Brazil"));
    setAffiliates(Array.isArray(data.covered_affiliates)?data.covered_affiliates.join("\n"):"");
    setNature(String(data.nature_of_engagement||""));
    setStrategic(Boolean(data.strategic_account));
    setCreditType(String(data.expected_credit_type||""));
    setVolume(data.expected_volume_tonnes==null?"":String(data.expected_volume_tonnes));
    setTiming(String(data.expected_timing||""));
    setPartnerContact(String(data.partner_contact||""));
  }

  async function load(){
    const data=await api<Json>(`/admin/deal-desk/opportunities/${opportunityId}/partner-registration`);
    hydrate(data);
  }

  useEffect(()=>{void load().catch(()=>undefined)},[opportunityId]);

  async function save(event?:FormEvent){
    event?.preventDefault();
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/opportunities/${opportunityId}/partner-registration`,{
        method:"POST",
        body:JSON.stringify({
          agreementDate:String(registration?.agreement_date||"2026-11-06").slice(0,10),
          clientLegalName,
          clientCountry,
          coveredAffiliates:affiliates.split(/[\n,;]/).map(v=>v.trim()).filter(Boolean),
          natureOfEngagement:nature,
          strategicAccount:strategic,
          expectedCreditType:creditType||null,
          expectedVolumeTonnes:volume?Number(volume):null,
          expectedTiming:timing||null,
          partnerContact,
        }),
      });
      hydrate(data);
      setMessage("Schedule 1 salvo e pronto para revisão. Nenhum dado foi enviado ao parceiro.");
      return data;
    }catch(error){
      setMessage((error as Error).message);
      return null;
    }finally{setBusy(false)}
  }

  async function packageData(){
    let current=registration;
    if(!current?.id) current=await save();
    else {
      const saved=await save();
      if(saved)current=saved;
    }
    if(!current?.id)return null;
    return api<Json>(`/admin/deal-desk/partner-registration/${current.id}/package`);
  }

  async function copySchedule(){
    setBusy(true);setMessage("");
    try{
      const pack=await packageData();
      if(!pack)return;
      await navigator.clipboard.writeText(`${pack.subject}\n\n${pack.body}`);
      setMessage("Schedule 1 copiado. Revise e envie para Drew; a identidade do cliente passa a ser compartilhada nesta etapa.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function openEmail(){
    setBusy(true);setMessage("");
    try{
      const pack=await packageData();
      if(!pack)return;
      const href=`mailto:${encodeURIComponent(pack.to)}?subject=${encodeURIComponent(pack.subject)}&body=${encodeURIComponent(pack.body)}`;
      window.location.href=href;
      setMessage("E-mail preparado no seu cliente de e-mail. Depois de enviar, volte e clique em “Marcar enviado”.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function markSent(){
    if(!registration?.id)return;
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/partner-registration/${registration.id}/mark-sent`,{method:"POST",body:"{}"});
      hydrate(data);
      setMessage("Schedule 1 marcado como enviado. O EcoTracker abriu a contagem contratual de 5 Business Days.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function decision(decision:"confirmed"|"declined"){
    if(!registration?.id)return;
    setBusy(true);setMessage("");
    try{
      const data=await api<Json>(`/admin/deal-desk/partner-registration/${registration.id}/decision`,{
        method:"POST",
        body:JSON.stringify({decision,declineGround:decision==="declined"?declineGround:null}),
      });
      hydrate(data);
      setMessage(decision==="confirmed"?"Cliente confirmado pelo parceiro e protegido pelo contrato.":"Recusa registrada com fundamento contratual.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function deemedConfirmed(){
    if(!registration?.id)return;
    setBusy(true);setMessage("");
    try{
      const ok=window.confirm("Confirme que você verificou feriados federais dos EUA e feriados nacionais do Brasil no período e que não houve resposta do parceiro. Continuar?");
      if(!ok)return;
      const data=await api<Json>(`/admin/deal-desk/partner-registration/${registration.id}/deemed-confirmed`,{
        method:"POST",
        body:JSON.stringify({holidayCheckConfirmed:true}),
      });
      hydrate(data);
      setMessage("Confirmação presumida registrada após validação humana do prazo contratual.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  if(!registration)return null;
  const status=String(registration.status||"draft");
  const protectedStatus=status==="confirmed"||status==="deemed_confirmed";

  return <section className="deal-registration">
    <div className="deal-registration-head">
      <div>
        <small>SCHEDULE 1 · ADMIN</small>
        <h3>Proteção contratual do cliente</h3>
        <p>Formalize o cliente com o parceiro antes de revelar a oportunidade nominal. O registro é por cliente, não por cada nova cotação.</p>
      </div>
      <span className={protectedStatus?"ok":registration.overdue?"warn":"pending"}>{status.replaceAll("_"," ").toUpperCase()}</span>
    </div>

    {message&&<div className="deal-otc-message">{message}</div>}

    {status==="sent"&&<div className={registration.overdue?"deal-registration-deadline overdue":"deal-registration-deadline"}>
      <span><small>Enviado</small><b>{dt(registration.sent_at)}</b></span>
      <span><small>Prazo estimado</small><b>{dt(registration.response_due_at)}</b></span>
      <span><small>Regra</small><b>5 Business Days</b></span>
      <p>O prazo exibido considera dias úteis de segunda a sexta. Antes de usar confirmação presumida, valide feriados federais dos EUA e feriados nacionais do Brasil.</p>
    </div>}

    {protectedStatus&&<div className="deal-registration-protected">
      <b>CLIENTE PROTEGIDO</b>
      <span>Confirmation Date: {registration.confirmation_date||"registrada"} · Proteção contratual passa a ser controlada a partir desta data.</span>
    </div>}

    <form className="deal-registration-form" onSubmit={save}>
      <div className="deal-two">
        <label>Legal name do cliente<input required value={clientLegalName} onChange={e=>setClientLegalName(e.target.value)} disabled={status==="sent"||protectedStatus}/></label>
        <label>Country of incorporation<input required value={clientCountry} onChange={e=>setClientCountry(e.target.value)} disabled={status==="sent"||protectedStatus}/></label>
      </div>
      <label>Affiliates a proteger<textarea rows={2} value={affiliates} onChange={e=>setAffiliates(e.target.value)} placeholder="Uma por linha; deixe vazio se não houver" disabled={status==="sent"||protectedStatus}/></label>
      <label>Nature of engagement<textarea required rows={3} value={nature} onChange={e=>setNature(e.target.value)} disabled={status==="sent"||protectedStatus}/></label>
      <label className="deal-registration-check"><input type="checkbox" checked={strategic} onChange={e=>setStrategic(e.target.checked)} disabled={status==="sent"||protectedStatus}/><span>Propor como Strategic Account</span></label>
      <div className="deal-two">
        <label>Expected credit type<input value={creditType} onChange={e=>setCreditType(e.target.value)} disabled={status==="sent"||protectedStatus}/></label>
        <label>Expected volume tCO2e<input type="number" min="0.001" step="0.001" value={volume} onChange={e=>setVolume(e.target.value)} disabled={status==="sent"||protectedStatus}/></label>
      </div>
      <div className="deal-two">
        <label>Expected timing<input value={timing} onChange={e=>setTiming(e.target.value)} placeholder="2026 / Q1 2027..." disabled={status==="sent"||protectedStatus}/></label>
        <label>Partner contact<input required value={partnerContact} onChange={e=>setPartnerContact(e.target.value)} disabled={status==="sent"||protectedStatus}/></label>
      </div>

      {(status==="draft"||status==="ready_to_send")&&<div className="deal-registration-actions">
        <button className="deal-secondary" disabled={busy}>{busy?"Salvando...":"Salvar Schedule 1"}</button>
        <button type="button" className="deal-secondary" disabled={busy} onClick={()=>void copySchedule()}>Copiar registro</button>
        <button type="button" className="deal-primary" disabled={busy} onClick={()=>void openEmail()}>Preparar e-mail para Drew</button>
        {registration.id&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void markSent()}>Marcar enviado</button>}
      </div>}

      {status==="sent"&&<div className="deal-registration-actions">
        <button type="button" className="deal-primary" disabled={busy} onClick={()=>void decision("confirmed")}>Registrar confirmação</button>
        <select value={declineGround} onChange={e=>setDeclineGround(e.target.value)} disabled={busy}>
          <option value="3.2(a)">Recusa · 3.2(a)</option>
          <option value="3.2(b)">Recusa · 3.2(b)</option>
          <option value="3.2(c)">Recusa · 3.2(c)</option>
          <option value="other">Recusa · outro</option>
        </select>
        <button type="button" className="deal-secondary" disabled={busy} onClick={()=>void decision("declined")}>Registrar recusa</button>
        {registration.overdue&&<button type="button" className="deal-secondary" disabled={busy} onClick={()=>void deemedConfirmed()}>Validar confirmação presumida</button>}
      </div>}
    </form>

    <small className="deal-registration-footnote">O envio do Schedule 1 é o momento em que a identidade do cliente é formalmente compartilhada. O EcoTracker não envia automaticamente sem revisão humana.</small>
  </section>;
}
