import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import {
  type Asset,
  type AutomationJob,
  type CommerceDashboard,
  dateTime,
  money,
  num,
  type Quote,
} from "./market-types";

type AdminTab = "overview" | "quotes" | "assets" | "jobs";

export function MarketAdmin() {
  const [token, setToken] = useState(localStorage.getItem("ecotracker_admin_token"));
  if (!token) {
    return <Login onLogin={(nextToken) => {
      localStorage.setItem("ecotracker_admin_token", nextToken);
      setToken(nextToken);
    }} />;
  }
  return <Panel logout={() => {
    localStorage.removeItem("ecotracker_admin_token");
    setToken(null);
  }} />;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const response = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onLogin(response.token);
    } catch (error) { setMessage((error as Error).message); }
  }

  return (
    <MarketShell>
      <main className="market-admin-login">
        <form onSubmit={submit}>
          <span className="tag">OPERAÇÃO COMERCIAL</span>
          <h1>EcoRouter Admin</h1>
          <input required type="email" placeholder="E-mail" value={email} onChange={(event) => setEmail(event.target.value)} />
          <input required type="password" placeholder="Senha" value={password} onChange={(event) => setPassword(event.target.value)} />
          <button>Entrar</button>
          {message && <div className="form-msg">{message}</div>}
        </form>
      </main>
    </MarketShell>
  );
}

function Panel({ logout }: { logout: () => void }) {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [dashboard, setDashboard] = useState<CommerceDashboard | null>(null);
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      const [assetData, quoteData, dashboardData, jobData] = await Promise.all([
        api<Asset[]>("/admin/market/assets"),
        api<Quote[]>("/admin/market/quotes"),
        api<CommerceDashboard>("/admin/commerce/dashboard"),
        api<AutomationJob[]>("/admin/commerce/jobs"),
      ]);
      setAssets(Array.isArray(assetData) ? assetData : []);
      setQuotes(Array.isArray(quoteData) ? quoteData : []);
      setDashboard(dashboardData);
      setJobs(Array.isArray(jobData) ? jobData : []);
      setMessage("");
    } catch (error) { setMessage((error as Error).message); }
  }

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(interval);
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await api("/admin/market/refresh", { method: "POST" });
      await load();
      setMessage("Fontes, câmbio, ordens e preços atualizados.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setRefreshing(false); }
  }

  return (
    <MarketShell>
      <main className="market-admin-page">
        <div className="market-admin-head">
          <div><span className="tag">ECOROUTER COMMERCE OS</span><h1>Operação e resultado</h1></div>
          <div>
            <button className="secondary-admin" onClick={() => void load()}>Recarregar</button>
            <button className="secondary-admin" onClick={refresh}>{refreshing ? "Atualizando..." : "Atualizar mercado"}</button>
            <button className="secondary-admin" onClick={logout}>Sair</button>
          </div>
        </div>
        <div className="market-admin-tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Financeiro</button>
          <button className={tab === "quotes" ? "active" : ""} onClick={() => setTab("quotes")}>Operações ({quotes.length})</button>
          <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>Ativos ({assets.length})</button>
          <button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>Automações ({jobs.length})</button>
          <a href="#admin">Admin de lastro →</a>
        </div>
        {message && <div className="notice">{message}</div>}
        {tab === "overview" && <Overview dashboard={dashboard} quotes={quotes} />}
        {tab === "quotes" && <Quotes quotes={quotes} reload={load} />}
        {tab === "assets" && <Assets assets={assets} reload={load} />}
        {tab === "jobs" && <Jobs jobs={jobs} reload={load} />}
      </main>
    </MarketShell>
  );
}

function Overview({ dashboard, quotes }: { dashboard: CommerceDashboard | null; quotes: Quote[] }) {
  if (!dashboard) return <div className="empty">Carregando indicadores...</div>;
  const pending = quotes.filter((quote) => !["delivered", "cancelled"].includes(quote.status)).length;
  return (
    <section className="commerce-overview">
      <div className="commerce-kpis">
        <Kpi label="Receita recebida" value={money(dashboard.paid_revenue_brl)} />
        <Kpi label="Custo dos ativos" value={money(dashboard.source_cost_brl)} />
        <Kpi label="Taxas de pagamento" value={money(dashboard.payment_fees_brl)} />
        <Kpi label="Reserva tributária" value={money(dashboard.tax_reserve_brl)} />
        <Kpi label="Lucro líquido estimado" value={money(dashboard.estimated_net_profit_brl)} featured />
        <Kpi label="ECOT entregues" value={num(dashboard.delivered_ecot, 0)} />
        <Kpi label="Pedidos pagos" value={num(dashboard.paid_orders, 0)} />
        <Kpi label="Operações em aberto" value={num(pending, 0)} />
      </div>
      <div className="provider-section">
        <div><span className="tag">CONEXÕES</span><h2>Prontidão da automação</h2><p>Verde significa que a credencial ou executor está configurado no Render.</p></div>
        <div className="provider-grid">
          {Object.entries(dashboard.providers).map(([provider, enabled]) => (
            <div className={enabled ? "provider-ready" : "provider-missing"} key={provider}>
              <span />
              <b>{providerLabel(provider)}</b>
              <small>{enabled ? "configurado" : "aguardando configuração"}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="job-summary">
        <h2>Filas de automação</h2>
        <div>{dashboard.jobs.map((job) => <span key={job.status}><b>{job.total}</b> {job.status}</span>)}</div>
      </div>
    </section>
  );
}

function Kpi({ label, value, featured = false }: { label: string; value: string; featured?: boolean }) {
  return <article className={featured ? "kpi-card featured" : "kpi-card"}><small>{label}</small><strong>{value}</strong></article>;
}

const providerLabel = (value: string) => ({
  woovi: "Pix · Woovi",
  mercadoPago: "Cartão · Mercado Pago",
  sourceExecutor: "Aquisição do ativo",
  retirementExecutor: "Aposentadoria",
  deliveryExecutor: "Entrega on-chain",
  email: "E-mail transacional",
  nfse: "Emissor NFS-e",
}[value] || value);

function Quotes({ quotes, reload }: { quotes: Quote[]; reload: () => void }) {
  return (
    <section className="quote-admin-list">
      {quotes.map((quote) => <QuoteCard key={quote.id} quote={quote} reload={reload} />)}
      {!quotes.length && <div className="empty">Nenhuma solicitação ainda.</div>}
    </section>
  );
}

function QuoteCard({ quote, reload }: { quote: Quote; reload: () => void }) {
  const [status, setStatus] = useState(quote.status || "requested");
  const [sourceCost, setSourceCost] = useState(quote.source_cost_brl || "");
  const [finalTotal, setFinalTotal] = useState(quote.final_total || "");
  const [expires, setExpires] = useState("60");
  const [notes, setNotes] = useState(quote.admin_notes || "");
  const [reference, setReference] = useState("");
  const [txHash, setTxHash] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function run(task: () => Promise<unknown>, success: string) {
    setSaving(true); setMessage("");
    try { await task(); setMessage(success); await reload(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }

  async function savePrice() {
    await run(() => api(`/admin/market/quotes/${quote.id}/reprice`, {
      method: "POST",
      body: JSON.stringify({ sourceCostBrl: Number(sourceCost), finalTotalBrl: Number(finalTotal), expiresInMinutes: Number(expires) }),
    }), "Preço, custo e lucro atualizados.");
  }

  async function saveStatus() {
    await run(() => api(`/admin/market/quotes/${quote.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, adminNotes: notes }),
    }), "Status e observações salvos.");
  }

  async function completeStage(stage: "sourcing" | "retirement" | "delivery") {
    await run(() => api(`/admin/market/quotes/${quote.id}/workflow`, {
      method: "POST",
      body: JSON.stringify({ stage, reference: reference || undefined, txHash: txHash || undefined }),
    }), `Etapa ${stage} concluída e próxima etapa acionada.`);
  }

  const grossProfit = quote.gross_profit_brl ?? (quote.final_total && quote.source_cost_brl ? String(Number(quote.final_total) - Number(quote.source_cost_brl)) : null);

  return (
    <article className="quote-admin-card commerce-quote-card">
      <div className="quote-admin-title">
        <div><span>{quote.registry}</span><h3>{quote.project_name}</h3><small>{quote.public_code}</small></div>
        <div className="quote-admin-amount"><b>{num(quote.requested_kg, 0)} ECOT</b><small>{money(quote.final_total)}</small></div>
      </div>
      <div className="quote-person">
        <strong>{quote.buyer_name}</strong>
        <span>{quote.buyer_email}{quote.buyer_phone ? ` · ${quote.buyer_phone}` : ""}</span>
        <span>{quote.company_name || "Pessoa física"} · {quote.delivery_mode}</span>
      </div>
      <div className="quote-status-grid">
        <Status label="Pagamento" value={quote.payment_status || "not_started"} />
        <Status label="Aquisição" value={quote.sourcing_status || "not_started"} />
        <Status label="Aposentadoria" value={quote.retirement_status || "not_started"} />
        <Status label="Entrega" value={quote.delivery_status || "not_started"} />
        <Status label="Recibo" value={quote.receipt_status || "not_started"} />
        <Status label="NFS-e" value={quote.nfse_status || "not_started"} />
      </div>
      <div className="quote-financials">
        <span><small>Receita</small><b>{money(quote.final_total)}</b></span>
        <span><small>Custo</small><b>{money(quote.source_cost_brl)}</b></span>
        <span><small>Lucro bruto</small><b>{money(grossProfit)}</b></span>
        <span><small>Taxas</small><b>{money(quote.payment_fee_brl)}</b></span>
        <span><small>Reserva fiscal</small><b>{money(quote.tax_reserve_brl)}</b></span>
        <span><small>Lucro estimado</small><b>{money(quote.net_profit_brl)}</b></span>
      </div>
      <div className="quote-price-editor">
        <label>Custo confirmado R$<input type="number" min="0" step="0.01" value={sourceCost} onChange={(event) => setSourceCost(event.target.value)} /></label>
        <label>Preço final R$<input type="number" min="0.01" step="0.01" value={finalTotal} onChange={(event) => setFinalTotal(event.target.value)} /></label>
        <label>Validade em minutos<input type="number" min="5" max="1440" value={expires} onChange={(event) => setExpires(event.target.value)} /></label>
        <button disabled={saving || !sourceCost || !finalTotal} onClick={() => void savePrice()}>Salvar preço e liberar pagamento</button>
      </div>
      <div className="quote-admin-fields">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {["requested", "reviewing", "quoted", "awaiting_payment", "sourcing", "retired", "delivered", "cancelled"].map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
        </select>
        <textarea placeholder="Notas internas" value={notes} onChange={(event) => setNotes(event.target.value)} />
        <button disabled={saving} onClick={() => void saveStatus()}>Salvar status</button>
      </div>
      <div className="manual-workflow">
        <input placeholder="Referência externa / serial / ID" value={reference} onChange={(event) => setReference(event.target.value)} />
        <input placeholder="Hash da transação (opcional)" value={txHash} onChange={(event) => setTxHash(event.target.value)} />
        <button disabled={saving || quote.payment_status !== "paid"} onClick={() => void completeStage("sourcing")}>Confirmar aquisição</button>
        <button disabled={saving || quote.payment_status !== "paid"} onClick={() => void completeStage("retirement")}>Confirmar aposentadoria</button>
        <button disabled={saving || quote.payment_status !== "paid"} onClick={() => void completeStage("delivery")}>Confirmar entrega</button>
      </div>
      {quote.quote_expires_at && <small className="quote-expiry">Cotação válida até {dateTime(quote.quote_expires_at)}</small>}
      {message && <div className="form-msg">{message}</div>}
    </article>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return <div><small>{label}</small><b className={`status-${value}`}>{value.replaceAll("_", " ")}</b></div>;
}

function Jobs({ jobs, reload }: { jobs: AutomationJob[]; reload: () => void }) {
  const [message, setMessage] = useState("");
  async function retry(job: AutomationJob) {
    try {
      await api(`/admin/commerce/jobs/${job.id}/retry`, { method: "POST" });
      setMessage(`Job ${job.job_type} reenfileirado.`);
      await reload();
    } catch (error) { setMessage((error as Error).message); }
  }
  return (
    <section className="jobs-section">
      <div className="jobs-intro"><h2>Filas auditáveis</h2><p>Jobs bloqueados não emitem ativos. Configure o provedor ou conclua a etapa manualmente na operação.</p></div>
      {message && <div className="form-msg">{message}</div>}
      <div className="jobs-table">
        {jobs.map((job) => (
          <div className="job-row" key={job.id}>
            <div><b>{job.job_type}</b><small>{job.quote_code}</small></div>
            <span className={`job-${job.status}`}>{job.status}</span>
            <span>{job.attempts}/{job.max_attempts} tentativas</span>
            <span>{job.last_error || dateTime(job.created_at)}</span>
            <button disabled={!['blocked', 'retry'].includes(job.status)} onClick={() => void retry(job)}>Tentar novamente</button>
          </div>
        ))}
        {!jobs.length && <div className="empty">Nenhum job criado ainda.</div>}
      </div>
    </section>
  );
}

function Assets({ assets, reload }: { assets: Asset[]; reload: () => void }) {
  return <section><NewAsset reload={reload} /><div className="asset-admin-list">{assets.map((asset) => <AdminAssetCard key={asset.id} asset={asset} reload={reload} />)}</div></section>;
}

function NewAsset({ reload }: { reload: () => void }) {
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api("/admin/market/assets", { method: "POST", body: JSON.stringify({
        ...data,
        sourcePriceUsdTon: data.sourcePriceUsdTon ? Number(data.sourcePriceUsdTon) : null,
        minOrderKg: Number(data.minOrderKg || 100), fxBrlUsd: Number(data.fxBrlUsd || 5.5),
        serviceMarginPct: Number(data.serviceMarginPct || 25), fixedFeeBrl: Number(data.fixedFeeBrl || 0),
        pricingMode: data.sourcePriceUsdTon ? "dynamic" : "quote", availabilityStatus: "monitoring", sourceStatus: "manual", active: true,
      }) });
      form.reset(); setMessage("Fonte adicionada."); await reload();
    } catch (error) { setMessage((error as Error).message); }
  }
  return (
    <form className="new-asset-form" onSubmit={submit}>
      <h2>Adicionar fonte ou projeto</h2>
      <input name="registry" required placeholder="Registry" /><input name="projectName" required placeholder="Nome comercial" />
      <input name="sourceReference" required placeholder="Referência única" /><input name="sourceUrl" type="url" placeholder="URL da origem" />
      <input name="assetType" defaultValue="carbon" placeholder="Tipo" /><input name="qualityTier" defaultValue="screening" placeholder="Tier" />
      <input name="sourcePriceUsdTon" type="number" min="0" step="0.0001" placeholder="Preço USD/t (opcional)" />
      <input name="fxBrlUsd" type="number" min="0" step="0.0001" defaultValue="5.5" />
      <input name="serviceMarginPct" type="number" min="0" step="0.01" defaultValue="25" />
      <input name="fixedFeeBrl" type="number" min="0" step="0.01" defaultValue="0" placeholder="Taxa fixa R$" />
      <input name="minOrderKg" type="number" min="1" defaultValue="100" /><textarea name="description" placeholder="Descrição" />
      <button>Adicionar</button>{message && <div className="form-msg">{message}</div>}
    </form>
  );
}

function AdminAssetCard({ asset, reload }: { asset: Asset; reload: () => void }) {
  const [price, setPrice] = useState(asset.source_price_usd_ton || "");
  const [fx, setFx] = useState(asset.fx_brl_usd || "5.5");
  const [margin, setMargin] = useState(asset.service_margin_pct || "25");
  const [fixedFee, setFixedFee] = useState(asset.fixed_fee_brl || "0");
  const [available, setAvailable] = useState(asset.available_tons || "");
  const [status, setStatus] = useState(asset.availability_status || "monitoring");
  const [active, setActive] = useState(Boolean(asset.active));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    setSaving(true); setMessage("");
    try {
      await api(`/admin/market/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify({
        sourcePriceUsdTon: price ? Number(price) : null, fxBrlUsd: Number(fx), serviceMarginPct: Number(margin),
        fixedFeeBrl: Number(fixedFee), availableTons: available ? Number(available) : null,
        availabilityStatus: status, pricingMode: price ? "dynamic" : "quote", active,
      }) });
      setMessage("Ativo atualizado."); await reload();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  }
  return (
    <article className="asset-admin-card">
      <div><span>{asset.registry}</span><h3>{asset.project_name}</h3><small>{asset.source_reference} · {asset.source_status} · {dateTime(asset.last_checked_at)}</small></div>
      <div className="asset-admin-fields">
        <label>USD/t<input type="number" min="0" step="0.0001" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
        <label>USD/BRL<input type="number" min="0" step="0.0001" value={fx} onChange={(event) => setFx(event.target.value)} /></label>
        <label>Margem %<input type="number" min="0" step="0.01" value={margin} onChange={(event) => setMargin(event.target.value)} /></label>
        <label>Taxa fixa R$<input type="number" min="0" step="0.01" value={fixedFee} onChange={(event) => setFixedFee(event.target.value)} /></label>
        <label>Disponível t<input type="number" min="0" step="0.000001" value={available} onChange={(event) => setAvailable(event.target.value)} /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as Asset["availability_status"])}><option value="monitoring">monitoring</option><option value="indicative">indicative</option><option value="confirmed">confirmed</option></select></label>
        <label className="checkbox-label"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Ativo</label>
        <button disabled={saving} onClick={() => void save()}>{saving ? "Salvando..." : "Salvar"}</button>
      </div>
      <div className="admin-price-preview">Preço público base: <b>{asset.indicative_price_brl_kg ? `${money(asset.indicative_price_brl_kg)}/ECOT` : "sob consulta"}</b></div>
      {message && <div className="form-msg">{message}</div>}
    </article>
  );
}
