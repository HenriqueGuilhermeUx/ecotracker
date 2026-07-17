import { type FormEvent, useEffect, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import { type Asset, dateTime, money, num, type Quote } from "./market-types";

export function MarketAdmin() {
  const [token, setToken] = useState(localStorage.getItem("ecotracker_admin_token"));

  if (!token) {
    return (
      <Login
        onLogin={(nextToken) => {
          localStorage.setItem("ecotracker_admin_token", nextToken);
          setToken(nextToken);
        }}
      />
    );
  }

  return (
    <Panel
      logout={() => {
        localStorage.removeItem("ecotracker_admin_token");
        setToken(null);
      }}
    />
  );
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
    } catch (error) {
      setMessage((error as Error).message);
    }
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
  const [tab, setTab] = useState<"quotes" | "assets">("quotes");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      const [assetData, quoteData] = await Promise.all([
        api<Asset[]>("/admin/market/assets"),
        api<Quote[]>("/admin/market/quotes"),
      ]);
      setAssets(Array.isArray(assetData) ? assetData : []);
      setQuotes(Array.isArray(quoteData) ? quoteData : []);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  useEffect(() => { void load(); }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await api("/admin/market/refresh", { method: "POST" });
      await load();
      setMessage("Fontes e câmbio atualizados.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <MarketShell>
      <main className="market-admin-page">
        <div className="market-admin-head">
          <div><span className="tag">ECOROUTER</span><h1>Operação comercial</h1></div>
          <div>
            <button className="secondary-admin" onClick={refresh}>{refreshing ? "Atualizando..." : "Atualizar fontes"}</button>
            <button className="secondary-admin" onClick={logout}>Sair</button>
          </div>
        </div>
        <div className="market-admin-tabs">
          <button className={tab === "quotes" ? "active" : ""} onClick={() => setTab("quotes")}>Cotações ({quotes.length})</button>
          <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>Ativos ({assets.length})</button>
          <a href="#admin">Admin de lastro →</a>
        </div>
        {message && <div className="notice">{message}</div>}
        {tab === "quotes" ? <Quotes quotes={quotes} reload={load} /> : <Assets assets={assets} reload={load} />}
      </main>
    </MarketShell>
  );
}

function Quotes({ quotes, reload }: { quotes: Quote[]; reload: () => void }) {
  async function save(quote: Quote, status: string, finalTotal: string, notes: string) {
    await api(`/admin/market/quotes/${quote.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, finalTotal: finalTotal ? Number(finalTotal) : null, adminNotes: notes }),
    });
    await reload();
  }

  return (
    <section className="quote-admin-list">
      {quotes.map((quote) => <QuoteCard key={quote.id} quote={quote} save={save} />)}
      {!quotes.length && <div className="empty">Nenhuma solicitação ainda.</div>}
    </section>
  );
}

function QuoteCard({ quote, save }: { quote: Quote; save: (quote: Quote, status: string, final: string, notes: string) => Promise<void> }) {
  const [status, setStatus] = useState(quote.status || "requested");
  const [finalTotal, setFinalTotal] = useState(quote.final_total || "");
  const [notes, setNotes] = useState(quote.admin_notes || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <article className="quote-admin-card">
      <div className="quote-admin-title">
        <div><span>{quote.registry}</span><h3>{quote.project_name}</h3><small>{quote.public_code}</small></div>
        <b>{num(quote.requested_kg, 0)} kg</b>
      </div>
      <div className="quote-person">
        <strong>{quote.buyer_name}</strong>
        <span>{quote.buyer_email}{quote.buyer_phone ? ` · ${quote.buyer_phone}` : ""}</span>
        <span>{quote.company_name || "Pessoa física"} · {quote.delivery_mode}</span>
      </div>
      <div className="quote-admin-fields">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {["requested", "reviewing", "quoted", "awaiting_payment", "sourcing", "retired", "delivered", "cancelled"].map((item) => (
            <option key={item} value={item}>{item.replaceAll("_", " ")}</option>
          ))}
        </select>
        <input type="number" min="0" step="0.01" placeholder="Valor final R$" value={finalTotal} onChange={(event) => setFinalTotal(event.target.value)} />
        <textarea placeholder="Notas internas" value={notes} onChange={(event) => setNotes(event.target.value)} />
        <button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setMessage("");
            try { await save(quote, status, finalTotal, notes); }
            catch (error) { setMessage((error as Error).message); }
            finally { setSaving(false); }
          }}
        >
          {saving ? "Salvando..." : "Salvar cotação"}
        </button>
      </div>
      {message && <div className="form-msg">{message}</div>}
    </article>
  );
}

function Assets({ assets, reload }: { assets: Asset[]; reload: () => void }) {
  return (
    <section>
      <NewAsset reload={reload} />
      <div className="asset-admin-list">
        {assets.map((asset) => <AdminAssetCard key={asset.id} asset={asset} reload={reload} />)}
      </div>
    </section>
  );
}

function NewAsset({ reload }: { reload: () => void }) {
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api("/admin/market/assets", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          sourcePriceUsdTon: data.sourcePriceUsdTon ? Number(data.sourcePriceUsdTon) : null,
          minOrderKg: Number(data.minOrderKg || 100),
          fxBrlUsd: Number(data.fxBrlUsd || 5.5),
          serviceMarginPct: Number(data.serviceMarginPct || 25),
          fixedFeeBrl: 0,
          pricingMode: data.sourcePriceUsdTon ? "dynamic" : "quote",
          availabilityStatus: "monitoring",
          sourceStatus: "manual",
          active: true,
        }),
      });
      event.currentTarget.reset();
      setMessage("Fonte adicionada.");
      await reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <form className="new-asset-form" onSubmit={submit}>
      <h2>Adicionar fonte ou projeto</h2>
      <input name="registry" required placeholder="Registry" />
      <input name="projectName" required placeholder="Nome comercial" />
      <input name="sourceReference" required placeholder="Referência única" />
      <input name="sourceUrl" type="url" placeholder="URL da origem" />
      <input name="assetType" defaultValue="carbon" placeholder="Tipo" />
      <input name="qualityTier" defaultValue="screening" placeholder="Tier" />
      <input name="sourcePriceUsdTon" type="number" min="0" step="0.0001" placeholder="Preço USD/t (opcional)" />
      <input name="fxBrlUsd" type="number" min="0" step="0.0001" defaultValue="5.5" />
      <input name="serviceMarginPct" type="number" min="0" step="0.01" defaultValue="25" />
      <input name="minOrderKg" type="number" min="1" defaultValue="100" />
      <textarea name="description" placeholder="Descrição" />
      <button>Adicionar</button>
      {message && <div className="form-msg">{message}</div>}
    </form>
  );
}

function AdminAssetCard({ asset, reload }: { asset: Asset; reload: () => void }) {
  const [price, setPrice] = useState(asset.source_price_usd_ton || "");
  const [fx, setFx] = useState(asset.fx_brl_usd || "5.5");
  const [margin, setMargin] = useState(asset.service_margin_pct || "25");
  const [available, setAvailable] = useState(asset.available_tons || "");
  const [status, setStatus] = useState(asset.availability_status || "monitoring");
  const [active, setActive] = useState(Boolean(asset.active));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await api(`/admin/market/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          sourcePriceUsdTon: price ? Number(price) : null,
          fxBrlUsd: Number(fx),
          serviceMarginPct: Number(margin),
          availableTons: available ? Number(available) : null,
          availabilityStatus: status,
          pricingMode: price ? "dynamic" : "quote",
          active,
        }),
      });
      await reload();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="asset-admin-card">
      <div>
        <span>{asset.registry}</span>
        <h3>{asset.project_name}</h3>
        <small>{asset.source_reference} · {asset.source_status} · {dateTime(asset.last_checked_at)}</small>
      </div>
      <div className="asset-admin-fields">
        <label>USD/t<input type="number" min="0" step="0.0001" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
        <label>USD/BRL<input type="number" min="0" step="0.0001" value={fx} onChange={(event) => setFx(event.target.value)} /></label>
        <label>Margem %<input type="number" min="0" step="0.01" value={margin} onChange={(event) => setMargin(event.target.value)} /></label>
        <label>Disponível t<input type="number" min="0" step="0.000001" value={available} onChange={(event) => setAvailable(event.target.value)} /></label>
        <label>Status
          <select value={status} onChange={(event) => setStatus(event.target.value as Asset["availability_status"])}>
            <option value="monitoring">monitoring</option>
            <option value="indicative">indicative</option>
            <option value="confirmed">confirmed</option>
          </select>
        </label>
        <label className="checkbox-label"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Ativo</label>
        <button disabled={saving} onClick={save}>{saving ? "Salvando..." : "Salvar"}</button>
      </div>
      <div className="admin-price-preview">Preço público: <b>{asset.indicative_price_brl_kg ? `${money(asset.indicative_price_brl_kg)}/kg` : "sob consulta"}</b></div>
      {message && <div className="form-msg">{message}</div>}
    </article>
  );
}
