import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { SellDetailDrawer } from "./SellDetailDrawer";
import "./sell-desk.css";

type Json = Record<string, any>;
type Filter = "all" | "ready" | "preparing";
type Selection = { kind: "proposal" | "rfq"; item: Json; account?: Json | null } | null;

const n = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tons = (value: unknown) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n(value));
const brl = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }).format(n(value));
const dateTime = (value: unknown) => value
  ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(String(value)))
  : "—";
const shortDate = (value: unknown) => value
  ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(String(value)))
  : "—";

function purpose(value: unknown) {
  return String(value || "voluntary_offset") === "voluntary_offset" ? "Compensação voluntária" : String(value || "Compensação de emissões");
}

function sourcingStatus(item: Json) {
  if (item.autopilot_status === "provider_capacity_found") return { title: "VALIDAÇÃO FINAL", tone: "positive", text: "O volume faltante foi encontrado e está na última validação antes da oferta." };
  if (item.autopilot_status === "partial_provider_capacity") return { title: "EM COMPOSIÇÃO", tone: "warning", text: "Parte do volume já foi encontrada. O EcoTracker segue compondo a disponibilidade." };
  if (item.autopilot_status === "no_provider_capacity") return { title: "BUSCANDO SUPPLY", tone: "warning", text: "O EcoTracker está consultando o mercado automaticamente." };
  if (item.autopilot_status === "failed") return { title: "REPROCESSANDO", tone: "warning", text: "A última rodada não fechou; o motor tentará novamente." };
  return { title: "EM PREPARAÇÃO", tone: "neutral", text: "Disponibilidade, qualidade e condições comerciais estão sendo consolidadas." };
}

function clientText(proposal: Json) {
  const items = Array.isArray(proposal.items) ? proposal.items : [];
  const assetLines = items.map((item: Json) => {
    const vintage = item.vintage ? ` · vintage ${item.vintage}` : "";
    return `• ${item.projectName || "Projeto"} · ${item.registry || "Registry"}${vintage} · ${tons(item.amountTonnes)} tCO₂e`;
  });
  return [
    "ECOTRACKER — OFERTA DE CRÉDITOS DE CARBONO",
    "",
    `Empresa: ${proposal.company_name || proposal.companyName || "Cliente"}`,
    `Finalidade: ${purpose(proposal.claim_purpose)}`,
    `Volume: ${tons(proposal.target_tonnes)} tCO₂e`,
    `Preço: ${brl(proposal.price_per_tonne_brl)}/tCO₂e`,
    `Valor total: ${brl(proposal.final_total_brl)}`,
    `Validade da oferta: ${dateTime(proposal.expires_at)}`,
    "",
    "Créditos propostos:",
    ...(assetLines.length ? assetLines : ["• Composição validada na proposta comercial."]),
    "",
    "Aposentadoria: os créditos serão aposentados de forma exclusiva para o beneficiário após a contratação, com evidência registral.",
    "Documentação: identificação dos projetos, registry, vintage e evidências ficam vinculadas à operação.",
    "",
    "Condições sujeitas à validade da proposta e ao contrato final.",
  ].join("\n");
}

function accountKey(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR");
}

export function SellDesk() {
  const token = localStorage.getItem("ecotracker_admin_token");
  const [rfqs, setRfqs] = useState<Json[]>([]);
  const [proposals, setProposals] = useState<Json[]>([]);
  const [accounts, setAccounts] = useState<Json[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState("");
  const [busyRfq, setBusyRfq] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selection, setSelection] = useState<Selection>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [rfqData, proposalData, accountData] = await Promise.all([
        api<Json>("/admin/market-maker/rfq-resolution-autopilot?limit=100"),
        api<Json>("/admin/demand/proposals?limit=200"),
        api<Json>("/admin/demand/accounts?limit=500"),
      ]);
      const nextRfqs = Array.isArray(rfqData?.items) ? rfqData.items : [];
      const nextAccounts = Array.isArray(accountData?.items) ? accountData.items : [];
      setRfqs(nextRfqs);
      setAccounts(nextAccounts);

      const shareable = (Array.isArray(proposalData?.items) ? proposalData.items : [])
        .filter((item: Json) => item.review_status === "approved" && item.review_eligible_now === true && n(item.coverage_pct) >= 99.99)
        .slice(0, 50);
      const details = await Promise.all(shareable.map((item: Json) => api<Json>(`/admin/demand/proposals/${item.id}`)));
      setProposals(details);
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const accountByCompany = useMemo(() => {
    const map = new Map<string, Json>();
    accounts.forEach((account) => map.set(accountKey(account.company_name), account));
    return map;
  }, [accounts]);

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const matchesSearch = useCallback((item: Json) => {
    if (!normalizedSearch) return true;
    const account = accountByCompany.get(accountKey(item.company_name));
    return [item.company_name, item.contact_email, account?.contact_email, account?.contact_name, account?.sector]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(normalizedSearch));
  }, [accountByCompany, normalizedSearch]);

  const visibleProposals = useMemo(() => proposals.filter(matchesSearch), [proposals, matchesSearch]);
  const visibleRfqs = useMemo(() => rfqs.filter(matchesSearch), [rfqs, matchesSearch]);

  const totalVolume = useMemo(() => proposals.reduce((sum, item) => sum + n(item.target_tonnes), 0) + rfqs.reduce((sum, item) => sum + n(item.target_tonnes), 0), [proposals, rfqs]);
  const validating = useMemo(() => rfqs.filter((item) => item.autopilot_status === "provider_capacity_found").length, [rfqs]);
  const contactable = useMemo(() => {
    const keys = new Set<string>();
    [...proposals, ...rfqs].forEach((item) => {
      const account = accountByCompany.get(accountKey(item.company_name));
      if (account?.contact_email || item.contact_email) keys.add(accountKey(item.company_name));
    });
    return keys.size;
  }, [proposals, rfqs, accountByCompany]);

  async function copyProposal(proposal: Json) {
    const text = clientText(proposal);
    await navigator.clipboard.writeText(text);
    setCopied(String(proposal.id));
    setMessage("Resumo comercial copiado. Pronto para colar no WhatsApp ou e-mail.");
    window.setTimeout(() => { setCopied(""); setMessage(""); }, 2600);
  }

  function emailProposal(proposal: Json) {
    const account = accountByCompany.get(accountKey(proposal.company_name));
    const email = account?.contact_email || proposal.contact_email;
    if (!email) {
      setMessage("Este cliente ainda não tem e-mail cadastrado.");
      return;
    }
    const subject = `EcoTracker — oferta de ${tons(proposal.target_tonnes)} tCO₂e`;
    window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(clientText(proposal))}`;
  }

  async function runRfq(rfqId: number) {
    setBusyRfq(String(rfqId));
    setMessage("");
    try {
      await api(`/admin/market-maker/rfqs/${rfqId}/resolution-autopilot/run`, { method: "POST", body: "{}" });
      setMessage("EcoTracker assumiu a validação. Você pode continuar trabalhando; o resultado atualiza sozinho.");
      window.setTimeout(() => void load(), 4500);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      window.setTimeout(() => setBusyRfq(""), 1200);
    }
  }

  function openDetails(kind: "proposal" | "rfq", item: Json) {
    setSelection({ kind, item, account: accountByCompany.get(accountKey(item.company_name)) || null });
  }

  if (!token) {
    return <MarketShell><main className="sell-page"><div className="sell-login-note">Entre uma vez na <a href="#carbon-desk">Carbon Desk</a>. Depois volte para <b>Vender</b>.</div></main></MarketShell>;
  }

  return <MarketShell>
    <main className="sell-page">
      <header className="sell-hero">
        <div className="sell-hero-copy">
          <span className="sell-eyebrow">ECOTRACKER · VENDER</span>
          <h1>Vender</h1>
          <p><b>Informação pronta para o cliente</b>, ações rápidas para o ADM e acompanhamento interno sem poluir a visão comercial.</p>
        </div>
        <div className="sell-hero-actions">
          <a className="sell-primary-action" href="#deal-desk">+ Nova ordem</a>
          <button className="sell-secondary-action" onClick={() => void load()}>Atualizar</button>
        </div>
      </header>

      <section className="sell-kpis" aria-label="Resumo comercial">
        <article><span>Prontas para repassar</span><strong>{proposals.length}</strong><small>ofertas validadas</small></article>
        <article><span>Em validação final</span><strong>{validating}</strong><small>quase prontas</small></article>
        <article><span>Demandas em andamento</span><strong>{rfqs.length}</strong><small>sourcing automático</small></article>
        <article><span>Volume em carteira</span><strong>{tons(totalVolume)} t</strong><small>{contactable} clientes com contato</small></article>
      </section>

      <section className="sell-toolbar">
        <label className="sell-search">
          <span>Buscar</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Empresa, contato ou setor…" />
        </label>
        <div className="sell-filter-tabs" role="tablist" aria-label="Filtrar vendas">
          <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todas</button>
          <button className={filter === "ready" ? "active" : ""} onClick={() => setFilter("ready")}>Prontas <b>{proposals.length}</b></button>
          <button className={filter === "preparing" ? "active" : ""} onClick={() => setFilter("preparing")}>Em andamento <b>{rfqs.length}</b></button>
        </div>
      </section>

      {message && <div className="sell-message">{message}</div>}

      {loading ? <div className="sell-loading">Preparando seu cockpit comercial…</div> : <div className="sell-content">
        {(filter === "all" || filter === "ready") && <section className="sell-section">
          <header className="sell-section-head">
            <div><span>PRONTO PARA REPASSAR</span><h2>Ofertas comerciais validadas</h2><p>Preço, volume e composição liberados para contato com o cliente.</p></div>
            <b>{visibleProposals.length}</b>
          </header>

          <div className="sell-card-grid">
            {visibleProposals.map((proposal) => {
              const items = Array.isArray(proposal.items) ? proposal.items : [];
              const account = accountByCompany.get(accountKey(proposal.company_name));
              const email = account?.contact_email || proposal.contact_email;
              return <article className="sell-card ready" key={`proposal-${proposal.id}`}>
                <div className="sell-card-top">
                  <div><span className="sell-status positive">PRONTO PARA CLIENTE</span><h3>{proposal.company_name}</h3><p>{purpose(proposal.claim_purpose)}</p></div>
                  <div className="sell-volume"><small>VOLUME</small><strong>{tons(proposal.target_tonnes)} t</strong></div>
                </div>

                <div className="sell-commercial-metrics">
                  <div><small>Preço / t</small><b>{brl(proposal.price_per_tonne_brl)}</b></div>
                  <div><small>Valor total</small><b>{brl(proposal.final_total_brl)}</b></div>
                  <div><small>Validade</small><b>{shortDate(proposal.expires_at)}</b></div>
                </div>

                <div className="sell-project-preview">
                  <div><small>COMPOSIÇÃO</small><b>{items.length} {items.length === 1 ? "projeto" : "projetos"}</b></div>
                  <div className="sell-project-tags">
                    {items.slice(0, 3).map((item: Json, index: number) => <span key={`${proposal.id}-tag-${index}`}>{item.registry}{item.vintage ? ` · ${item.vintage}` : ""}</span>)}
                    {items.length > 3 && <span>+{items.length - 3}</span>}
                  </div>
                </div>

                <div className="sell-contact-line"><span>{email ? `Contato: ${email}` : "Contato ainda não cadastrado"}</span></div>

                <footer className="sell-card-actions">
                  <button className="sell-primary-action" onClick={() => void copyProposal(proposal)}>{copied === String(proposal.id) ? "Copiado ✓" : "Copiar resumo"}</button>
                  <button className="sell-secondary-action" onClick={() => emailProposal(proposal)} disabled={!email}>Contatar cliente</button>
                  <button className="sell-tertiary-action" onClick={() => openDetails("proposal", proposal)}>Ver detalhes</button>
                </footer>
              </article>;
            })}
            {!visibleProposals.length && <div className="sell-empty-card"><b>Nenhuma oferta pronta agora.</b><span>Quando volume, ativos e preço estiverem válidos, a oferta sobe automaticamente para esta área.</span></div>}
          </div>
        </section>}

        {(filter === "all" || filter === "preparing") && <section className="sell-section">
          <header className="sell-section-head">
            <div><span>EM ANDAMENTO</span><h2>Demandas sendo preparadas</h2><p>Acompanhe sem entrar nas telas técnicas. Abra o detalhe apenas quando quiser entender o que está acontecendo por baixo.</p></div>
            <b>{visibleRfqs.length}</b>
          </header>

          <div className="sell-card-grid preparing-grid">
            {visibleRfqs.map((item) => {
              const status = sourcingStatus(item);
              const target = n(item.target_tonnes);
              const covered = n(item.covered_tonnes);
              const coverage = target > 0 ? Math.max(0, Math.min(100, (covered / target) * 100)) : 0;
              const account = accountByCompany.get(accountKey(item.company_name));
              return <article className="sell-card preparing" key={`rfq-${item.rfq_id}`}>
                <div className="sell-card-top">
                  <div><span className={`sell-status ${status.tone}`}>{status.title}</span><h3>{item.company_name}</h3><p>Solicitação de {tons(item.target_tonnes)} tCO₂e</p></div>
                  <div className="sell-volume"><small>COBERTURA</small><strong>{new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(coverage)}%</strong></div>
                </div>

                <div className="sell-progress"><i style={{ width: `${coverage}%` }} /></div>
                <div className="sell-commercial-metrics compact">
                  <div><small>Solicitado</small><b>{tons(item.target_tonnes)} t</b></div>
                  <div><small>Validado</small><b>{tons(item.covered_tonnes)} t</b></div>
                  <div><small>Falta</small><b>{tons(item.gap_tonnes)} t</b></div>
                </div>
                <p className="sell-status-copy">{status.text}</p>
                <div className="sell-contact-line"><span>{account?.contact_email ? `Contato: ${account.contact_email}` : "Contato disponível no detalhe quando cadastrado"}</span></div>

                <footer className="sell-card-actions">
                  <button className="sell-primary-action" disabled={busyRfq === String(item.rfq_id)} onClick={() => void runRfq(Number(item.rfq_id))}>{busyRfq === String(item.rfq_id) ? "Validando…" : "Acelerar validação"}</button>
                  <button className="sell-tertiary-action" onClick={() => openDetails("rfq", item)}>Acompanhar</button>
                </footer>
              </article>;
            })}
            {!visibleRfqs.length && <div className="sell-empty-card"><b>Nenhuma demanda em andamento.</b><span>Crie uma nova ordem para o EcoTracker assumir o sourcing.</span><a className="sell-primary-action" href="#deal-desk">+ Nova ordem</a></div>}
          </div>
        </section>}
      </div>}
    </main>

    <SellDetailDrawer
      open={Boolean(selection)}
      kind={selection?.kind || null}
      item={selection?.item || null}
      account={selection?.account || null}
      busy={selection?.kind === "rfq" && busyRfq === String(selection.item.rfq_id)}
      onClose={() => setSelection(null)}
      onCopyProposal={copyProposal}
      onRunRfq={runRfq}
    />
  </MarketShell>;
}
