import type { Application, NextFunction, Request, Response } from "express";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import {
  isKlimaX402Asset,
  klimaX402Status,
  previewKlimaX402Quote,
  refreshKlimaX402Assets,
  refreshKlimaX402IfStale,
} from "./klima-x402.js";
import { enrichX402CfcIfStale, enrichX402CityForestCredits } from "./x402-cfc-enrichment.js";

const fail = (res: Response, error: unknown) =>
  res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });

async function refreshAndEnrich(force = false) {
  const refresh = force ? await refreshKlimaX402Assets() : await refreshKlimaX402IfStale();
  const cfc = await enrichX402CfcIfStale(force ? 0 : 5 * 60 * 1000);
  return { refresh, cfc };
}

export function registerKlimaX402Routes(app: Application) {
  const refreshBeforeRead = async (_req: Request, _res: Response, next: NextFunction) => {
    try { await refreshAndEnrich(false); }
    catch (error) { console.warn("[klima-x402] refresh/enrichment before read failed", error); }
    next();
  };

  app.get("/api/market/assets", refreshBeforeRead);
  app.get("/api/market/catalog/eligibility", refreshBeforeRead);
  app.get("/api/market/compensation-assets", refreshBeforeRead);
  app.get("/api/market/availability", refreshBeforeRead);
  app.get("/api/market/sourcing/status", refreshBeforeRead);
  app.get("/api/market/sourcing/candidates", refreshBeforeRead);
  app.get("/api/market/sourcing/health", refreshBeforeRead);

  app.get("/api/market/klima-x402/status", async (_req: Request, res: Response) => {
    try {
      const state = await refreshAndEnrich(false);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...klimaX402Status(), refresh: state.refresh, cfcEnrichment: state.cfc });
    } catch (error) {
      res.status(503).json({ ...klimaX402Status(), error: error instanceof Error ? error.message : "Klima x402 indisponível" });
    }
  });

  app.get("/api/market/klima-x402/quote-preview", async (req: Request, res: Response) => {
    const assetId = Number(req.query.assetId);
    const requestedKg = Number(req.query.kg);
    if (!Number.isInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "assetId inválido" });
    if (!Number.isInteger(requestedKg) || requestedKg <= 0 || requestedKg > 10_000_000) {
      return res.status(400).json({ error: "kg deve ser um inteiro positivo até 10.000.000" });
    }

    try {
      await refreshAndEnrich(false);
      const { rows } = await pool.query("SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE", [assetId]);
      const asset = rows[0];
      if (!asset || !isKlimaX402Asset(asset)) return res.status(404).json({ error: "Ativo x402 não encontrado" });
      if (requestedKg < Number(asset.min_order_kg || 1)) {
        return res.status(400).json({ error: `Pedido mínimo desta fonte: ${asset.min_order_kg} kg` });
      }
      if (Number(asset.available_tons || 0) * 1000 < requestedKg) {
        return res.status(409).json({ error: "Liquidez monitorada insuficiente para esta quantidade" });
      }

      const quote = await previewKlimaX402Quote(asset, requestedKg);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        asset: {
          id: asset.id,
          registry: asset.registry,
          projectName: asset.project_name,
          vintage: asset.vintage,
          availableTons: asset.available_tons,
          minOrderKg: asset.min_order_kg,
          claimCategory: asset.claim_category,
          eligibilityStatus: asset.eligibility_status,
        },
        requestedKg,
        quote,
        checkoutReady: false,
        executionEnabled: false,
        requestMode: asset.claim_category === "voluntary_offset" && asset.eligibility_status === "eligible" ? "assisted" : "discovery_only",
        message: "Preview x402 ao vivo. Nenhuma cobrança, assinatura ou aposentadoria foi executada.",
      });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Falha ao consultar quote x402" });
    }
  });

  app.post("/api/admin/market/klima-x402/refresh", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const refresh = await refreshKlimaX402Assets();
      const cfcEnrichment = await enrichX402CityForestCredits();
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...refresh, cfcEnrichment, status: klimaX402Status() });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Falha ao sincronizar Klima x402", status: klimaX402Status() });
    }
  });

  // x402 paid execution remains disabled. Eligible CFC preservation credits are
  // allowed to continue to the normal eligibility + assisted-quote flow, which
  // only creates a request and never charges. All other x402 assets remain
  // discovery/preview only and are blocked here.
  app.post("/api/market/quotes", async (req: Request, res: Response, next: NextFunction) => {
    const assetId = Number(req.body?.assetId);
    if (!Number.isInteger(assetId) || assetId <= 0) return next();
    try {
      const { rows } = await pool.query("SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE", [assetId]);
      const asset = rows[0];
      if (!asset || !isKlimaX402Asset(asset)) return next();

      const assistedVerified = asset.claim_category === "voluntary_offset"
        && asset.eligibility_status === "eligible"
        && asset.pricing_mode === "quote";
      if (assistedVerified) return next();

      return res.status(409).json({
        error: "Esta fonte x402 está habilitada apenas para discovery e preview de preço nesta fase.",
        code: "X402_EXECUTION_NOT_ENABLED",
        checkoutReady: false,
        executionEnabled: false,
        previewEndpoint: `/api/market/klima-x402/quote-preview?assetId=${asset.id}&kg=${Math.max(1, Number(req.body?.requestedKg || asset.min_order_kg || 1))}`,
        message: "O EcoTracker não cobrará nem aposentará este ativo até a integração de execução x402 ser explicitamente habilitada.",
      });
    } catch (error) { return fail(res, error); }
  });
}
