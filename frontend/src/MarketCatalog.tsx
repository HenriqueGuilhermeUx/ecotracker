import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { type Asset, dateTime, money, num, type Quote } from "./market-types";

type QuoteStatus = Pick<
  Quote,
  "public_code" | "requested_kg" | "delivery_mode" | "indicative_total" | "final_total" | "status" | "quote_expires_at" | "registry" | "project_name" | "created_at"
>;

export function MarketCatalog() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [tracking, setTracking] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api<Asset[]>("/market/assets")
      .then((data) => {
        if (!active) return;
        setAssets(Array.isArray(data) ? data : []);
      })
      .catch((error: Error) => active && setMessage(error.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(assets.map((asset) => String(asset.asset_type || "carbon")))),
    [assets],
  );

  const filtered = useMemo(
    () => assets.filter((asset) => filter === "all" || String(asset.asset_type || "carbon") === filter),
    [assets, filter],
  );

  return (
    <MarketShell>
      <main className="market-page">
        <section className="market-hero">
          <div>
            <span className="tag">ECOROUTER / CATÁLOGO MULTI-REGISTRY</span>
            <h1>Impacto ambiental<br /><em>sob demanda.</em></h1>
            <p>Monitore fontes, compare características e solicite uma cotação. O EcoTracker confirma disponibilidade, preço e regras do registry antes de qualquer cobrança.</p>
          </div>
          <div className="market-guardrails">
            <b>FLUXO PROTEGIDO</b>
            {["01 · Monitoramento público", "02 · Cotação confirmada", "03 · Pagamento autorizado", "04 · Aquisição e aposentadoria", "05 · ECOT entregue"].map((item) => <span key={item}>{item}</span>)}
          </div>
        </section>

        <section className="market-controls">
          <div>
            <h2>Ativos e canais monitorados</h2>
            <p>O catálogo não representa estoque próprio. Cada operação passa por confirmação executável.</p>
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

        {message && <div className="notice">{message}</div>}
        {loading && <div className="empty">Carregando fontes monitoradas...</div>}

        {!loading && (
          <section className="monitored-grid">
            {filtered.map((asset) => <AssetCard key={asset.id} asset={asset} onQuote={() => setSelected(asset)} />)}
            {!filtered.length && <div className="empty">Nenhuma fonte disponível neste filtro.</div>}
          </section>
        )}

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
  const registry = String(asset.registry || "Registry em análise");
  const projectName = String(asset.project_name || "Ativo ambiental monitorado");

  return (
    <article className="monitored-card">
      <div className="monitored-top">
        <span className={`source-dot ${sourceStatus}`} />
        <span>{registry}</span>
        <b>{String(asset.quality_tier || "screening")}</b>
      </div>
      <h3>{projectName}</h3>
      <p>{asset.description || "Fonte ambiental em monitoramento comercial pelo EcoTracker."}</p>
      <div className="asset-tags">
        <span>{assetType.replaceAll("-", " ")}</span>
        {asset.location && <span>{asset.location}</span>}
        {asset.vintage && <span>Vintage {asset.vintage}</span>}
      </div>
      <div className="asset-price">
        <small>{pricePerKg != null && Number.isFinite(pricePerKg) ? "Preço indicativo" : "Modelo comercial"}</small>
        <strong>{pricePerKg != null && Number.isFinite(pricePerKg) ? `${money(pricePerKg)}/kg` : "Cotação sob demanda"}</strong>
        <span>{pricePerTon != null && Number.isFinite(pricePerTon) ? `${money(pricePerTon)} por tCO₂e` : "Preço e disponibilidade confirmados com a fonte"}</span>
      </div>
      <div className="asset-availability">
        <div>
          <small>Disponibilidade</small>
          <b>{tons != null && Number.isFinite(tons) && tons > 0 ? `${num(tons, 4)} t monitoradas` : "Sob confirmação"}</b>
        </div>
        <div>
          <small>Pedido mínimo</small>
          <b>{num(asset.min_order_kg || 100, 0)} kg</b>
        </div>
      </div>
      <div className="asset-update">Atualização: {dateTime(asset.last_checked_at)}</div>
      <div className="asset-actions">
        <button onClick={onQuote}>Solicitar cotação</button>
        {asset.source_url && <a href={asset.source_url} target="_blank" rel="noreferrer">Ver origem ↗</a>}
      </div>
      <small className="indicative-warning">Não é oferta executável nem prova de estoque do EcoTracker.</small>
    </article>
  );
}

function QuoteModal({ asset, onClose, onCreated }: { asset: Asset; onClose: () => void; onCreated: (code: string) => void }) {
  const minimum = Number(asset.min_order_kg || 100);
  const recommendation = Math.max(minimum, Number(localStorage.getItem("ecotracker_recommended_kg") || minimum));
  const [form, setForm] = useState({
    buyerName: "",
    buyerEmail: "",
    buyerPhone: "",
    companyName: "",
    taxId: "",
    requestedKg: String(recommendation),
    deliveryMode: "email",
    walletAddress: "",
    purpose: "neutralization",
  });
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const indicative = asset.indicative_price_brl_kg == null ? null : Number(asset.indicative_price_brl_kg);
  const estimate = indicative == null || !Number.isFinite(indicative) ? null : indicative * Number(form.requestedKg || 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setMessage("");
    try {
      const response = await api<{ public_code: string }>("/market/quotes", {
        method: "POST",
        body: JSON.stringify({ ...form, assetId: asset.id, requestedKg: Number(form.requestedKg) }),
      });
      onCreated(response.public_code);
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
        <span className="tag">SOLICITAÇÃO DE COTAÇÃO</span>
        <h2>{asset.project_name}</h2>
        <p>Você não será cobrado agora. Primeiro confirmaremos lote, preço e prazo.</p>
        <div className="quote-fields">
          <input required placeholder="Nome completo" value={form.buyerName} onChange={(event) => setForm({ ...form, buyerName: event.target.value })} />
          <input required type="email" placeholder="E-mail" value={form.buyerEmail} onChange={(event) => setForm({ ...form, buyerEmail: event.target.value })} />
          <input placeholder="WhatsApp" value={form.buyerPhone} onChange={(event) => setForm({ ...form, buyerPhone: event.target.value })} />
          <input placeholder="Empresa (opcional)" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
          <input placeholder="CPF/CNPJ (opcional)" value={form.taxId} onChange={(event) => setForm({ ...form, taxId: event.target.value })} />
          <input required type="number" min={minimum} value={form.requestedKg} onChange={(event) => setForm({ ...form, requestedKg: event.target.value })} />
          <select value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}>
            <option value="neutralization">Neutralização</option>
            <option value="rewards">EcoRewards</option>
            <option value="corporate">Programa corporativo</option>
            <option value="other">Outro uso</option>
          </select>
          <select value={form.deliveryMode} onChange={(event) => setForm({ ...form, deliveryMode: event.target.value })}>
            <option value="email">Receber por e-mail</option>
            <option value="wallet">Carteira própria 0x</option>
          </select>
          {form.deliveryMode === "wallet" && (
            <input required pattern="^0x[a-fA-F0-9]{40}$" placeholder="0x..." value={form.walletAddress} onChange={(event) => setForm({ ...form, walletAddress: event.target.value })} />
          )}
        </div>
        <div className="quote-summary">
          <span>{num(form.requestedKg, 0)} ECOT pretendidos</span>
          <b>{estimate == null ? "Valor sob consulta" : `Estimativa ${money(estimate)}`}</b>
        </div>
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

  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setQuote(null);
    try {
      setQuote(await api<QuoteStatus>(`/market/quotes/${code.trim()}`));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <form className="tracker-form" onSubmit={submit}>
      <div>
        <input required placeholder="Código UUID da cotação" value={code} onChange={(event) => setCode(event.target.value)} />
        <button>Consultar</button>
      </div>
      {message && <div className="form-msg">{message}</div>}
      {quote && (
        <div className="tracker-result">
          <span className={`quote-status ${quote.status}`}>{String(quote.status || "requested").replaceAll("_", " ")}</span>
          <h3>{quote.project_name}</h3>
          <p>{num(quote.requested_kg, 0)} kg · {quote.registry}</p>
          <b>{quote.final_total ? `Proposta final: ${money(quote.final_total)}` : quote.indicative_total ? `Estimativa: ${money(quote.indicative_total)}` : "Preço em análise"}</b>
        </div>
      )}
    </form>
  );
}
