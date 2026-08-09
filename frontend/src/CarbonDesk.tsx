import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import "./carbon-desk.css";

type Json = Record<string, any>;

type Rfq = {
  id:number;
  public_code:string;
  company_name:string;
  status:string;
  target_tonnes:string|number;
  covered_tonnes:string|number;
  gap_tonnes:string|number;
  candidate_count:number;
  candidate_tonnes:string|number;
  priority_score:number;
  claim_purpose:string;
  preferred_country?:string|null;
  updated_at:string;
};

type Proposal = {
  id:number;
  public_code:string;
  company_name:string;
  status:string;
  target_tonnes:string|number;
  coverage_pct:string|number;
  final_total_brl:string|number;
  checkout_mode:string;
  review_status?:string|null;
  outbox_id?:number|null;
  outbox_status?:string|null;
  contact_email?:string|null;
  expires_at?:string|null;
};

type Basket = {
  id:number;
  public_code:string;
  company_name:string;
  status:string;
  payment_status:string;
  covered_kg:string|number;
  final_total_brl:string|number;
  leg_count:number;
  confirmed_legs:number;
  active_reservations:number;
  created_at:string;
};

type PipelineItem = {
  accountId:number;
  company_name?:string;
  companyName?:string;
  status:string;
  target_tonnes?:string|number;
  targetTonnes?:string|number;
  lead_score?:number;
  priority_score?:number;
  proposal_id?:number|null;
  proposalId?:number|null;
  coverage_pct?:string|number;
  proposal_status?:string|null;
};

const n = (value:unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tons = (value:unknown) => new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(n(value));
const money = (value:unknown) => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0}).format(n(value));
const compactMoney = (value:unknown) => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",notation:"compact",maximumFractionDigits:1}).format(n(value));
const dateTime = (value:unknown) => value ? new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(String(value))) : "—";

export function CarbonDesk() {
  const [token,setToken] = useState(localStorage.getItem("ecotracker_admin_token"));
  if (!token) {
    return <DeskLogin onLogin={(next) => {
      localStorage.setItem("ecotracker_admin_token",next);
      setToken(next);
    }} />;
  }
  return <CarbonDeskPanel logout={() => {
    localStorage.removeItem("ecotracker_admin_token");
    setToken(null);
  }} />;
}

function DeskLogin({onLogin}:{onLogin:(token:string)=>void}) {
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [message,setMessage] = useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const response = await api<{token:string}>("/auth/login",{
        method:"POST",body:JSON.stringify({email,password}),
      });
      onLogin(response.token);
    } catch (error) { setMessage((error as Error).message); }
  }
  return (
    <MarketShell>
      <main className="carbon-login">
        <form onSubmit={submit}>
          <span className="tag">CARBON DESK</span>
          <h1>Mesa de carbono</h1>
          <p>Supply, demand, propostas e execução em uma única operação.</p>
          <input required type="email" placeholder="E-mail admin" value={email} onChange={(e)=>setEmail(e.target.value)} />
          <input required type="password" placeholder="Senha" value={password} onChange={(e)=>setPassword(e.target.value)} />
          <button>Entrar</button>
          {message && <div className="desk-error">{message}</div>}
        </form>
      </main>
    </MarketShell>
  );
}

function CarbonDeskPanel({logout}:{logout:()=>void}) {
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState("");
  const [message,setMessage] = useState("");
  const [marketSummary,setMarketSummary] = useState<Json>({});
  const [autopilot,setAutopilot] = useState<Json>({});
  const [pipeline,setPipeline] = useState<PipelineItem[]>([]);
  const [rfqs,setRfqs] = useState<Rfq[]>([]);
  const [proposals,setProposals] = useState<Proposal[]>([]);
  const [outbox,setOutbox] = useState<Json[]>([]);
  const [outreach,setOutreach] = useState<Json>({});
  const [baskets,setBaskets] = useState<Basket[]>([]);
  const [payment,setPayment] = useState<Json>({});

  const load = useCallback(async () => {
    try {
      const [summaryData,autopilotData,pipelineData,rfqData,proposalData,outboxData,outreachData,basketData,paymentData] = await Promise.all([
        api<Json>("/admin/market-maker/summary"),
        api<Json>("/admin/demand/autopilot/status"),
        api<Json>("/admin/demand/autopilot/pipeline?limit=200"),
        api<Json>("/admin/market-maker/rfqs?limit=200"),
        api<Json>("/admin/demand/proposals?limit=200"),
        api<Json>("/admin/demand/outbox?limit=200"),
        api<Json>("/admin/demand/outreach/status"),
        api<Json>("/admin/demand/baskets?limit=200"),
        api<Json>("/admin/demand/basket-payments/status"),
      ]);
      setMarketSummary(summaryData || {});
      setAutopilot(autopilotData || {});
      setPipeline(Array.isArray(pipelineData?.items) ? pipelineData.items : []);
      setRfqs(Array.isArray(rfqData?.items) ? rfqData.items : []);
      setProposals(Array.isArray(proposalData?.items) ? proposalData.items : []);
      setOutbox(Array.isArray(outboxData?.items) ? outboxData.items : []);
      setOutreach(outreachData || {});
      setBaskets(Array.isArray(basketData?.items) ? basketData.items : []);
      setPayment(paymentData || {});
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally { setLoading(false); }
  },[]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(()=>void load(),20000);
    return ()=>window.clearInterval(timer);
  },[load]);

  async function act(key:string,fn:()=>Promise<unknown>,success:string) {
    setBusy(key); setMessage("");
    try { await fn(); setMessage(success); await load(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  const openRfqs = useMemo(()=>rfqs.filter((r)=>["open","partially_sourced"].includes(r.status)),[rfqs]);
  const reviewQueue = useMemo(()=>proposals.filter((p)=>p.status==="draft" && !p.review_status),[proposals]);
  const approvedQueue = useMemo(()=>proposals.filter((p)=>p.status==="draft" && p.review_status==="approved" && !p.outbox_id),[proposals]);
  const readyOutbox = useMemo(()=>outbox.filter((o)=>o.status==="ready"),[outbox]);
  const activeBaskets = useMemo(()=>baskets.filter((b)=>!["completed","cancelled"].includes(b.status)),[baskets]);
  const proposalValue = useMemo(()=>reviewQueue.reduce((sum,p)=>sum+n(p.final_total_brl),0),[reviewQueue]);

  return (
    <MarketShell>
      <main className="carbon-desk">
        <header className="desk-head">
          <div>
            <span className="tag">ECOTRACKER MARKET MAKER</span>
            <h1>Carbon Desk</h1>
            <p>Demanda, sourcing, propostas e execução corporativa.</p>
          </div>
          <div className="desk-head-actions">
            <a className="desk-button ghost" href="#market-admin">Commerce OS</a>
            <button className="desk-button ghost" onClick={()=>void load()}>Recarregar</button>
            <button className="desk-button primary" disabled={!!busy} onClick={()=>void act(
              "autopilot",
              ()=>api("/admin/demand/autopilot/run",{method:"POST"}),
              "Demand Autopilot executado: oportunidades, matching e RFQs atualizados.",
            )}>{busy==="autopilot" ? "Rodando..." : "Rodar Demand Autopilot"}</button>
            <button className="desk-button ghost" onClick={logout}>Sair</button>
          </div>
        </header>

        {message && <div className="desk-notice">{message}</div>}
        {loading ? <div className="desk-loading">Carregando mesa de operações...</div> : <>
          <section className="desk-kpis">
            <DeskKpi label="Gap aberto" value={`${tons(marketSummary?.rfqs?.open_gap_tonnes)} t`} detail={`${n(marketSummary?.rfqs?.open_rfqs)} RFQs`} tone="alert" />
            <DeskKpi label="Pipeline alvo" value={`${tons(marketSummary?.rfqs?.open_target_tonnes)} t`} detail="demanda ainda em sourcing" />
            <DeskKpi label="Propostas p/ revisão" value={String(reviewQueue.length)} detail={compactMoney(proposalValue)} tone="money" />
            <DeskKpi label="Outbox pronto" value={String(readyOutbox.length)} detail={outreach.live ? "envio live habilitado" : "envio live bloqueado"} tone={outreach.live ? "money" : "safe"} />
            <DeskKpi label="Baskets ativos" value={String(activeBaskets.length)} detail={payment.live ? "pagamento live" : "pagamento live OFF"} tone={payment.live ? "alert" : "safe"} />
            <DeskKpi label="RFQs resolvidos" value={String(n(marketSummary?.rfqs?.resolved_rfqs))} detail="cobertura claim-ready encontrada" tone="money" />
          </section>

          <section className="desk-safety">
            <div><span className={autopilot.live ? "dot live" : "dot"}/><b>Demand worker</b><small>{autopilot.live ? "recorrente ativo" : "manual / recorrente off"}</small></div>
            <div><span className={outreach.live ? "dot live" : "dot"}/><b>Outreach</b><small>{outreach.live ? "e-mail live" : "bloqueado por feature gate"}</small></div>
            <div><span className={payment.live ? "dot warn" : "dot"}/><b>Basket Payment</b><small>{payment.live ? "LIVE" : "desligado"}</small></div>
            <div><span className="dot live"/><b>Claim gate</b><small>RFQ só fecha com ativo elegível</small></div>
          </section>

          <div className="desk-grid two">
            <DeskCard title="Gaps de demanda / RFQs" eyebrow="BUY-SIDE → SOURCING" count={openRfqs.length}>
              <div className="desk-list">
                {openRfqs.map((rfq)=><RfqRow key={rfq.id} rfq={rfq} busy={busy} refresh={()=>act(
                  `rfq-${rfq.id}`,
                  ()=>api(`/admin/market-maker/rfqs/${rfq.id}/refresh`,{method:"POST"}),
                  `RFQ ${rfq.public_code.slice(0,8)} atualizado contra o Supply Desk.`,
                )} />)}
                {!openRfqs.length && <Empty text="Nenhum gap de sourcing aberto." />}
              </div>
            </DeskCard>

            <DeskCard title="Fila comercial" eyebrow="PROPOSTAS" count={reviewQueue.length + approvedQueue.length}>
              <div className="desk-list">
                {reviewQueue.map((proposal)=><ProposalRow key={proposal.id} proposal={proposal} mode="review" busy={busy} action={()=>act(
                  `approve-${proposal.id}`,
                  ()=>api(`/admin/demand/proposals/${proposal.id}/review/approve`,{method:"POST",body:JSON.stringify({note:"Aprovada pela Carbon Desk"})}),
                  `Proposta ${proposal.public_code.slice(0,8)} aprovada e snapshot comercial congelado.`,
                )} />)}
                {approvedQueue.map((proposal)=><ProposalRow key={proposal.id} proposal={proposal} mode="outbox" busy={busy} action={()=>act(
                  `outbox-${proposal.id}`,
                  ()=>api(`/admin/demand/proposals/${proposal.id}/outbox`,{method:"POST",body:JSON.stringify({})}),
                  `Outbox da proposta ${proposal.public_code.slice(0,8)} criado.`,
                )} />)}
                {!reviewQueue.length && !approvedQueue.length && <Empty text="Nenhuma proposta aguardando decisão comercial." />}
              </div>
            </DeskCard>
          </div>

          <div className="desk-grid two">
            <DeskCard title="Supply candidato" eyebrow="SUPPLY DESK" count={Array.isArray(marketSummary?.supplyCandidates) ? marketSummary.supplyCandidates.length : 0}>
              <div className="supply-summary">
                {(marketSummary?.supplyCandidates || []).map((item:Json)=><div key={item.candidate_type}>
                  <span>{candidateLabel(item.candidate_type)}</span>
                  <strong>{tons(item.tonnes)} t</strong>
                  <small>{n(item.count)} candidatos</small>
                </div>)}
                {!(marketSummary?.supplyCandidates || []).length && <Empty text="Nenhum candidato de supply ligado a RFQs." />}
              </div>
              <p className="desk-footnote">Mandato, seller-confirmed e saldo registral são inteligência de sourcing. Nenhum deles encerra uma demanda até virar ativo claim-ready no catálogo.</p>
            </DeskCard>

            <DeskCard title="Outbox comercial" eyebrow="OUTREACH" count={readyOutbox.length}>
              <div className="desk-list">
                {outbox.slice(0,10).map((item)=><OutboxRow key={item.id} item={item} live={Boolean(outreach.live)} busy={busy} dispatch={()=>act(
                  `dispatch-${item.id}`,
                  ()=>api(`/admin/demand/outbox/${item.id}/dispatch`,{method:"POST",body:JSON.stringify({actor:"Carbon Desk"})}),
                  `Proposta enviada para ${item.recipient_email}.`,
                )} />)}
                {!outbox.length && <Empty text="Nenhuma mensagem comercial preparada." />}
              </div>
            </DeskCard>
          </div>

          <DeskCard title="Operações corporativas" eyebrow="BASKETS / SETTLEMENT" count={activeBaskets.length}>
            <div className="basket-table-wrap"><table className="desk-table">
              <thead><tr><th>Empresa</th><th>Volume</th><th>Valor</th><th>Legs</th><th>Reserva</th><th>Pagamento</th><th>Status</th></tr></thead>
              <tbody>{baskets.slice(0,30).map((basket)=><tr key={basket.id}>
                <td><b>{basket.company_name}</b><small>{basket.public_code.slice(0,8)}</small></td>
                <td>{tons(n(basket.covered_kg)/1000)} t</td>
                <td>{money(basket.final_total_brl)}</td>
                <td>{n(basket.confirmed_legs)}/{n(basket.leg_count)}</td>
                <td>{n(basket.active_reservations)>0 ? `${basket.active_reservations} ativa(s)` : "—"}</td>
                <td><Status value={basket.payment_status || "not_started"}/></td>
                <td><Status value={basket.status}/></td>
              </tr>)}</tbody>
            </table>{!baskets.length && <Empty text="Nenhum basket corporativo criado." />}</div>
          </DeskCard>

          <DeskCard title="Pipeline comprador" eyebrow="DEMAND AUTOPILOT" count={pipeline.length}>
            <div className="pipeline-strip">
              {pipeline.slice(0,20).map((item,index)=><div key={`${item.accountId}-${index}`}>
                <span>{item.company_name || item.companyName || `Conta #${item.accountId}`}</span>
                <b>{tons(item.target_tonnes ?? item.targetTonnes)} t</b>
                <Status value={item.proposal_id || item.proposalId ? "proposal_ready" : item.status}/>
              </div>)}
              {!pipeline.length && <Empty text="O Demand Autopilot ainda não materializou oportunidades." />}
            </div>
          </DeskCard>
        </>}
      </main>
    </MarketShell>
  );
}

function DeskKpi({label,value,detail,tone=""}:{label:string;value:string;detail:string;tone?:string}) {
  return <article className={`desk-kpi ${tone}`}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function DeskCard({title,eyebrow,count,children}:{title:string;eyebrow:string;count:number;children:React.ReactNode}) {
  return <section className="desk-card"><header><div><span>{eyebrow}</span><h2>{title}</h2></div><b>{count}</b></header>{children}</section>;
}

function RfqRow({rfq,busy,refresh}:{rfq:Rfq;busy:string;refresh:()=>void}) {
  const coverage = n(rfq.target_tonnes)>0 ? Math.min(100,n(rfq.covered_tonnes)/n(rfq.target_tonnes)*100) : 0;
  return <article className="desk-row rfq-row">
    <div className="row-main"><div><b>{rfq.company_name}</b><small>{rfq.claim_purpose} · prioridade {rfq.priority_score}</small></div><Status value={rfq.status}/></div>
    <div className="coverage"><i style={{width:`${coverage}%`}}/></div>
    <div className="row-metrics"><span><small>Target</small><b>{tons(rfq.target_tonnes)} t</b></span><span><small>Coberto</small><b>{tons(rfq.covered_tonnes)} t</b></span><span className="gap"><small>Gap</small><b>{tons(rfq.gap_tonnes)} t</b></span><span><small>Candidatos</small><b>{n(rfq.candidate_count)}</b></span></div>
    <footer><small>{tons(rfq.candidate_tonnes)} t candidatos · atualizado {dateTime(rfq.updated_at)}</small><button disabled={!!busy} onClick={refresh}>{busy===`rfq-${rfq.id}` ? "Atualizando..." : "Atualizar Supply"}</button></footer>
  </article>;
}

function ProposalRow({proposal,mode,busy,action}:{proposal:Proposal;mode:"review"|"outbox";busy:string;action:()=>void}) {
  const key = mode==="review" ? `approve-${proposal.id}` : `outbox-${proposal.id}`;
  return <article className="desk-row proposal-row">
    <div className="row-main"><div><b>{proposal.company_name}</b><small>{proposal.public_code.slice(0,8)} · {proposal.checkout_mode}</small></div><Status value={mode==="review" ? "review_required" : "approved"}/></div>
    <div className="row-metrics"><span><small>Volume</small><b>{tons(proposal.target_tonnes)} t</b></span><span><small>Cobertura</small><b>{tons(proposal.coverage_pct)}%</b></span><span><small>Proposta</small><b>{money(proposal.final_total_brl)}</b></span></div>
    <footer><small>{proposal.contact_email || "Contato sem e-mail"} {proposal.expires_at ? `· vence ${dateTime(proposal.expires_at)}` : ""}</small><button disabled={!!busy || (mode==="outbox" && !proposal.contact_email)} onClick={action}>{busy===key ? "Processando..." : mode==="review" ? "Aprovar snapshot" : "Criar outbox"}</button></footer>
  </article>;
}

function OutboxRow({item,live,busy,dispatch}:{item:Json;live:boolean;busy:string;dispatch:()=>void}) {
  return <article className="desk-row outbox-row">
    <div className="row-main"><div><b>{item.company_name || item.recipient_name || item.recipient_email}</b><small>{item.recipient_email}</small></div><Status value={item.status}/></div>
    <p>{item.subject}</p>
    <footer><small>{item.provider_reference ? `provider ${item.provider_reference}` : `tentativas ${n(item.attempts)}`}</small>{item.status==="ready" && <button disabled={!live || !!busy} title={!live ? "Outreach live está bloqueado por feature gate" : "Enviar proposta"} onClick={dispatch}>{!live ? "Envio bloqueado" : busy===`dispatch-${item.id}` ? "Enviando..." : "Enviar agora"}</button>}</footer>
  </article>;
}

function Status({value}:{value:string}) {
  const normalized = String(value || "unknown").toLowerCase();
  const positive = ["resolved","proposal_ready","approved","sent","paid","completed","fulfilled_climate","delivered","quoted","reserved"].some((v)=>normalized.includes(v));
  const warning = ["review","required","open","partial","awaiting","pending","failed"].some((v)=>normalized.includes(v));
  return <span className={`desk-status ${positive ? "positive" : warning ? "warning" : ""}`}>{String(value || "—").replaceAll("_"," ")}</span>;
}

function Empty({text}:{text:string}) { return <div className="desk-empty">{text}</div>; }

function candidateLabel(value:string) {
  return ({mandated_inventory:"Mandato ativo",seller_confirmed:"Seller-confirmed",registry_estimate:"Saldo registral estimado"} as Record<string,string>)[value] || value;
}
