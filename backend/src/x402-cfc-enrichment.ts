import { pool } from "./db.js";

type Json = Record<string, unknown>;

const CFC_REGISTRY_URL = "https://www.cityforestcredits.org/carbon-credits/carbon-registry/";
const KLIMA_REGEN_DOCS = "https://docs.klimaprotocol.com/carbon-class-handbook/regen-network-credits";

const projects: Record<string, { name: string; regenProjectId: string; protocol: string }> = {
  C02003: {
    name: "Buena Vista Heights Conservation Area",
    regenProjectId: "C02-003",
    protocol: "City Forest Credits Tree Preservation Protocol",
  },
  C02004: {
    name: "Harvey Manning Park Expansion",
    regenProjectId: "C02-004",
    protocol: "City Forest Credits Tree Preservation Protocol",
  },
  C02006: {
    name: "St. Elmo Preservation Project",
    regenProjectId: "C02-006",
    protocol: "City Forest Credits Tree Preservation Protocol",
  },
};

let lastEnrichedAt = 0;
let enrichInFlight: Promise<X402CfcEnrichmentResult> | null = null;
let workerStarted = false;

export type X402CfcEnrichmentResult = {
  connected: boolean;
  candidates: number;
  verifiedFractional: number;
  skipped: number;
  registry: "City Forest Credits";
  executionMode: "assisted";
};

function details(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
    } catch { return {}; }
  }
  return {};
}

function flags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

function mergeFlags(current: unknown, next: string[]) {
  const remove = new Set([
    "registry-or-vintage-requires-eligibility-review",
    "registry-requires-manual-eligibility-review",
    "x402-discovery-only-not-enabled-for-ecotracker-checkout",
  ]);
  return Array.from(new Set([...flags(current).filter((flag) => !remove.has(flag)), ...next]));
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function enrichX402CityForestCredits(): Promise<X402CfcEnrichmentResult> {
  const { rows } = await pool.query(`
    SELECT * FROM monitored_assets
    WHERE active=TRUE
      AND source_reference LIKE 'klima-x402-%'
      AND registry='REGEN'
    ORDER BY id
  `);

  const currentYear = new Date().getUTCFullYear();
  const maxVintageAgeYears = Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5));
  const minVintage = currentYear - maxVintageAgeYears;
  const commercialValidUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let candidates = 0;
  let verifiedFractional = 0;
  let skipped = 0;

  for (const asset of rows) {
    const monitor = details(asset.monitor_details);
    const projectId = String(monitor.projectId || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const project = projects[projectId];
    if (!project) {
      skipped += 1;
      continue;
    }
    candidates += 1;

    const vintage = numeric(asset.vintage);
    const availableTons = numeric(asset.available_tons);
    const providerRegistered = monitor.isRegistered === true;
    const providerCategory = String(monitor.category || "").toLowerCase();
    const preservation = providerCategory.includes("preservation") || project.protocol.toLowerCase().includes("preservation");
    const vintageEligible = vintage != null && vintage >= minVintage && vintage <= currentYear;
    const supplyAvailable = availableTons != null && availableTons > 0;
    const retirementSupported = asset.retirement_supported === true;
    const fractional = asset.fractional_retirement_supported === true && Number(asset.retirement_granularity_kg || 1000) <= 1;
    const eligible = providerRegistered && preservation && vintageEligible && supplyAvailable && retirementSupported && fractional;

    const nextFlags = mergeFlags(asset.eligibility_risk_flags, [
      "cfc-icroa-endorsed-preservation-ex-post",
      "regen-registry-of-record-periodic-retirement-sync",
      "x402-execution-disabled-assisted-request-only",
      ...(eligible ? [] : ["cfc-x402-eligibility-prerequisite-missing"]),
    ]);

    const enrichment = {
      standard: "City Forest Credits",
      standardEvidence: "ICROA-endorsed carbon registry; preservation credits are ex-post",
      canonicalRegistry: "Regen Network",
      canonicalProjectId: project.regenProjectId,
      projectName: project.name,
      protocol: project.protocol,
      registryEvidenceUrl: CFC_REGISTRY_URL,
      bridgeEvidenceUrl: KLIMA_REGEN_DOCS,
      providerRegistered,
      preservation,
      vintageEligible,
      supplyAvailable,
      retirementSupported,
      fractionalRetirement: fractional,
      executionMode: "assisted",
      registrySyncMode: "periodic_after_base_retirement",
      checkedAt: new Date().toISOString(),
    };

    await pool.query(`
      UPDATE monitored_assets SET
        project_name=$2,
        methodology=$3,
        quality_tier=$4,
        claim_category=$5,
        eligibility_status=$6,
        eligibility_basis=$7,
        source_unit_status=$8,
        commercial_valid_until=$9::date,
        registry_project_id=$10,
        registry_evidence_url=$11,
        retirement_supported=TRUE,
        fractional_retirement_supported=TRUE,
        retirement_granularity_kg=1,
        beneficiary_retirement_supported=TRUE,
        availability_status=$12,
        pricing_mode='quote',
        eligibility_checked_at=NOW(),
        eligibility_risk_flags=$13::jsonb,
        monitor_details=COALESCE(monitor_details,'{}'::jsonb) || jsonb_build_object('cfcEnrichment',$14::jsonb),
        last_checked_at=NOW(),
        updated_at=NOW()
      WHERE id=$1`, [
      asset.id,
      project.name,
      project.protocol,
      eligible ? "verified-offset-assisted-fractional" : "screening",
      eligible ? "voluntary_offset" : "climate_contribution",
      eligible ? "eligible" : "restricted",
      eligible
        ? "City Forest Credits preservation credit, ex-post and ICROA-endorsed, mirrored from escrowed Regen Network credits to Base. The x402 rail supports fractional retirement and the canonical Regen retirement is synchronized after Base retirement. EcoTracker execution remains assisted while x402 paid execution is disabled; no automatic checkout is permitted."
        : "CFC/Regen x402 candidate remains restricted until registry, preservation, vintage, supply and fractional-retirement prerequisites are all confirmed.",
      eligible ? "tradable" : "unknown",
      commercialValidUntil,
      project.regenProjectId,
      CFC_REGISTRY_URL,
      // Deliberately indicative: verified claim does not imply that the EcoTracker
      // has programmatic execution enabled for this rail.
      eligible ? "indicative" : "monitoring",
      JSON.stringify(nextFlags),
      JSON.stringify(enrichment),
    ]);

    if (eligible) verifiedFractional += 1;
  }

  lastEnrichedAt = Date.now();
  return {
    connected: true,
    candidates,
    verifiedFractional,
    skipped,
    registry: "City Forest Credits",
    executionMode: "assisted",
  };
}

export async function enrichX402CfcIfStale(maxAgeMs = 5 * 60 * 1000) {
  if (lastEnrichedAt && Date.now() - lastEnrichedAt < maxAgeMs) {
    return {
      connected: true,
      candidates: -1,
      verifiedFractional: -1,
      skipped: -1,
      registry: "City Forest Credits" as const,
      executionMode: "assisted" as const,
      cached: true,
    };
  }
  if (!enrichInFlight) enrichInFlight = enrichX402CityForestCredits().finally(() => { enrichInFlight = null; });
  return enrichInFlight;
}

export function startX402CfcEnrichmentWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const intervalMs = Math.max(60_000, Number(process.env.KLIMA_X402_CFC_ENRICH_INTERVAL_MS || 5 * 60 * 1000));
  void enrichX402CfcIfStale(0).catch((error) => console.warn("[x402-cfc] initial enrichment failed", error));
  const timer = setInterval(() => {
    void enrichX402CfcIfStale().catch((error) => console.warn("[x402-cfc] enrichment cycle failed", error));
  }, intervalMs);
  timer.unref();
}
