import { pool } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

type Asset = Record<string, unknown>;
type Json = Record<string, unknown>;

export type SourcingOpportunityAction =
  | "complete_x402_execution_rail"
  | "integrate_gold_standard_commerce_api"
  | "source_newer_vintage"
  | "review_registry_and_vintage"
  | "configure_puro_metadata"
  | "confirm_registry_unit_status"
  | "configure_retirement_executor"
  | "attach_registry_evidence"
  | "refresh_eligibility_review"
  | "complete_eligibility_review"
  | "confirm_price_and_inventory"
  | "reduce_fractional_minimum"
  | "manual_policy_review";

export type SourcingOpportunity = {
  assetId: number;
  publicCode: string | null;
  providerKey: string;
  registry: string;
  projectName: string;
  sourceReference: string;
  vintage: string | null;
  availableTons: number | null;
  minOrderKg: number;
  sourcingScore: number;
  sourcingTier: string;
  sourcingRank: number | null;
  blocker: string;
  riskFlags: string[];
  action: SourcingOpportunityAction;
  actionLabel: string;
  priority: number;
  readyForPolicyReview: boolean;
  whyPromising: string[];
};

const bool = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";

function numberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function jsonObject(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    } catch { /* ignore malformed provider metadata */ }
  }
  return {};
}

function flagsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

function providerKey(asset: Asset): string {
  const details = jsonObject(asset.monitor_details);
  const explicit = stringValue(details.providerKey);
  if (explicit) return explicit;
  const ref = stringValue(asset.source_reference).toLowerCase();
  if (ref.startsWith("carbonmark-")) return "carbonmark";
  if (ref.startsWith("klima-x402-")) return "klima-x402";
  if (ref.startsWith("gold-standard-marketplace-")) return "gold-standard";
  if (ref.startsWith("regen-")) return "regen";
  return stringValue(asset.registry, "manual").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "manual";
}

function includesAny(flags: string[], needles: string[]) {
  return flags.some((flag) => needles.some((needle) => flag.includes(needle)));
}

function remediation(asset: Asset, blocker: string, flags: string[]): {
  action: SourcingOpportunityAction;
  label: string;
  priority: number;
} {
  const lower = blocker.toLowerCase();
  if (flags.includes("x402-discovery-only-not-enabled-for-ecotracker-checkout")) {
    return { action: "complete_x402_execution_rail", label: "Concluir e validar a rail de execução x402", priority: 100 };
  }
  if (flags.includes("gold-standard-commerce-api-not-integrated")) {
    return { action: "integrate_gold_standard_commerce_api", label: "Integrar Commerce API do Gold Standard", priority: 97 };
  }
  if (flags.includes("puro-retirement-requires-consumption-metadata-and-whole-tonnes")) {
    return { action: "configure_puro_metadata", label: "Configurar metadata Puro e operação em toneladas inteiras", priority: 92 };
  }
  if (flags.includes("vintage-outside-ecotracker-policy") || lower.includes("vintage excede")) {
    return { action: "source_newer_vintage", label: "Buscar vintage mais recente ou documentar exceção", priority: 94 };
  }
  if (flags.includes("registry-or-vintage-requires-eligibility-review") || flags.includes("registry-requires-manual-eligibility-review")) {
    return { action: "review_registry_and_vintage", label: "Revisar registry, vintage e claim permitido", priority: 90 };
  }
  if (lower.includes("status registral") || lower.includes("tradable") || stringValue(asset.source_unit_status) !== "tradable") {
    return { action: "confirm_registry_unit_status", label: "Confirmar unidade tradable no registry", priority: 96 };
  }
  if (lower.includes("aposentadoria") || !bool(asset.retirement_supported)) {
    return { action: "configure_retirement_executor", label: "Configurar aposentadoria executável e comprovável", priority: 98 };
  }
  if (lower.includes("evidência pública") || (!asset.registry_evidence_url && !asset.source_url)) {
    return { action: "attach_registry_evidence", label: "Anexar evidência pública do registry/projeto", priority: 84 };
  }
  if (lower.includes("desatualizada")) {
    return { action: "refresh_eligibility_review", label: "Atualizar revisão de elegibilidade", priority: 88 };
  }
  if (lower.includes("ainda não possui data de revisão") || lower.includes("ainda não está aprovada")) {
    return { action: "complete_eligibility_review", label: "Concluir revisão de elegibilidade", priority: 86 };
  }
  if (stringValue(asset.availability_status) !== "confirmed" || !(numberValue(asset.source_price_usd_ton) || 0) || !(numberValue(asset.available_tons) || 0)) {
    return { action: "confirm_price_and_inventory", label: "Confirmar preço executável e inventário", priority: 82 };
  }
  if (lower.includes("blocos de") || Number(asset.min_order_kg || 1000) > 1) {
    return { action: "reduce_fractional_minimum", label: "Buscar fonte com retirement fracionário menor", priority: 78 };
  }
  return { action: "manual_policy_review", label: "Revisar política e documentação manualmente", priority: 70 };
}

function promisingReasons(asset: Asset): string[] {
  const reasons: string[] = [];
  if (stringValue(asset.source_status) === "connected") reasons.push("fonte conectada");
  if (stringValue(asset.availability_status) === "confirmed") reasons.push("disponibilidade confirmada");
  if ((numberValue(asset.source_price_usd_ton) || 0) > 0) reasons.push("preço disponível");
  if ((numberValue(asset.available_tons) || 0) > 0) reasons.push("liquidez disponível");
  if (stringValue(asset.source_unit_status) === "tradable") reasons.push("unidade tradable");
  if (bool(asset.retirement_supported)) reasons.push("retirement suportado");
  if (bool(asset.beneficiary_retirement_supported)) reasons.push("beneficiário suportado");
  if (bool(asset.fractional_retirement_supported) && Number(asset.retirement_granularity_kg || 1000) <= 1) reasons.push("fracionável até 1 kg");
  if (asset.registry_evidence_url || asset.source_url) reasons.push("evidência pública disponível");
  return reasons;
}

function policyReviewReady(asset: Asset, flags: string[]): boolean {
  const hardFlags = [
    "registry-or-vintage-requires-eligibility-review",
    "registry-requires-manual-eligibility-review",
    "vintage-outside-ecotracker-policy",
    "vintage-not-resolved",
    "gold-standard-vintage-not-resolved",
    "gold-standard-vintage-selection-not-supported",
    "gold-standard-commerce-api-not-integrated",
    "puro-retirement-requires-consumption-metadata-and-whole-tonnes",
    "ex-ante-credit-not-allowed-for-automatic-offset",
  ];
  return stringValue(asset.source_status) === "connected"
    && stringValue(asset.availability_status) === "confirmed"
    && stringValue(asset.source_unit_status) === "tradable"
    && (numberValue(asset.source_price_usd_ton) || 0) > 0
    && (numberValue(asset.available_tons) || 0) > 0
    && bool(asset.retirement_supported)
    && Boolean(asset.registry_evidence_url || asset.source_url)
    && !includesAny(flags, hardFlags);
}

export async function getSourcingOpportunityReport() {
  const { rows } = await pool.query(`
    SELECT * FROM monitored_assets
    WHERE active=TRUE
    ORDER BY sourcing_score DESC,sourcing_rank ASC NULLS LAST,updated_at DESC
    LIMIT 500
  `);

  const riskFlagCounts = new Map<string, number>();
  const providerCounts = new Map<string, { assets: number; verified: number; executable: number; restricted: number }>();
  const actionCounts = new Map<SourcingOpportunityAction, { count: number; label: string; maxPriority: number }>();
  const opportunities: SourcingOpportunity[] = [];

  for (const asset of rows) {
    const provider = providerKey(asset);
    const providerStats = providerCounts.get(provider) || { assets: 0, verified: 0, executable: 0, restricted: 0 };
    providerStats.assets += 1;
    if (stringValue(asset.sourcing_shelf) === "verified_compensation") providerStats.verified += 1;
    if (bool(asset.sourcing_executable)) providerStats.executable += 1;
    if (stringValue(asset.sourcing_shelf) === "restricted" || stringValue(asset.eligibility_status) === "restricted") providerStats.restricted += 1;
    providerCounts.set(provider, providerStats);

    const flags = flagsFrom(asset.eligibility_risk_flags);
    for (const flag of flags) riskFlagCounts.set(flag, (riskFlagCounts.get(flag) || 0) + 1);

    const requestedKg = Math.max(1, Number(asset.min_order_kg || 1000));
    const decision = evaluateAssetEligibility(asset, "voluntary_offset", requestedKg);
    if (decision.allowed) continue;

    const fix = remediation(asset, decision.reason, flags);
    const whyPromising = promisingReasons(asset);
    const readyForPolicyReview = policyReviewReady(asset, flags);
    const score = Number(asset.sourcing_score || 0);
    const priority = Math.min(100, Math.max(1, Math.round(fix.priority * 0.72 + score * 0.28 + (readyForPolicyReview ? 5 : 0))));

    const existingAction = actionCounts.get(fix.action) || { count: 0, label: fix.label, maxPriority: 0 };
    existingAction.count += 1;
    existingAction.maxPriority = Math.max(existingAction.maxPriority, priority);
    actionCounts.set(fix.action, existingAction);

    opportunities.push({
      assetId: Number(asset.id),
      publicCode: asset.public_code ? String(asset.public_code) : null,
      providerKey: provider,
      registry: stringValue(asset.registry, "Desconhecido"),
      projectName: stringValue(asset.project_name, "Ativo sem nome"),
      sourceReference: stringValue(asset.source_reference),
      vintage: asset.vintage == null ? null : String(asset.vintage),
      availableTons: numberValue(asset.available_tons),
      minOrderKg: requestedKg,
      sourcingScore: score,
      sourcingTier: stringValue(asset.sourcing_tier, "D"),
      sourcingRank: numberValue(asset.sourcing_rank),
      blocker: decision.reason,
      riskFlags: flags,
      action: fix.action,
      actionLabel: fix.label,
      priority,
      readyForPolicyReview,
      whyPromising,
    });
  }

  opportunities.sort((left, right) =>
    right.priority - left.priority
    || Number(right.readyForPolicyReview) - Number(left.readyForPolicyReview)
    || right.sourcingScore - left.sourcingScore
    || (left.sourcingRank ?? 999999) - (right.sourcingRank ?? 999999));

  const actions = Array.from(actionCounts.entries())
    .map(([action, value]) => ({ action, ...value }))
    .sort((left, right) => right.maxPriority - left.maxPriority || right.count - left.count);
  const riskFlags = Array.from(riskFlagCounts.entries())
    .map(([flag, count]) => ({ flag, count }))
    .sort((left, right) => right.count - left.count || left.flag.localeCompare(right.flag));
  const providers = Array.from(providerCounts.entries())
    .map(([providerKey, value]) => ({ providerKey, ...value }))
    .sort((left, right) => right.assets - left.assets || left.providerKey.localeCompare(right.providerKey));

  return {
    generatedAt: new Date().toISOString(),
    activeAssetsScanned: rows.length,
    blockedOpportunities: opportunities.length,
    policyReviewReady: opportunities.filter((item) => item.readyForPolicyReview).length,
    actionQueue: actions,
    riskFlagBreakdown: riskFlags.slice(0, 30),
    providerBreakdown: providers,
    topOpportunities: opportunities.slice(0, 50),
    note: "Opportunity Engine não promove ativos nem altera elegibilidade. Ele apenas prioriza as ações necessárias para aumentar o inventário de compensação verificada.",
  };
}
