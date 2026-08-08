import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { type Asset, dateOnly, dateTime, type EligibilityCatalog, money, num, type Quote } from "./market-types";

type DataMode = "loading" | "live" | "base";
type Shelf = "verified" | "contribution" | "restricted";
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
    description: "Ordens públicas on-chain em monitoramento. Permanecem como contribuição até a elegibilidade para compensação ser verificada lote a lote.",
    source_price_usd_ton: null, fx_brl_usd: "5.50", service_margin_pct: "25", fixed_fee_brl: "0", available_tons: null,
    min_order_kg: 100, pricing_mode: "quote", availability_status: "monitoring", source_status: "connected",
    monitor_details: { note: "Aguardando sincronização e revisão de elegibilidade." }, active: true,
    claim_category: "climate_contribution", eligibility_status: "restricted", source_unit_status: "unknown",
  },
  {
    id: 2, public_code: "ofp-projects", registry: "Open Forest Protocol", project_name: "Projetos de reflorestamento OFP",
    source_reference: "ofp-projects", source_url: "https://www.openforestprotocol.org/", asset_type: "carbon-removal", quality_tier: "premium",
    description: "Projetos florestais monitorados. Uso como compensação depende da validação específica do lote, metodologia e aposentadoria.",
    source_price_usd_ton: null, fx_brl_usd: "5.50", service_margin_pct: "25", fixed_fee_brl: "0", available_tons: null,
    min_order_kg: 1000, pricing_mode: "quote", availability_status: "monitoring", source_status: "manual",
    monitor_details: { note: "Canal de originação monitorado pelo EcoTracker." }, active: true,
    claim_category: "climate_contribution", eligibility_status: "restricted", source_unit_status: "unknown",
  },
  {
    id: 3, public_code: "coorest-removals", registry: "Coorest Carbon Standard", project_name: "Créditos de remoção Coorest",
    source_reference: "coorest-removals", source_url: "https://coorest.eu/", asset_type: "carbon-removal", quality_tier: "premium",
    description: "Ativos de remoção monitorados. A fonte, o lote e o claim permitido precisam ser validados antes de qualquer compensação.",
    source_price_usd_ton: null, fx_brl_usd: "5.50", service_margin_pct: "25", fixed_fee_brl: "0", available_tons: null,
    min_order_kg: 100, pricing_mode: "quote", availability_status: "monitoring", source_status: "manual",
    monitor_details: { note: "Canal comercial monitorado pelo EcoTracker." }, active: true,
    claim_category: "climate_contribution", eligibility_status: "restricted", source_unit_status: "unknown",
  },
];

const BASE_CATALOG: EligibilityCatalog = { verifiedCompensation: [], climateContribution: BASE_ASSETS, restricted: BASE_ASSETS };

export function MarketCatalog() {
  const [catalog, setCatalog] = useState<EligibilityCatalog>(BASE_CATALOG);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [shelf, setShelf] = useState<Shelf>("verified");
  const [message, setMessage] = useState("");
  const [tracking, setTracking] = useState("");
  const [dataMode, setDataMode] = useState<DataMode>("loading");
  const [refreshing, setRefreshing] = useState(false);

  async function loadAssets(force = false) {
    if (force) setRefreshing(true);
    setMessage("");
    try {
      if (force) await api<Asset[]>("/market/refresh");
      const data = await api<EligibilityCatalog>("/market/catalog/eligibility");
      if (data && Array.isArray(data.verifiedCompensation) && Array.isArray(data.climateContribution)) {
        setCatalog(data);
        setDataMode("live");
      } else {
        setCatalog(BASE_CATALOG);
        setDataMode("base");
        setMessage("A API respondeu sem o catálogo de elegibilidade. Exibimos somente fontes de contribuição enquanto a revisão é refeita.");
      }
    } catch (error) {
      setCatalog(BASE_CATALOG);
      setDataMode("base");
      setMessage(`${(error as Error).message} Nenhum ativo-base será apresentado como compensação.`);
    } finally { setRefreshing(false); }
  }

  useEffect(() => {
    void loadAssets();
    const interval = window.setInterval(() => void loadAssets(), 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const assets = shelf === "verified" ? catalog.verifiedCompensation : shelf === "contribution" ? catalog.climateContribution : catalog.restricted;
  const latestUpdate = useMemo(() => {
    const all = [...catalog.verifiedCompensation, ...catalog.climateContribution, ...catalog.restricted];
    const dates = all.map((asset) => asset.last_checked_at ? new Date(asset.last_checked_at).getTime() : 0).filter((value) => value > 0);
    return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  }, [catalog]);

  return (
    <MarketShell>
      <main className="market-page">
        <section className="market-hero">
          <div>
            <span className="tag">MARKETPLACE ECOTRACKER / ECOROUTER</span>
            <h1>Compense com lastro<br /><em>verificado e rastreável.</em></h1>
            <p>Compensação, contribuição climática e ativos restritos agora ficam em prateleiras separadas. Um lote on-chain só entra como compensação quando status, evidência, aposentadoria e validade comercial estiverem aprovados.</p>
            <div className="live-status">
              <span className={`source-dot ${dataMode === "live" ? "connected" : "manual"}`} />
              <b>{dataMode === "live" ? "ELEGIBILIDADE CONECTADA" : dataMode === "loading" ? "VALIDANDO LOTES" : "MODO SEGURO"}</b>
              <small>{latestUpdate ? `Última leitura: ${dateTime(latestUpdate)}` : "Aguardando primeira leitura"}</small>
              <button onClick={() => void loadAssets(true)} disabled={refreshing}>{refreshing ? "Atualizando..." : "Atualizar agora"}</button>
            </div>
          </div>
          <div className="market-guardrails">
            <b>COMPENSAÇÃO VERIFICADA</b>
            {["01 · Registry e unidade conferidos", "02 · Vintage e validade comercial", "03 · Quantidade realmente aposentável", "04 · Aposentadoria obrigatória", "05 · Evidência e recibo vinculados"].map((item) => <span key={item}>{item}</span>)}
          </div>
        </section>

        <section className="ecot-explainer">
          <div><small>COMPENSAÇÃO</small><strong>{catalog.verifiedCompensation.length} lotes</strong><span>aptos segundo a política comercial EcoTracker</span></div>
          <div><small>CONTRIBUIÇÃO</small><strong>{catalog.climateContribution.length} ativos</strong><span>impacto sem claim automático de offset</span></div>
          <div><small>UNIDADE ECOT</small><strong>1 ECOT</strong><span>= 1 kg de CO₂e alocado; compensação exige aposentadoria elegível</span></div>
        </section>

        <section className="market-controls">
          <div><span className="tag">PRATELEIRAS DE INTEGRIDADE</span><h2>Escolha o tipo de ação climática</h2><p>Vintage não é uma data universal de vencimento. A validade abaixo é uma política comercial do EcoTracker e pode retirar um lote da venda sem afirmar que o registry o declarou expirado.</p></div>
          <div className="market-filters">
            <button className={shelf === "verified" ? "active" : ""} onClick={() => setShelf("verified")}>Compensação verificada ({catalog.verifiedCompensation.length})</button>
            <button className={shelf === "contribution" ? "active" : ""} onClick={() => setShelf("contribution")}>Contribuição ({catalog.climateContribution.length})</button>
            <button className={shelf === "restricted" ? "active" : ""} onClick={() => setShelf("restricted")}>Restritos / histórico ({catalog.restricted.length})</button>
          </div>
        </section>

        {message && <div className="market-notice">{message}</div>}
        {dataMode === "loading" && <div className="loading-line"><span /> Validando elegibilidade e validade dos lotes...</div>}
        <section className="monitored-grid">
          {assets.map((asset) => <AssetCard key={`${asset.source_reference}-${asset.id}`} asset={asset} canQuote={dataMode === "live" && shelf !== "restricted"} onQuote={() => setSelected(asset)} />)}
          {!assets.length && <div className="empty">{shelf === "verified" ? "Nenhum lote está aprovado para compensação neste momento. O EcoTracker não substitui qualidade por disponibilidade." : "Nenhum ativo disponível nesta prateleira."}</div>}
        </section>

        <section className="data-methodology">
          <div><span className="tag">QUALIDADE ANTES DA VENDA</span><h2>“On-chain” não significa “apto a compensar”.</h2></div>
          <p><strong>Compensação verificada:</strong> exige unidade tradable, evidência de origem, aposentadoria executável, revisão vigente e validade comercial futura.</p>
          <p><strong>Contribuição climática:</strong> pode financiar impacto real, mas o comprovante não afirma que emissões foram neutralizadas quando os requisitos de offset não estão satisfeitos.</p>
        </section>

        <section className="quote-tracker" id="quote-tracker">
          <div><span className="tag">ACOMPANHAR E PAGAR</span><h2>Sua operação EcoTracker</h2><p>Informe o código recebido. O painel atualiza automaticamente durante aquisição, aposentadoria e entrega.</p></div>
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
  const verified = asset.claim_category === "voluntary_offset" && asset.eligibility_status === "eligible";
  const contribution = asset.claim_category === "climate_contribution" || asset.claim_category === "ecological_contribution";
  const claimLabel = verified ? "COMPENSAÇÃO VERIFICADA" : contribution ? "CONTRIBUIÇÃO CLIMÁTICA" : "USO RESTRITO";

  return (
    <article className={`monitored-card ${liveOrder ? "live-order-card" : ""}`}>
      <div className="monitored-top"><span className={`source-dot ${asset.source_status}`} /><span>{asset.registry || "Registry em análise"}</span><b>{claimLabel}</b></div>
      <h3>{asset.project_name || "Ativo ambiental monitorado"}</h3>
      <p>{asset.description || "Fonte ambiental em monitoramento comercial pelo EcoTracker."}</p>
      <div className="asset-tags">
        <span>{String(asset.asset_type || "carbon").replaceAll("-", " ")}</span><span>{asset.quality_tier || "screening"}</span>
        {asset.vintage && <span>Vintage {asset.vintage}</span>}
        {asset.source_unit_status && <span>registry: {asset.source_unit_status}</span>}
        {asset.retirement_supported && <span>aposentadoria suportada</span>}
        {asset.fractional_retirement_supported && <span>fracionamento real</span>}
      </div>
      <div className="asset-price">
        <small>{hasPrice ? "Referência antes da taxa mínima" : "Preço comercial"}</small>
        <strong>{hasPrice ? `${money(pricePerKg)}/ECOT` : "Cotação sob demanda"}</strong>
        <span>{hasPrice ? `${money(pricePerTon)} por tCO₂e · o total final é calculado ao solicitar` : "Confirmamos projeto, lote e preço antes de cobrar"}</span>
      </div>
      <div className="asset-availability">
        <div><small>Volume monitorado</small><b>{tons != null && Number.isFinite(tons) && tons > 0 ? `${num(tons, 4)} tCO₂e` : "Sob confirmação"}</b></div>
        <div><small>Validade comercial</small><b>{dateOnly(asset.commercial_valid_until)}</b></div>
      </div>
      <div className="live-metrics">
        {details.batchDenom && <span>Lote: <b>{details.batchDenom}</b></span>}
        {asset.registry_project_id && <span>Projeto: <b>{asset.registry_project_id}</b></span>}
        {asset.retirement_granularity_kg && <span>Aposentadoria: <b>{num(asset.retirement_granularity_kg, 0)} kg</b></span>}
      </div>
      <div className="asset-update">{asset.eligibility_basis || details.note || "Elegibilidade em revisão pelo EcoTracker."}</div>
      <div className="asset-actions"><button onClick={onQuote} disabled={!canQuote}>{!canQuote ? "Indisponível para compra" : verified ? "Cotar compensação" : "Apoiar como contribuição"}</button>{(asset.registry_evidence_url || asset.source_url) && <a href={asset.registry_evidence_url || asset.source_url} target="_blank" rel="noreferrer">Ver evidência ↗</a>}</div>
      <small className="indicative-warning">{verified ? "A compensação só é concluída depois da aposentadoria elegível e rastreável." : "Este ativo não será apresentado como compensação de emissões."}</small>
    </article>
  );
}

function QuoteModal({ asset, onClose, onCreated }: { asset: Asset; onClose: () => void; onCreated: (code: string) => void }) {
  const minimum = Number(asset.min_order_kg || 100);
  const recommendation = Math.max(minimum, Number(localStorage.getItem("ecotracker_recommended_kg") || minimum));
  const verified = asset.claim_category === "voluntary_offset" && asset.eligibility_status === "eligible";
  const fixedPurpose = verified ? "voluntary_offset" : "climate_contribution";
  const [form, setForm] = useState({ buyerName: "", buyerEmail: "", buyerPhone: "", companyName: "", taxId: "", requestedKg: String(recommendation), deliveryMode: "email", walletAddress: "", purpose: fixedPurpose });
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const indicative = asset.indicative_price_brl_kg == null ? null : Number(asset.indicative_price_brl_kg);
  const estimate = indicative == null || !Number.isFinite(indicative) ? null : indicative * Number(form.requestedKg || 0);
  const granularity = Math.max(1, Number(asset.retirement_granularity_kg || 1000));
  const fractionalOk = !verified || asset.fractional_retirement_supported || Number(form.requestedKg || 0) % granularity === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!fractionalOk) { setMessage(`Este lote aposenta somente em blocos de ${num(granularity, 0)} kg.`); return; }
    setSending(true);
    setMessage("");
    try {
      const response = await api<QuoteCreation>("/market/quotes", { method: "POST", body: JSON.stringify({ ...form, purpose: fixedPurpose, assetId: asset.id, requestedKg: Number(form.requestedKg) }) });
      window.alert(`${response.message || "Cotação registrada"}\n\nCódigo: ${response.public_code}`);
      onCreated(response.public_code);
    } catch (error) { setMessage((error as Error).message); }
    finally { setSending(false); }
  }

  return (
    <div className="quote-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="quote-modal" onSubmit={submit}>
        <button type="button" className="quote-close" onClick={onClose}>×</button>
        <span className="tag">{verified ? "COMPENSAÇÃO VERIFICADA" : "CONTRIBUIÇÃO CLIMÁTICA"}</span><h2>{asset.project_name}</h2>
        <p>{verified ? "A finalidade está travada como compensação voluntária e exige aposentadoria elegível antes da entrega final." : "A finalidade está travada como contribuição climática; o comprovante não fará claim de neutralização."}</p>
        <div className="quote-fields">
          <input required placeholder="Nome completo" value={form.buyerName} onChange={(event) => setForm({ ...form, buyerName: event.target.value })} />
          <input required type="email" placeholder="E-mail" value={form.buyerEmail} onChange={(event) => setForm({ ...form, buyerEmail: event.target.value })} />
          <input placeholder="WhatsApp" value={form.buyerPhone} onChange={(event) => setForm({ ...form, buyerPhone: event.target.value })} />
          <input placeholder="Empresa (opcional)" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
          <input placeholder="CPF/CNPJ para cobrança e documento" value={form.taxId} onChange={(event) => setForm({ ...form, taxId: event.target.value })} />
          <input required type="number" min={minimum} step={verified && !asset.fractional_retirement_supported ? granularity : 1} value={form.requestedKg} onChange={(event) => setForm({ ...form, requestedKg: event.target.value })} aria-label="Quantidade de ECOT" />
          <input readOnly value={verified ? "Compensação voluntária" : "Contribuição climática"} aria-label="Finalidade" />
          <select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}><option value="email">Receber por e-mail</option><option value="wallet">Carteira própria 0x</option></select>
          {form.deliveryMode === "wallet" && <input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x..." value={form.walletAddress} onChange={(event) => setForm({ ...form, walletAddress: event.target.value })} />}
        </div>
        <div className="quote-summary"><span>{num(form.requestedKg, 0)} ECOT = {num(form.requestedKg, 0)} kg CO₂e</span><b>{estimate == null ? "Valor final após confirmação" : `Base monitorada ${money(estimate)}`}</b></div>
        {!fractionalOk && <div className="form-msg">Esta fonte aposenta em blocos de {num(granularity, 0)} kg. Ajuste a quantidade ou escolha uma fonte fracionária.</div>}
        <button disabled={sending || !fractionalOk}>{sending ? "Calculando..." : verified ? "Gerar cotação de compensação" : "Registrar contribuição"}</button>
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
        <p><strong>Finalidade:</strong> {quote.claim_category === "voluntary_offset" ? "Compensação voluntária" : "Contribuição climática/ecológica"}</p>
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
