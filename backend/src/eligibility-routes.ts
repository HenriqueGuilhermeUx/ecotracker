import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { assetProjection } from "./market-db.js";
import { evaluateAssetEligibility, normalizeClaimPurpose } from "./eligibility-policy.js";
import { directMutationRequiresLedger, type EligibilityProposal } from "./eligibility-review.js";

const fail = (res: Response, error: unknown) =>
  res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });

const reviewSchema = z.object({
  claimCategory: z.enum(["voluntary_offset", "climate_contribution", "ecological_contribution", "compliance", "historical"]).optional(),
  eligibilityStatus: z.enum(["eligible", "restricted", "ineligible", "under_review"]).optional(),
  eligibilityBasis: z.string().max(5000).nullable().optional(),
  sourceUnitStatus: z.enum(["tradable", "retired", "cancelled", "suspended", "unknown"]).optional(),
  vintageStart: z.string().date().nullable().optional(),
  vintageEnd: z.string().date().nullable().optional(),
  issuanceDate: z.string().date().nullable().optional(),
  commercialValidUntil: z.string().date().nullable().optional(),
  offerExpiresAt: z.string().datetime().nullable().optional(),
  registryProjectId: z.string().max(180).nullable().optional(),
  registryBatchId: z.string().max(255).nullable().optional(),
  registryEvidenceUrl: z.string().url().nullable().optional(),
  retirementSupported: z.boolean().optional(),
  fractionalRetirementSupported: z.boolean().optional(),
  retirementGranularityKg: z.coerce.number().int().positive().max(1000000).optional(),
  beneficiaryRetirementSupported: z.boolean().optional(),
  ccpStatus: z.enum(["approved", "eligible_program", "not_approved", "not_assessed"]).optional(),
  corsiaStatus: z.enum(["eligible", "authorized", "not_eligible", "not_assessed"]).optional(),
  article6Status: z.enum(["eligible", "authorized", "not_eligible", "not_assessed"]).optional(),
  vintagePolicyOverride: z.boolean().optional(),
  vintageExceptionReason: z.string().max(3000).nullable().optional(),
  riskFlags: z.array(z.string().max(120)).max(30).optional(),
  reviewNow: z.boolean().default(true),
});

async function allAssets() {
  const { rows } = await pool.query(`SELECT ${assetProjection} FROM monitored_assets a WHERE a.active=TRUE ORDER BY a.updated_at DESC`);
  return rows;
}

export function registerEligibilityRoutes(app: Application) {
  // Esta rota é registrada antes da rota de criação de cotação. Ela funciona como
  // uma trava de integridade: um ativo de contribuição/restrito não pode ser vendido
  // como compensação apenas porque possui preço ou liquidez on-chain.
  app.post("/api/market/quotes", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assetId = Number(req.body?.assetId);
      const requestedKg = Number(req.body?.requestedKg);
      if (!Number.isInteger(assetId) || assetId <= 0) return next();

      const { rows } = await pool.query("SELECT * FROM monitored_assets WHERE id=$1", [assetId]);
      const asset = rows[0];
      if (!asset) return next();

      const purpose = normalizeClaimPurpose(req.body?.purpose);
      const decision = evaluateAssetEligibility(asset, purpose, Number.isFinite(requestedKg) ? requestedKg : undefined);
      if (!decision.allowed) {
        const contributionDecision = evaluateAssetEligibility(asset, "climate_contribution", Number.isFinite(requestedKg) ? requestedKg : undefined);
        return res.status(409).json({
          error: decision.reason,
          code: "ASSET_NOT_ELIGIBLE_FOR_REQUESTED_CLAIM",
          purpose: decision.purpose,
          shelf: decision.shelf,
          warnings: decision.warnings,
          contributionAvailable: contributionDecision.allowed,
          suggestion: contributionDecision.allowed && purpose === "voluntary_offset"
            ? "Este ativo pode permanecer no catálogo como contribuição climática, mas não como compensação de emissões."
            : undefined,
        });
      }

      req.body.purpose = decision.purpose;
      return next();
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/market/catalog/eligibility", async (_req: Request, res: Response) => {
    try {
      const assets = await allAssets();
      const enriched = assets.map((asset) => ({
        ...asset,
        eligibilityDecision: evaluateAssetEligibility(asset, asset.claim_category === "voluntary_offset" ? "voluntary_offset" : "climate_contribution", Number(asset.min_order_kg || 1000)),
      }));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        verifiedCompensation: enriched.filter((asset) => asset.eligibilityDecision.shelf === "verified_compensation" && asset.eligibilityDecision.allowed),
        climateContribution: enriched.filter((asset) => asset.eligibilityDecision.shelf === "climate_contribution" && asset.eligibilityDecision.allowed),
        restricted: enriched.filter((asset) => !asset.eligibilityDecision.allowed || asset.eligibility_status === "restricted" || asset.claim_category === "historical"),
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/compensation-assets", async (req: Request, res: Response) => {
    try {
      const requestedKg = Math.max(1, Number(req.query.kg || 1000));
      const assets = await allAssets();
      const eligible = assets
        .map((asset) => ({ ...asset, eligibilityDecision: evaluateAssetEligibility(asset, "voluntary_offset", requestedKg) }))
        .filter((asset) => asset.eligibilityDecision.allowed);
      res.setHeader("Cache-Control", "no-store");
      res.json(eligible);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/availability", async (_req: Request, res: Response) => {
    try {
      const assets = await allAssets();
      const target = Math.max(1, Number(process.env.ECOT_MIN_VERIFIED_OFFSET_ASSETS || 2));
      const verified = assets.filter((asset) => evaluateAssetEligibility(asset, "voluntary_offset", Number(asset.min_order_kg || 1000)).allowed);
      const fractional = assets.filter((asset) => evaluateAssetEligibility(asset, "voluntary_offset", 1).allowed);
      const contribution = assets.filter((asset) => evaluateAssetEligibility(asset, "climate_contribution", Number(asset.min_order_kg || 1)).allowed);
      const channels = await pool.query("SELECT * FROM offset_source_channels ORDER BY provider_name");
      res.setHeader("Cache-Control", "no-store");
      res.json({
        verifiedCompensationAssets: verified.length,
        fractionalCompensationAssets: fractional.length,
        climateContributionAssets: contribution.length,
        minimumVerifiedTarget: target,
        needsReplenishment: verified.length < target,
        needsFractionalSource: fractional.length < 1,
        channels: channels.rows,
        policy: {
          defaultMaxVintageAgeYears: Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5)),
          eligibilityReviewMaxAgeHours: Math.max(1, Number(process.env.ECOT_ELIGIBILITY_MAX_AGE_HOURS || 168)),
          note: "Os limites são política comercial EcoTracker, não uma regra universal de validade dos registries.",
        },
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/market/eligibility", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(`
        SELECT ${assetProjection} FROM monitored_assets a
        ORDER BY CASE a.eligibility_status WHEN 'eligible' THEN 1 WHEN 'under_review' THEN 2 WHEN 'restricted' THEN 3 ELSE 4 END,a.updated_at DESC
      `);
      res.json(rows.map((asset) => ({
        ...asset,
        offsetDecision: evaluateAssetEligibility(asset, "voluntary_offset", Number(asset.min_order_kg || 1000)),
      })));
    } catch (error) { fail(res, error); }
  });

  // PATCH legado permanece disponível para manutenção técnica de ativos ainda restritos/contribuição.
  // Promoção a compensação verificada — e qualquer mutação de um ativo já verificado — exige
  // uma Eligibility Review auditável com fingerprint, snapshot, SHA e decisão humana.
  app.patch("/api/admin/market/assets/:id/eligibility", requireAdmin, async (req: Request, res: Response) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Revisão de elegibilidade inválida", details: parsed.error.flatten() });
    try {
      const current = (await pool.query("SELECT * FROM monitored_assets WHERE id=$1", [req.params.id])).rows[0];
      if (!current) return res.status(404).json({ error: "Ativo não encontrado" });
      const { reviewNow: _reviewNow, ...proposal } = parsed.data;
      if (directMutationRequiresLedger(current, proposal as EligibilityProposal)) {
        return res.status(409).json({
          error: "Ativos elegíveis para compensação exigem Eligibility Review auditável; crie e decida uma review em vez de promoção direta.",
          code: "ELIGIBILITY_LEDGER_REQUIRED",
          assetId: Number(current.id),
          currentClaimCategory: current.claim_category,
          currentEligibilityStatus: current.eligibility_status,
          requiredFlow: "create_eligibility_review_then_approve",
        });
      }

      const own = (key: keyof typeof parsed.data) => Object.prototype.hasOwnProperty.call(parsed.data, key);
      const d = parsed.data;
      const { rows } = await pool.query(`
        UPDATE monitored_assets SET
          claim_category=CASE WHEN $2::boolean THEN $3 ELSE claim_category END,
          eligibility_status=CASE WHEN $4::boolean THEN $5 ELSE eligibility_status END,
          eligibility_basis=CASE WHEN $6::boolean THEN $7 ELSE eligibility_basis END,
          source_unit_status=CASE WHEN $8::boolean THEN $9 ELSE source_unit_status END,
          vintage_start=CASE WHEN $10::boolean THEN $11::date ELSE vintage_start END,
          vintage_end=CASE WHEN $12::boolean THEN $13::date ELSE vintage_end END,
          issuance_date=CASE WHEN $14::boolean THEN $15::date ELSE issuance_date END,
          commercial_valid_until=CASE WHEN $16::boolean THEN $17::date ELSE commercial_valid_until END,
          offer_expires_at=CASE WHEN $18::boolean THEN $19::timestamptz ELSE offer_expires_at END,
          registry_project_id=CASE WHEN $20::boolean THEN $21 ELSE registry_project_id END,
          registry_batch_id=CASE WHEN $22::boolean THEN $23 ELSE registry_batch_id END,
          registry_evidence_url=CASE WHEN $24::boolean THEN $25 ELSE registry_evidence_url END,
          retirement_supported=CASE WHEN $26::boolean THEN $27 ELSE retirement_supported END,
          fractional_retirement_supported=CASE WHEN $28::boolean THEN $29 ELSE fractional_retirement_supported END,
          retirement_granularity_kg=CASE WHEN $30::boolean THEN $31 ELSE retirement_granularity_kg END,
          beneficiary_retirement_supported=CASE WHEN $32::boolean THEN $33 ELSE beneficiary_retirement_supported END,
          ccp_status=CASE WHEN $34::boolean THEN $35 ELSE ccp_status END,
          corsia_status=CASE WHEN $36::boolean THEN $37 ELSE corsia_status END,
          article6_status=CASE WHEN $38::boolean THEN $39 ELSE article6_status END,
          vintage_policy_override=CASE WHEN $40::boolean THEN $41 ELSE vintage_policy_override END,
          vintage_exception_reason=CASE WHEN $42::boolean THEN $43 ELSE vintage_exception_reason END,
          eligibility_risk_flags=CASE WHEN $44::boolean THEN $45::jsonb ELSE eligibility_risk_flags END,
          eligibility_checked_at=CASE WHEN $46::boolean THEN NOW() ELSE eligibility_checked_at END,
          updated_at=NOW()
        WHERE id=$1 RETURNING *`,
        [
          req.params.id,
          own("claimCategory"), d.claimCategory ?? null,
          own("eligibilityStatus"), d.eligibilityStatus ?? null,
          own("eligibilityBasis"), d.eligibilityBasis ?? null,
          own("sourceUnitStatus"), d.sourceUnitStatus ?? null,
          own("vintageStart"), d.vintageStart ?? null,
          own("vintageEnd"), d.vintageEnd ?? null,
          own("issuanceDate"), d.issuanceDate ?? null,
          own("commercialValidUntil"), d.commercialValidUntil ?? null,
          own("offerExpiresAt"), d.offerExpiresAt ?? null,
          own("registryProjectId"), d.registryProjectId ?? null,
          own("registryBatchId"), d.registryBatchId ?? null,
          own("registryEvidenceUrl"), d.registryEvidenceUrl ?? null,
          own("retirementSupported"), d.retirementSupported ?? false,
          own("fractionalRetirementSupported"), d.fractionalRetirementSupported ?? false,
          own("retirementGranularityKg"), d.retirementGranularityKg ?? 1000,
          own("beneficiaryRetirementSupported"), d.beneficiaryRetirementSupported ?? false,
          own("ccpStatus"), d.ccpStatus ?? null,
          own("corsiaStatus"), d.corsiaStatus ?? null,
          own("article6Status"), d.article6Status ?? null,
          own("vintagePolicyOverride"), d.vintagePolicyOverride ?? false,
          own("vintageExceptionReason"), d.vintageExceptionReason ?? null,
          own("riskFlags"), JSON.stringify(d.riskFlags ?? []),
          d.reviewNow,
        ],
      );
      res.json({
        ...rows[0],
        offsetDecision: evaluateAssetEligibility(rows[0], "voluntary_offset", Number(rows[0].min_order_kg || 1000)),
      });
    } catch (error) { fail(res, error); }
  });
}
