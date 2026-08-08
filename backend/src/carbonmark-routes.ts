import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { carbonmarkStatus, createCarbonmarkQuote, refreshCarbonmarkAssets, refreshCarbonmarkIfStale } from "./carbonmark.js";
import { pool } from "./db.js";
import { evaluateAssetEligibility, normalizeClaimPurpose } from "./eligibility-policy.js";
import { priceFromSourceCost, publicPricingPolicy } from "./pricing-policy.js";

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

const numEnv = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

function isCarbonmarkAsset(asset: Record<string, unknown>) {
  const details = asset.monitor_details && typeof asset.monitor_details === "object" ? asset.monitor_details as Record<string, unknown> : {};
  return String(details.providerKey || "") === "carbonmark" || String(asset.source_reference || "").startsWith("carbonmark-");
}

function carbonmarkSourceId(asset: Record<string, unknown>) {
  const details = asset.monitor_details && typeof asset.monitor_details === "object" ? asset.monitor_details as Record<string, unknown> : {};
  const value = details.assetPriceSourceId;
  return typeof value === "string" && value ? value : String(asset.source_reference || "").replace(/^carbonmark-/, "");
}

export function registerCarbonmarkRoutes(app: Application) {
  const refreshBeforeRead = async (_req: Request, _res: Response, next: NextFunction) => {
    try { await refreshCarbonmarkIfStale(); }
    catch (error) { console.warn("[carbonmark] refresh before read failed", error); }
    next();
  };

  app.get("/api/market/assets", refreshBeforeRead);
  app.get("/api/market/catalog/eligibility", refreshBeforeRead);
  app.get("/api/market/compensation-assets", refreshBeforeRead);
  app.get("/api/market/availability", refreshBeforeRead);

  app.get("/api/market/carbonmark/status", async (_req: Request, res: Response) => {
    try {
      const refresh = await refreshCarbonmarkIfStale();
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...carbonmarkStatus(), refresh, pricingPolicy: publicPricingPolicy() });
    } catch (error) {
      res.status(503).json({ ...carbonmarkStatus(), error: error instanceof Error ? error.message : "Carbonmark indisponível" });
    }
  });

  app.post("/api/admin/market/carbonmark/refresh", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await refreshCarbonmarkAssets();
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...result, status: carbonmarkStatus() });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Falha ao sincronizar Carbonmark", status: carbonmarkStatus() });
    }
  });

  // Carbonmark precisa travar o custo da fonte em /quotes antes de apresentar o
  // preço final ao cliente. Outros ativos seguem para a rota normal via next().
  app.post("/api/market/quotes", async (req: Request, res: Response, next: NextFunction) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) return next();

    try {
      const assetResult = await pool.query("SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE", [parsed.data.assetId]);
      const asset = assetResult.rows[0];
      if (!asset || !isCarbonmarkAsset(asset)) return next();

      if (parsed.data.deliveryMode === "wallet" && !/^0x[a-fA-F0-9]{40}$/.test(parsed.data.walletAddress || "")) {
        return res.status(400).json({ error: "Informe um endereço 0x válido" });
      }
      if (parsed.data.requestedKg < Number(asset.min_order_kg || 1)) {
        return res.status(400).json({ error: `Pedido mínimo: ${asset.min_order_kg} ECOT` });
      }

      const purpose = normalizeClaimPurpose(parsed.data.purpose);
      const decision = evaluateAssetEligibility(asset, purpose, parsed.data.requestedKg);
      if (!decision.allowed) {
        return res.status(409).json({
          error: decision.reason,
          code: "ASSET_NOT_ELIGIBLE_FOR_REQUESTED_CLAIM",
          shelf: decision.shelf,
          warnings: decision.warnings,
        });
      }

      const sourceId = carbonmarkSourceId(asset);
      const sourceQuote = await createCarbonmarkQuote(sourceId, parsed.data.requestedKg / 1000);
      const fx = Number(asset.fx_brl_usd || 5.5);
      if (!Number.isFinite(fx) || fx <= 0) throw new Error("Câmbio BRL/USD indisponível");

      // Carbonmark devolve cost_usdc para a quantidade inteira solicitada. Esse é
      // o custo executável que entra no ledger, em vez de estimar pelo card.
      const sourceCostBrl = sourceQuote.costUsdc * fx;
      const priced = priceFromSourceCost({
        sourceCostBrl,
        requestedKg: parsed.data.requestedKg,
        fixedFeeBrl: Number(asset.fixed_fee_brl || 0),
      });
      const ttlMinutes = Math.max(1, numEnv("ECOT_QUOTE_TTL_MINUTES", 15));
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const taxPct = Math.max(0, numEnv("ECOT_TAX_RESERVE_PCT", 0));
      const taxReserve = Number((priced.finalTotalBrl * taxPct / 100).toFixed(2));
      const netProfit = Number((priced.serviceRevenueBrl - taxReserve).toFixed(2));
      const snapshot = {
        pricingMode: "carbonmark_locked_quote",
        sourceProvider: "carbonmark",
        carbonmarkEnvironment: carbonmarkStatus().environment,
        carbonmarkQuoteUuid: sourceQuote.uuid,
        assetPriceSourceId: sourceQuote.assetPriceSourceId,
        quantityTonnes: sourceQuote.quantityTonnes,
        sourceCostUsdc: sourceQuote.costUsdc,
        fxBrlUsd: fx,
        sourceCostBrl: priced.sourceCostBrl,
        markupTier: priced.tier,
        serviceRevenueBrl: priced.serviceRevenueBrl,
        fixedFeeBrl: Number(asset.fixed_fee_brl || 0),
        capturedAt: new Date().toISOString(),
      };

      const { rows } = await pool.query(`
        INSERT INTO quote_requests
          (asset_id,buyer_name,buyer_email,buyer_phone,company_name,tax_id,requested_kg,delivery_mode,wallet_address,purpose,
           indicative_price_per_kg,indicative_total,source_cost_brl,final_total,gross_revenue_brl,gross_profit_brl,
           tax_reserve_brl,net_profit_brl,status,quote_expires_at,pricing_snapshot,source_order_id,source_batch_denom)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,'quoted',$18,$19::jsonb,$20,$21)
        RETURNING public_code,status,requested_kg,indicative_price_per_kg,indicative_total,final_total,quote_expires_at,created_at`,
        [
          asset.id, parsed.data.buyerName, parsed.data.buyerEmail, parsed.data.buyerPhone || null,
          parsed.data.companyName || null, parsed.data.taxId || null, parsed.data.requestedKg,
          parsed.data.deliveryMode, parsed.data.deliveryMode === "wallet" ? parsed.data.walletAddress || null : null,
          decision.purpose, priced.finalTotalBrl / parsed.data.requestedKg, priced.finalTotalBrl,
          priced.sourceCostBrl, priced.finalTotalBrl, priced.serviceRevenueBrl, taxReserve, netProfit,
          expiresAt, JSON.stringify(snapshot), sourceQuote.uuid, sourceQuote.assetPriceSourceId,
        ],
      );

      return res.status(201).json({
        ...rows[0],
        checkoutReady: true,
        sourceProvider: "carbonmark",
        claimCategory: asset.claim_category,
        pricing: { markupPct: priced.tier.markupPct, minimumServiceFeeBrl: priced.tier.minimumServiceFeeBrl, tier: priced.tier.key },
        asset: { id: asset.id, registry: asset.registry, projectName: asset.project_name },
        message: `Cotação Carbonmark travada por ${ttlMinutes} minutos. Preço final inclui a fonte executável e o serviço EcoTracker.`,
      });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : 0;
      const message = error instanceof Error ? error.message : "Falha na cotação Carbonmark";
      return res.status(status >= 400 && status < 500 ? status : 503).json({ error: message, code: "CARBONMARK_QUOTE_FAILED" });
    }
  });
}
