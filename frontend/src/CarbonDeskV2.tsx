import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { SupplyIntakeBoard } from "./SupplyIntakeBoard";
import "./carbon-desk.css";
import "./carbon-desk-supply.css";

type Json = Record<string, any>;

type Rfq = {
  id:number; public_code:string; company_name:string; status:string;
  target_tonnes:string|number; covered_tonnes:string|number; gap_tonnes:string|number;
  candidate_count:number; candidate_tonnes:string|number; priority_score:number;
  claim_purpose:string; updated_at:string;
};

type SupplyCandidate = {
  id:number; publicCode:string; candidateType:string; candidateKey:string;
  supplyLeadId?:number|null; supplyInventoryId?:number|null; monitoredAssetId?:number|null; registry?:string|null;
  registryProjectId?:string|null; projectName?:string|null; country?:string|null; vintage?:string|null;
  candidateTonnes:string|number; confidence:string; sourcingScore:number; status:string;
  autoCloseEligible:boolean; rationale?:Json; snapshot?:Json; lastCheckedAt?:string;
};

type Proposal = {
  id:number; public_code:string; company_name:string; status:string;
  target_tonnes:string|number; coverage_pct:string|number; final_total_brl:string|number;
  checkout_mode:string; review_status?:string|null; outbox_id?:number|null;
  outbox_status?:string|null; contact_email?:string|null; expires_at?:string|null;
  review_eligible_now?:boolean|null; opportunity_status?:string|null;
};

type Basket = {
  id:number; public_code:string; company_name:string; status:string; payment_status:string;
  covered_kg:string|number; final_total_brl:string|number; leg_count:number; confirmed_legs:number;
  active_reservations:number;
};

const n = (value:unknown) => { const parsed=Number(value||0); return Number.isFinite(parsed)?parsed:0; };
const tons = (value:unknown) => new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(n(value));
const money = (value:unknown) => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0}).format(n(value));
const compactMoney = (value:unknown) => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",notation:"compact",maximumFractionDigits:1}).format(n(value));
const dateTime = (value:unknown) => value ? new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(String(value))) : "—";
const label = (value:unknown) => String(value || "—").replaceAll("_"," ");

export function CarbonDesk() {
  const [token,setToken] = useState(localStorage.getItem("ecotracker_admin_token"));
  if (!token) return <DeskLogin onLogin={(next)=>{ localStorage.setItem("ecotracker_admin_token",next); setToken(next); }} />;
  return <CarbonDeskPanel logout={()=>{ localStorage.removeItem("ecotracker_admin_token"); setToken(null); }} />;
}

function DeskLogin({onLogin}:{onLogin:(token:string)=>void}) {
  const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [message,setMessage]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault(); setMessage("");
    try { const response=await api<{token:string}>("/auth/login",{method:"POST",body:JSON.stringify({email,password})}); onLogin(response.token); }
    catch(error){ setMessage((error as Error).message); }
  }
  return <MarketShell><main className="carbon-login"><form onSubmit={submit}>
    <span className="tag">CARBON DESK</span><h1>Mesa de carbono</h1><p>Supply, demand e settlement.</p>
    <input required type="email" placeholder="E-mail admin" value={email} onChange={(e)=>setEmail(e.target.value)} />
    <input required type="password" placeholder="Senha" value={password} onChange={(e)=>setPassword(e.target.value)} />
    <button>Entrar</button>{message && <div className="desk-error">{message}</div>}
  </form></main></MarketShell>;
}

function CarbonDeskPanel({logout}:{logout:()=>void}) {
  const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(""); const [message,setMessage]=useState("");
  const [summary,setSummary]=useState<Json>({}); const [autopilot,setAutopilot]=useState<Json>({});
  const [pipeline,setPipeline]=useState<Json[]>([]); const [rfqs,setRfqs]=useState<Rfq[]>([]);
  const [proposals,setProposals]=useState<Proposal[]>([]); const [buyerOutbox,setBuyerOutbox]=useState<Json[]>([]);
  const [buyerOutreach,setBuyerOutreach]=useState<Json>({}); const [baskets,setBaskets]=useState<Basket[]>([]);
  const [payment,setPayment]=useState<Json>({}); const [supplyOutreach,setSupplyOutreach]=useState<Json>({});
  const [supplyOutbox,setSupplyOutbox]=useState<Json[]>([]); const [supplySelections,setSupplySelections]=useState<Json[]>([]);
  const [openRfq,setOpenRfq]=useState<Json|null>(null);

  const load = useCallback(async()=>{
    try {
      const [s,a,p,r,pr,bo,bos,b,ps,so,sob,sel]=await Promise.all([
        api<Json>("/admin/market-maker/summary"), api<Json>("/admin/demand/autopilot/status"),
        api<Json>("/admin/demand/autopilot/pipeline?limit=200"), api<Json>("/admin/market-maker/rfqs?limit=200"),
        api<Json>("/admin/demand/proposals?limit=200"), api<Json>("/admin/demand/outbox?limit=200"),
        api<Json>("/admin/demand/outreach/status"), api<Json>("/admin/demand/baskets?limit=200"),
        api<Json>("/admin/demand/basket-payments/status"), api<Json>("/admin/market-maker/supply-outreach/status"),
        api<Json>("/admin/market-maker/supply-outbox?limit=200"), api<Json>("/admin/market-maker/supply-selections?limit=200"),
      ]);
      setSummary(s||{}); setAutopilot(a||{}); setPipeline(Array.isArray(p?.items)?p.items:[]); setRfqs(Array.isArray(r?.items)?r.items:[]);
      setProposals(Array.isArray(pr?.items)?pr.items:[]); setBuyerOutbox(Array.isArray(bo?.items)?bo.items:[]); setBuyerOutreach(bos||{});
      setBaskets(Array.isArray(b?.items)?b.items:[]); setPayment(ps||{}); setSupplyOutreach(so||{});
      setSupplyOutbox(Array.isArray(sob?.items)?sob.items:[]); setSupplySelections(Array.isArray(sel?.items)?sel.items:[]); setMessage("");
    } catch(error){ setMessage((error as Error).message); }
    finally { setLoading(false); }
  },[]);

  useEffect(()=>{ void load(); const timer=window.setInterval(()=>void load(),20000); return ()=>window.clearInterval(timer); },[load]);

  async function act(key:string,fn:()=>Promise<any>,success:string,after?:()=>Promise<void>) {
    setBusy(key); setMessage("");
    try { await fn(); setMessage(success); await load(); if(after) await after(); }
    catch(error){ setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  async function inspectRfq(id:number) {
    setBusy(`inspect-${id}`);
    try { setOpenRfq(await api<Json>(`/admin/market-maker/rfqs/${id}`)); }
    catch(error){ setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  async function prepareSupplierRfq(rfq:Json,candidate:SupplyCandidate) {
    if(candidate.candidateType==="market_signal" || !candidate.supplyLeadId) {
      setMessage("Sinal de mercado não é fornecedor confirmado. Verifique provider/evidência, origine o holder e passe pela elegibilidade antes de preparar RFQ de fornecedor.");
      return;
    }
    const requested=Math.min(n(rfq.gap_tonnes),n(candidate.candidateTonnes));
    await act(`prepare-supply-${candidate.id}`,async()=>{
      const selection=await api<Json>(`/admin/market-maker/rfqs/${rfq.id}/candidates/${candidate.id}/select`,{
        method:"POST",body:JSON.stringify({requestedTonnes:requested,responseDays:5,selectedBy:"Carbon Desk",note:"Selecionado pela Carbon Desk"}),
      });
      await api(`/admin/market-maker/supply-selections/${selection.id}/outbox`,{method:"POST",body:JSON.stringify({createdBy:"Carbon Desk"})});
    },`RFQ de ${tons(requested)} t preparado para o fornecedor.`,()=>inspectRfq(Number(rfq.id)));
  }

  const openRfqs=useMemo(()=>rfqs.filter((r)=>["open","partially_sourced"].includes(r.status)),[rfqs]);
  const reviewQueue=useMemo(()=>proposals.filter((p)=>p.status==="draft"&&!p.review_status&&p.review_eligible_now!==false),[proposals]);
  const approvedQueue=useMemo(()=>proposals.filter((p)=>p.status==="draft"&&p.review_status==="approved"&&!p.outbox_id&&p.review_eligible_now!==false),[proposals]);
  const staleReviewQueue=useMemo(()=>proposals.filter((p)=>p.status==="draft"&&p.review_eligible_now===false),[proposals]);
  const buyerReady=useMemo(()=>buyerOutbox.filter((o)=>o.status==="ready"),[buyerOutbox]);
  const supplyReady=useMemo(()=>supplyOutbox.filter((o)=>o.status==="ready"),[supplyOutbox]);
  const proposalValue=useMemo(()=>reviewQueue.reduce((sum,p)=>sum+n(p.final_total_brl),0),[reviewQueue]);
  const activeBaskets=useMemo(()=>baskets.filter((b)=>!["completed","cancelled"].includes(b.status)),[baskets]);

  return <MarketShell><main className="carbon-desk">
    <header className="desk-head"><div><span className="tag">ECOTRACKER MARKET MAKER</span><h1>Carbon Desk</h1><p>Demand ↔ Supply ↔ Execution.</p></div>
      <div className="desk-head-actions"><a className="desk-button ghost" href="#market-admin">Commerce OS</a><button className="desk-button ghost" onClick={()=>void load()}>Recarregar</button>
      <button className="desk-button primary" disabled={!!busy} onClick={()=>void act("autopilot",()=>api("/admin/demand/autopilot/run",{method:"POST"}),"Demand Autopilot executado.")}>{busy==="autopilot"?"Rodando...":"Rodar Demand Autopilot"}</button>
      <button className="desk-button ghost" onClick={logout}>Sair</button></div></header>
    {message&&<div className="desk-notice">{message}</div>}
    {loading?<div className="desk-loading">Carregando mesa...</div>:<>
      <section className="desk-kpis">
        <DeskKpi label="Gap aberto" value={`${tons(summary?.rfqs?.open_gap_tonnes)} t`} detail={`${n(summary?.rfqs?.open_rfqs)} RFQs`} tone="alert" />
        <DeskKpi label="Supply em abordagem" value={String(supplySelections.filter((s)=>!s.response_id).length)} detail={`${supplyReady.length} e-mails prontos`} />
        <DeskKpi label="Respostas Supply" value={String(supplySelections.filter((s)=>s.response_id).length)} detail="seller-confirmed" tone="safe" />
        <DeskKpi label="Propostas p/ revisão" value={String(reviewQueue.length)} detail={compactMoney(proposalValue)} tone="money" />
        <DeskKpi label="Outbox comprador" value={String(buyerReady.length)} detail={buyerOutreach.live?"envio live":"live OFF"} tone={buyerOutreach.live?"money":"safe"} />
        <DeskKpi label="Baskets ativos" value={String(activeBaskets.length)} detail={payment.live?"pagamento LIVE":"pagamento OFF"} tone={payment.live?"alert":"safe"} />
      </section>

      <section className="desk-safety supply-safety">
        <Gate title="Demand worker" live={Boolean(autopilot.live)} text={autopilot.live?"recorrente ativo":"manual / worker off"}/>
        <Gate title="Buyer outreach" live={Boolean(buyerOutreach.live)} text={buyerOutreach.live?"e-mail live":"bloqueado"}/>
        <Gate title="Supply outreach" live={Boolean(supplyOutreach.live)} text={supplyOutreach.live?"e-mail live":"bloqueado"}/>
        <Gate title="Basket payment" live={Boolean(payment.live)} warn={Boolean(payment.live)} text={payment.live?"LIVE":"desligado"}/>
        <Gate title="Claim gate" live text="seller-confirmed ≠ claim-ready"/>
      </section>

      <div className="supply-integrity-banner"><b>CONFIRMAÇÃO COMERCIAL ≠ CLAIM-READY</b><span>Fornecedor confirmar saldo, preço ou retirement melhora o sourcing, mas não publica crédito. O RFQ só resolve quando o Matching Engine encontra ativo elegível, tradable e retirement-ready no catálogo.</span></div>

      <div className="desk-grid two">
        <DeskCard title="Gaps de demanda / RFQs" eyebrow="BUY-SIDE → SOURCING" count={openRfqs.length}>
          <div className="desk-list">{openRfqs.map((rfq)=><article className="desk-row rfq-row" key={rfq.id}>
            <div className="row-main"><div><b>{rfq.company_name}</b><small>{rfq.claim_purpose} · prioridade {rfq.priority_score}</small></div><Status value={rfq.status}/></div>
            <div className="coverage"><i style={{width:`${Math.min(100,n(rfq.covered_tonnes)/Math.max(1,n(rfq.target_tonnes))*100)}%`}}/></div>
            <div className="row-metrics"><span><small>Target</small><b>{tons(rfq.target_tonnes)} t</b></span><span><small>Coberto</small><b>{tons(rfq.covered_tonnes)} t</b></span><span className="gap"><small>Gap</small><b>{tons(rfq.gap_tonnes)} t</b></span><span><small>Candidatos</small><b>{n(rfq.candidate_count)}</b></span></div>
            <footer><small>{tons(rfq.candidate_tonnes)} t candidatos deste RFQ · {dateTime(rfq.updated_at)}</small><div className="row-actions"><button disabled={!!busy} onClick={()=>void act(`rfq-${rfq.id}`,()=>api(`/admin/market-maker/rfqs/${rfq.id}/refresh`,{method:"POST"}),"Supply atualizado.",()=>inspectRfq(rfq.id))}>Atualizar</button><button disabled={!!busy} onClick={()=>void inspectRfq(rfq.id)}>{busy===`inspect-${rfq.id}`?"Abrindo...":"Abrir candidatos"}</button></div></footer>
          </article>)}{!openRfqs.length&&<Empty text="Nenhum gap aberto."/>}</div>
        </DeskCard>

        <DeskCard title="Fila comercial comprador" eyebrow="PROPOSTAS" count={reviewQueue.length+approvedQueue.length}>
          {staleReviewQueue.length>0&&<div className="claim-warning"><b>{staleReviewQueue.length} proposta(s) obsoleta(s) ocultada(s).</b> Supply atual não sustenta mais o snapshot; rematching obrigatório.</div>}
          <div className="desk-list">{reviewQueue.map((p)=><BuyerProposal key={p.id} proposal={p} label="Aprovar snapshot" disabled={!!busy} action={()=>act(`approve-${p.id}`,()=>api(`/admin/demand/proposals/${p.id}/review/approve`,{method:"POST",body:JSON.stringify({note:"Aprovada pela Carbon Desk"})}),"Proposta aprovada.")} />)}
          {approvedQueue.map((p)=><BuyerProposal key={p.id} proposal={p} label="Criar outbox" disabled={!!busy||!p.contact_email} action={()=>act(`outbox-${p.id}`,()=>api(`/admin/demand/proposals/${p.id}/outbox`,{method:"POST",body:"{}"}),"Outbox comprador criado.")} />)}
          {!reviewQueue.length&&!approvedQueue.length&&<Empty text="Nenhuma proposta atual aguardando ação."/>}</div>
        </DeskCard>
      </div>

      {openRfq&&<RfqCandidatePanel rfq={openRfq} selections={supplySelections} busy={busy} close={()=>setOpenRfq(null)} prepare={(c)=>void prepareSupplierRfq(openRfq,c)} />}

      <div className="desk-grid two">
        <DeskCard title="Supplier Outbox" eyebrow="SUPPLY OUTREACH" count={supplyOutbox.length}>
          <div className="desk-list">{supplyOutbox.slice(0,20).map((item)=><article className="desk-row outbox-row" key={item.id}><div className="row-main"><div><b>{item.supplier_name||item.recipient_name||item.recipient_email}</b><small>{item.registry} · {item.project_name} · {tons(item.requested_tonnes)} t</small></div><Status value={item.status}/></div><p>{item.subject}</p><footer><small>{item.recipient_email}</small>{item.status==="ready"&&<button disabled={!supplyOutreach.live||!!busy} onClick={()=>void act(`send-supply-${item.id}`,()=>api(`/admin/market-maker/supply-outbox/${item.id}/dispatch`,{method:"POST",body:JSON.stringify({actor:"Carbon Desk"})}),"RFQ enviado ao fornecedor.")}>{supplyOutreach.live?"Enviar RFQ":"Envio bloqueado"}</button>}</footer></article>)}{!supplyOutbox.length&&<Empty text="Nenhum RFQ preparado para fornecedor."/>}</div>
        </DeskCard>

        <DeskCard title="Respostas de Supply" eyebrow="QUALIFICAÇÃO" count={supplySelections.length}>
          <div className="desk-list">{supplySelections.slice(0,20).map((selection)=><SupplySelectionRow key={selection.id} selection={selection} busy={busy} onSubmit={(body)=>act(`response-${selection.id}`,()=>api(`/admin/market-maker/supply-selections/${selection.id}/response`,{method:"POST",body:JSON.stringify(body)}),"Resposta do fornecedor registrada como seller-confirmed.",openRfq?()=>inspectRfq(Number(openRfq.id)):undefined)} />)}{!supplySelections.length&&<Empty text="Nenhum fornecedor selecionado."/>}</div>
        </DeskCard>
      </div>

      <SupplyIntakeBoard />

      <div className="desk-grid two">
        <DeskCard title="Outbox comprador" eyebrow="BUYER OUTREACH" count={buyerOutbox.length}><div className="desk-list">{buyerOutbox.slice(0,12).map((item)=><article className="desk-row outbox-row" key={item.id}><div className="row-main"><div><b>{item.company_name||item.recipient_name||item.recipient_email}</b><small>{item.recipient_email}</small></div><Status value={item.status}/></div><p>{item.subject}</p><footer><small>tentativas {n(item.attempts)}</small>{item.status==="ready"&&<button disabled={!buyerOutreach.live||!!busy} onClick={()=>void act(`send-buyer-${item.id}`,()=>api(`/admin/demand/outbox/${item.id}/dispatch`,{method:"POST",body:JSON.stringify({actor:"Carbon Desk"})}),"Proposta enviada ao comprador.")}>{buyerOutreach.live?"Enviar proposta":"Envio bloqueado"}</button>}</footer></article>)}{!buyerOutbox.length&&<Empty text="Nenhuma proposta no outbox."/>}</div></DeskCard>
        <DeskCard title="Supply único observado" eyebrow="SUPPLY DESK" count={Array.isArray(summary?.supplyCandidates)?summary.supplyCandidates.length:0}><div className="supply-summary">{(summary?.supplyCandidates||[]).map((item:Json)=><div key={item.candidate_type}><span>{candidateType(item.candidate_type)}</span><strong>{tons(item.tonnes)} t</strong><small>{n(item.count)} fontes econômicas únicas</small></div>)}</div><p className="desk-footnote">Deduplicado entre RFQs por inventário/lead/monitored asset. Sinal de mercado não é seller-confirmed nem claim-ready.</p></DeskCard>
      </div>

      <DeskCard title="Operações corporativas" eyebrow="BASKETS / SETTLEMENT" count={activeBaskets.length}><div className="basket-table-wrap"><table className="desk-table"><thead><tr><th>Empresa</th><th>Volume</th><th>Valor</th><th>Legs</th><th>Reserva</th><th>Pagamento</th><th>Status</th></tr></thead><tbody>{baskets.slice(0,30).map((b)=><tr key={b.id}><td><b>{b.company_name}</b><small>{b.public_code.slice(0,8)}</small></td><td>{tons(n(b.covered_kg)/1000)} t</td><td>{money(b.final_total_brl)}</td><td>{n(b.confirmed_legs)}/{n(b.leg_count)}</td><td>{n(b.active_reservations)>0?`${b.active_reservations} ativa(s)`:"—"}</td><td><Status value={b.payment_status||"not_started"}/></td><td><Status value={b.status}/></td></tr>)}</tbody></table>{!baskets.length&&<Empty text="Nenhum basket corporativo."/>}</div></DeskCard>

      <DeskCard title="Pipeline comprador" eyebrow="DEMAND AUTOPILOT" count={pipeline.length}><div className="pipeline-strip">{pipeline.slice(0,24).map((item,index)=><div key={`${item.account_id||item.accountId}-${index}`}><span>{item.company_name||item.companyName||`Conta #${item.account_id||item.accountId}`}</span><b>{tons(item.target_tonnes??item.targetTonnes)} t</b><Status value={item.proposal_id||item.proposalId?"proposal_ready":item.status}/></div>)}</div></DeskCard>
    </>}
  </main></MarketShell>;
}

function marketSignalConfidence(value:string) {
  return ({marketplace_observed:"Disponibilidade observada no marketplace",marketplace_indicative:"Disponibilidade indicativa",provider_connected_signal:"Provider conectado · disponibilidade a provar"} as Record<string,string>)[value]||label(value);
}

function RfqCandidatePanel({rfq,selections,busy,close,prepare}:{rfq:Json;selections:Json[];busy:string;close:()=>void;prepare:(candidate:SupplyCandidate)=>void}) {
  const candidates:Array<SupplyCandidate>=Array.isArray(rfq.candidates)?rfq.candidates:[];
  return <section className="desk-card supply-candidate-panel"><header><div><span>SUPPLY MATCHING</span><h2>{rfq.company_name} · gap {tons(rfq.gap_tonnes)} t</h2></div><button className="desk-button ghost" onClick={close}>Fechar</button></header>
    <div className="candidate-grid">{candidates.map((c)=>{ const selection=selections.find((s)=>Number(s.candidate_id)===Number(c.id)); const marketSignal=c.candidateType==="market_signal"; const supplier=marketSignal?`Marketplace/provider observado · ${c.registry||"fonte"}`:(c.snapshot?.supplierName||c.snapshot?.supplier_name||`Lead #${c.supplyLeadId||"—"}`); const evidence=c.snapshot?.evidenceUrl||c.snapshot?.sourceUrl; return <article className="supply-candidate" key={c.id}>
      <div className="candidate-head"><div><small>{candidateType(c.candidateType)}</small><b>{c.projectName||c.registryProjectId||"Projeto"}</b><span>{supplier}</span></div><strong>{tons(c.candidateTonnes)} t</strong></div>
      <div className="candidate-tags">{marketSignal?<span className="desk-status warning">{marketSignalConfidence(c.confidence)}</span>:<Status value={c.confidence}/>}<span>score {n(c.sourcingScore)}</span><span>{c.country||"país n/d"}</span><span>vintage {c.vintage||"n/d"}</span></div>
      <div className="claim-warning">AUTO-CLOSE: <b>FALSE</b> · {marketSignal?"sinal observado ≠ estoque confirmado ≠ claim-ready":c.rationale?.claimReady===false?"não claim-ready":"gate claim-ready obrigatório"}</div>
      {marketSignal&&<div className="claim-warning"><b>PRÓXIMO GATE:</b> provar disponibilidade/preço no provider ou identificar holder → originação comercial → eligibility. Este card não representa oferta firme.</div>}
      <footer><small>{c.registry||"registry n/d"} · {c.registryProjectId||"project id n/d"}{c.monitoredAssetId?` · asset #${c.monitoredAssetId}`:""}</small>{marketSignal?<div className="row-actions">{evidence&&<a className="mini-button" href={String(evidence)} target="_blank" rel="noreferrer">Abrir evidência ↗</a>}<span className="desk-status warning">Qualificação obrigatória</span></div>:selection?<Status value={selection.response_id?"supplier_responded":selection.outbox_status||"selected"}/>:<button disabled={!!busy||!c.supplyLeadId} onClick={()=>prepare(c)}>{busy===`prepare-supply-${c.id}`?"Preparando...":"Preparar RFQ fornecedor"}</button>}</footer>
    </article>; })}{!candidates.length&&<Empty text="Nenhum candidato de supply para este RFQ."/>}</div>
  </section>;
}

function SupplySelectionRow({selection,busy,onSubmit}:{selection:Json;busy:string;onSubmit:(body:Json)=>Promise<any>}) {
  const [expanded,setExpanded]=useState(false); const [tonnesValue,setTonnesValue]=useState(String(selection.confirmed_available_tonnes||selection.requested_tonnes||""));
  const [price,setPrice]=useState(String(selection.firm_price_usd_tonne||"")); const [minOrder,setMinOrder]=useState("");
  const [retirement,setRetirement]=useState(Boolean(selection.retirement_supported)); const [beneficiary,setBeneficiary]=useState(false); const [evidence,setEvidence]=useState(""); const [note,setNote]=useState("");
  if(selection.response_id) return <article className="desk-row supply-response-done"><div className="row-main"><div><b>{selection.supplier_name||selection.project_name}</b><small>{selection.registry} · {selection.project_name}</small></div><Status value="seller_confirmed"/></div><div className="row-metrics"><span><small>Confirmado</small><b>{tons(selection.confirmed_available_tonnes)} t</b></span><span><small>Preço</small><b>{selection.firm_price_usd_tonne?`US$ ${tons(selection.firm_price_usd_tonne)}/t`:"—"}</b></span><span><small>Retirement</small><b>{selection.retirement_supported?"sim":"não/n.d."}</b></span></div><div className="claim-warning">Ainda não claim-ready. Elegibilidade e monitored asset continuam obrigatórios.</div></article>;
  return <article className="desk-row"><div className="row-main"><div><b>{selection.supplier_name||selection.project_name}</b><small>{selection.registry} · solicitado {tons(selection.requested_tonnes)} t · outbox {selection.outbox_status||"não criado"}</small></div><button className="mini-button" onClick={()=>setExpanded(!expanded)}>{expanded?"Fechar":"Registrar resposta"}</button></div>{expanded&&<form className="supply-response-form" onSubmit={(e)=>{e.preventDefault(); const body:Json={confirmedAvailableTonnes:n(tonnesValue),retirementSupported:retirement,beneficiaryRetirementSupported:beneficiary,responseNote:note||undefined}; if(price)body.firmPriceUsdTonne=n(price); if(minOrder)body.minOrderTonnes=n(minOrder); if(evidence)body.registryEvidenceUrl=evidence; void onSubmit(body);}}>
    <label>Volume confirmado t<input required type="number" min="0" step="0.001" value={tonnesValue} onChange={(e)=>setTonnesValue(e.target.value)}/></label>
    <label>Preço firme US$/t<input type="number" min="0" step="0.01" value={price} onChange={(e)=>setPrice(e.target.value)}/></label>
    <label>Pedido mínimo t<input type="number" min="0" step="0.001" value={minOrder} onChange={(e)=>setMinOrder(e.target.value)}/></label>
    <label>Evidência registral<input type="url" placeholder="https://" value={evidence} onChange={(e)=>setEvidence(e.target.value)}/></label>
    <label className="check"><input type="checkbox" checked={retirement} onChange={(e)=>setRetirement(e.target.checked)}/> Retirement suportado</label>
    <label className="check"><input type="checkbox" checked={beneficiary} onChange={(e)=>setBeneficiary(e.target.checked)}/> Retirement em nome do beneficiário</label>
    <label className="response-note">Nota<textarea value={note} onChange={(e)=>setNote(e.target.value)} /></label>
    <button disabled={!!busy}>{busy===`response-${selection.id}`?"Registrando...":"Salvar seller-confirmed"}</button>
  </form>}</article>;
}

function BuyerProposal({proposal,label,disabled,action}:{proposal:Proposal;label:string;disabled:boolean;action:()=>Promise<any>|void}) { return <article className="desk-row proposal-row"><div className="row-main"><div><b>{proposal.company_name}</b><small>{proposal.public_code.slice(0,8)} · {proposal.checkout_mode}</small></div><Status value={proposal.review_status||"review_required"}/></div><div className="row-metrics"><span><small>Volume</small><b>{tons(proposal.target_tonnes)} t</b></span><span><small>Cobertura</small><b>{tons(proposal.coverage_pct)}%</b></span><span><small>Valor</small><b>{money(proposal.final_total_brl)}</b></span></div><footer><small>{proposal.contact_email||"Contato sem e-mail"}</small><button disabled={disabled} onClick={()=>void action()}>{label}</button></footer></article>; }
function DeskKpi({label:lbl,value,detail,tone=""}:{label:string;value:string;detail:string;tone?:string}) { return <article className={`desk-kpi ${tone}`}><small>{lbl}</small><strong>{value}</strong><span>{detail}</span></article>; }
function DeskCard({title,eyebrow,count,children}:{title:string;eyebrow:string;count:number;children:any}) { return <section className="desk-card"><header><div><span>{eyebrow}</span><h2>{title}</h2></div><b>{count}</b></header>{children}</section>; }
function Gate({title,live,warn=false,text}:{title:string;live:boolean;warn?:boolean;text:string}) { return <div><span className={warn?"dot warn":live?"dot live":"dot"}/><b>{title}</b><small>{text}</small></div>; }
function Status({value}:{value:string}) { const v=String(value||"unknown").toLowerCase(); const positive=["resolved","proposal_ready","approved","sent","paid","completed","fulfilled","delivered","qualified","seller_confirmed"].some((x)=>v.includes(x)); const warning=["review","required","open","partial","awaiting","pending","failed","contacting"].some((x)=>v.includes(x)); return <span className={`desk-status ${positive?"positive":warning?"warning":""}`}>{label(value)}</span>; }
function Empty({text}:{text:string}) { return <div className="desk-empty">{text}</div>; }
function candidateType(value:string) { return ({mandated_inventory:"Mandato ativo",seller_confirmed:"Seller-confirmed",registry_estimate:"Saldo registral estimado",market_signal:"Sinal de mercado"} as Record<string,string>)[value]||label(value); }
