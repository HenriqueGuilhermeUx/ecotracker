import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { type Asset, dateTime, money, num, type Quote } from "./market-types";

type DataMode = "loading" | "live" | "base";
type QuoteCreation = Pick<Quote, "public_code" | "status" | "final_total" | "quote_expires_at"> & { checkoutReady?: boolean; message?: string };
type CheckoutResponse = {
  provider: string;
  method: "pix" | "card";
  providerReference: string;
  status: string;
  checkoutUrl?: string | null;
  pixBrCode?: string | null;
  qrCodeUrl?: string | null;
  amountBrl: number;
};

const BASE_ASSETS: Asset[] = [
  {
    id: 1, public_code: "regen-marketplace", registry: "Regen Network", project_name: "Eco-créditos do Regen Marketplace",
    source_reference: "regen-marketplace", source_url: "https://app.regen.network/", asset_type: "carbon", quality_tier: "screening",
    description: "Ordens públicas on-chain. Volume, preço e possibilidade de aposentadoria são confirmados antes da cobrança.",
    source_price_usd_ton: null, fx_brl_usd: "5.50", service_margin_pct: "25", fixed_fee_brl: "0", available_tons: null,
    min_order_kg: 100, pricing_mode: "quote", availability_status: "monitoring", source_status: "connected",
    monitor_details: { note: "Aguardando sincronização ao vivo com a Regen Network." }, active: true,
  },
  {
    id: 2, public_code: "ofp-projects", registry: "Open Forest Protocol", project_name: "Projetos de reflorestamento OFP",
    source_reference: "ofp-projects", source_url: "https://www.openforestprotocol.org/", asset_type: "carbon-removal", quality_tier: "premium",
    description: "Projetos florestais com monitoramento digital. O volume e o preço são solicitados ao desenvolvedor do projeto.",
    source_price_usd_ton: null, fx_brl_usd: "5.50", service_margin_pct: "25", fixed_fee_brl: "0", available_tons: null,
    min_order_kg: 1000, pricing_mode: "quote", availability_status: "monitoring", source_status: "manual",
    monitor_details: { note: "Canal de originação e cotação monitorado pelo EcoTracker." }, active: true,
  },
  {
    id: 3, public_code: "coorest-removals", registry: "Coorest Carbon Standard", project_name: "Créditos de remoção Coorest",
    source_reference: "coorest-removals", source_url: "https://coorest.eu/", asset_type: "carbon-removal", quality_tier: "premium",
    description: "Ativos de remoção com monitoramento digital. A fonte, o lote e as condições comerciais são validados antes da proposta.",
    source_price_usd_ton: null, fx_brl_usd: "5.50", service_margin_pct: "25", fixed_fee_brl: "0", available_tons: null,
    min_order_kg: 100, pricing_mode: "quote", availability_status: "monitoring", source_status: "manual",
    monitor_details: { note: "Canal comercial monitorado pelo EcoTracker." }, active: true,
  },
];

export function MarketCatalog() {
  const [assets, setAssets] = useState<Asset[]>(BASE_ASSETS);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [tracking, setTracking] = useState("");
  const [dataMode, setDataMode] = useState<DataMode>("loading");
  const [refreshing, setRefreshing] = useState(false);

  async function loadAssets(force = false) {
    if (force) setRefreshing(true);
    setMessage("");
    try {
      const data = await api<Asset[]>(force ? "/market/refresh" : "/market/assets");
      if (Array.isArray(data) && data.length) {
        setAssets(data);
        setDataMode("live");
      } else {
        setAssets(BASE_ASSETS);
        setDataMode("base");
        setMessage("A API respondeu sem ativos. Exibimos o catálogo-base enquanto a sincronização é refeita.");
      }
    } catch (error) {
      setAssets(BASE_ASSETS);
      setDataMode("base");
      setMessage(`${(error as Error).message} O catálogo-base continua disponível para consulta.`);
    } finally { setRefreshing(false); }
  }

  useEffect(() => {
    void loadAssets();
    const interval = window.setInterval(() => void loadAssets(), 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const categories = useMemo(() => Array.from(new Set(assets.map((asset) => String(asset.asset_type || "carbon")))), [assets]);
  const filtered = useMemo(() => assets.filter((asset) => filter === "all" || String(asset.asset_type || "carbon") === filter), [assets, filter]);
  const latestUpdate = useMemo(() => {
    const dates = assets.map((asset) => asset.last_checked_at ? new Date(asset.last_checked_at).getTime() : 0).filter((value) => value > 0);
    return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  }, [assets]);

  return (
    <MarketShell>
      <main className="market-page">
        <section className="market-hero">
          <div>
            <span className="tag">MARKETPLACE ECOTRACKER / ECOROUTER</span>
            <h1>Créditos ambientais<br /><em>monitorados ao vivo.</em></h1>
            <p>Compare ordens, receba uma cotação e pague por Pix ou cartão. Após a confirmação, o fluxo operacional segue para aquisição, aposentadoria, entrega e documentação.</p>
            <div className="live-status">
              <span className={`source-dot ${dataMode === "live" ? "connected" : "manual"}`} />
              <b>{dataMode === "live" ? "API CONECTADA" : dataMode === "loading" ? "SINCRONIZANDO" : "CATÁLOGO-BASE"}</b>
              <small>{latestUpdate ? `Última leitura: ${dateTime(latestUpdate)}` : "Aguardando primeira leitura"}</small>
              <button onClick={() => void loadAssets(true)} disabled={refreshing}>{refreshing ? "Atualizando..." : "Atualizar agora"}</button>
            </div>
          </div>
          <div className="market-guardrails">
            <b>FLUXO AUTOMATIZADO</b>
            {["01 · Ordem e preço monitorados", "02 · Cotação protegida por prazo", "03 · Pix ou cartão conciliado", "04 · Aquisição e aposentadoria", "05 · ECOT, recibo e documento fiscal"].map((item) => <span key={item}>{item}</span>)}
          </div>
        </section>

        <section className="ecot-explainer">
          <div><small>UNIDADE ECOT</small><strong>1 ECOT</strong><span>= alocação rastreável de 1 kg de CO₂e</span></div>
          <div><small>EQUIVALÊNCIA</small><strong>1.000 ECOT</strong><span>= 1 tCO₂e vinculada a crédito ou aposentadoria identificada</span></div>
          <div><small>PREÇO AO CLIENTE</small><strong>Custo + serviço</strong><span>origem, câmbio, margem, taxa mínima e custo de pagamento</span></div>
        </section>

        <section className="market-controls">
          <div><span className="tag">FONTES DISPONÍVEIS</span><h2>Marketplace e canais monitorados</h2><p>Ofertas individuais da Regen podem gerar preço automático. OFP e Coorest continuam em cotação assistida até disponibilizarem uma execução pública compatível.</p></div>
          <div className="market-filters">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todos</button>
            {categories.map((category) => <button className={filter === category ? "active" : ""} onClick={() => setFilter(category)} key={category}>{category.replaceAll("-", " ")}</button>)}
          </div>
        </section>

        {message && <div className="market-notice">{message}</div>}
        {dataMode === "loading" && <div className="loading-line"><span /> Sincronizando dados com as fontes...</div>}
        <section className="monitored-grid">
          {filtered.map((asset) => <AssetCard key={`${asset.source_reference}-${asset.id}`} asset={asset} canQuote={dataMode === "live"} onQuote={() => setSelected(asset)} />)}
          {!filtered.length && <div className="empty">Nenhuma fonte disponível neste filtro.</div>}
        </section>

        <section className="data-methodology">
          <div><span className="tag">AUTOMAÇÃO COM CONTROLE</span><h2>O dinheiro só avança após confirmação.</h2></div>
          <p><strong>Preço automático:</strong> uma ordem individual com preço convertível gera proposta válida por tempo limitado. A margem EcoTracker e a taxa mínima entram no cálculo.</p>
          <p><strong>Fulfillment:</strong> pagamento aprovado cria jobs auditáveis de aquisição, aposentadoria, entrega, recibo e NFS-e. Etapas sem credencial ficam bloqueadas para ação humana, sem emissão indevida.</p>
        </section>

        <section className="quote-tracker" id="quote-tracker">
          <div><span className="tag">ACOMPANHAR E PAGAR</span><h2>Sua operação EcoTracker</h2><p>Informe o código recebido. O painel atualiza automaticamente durante o processamento.</p></div>
          <Tracker initialCode={tracking} />
        </section>
      </main>

      {selected && <QuoteModal asset={selected} onClose={() => setSelected(null)} onCreated={(code) => {
        setTracking(code);
        setSelected(null);
        window.setTimeout(() => document.getElementById("quote-tracker")?.scrollIntoView({ behavior: "smooth" }), 150);
      }} />}
    </MarketShell>
  );
}

function AssetCard({ asset, canQuote, onQuote }: { asset: Asset; canQuote: boolean; onQuote: () => void }) {
  const pricePerKg = asset.indicative_price_brl_kg == null ? null : Number(asset.indicative_price_brl_kg);
  const pricePerTon = asset.indicative_price_brl_ton == null ? null : Number(asset.indicative_price_brl_ton);
  const tons = asset.available_tons == null ? null : Number(asset.available_tons);
  const details = asset.monitor_details || {};
  const hasPrice = pricePerKg != null && Number.isFinite(pricePerKg) && pricePerKg > 0;
  const liveOrder = Boolean(details.sellOrderId);

  return (
    <article className={`monitored-card ${liveOrder ? "live-order-card" : ""}`}>
      <div className="monitored-top"><span className={`source-dot ${asset.source_status}`} /><span>{asset.registry || "Registry em análise"}</span><b>{liveOrder ? `ordem #${details.sellOrderId}` : asset.source_status === "connected" ? "dados conectados" : "cotação assistida"}</b></div>
      <h3>{asset.project_name || "Ativo ambiental monitorado"}</h3>
      <p>{asset.description || "Fonte ambiental em monitoramento comercial pelo EcoTracker."}</p>
      <div className="asset-tags"><span>{String(asset.asset_type || "carbon").replaceAll("-", " ")}</span><span>{asset.quality_tier || "screening"}</span>{asset.vintage && <span>Vintage {asset.vintage}</span>}{details.autoRetireAvailable && <span>auto-retire</span>}</div>
      <div className="asset-price">
        <small>{hasPrice ? "Referência antes da taxa mínima" : "Preço comercial"}</small>
        <strong>{hasPrice ? `${money(pricePerKg)}/ECOT` : "Cotação sob demanda"}</strong>
        <span>{hasPrice ? `${money(pricePerTon)} por tCO₂e · o total final é calculado ao solicitar` : "Confirmamos projeto, lote e preço antes de cobrar"}</span>
      </div>
      <div className="asset-availability">
        <div><small>Volume monitorado</small><b>{tons != null && Number.isFinite(tons) && tons > 0 ? `${num(tons, 4)} tCO₂e` : "Sob confirmação"}</b></div>
        <div><small>Pedido mínimo</small><b>{num(asset.min_order_kg || 100, 0)} ECOT</b></div>
      </div>
      <div className="live-metrics">
        {details.batchDenom && <span>Lote: <b>{details.batchDenom}</b></span>}
        {typeof details.orderCount === "number" && <span><b>{details.orderCount}</b> ordens públicas</span>}
        {details.askDenoms?.length ? <span>Moedas: <b>{details.askDenoms.join(", ")}</b></span> : null}
      </div>
      <div className="asset-update">Atualização: {dateTime(asset.last_checked_at)}{details.note ? ` · ${details.note}` : ""}</div>
      <div className="asset-actions"><button onClick={onQuote} disabled={!canQuote}>{!canQuote ? "Aguardando API" : hasPrice ? "Cotar e comprar" : "Solicitar cotação"}</button>{asset.source_url && <a href={asset.source_url} target="_blank" rel="noreferrer">Ver fonte ↗</a>}</div>
      <small className="indicative-warning">O preço exibido é referência. A cobrança usa a cotação final registrada e não cria ECOT antes do lastro.</small>
    </article>
  );
}

function QuoteModal({ asset, onClose, onCreated }: { asset: Asset; onClose: () => void; onCreated: (code: string) => void }) {
  const minimum = Number(asset.min_order_kg || 100);
  const recommendation = Math.max(minimum, Number(localStorage.getItem("ecotracker_recommended_kg") || minimum));
  const [form, setForm] = useState({ buyerName: "", buyerEmail: "", buyerPhone: "", companyName: "", taxId: "", requestedKg: String(recommendation), deliveryMode: "email", walletAddress: "", purpose: "neutralization" });
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const indicative = asset.indicative_price_brl_kg == null ? null : Number(asset.indicative_price_brl_kg);
  const estimate = indicative == null || !Number.isFinite(indicative) ? null : indicative * Number(form.requestedKg || 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setMessage("");
    try {
      const response = await api<QuoteCreation>("/market/quotes", { method: "POST", body: JSON.stringify({ ...form, assetId: asset.id, requestedKg: Number(form.requestedKg) }) });
      window.alert(`${response.message || "Cotação registrada"}\n\nCódigo: ${response.public_code}`);
      onCreated(response.public_code);
    } catch (error) { setMessage((error as Error).message); }
    finally { setSending(false); }
  }

  return (
    <div className="quote-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="quote-modal" onSubmit={submit}>
        <button type="button" className="quote-close" onClick={onClose}>×</button>
        <span className="tag">COTAÇÃO PROTEGIDA</span><h2>{asset.project_name}</h2>
        <p>{asset.pricing_mode === "dynamic" ? "A proposta pode ser gerada imediatamente com o preço monitorado. Você só paga depois de visualizar o total final." : "A fonte exige confirmação assistida. Nenhuma cobrança será criada agora."}</p>
        <div className="quote-fields">
          <input required placeholder="Nome completo" value={form.buyerName} onChange={(event) => setForm({ ...form, buyerName: event.target.value })} />
          <input required type="email" placeholder="E-mail" value={form.buyerEmail} onChange={(event) => setForm({ ...form, buyerEmail: event.target.value })} />
          <input placeholder="WhatsApp" value={form.buyerPhone} onChange={(event) => setForm({ ...form, buyerPhone: event.target.value })} />
          <input placeholder="Empresa (opcional)" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
          <input placeholder="CPF/CNPJ para cobrança e documento" value={form.taxId} onChange={(event) => setForm({ ...form, taxId: event.target.value })} />
          <input required type="number" min={minimum} value={form.requestedKg} onChange={(event) => setForm({ ...form, requestedKg: event.target.value })} aria-label="Quantidade de ECOT" />
          <select value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}><option value="neutralization">Neutralização</option><option value="rewards">EcoRewards</option><option value="corporate">Programa corporativo</option><option value="other">Outro uso</option></select>
          <select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}><option value="email">Receber por e-mail</option><option value="wallet">Carteira própria 0x</option></select>
          {form.deliveryMode === "wallet" && <input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x..." value={form.walletAddress} onChange={(event) => setForm({ ...form, walletAddress: event.target.value })} />}
        </div>
        <div className="quote-summary"><span>{num(form.requestedKg, 0)} ECOT = {num(form.requestedKg, 0)} kg CO₂e</span><b>{estimate == null ? "Valor final após confirmação" : `Base monitorada ${money(estimate)}`}</b></div>
        <button disabled={sending}>{sending ? "Calculando..." : asset.pricing_mode === "dynamic" ? "Gerar cotação final" : "Registrar solicitação"}</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
    </div>
  );
}

function Tracker({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode || "");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(target = code) {
    const normalized = target.trim();
    if (!normalized) return;
    setLoading(true);
    try { setQuote(await api<Quote>(`/market/quotes/${normalized}`)); setMessage(""); }
    catch (error) { setMessage((error as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (initialCode) { setCode(initialCode); void load(initialCode); } }, [initialCode]);
  useEffect(() => {
    if (!quote || ["delivered", "cancelled"].includes(quote.status)) return;
    const interval = window.setInterval(() => void load(quote.public_code), 10000);
    return () => window.clearInterval(interval);
  }, [quote?.public_code, quote?.status]);

  async function submit(event: FormEvent) { event.preventDefault(); setQuote(null); setCheckout(null); await load(); }
  async function beginPayment(method: "pix" | "card") {
    if (!quote) return;
    setLoading(true); setMessage("");
    try {
      const result = await api<CheckoutResponse>(`/market/quotes/${quote.public_code}/checkout`, { method: "POST", body: JSON.stringify({ method }) });
      setCheckout(result);
      await load(quote.public_code);
      if (method === "card" && result.checkoutUrl) window.location.assign(result.checkoutUrl);
    } catch (error) { setMessage((error as Error).message); }
    finally { setLoading(false); }
  }

  const paymentReady = quote && quote.final_total && ["quoted", "awaiting_payment"].includes(quote.status) && quote.payment_status !== "paid";
  const pixCode = checkout?.pixBrCode || quote?.pix_br_code;
  const pixQr = checkout?.qrCodeUrl || quote?.pix_qr_code_url;
  const steps = quote ? [
    ["Pagamento", quote.payment_status || "not_started"],
    ["Aquisição", quote.sourcing_status || "not_started"],
    ["Aposentadoria", quote.retirement_status || "not_started"],
    ["Entrega ECOT", quote.delivery_status || "not_started"],
    ["Recibo", quote.receipt_status || "not_started"],
    ["NFS-e", quote.nfse_status || "not_started"],
  ] : [];

  return (
    <form className="tracker-form" onSubmit={submit}>
      <div><input required placeholder="Código UUID da cotação" value={code} onChange={(event) => setCode(event.target.value)} /><button disabled={loading}>{loading ? "Consultando..." : "Consultar"}</button></div>
      {message && <div className="form-msg">{message}</div>}
      {quote && <div className="tracker-result commerce-tracker">
        <span className={`quote-status ${quote.status}`}>{String(quote.status || "requested").replaceAll("_", " ")}</span>
        <h3>{quote.project_name}</h3><p>{num(quote.requested_kg, 0)} ECOT · {num(quote.requested_kg, 0)} kg CO₂e · {quote.registry}</p>
        <b className="tracker-total">{quote.final_total ? `Total: ${money(quote.final_total)}` : quote.indicative_total ? `Estimativa: ${money(quote.indicative_total)}` : "Preço em análise"}</b>
        {quote.quote_expires_at && <small>Cotação válida até {dateTime(quote.quote_expires_at)}</small>}
        <div className="workflow-steps">{steps.map(([label, status]) => <div key={label}><span>{label}</span><b className={`step-${status}`}>{String(status).replaceAll("_", " ")}</b></div>)}</div>
        {paymentReady && <div className="payment-actions"><button type="button" onClick={() => void beginPayment("pix")}>Pagar com Pix</button><button type="button" className="secondary-payment" onClick={() => void beginPayment("card")}>Pagar com cartão</button></div>}
        {pixQr && <div className="pix-box"><img src={pixQr} alt="QR Code Pix" /><div><b>Pix gerado</b><textarea readOnly value={pixCode || ""} /><button type="button" onClick={() => pixCode && navigator.clipboard.writeText(pixCode)}>Copiar código Pix</button>{checkout?.checkoutUrl && <a href={checkout.checkoutUrl} target="_blank" rel="noreferrer">Abrir página de pagamento ↗</a>}</div></div>}
        {quote.payment_status === "paid" && <div className="paid-banner">Pagamento confirmado. A automação operacional está processando as próximas etapas.</div>}
        <div className="document-actions">
          {quote.payment_status === "paid" && <a href={`/api/market/quotes/${quote.public_code}/receipt`} target="_blank" rel="noreferrer">Abrir recibo/comprovante ↗</a>}
          {quote.nfse_url && <a href={quote.nfse_url} target="_blank" rel="noreferrer">Abrir NFS-e ↗</a>}
          {quote.retirement_tx_hash && <span>Tx aposentadoria: {quote.retirement_tx_hash}</span>}
          {quote.delivery_tx_hash && <span>Tx entrega: {quote.delivery_tx_hash}</span>}
        </div>
      </div>}
    </form>
  );
}
