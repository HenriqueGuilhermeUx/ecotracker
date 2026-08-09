import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { enqueueAutomationJob } from "./commerce-service.js";
import { pool } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";
import { priceFromSourceCost } from "./pricing-policy.js";

type Json = Record<string, unknown>;

const fail = (res: Response, error: unknown) =>
  res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });

function objectAt(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
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

function nextAction(row: Json) {
  if (String(row.status) === "cancelled") return "closed";
  if (!row.final_total || Number(row.final_total) <= 0) return "confirm_source_quote";
  if (String(row.payment_status || "unpaid") !== "paid") return "await_payment";
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

export function registerAssistedSourcingOpsRoutes(app: Application) {
  app.get("/api/admin/market/assisted-sourcing", requireAdmin, async (req: Request, res: Response) => {
    try {
      const includeClosed = String(req.query.includeClosed || "false") === "true";
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80)));
      const { rows } = await pool.query(`
        SELECT q.*,a.registry,a.project_name,a.source_reference,a.source_url,a.vintage,a.available_tons,
               a.min_order_kg,a.pricing_mode,a.availability_status,a.source_status,a.claim_category,
               a.eligibility_status,a.retirement_supported,a.fractional_retirement_supported,
               a.retirement_granularity_kg,a.monitor_details
        FROM quote_requests q
        JOIN monitored_assets a ON a.id=q.asset_id
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
          nextAction: nextAction(row),
          sourcePreview: previewAction(row),
          assisted: true,
        })),
      });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market/assisted-sourcing/:id/confirm-source", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      sourceCostBrl: z.coerce.number().positive().max(100_000_000),
      sourceReference: z.string().min(2).max(500),
      sourceEvidenceUrl: z.string().url().nullable().optional(),
      sourceAvailableKg: z.coerce.number().positive().max(100_000_000).nullable().optional(),
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
      if (String(row.payment_status || "unpaid") === "paid") return res.status(409).json({ error: "Pagamento já foi confirmado; preço da fonte não pode mais ser alterado" });

      const decision = evaluateAssetEligibility(row, "voluntary_offset", Number(row.requested_kg));
      if (!decision.allowed) {
        return res.status(409).json({ error: decision.reason, code: "ASSET_NO_LONGER_ELIGIBLE", warnings: decision.warnings });
      }
      if (parsed.data.sourceAvailableKg != null && parsed.data.sourceAvailableKg < Number(row.requested_kg)) {
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
        sourceAvailableKg: parsed.data.sourceAvailableKg ?? null,
        sourceCostBrl: priced.sourceCostBrl,
        serviceRevenueBrl: priced.serviceRevenueBrl,
        markupTier: priced.tier,
        confirmedByAdmin: true,
        confirmedAt: new Date().toISOString(),
      };

      const updated = await pool.query(`
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

      res.json({
        ...updated.rows[0],
        checkoutReady: true,
        automationEnabled: false,
        nextAction: "await_payment",
        pricing: { tier: priced.tier.key, markupPct: priced.tier.markupPct, sourceCostBrl: priced.sourceCostBrl, finalTotalBrl: priced.finalTotalBrl },
        message: "Fonte, estoque e custo foram confirmados. O pagamento pode ser liberado; aquisição e retirement continuarão assistidos.",
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
    if (!parsed.success) return res.status(400).json({ error: "Evidência de retirement inválida", details: parsed.error.flatten() });

    try {
      const { rows } = await pool.query(`
        SELECT q.*,a.registry,a.project_name,a.source_reference,a.registry_evidence_url
        FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id
        WHERE q.id=$1`, [req.params.id]);
      const quote = rows[0];
      if (!quote) return res.status(404).json({ error: "Cotação não encontrada" });
      if (quote.automation_enabled !== false) return res.status(409).json({ error: "Esta cotação não é de sourcing assistido" });
      if (String(quote.payment_status) !== "paid") return res.status(409).json({ error: "Retirement só pode ser registrado após confirmação do pagamento" });
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

      await pool.query("BEGIN");
      try {
        await pool.query(`
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

        await pool.query(`
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
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }

      // Apenas etapas posteriores ao retirement são automatizadas. A trigger do
      // banco continua proibindo source_asset/retire_asset para esta cotação.
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
        message: "Retirement assistido registrado e verificado. Delivery ECOT, recibo e NFS-e foram enfileirados.",
      });
    } catch (error) { fail(res, error); }
  });
}
