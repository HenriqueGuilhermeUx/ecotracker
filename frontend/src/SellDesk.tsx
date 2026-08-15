import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import "./carbon-desk.css";

type Json = Record<string, any>;
const n = (value: unknown) => { const parsed = Number(value || 0); return Number.isFinite(parsed) ? parsed : 0; };
const tons = (value: unknown) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n(value));
const usd = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n(value));
const dateTime = (value: unknown) => value ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(String(value))) : "—";

function verdict(item: Json) {
  if (item.rfq_status === "resolved" || item.autopilot_status === "already_covered") return { title: "PRONTO PARA PROPOSTA", tone: "safe", text: "O Matching Engine já cobre 100% com supply claim-ready." };
  if (item.autopilot_status === "provider_capacity_found") return { title: "SUPPLY ENCONTRADO", tone: "money", text: "O provider aceitou volume suficiente para fechar o gap. Falta uma única revisão final de elegibilidade/comercial; não há mais probes manuais para você fazer." };
  if (item.autopilot_status === "partial_provider_capacity") return { title: "AINDA NÃO FECHA", tone: "alert", text: "O EcoTracker encontrou parte do supply, mas continua faltando volume provado." };
  if (item.autopilot_status === "no_provider_capacity") return { title: "NÃO FECHA AGORA", tone: "alert", text: "Nenhum candidato automatizado provou volume suficiente neste ciclo." };
  if (item.autopilot_status === "failed") return { title: "AUTOPILOT COM ERRO", tone: "alert", text: "O motor tentará novamente; você não precisa testar listings manualmente." };
  return { title: "ECOTRACKER PROCURANDO", tone: "", text: "O sourcing autopilot roda em background e testa os providers automaticamente." };
}

export function SellDesk() {
  const token = localStorage.getItem("ecotracker_admin_token");
  const [items, setItems] = useState<Json[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api<Json>("/admin/market-maker/rfq-resolution-autopilot?limit=100");
      setItems(Array.isArray(data?.items) ? data.items : []);
      setMessage("");
    } catch (error) { setMessage((error as Error).message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run(rfqId: number) {
    setBusy(String(rfqId)); setMessage("");
    try {
      await api(`/admin/market-maker/rfqs/${rfqId}/resolution-autopilot/run`, { method: "POST", body: "{}" });
      await load();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  if (!token) return <MarketShell><main className="carbon-desk"><div className="desk-notice">Entre uma vez na <a href="#carbon-desk">Carbon Desk</a>. Depois volte para <b>Vender</b>.</div></main></MarketShell>;

  return <MarketShell><main className="carbon-desk">
    <header className="desk-head">
      <div><span className="tag">ECOTRACKER SELL DESK</span><h1>Eu só quero vender</h1><p>Você traz a demanda. O motor resolve o sourcing técnico.</p></div>
      <div className="desk-head-actions"><a className="desk-button ghost" href="#deal-desk">Nova ordem</a><button className="desk-button ghost" onClick={() => void load()}>Recarregar</button></div>
    </header>

    <div className="supply-integrity-banner"><b>SEM CAÇA A LISTING</b><span>O EcoTracker testa Carbonmark e os candidatos conectados em background, busca a capacidade máxima cotável e monta legs. Nenhum order, pagamento ou retirement é criado por este processo.</span></div>
    {message && <div className="desk-notice">{message}</div>}
    {loading ? <div className="desk-loading">EcoTracker está procurando supply...</div> : <section className="desk-list">
      {items.map((item) => {
        const v = verdict(item);
        const quotableT = n(item.provider_quotable_kg) / 1000;
        const remainingT = n(item.remaining_kg) / 1000;
        const potentialT = n(item.covered_tonnes) + quotableT;
        const summary = item.summary || {};
        return <article className="desk-row rfq-row" key={item.rfq_id}>
          <div className="row-main"><div><b>{item.company_name}</b><small>RFQ #{item.rfq_id} · alvo {tons(item.target_tonnes)} t</small></div><span className={`status-${v.tone || "open"}`}>{v.title}</span></div>
          <div className="row-metrics">
            <span><small>Claim-ready hoje</small><b>{tons(item.covered_tonnes)} t</b></span>
            <span><small>Provider provou</small><b>{tons(quotableT)} t</b></span>
            <span><small>Potencial coberto</small><b>{tons(potentialT)} t</b></span>
            <span className="gap"><small>Ainda falta</small><b>{tons(remainingT || item.gap_tonnes)} t</b></span>
          </div>
          <p>{v.text}</p>
          {n(item.total_cost_usdc) > 0 && <div className="row-metrics"><span><small>Custo provider do gap</small><b>{usd(item.total_cost_usdc)}</b></span><span><small>Custo médio provider</small><b>{usd(item.avg_cost_usdc_tonne)}/t</b></span><span><small>Legs encontradas</small><b>{Array.isArray(summary.legs) ? summary.legs.length : "—"}</b></span></div>}
          <footer><small>Último ciclo: {dateTime(item.completed_at)} · produção continua bloqueada</small><div className="row-actions"><button disabled={!!busy} onClick={() => void run(Number(item.rfq_id))}>{busy === String(item.rfq_id) ? "EcoTracker resolvendo..." : "Resolver agora"}</button></div></footer>
        </article>;
      })}
      {!items.length && <div className="empty">Nenhum RFQ com gap aberto. Quando entrar uma demanda, o autopilot assume o sourcing.</div>}
    </section>}
  </main></MarketShell>;
}
