import type { Application, Request, Response } from "express";
import { requireAdmin } from "./auth.js";
import { refreshCarbonmarkAssets, refreshCarbonmarkIfStale } from "./carbonmark.js";
import { pool } from "./db.js";
import { evaluateAssetEligibility, normalizeClaimPurpose } from "./eligibility-policy.js";
import { assetProjection } from "./market-db.js";
import { getSourcingSummary, rankSourcingInventory } from "./sourcing-engine.js";

const fail = (res: Response, error: unknown) =>
  res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });

async function synchronizeAndRank(forceCarbonmark = false) {
  const carbonmark = forceCarbonmark
    ? await refreshCarbonmarkAssets()
    : await refreshCarbonmarkIfStale();
  const sourcing = await rankSourcingInventory(forceCarbonmark ? 0 : undefined);
  return { carbonmark, sourcing };
}

async function listRankedAssets() {
  const { rows } = await pool.query(`
    SELECT ${assetProjection}
    FROM monitored_assets a
    WHERE a.active=TRUE
    ORDER BY
      CASE a.sourcing_shelf
        WHEN 'verified_compensation' THEN 1
        WHEN 'climate_contribution' THEN 2
        ELSE 3
      END,
      a.sourcing_executable DESC,
      a.sourcing_score DESC,
      a.sourcing_rank ASC NULLS LAST,
      CASE a.availability_status WHEN 'confirmed' THEN 1 WHEN 'indicative' THEN 2 ELSE 3 END,
      a.updated_at DESC
  `);
  return rows;
}

function publicCandidate(asset: Record<string, unknown>, requestedKg: number, purpose: unknown) {
  const decision = evaluateAssetEligibility(asset, normalizeClaimPurpose(purpose), requestedKg);
  return {
    id: asset.id,
    public_code: asset.public_code,
    registry: asset.registry,
    project_name: asset.project_name,
    source_url: asset.source_url,
    methodology: asset.methodology,
    location: asset.location,
    vintage: asset.vintage,
    description: asset.description,
    indicative_price_brl_kg: asset.indicative_price_brl_kg,
    indicative_price_brl_ton: asset.indicative_price_brl_ton,
    available_tons: asset.available_tons,
    min_order_kg: asset.min_order_kg,
    claim_category: asset.claim_category,
    eligibility_status: asset.eligibility_status,
    registry_project_id: asset.registry_project_id,
    registry_evidence_url: asset.registry_evidence_url,
    retirement_supported: asset.retirement_supported,
    fractional_retirement_supported: asset.fractional_retirement_supported,
    retirement_granularity_kg: asset.retirement_granularity_kg,
    beneficiary_retirement_supported: asset.beneficiary_retirement_supported,
    sourcing_score: asset.sourcing_score,
    sourcing_tier: asset.sourcing_tier,
    sourcing_shelf: asset.sourcing_shelf,
    sourcing_rank: asset.sourcing_rank,
    sourcing_executable: asset.sourcing_executable,
    eligibilityDecision: decision,
  };
}

export function registerSourcingRoutes(app: Application) {
  // Estas rotas entram depois do middleware Carbonmark e antes das rotas genéricas.
  // Assim o site/app recebe o catálogo já ranqueado, sem mudar o contrato básico.
  app.get("/api/market/assets", async (_req: Request, res: Response) => {
    try {
      await rankSourcingInventory();
      res.setHeader("Cache-Control", "no-store");
      res.json(await listRankedAssets());
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/catalog/eligibility", async (_req: Request, res: Response) => {
    try {
      await rankSourcingInventory();
      const assets = await listRankedAssets();
      const enriched = assets.map((asset) => ({
        ...asset,
        eligibilityDecision: evaluateAssetEligibility(
          asset,
          asset.claim_category === "voluntary_offset" ? "voluntary_offset" : "climate_contribution",
          Number(asset.min_order_kg || 1000),
        ),
      }));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        verifiedCompensation: enriched.filter((asset) => asset.sourcing_shelf === "verified_compensation" && asset.eligibilityDecision.allowed),
        climateContribution: enriched.filter((asset) => asset.sourcing_shelf === "climate_contribution" && asset.eligibilityDecision.allowed),
        restricted: enriched.filter((asset) => asset.sourcing_shelf === "restricted" || !asset.eligibilityDecision.allowed),
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/compensation-assets", async (req: Request, res: Response) => {
    try {
      const requestedKg = Math.max(1, Math.min(10_000_000, Number(req.query.kg || 1000)));
      await rankSourcingInventory();
      const assets = await listRankedAssets();
      const eligible = assets
        .map((asset) => publicCandidate(asset, requestedKg, "voluntary_offset"))
        .filter((asset) => asset.eligibilityDecision.allowed)
        .sort((left, right) => {
          const executableDiff = Number(right.sourcing_executable) - Number(left.sourcing_executable);
          if (executableDiff) return executableDiff;
          return Number(right.sourcing_score || 0) - Number(left.sourcing_score || 0);
        });
      res.setHeader("Cache-Control", "no-store");
      res.json(eligible);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/availability", async (_req: Request, res: Response) => {
    try {
      await rankSourcingInventory();
      const summary = await getSourcingSummary();
      const channels = await pool.query("SELECT * FROM offset_source_channels ORDER BY provider_name");
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ...summary,
        channels: channels.rows,
        policy: {
          defaultMaxVintageAgeYears: Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5)),
          eligibilityReviewMaxAgeHours: Math.max(1, Number(process.env.ECOT_ELIGIBILITY_MAX_AGE_HOURS || 168)),
          carbonmarkPublishedListingLimit: Math.max(1, Number(process.env.CARBONMARK_PUBLISHED_LISTING_LIMIT || 100)),
          note: "O sourcing amplia a descoberta, mas a prateleira de compensação continua sujeita à política de elegibilidade EcoTracker.",
        },
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/sourcing/status", async (_req: Request, res: Response) => {
    try {
      const result = await synchronizeAndRank(false);
      const channels = await pool.query("SELECT provider_key,provider_name,sourcing_mode,status,min_order_kg,fractional_supported,retirement_supported,beneficiary_retirement_supported,last_checked_at FROM offset_source_channels ORDER BY provider_name");
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...result.sourcing, carbonmark: result.carbonmark, channels: channels.rows });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Sourcing indisponível" });
    }
  });

  app.get("/api/market/sourcing/candidates", async (req: Request, res: Response) => {
    try {
      const requestedKg = Math.max(1, Math.min(10_000_000, Number(req.query.kg || 1000)));
      const purpose = normalizeClaimPurpose(req.query.purpose);
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || 12)));
      await synchronizeAndRank(false);
      const assets = await listRankedAssets();
      const candidates = assets
        .map((asset) => publicCandidate(asset, requestedKg, purpose))
        .filter((asset) => asset.eligibilityDecision.allowed)
        .slice(0, limit);
      res.setHeader("Cache-Control", "no-store");
      res.json({ purpose, requestedKg, count: candidates.length, candidates });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market/sourcing/refresh", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await synchronizeAndRank(true);
      const channels = await pool.query("SELECT * FROM offset_source_channels ORDER BY provider_name");
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...result, channels: channels.rows });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Falha ao atualizar sourcing" });
    }
  });

  app.get("/api/admin/market/sourcing/candidates", requireAdmin, async (_req: Request, res: Response) => {
    try {
      await rankSourcingInventory();
      const { rows } = await pool.query(`
        SELECT ${assetProjection}
        FROM monitored_assets a
        ORDER BY a.sourcing_rank ASC NULLS LAST,a.sourcing_score DESC,a.updated_at DESC
      `);
      res.json(rows.map((asset) => ({
        ...asset,
        offsetDecision: evaluateAssetEligibility(asset, "voluntary_offset", Number(asset.min_order_kg || 1000)),
        fractionalOffsetDecision: evaluateAssetEligibility(asset, "voluntary_offset", 1),
      })));
    } catch (error) { fail(res, error); }
  });
}
