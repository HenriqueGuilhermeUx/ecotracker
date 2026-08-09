import { pool } from "./db.js";

type Json = Record<string, unknown>;

type X402Credit = {
  tokenAddress: string;
  tokenStandard: string | null;
  tokenId: number;
  registry: string | null;
  projectId: string | null;
  vintage: number | null;
  liquidity: string;
  liquidityFormatted: string;
};

type X402CarbonClass = {
  carbonClassId: string;
  name: string | null;
  category: string | null;
  country: string | null;
  region: string | null;
  methodologies: unknown[];
  isRegistered: boolean | null;
  priceUsdcPerTonne: string | null;
  priceUsdcPerTonneFormatted: string | null;
  credits: string[];
  creditsDetailed: X402Credit[];
  minRetirementTonnes: string;
  minRetirementTonnesFormatted: string;
  minRetirementNote: string;
};

type X402DiscoverResponse = {
  carbonClasses: X402CarbonClass[];
  contracts?: Json;
  supportedInputTokens?: Json[];
  supportedCreditTypes?: Json[];
  x402FacilitatorVersion?: number;
  note?: string;
};

export type KlimaX402RefreshResult = {
  connected: boolean;
  published: number;
  discoveredClasses: number;
  baseUrl: string;
  chainId: number;
  discoveryOnly: true;
};

let lastRefreshAt = 0;
let refreshInFlight: Promise<KlimaX402RefreshResult> | null = null;

const CHAIN_ID = 8453;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const baseUrl = () => (process.env.KLIMA_X402_BASE_URL || "https://x402.klimalabs.com").replace(/\/$/, "");

function numberAt(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringAt(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function registryAutomaticallyEligible(registry: string) {
  const normalized = registry.toLowerCase();
  return normalized.includes("verra")
    || normalized.includes("vcs")
    || normalized.includes("gold standard")
    || normalized.includes("american carbon registry")
    || normalized === "acr"
    || normalized.includes("climate action reserve");
}

function methodologyFor(carbonClass: X402CarbonClass): string | null {
  const values = Array.isArray(carbonClass.methodologies)
    ? carbonClass.methodologies.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const object = item as Json;
        return stringAt(object.id, object.name, object.methodology);
      }
      return null;
    }).filter(Boolean)
    : [];
  return values.length ? values.join(", ").slice(0, 255) : carbonClass.category?.slice(0, 255) || null;
}

async function request<T = Json>(body: Json, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(`${baseUrl()}/api`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  if (!response.ok) {
    const object = data && typeof data === "object" ? data as Json : {};
    const message = String(object.message || object.error || `Klima x402 HTTP ${response.status}`);
    throw Object.assign(new Error(message), { status: response.status, x402: data });
  }
  return data as T;
}

async function upsertChannel(status: string, notes: string) {
  await pool.query(`
    INSERT INTO offset_source_channels
      (provider_key,provider_name,sourcing_mode,min_order_kg,fractional_supported,retirement_supported,
       beneficiary_retirement_supported,status,registry_scope,source_url,notes,last_checked_at)
    VALUES('klima-x402','Klima / Carbonmark x402','public_agentic_api',1,TRUE,TRUE,TRUE,$1,
      'Tokenized carbon liquidity on Base across supported registries','https://www.klimalabs.com/x402-endpoint',$2,NOW())
    ON CONFLICT(provider_key) DO UPDATE SET
      provider_name=EXCLUDED.provider_name,sourcing_mode=EXCLUDED.sourcing_mode,min_order_kg=EXCLUDED.min_order_kg,
      fractional_supported=EXCLUDED.fractional_supported,retirement_supported=EXCLUDED.retirement_supported,
      beneficiary_retirement_supported=EXCLUDED.beneficiary_retirement_supported,status=EXCLUDED.status,
      registry_scope=EXCLUDED.registry_scope,source_url=EXCLUDED.source_url,notes=EXCLUDED.notes,
      last_checked_at=NOW(),updated_at=NOW()`, [status, notes]);
}

export async function refreshKlimaX402Assets(): Promise<KlimaX402RefreshResult> {
  try {
    const catalog = await request<X402DiscoverResponse>({ action: "discover" });
    const classes = Array.isArray(catalog.carbonClasses) ? catalog.carbonClasses : [];
    const currentYear = new Date().getUTCFullYear();
    const maxVintageAgeYears = Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5));
    const minVintage = currentYear - maxVintageAgeYears;
    const limit = Math.max(1, Math.min(250, Number(process.env.KLIMA_X402_PUBLISHED_CREDIT_LIMIT || 100)));

    const candidates = classes.flatMap((carbonClass) => {
      const spotPrice = numberAt(carbonClass.priceUsdcPerTonneFormatted);
      const minRetirementTonnes = Math.max(0.001, numberAt(carbonClass.minRetirementTonnesFormatted) || 0.001);
      const minOrderKg = Math.max(1, Math.ceil(minRetirementTonnes * 1000));
      return (Array.isArray(carbonClass.creditsDetailed) ? carbonClass.creditsDetailed : []).map((credit) => {
        const liquidity = numberAt(credit.liquidityFormatted) || 0;
        const registry = stringAt(credit.registry) || "Klima x402";
        const projectId = stringAt(credit.projectId);
        const vintage = Number.isInteger(credit.vintage) ? Number(credit.vintage) : null;
        const isPuro = registry.toLowerCase().includes("puro");
        const registryEligible = registryAutomaticallyEligible(registry);
        const vintageEligible = vintage != null && vintage >= minVintage && vintage <= currentYear;
        const registryCandidate = carbonClass.isRegistered === true && registryEligible && vintageEligible && !isPuro;
        const riskFlags = [
          "x402-discovery-only-not-enabled-for-ecotracker-checkout",
          "x402-spot-price-requires-live-quote-before-purchase",
          ...(!registryCandidate ? ["registry-or-vintage-requires-eligibility-review"] : []),
          ...(isPuro ? ["puro-retirement-requires-consumption-metadata-and-whole-tonnes"] : []),
        ];
        return {
          carbonClass,
          credit,
          spotPrice,
          liquidity,
          registry,
          projectId,
          vintage,
          minOrderKg,
          minRetirementTonnes,
          registryCandidate,
          riskFlags,
        };
      });
    }).filter((item) => item.spotPrice != null && item.spotPrice > 0 && item.liquidity > 0)
      .sort((left, right) => {
        if (left.registryCandidate !== right.registryCandidate) return left.registryCandidate ? -1 : 1;
        return Number(right.liquidity) - Number(left.liquidity) || Number(left.spotPrice) - Number(right.spotPrice);
      })
      .slice(0, limit);

    await pool.query("UPDATE monitored_assets SET active=FALSE,updated_at=NOW() WHERE source_reference LIKE 'klima-x402-%'");
    const fxResult = await pool.query(`SELECT fx_brl_usd FROM monitored_assets WHERE fx_brl_usd>0 ORDER BY last_checked_at DESC NULLS LAST,updated_at DESC LIMIT 1`);
    const fx = Number(fxResult.rows[0]?.fx_brl_usd || 5.5);
    const commercialValidUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    for (const item of candidates) {
      const carbonClassId = item.carbonClass.carbonClassId;
      const tokenAddress = item.credit.tokenAddress.toLowerCase();
      const tokenId = Number(item.credit.tokenId || 0);
      const sourceReference = `klima-x402-${tokenAddress}-${tokenId}`;
      const projectName = item.carbonClass.name || item.projectId || `Klima x402 ${carbonClassId.slice(0, 10)}`;
      const sourceUrl = item.projectId
        ? `https://app.carbonmark.com/projects/${encodeURIComponent(item.projectId)}`
        : "https://www.klimalabs.com/x402-endpoint";
      const monitorDetails = {
        providerKey: "klima-x402",
        discoveryOnly: true,
        chainId: CHAIN_ID,
        inputToken: USDC_BASE,
        carbonClassId,
        carbonClassName: item.carbonClass.name,
        category: item.carbonClass.category,
        country: item.carbonClass.country,
        region: item.carbonClass.region,
        isRegistered: item.carbonClass.isRegistered,
        creditToken: item.credit.tokenAddress,
        tokenStandard: item.credit.tokenStandard,
        tokenId,
        registry: item.registry,
        projectId: item.projectId,
        vintage: item.vintage,
        spotPriceUsdcPerTonne: item.spotPrice,
        liquidityTonnes: item.liquidity,
        minRetirementTonnes: item.minRetirementTonnes,
        minRetirementNote: item.carbonClass.minRetirementNote,
        checkedAt: new Date().toISOString(),
        note: "Discovery público x402. O preço exibido é spot; qualquer compra exige /quote ao vivo. Checkout EcoTracker permanece bloqueado nesta fase.",
      };
      const vintageStart = item.vintage ? `${item.vintage}-01-01` : null;
      const vintageEnd = item.vintage ? `${item.vintage}-12-31` : null;
      const isPuro = item.registry.toLowerCase().includes("puro");
      const fractional = item.minOrderKg <= 1 && !isPuro;

      await pool.query(`
        INSERT INTO monitored_assets
          (registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
           source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,
           availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,
           eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,
           registry_batch_id,registry_evidence_url,retirement_supported,fractional_retirement_supported,
           retirement_granularity_kg,beneficiary_retirement_supported,eligibility_checked_at,eligibility_risk_flags)
        VALUES($1,$2,$3,$4,$5,$6,$7,'carbon','screening',$8,$9,$10,25,0,$11,$12,'quote','confirmed','connected',$13::jsonb,NOW(),TRUE,
           'climate_contribution','restricted',$14,'tradable',$15::date,$16::date,$17::date,$18,$19,$20,TRUE,$21,$22,TRUE,NOW(),$23::jsonb)
        ON CONFLICT(registry,source_reference) DO UPDATE SET
          project_name=EXCLUDED.project_name,source_url=EXCLUDED.source_url,methodology=EXCLUDED.methodology,location=EXCLUDED.location,
          vintage=EXCLUDED.vintage,quality_tier='screening',description=EXCLUDED.description,
          source_price_usd_ton=EXCLUDED.source_price_usd_ton,fx_brl_usd=EXCLUDED.fx_brl_usd,available_tons=EXCLUDED.available_tons,
          min_order_kg=EXCLUDED.min_order_kg,pricing_mode='quote',availability_status='confirmed',source_status='connected',
          monitor_details=EXCLUDED.monitor_details,last_checked_at=NOW(),active=TRUE,claim_category='climate_contribution',
          eligibility_status='restricted',eligibility_basis=EXCLUDED.eligibility_basis,source_unit_status='tradable',
          vintage_start=EXCLUDED.vintage_start,vintage_end=EXCLUDED.vintage_end,commercial_valid_until=EXCLUDED.commercial_valid_until,
          registry_project_id=EXCLUDED.registry_project_id,registry_batch_id=EXCLUDED.registry_batch_id,
          registry_evidence_url=EXCLUDED.registry_evidence_url,retirement_supported=TRUE,
          fractional_retirement_supported=EXCLUDED.fractional_retirement_supported,
          retirement_granularity_kg=EXCLUDED.retirement_granularity_kg,beneficiary_retirement_supported=TRUE,
          eligibility_checked_at=NOW(),eligibility_risk_flags=EXCLUDED.eligibility_risk_flags,updated_at=NOW()`,
        [
          item.registry, projectName, sourceReference, sourceUrl, methodologyFor(item.carbonClass),
          item.carbonClass.country || item.carbonClass.region || null, item.vintage ? String(item.vintage) : null,
          `Crédito retirable via Klima/Carbonmark x402 em Base. Registry ${item.registry}${item.vintage ? `, vintage ${item.vintage}` : ""}. Liquidez e preço são lidos ao vivo; execução comercial EcoTracker ainda não está habilitada para esta rail.`,
          item.spotPrice, fx, item.liquidity, item.minOrderKg, JSON.stringify(monitorDetails),
          item.registryCandidate
            ? "Candidato técnico a compensação identificado via x402, mas mantido fora da prateleira comercial até a integração de quote/retirement EcoTracker ser concluída."
            : "Ativo x402 monitorado para sourcing. Registry, vintage ou requisitos de retirement ainda exigem revisão antes de qualquer claim de compensação.",
          vintageStart, vintageEnd, commercialValidUntil, item.projectId || carbonClassId,
          `${item.credit.tokenAddress}:${tokenId}`, sourceUrl, fractional, item.minOrderKg, JSON.stringify(item.riskFlags),
        ],
      );
    }

    await upsertChannel("public_discovery_connected", `${candidates.length} créditos x402 publicados a partir de ${classes.length} classes. Discovery público em Base; checkout/retirement EcoTracker ainda desabilitado para esta rail.`);
    lastRefreshAt = Date.now();
    return { connected: true, published: candidates.length, discoveredClasses: classes.length, baseUrl: baseUrl(), chainId: CHAIN_ID, discoveryOnly: true };
  } catch (error) {
    await upsertChannel("degraded", `Falha no discovery x402: ${error instanceof Error ? error.message : "erro desconhecido"}`).catch(() => undefined);
    throw error;
  }
}

export async function refreshKlimaX402IfStale(maxAgeMs = 5 * 60 * 1000) {
  if (lastRefreshAt && Date.now() - lastRefreshAt < maxAgeMs) {
    return { connected: true, published: -1, discoveredClasses: -1, baseUrl: baseUrl(), chainId: CHAIN_ID, discoveryOnly: true, cached: true };
  }
  if (!refreshInFlight) refreshInFlight = refreshKlimaX402Assets().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function previewKlimaX402Quote(asset: Record<string, unknown>, requestedKg: number) {
  const details = asset.monitor_details && typeof asset.monitor_details === "object" ? asset.monitor_details as Json : {};
  const carbonClass = stringAt(details.carbonClassId);
  const creditToken = stringAt(details.creditToken);
  if (!carbonClass || !creditToken) throw new Error("Metadados x402 incompletos para cotação");
  const amount = Math.max(1, requestedKg) / 1000;
  return request<Json>({
    action: "quote",
    chainId: CHAIN_ID,
    inputToken: USDC_BASE,
    amount: String(amount),
    carbonClass,
    creditToken,
    ...(details.vintage != null ? { vintage: Number(details.vintage) } : {}),
    ...(details.tokenId != null ? { tokenId: String(details.tokenId) } : {}),
  }, 20_000);
}

export function isKlimaX402Asset(asset: Record<string, unknown>) {
  const details = asset.monitor_details && typeof asset.monitor_details === "object" ? asset.monitor_details as Json : {};
  return String(details.providerKey || "") === "klima-x402" || String(asset.source_reference || "").startsWith("klima-x402-");
}

export function klimaX402Status() {
  return {
    baseUrl: baseUrl(),
    chainId: CHAIN_ID,
    discoveryOnly: true,
    executionEnabled: false,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
  };
}
