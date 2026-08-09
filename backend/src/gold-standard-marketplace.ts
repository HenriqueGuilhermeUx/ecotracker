import { pool } from "./db.js";

type Json = Record<string, unknown>;

type ShopifyVariant = {
  id?: number | string;
  price?: string | number;
  available?: boolean;
  inventory_quantity?: number;
  inventory_policy?: string;
  sku?: string;
};

type ShopifyProduct = {
  id?: number | string;
  title?: string;
  handle?: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string | string[];
  variants?: ShopifyVariant[];
};

type ShopifyProductsResponse = { products?: ShopifyProduct[] };

export type GoldStandardRefreshResult = {
  connected: boolean;
  published: number;
  productsSeen: number;
  commerciallyAvailable: number;
  exactStockProducts: number;
  baseUrl: string;
  executionMode: "assisted";
};

let lastRefreshAt = 0;
let refreshInFlight: Promise<GoldStandardRefreshResult> | null = null;

const baseUrl = () => (process.env.GOLD_STANDARD_MARKETPLACE_BASE || "https://marketplace.goldstandard.org").replace(/\/$/, "");
const publicApiBase = () => (process.env.GOLD_STANDARD_PUBLIC_API_BASE || "https://public-api.goldstandard.org").replace(/\/$/, "");

function numberAt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: unknown): string {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function tagsText(product: ShopifyProduct): string {
  return Array.isArray(product.tags) ? product.tags.join(" | ") : String(product.tags || "");
}

function vintageYears(product: ShopifyProduct): number[] {
  const tags = tagsText(product);
  const body = cleanText(product.body_html);
  const vintageChunks = [
    ...tags.split(/[|,;]/).filter((part) => /vintage/i.test(part)),
    ...(body.match(/VINTAGES?\s*:?\s*(?:19|20)\d{2}(?:\s*[|,\/-]\s*(?:19|20)\d{2})*/gi) || []),
  ];
  const years = vintageChunks.flatMap((chunk) => chunk.match(/(?:19|20)\d{2}/g) || []).map(Number);
  return Array.from(new Set(years.filter((year) => year >= 1990 && year <= 2100))).sort((a, b) => a - b);
}

function registryUrlFromBody(product: ShopifyProduct): string | null {
  const html = String(product.body_html || "");
  const match = html.match(/https?:\/\/[^"'<>\s]*registry\.goldstandard\.org[^"'<>\s]*/i);
  return match?.[0]?.replace(/&amp;/g, "&") || null;
}

function productPrice(product: ShopifyProduct): number | null {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const preferred = variants.filter((variant) => variant.available !== false);
  const pool = preferred.length ? preferred : variants;
  const prices = pool.map((variant) => numberAt(variant.price)).filter((price): price is number => price != null && price > 0);
  return prices.length ? Math.min(...prices) : null;
}

function exactInventory(product: ShopifyProduct): number | null {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const quantities = variants
    .map((variant) => numberAt(variant.inventory_quantity))
    .filter((quantity): quantity is number => quantity != null && quantity >= 0);
  return quantities.length === variants.length && variants.length > 0
    ? quantities.reduce((sum, value) => sum + value, 0)
    : null;
}

function commerciallyAvailable(product: ShopifyProduct): boolean {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  return variants.some((variant) => variant.available === true);
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

async function requestProducts(): Promise<ShopifyProduct[]> {
  const response = await fetch(`${baseUrl()}/products.json?limit=250`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "EcoTracker/1.0 (+https://ecotracker10.netlify.app)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Gold Standard Marketplace HTTP ${response.status}`);
  const data = await response.json() as ShopifyProductsResponse;
  if (!Array.isArray(data.products)) throw new Error("Gold Standard Marketplace não retornou catálogo de produtos");
  return data.products;
}

async function upsertChannel(status: string, notes: string) {
  await pool.query(`
    INSERT INTO offset_source_channels
      (provider_key,provider_name,sourcing_mode,min_order_kg,fractional_supported,retirement_supported,
       beneficiary_retirement_supported,status,registry_scope,source_url,notes,last_checked_at)
    VALUES('gold-standard','Gold Standard Marketplace','direct_marketplace',1000,FALSE,TRUE,TRUE,$1,
      'Gold Standard Impact Registry','https://marketplace.goldstandard.org/',$2,NOW())
    ON CONFLICT(provider_key) DO UPDATE SET
      provider_name=EXCLUDED.provider_name,sourcing_mode=EXCLUDED.sourcing_mode,min_order_kg=EXCLUDED.min_order_kg,
      fractional_supported=EXCLUDED.fractional_supported,retirement_supported=EXCLUDED.retirement_supported,
      beneficiary_retirement_supported=EXCLUDED.beneficiary_retirement_supported,status=EXCLUDED.status,
      registry_scope=EXCLUDED.registry_scope,source_url=EXCLUDED.source_url,notes=EXCLUDED.notes,
      last_checked_at=NOW(),updated_at=NOW()`, [status, notes]);
}

export async function refreshGoldStandardMarketplace(): Promise<GoldStandardRefreshResult> {
  try {
    const products = await requestProducts();
    const limit = Math.max(1, Math.min(250, Number(process.env.GOLD_STANDARD_PUBLISHED_PRODUCT_LIMIT || 100)));
    const currentYear = new Date().getUTCFullYear();
    const maxVintageAgeYears = Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5));
    const minVintage = currentYear - maxVintageAgeYears;
    const commercialValidUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fxResult = await pool.query(`SELECT fx_brl_usd FROM monitored_assets WHERE fx_brl_usd>0 ORDER BY last_checked_at DESC NULLS LAST,updated_at DESC LIMIT 1`);
    const fx = Number(fxResult.rows[0]?.fx_brl_usd || 5.5);

    const normalized = products.map((product) => {
      const id = String(product.id || "").trim();
      const handle = stringField(product.handle);
      const title = stringField(product.title);
      if (!id || !handle || !title) return null;
      const price = productPrice(product);
      if (price == null || price <= 0) return null;
      const available = commerciallyAvailable(product);
      const inventory = exactInventory(product);
      const vintages = vintageYears(product);
      const oldestVintage = vintages[0] || null;
      const newestVintage = vintages[vintages.length - 1] || null;
      const vintagePolicyCompatible = oldestVintage != null && oldestVintage >= minVintage && newestVintage != null && newestVintage <= currentYear;
      const evidenceUrl = registryUrlFromBody(product);
      const sourceUrl = `${baseUrl()}/products/${encodeURIComponent(handle)}`;
      const riskFlags = [
        "gold-standard-commerce-api-not-integrated",
        "gold-standard-marketplace-execution-assisted",
        ...(!available ? ["gold-standard-marketplace-currently-unavailable"] : []),
        ...(inventory == null ? ["gold-standard-stock-quantity-not-confirmed"] : []),
        ...(vintages.length === 0 ? ["gold-standard-vintage-not-resolved"] : []),
        ...(vintages.length > 1 ? ["gold-standard-vintage-selection-not-supported"] : []),
        ...(!vintagePolicyCompatible && vintages.length > 0 ? ["vintage-outside-ecotracker-policy"] : []),
        ...(!evidenceUrl ? ["gold-standard-registry-project-link-not-resolved"] : []),
      ];
      return {
        id,
        handle,
        title,
        price,
        available,
        inventory,
        vintages,
        oldestVintage,
        newestVintage,
        vintagePolicyCompatible,
        evidenceUrl,
        sourceUrl,
        vendor: stringField(product.vendor) || null,
        projectType: stringField(product.product_type) || null,
        description: cleanText(product.body_html).slice(0, 3000) || null,
        riskFlags,
      };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => {
        if (left.available !== right.available) return left.available ? -1 : 1;
        if (left.vintagePolicyCompatible !== right.vintagePolicyCompatible) return left.vintagePolicyCompatible ? -1 : 1;
        const leftStock = left.inventory ?? -1;
        const rightStock = right.inventory ?? -1;
        if (leftStock !== rightStock) return rightStock - leftStock;
        return left.price - right.price;
      })
      .slice(0, limit);

    await pool.query("UPDATE monitored_assets SET active=FALSE,updated_at=NOW() WHERE source_reference LIKE 'gold-standard-marketplace-%'");

    let availableCount = 0;
    let exactStockCount = 0;
    for (const item of normalized) {
      if (item.available) availableCount += 1;
      if (item.inventory != null) exactStockCount += 1;
      const vintageLabel = item.vintages.length ? item.vintages.join(" | ") : null;
      // Quando várias vintages são vendidas sem seleção individual, usamos a mais antiga
      // como limite conservador para qualquer futura revisão de elegibilidade.
      const vintageStart = item.oldestVintage ? `${item.oldestVintage}-01-01` : null;
      const vintageEnd = item.oldestVintage ? `${item.oldestVintage}-12-31` : null;
      const monitorDetails = {
        providerKey: "gold-standard",
        marketplace: true,
        executionMode: "assisted",
        productId: item.id,
        handle: item.handle,
        vendor: item.vendor,
        projectType: item.projectType,
        priceUsdPerTonne: item.price,
        storefrontAvailable: item.available,
        exactInventoryTonnes: item.inventory,
        vintages: item.vintages,
        vintageSelectionSupported: item.vintages.length <= 1,
        registryEvidenceResolved: Boolean(item.evidenceUrl),
        publicApiBase: publicApiBase(),
        checkedAt: new Date().toISOString(),
        note: "Oferta comercial pública do Gold Standard Marketplace. O EcoTracker monitora preço/availability, mas checkout e retirement continuam assistidos até integração da Commerce API.",
      };
      await pool.query(`
        INSERT INTO monitored_assets
          (registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
           source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,
           availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,
           eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,
           registry_evidence_url,retirement_supported,fractional_retirement_supported,retirement_granularity_kg,
           beneficiary_retirement_supported,eligibility_checked_at,eligibility_risk_flags)
        VALUES('Gold Standard',$1,$2,$3,$4,NULL,$5,'carbon','screening',$6,$7,$8,25,0,$9,1000,'quote',$10,'connected',$11::jsonb,NOW(),TRUE,
           'climate_contribution','restricted',$12,$13,$14::date,$15::date,$16::date,$17,$18,FALSE,FALSE,1000,FALSE,NOW(),$19::jsonb)
        ON CONFLICT(registry,source_reference) DO UPDATE SET
          project_name=EXCLUDED.project_name,source_url=EXCLUDED.source_url,methodology=EXCLUDED.methodology,
          vintage=EXCLUDED.vintage,quality_tier='screening',description=EXCLUDED.description,
          source_price_usd_ton=EXCLUDED.source_price_usd_ton,fx_brl_usd=EXCLUDED.fx_brl_usd,
          available_tons=EXCLUDED.available_tons,min_order_kg=1000,pricing_mode='quote',
          availability_status=EXCLUDED.availability_status,source_status='connected',monitor_details=EXCLUDED.monitor_details,
          last_checked_at=NOW(),active=TRUE,claim_category='climate_contribution',eligibility_status='restricted',
          eligibility_basis=EXCLUDED.eligibility_basis,source_unit_status=EXCLUDED.source_unit_status,
          vintage_start=EXCLUDED.vintage_start,vintage_end=EXCLUDED.vintage_end,
          commercial_valid_until=EXCLUDED.commercial_valid_until,registry_project_id=EXCLUDED.registry_project_id,
          registry_evidence_url=EXCLUDED.registry_evidence_url,retirement_supported=FALSE,
          fractional_retirement_supported=FALSE,retirement_granularity_kg=1000,beneficiary_retirement_supported=FALSE,
          eligibility_checked_at=NOW(),eligibility_risk_flags=EXCLUDED.eligibility_risk_flags,updated_at=NOW()`,
        [
          item.title,
          `gold-standard-marketplace-${item.id}`,
          item.sourceUrl,
          item.projectType,
          vintageLabel,
          item.description,
          item.price,
          fx,
          item.inventory,
          item.available ? (item.inventory != null ? "confirmed" : "indicative") : "monitoring",
          JSON.stringify(monitorDetails),
          "Oferta pública Gold Standard identificada no marketplace. Para entrar em compensação verificada, o EcoTracker ainda precisa vincular lote/registry, confirmar vintage aplicável e integrar checkout/retirement da Commerce API.",
          item.available ? "tradable" : "unknown",
          vintageStart,
          vintageEnd,
          commercialValidUntil,
          item.id,
          item.evidenceUrl || item.sourceUrl,
          JSON.stringify(item.riskFlags),
        ],
      );
    }

    await upsertChannel(
      "marketplace_connected",
      `${normalized.length} produtos monitorados; ${availableCount} disponíveis no storefront; ${exactStockCount} com quantidade de estoque exposta. Compra/retirement EcoTracker permanece assistida até integração da Commerce API.`,
    );
    lastRefreshAt = Date.now();
    return {
      connected: true,
      published: normalized.length,
      productsSeen: products.length,
      commerciallyAvailable: availableCount,
      exactStockProducts: exactStockCount,
      baseUrl: baseUrl(),
      executionMode: "assisted",
    };
  } catch (error) {
    await upsertChannel("degraded", `Falha no Gold Standard Marketplace: ${error instanceof Error ? error.message : "erro desconhecido"}`).catch(() => undefined);
    throw error;
  }
}

export async function refreshGoldStandardIfStale(maxAgeMs = 10 * 60 * 1000) {
  if (lastRefreshAt && Date.now() - lastRefreshAt < maxAgeMs) {
    return {
      connected: true,
      published: -1,
      productsSeen: -1,
      commerciallyAvailable: -1,
      exactStockProducts: -1,
      baseUrl: baseUrl(),
      executionMode: "assisted" as const,
      cached: true,
    };
  }
  if (!refreshInFlight) refreshInFlight = refreshGoldStandardMarketplace().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export function goldStandardMarketplaceStatus() {
  return {
    baseUrl: baseUrl(),
    publicApiBase: publicApiBase(),
    executionMode: "assisted" as const,
    commerceApiIntegrated: false,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
  };
}
