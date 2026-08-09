import { pool } from "./db.js";

type Asset = Record<string, unknown>;

type CatalogDetails = {
  stockTons: number | null;
  vintages: number[];
  location: string | null;
  projectType: string | null;
  found: boolean;
};

export type GoldStandardEnrichmentResult = {
  connected: boolean;
  assetsSeen: number;
  enriched: number;
  verifiedAssisted: number;
  recentVintageCandidates: number;
  sourcePages: number;
  baseUrl: string;
};

let lastEnrichedAt = 0;
let enrichInFlight: Promise<GoldStandardEnrichmentResult> | null = null;
let workerStarted = false;

const baseUrl = () => (process.env.GOLD_STANDARD_MARKETPLACE_BASE || "https://marketplace.goldstandard.org").replace(/\/$/, "");

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&[#a-zA-Z0-9]+;/g, " ");
}

function cleanText(value: string) {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalized(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseYears(value: string | undefined): number[] {
  if (!value) return [];
  return Array.from(new Set((value.match(/(?:19|20)\d{2}/g) || []).map(Number)))
    .filter((year) => year >= 1990 && year <= 2100)
    .sort((a, b) => a - b);
}

async function fetchCatalogPages(): Promise<string[]> {
  const pages = Math.max(1, Math.min(8, Number(process.env.GOLD_STANDARD_CATALOG_PAGES || 4)));
  const results: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const suffix = page === 1 ? "" : `?page=${page}`;
    const response = await fetch(`${baseUrl()}/collections/projects${suffix}`, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "EcoTracker/1.0 (+https://ecotracker10.netlify.app)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if (page === 1) throw new Error(`Gold Standard catalog HTTP ${response.status}`);
      break;
    }
    const html = await response.text();
    const text = cleanText(html);
    if (!text || !/VINTAGES?/i.test(text)) {
      if (page === 1) throw new Error("Catálogo Gold Standard sem metadados de vintage visíveis");
      break;
    }
    results.push(text);
    // Shopify frequentemente devolve a última página novamente para páginas além do fim.
    if (results.length > 1 && results[results.length - 1] === results[results.length - 2]) break;
  }
  return results;
}

function extractAroundTitle(pageText: string, projectName: string): string | null {
  const page = normalized(pageText);
  const title = normalized(projectName);
  if (!title) return null;
  const index = page.indexOf(title);
  if (index < 0) return null;
  return page.slice(index, Math.min(page.length, index + 2600));
}

function detailsFromSegment(segment: string | null): CatalogDetails {
  if (!segment) return { stockTons: null, vintages: [], location: null, projectType: null, found: false };
  const stockMatch = segment.match(/in stock\s*\(([\d,]+)\s*units?\)/i);
  const vintagesMatch = segment.match(/vintages?\s*:\s*((?:19|20)\d{2}(?:\s*\|\s*(?:19|20)\d{2})*)/i);
  const locationMatch = segment.match(/location\s*:\s*([^|]{2,120}?)(?=\s+vintages?\s*:|\s+project type\s*:|\s+add to cart|$)/i);
  const typeMatch = segment.match(/project type\s*:\s*(.{2,120}?)(?=\s+add to cart|\s+view details|$)/i);
  return {
    stockTons: parseNumber(stockMatch?.[1]),
    vintages: parseYears(vintagesMatch?.[1]),
    location: locationMatch?.[1]?.trim() || null,
    projectType: typeMatch?.[1]?.trim() || null,
    found: true,
  };
}

function catalogDetails(pages: string[], projectName: string): CatalogDetails {
  for (const page of pages) {
    const details = detailsFromSegment(extractAroundTitle(page, projectName));
    if (details.found && (details.vintages.length || details.stockTons != null)) return details;
  }
  return { stockTons: null, vintages: [], location: null, projectType: null, found: false };
}

function existingFlags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

function mergeFlags(current: unknown, next: string[]) {
  const removablePrefixes = [
    "gold-standard-stock-quantity-not-confirmed",
    "gold-standard-vintage-not-resolved",
    "gold-standard-vintage-selection-not-supported",
    "gold-standard-marketplace-currently-unavailable",
    "vintage-outside-ecotracker-policy",
  ];
  const kept = existingFlags(current).filter((flag) => !removablePrefixes.includes(flag));
  return Array.from(new Set([...kept, ...next]));
}

function monitorDetails(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

export async function enrichGoldStandardMarketplaceAssets(): Promise<GoldStandardEnrichmentResult> {
  const pages = await fetchCatalogPages();
  const { rows } = await pool.query(
    "SELECT * FROM monitored_assets WHERE active=TRUE AND source_reference LIKE 'gold-standard-marketplace-%' ORDER BY id",
  );
  const currentYear = new Date().getUTCFullYear();
  const maxVintageAgeYears = Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5));
  const minVintage = currentYear - maxVintageAgeYears;
  const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let enriched = 0;
  let verifiedAssisted = 0;
  let recentVintageCandidates = 0;

  for (const asset of rows as Asset[]) {
    const details = catalogDetails(pages, String(asset.project_name || ""));
    if (!details.found) continue;
    enriched += 1;

    const stock = details.stockTons;
    const vintages = details.vintages;
    const oldest = vintages[0] || null;
    const newest = vintages[vintages.length - 1] || null;
    const allVintagesWithinPolicy = oldest != null && newest != null && oldest >= minVintage && newest <= currentYear;
    const hasStock = stock != null && stock > 0;
    const hasEvidence = Boolean(asset.registry_evidence_url || asset.source_url);
    const verified = hasStock && allVintagesWithinPolicy && hasEvidence;
    if (allVintagesWithinPolicy) recentVintageCandidates += 1;
    if (verified) verifiedAssisted += 1;

    // O marketplace oficial garante retirement no Impact Registry, certificate e
    // Retirement Attribution ao beneficiário. A execução segue assistida: isso
    // habilita o claim de compensação, mas NÃO checkout automático.
    const nextFlags = [
      "gold-standard-marketplace-execution-assisted",
      "gold-standard-commerce-api-not-integrated",
      ...(vintages.length > 1 ? ["gold-standard-vintage-allocation-confirm-at-retirement"] : []),
      ...(!hasStock ? ["gold-standard-stock-quantity-not-confirmed"] : []),
      ...(vintages.length === 0 ? ["gold-standard-vintage-not-resolved"] : []),
      ...(!allVintagesWithinPolicy && vintages.length > 0 ? ["vintage-outside-ecotracker-policy"] : []),
      ...(!hasEvidence ? ["gold-standard-registry-project-link-not-resolved"] : []),
    ];
    const riskFlags = mergeFlags(asset.eligibility_risk_flags, nextFlags);
    const currentDetails = monitorDetails(asset.monitor_details);
    const enrichment = {
      source: `${baseUrl()}/collections/projects`,
      stockTonnes: stock,
      vintages,
      oldestVintage: oldest,
      newestVintage: newest,
      allVintagesWithinPolicy,
      location: details.location,
      projectType: details.projectType,
      retirementMode: "gold_standard_marketplace_assisted",
      retirementCertificate: true,
      beneficiaryAttribution: true,
      checkedAt: new Date().toISOString(),
    };
    const vintageLabel = vintages.length ? vintages.join(" | ") : null;
    const vintageStart = oldest ? `${oldest}-01-01` : null;
    const vintageEnd = oldest ? `${oldest}-12-31` : null;

    await pool.query(`
      UPDATE monitored_assets SET
        vintage=$2,
        location=COALESCE($3,location),
        methodology=COALESCE($4,methodology),
        available_tons=$5,
        availability_status=$6,
        claim_category=$7,
        eligibility_status=$8,
        eligibility_basis=$9,
        source_unit_status=$10,
        vintage_start=$11::date,
        vintage_end=$12::date,
        commercial_valid_until=$13::date,
        retirement_supported=TRUE,
        fractional_retirement_supported=FALSE,
        retirement_granularity_kg=1000,
        beneficiary_retirement_supported=TRUE,
        eligibility_checked_at=NOW(),
        eligibility_risk_flags=$14::jsonb,
        quality_tier=$15,
        monitor_details=COALESCE(monitor_details,'{}'::jsonb) || jsonb_build_object('catalogEnrichment',$16::jsonb),
        last_checked_at=NOW(),
        updated_at=NOW()
      WHERE id=$1`, [
      asset.id,
      vintageLabel,
      details.location,
      details.projectType,
      stock,
      hasStock ? "indicative" : "monitoring",
      verified ? "voluntary_offset" : "climate_contribution",
      verified ? "eligible" : "restricted",
      verified
        ? "Oferta pública Gold Standard com estoque e todas as vintages dentro da política EcoTracker. O próprio Gold Standard aposenta os créditos no Impact Registry, permite Retirement Attribution e emite Retirement Certificate. Execução EcoTracker permanece assistida; a vintage efetivamente alocada deve ser confirmada no certificado antes do fulfillment final."
        : "Oferta Gold Standard monitorada. Permanece fora da prateleira de compensação até estoque, vintage e evidência satisfazerem integralmente a política EcoTracker.",
      hasStock ? "tradable" : "unknown",
      vintageStart,
      vintageEnd,
      validUntil,
      JSON.stringify(riskFlags),
      verified ? "verified-offset-assisted" : "screening",
      JSON.stringify(enrichment),
    ]);
  }

  lastEnrichedAt = Date.now();
  return {
    connected: true,
    assetsSeen: rows.length,
    enriched,
    verifiedAssisted,
    recentVintageCandidates,
    sourcePages: pages.length,
    baseUrl: baseUrl(),
  };
}

export async function enrichGoldStandardIfStale(maxAgeMs = 10 * 60 * 1000) {
  if (lastEnrichedAt && Date.now() - lastEnrichedAt < maxAgeMs) {
    return {
      connected: true,
      assetsSeen: -1,
      enriched: -1,
      verifiedAssisted: -1,
      recentVintageCandidates: -1,
      sourcePages: -1,
      baseUrl: baseUrl(),
      cached: true,
    };
  }
  if (!enrichInFlight) enrichInFlight = enrichGoldStandardMarketplaceAssets().finally(() => { enrichInFlight = null; });
  return enrichInFlight;
}

export function startGoldStandardEnrichmentWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const intervalMs = Math.max(60_000, Number(process.env.GOLD_STANDARD_ENRICH_INTERVAL_MS || 10 * 60 * 1000));
  void enrichGoldStandardIfStale(0).catch((error) => console.warn("[gold-standard] initial enrichment failed", error));
  const timer = setInterval(() => {
    void enrichGoldStandardIfStale().catch((error) => console.warn("[gold-standard] enrichment cycle failed", error));
  }, intervalMs);
  timer.unref();
}
