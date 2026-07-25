import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { type Asset, dateTime, money, num, type Quote } from "./market-types";

type QuoteStatus = Pick<
  Quote,
  "public_code" | "requested_kg" | "delivery_mode" | "indicative_total" | "final_total" | "status" | "quote_expires_at" | "registry" | "project_name" | "created_at"
>;

type DataMode = "loading" | "live" | "base";

const BASE_ASSETS: Asset[] = [
  {
    id: 1,
    public_code: "regen-marketplace",
    registry: "Regen Network",
    project_name: "Eco-créditos do Regen Marketplace",
    source_reference: "regen-marketplace",
    source_url: "https://app.regen.network/",
    asset_type: "carbon",
    quality_tier: "screening",
    description: "Ordens públicas on-chain. Volume, preço e possibilidade de aposentadoria são confirmados antes da cobrança.",
    source_price_usd_ton: null,
    fx_brl_usd: "5.50",
    service_margin_pct: "25",
    fixed_fee_brl: "0",
    available_tons: null,
    min_order_kg: 100,
    pricing_mode: "quote",
    availability_status: "monitoring",
    source_status: "connected",
    monitor_details: { note: "Aguardando sincronização ao vivo com a Regen Network." },
    active: true,
  },
  {
    id: 2,
    public_code: "ofp-projects",
    registry: "Open Forest Protocol",
    project_name: "Projetos de reflorestamento OFP",
    source_reference: "ofp-projects",
    source_url: "https://www.openforestprotocol.org/",
    asset_type: "carbon-removal",
    quality_tier: "premium",
    description: "Projetos florestais com monitoramento digital. O volume e o preço são solicitados ao desenvolvedor do projeto.",
    source_price_usd_ton: null,
    fx_brl_usd: "5.50",
    service_margin_pct: "25",
    fixed_fee_brl: "0",
    available_tons: null,
    min_order_kg: 1000,
    pricing_mode: "quote",
    availability_status: "monitoring",
    source_status: "manual",
    monitor_details: { note: "Canal de originação e cotação monitorado pelo EcoTracker." },
    active: true,
  },
  {
    id: 3,
    public_code: "coorest-removals",
    registry: "Coorest Carbon Standard",
    project_name: "Créditos de remoção Coorest",
    source_reference: "coorest-removals",
    source_url: "https://coorest.eu/",
    asset_type: "carbon-removal",
    quality_tier: "premium",
    description: "Ativos de remoção com monitoramento digital. A fonte, o lote e as condições comerciais são validados antes da proposta.",
    source_price_usd_ton: null,
    fx_brl_usd: "5.50",
    service_margin_pct: "25",
    fixed_fee_brl: "0",
    available_tons: null,
    min_order_kg: 100,
    pricing_mode: "quote",
    availability_status: "monitoring",
    source_status: "manual",
    monitor_details: { note: "Canal comercial monitorado pelo EcoTracker." },
    active: true,
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
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadAssets();
    const interval = window.setInterval(() => void loadAssets(), 5 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(assets.map((asset) => String(asset.asset_type || "carbon")))),
    [assets],
  );

  const filtered = useMemo(
    () => assets.filter((asset) => filter === "all" || String(asset.asset_type || "carbon") === filter),
    [assets, filter],
  );

  const latestUpdate = useMemo(() => {
    const dates = assets
      .map((asset) => asset.last_checked_at ? new Date(asset.last_checked_at).getTime() : 0)
      .filter((value) => value > 0);
    return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  }, [assets]);

  return (
    <MarketShell>
      <main className="market-page">
        <section className="market-hero">
          <div>
            <span className="tag">MARKETPLACE ECOTRACKER / ECOROUTER</span>
            <h1>Créditos ambientais<br /><em>monitorados ao vivo.</em></h1>
            <p>Compare registries, acompanhe disponibilidade pública e solicite uma cotação. O EcoTracker confirma a ordem, o preço, o lote e a regra de aposentadoria antes de qualquer cobrança.</p>
            <div className="live-status">
              <span className={`source-dot ${dataMode === "live" ? "connected" : "manual"}`} />
              <b>{dataMode === "live" ? "API CONECTADA" : dataMode === "loading" ? "SINCRONIZANDO" : "CATÁLOGO-BASE"}</b>
              <small>{latestUpdate ? `Última leitura: ${dateTime(latestUpdate)}` : "Aguardando primeira leitura"}</small>
              <button onClick={() => void loadAssets(true)} disabled={refreshing}>{refreshing ? "Atualizando..." : "Atualizar agora"}</button>
            </div>
          </div>
          <div className="market-guardrails">
            <b>FLUXO PROTEGIDO</b>
            {["01 · Dados públicos monitorados", "02 · Cotação executável confirmada", "03 · Pagamento autorizado", "04 · Aquisição e aposentadoria", "05 · ECOT alocado e comprovado"].map((item) => <span key={item}>{item}</span>)}
          </div>
        </section>

        <section className="ecot-explainer">
          <div>
            <small>UNIDADE ECOT</small>
            <strong>1 ECOT</strong>
            <span>= alocação rastreável de 1 kg de CO₂e</span>
          </div>
          <div>
            <small>EQUIVALÊNCIA</small>
            <strong>1.000 ECOT</strong>
            <span>= 1 tCO₂e vinculada a um crédito ou aposentadoria identificada</span>
          </div>
          <div>
            <small>VALOR EM REAIS</small>
            <strong>Dinâmico</strong>
            <span>depende do projeto, vintage, registry, câmbio, taxas e disponibilidade</span>
          </div>
        </section>

        <section className="market-controls">
          <div>
            <span className="tag">FONTES DISPONÍVEIS</span>
            <h2>Ativos e canais monitorados</h2>
            <p>Dados públicos são atualizados periodicamente. “Monitorado” não significa estoque próprio nem garantia de execução pelo preço exibido.</p>
          </div>
          <div className="market-filters">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todos</button>
            {categories.map((category) => (
              <button className={filter === category ? "active" : ""} onClick={() => setFilter(category)} key={category}>
                {category.replaceAll("-", " ")}
              </button>
            ))}
          </div>
        </section>

        {message && <div className="market-notice">{message}</div>}
        {dataMode === "loading" && <div className="loading-line"><span /> Sincronizando dados com as fontes...</div>}

        <section className="monitored-grid">
          {filtered.map((asset) => <AssetCard key={`${asset.source_reference}-${asset.id}`} asset={asset} onQuote={() => setSelected(asset)} />)}
          {!filtered.length && <div className="empty">Nenhuma fonte disponível neste filtro.</div>}
        </section>

        <section className="data-methodology">
          <div>
            <span className="tag">O QUE É TEMPO REAL AQUI?</span>
            <h2>Transparência antes da promessa.</h2>
          </div>
          <p><strong>Regen Network:</strong> ordens e volumes são lidos diretamente da infraestrutura pública on-chain. O preço em reais é apenas referência até validarmos denominação, liquidez e execução.</p>
          <p><strong>OFP e Coorest:</strong> ainda não oferecem ao EcoTracker um book público executável equivalente. Mostramos os canais e confirmamos preço e lote diretamente com a fonte.</p>
        </section>

        <section className="quote-tracker">
          <div>
            <span className="tag">ACOMPANHAR SOLICITAÇÃO</span>
            <h2>Já pediu uma cotação?</h2>
            <p>Informe o código recebido para consultar o andamento.</p>
          </div>
          <Tracker initialCode={tracking} />
        </section>
      </main>

      {selected && (
        <QuoteModal
          asset={selected}
          onClose={() => setSelected(null)}
          onCreated={(code) => {
            setTracking(code);
            setSelected(null);
          }}
        />
      )}
    </MarketShell>
  );
}

function AssetCard({ asset, onQuote }: { asset: Asset; onQuote: () => void }) {
  const pricePerKg = asset.indicative_price_brl_kg == null ? null : Number(asset.indicative_price_brl_kg);
  const pricePerTon = asset.indicative_price_brl_ton == null ? null : Number(asset.indicative_price_brl_ton);
  const tons = asset.available_tons == null ? null : Number(asset.available_tons);
  const assetType = String(asset.asset_type || "carbon");
  const sourceStatus = String(asset.source_status || "manual");
  const details = asset.monitor_details || {};
  const hasPrice = pricePerKg != null && Number.isFinite(pricePerKg) && pricePerKg > 0;

  return (
    <article className="monitored-card">
      <div className="monitored-top">
        <span className={`source-dot ${sourceStatus}`} />
        <span>{asset.registry || "Registry em análise"}</span>
        <b>{sourceStatus === "connected" ? "dados conectados" : sourceStatus === "degraded" ? "fonte indisponível" : "cotação assistida"}</b>
      </div>
      <h3>{asset.project_name || "Ativo ambiental monitorado"}</h3>
      <p>{asset.description || "Fonte ambiental em monitoramento comercial pelo EcoTracker."}</p>
      <div className="asset-tags">
        <span>{assetType.replaceAll("-", " ")}</span>
        <span>{asset.quality_tier || "screening"}</span>
        {asset.location && <span>{asset.location}</span>}
        {asset.vintage && <span>Vintage {asset.vintage}</span>}
      </div>
      <div className="asset-price">
        <small>{hasPrice ? "Referência indicativa por ECOT" : "Preço comercial"}</small>
        <strong>{hasPrice ? `${money(pricePerKg)}/ECOT` : "Cotação sob demanda"}</strong>
        <span>{hasPrice ? `${money(pricePerTon)} por tCO₂e · 1 ECOT = 1 kg` : "Confirmamos projeto, lote e preço antes de cobrar"}</span>
      </div>
      <div className="asset-availability">
        <div>
          <small>Volume monitorado</small>
          <b>{tons != null && Number.isFinite(tons) && tons > 0 ? `${num(tons, 4)} tCO₂e` : "Sob confirmação"}</b>
        </div>
        <div>
          <small>Pedido mínimo</small>
          <b>{num(asset.min_order_kg || 100, 0)} ECOT</b>
        </div>
      </div>
      <div className="live-metrics">
        {typeof details.orderCount === "number" && <span><b>{details.orderCount}</b> ordens públicas</span>}
        {typeof details.pricingOrderCount === "number" && <span><b>{details.pricingOrderCount}</b> com preço convertido</span>}
        {details.askDenoms?.length ? <span>Moedas: <b>{details.askDenoms.join(", ")}</b></span> : null}
      </div>
      <div className="asset-update">Atualização: {dateTime(asset.last_checked_at)}{details.note ? ` · ${details.note}` : ""}</div>
      <div className="asset-actions">
        <button onClick={onQuote}>Solicitar cotação</button>
        {asset.source_url && <a href={asset.source_url} target="_blank" rel="noreferrer">Ver fonte ↗</a>}
      </div>
      <small className="indicative-warning">Referência informativa. Não é oferta executável, promessa de estoque ou recomendação de investimento.</small>
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
      const response = await api<{ public_code: string }>("/market/quotes", { method: "POST", body: JSON.stringify({ ...form, assetId: asset.id, requestedKg: Number(form.requestedKg) }) });
      onCreated(response.public_code);
      window.alert(`Cotação registrada. Guarde o código: ${response.public_code}`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="quote-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="quote-modal" onSubmit={submit}>
        <button type="button" className="quote-close" onClick={onClose}>×</button>
        <span className="tag">SOLICITAÇÃO SEM COBRANÇA</span>
        <h2>{asset.project_name}</h2>
        <p>Você solicita {form.requestedKg || 0} ECOT, equivalentes à alocação pretendida de {form.requestedKg || 0} kg de CO₂e. Primeiro confirmaremos lote, preço, prazo e forma de aposentadoria.</p>
        <div className="quote-fields">
          <input required placeholder="Nome completo" value={form.buyerName} onChange={(event) => setForm({ ...form, buyerName: event.target.value })} />
          <input required type="email" placeholder="E-mail" value={form.buyerEmail} onChange={(event) => setForm({ ...form, buyerEmail: event.target.value })} />
          <input placeholder="WhatsApp" value={form.buyerPhone} onChange={(event) => setForm({ ...form, buyerPhone: event.target.value })} />
          <input placeholder="Empresa (opcional)" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
          <input placeholder="CPF/CNPJ (opcional)" value={form.taxId} onChange={(event) => setForm({ ...form, taxId: event.target.value })} />
          <input required type="number" min={minimum} value={form.requestedKg} onChange={(event) => setForm({ ...form, requestedKg: event.target.value })} aria-label="Quantidade de ECOT" />
          <select value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}><option value="neutralization">Neutralização</option><option value="rewards">EcoRewards</option><option value="corporate">Programa corporativo</option><option value="other">Outro uso</option></select>
          <select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}><option value="email">Receber por e-mail</option><option value="wallet">Carteira própria 0x</option></select>
          {form.deliveryMode === "wallet" && <input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x..." value={form.walletAddress} onChange={(event) => setForm({ ...form, walletAddress: event.target.value })} />}
        </div>
        <div className="quote-summary"><span>{num(form.requestedKg, 0)} ECOT = {num(form.requestedKg, 0)} kg CO₂e</span><b>{estimate == null ? "Valor sob consulta" : `Estimativa ${money(estimate)}`}</b></div>
        <button disabled={sending}>{sending ? "Registrando..." : "Registrar solicitação"}</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
    </div>
  );
}

function Tracker({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode || "");
  const [quote, setQuote] = useState<QuoteStatus | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { if (initialCode) setCode(initialCode); }, [initialCode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setQuote(null);
    try { setQuote(await api<QuoteStatus>(`/market/quotes/${code.trim()}`)); }
    catch (error) { setMessage((error as Error).message); }
  }

  return (
    <form className="tracker-form" onSubmit={submit}>
      <div><input required placeholder="Código UUID da cotação" value={code} onChange={(event) => setCode(event.target.value)} /><button>Consultar</button></div>
      {message && <div className="form-msg">{message}</div>}
      {quote && <div className="tracker-result"><span className={`quote-status ${quote.status}`}>{String(quote.status || "requested").replaceAll("_", " ")}</span><h3>{quote.project_name}</h3><p>{num(quote.requested_kg, 0)} ECOT · {num(quote.requested_kg, 0)} kg CO₂e · {quote.registry}</p><b>{quote.final_total ? `Proposta final: ${money(quote.final_total)}` : quote.indicative_total ? `Estimativa: ${money(quote.indicative_total)}` : "Preço em análise"}</b></div>}
    </form>
  );
}
