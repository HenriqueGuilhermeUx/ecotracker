import { pool } from "./db.js";

let lastCompletedAt = 0;
let inFlight: Promise<MarketRefreshResult> | null = null;

type RegenRefresh = {
  orders: number;
  availableTons: number;
  pricingOrders: number;
  sourcePriceUsdTon: number | null;
  askDenoms: string[];
  publishedOrders: number;
} | null;

type ChannelRefresh = { source: string; reachable: boolean; status: number | null };
type MarketRefreshResult = { cached?: boolean; fx: number | null; regen: RegenRefresh; channels: ChannelRefresh[]; refreshedAt: string };
type AllowedDenomsResponse = { allowed_denoms?: Array<Record<string, unknown>>; allowedDenoms?: Array<Record<string, unknown>> };
type PricedOrder = {
  id: string;
  batchDenom: string;
  quantity: number;
  priceUsdTon: number;
  askDenom: string;
  askAmount: string;
  displayDenom: string;
  disableAutoRetire: boolean;
  expiration: string | null;
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function refreshFx(): Promise<number | null> {
  try {
    const response = await fetch("https://api.frankfurter.app/latest?from=USD&to=BRL", {
      signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = await response.json() as { rates?: { BRL?: number } };
    const rate = Number(data.rates?.BRL);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    await pool.query("UPDATE monitored_assets SET fx_brl_usd=$1,updated_at=NOW() WHERE active=TRUE", [rate]);
    return rate;
  } catch (error) {
    console.warn("[market] FX refresh failed", error);
    return null;
  }
}

async function fetchRegenUsd(): Promise<number | null> {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=regen&vs_currencies=usd", {
      signal: AbortSignal.timeout(8000), headers: { Accept: "application/json", "User-Agent": "EcoTracker/1.0" },
    });
    if (!response.ok) return null;
    const data = await response.json() as { regen?: { usd?: number } };
    const value = Number(data.regen?.usd);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) {
    console.warn("[market] REGEN/USD refresh failed", error);
    return null;
  }
}

async function publishRegenOrders(orders: PricedOrder[], endpoint: string): Promise<number> {
  await pool.query("UPDATE monitored_assets SET active=FALSE,updated_at=NOW() WHERE source_reference LIKE 'regen-order-%'");
  const limit = Math.max(1, Math.min(50, Number(process.env.REGEN_PUBLISHED_ORDER_LIMIT || 20)));
  const published = [...orders]
    .filter((order) => order.quantity > 0 && order.priceUsdTon > 0)
    .sort((a, b) => a.priceUsdTon - b.priceUsdTon)
    .slice(0, limit);

  for (const order of published) {
    const vintageMatch = order.batchDenom.match(/-(20\d{2})\d{4}-/);
    const details = {
      sellOrderId: order.id,
      batchDenom: order.batchDenom,
      askDenom: order.askDenom,
      askAmount: order.askAmount,
      displayDenom: order.displayDenom,
      disableAutoRetire: order.disableAutoRetire,
      autoRetireAvailable: !order.disableAutoRetire,
      expiration: order.expiration,
      endpoint,
      checkedAt: new Date().toISOString(),
      note: "Ordem pública on-chain com preço convertido. A execução final depende de liquidez, saldo e assinatura da carteira operacional.",
    };
    await pool.query(
      `INSERT INTO monitored_assets
        (registry,project_name,source_reference,source_url,vintage,asset_type,quality_tier,description,
         source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,
         pricing_mode,availability_status,source_status,monitor_details,last_checked_at,active)
       VALUES('Regen Network',$1,$2,'https://app.regen.network/',$3,'carbon','screening',$4,$5,
         COALESCE((SELECT fx_brl_usd FROM monitored_assets WHERE source_reference='regen-marketplace' LIMIT 1),5.5),
         25,0,$6,100,'dynamic','indicative','connected',$7::jsonb,NOW(),TRUE)
       ON CONFLICT(registry,source_reference) DO UPDATE SET
         project_name=EXCLUDED.project_name,source_url=EXCLUDED.source_url,vintage=EXCLUDED.vintage,
         description=EXCLUDED.description,source_price_usd_ton=EXCLUDED.source_price_usd_ton,
         available_tons=EXCLUDED.available_tons,pricing_mode='dynamic',availability_status='indicative',
         source_status='connected',monitor_details=EXCLUDED.monitor_details,last_checked_at=NOW(),active=TRUE,updated_at=NOW()`,
      [
        `Lote Regen ${order.batchDenom}`,
        `regen-order-${order.id}`,
        vintageMatch?.[1] || null,
        `Oferta on-chain do lote ${order.batchDenom}. ${order.disableAutoRetire ? "Aposentadoria será executada após a aquisição." : "A ordem permite aposentadoria automática na compra."}`,
        order.priceUsdTon,
        order.quantity,
        JSON.stringify(details),
      ],
    );
  }
  return published.length;
}

async function refreshRegen(): Promise<RegenRefresh> {
  const base = (process.env.REGEN_REST_URL || "https://rest.cosmos.directory/regen").replace(/\/$/, "");
  try {
    const [ordersResponse, denomsResponse, regenUsd] = await Promise.all([
      fetch(`${base}/regen/ecocredit/marketplace/v1/sell-orders?pagination.limit=200`, {
        signal: AbortSignal.timeout(12000), headers: { Accept: "application/json" },
      }),
      fetch(`${base}/regen/ecocredit/marketplace/v1/allowed-denoms`, {
        signal: AbortSignal.timeout(12000), headers: { Accept: "application/json" },
      }).catch(() => null),
      fetchRegenUsd(),
    ]);
    if (!ordersResponse.ok) throw new Error(`Regen REST ${ordersResponse.status}`);

    const orderData = await ordersResponse.json() as { sell_orders?: Array<Record<string, unknown>>; sellOrders?: Array<Record<string, unknown>> };
    const denomData: AllowedDenomsResponse = denomsResponse?.ok ? await denomsResponse.json() as AllowedDenomsResponse : {};
    const exponentByDenom = new Map<string, number>();
    const displayByDenom = new Map<string, string>();
    for (const raw of denomData.allowed_denoms || denomData.allowedDenoms || []) {
      const bank = String(raw.bank_denom || raw.bankDenom || "");
      const display = String(raw.display_denom || raw.displayDenom || bank);
      const exponent = Number(raw.exponent || 0);
      if (bank) {
        exponentByDenom.set(bank, Number.isFinite(exponent) ? exponent : 0);
        displayByDenom.set(bank, display);
      }
    }
    if (!exponentByDenom.has("uregen")) exponentByDenom.set("uregen", 6);
    if (!displayByDenom.has("uregen")) displayByDenom.set("uregen", "regen");

    const now = Date.now();
    const orders = (orderData.sell_orders || orderData.sellOrders || []).filter((order) => {
      const expiration = order.expiration;
      return !expiration || Date.parse(String(expiration)) > now;
    });
    const availableTons = orders.reduce((sum, order) => {
      const quantity = Number(order.quantity);
      return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
    }, 0);
    const askDenoms = Array.from(new Set(orders.map((order) => String(order.ask_denom || order.askDenom || "")).filter(Boolean)));
    const pricedOrders: PricedOrder[] = [];

    for (const order of orders) {
      const askDenom = String(order.ask_denom || order.askDenom || "");
      const askAmountRaw = String(order.ask_amount || order.askAmount || "");
      const askAmount = Number(askAmountRaw);
      const quantity = Number(order.quantity);
      const id = String(order.id || "");
      const batchDenom = String(order.batch_denom || order.batchDenom || "");
      if (!id || !batchDenom || !askDenom || !Number.isFinite(askAmount) || askAmount <= 0 || !Number.isFinite(quantity) || quantity <= 0) continue;

      const exponent = exponentByDenom.get(askDenom) ?? (askDenom.startsWith("u") ? 6 : 0);
      const displayDenom = displayByDenom.get(askDenom) || askDenom;
      const displayAmount = askAmount / Math.pow(10, exponent);
      let priceUsdTon: number | null = null;
      if ((displayDenom.toLowerCase() === "regen" || askDenom.toLowerCase() === "uregen") && regenUsd) {
        priceUsdTon = displayAmount * regenUsd;
      } else if (
        ["usdc", "uusdc", "usd", "usdt", "uusdt"].includes(displayDenom.toLowerCase()) ||
        ["uusdc", "uusdt"].includes(askDenom.toLowerCase())
      ) {
        priceUsdTon = displayAmount;
      }
      if (priceUsdTon && Number.isFinite(priceUsdTon) && priceUsdTon > 0) {
        pricedOrders.push({
          id, batchDenom, quantity, priceUsdTon, askDenom, askAmount: askAmountRaw, displayDenom,
          disableAutoRetire: Boolean(order.disable_auto_retire || order.disableAutoRetire),
          expiration: order.expiration ? String(order.expiration) : null,
        });
      }
    }

    const sourcePriceUsdTon = median(pricedOrders.map((order) => order.priceUsdTon));
    const details = {
      orderCount: orders.length,
      pricingOrderCount: pricedOrders.length,
      askDenoms,
      regenUsd,
      minSourceUsdTon: pricedOrders.length ? Math.min(...pricedOrders.map((order) => order.priceUsdTon)) : null,
      medianSourceUsdTon: sourcePriceUsdTon,
      maxSourceUsdTon: pricedOrders.length ? Math.max(...pricedOrders.map((order) => order.priceUsdTon)) : null,
      endpoint: base,
      checkedAt: new Date().toISOString(),
      note: "Visão agregada do marketplace. Para cotação automática, escolha uma oferta individual abaixo.",
    };
    await pool.query(
      `UPDATE monitored_assets SET available_tons=$1,availability_status=$2,source_status='connected',
         source_price_usd_ton=NULL,pricing_mode='quote',monitor_details=$3::jsonb,last_checked_at=NOW(),updated_at=NOW()
       WHERE source_reference='regen-marketplace'`,
      [availableTons, orders.length ? "indicative" : "monitoring", JSON.stringify(details)],
    );
    const publishedOrders = await publishRegenOrders(pricedOrders, base);
    return { orders: orders.length, availableTons, pricingOrders: pricedOrders.length, sourcePriceUsdTon, askDenoms, publishedOrders };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[market] Regen refresh failed", error);
    await pool.query(
      `UPDATE monitored_assets SET source_status='degraded',
         monitor_details=jsonb_build_object('error',$1::text,'checkedAt',NOW(),'note','A última leitura ao vivo falhou; o catálogo continua disponível para cotação assistida.'),
         last_checked_at=NOW(),updated_at=NOW() WHERE source_reference='regen-marketplace'`,
      [message],
    );
    return null;
  }
}

async function refreshChannel(sourceReference: string, url: string): Promise<ChannelRefresh> {
  try {
    const response = await fetch(url, {
      method: "GET", redirect: "follow", signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "EcoTracker/1.0", Accept: "text/html,application/xhtml+xml" },
    });
    if (response.body) await response.body.cancel().catch(() => undefined);
    const reachable = response.ok;
    await pool.query(
      `UPDATE monitored_assets SET source_status=$2,
         monitor_details=jsonb_build_object('websiteStatus',$3::int,'checkedAt',NOW(),'note',$4::text),
         last_checked_at=NOW(),updated_at=NOW() WHERE source_reference=$1`,
      [sourceReference, reachable ? "manual" : "degraded", response.status,
        reachable ? "Canal público online; preço e lote dependem de confirmação direta." : "Canal público respondeu com erro; cotação permanece assistida."],
    );
    return { source: sourceReference, reachable, status: response.status };
  } catch (error) {
    await pool.query(
      `UPDATE monitored_assets SET source_status='degraded',monitor_details=jsonb_build_object('error',$2::text,'checkedAt',NOW(),'note','Não foi possível verificar o canal público nesta leitura.'),last_checked_at=NOW(),updated_at=NOW() WHERE source_reference=$1`,
      [sourceReference, error instanceof Error ? error.message : "Unknown error"],
    );
    return { source: sourceReference, reachable: false, status: null };
  }
}

async function executeRefresh(): Promise<MarketRefreshResult> {
  const fx = await refreshFx();
  const [regen, ofp, coorest] = await Promise.all([
    refreshRegen(),
    refreshChannel("ofp-projects", "https://www.openforestprotocol.org/"),
    refreshChannel("coorest-removals", "https://coorest.eu/"),
  ]);
  lastCompletedAt = Date.now();
  return { fx, regen, channels: [ofp, coorest], refreshedAt: new Date(lastCompletedAt).toISOString() };
}

export async function refreshMarketData(): Promise<MarketRefreshResult> {
  if (!inFlight) inFlight = executeRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

export async function refreshIfStale(maxAgeMs = 10 * 60 * 1000): Promise<MarketRefreshResult> {
  if (lastCompletedAt && Date.now() - lastCompletedAt < maxAgeMs) {
    return { cached: true, fx: null, regen: null, channels: [], refreshedAt: new Date(lastCompletedAt).toISOString() };
  }
  return refreshMarketData();
}
