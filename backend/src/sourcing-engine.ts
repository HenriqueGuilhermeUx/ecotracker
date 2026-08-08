import { pool } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

export type SourcingShelf = "verified_compensation" | "climate_contribution" | "restricted";
export type SourcingTier = "A" | "B" | "C" | "D";

type Asset = Record<string, unknown>;

type RankedAsset = {
  id: number;
  shelf: SourcingShelf;
  score: number;
  tier: SourcingTier;
  executable: boolean;
  fractional: boolean;
  riskFlags: string[];
  reasons: string[];
};

export type SourcingSummary = {
  totalActiveAssets: number;
  verifiedCompensationAssets: number;
  executableCompensationAssets: number;
  fractionalCompensationAssets: number;
  climateContributionAssets: number;
  restrictedAssets: number;
  minimumVerifiedTarget: number;
  needsReplenishment: boolean;
  needsFractionalSource: boolean;
  topVerifiedCandidates: Array<Record<string, unknown>>;
  refreshedAt: string;
};

// Carbonmark.ts já protege o teto em 100. O problema anterior era o default de 30.
// Esse default amplia a descoberta sem afrouxar a política de elegibilidade.
export function configureSourcingDefaults(): void {
  if (!process.env.CARBONMARK_PUBLISHED_LISTING_LIMIT) process.env.CARBONMARK_PUBLISHED_LISTING_LIMIT = "100";
  if (!process.env.ECOT_MIN_VERIFIED_OFFSET_ASSETS) process.env.ECOT_MIN_VERIFIED_OFFSET_ASSETS = "5";
}

configureSourcingDefaults();

const bool = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function riskFlags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function tierFor(score: number): SourcingTier {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  return "D";
}

export function scoreSourcingAsset(asset: Asset): RankedAsset {
  const id = Number(asset.id);
  const minOrderKg = Math.max(1, numberValue(asset.min_order_kg) || 1000);
  const flags = riskFlags(asset.eligibility_risk_flags);
  const offsetDecision = evaluateAssetEligibility(asset, "voluntary_offset", minOrderKg);
  const contributionDecision = evaluateAssetEligibility(asset, "climate_contribution", minOrderKg);
  const fractionalDecision = evaluateAssetEligibility(asset, "voluntary_offset", 1);

  const sourceConnected = String(asset.source_status || "") === "connected";
  const availabilityConfirmed = String(asset.availability_status || "") === "confirmed";
  const tradable = String(asset.source_unit_status || "") === "tradable";
  const retirementSupported = bool(asset.retirement_supported);
  const beneficiarySupported = bool(asset.beneficiary_retirement_supported);
  const fractionalSupported = bool(asset.fractional_retirement_supported) && fractionalDecision.allowed;
  const evidence = Boolean(asset.registry_evidence_url || asset.source_url);
  const priceReady = numberValue(asset.source_price_usd_ton) > 0;
  const supplyReady = numberValue(asset.available_tons) > 0;
  const reviewed = Boolean(asset.eligibility_checked_at);
  const eligible = String(asset.eligibility_status || "") === "eligible";

  let score = 10;
  const reasons: string[] = [];

  if (sourceConnected) { score += 10; reasons.push("fonte conectada"); }
  if (availabilityConfirmed) { score += 10; reasons.push("disponibilidade confirmada"); }
  if (priceReady) { score += 10; reasons.push("preço executável disponível"); }
  if (supplyReady) { score += 10; reasons.push("estoque disponível"); }
  if (evidence) { score += 8; reasons.push("evidência pública de origem"); }
  if (tradable) { score += 10; reasons.push("unidade tradable"); }
  if (retirementSupported) { score += 12; reasons.push("aposentadoria executável"); }
  if (beneficiarySupported) { score += 5; reasons.push("beneficiário suportado"); }
  if (fractionalSupported) { score += 10; reasons.push("fracionamento até 1 kg"); }
  if (reviewed) score += 3;
  if (eligible) score += 7;

  const riskPenalty = Math.min(28, flags.length * 7);
  score -= riskPenalty;
  if (riskPenalty) reasons.push(`penalidade por ${flags.length} flag(s) de risco`);
  if (minOrderKg > 1000) score -= 6;
  else if (minOrderKg > 1) score -= 2;

  const executable = offsetDecision.allowed
    && sourceConnected
    && availabilityConfirmed
    && priceReady
    && supplyReady
    && tradable
    && retirementSupported;

  let shelf: SourcingShelf = "restricted";
  if (offsetDecision.allowed) shelf = "verified_compensation";
  else if (contributionDecision.allowed) shelf = "climate_contribution";

  if (executable) score += 5;
  const finalScore = clampScore(score);

  return {
    id,
    shelf,
    score: finalScore,
    tier: tierFor(finalScore),
    executable,
    fractional: fractionalSupported,
    riskFlags: flags,
    reasons,
  };
}

function shelfPriority(shelf: SourcingShelf): number {
  if (shelf === "verified_compensation") return 0;
  if (shelf === "climate_contribution") return 1;
  return 2;
}

export async function rankSourcingInventory(): Promise<SourcingSummary> {
  const { rows } = await pool.query("SELECT * FROM monitored_assets WHERE active=TRUE");
  const ranked = rows.map((asset) => ({ asset, ranking: scoreSourcingAsset(asset) }))
    .sort((left, right) => {
      const shelfDiff = shelfPriority(left.ranking.shelf) - shelfPriority(right.ranking.shelf);
      if (shelfDiff) return shelfDiff;
      const executableDiff = Number(right.ranking.executable) - Number(left.ranking.executable);
      if (executableDiff) return executableDiff;
      const scoreDiff = right.ranking.score - left.ranking.score;
      if (scoreDiff) return scoreDiff;
      const leftPrice = numberValue(left.asset.source_price_usd_ton) || Number.MAX_SAFE_INTEGER;
      const rightPrice = numberValue(right.asset.source_price_usd_ton) || Number.MAX_SAFE_INTEGER;
      return leftPrice - rightPrice;
    });

  let rank = 0;
  for (const item of ranked) {
    rank += 1;
    const details = {
      sourcingScore: item.ranking.score,
      sourcingTier: item.ranking.tier,
      sourcingShelf: item.ranking.shelf,
      sourcingRank: rank,
      sourcingExecutable: item.ranking.executable,
      sourcingFractional: item.ranking.fractional,
      sourcingReasons: item.ranking.reasons,
      sourcingRankedAt: new Date().toISOString(),
    };
    await pool.query(`
      UPDATE monitored_assets SET
        sourcing_score=$2,
        sourcing_tier=$3,
        sourcing_shelf=$4,
        sourcing_rank=$5,
        sourcing_executable=$6,
        sourcing_checked_at=NOW(),
        monitor_details=COALESCE(monitor_details,'{}'::jsonb) || $7::jsonb,
        updated_at=updated_at
      WHERE id=$1`,
    [item.ranking.id, item.ranking.score, item.ranking.tier, item.ranking.shelf, rank,
      item.ranking.executable, JSON.stringify(details)]);
  }

  return getSourcingSummary();
}

export async function getSourcingSummary(): Promise<SourcingSummary> {
  const target = Math.max(1, Number(process.env.ECOT_MIN_VERIFIED_OFFSET_ASSETS || 5));
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE active=TRUE)::int AS total_active,
      COUNT(*) FILTER (WHERE active=TRUE AND sourcing_shelf='verified_compensation')::int AS verified,
      COUNT(*) FILTER (WHERE active=TRUE AND sourcing_shelf='verified_compensation' AND sourcing_executable=TRUE)::int AS executable,
      COUNT(*) FILTER (WHERE active=TRUE AND sourcing_shelf='verified_compensation' AND fractional_retirement_supported=TRUE AND retirement_granularity_kg<=1)::int AS fractional,
      COUNT(*) FILTER (WHERE active=TRUE AND sourcing_shelf='climate_contribution')::int AS contribution,
      COUNT(*) FILTER (WHERE active=TRUE AND sourcing_shelf='restricted')::int AS restricted
    FROM monitored_assets
  `);
  const counts = rows[0] || {};
  const top = await pool.query(`
    SELECT id,public_code,registry,project_name,source_reference,source_url,methodology,location,vintage,
           available_tons,min_order_kg,claim_category,eligibility_status,registry_evidence_url,
           retirement_supported,fractional_retirement_supported,retirement_granularity_kg,
           sourcing_score,sourcing_tier,sourcing_shelf,sourcing_rank,sourcing_executable,
           CASE WHEN source_price_usd_ton IS NULL THEN NULL
             ELSE ROUND((((source_price_usd_ton*fx_brl_usd)*(1+service_margin_pct/100.0))+fixed_fee_brl)/1000.0,4)
           END AS indicative_price_brl_kg
    FROM monitored_assets
    WHERE active=TRUE AND sourcing_shelf='verified_compensation'
    ORDER BY sourcing_executable DESC,sourcing_score DESC,sourcing_rank ASC
    LIMIT 12
  `);

  const verified = Number(counts.verified || 0);
  const fractional = Number(counts.fractional || 0);
  return {
    totalActiveAssets: Number(counts.total_active || 0),
    verifiedCompensationAssets: verified,
    executableCompensationAssets: Number(counts.executable || 0),
    fractionalCompensationAssets: fractional,
    climateContributionAssets: Number(counts.contribution || 0),
    restrictedAssets: Number(counts.restricted || 0),
    minimumVerifiedTarget: target,
    needsReplenishment: verified < target,
    needsFractionalSource: fractional < 1,
    topVerifiedCandidates: top.rows,
    refreshedAt: new Date().toISOString(),
  };
}
