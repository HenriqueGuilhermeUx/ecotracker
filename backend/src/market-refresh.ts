import { pool } from "./db.js";

let lastCompletedAt = 0;
let inFlight: Promise<MarketRefreshResult> | null = null;

type RegenRefresh = {
  orders: number;
  availableTons: number;
  pricingOrders: number;
  sourcePriceUsdTon: number | null;
  askDenoms: string[];
} | null;

type ChannelRefresh = { source: string; reachable: boolean; status: number | null };

type MarketRefreshResult = {
  cached?: boolean;
  fx: number | null;
  regen: RegenRefresh;
  channels: ChannelRefresh[];
  refreshedAt: string;
};

type AllowedDenomsResponse = {
  allowed_denoms?: Array<Record<string, unknown>>;
  allowedDenoms?: Array<Record<string, unknown>>;
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
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
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
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json", "User-Agent": "EcoTracker/1.0" },
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

async function refreshRegen(): Promise<RegenRefresh> {
  const base = (process.env.REGEN_REST_URL || "https://rest.cosmos.directory/regen").replace(/\/$/, "");
  try {
    const [ordersResponse, denomsResponse, regenUsd] = await Promise.all([
      fetch(`${base}/regen/ecocredit/marketplace/v1/sell-orders?pagination.limit=200`, {
        signal: AbortSignal.timeout(12000),
        headers: { Accept: "application/json" },
      }),
      fetch(`${base}/regen/ecocredit/marketplace/v1/allowed-denoms`, {
        signal: AbortSignal.timeout(12000),
        headers: { Accept: "application/json" },
      }).catch(() => null),
      fetchRegenUsd(),
    ]);

    if (!ordersResponse.ok) throw new Error(`Regen REST ${ordersResponse.status}`);

    const orderData = await ordersResponse.json() as {
      sell_orders?: Array<Record<string, unknown>>;
      sellOrders?: Array<Record<string, unknown>>;
    };
    const denomData: AllowedDenomsResponse = denomsResponse?.ok
      ? await denomsResponse.json() as AllowedDenomsResponse
      : {};

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

    const askDenoms = Array.from(new Set(
      orders.map((order) => String(order.ask_denom || order.askDenom || "")).filter(Boolean),
    ));
    const usdPrices: number[] = [];

    for (const order of orders) {
      const askDenom = String(order.ask_denom || order.askDenom || "");
      const askAmount = Number(order.ask_amount || order.askAmount);
      if (!askDenom || !Number.isFinite(askAmount) || askAmount <= 0) continue;

      const exponent = exponentByDenom.get(askDenom) ?? (askDenom.startsWith("u") ? 6 : 0);
      const displayDenom = displayByDenom.get(askDenom) || askDenom;
      const displayAmount = askAmount / Math.pow(10, exponent);

      if ((displayDenom === "regen" || askDenom === "uregen") && regenUsd) {
        usdPrices.push(displayAmount * regenUsd);
      } else if (
        ["usdc", "uusdc", "usd", "usdt", "uusdt"].includes(displayDenom.toLowerCase()) ||
        ["uusdc", "uusdt"].includes(askDenom.toLowerCase())
      ) {
        usdPrices.push(displayAmount);
      }
    }

    const sourcePriceUsdTon = median(usdPrices);
    const details = {
      orderCount: orders.length,
      pricingOrderCount: usdPrices.length,
      askDenoms,
      regenUsd,
      minSourceUsdTon: usdPrices.length ? Math.min(...usdPrices) : null,
      medianSourceUsdTon: sourcePriceUsdTon,
      maxSourceUsdTon: usdPrices.length ? Math.max(...usdPrices) : null,
      endpoint: base,
      checkedAt: new Date().toISOString(),
      note: sourcePriceUsdTon
        ? "Preço de referência calculado pela mediana das ordens cuja moeda pôde ser convertida. Execução ainda exige confirmação."
        : "Volume e ordens lidos on-chain; preço executável depende da moeda e da liquidez de cada ordem.",
    };

    await pool.query(
      `UPDATE monitored_assets
       SET available_tons=$1,
           availability_status=$2,
           source_status='connected',
           source_price_usd_ton=CASE WHEN $3::numeric IS NULL THEN source_price_usd_ton ELSE $3 END,
           pricing_mode=CASE WHEN $3::numeric IS NULL THEN 'quote' ELSE 'dynamic' END,
           monitor_details=$4::jsonb,
           last_checked_at=NOW(),updated_at=NOW()
       WHERE source_reference='regen-marketplace'`,
      [availableTons, orders.length ? "indicative" : "monitoring", sourcePriceUsdTon, JSON.stringify(details)],
    );

    return { orders: orders.length, availableTons, pricingOrders: usdPrices.length, sourcePriceUsdTon, askDenoms };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("[market] Regen refresh failed", error);
    await pool.query(
      `UPDATE monitored_assets
       SET source_status='degraded',
           monitor_details=jsonb_build_object('error',$1::text,'checkedAt',NOW(),'note','A última leitura ao vivo falhou; o catálogo continua disponível para cotação assistida.'),
           last_checked_at=NOW(),updated_at=NOW()
       WHERE source_reference='regen-marketplace'`,
      [message],
    );
    return null;
  }
}

async function refreshChannel(sourceReference: string, url: string): Promise<ChannelRefresh> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "EcoTracker/1.0", Accept: "text/html,application/xhtml+xml" },
    });
    if (response.body) await response.body.cancel().catch(() => undefined);
    const reachable = response.ok;
    await pool.query(
      `UPDATE monitored_assets SET
         source_status=$2,
         monitor_details=jsonb_build_object('websiteStatus',$3::int,'checkedAt',NOW(),'note',$4::text),
         last_checked_at=NOW(),updated_at=NOW()
       WHERE source_reference=$1`,
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
  const [fx, regen, ofp, coorest] = await Promise.all([
    refreshFx(),
    refreshRegen(),
    refreshChannel("ofp-projects", "https://www.openforestprotocol.org/"),
    refreshChannel("coorest-removals", "https://coorest.eu/"),
  ]);
  lastCompletedAt = Date.now();
  return { fx, regen, channels: [ofp, coorest], refreshedAt: new Date(lastCompletedAt).toISOString() };
}

export async function refreshMarketData(): Promise<MarketRefreshResult> {
  if (!inFlight) {
    inFlight = executeRefresh().finally(() => { inFlight = null; });
  }
  return inFlight;
}

export async function refreshIfStale(maxAgeMs = 10 * 60 * 1000): Promise<MarketRefreshResult> {
  if (lastCompletedAt && Date.now() - lastCompletedAt < maxAgeMs) {
    return { cached: true, fx: null, regen: null, channels: [], refreshedAt: new Date(lastCompletedAt).toISOString() };
  }
  return refreshMarketData();
}
