import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { pool } from "./db.js";
import { evaluateAssetEligibility, normalizeClaimPurpose } from "./eligibility-policy.js";

const quoteSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  buyerName: z.string().min(2).max(255),
  buyerEmail: z.string().email(),
  buyerPhone: z.string().max(40).optional(),
  companyName: z.string().max(255).optional(),
  taxId: z.string().max(40).optional(),
  requestedKg: z.coerce.number().int().positive().max(10_000_000),
  deliveryMode: z.enum(["email", "wallet"]).default("email"),
  walletAddress: z.string().max(100).optional(),
  purpose: z.string().max(120).default("voluntary_offset"),
});

function automaticGenericSource(asset: Record<string, unknown>) {
  const availableTons = Number(asset.available_tons);
  return String(asset.pricing_mode || "") === "dynamic"
    && String(asset.availability_status || "") === "confirmed"
    && String(asset.source_status || "") === "connected"
    && Number.isFinite(availableTons)
    && availableTons > 0;
}

function providerKey(asset: Record<string, unknown>) {
  const details = asset.monitor_details && typeof asset.monitor_details === "object" && !Array.isArray(asset.monitor_details)
    ? asset.monitor_details as Record<string, unknown>
    : {};
  const explicit = String(details.providerKey || "").trim();
  if (explicit) return explicit;
  const sourceReference = String(asset.source_reference || "").toLowerCase();
  if (sourceReference.startsWith("gold-standard-marketplace-")) return "gold-standard";
  if (sourceReference.startsWith("klima-x402-")) return "klima-x402";
  if (sourceReference.startsWith("carbonmark-")) return "carbonmark";
  return String(asset.registry || "assisted").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "assisted";
}

export function registerAssistedQuoteRoutes(app: Application) {
  app.post("/api/market/quotes", async (req: Request, res: Response, next: NextFunction) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) return next();

    try {
      const { rows } = await pool.query("SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE", [parsed.data.assetId]);
      const asset = rows[0];
      if (!asset) return next();
      if (automaticGenericSource(asset)) return next();

      if (parsed.data.deliveryMode === "wallet" && !/^0x[a-fA-F0-9]{40}$/.test(parsed.data.walletAddress || "")) {
        return res.status(400).json({ error: "Informe um endereço 0x válido" });
      }
      const minOrderKg = Math.max(1, Number(asset.min_order_kg || 1));
      if (parsed.data.requestedKg < minOrderKg) {
        return res.status(400).json({ error: `Pedido mínimo: ${minOrderKg} ECOT` });
      }
      const availableTons = asset.available_tons == null ? null : Number(asset.available_tons);
      if (availableTons != null && Number.isFinite(availableTons) && availableTons >= 0 && parsed.data.requestedKg > availableTons * 1000) {
        return res.status(409).json({ error: "Quantidade solicitada supera o estoque monitorado desta fonte" });
      }

      const purpose = normalizeClaimPurpose(parsed.data.purpose);
      const decision = evaluateAssetEligibility(asset, purpose, parsed.data.requestedKg);
      if (!decision.allowed) {
        const contributionDecision = evaluateAssetEligibility(asset, "climate_contribution", parsed.data.requestedKg);
        return res.status(409).json({
          error: decision.reason,
          code: "ASSET_NOT_ELIGIBLE_FOR_REQUESTED_CLAIM",
          purpose: decision.purpose,
          shelf: decision.shelf,
          warnings: decision.warnings,
          contributionAvailable: contributionDecision.allowed,
        });
      }

      const sourceProvider = providerKey(asset);
      const snapshot = {
        pricingMode: "assisted",
        reason: String(asset.pricing_mode || "quote") !== "dynamic"
          ? "source_requires_quote"
          : String(asset.availability_status || "") !== "confirmed"
            ? "availability_not_confirmed"
            : String(asset.source_status || "") !== "connected"
              ? "source_not_connected"
              : "monitored_volume_not_confirmed",
        sourceProvider,
        sourceReference: asset.source_reference,
        sourceStatus: asset.source_status,
        availabilityStatus: asset.availability_status,
        monitoredSourcePriceUsdTon: asset.source_price_usd_ton,
        monitoredAvailableTons: asset.available_tons,
        requestedKg: parsed.data.requestedKg,
        capturedAt: new Date().toISOString(),
      };

      const created = await pool.query(`
        INSERT INTO quote_requests
          (asset_id,buyer_name,buyer_email,buyer_phone,company_name,tax_id,requested_kg,delivery_mode,wallet_address,purpose,
           status,pricing_snapshot,automation_enabled,sourcing_status,sourcing_provider)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested',$11::jsonb,FALSE,'manual_quote_pending',$12)
        RETURNING public_code,status,requested_kg,automation_enabled,sourcing_status,sourcing_provider,created_at`,
      [
        asset.id,
        parsed.data.buyerName,
        parsed.data.buyerEmail,
        parsed.data.buyerPhone || null,
        parsed.data.companyName || null,
        parsed.data.taxId || null,
        parsed.data.requestedKg,
        parsed.data.deliveryMode,
        parsed.data.deliveryMode === "wallet" ? parsed.data.walletAddress || null : null,
        decision.purpose,
        JSON.stringify(snapshot),
        sourceProvider,
      ]);

      return res.status(201).json({
        ...created.rows[0],
        checkoutReady: false,
        pricingMode: "assisted",
        automationEnabled: false,
        nextAction: "confirm_source_quote",
        asset: {
          id: asset.id,
          registry: asset.registry,
          projectName: asset.project_name,
          sourceReference: asset.source_reference,
        },
        message: "Solicitação registrada. O EcoTracker confirmará preço, estoque, lote e execução antes de liberar qualquer cobrança.",
      });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });
    }
  });
}
