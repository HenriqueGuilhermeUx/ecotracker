import { pool } from "./db.js";

export type CarbonmarkQuote = {
  uuid: string;
  assetPriceSourceId: string;
  quantityTonnes: number;
  costUsdc: number;
  raw: Record<string, unknown>;
};

export type CarbonmarkOrderResult = {
  status: "completed" | "processing";
  reference: string;
  txHash: string | null;
  viewRetirementUrl: string | null;
  certificateUrl: string | null;
  provenanceUrl: string | null;
  retirementId: string | null;
  raw: Record<string, unknown>;
};

type Json = Record<string, unknown>;

let lastRefreshAt = 0;
let refreshInFlight: Promise<{ published: number; connected: boolean; baseUrl: string; environment: string }> | null = null;

const environment = () => String(process.env.CARBONMARK_ENVIRONMENT || "sandbox").toLowerCase();
const configuredBase = () => process.env.CARBONMARK_API_BASE?.replace(/\/$/, "");
const stableBase = () => configuredBase() || "https://v18.api.carbonmark.com";
const baseCandidates = () => [stableBase()];

const apiKey = () => process.env.CARBONMARK_API_KEY?.trim() || "";

function authHeaders(body = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (apiKey()) headers.Authorization = `Bearer ${apiKey()}`;
  return headers;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  if (!response.ok) {
    const object = data && typeof data === "object" ? data as Json : {};
    const message = String(object.message || object.error || object.detail || `Carbonmark HTTP ${response.status}`);
    throw Object.assign(new Error(message), { status: response.status, carbonmark: data });
  }
  return data;
}

async function request(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<{ data: unknown; baseUrl: string }> {
  let lastError: unknown = null;
  for (const baseUrl of baseCandidates()) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...authHeaders(Boolean(init.body)), ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { data: await parseResponse(response), baseUrl };
    } catch (error) {
      lastError = error;
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : 0;
      if (status === 401 || status === 403) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Carbonmark indisponível");
}

async function requestListEndpoint(pathWithPagination: string, barePath: string) {
  try { return await request(pathWithPagination); }
  catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : 0;
    if (status !== 400 && status !== 404 && status !== 422) throw error;
    return request(barePath);
  }
}

function listFrom(data: unknown, preferredKeys: string[] = []): Json[] {
  if (Array.isArray(data)) return data.filter((item): item is Json => Boolean(item) && typeof item === "object");
  if (!data || typeof data !== "object") return [];
  const object = data as Json;
  for (const key of [...preferredKeys, "items", "results", "data", "rows"]) {
    const value = object[key];
    if (Array.isArray(value)) return value.filter((item): item is Json => Boolean(item) && typeof item === "object");
  }
  return [];
}

function objectAt(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function numberAt(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
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

function booleanAt(...values: unknown[]): boolean {
  for (const value of values) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
  }
  return false;
}

function yearFrom(value: unknown): number | null {
  const direct = Number(value);
  if (Number.isInteger(direct) && direct >= 1990 && direct <= 2100) return direct;
  const match = String(value || "").match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function registryName(raw: string | null, projectKey: string) {
  const source = String(raw || projectKey.split("-")[0] || "").trim();
  const normalized = source.toUpperCase();
  const names: Record<string, string> = {
    VCS: "Verra VCS",
    VERRA: "Verra VCS",
    GS: "Gold Standard",
    GOLDSTANDARD: "Gold Standard",
    ACR: "American Carbon Registry",
    CAR: "Climate Action Reserve",
    PURO: "Puro.earth",
    UCR: "Universal Carbon Registry",
    CFC: "City Forest Credits",
  };
  return names[normalized.replace(/[^A-Z]/g, "")] || source || "Carbonmark";
}

function registryAutomaticallyEligible(registry: string) {
  const normalized = registry.toLowerCase();
  return normalized.includes("verra")
    || normalized.includes("gold standard")
    || normalized.includes("american carbon registry")
    || normalized.includes("climate action reserve");
}

function descriptionFor(project: Json, registry: string, vintage: number | null) {
  const direct = stringAt(project.description, project.short_description, project.shortDescription);
  if (direct) return direct.slice(0, 2400);
  return `Crédito de carbono ${registry}${vintage ? `, vintage ${vintage}` : ""}, ofertado por listing da Carbonmark com aposentadoria programática e comprovante verificável.`;
}

function methodologyFor(project: Json) {
  const methodologies = project.methodologies;
  if (Array.isArray(methodologies)) {
    const names = methodologies.map((item) => {
      const object = objectAt(item);
      return stringAt(object.id, object.name);
    }).filter(Boolean);
    if (names.length) return names.join(", ").slice(0, 255);
  }
  return stringAt(project.methodology, project.category)?.slice(0, 255) || null;
}

function projectIndex(projects: Json[]) {
  const map = new Map<string, Json>();
  for (const project of projects) {
    const key = stringAt(project.key, project.id, project.projectID, project.projectId);
    if (key) map.set(key.toUpperCase(), project);
    const projectId = stringAt(project.projectID, project.projectId);
    const registry = stringAt(project.registry);
    if (projectId && registry) map.set(`${registry}-${projectId}`.toUpperCase(), project);
  }
  return map;
}

async function readCarbonmarkMarket() {
  const [projectsResult, pricesResult] = await Promise.all([
    requestListEndpoint("/carbonProjects?limit=250", "/carbonProjects"),
    requestListEndpoint("/prices?limit=500", "/prices"),
  ]);
  const projects = listFrom(projectsResult.data, ["carbonProjects"]);
  const prices = listFrom(pricesResult.data, ["prices"]);
  return { projects, prices, baseUrl: pricesResult.baseUrl || projectsResult.baseUrl };
}

export async function refreshCarbonmarkAssets() {
  if (!apiKey()) {
    await pool.query(`UPDATE offset_source_channels SET status='awaiting_configuration',last_checked_at=NOW(),updated_at=NOW() WHERE provider_key='carbonmark'`).catch(() => undefined);
    return { published: 0, connected: false, baseUrl: baseCandidates()[0], environment: environment() };
  }

  const { projects, prices, baseUrl } = await readCarbonmarkMarket();
  const byProject = projectIndex(projects);
  const currentYear = new Date().getUTCFullYear();
  const maxVintageAgeYears = Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5));
  const minVintage = currentYear - maxVintageAgeYears;
  const limit = Math.max(1, Math.min(100, Number(process.env.CARBONMARK_PUBLISHED_LISTING_LIMIT || 30)));

  const normalized = prices.map((price) => {
    const type = String(price.type || "listing").toLowerCase();
    const listing = objectAt(price.listing);
    const token = objectAt(listing.token);
    const creditId = objectAt(listing.creditId || listing.credit_id || price.creditId || price.credit_id);
    const sourceId = stringAt(price.sourceId, price.asset_price_source_id, price.assetPriceSourceId);
    const projectKey = stringAt(creditId.projectId, creditId.project_id, listing.projectId, price.projectId);
    const purchasePrice = numberAt(price.purchasePrice, price.purchase_price, price.price, price.price_usdc);
    const supply = numberAt(price.supply, listing.supply, listing.amount);
    const minFillTonnes = Math.max(0.001, numberAt(price.minFillAmount, price.min_fill_amount) || 0.001);
    if (!sourceId || !projectKey || !purchasePrice || purchasePrice <= 0 || !supply || supply <= 0 || type !== "listing") return null;

    const project = byProject.get(projectKey.toUpperCase()) || {};
    const vintage = yearFrom(creditId.vintage ?? project.vintage ?? (Array.isArray(project.vintages) ? project.vintages[0] : null));
    const registry = registryName(stringAt(project.registry), projectKey);
    const lowerRegistry = registry.toLowerCase();
    const requiresConsumptionMetadata = lowerRegistry.includes("puro");
    const isExAnte = booleanAt(token.isExAnte, token.is_ex_ante, listing.isExAnte, listing.is_ex_ante);
    const vintageEligible = vintage != null && vintage >= minVintage && vintage <= currentYear;
    const registryEligible = registryAutomaticallyEligible(registry);
    const eligible = vintageEligible && registryEligible && !isExAnte && !requiresConsumptionMetadata;
    const commercialValidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const projectName = stringAt(project.name, project.projectName) || `Carbonmark ${projectKey}`;
    const country = stringAt(project.country, project.location);
    const evidenceUrl = stringAt(project.url, project.project_url, project.projectUrl)
      || `${baseUrl}/carbonProjects/${encodeURIComponent(projectKey)}`;
    const minOrderKg = Math.max(1, Math.ceil(minFillTonnes * 1000));
    return {
      sourceId, projectKey, purchasePrice, supply, minFillTonnes, minOrderKg,
      projectName, country, vintage, registry, evidenceUrl,
      methodology: methodologyFor(project),
      description: descriptionFor(project, registry, vintage),
      eligible, requiresConsumptionMetadata, isExAnte, registryEligible, commercialValidUntil,
      riskFlags: [
        ...(vintage == null ? ["vintage-not-resolved"] : []),
        ...(!vintageEligible && vintage != null ? ["vintage-outside-ecotracker-policy"] : []),
        ...(!registryEligible ? ["registry-requires-manual-eligibility-review"] : []),
        ...(isExAnte ? ["ex-ante-credit-not-allowed-for-automatic-offset"] : []),
        ...(requiresConsumptionMetadata ? ["puro-consumption-metadata-required"] : []),
      ],
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return a.purchasePrice - b.purchasePrice;
    })
    .slice(0, limit);

  await pool.query("UPDATE monitored_assets SET active=FALSE,updated_at=NOW() WHERE source_reference LIKE 'carbonmark-%'");
  const fxResult = await pool.query(`SELECT fx_brl_usd FROM monitored_assets WHERE fx_brl_usd>0 ORDER BY last_checked_at DESC NULLS LAST,updated_at DESC LIMIT 1`);
  const fx = Number(fxResult.rows[0]?.fx_brl_usd || 5.5);

  for (const item of normalized) {
    const monitorDetails = {
      providerKey: "carbonmark",
      environment: environment(),
      apiBaseUrl: baseUrl,
      assetPriceSourceId: item.sourceId,
      projectKey: item.projectKey,
      purchasePriceUsdTon: item.purchasePrice,
      minFillTonnes: item.minFillTonnes,
      fractionalRetirement: item.minOrderKg <= 1,
      registryEligible: item.registryEligible,
      isExAnte: item.isExAnte,
      checkedAt: new Date().toISOString(),
      note: item.eligible
        ? "Listing Carbonmark com preço visível, aposentadoria programática e elegibilidade EcoTracker vigente."
        : "Listing Carbonmark monitorado, mas mantido fora da prateleira de compensação até cumprir a política de elegibilidade.",
    };
    const vintageStart = item.vintage ? `${item.vintage}-01-01` : null;
    const vintageEnd = item.vintage ? `${item.vintage}-12-31` : null;
    await pool.query(`
      INSERT INTO monitored_assets
        (registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
         source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,
         availability_status,source_status,monitor_details,last_checked_at,active,claim_category,eligibility_status,
         eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,registry_project_id,
         registry_batch_id,registry_evidence_url,retirement_supported,fractional_retirement_supported,
         retirement_granularity_kg,beneficiary_retirement_supported,eligibility_checked_at,eligibility_risk_flags)
      VALUES($1,$2,$3,$4,$5,$6,$7,'carbon','verified-offset',$8,$9,$10,25,0,$11,$12,'dynamic','confirmed','connected',$13::jsonb,NOW(),TRUE,
         $14,$15,$16,'tradable',$17::date,$18::date,$19::date,$20,$21,$22,TRUE,$23,$24,TRUE,NOW(),$25::jsonb)
      ON CONFLICT(registry,source_reference) DO UPDATE SET
        project_name=EXCLUDED.project_name,source_url=EXCLUDED.source_url,methodology=EXCLUDED.methodology,location=EXCLUDED.location,
        vintage=EXCLUDED.vintage,quality_tier=EXCLUDED.quality_tier,description=EXCLUDED.description,
        source_price_usd_ton=EXCLUDED.source_price_usd_ton,fx_brl_usd=EXCLUDED.fx_brl_usd,available_tons=EXCLUDED.available_tons,
        min_order_kg=EXCLUDED.min_order_kg,pricing_mode='dynamic',availability_status='confirmed',source_status='connected',
        monitor_details=EXCLUDED.monitor_details,last_checked_at=NOW(),active=TRUE,claim_category=EXCLUDED.claim_category,
        eligibility_status=EXCLUDED.eligibility_status,eligibility_basis=EXCLUDED.eligibility_basis,source_unit_status='tradable',
        vintage_start=EXCLUDED.vintage_start,vintage_end=EXCLUDED.vintage_end,commercial_valid_until=EXCLUDED.commercial_valid_until,
        registry_project_id=EXCLUDED.registry_project_id,registry_batch_id=EXCLUDED.registry_batch_id,
        registry_evidence_url=EXCLUDED.registry_evidence_url,retirement_supported=TRUE,
        fractional_retirement_supported=EXCLUDED.fractional_retirement_supported,
        retirement_granularity_kg=EXCLUDED.retirement_granularity_kg,beneficiary_retirement_supported=TRUE,
        eligibility_checked_at=NOW(),eligibility_risk_flags=EXCLUDED.eligibility_risk_flags,updated_at=NOW()`,
      [
        item.registry, item.projectName, `carbonmark-${item.sourceId}`, item.evidenceUrl, item.methodology, item.country,
        item.vintage ? String(item.vintage) : null, item.description, item.purchasePrice, fx, item.supply, item.minOrderKg,
        JSON.stringify(monitorDetails), item.eligible ? "voluntary_offset" : "climate_contribution",
        item.eligible ? "eligible" : "restricted",
        item.eligible
          ? "Listing Carbonmark de registry aceito, não ex-ante, com preço executável, aposentadoria programática, status tradable e vintage dentro da política comercial EcoTracker. Uso: compensação voluntária, não compliance."
          : "Listing Carbonmark fora da prateleira de compensação automática até resolver as flags registradas.",
        vintageStart, vintageEnd, item.commercialValidUntil, item.projectKey, item.sourceId, item.evidenceUrl,
        item.minOrderKg <= 1, item.minOrderKg, JSON.stringify(item.riskFlags),
      ],
    );
  }

  await pool.query(`
    UPDATE offset_source_channels SET
      status=$1,last_checked_at=NOW(),updated_at=NOW(),
      notes=$2
    WHERE provider_key='carbonmark'`,
    [environment() === "production" ? "production_connected" : "sandbox_connected",
      `${normalized.length} listings Carbonmark publicados. API ${baseUrl}. Ambiente ${environment()}.`],
  );

  lastRefreshAt = Date.now();
  return { published: normalized.length, connected: true, baseUrl, environment: environment() };
}

export async function refreshCarbonmarkIfStale(maxAgeMs = 5 * 60 * 1000) {
  if (lastRefreshAt && Date.now() - lastRefreshAt < maxAgeMs) {
    return { published: -1, connected: Boolean(apiKey()), baseUrl: baseCandidates()[0], environment: environment(), cached: true };
  }
  if (!refreshInFlight) refreshInFlight = refreshCarbonmarkAssets().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function createCarbonmarkQuote(assetPriceSourceId: string, quantityTonnes: number): Promise<CarbonmarkQuote> {
  if (!apiKey()) throw Object.assign(new Error("CARBONMARK_API_KEY não configurada"), { code: "PROVIDER_NOT_CONFIGURED" });
  const { data } = await request("/quotes", {
    method: "POST",
    body: JSON.stringify({ asset_price_source_id: assetPriceSourceId, quantity_tonnes: quantityTonnes }),
  }, 20000);
  const object = objectAt(data);
  const uuid = stringAt(object.uuid);
  const costUsdc = numberAt(object.cost_usdc, object.costUsdc);
  if (!uuid || costUsdc == null || costUsdc <= 0) throw new Error("Carbonmark não retornou uma cotação executável");
  return {
    uuid,
    assetPriceSourceId: stringAt(object.asset_price_source_id, object.assetPriceSourceId) || assetPriceSourceId,
    quantityTonnes: numberAt(object.quantity_tonnes, object.quantityTonnes) || quantityTonnes,
    costUsdc,
    raw: object,
  };
}

function firstOrder(data: unknown): Json | null {
  const list = listFrom(data, ["orders"]);
  if (list[0]) return list[0];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const object = data as Json;
    if (object.status || object.quote) return object;
  }
  return null;
}

function completedOrder(order: Json, quoteUuid: string): CarbonmarkOrderResult {
  const retirement = objectAt(order.retirement);
  const retirementId = stringAt(order.retirement_id, order.retirementId, retirement.id);
  const viewRetirementUrl = stringAt(order.view_retirement_url, order.viewRetirementUrl, retirement.url);
  const certificateUrl = stringAt(order.certificate_url, order.certificateUrl)
    || (retirementId ? `${baseCandidates()[0]}/retirements/${encodeURIComponent(retirementId)}/certificate` : viewRetirementUrl);
  const provenanceUrl = stringAt(order.provenance_url, order.provenanceUrl)
    || (retirementId ? `${baseCandidates()[0]}/retirements/${encodeURIComponent(retirementId)}/provenance` : null);
  const txHash = stringAt(order.transaction_hash, order.transactionHash, retirement.transaction_hash, retirement.transactionHash);
  return {
    status: "completed",
    reference: viewRetirementUrl || retirementId || quoteUuid,
    txHash,
    viewRetirementUrl,
    certificateUrl,
    provenanceUrl,
    retirementId,
    raw: order,
  };
}

async function fetchOrderForQuote(quoteUuid: string): Promise<Json | null> {
  const { data } = await request(`/orders?quote_uuid=${encodeURIComponent(quoteUuid)}`, {}, 12000);
  return firstOrder(data);
}

export async function executeCarbonmarkRetirement(input: {
  quoteUuid: string;
  beneficiaryName: string;
  retirementMessage: string;
}): Promise<CarbonmarkOrderResult> {
  if (!apiKey()) throw Object.assign(new Error("CARBONMARK_API_KEY não configurada"), { code: "PROVIDER_NOT_CONFIGURED" });

  let order = await fetchOrderForQuote(input.quoteUuid).catch(() => null);
  if (!order) {
    const { data } = await request("/orders", {
      method: "POST",
      body: JSON.stringify({
        quote_uuid: input.quoteUuid,
        beneficiary_name: input.beneficiaryName.slice(0, 180),
        retirement_message: input.retirementMessage.slice(0, 500),
      }),
    }, 20000);
    order = firstOrder(data) || objectAt(data);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const status = String(order?.status || "").toUpperCase();
    if (status === "COMPLETED") return completedOrder(order || {}, input.quoteUuid);
    if (["FAILED", "CANCELLED", "CANCELED", "REJECTED"].includes(status)) {
      throw new Error(`Carbonmark order ${status.toLowerCase()}`);
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1000 + attempt * 500));
      order = await fetchOrderForQuote(input.quoteUuid).catch(() => order);
    }
  }

  return {
    status: "processing",
    reference: stringAt(order?.id, order?.uuid) || input.quoteUuid,
    txHash: stringAt(order?.transaction_hash, order?.transactionHash),
    viewRetirementUrl: stringAt(order?.view_retirement_url, order?.viewRetirementUrl),
    certificateUrl: null,
    provenanceUrl: null,
    retirementId: stringAt(order?.retirement_id, order?.retirementId),
    raw: order || {},
  };
}

export function carbonmarkStatus() {
  return {
    configured: Boolean(apiKey()),
    environment: environment(),
    stableApiVersion: "v18",
    baseCandidates: baseCandidates(),
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
  };
}