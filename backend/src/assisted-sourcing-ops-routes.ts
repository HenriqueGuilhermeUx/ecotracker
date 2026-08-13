import crypto from "node:crypto";
import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { enqueueAutomationJob } from "./commerce-service.js";
import { pool, withTransaction } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";
import { priceFromSourceCost } from "./pricing-policy.js";

type Json = Record<string, unknown>;

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  return res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500)
    .json({ error: error instanceof Error ? error.message : "Erro interno" });
};

function objectAt(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function providerKey(asset: Json): string {
  const details = objectAt(asset.monitor_details);
  const explicit = String(details.providerKey || "").trim();
  if (explicit) return explicit;
  const sourceReference = String(asset.source_reference || "").toLowerCase();
  if (sourceReference.startsWith("gold-standard-marketplace-")) return "gold-standard";
  if (sourceReference.startsWith("klima-x402-")) return "klima-x402";
  if (sourceReference.startsWith("carbonmark-")) return "carbonmark";
  return String(asset.registry || "assisted").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "assisted";
}

function commercialSnapshot(row: Json) {
  const pricing = objectAt(row.pricing_snapshot);
  const requestedKg = Number(row.requested_kg || 0);
  const finalTotalBrl = numberOrNull(row.final_total);
  return {
    version: "ecotracker-assisted-quote-commercial-v1",
    quote: {
      id: Number(row.id || row.quote_id || 0),
      publicCode: String(row.public_code || row.quote_public_code || ""),
      status: String(row.status || ""),
      requestedKg,
      purpose: String(row.purpose || "voluntary_offset"),
      expiresAt: row.quote_expires_at || null,
    },
    buyer: {
      name: row.buyer_name || null,
      email: row.buyer_email || null,
      companyName: row.company_name || null,
      taxId: row.tax_id || null,
    },
    asset: {
      id: Number(row.asset_id || 0),
      registry: row.registry || null,
      projectName: row.project_name || null,
      vintage: row.vintage || null,
      sourceReference: row.asset_source_reference || row.source_reference || null,
    },
    sourcing: {
      status: row.sourcing_status || null,
      provider: row.sourcing_provider || pricing.sourceProvider || null,
      confirmedReference: row.sourcing_reference || pricing.sourceReference || null,
      confirmedAvailableKg: numberOrNull(pricing.sourceAvailableKg),
      evidenceUrl: pricing.sourceEvidenceUrl || null,
      confirmedAt: pricing.confirmedAt || null,
      confirmedByAdmin: pricing.confirmedByAdmin === true,
    },
    commercial: {
      sourceCostBrl: numberOrNull(row.source_cost_brl),
      finalTotalBrl,
      pricePerTonneBrl: finalTotalBrl != null && requestedKg > 0
        ? Number((finalTotalBrl / (requestedKg / 1000)).toFixed(6))
        : null,
      grossProfitBrl: numberOrNull(row.gross_profit_brl),
      taxReserveBrl: numberOrNull(row.tax_reserve_brl),
      netProfitBrl: numberOrNull(row.net_profit_brl),
      markupTier: pricing.markupTier || null,
      serviceRevenueBrl: numberOrNull(pricing.serviceRevenueBrl),
    },
  };
}

function commercialSha(row: Json) {
  return crypto.createHash("sha256").update(JSON.stringify(commercialSnapshot(row))).digest("hex");
}

function commercialReviewCurrent(row: Json) {
  return String(row.commercial_review_status || "") === "approved"
    && String(row.commercial_review_sha256 || "") === commercialSha(row);
}

function nextAction(row: Json) {
  if (String(row.status) === "cancelled") return "closed";
  if (!row.final_total || Number(row.final_total) <= 0) return "confirm_source_quote";
  if (!commercialReviewCurrent(row)) return "commercial_reapproval";
  if (String(row.payment_status || "not_started") !== "paid") return "await_payment";
  if (String(row.retirement_status || "not_started") !== "retired") return "execute_and_record_retirement";
  if (String(row.delivery_status || "not_started") !== "delivered") return "await_delivery";
  return "complete";
}

function previewAction(row: Json) {
  const source = String(row.source_reference || "");
  if (source.startsWith("klima-x402-")) {
    return `/api/market/klima-x402/quote-preview?assetId=${row.asset_id}&kg=${row.requested_kg}`;
  }
  return row.source_url || null;
}

async function assistedQuoteForReview(quoteId: number) {
  const { rows } = await pool.query(`
    SELECT q.*,a.registry,a.project_name,a.vintage,a.source_reference AS asset_source_reference,
           a.source_url,a.monitor_details,a.claim_category,a.eligibility_status,a.retirement_supported,
           r.status AS commercial_review_status,r.snapshot_sha256 AS commercial_review_sha256,
           r.reviewed_by AS commercial_reviewed_by,r.approved_at AS commercial_reviewed_at
    FROM quote_requests q
    JOIN monitored_assets a ON a.id=q.asset_id
    LEFT JOIN assisted_quote_reviews r ON r.quote_id=q.id
    WHERE q.id=$1`, [quoteId]);
  return rows[0] as Json | undefined;
}

export function registerAssistedSourcingOpsRoutes(app: Application) {
  // Safety middleware: assisted quotes cannot enter public checkout without a current
  // post-sourcing commercial approval. Automatic quotes continue to the normal checkout route.
  app.post("/api/market/quotes/:publicCode/checkout", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.params.publicCode;
      const publicCode = Array.isArray(raw) ? raw[0] : raw;
      const { rows } = await pool.query(`
        SELECT q.*,a.registry,a.project_name,a.vintage,a.source_reference AS asset_source_reference,
               r.status AS commercial_review_status,r.snapshot_sha256 AS commercial_review_sha256
        FROM quote_requests q
        JOIN monitored_assets a ON a.id=q.asset_id
        LEFT JOIN assisted_quote_reviews r ON r.quote_id=q.id
        WHERE q.public_code=$1`, [publicCode]);
      const quote = rows[0] as Json | undefined;
      if (!quote || quote.automation_enabled !== false) return next();
      if (String(quote.sourcing_status || "") !== "manual_source_confirmed") {
        return res.status(409).json({ error: "Fonte, estoque e custo ainda não foram confirmados para esta cotação assistida", code: "ASSISTED_SOURCE_NOT_CONFIRMED" });
      }
      if (!commercialReviewCurrent(quote)) {
        return res.status(409).json({ error: "A cotação assistida precisa de aprovação comercial atual após a confirmação da fonte", code: "ASSISTED_COMMERCIAL_REAPPROVAL_REQUIRED" });
      }
      if (quote.quote_expires_at && new Date(String(quote.quote_expires_at)).getTime() <= Date.now()) {
        return res.status(409).json({ error: "A cotação assistida expirou; reconfirme a fonte e aprove novamente", code: "ASSISTED_QUOTE_EXPIRED" });
      }
      return next();
    } catch (error) { return fail(res, error); }
  });

  // Assisted repricing must go through confirm-source; the generic reprice route would bypass
  // source availability evidence and the commercial reapproval fingerprint.
  app.post("/api/admin/market/quotes/:id/reprice", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await pool.query("SELECT automation_enabled FROM quote_requests WHERE id=$1", [req.params.id]);
      if (!rows[0] || rows[0].automation_enabled !== false) return next();
      return res.status(409).json({
        error: "Cotação de sourcing assistido deve ser reprificada pela confirmação da fonte e exige nova aprovação comercial",
        code: "USE_ASSISTED_SOURCE_CONFIRMATION",
      });
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/admin/market/assisted-sourcing", requireAdmin, async (req: Request, res: Response) => {
    try {
      const includeClosed = String(req.query.includeClosed || "false") === "true";
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const { rows } = await pool.query(`
        SELECT q.*,a.registry,a.project_name,a.source_reference,a.source_url,a.vintage,a.available_tons,
               a.min_order_kg,a.pricing_mode,a.availability_status,a.source_status,a.claim_category,
               a.eligibility_status,a.retirement_supported,a.fractional_retirement_supported,
               a.retirement_granularity_kg,a.monitor_details,
               r.status AS commercial_review_status,r.snapshot_sha256 AS commercial_review_sha256,
               r.reviewed_by AS commercial_reviewed_by,r.approved_at AS commercial_reviewed_at
        FROM quote_requests q
        JOIN monitored_assets a ON a.id=q.asset_id
        LEFT JOIN assisted_quote_reviews r ON r.quote_id=q.id
        WHERE q.automation_enabled=FALSE
          AND ($1::boolean=TRUE OR q.status NOT IN ('delivered','cancelled'))
        ORDER BY
          CASE WHEN q.payment_status='paid' AND q.retirement_status<>'retired' THEN 1
               WHEN q.final_total IS NULL THEN 2
               WHEN q.payment_status<>'paid' THEN 3
               ELSE 4 END,
          q.created_at ASC
        LIMIT $2`, [includeClosed, limit]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        count: rows.length,
        items: rows.map((row) => ({
          ...row,
          commercialReviewCurrent: commercialReviewCurrent(row),
          nextAction: nextAction(row),
          sourcePreview: previewAction(row),
          assisted: true,
        })),
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/market/assisted-sourcing/:id/review", requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await assistedQuoteForReview(Number(req.params.id));
      if (!row) return res.status(404).json({ error: "Cotação não encontrada" });
      const { rows } = await pool.query("SELECT * FROM assisted_quote_reviews WHERE quote_id=$1", [req.params.id]);
      const review = rows[0] || null;
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        review,
        current: Boolean(review && String(review.status) === "approved" && String(review.snapshot_sha256) === commercialSha(row)),
        currentSha256: commercialSha(row),
        snapshot: commercialSnapshot(row),
      });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/market/assisted-sourcing/:id/review/approve", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      reviewedBy: z.string().min(2).max(255).nullable().optional(),
      note: z.string().max(5000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Aprovação comercial inválida", details: parsed.error.flatten() });

    try {
      const row = await assistedQuoteForReview(Number(req.params.id));
      if (!row) return res.status(404).json({ error: "Cotação não encontrada" });
      if (row.automation_enabled !== false) return res.status(409).json({ error: "Esta cotação não é de sourcing assistido" });
      if (String(row.sourcing_status || "") !== "manual_source_confirmed") {
        return res.status(409).json({ error: "Confirme fonte, estoque e custo antes da aprovação comercial" });
      }
      if (String(row.status || "") !== "quoted") return res.status(409).json({ error: "A cotação precisa estar em estado quoted" });
      if (String(row.payment_status || "not_started") !== "not_started") {
        return res.status(409).json({ error: "A revisão comercial não pode alterar uma cotação cujo pagamento já começou" });
      }
      if (row.quote_expires_at && new Date(String(row.quote_expires_at)).getTime() <= Date.now()) {
        return res.status(409).json({ error: "A cotação expirou; reconfirme a fonte" });
      }
      if (Number(row.source_cost_brl || 0) <= 0 || Number(row.final_total || 0) <= 0) {
        return res.status(409).json({ error: "Custo e preço final precisam estar confirmados" });
      }
      const pricing = objectAt(row.pricing_snapshot);
      const sourceAvailableKg = Number(pricing.sourceAvailableKg || 0);
      if (pricing.confirmedByAdmin !== true || !Number.isFinite(sourceAvailableKg) || sourceAvailableKg < Number(row.requested_kg)) {
        return res.status(409).json({ error: "A aprovação exige estoque confirmado suficiente para todo o pedido" });
      }
      const decision = evaluateAssetEligibility(row, String(row.purpose || "voluntary_offset"), Number(row.requested_kg));
      if (!decision.allowed) {
        return res.status(409).json({ error: decision.reason, code: "ASSET_NO_LONGER_ELIGIBLE", warnings: decision.warnings });
      }

      const snapshot = commercialSnapshot(row);
      const snapshotSha256 = commercialSha(row);
      const reviewedBy = String(parsed.data.reviewedBy || process.env.ADMIN_EMAIL || "ecotracker-admin").slice(0, 255);
      const { rows } = await pool.query(`
        INSERT INTO assisted_quote_reviews(quote_id,status,reviewed_by,review_note,snapshot,snapshot_sha256,approved_at)
        VALUES($1,'approved',$2,$3,$4::jsonb,$5,NOW())
        ON CONFLICT(quote_id) DO UPDATE SET
          status='approved',reviewed_by=EXCLUDED.reviewed_by,review_note=EXCLUDED.review_note,
          snapshot=EXCLUDED.snapshot,snapshot_sha256=EXCLUDED.snapshot_sha256,
          approved_at=NOW(),rejected_at=NULL,updated_at=NOW()
        RETURNING *`, [row.id, reviewedBy, parsed.data.note || null, JSON.stringify(snapshot), snapshotSha256]);

      return res.status(201).json({
        review: rows[0],
        current: true,
        commerciallyApproved: true,
        checkoutReady: false,
        nextAction: "payment_gate_review",
        message: "Cotação reprificada aprovada comercialmente. Nenhum checkout ou pagamento foi criado.",
      });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/market/assisted-sourcing/:id/confirm-source", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      sourceCostBrl: z.coerce.number().positive().max(100_000_000),
      sourceReference: z.string().min(2).max(500),
      sourceEvidenceUrl: z.string().url().nullable().optional(),
      sourceAvailableKg: z.coerce.number().positive().max(100_000_000),
      quoteTtlMinutes: z.coerce.number().int().min(5).max(1440).default(30),
      notes: z.string().max(5000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Confirmação da fonte inválida", details: parsed.error.flatten() });

    try {
      const quoteResult = await pool.query(`
        SELECT q.*,a.*,
               q.id AS quote_id,q.public_code AS quote_public_code,q.created_at AS quote_created_at
        FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id
        WHERE q.id=$1`, [req.params.id]);
      const row = quoteResult.rows[0];
      if (!row) return res.status(404).json({ error: "Cotação não encontrada" });
      if (row.automation_enabled !== false) return res.status(409).json({ error: "Esta cotação não é de sourcing assistido" });
      if (["cancelled","delivered"].includes(String(row.status))) return res.status(409).json({ error: "Cotação já encerrada" });
      if (String(row.payment_status || "not_started") !== "not_started") {
        return res.status(409).json({ error: "Fonte/preço não podem ser alterados depois que o fluxo de pagamento começou" });
      }

      const decision = evaluateAssetEligibility(row, String(row.purpose || "voluntary_offset"), Number(row.requested_kg));
      if (!decision.allowed) {
        return res.status(409).json({ error: decision.reason, code: "ASSET_NO_LONGER_ELIGIBLE", warnings: decision.warnings });
      }
      if (parsed.data.sourceAvailableKg < Number(row.requested_kg)) {
        return res.status(409).json({ error: "Estoque confirmado da fonte é inferior à quantidade solicitada" });
      }

      const priced = priceFromSourceCost({
        sourceCostBrl: parsed.data.sourceCostBrl,
        requestedKg: Number(row.requested_kg),
        fixedFeeBrl: Number(row.fixed_fee_brl || 0),
      });
      const taxPct = Math.max(0, Number(process.env.ECOT_TAX_RESERVE_PCT || 0));
      const taxReserve = Number((priced.finalTotalBrl * taxPct / 100).toFixed(2));
      const netProfit = Number((priced.serviceRevenueBrl - taxReserve).toFixed(2));
      const expiresAt = new Date(Date.now() + parsed.data.quoteTtlMinutes * 60 * 1000).toISOString();
      const provider = providerKey(row);
      const snapshot = {
        ...objectAt(row.pricing_snapshot),
        pricingMode: "assisted_confirmed",
        sourceProvider: provider,
        sourceReference: parsed.data.sourceReference,
        sourceEvidenceUrl: parsed.data.sourceEvidenceUrl || null,
        sourceAvailableKg: parsed.data.sourceAvailableKg,
        sourceCostBrl: priced.sourceCostBrl,
        serviceRevenueBrl: priced.serviceRevenueBrl,
        markupTier: priced.tier,
        confirmedByAdmin: true,
        confirmedAt: new Date().toISOString(),
      };

      const updated = await withTransaction(async (client) => {
        await client.query("DELETE FROM assisted_quote_reviews WHERE quote_id=$1", [row.quote_id]);
        const result = await client.query(`
          UPDATE quote_requests SET
            source_cost_brl=$2,final_total=$3,gross_revenue_brl=$3,gross_profit_brl=$4,
            tax_reserve_brl=$5,net_profit_brl=$6,indicative_total=$3,
            indicative_price_per_kg=ROUND($3/requested_kg,6),status='quoted',quote_expires_at=$7,
            pricing_snapshot=$8::jsonb,sourcing_status='manual_source_confirmed',
            sourcing_provider=$9,sourcing_reference=$10,automation_enabled=FALSE,
            admin_notes=CASE WHEN $11::text IS NULL THEN admin_notes
              ELSE CONCAT_WS(E'\n',NULLIF(admin_notes,''),$11::text) END,
            updated_at=NOW()
          WHERE id=$1
          RETURNING *`, [
          row.quote_id, priced.sourceCostBrl, priced.finalTotalBrl, priced.serviceRevenueBrl,
          taxReserve, netProfit, expiresAt, JSON.stringify(snapshot), provider,
          parsed.data.sourceReference, parsed.data.notes ?? null,
        ]);
        return result.rows[0];
      });

      res.json({
        ...updated,
        sourceConfirmed: true,
        commercialReapprovalRequired: true,
        checkoutReady: false,
        automationEnabled: false,
        nextAction: "commercial_reapproval",
        pricing: { tier: priced.tier.key, markupPct: priced.tier.markupPct, sourceCostBrl: priced.sourceCostBrl, finalTotalBrl: priced.finalTotalBrl },
        message: "Fonte, estoque e custo confirmados. O preço foi recalculado e exige nova aprovação comercial antes de qualquer checkout.",
      });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market/assisted-sourcing/:id/record-retirement", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      sourcingReference: z.string().min(2).max(500).optional(),
      retirementReference: z.string().min(2).max(1000),
      retirementTxHash: z.string().max(255).nullable().optional(),
      certificateUrl: z.string().url().nullable().optional(),
      registryEvidenceUrl: z.string().url().nullable().optional(),
      retiredKg: z.coerce.number().positive().max(100_000_000).optional(),
      notes: z.string().max(5000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Evidência de aposentadoria inválida", details: parsed.error.flatten() });

    try {
      const { rows } = await pool.query(`
        SELECT q.*,a.registry,a.project_name,a.source_reference,a.registry_evidence_url
        FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id
        WHERE q.id=$1`, [req.params.id]);
      const quote = rows[0];
      if (!quote) return res.status(404).json({ error: "Cotação não encontrada" });
      if (quote.automation_enabled !== false) return res.status(409).json({ error: "Esta cotação não é de sourcing assistido" });
      if (String(quote.payment_status) !== "paid") return res.status(409).json({ error: "A aposentadoria só pode ser registrada após confirmação do pagamento" });
      if (String(quote.retirement_status) === "retired") {
        return res.json({ alreadyRetired: true, quoteId: quote.id, retirementReference: quote.retirement_reference });
      }

      const retiredKg = parsed.data.retiredKg ?? Number(quote.requested_kg);
      if (retiredKg + 0.000001 < Number(quote.requested_kg)) {
        return res.status(409).json({ error: "Quantidade aposentada é inferior à quantidade vendida" });
      }
      const registryEvidenceUrl = parsed.data.registryEvidenceUrl || quote.registry_evidence_url || null;
      const evidence = {
        assisted: true,
        provider: quote.sourcing_provider,
        sourceReference: parsed.data.sourcingReference || quote.sourcing_reference || quote.source_reference,
        retirementReference: parsed.data.retirementReference,
        retirementTxHash: parsed.data.retirementTxHash || null,
        certificateUrl: parsed.data.certificateUrl || null,
        registryEvidenceUrl,
        retiredKg,
        recordedAt: new Date().toISOString(),
      };

      await withTransaction(async (client) => {
        const locked = await client.query("SELECT id,retirement_status FROM quote_requests WHERE id=$1 FOR UPDATE", [quote.id]);
        if (!locked.rows[0]) throw new Error("Cotação não encontrada durante registro da aposentadoria");
        if (String(locked.rows[0].retirement_status) === "retired") return;

        await client.query(`
          UPDATE quote_requests SET
            sourcing_status='acquired',sourcing_reference=COALESCE($2,sourcing_reference),sourcing_completed_at=NOW(),
            retirement_status='retired',retirement_reference=$3,retirement_tx_hash=$4,retired_at=NOW(),
            status='retired',admin_notes=CASE WHEN $5::text IS NULL THEN admin_notes
              ELSE CONCAT_WS(E'\n',NULLIF(admin_notes,''),$5::text) END,
            updated_at=NOW()
          WHERE id=$1`, [
          quote.id, parsed.data.sourcingReference || null, parsed.data.retirementReference,
          parsed.data.retirementTxHash || null, parsed.data.notes ?? null,
        ]);

        await client.query(`
          INSERT INTO retirement_proofs
            (quote_id,registry,retirement_reference,transaction_hash,beneficiary,amount_kg,evidence_url,status,evidence)
          VALUES($1,$2,$3,$4,$5,$6,$7,'verified',$8::jsonb)
          ON CONFLICT(quote_id) DO UPDATE SET
            registry=EXCLUDED.registry,retirement_reference=EXCLUDED.retirement_reference,
            transaction_hash=EXCLUDED.transaction_hash,beneficiary=EXCLUDED.beneficiary,
            amount_kg=EXCLUDED.amount_kg,evidence_url=EXCLUDED.evidence_url,status='verified',
            evidence=EXCLUDED.evidence,updated_at=NOW()`, [
          quote.id, quote.registry, parsed.data.retirementReference, parsed.data.retirementTxHash || null,
          quote.buyer_name, retiredKg, parsed.data.certificateUrl || registryEvidenceUrl,
          JSON.stringify(evidence),
        ]);
      });

      await Promise.all([
        enqueueAutomationJob(Number(quote.id), "deliver_ecot", { assistedRetirement: true }),
        enqueueAutomationJob(Number(quote.id), "issue_receipt", { assistedRetirement: true }),
        enqueueAutomationJob(Number(quote.id), "issue_nfse", { assistedRetirement: true }),
      ]);

      res.json({
        quoteId: quote.id,
        status: "retired",
        sourcingStatus: "acquired",
        retirementStatus: "retired",
        automationEnabled: false,
        evidence,
        nextAction: "await_delivery",
        message: "Aposentadoria assistida registrada e verificada. Entrega ECOT, recibo e NFS-e foram enfileirados.",
      });
    } catch (error) { fail(res, error); }
  });
}
