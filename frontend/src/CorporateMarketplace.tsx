import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { type Asset, dateOnly, dateTime, type EligibilityCatalog, money, num, type Quote } from "./market-types";
import "./corporate-public.css";

type Shelf = "verified" | "contribution";
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

const EMPTY: EligibilityCatalog = { verifiedCompensation: [], climateContribution: [], restricted: [] };

function projectNamePt(name: string) {
  return String(name || "Projeto de crédito de carbono")
    .replace(/Solar PV Plant/gi, "Usina Solar Fotovoltaica")
    .replace(/Solar Power Project/gi, "Projeto de Energia Solar")
    .replace(/Wind Power Project/gi, "Projeto de Energia Eólica")
    .replace(/Wind Farm/gi, "Parque Eólico")
    .replace(/Hydroelectric Power Project/gi, "Projeto de Energia Hidrelétrica")
    .replace(/Hydro Power Project/gi, "Projeto Hidrelétrico")
    .replace(/Improved Cookstoves/gi, "Fogões Eficientes")
    .replace(/Forest Conservation/gi, "Conservação Florestal")
    .replace(/Afforestation/gi, "Florestamento")
    .replace(/Reforestation/gi, "Reflorestamento")
    .replace(/Landfill Gas/gi, "Gás de Aterro")
    .replace(/Methane Capture/gi, "Captura de Metano");
}

function methodologyPt(methodology?: string) {
  if (!methodology) return null;
  return methodology
    .replace(/renewable energy/gi, "energia renovável")
    .replace(/solar/gi, "solar")
    .replace(/wind/gi, "eólica")
    .replace(/forestry/gi, "florestal")
    .replace(/forest conservation/gi, "conservação florestal")
    .replace(/afforestation/gi, "florestamento")
    .replace(/reforestation/gi, "reflorestamento")
    .replace(/methane/gi, "metano")
    .replace(/cookstove/gi, "fogão eficiente");
}

function publicDescriptionPt(asset: Asset) {
  const pieces: string[] = [];
  const location = asset.location?.trim();
  pieces.push(location
    ? `Projeto de crédito de carbono localizado em ${location}, registrado no ${asset.registry}.`
    : `Projeto de crédito de carbono registrado no ${asset.registry}.`);
  if (asset.vintage) pieces.push(`Vintage ${asset.vintage}.`);
  const methodology = methodologyPt(asset.methodology);
  if (methodology) pieces.push(`Metodologia: ${methodology}.`);
  if (asset.registry_project_id) pieces.push(`Identificação do projeto no registry: ${asset.registry_project_id}.`);
  if (asset.retirement_supported) pieces.push("O lote suporta aposentadoria para comprovação da destinação dos créditos.");
  pieces.push("A disponibilidade e a elegibilidade comercial são validadas pelo EcoTracker antes da conclusão da operação.");
  return pieces.join(" ");
}

export function CorporateMarketplace() {
  const [catalog, setCatalog] = useState<EligibilityCatalog>(EMPTY);
  const [shelf, setShelf] = useState<Shelf>("verified");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [tracking, setTracking] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setMessage("");
    try {
      const data = await api<EligibilityCatalog>("/market/catalog/eligibility");
      setCatalog(data);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const assets = shelf === "verified" ? catalog.verifiedCompensation : catalog.climateContribution;
  const latest = useMemo(() => {
    const dates = [...catalog.verifiedCompensation, ...catalog.climateContribution]
      .map((asset) => asset.last_checked_at ? new Date(asset.last_checked_at).getTime() : 0)
      .filter((value) => value > 0);
    return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  }, [catalog]);

  return (
    <MarketShell>
      <main className="corp-market">
        <section className="corp-market-hero">
          <div>
            <span className="corp-eyebrow">MARKETPLACE · CRÉDITOS DE CARBONO</span>
            <h1>Escolha créditos pela <em>origem, qualidade e finalidade.</em></h1>
            <p>
              Veja em português as informações que importam para uma compra corporativa: projeto, registry,
              localização, metodologia, vintage, volume, preço, validade e possibilidade de aposentadoria.
            </p>
            <div className="corp-trust-row">
              <span>Origem documentada</span><span>Preço por tCO₂e</span><span>Volume disponível</span><span>Evidência registral</span>
            </div>
          </div>
          <aside className="corp-market-status">
            <small>CATÁLOGO</small>
            <strong>{catalog.verifiedCompensation.length}</strong>
            <span>lotes aptos para compensação</span>
            <b>{latest ? `Atualizado ${dateTime(latest)}` : "Aguardando atualização"}</b>
          </aside>
        </section>

        <section className="corp-market-tabs">
          <div>
            <span>FINALIDADE</span>
            <h2>O que você pretende contratar?</h2>
          </div>
          <div className="corp-tab-buttons">
            <button className={shelf === "verified" ? "active" : ""} onClick={() => setShelf("verified")}>Compensação verificada ({catalog.verifiedCompensation.length})</button>
            <button className={shelf === "contribution" ? "active" : ""} onClick={() => setShelf("contribution")}>Contribuição climática ({catalog.climateContribution.length})</button>
          </div>
        </section>

        {message && <div className="market-notice">{message}</div>}
        {loading && <div className="loading-line"><span /> Carregando e validando créditos...</div>}

        <section className="corp-asset-grid">
          {assets.map((asset) => <CorporateAssetCard key={`${asset.source_reference}-${asset.id}`} asset={asset} onQuote={() => setSelected(asset)} />)}
          {!loading && assets.length === 0 && (
            <div className="corp-empty">
              <b>{shelf === "verified" ? "Nenhum lote está liberado para compensação agora." : "Nenhum ativo de contribuição disponível agora."}</b>
              <p>O EcoTracker não apresenta um crédito como comprável antes de volume, elegibilidade e condições comerciais estarem validados.</p>
            </div>
          )}
        </section>

        <section className="corp-buy-guide">
          <div><small>1</small><b>Escolha o projeto</b><span>Analise origem, registry, vintage e evidências.</span></div>
          <div><small>2</small><b>Solicite a cotação</b><span>Informe empresa, volume e finalidade.</span></div>
          <div><small>3</small><b>Receba as condições</b><span>Preço, total e validade ficam claros antes da contratação.</span></div>
          <div><small>4</small><b>Conclua com evidência</b><span>Compensação exige aposentadoria elegível e rastreável.</span></div>
        </section>

        <section className="quote-tracker" id="quote-tracker">
          <div><span className="tag">ACOMPANHAR OPERAÇÃO</span><h2>Já solicitou uma cotação?</h2><p>Use o código recebido para acompanhar preço, pagamento, aquisição, aposentadoria e entrega.</p></div>
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

function CorporateAssetCard({ asset, onQuote }: { asset: Asset; onQuote: () => void }) {
  const verified = asset.claim_category === "voluntary_offset" && asset.eligibility_status === "eligible";
  const tons = asset.available_tons == null ? null : Number(asset.available_tons);
  const priceTon = asset.indicative_price_brl_ton == null ? null : Number(asset.indicative_price_brl_ton);
  const canQuote = asset.eligibilityDecision?.allowed !== false && asset.source_status !== "degraded";
  return (
    <article className="corp-asset-card">
      <div className="corp-asset-head">
        <span>{asset.registry || "Registry em validação"}</span>
        <b>{verified ? "APTO PARA COMPENSAÇÃO" : "CONTRIBUIÇÃO CLIMÁTICA"}</b>
      </div>
      <h3>{projectNamePt(asset.project_name)}</h3>
      {asset.project_name !== projectNamePt(asset.project_name) && <small className="corp-official-name">Nome oficial: {asset.project_name}</small>}
      <p className="corp-project-summary">{publicDescriptionPt(asset)}</p>

      <div className="corp-asset-facts">
        <div><small>Local</small><b>{asset.location || "Conforme registro do projeto"}</b></div>
        <div><small>Vintage</small><b>{asset.vintage || "Em validação"}</b></div>
        <div><small>Volume</small><b>{tons != null && Number.isFinite(tons) ? `${num(tons, 2)} tCO₂e` : "Sob confirmação"}</b></div>
        <div><small>Preço</small><b>{priceTon != null && Number.isFinite(priceTon) ? `${money(priceTon)}/t` : "Sob cotação"}</b></div>
      </div>

      <div className="corp-asset-meta">
        {asset.methodology && <span>Metodologia: {methodologyPt(asset.methodology)}</span>}
        {asset.commercial_valid_until && <span>Validade comercial: {dateOnly(asset.commercial_valid_until)}</span>}
        {asset.retirement_supported && <span>Aposentadoria suportada</span>}
        {asset.beneficiary_retirement_supported && <span>Beneficiário identificável</span>}
      </div>

      <div className="corp-asset-actions">
        <button onClick={onQuote} disabled={!canQuote}>{canQuote ? "Solicitar cotação" : "Em validação"}</button>
        {(asset.registry_evidence_url || asset.source_url) && <a href={asset.registry_evidence_url || asset.source_url} target="_blank" rel="noreferrer">Ver fonte / evidência ↗</a>}
      </div>
      <small className="corp-asset-note">{verified ? "A compensação só é concluída após aposentadoria elegível e rastreável." : "Este ativo não será apresentado como neutralização de emissões."}</small>
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
  const granularity = Math.max(1, Number(asset.retirement_granularity_kg || 1000));
  const fractionalOk = !verified || asset.fractional_retirement_supported || Number(form.requestedKg || 0) % granularity === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!fractionalOk) { setMessage(`Este lote aposenta somente em blocos de ${num(granularity, 0)} kg.`); return; }
    setSending(true); setMessage("");
    try {
      const response = await api<QuoteCreation>("/market/quotes", { method: "POST", body: JSON.stringify({ ...form, purpose: fixedPurpose, assetId: asset.id, requestedKg: Number(form.requestedKg) }) });
      onCreated(response.public_code);
    } catch (error) { setMessage((error as Error).message); }
    finally { setSending(false); }
  }

  return (
    <div className="quote-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="quote-modal" onSubmit={submit}>
        <button type="button" className="quote-close" onClick={onClose}>×</button>
        <span className="tag">{verified ? "COTAÇÃO DE COMPENSAÇÃO" : "COTAÇÃO DE CONTRIBUIÇÃO"}</span>
        <h2>{projectNamePt(asset.project_name)}</h2>
        <p>Preencha os dados abaixo. O EcoTracker registra a solicitação e mantém a finalidade climática vinculada à elegibilidade do ativo.</p>
        <div className="quote-fields">
          <input required placeholder="Nome do responsável" value={form.buyerName} onChange={(event) => setForm({ ...form, buyerName: event.target.value })} />
          <input required type="email" placeholder="E-mail corporativo" value={form.buyerEmail} onChange={(event) => setForm({ ...form, buyerEmail: event.target.value })} />
          <input placeholder="Telefone / WhatsApp" value={form.buyerPhone} onChange={(event) => setForm({ ...form, buyerPhone: event.target.value })} />
          <input placeholder="Empresa" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
          <input placeholder="CNPJ / CPF" value={form.taxId} onChange={(event) => setForm({ ...form, taxId: event.target.value })} />
          <input required type="number" min={minimum} step={verified && !asset.fractional_retirement_supported ? granularity : 1} value={form.requestedKg} onChange={(event) => setForm({ ...form, requestedKg: event.target.value })} aria-label="Quantidade em kg de CO2e" />
          <input readOnly value={verified ? "Compensação voluntária" : "Contribuição climática"} aria-label="Finalidade" />
          <select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}><option value="email">Receber documentação por e-mail</option><option value="wallet">Carteira própria 0x</option></select>
          {form.deliveryMode === "wallet" && <input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x..." value={form.walletAddress} onChange={(event) => setForm({ ...form, walletAddress: event.target.value })} />}
        </div>
        <div className="quote-summary"><span>{num(form.requestedKg, 0)} kg CO₂e = {num(Number(form.requestedKg || 0) / 1000, 3)} tCO₂e</span><b>Preço final informado na cotação</b></div>
        {!fractionalOk && <div className="form-msg">Este lote exige blocos de {num(granularity, 0)} kg.</div>}
        <button disabled={sending || !fractionalOk}>{sending ? "Registrando..." : "Solicitar cotação"}</button>
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
    ["Pagamento", quote.payment_status || "not_started"], ["Aquisição", quote.sourcing_status || "not_started"],
    ["Aposentadoria", quote.retirement_status || "not_started"], ["Entrega", quote.delivery_status || "not_started"],
  ] : [];

  return (
    <form className="tracker-form" onSubmit={submit}>
      <div><input required placeholder="Código da cotação" value={code} onChange={(event) => setCode(event.target.value)} /><button disabled={loading}>{loading ? "Consultando..." : "Consultar"}</button></div>
      {message && <div className="form-msg">{message}</div>}
      {quote && <div className="tracker-result commerce-tracker">
        <span className={`quote-status ${quote.status}`}>{String(quote.status || "requested").replaceAll("_", " ")}</span>
        <h3>{projectNamePt(quote.project_name)}</h3>
        <p>{num(Number(quote.requested_kg) / 1000, 3)} tCO₂e · {quote.registry}</p>
        <b className="tracker-total">{quote.final_total ? `Total: ${money(quote.final_total)}` : "Preço em validação"}</b>
        {quote.quote_expires_at && <small>Cotação válida até {dateTime(quote.quote_expires_at)}</small>}
        <div className="workflow-steps">{steps.map(([label, status]) => <div key={label}><span>{label}</span><b className={`step-${status}`}>{String(status).replaceAll("_", " ")}</b></div>)}</div>
        {paymentReady && <div className="payment-actions"><button type="button" onClick={() => void beginPayment("pix")}>Pix</button><button type="button" className="secondary-payment" onClick={() => void beginPayment("card")}>Cartão</button></div>}
        {pixQr && <div className="pix-box"><img src={pixQr} alt="QR Code Pix" /><div><b>Pix gerado</b><textarea readOnly value={pixCode || ""} /><button type="button" onClick={() => pixCode && navigator.clipboard.writeText(pixCode)}>Copiar código Pix</button></div></div>}
      </div>}
    </form>
  );
}
