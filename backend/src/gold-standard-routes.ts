import type { Application, NextFunction, Request, Response } from "express";
import { requireAdmin } from "./auth.js";
import {
  goldStandardMarketplaceStatus,
  refreshGoldStandardIfStale,
  refreshGoldStandardMarketplace,
} from "./gold-standard-marketplace.js";

export function registerGoldStandardRoutes(app: Application) {
  const refreshBeforeRead = async (_req: Request, _res: Response, next: NextFunction) => {
    try { await refreshGoldStandardIfStale(); }
    catch (error) { console.warn("[gold-standard] refresh before read failed", error); }
    next();
  };

  app.get("/api/market/assets", refreshBeforeRead);
  app.get("/api/market/catalog/eligibility", refreshBeforeRead);
  app.get("/api/market/compensation-assets", refreshBeforeRead);
  app.get("/api/market/availability", refreshBeforeRead);
  app.get("/api/market/sourcing/status", refreshBeforeRead);
  app.get("/api/market/sourcing/candidates", refreshBeforeRead);
  app.get("/api/market/sourcing/health", refreshBeforeRead);

  app.get("/api/market/gold-standard/status", async (_req: Request, res: Response) => {
    try {
      const refresh = await refreshGoldStandardIfStale();
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...goldStandardMarketplaceStatus(), refresh });
    } catch (error) {
      res.status(503).json({
        ...goldStandardMarketplaceStatus(),
        error: error instanceof Error ? error.message : "Gold Standard Marketplace indisponível",
      });
    }
  });

  app.post("/api/admin/market/gold-standard/refresh", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const refresh = await refreshGoldStandardMarketplace();
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...refresh, status: goldStandardMarketplaceStatus() });
    } catch (error) {
      res.status(503).json({
        error: error instanceof Error ? error.message : "Falha ao sincronizar Gold Standard Marketplace",
        status: goldStandardMarketplaceStatus(),
      });
    }
  });
}
