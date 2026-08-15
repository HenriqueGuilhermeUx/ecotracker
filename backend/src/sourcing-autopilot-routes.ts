import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { getSourcingSummary } from "./sourcing-engine.js";
import { getSourcingAutopilotStatus, runSourcingAutopilot } from "./sourcing-autopilot.js";
import {
  getOpenRfqResolutionStatus,
  getRfqResolutionAutopilot,
  runRfqResolutionAutopilot,
  startRfqResolutionAutopilot,
} from "./rfq-resolution-autopilot.js";

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  return res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500)
    .json({ error: error instanceof Error ? error.message : "Erro interno" });
};

export function registerSourcingAutopilotRoutes(app: Application) {
  app.get("/api/market/sourcing/health", async (_req: Request, res: Response) => {
    try {
      const [summary, latest, alerts] = await Promise.all([
        getSourcingSummary(),
        pool.query(`SELECT status,verified_count,executable_count,fractional_count,minimum_target,
          needs_replenishment,needs_fractional_source,replenishment_attempted,started_at,completed_at
          FROM sourcing_autopilot_runs ORDER BY started_at DESC LIMIT 1`),
        pool.query("SELECT alert_key,severity,title,last_seen_at FROM sourcing_autopilot_alerts WHERE status='open' ORDER BY last_seen_at DESC"),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        status: summary.verifiedCompensationAssets >= summary.minimumVerifiedTarget ? "healthy" : "needs_replenishment",
        summary,
        latestRun: latest.rows[0] || null,
        alerts: alerts.rows,
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/market/sourcing/autopilot", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getSourcingAutopilotStatus());
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market/sourcing/autopilot/run", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ forceProviders: z.boolean().default(true) }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Parâmetros inválidos", details: parsed.error.flatten() });
    try {
      const result = await runSourcingAutopilot("manual", parsed.data.forceProviders);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Falha no ciclo manual do sourcing" });
    }
  });

  app.get("/api/admin/market/sourcing/autopilot/runs", requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
      const { rows } = await pool.query(
        "SELECT * FROM sourcing_autopilot_runs ORDER BY started_at DESC LIMIT $1",
        [limit],
      );
      res.setHeader("Cache-Control", "no-store");
      res.json(rows);
    } catch (error) { fail(res, error); }
  });

  // Deal-focused autopilot: the operator should not manually probe listings one by one.
  app.get("/api/admin/market-maker/rfq-resolution-autopilot", requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
      res.setHeader("Cache-Control", "no-store");
      res.json({ items: await getOpenRfqResolutionStatus(limit) });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/market-maker/rfqs/:id/resolution-autopilot", requireAdmin, async (req: Request, res: Response) => {
    try {
      const rfqId = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
      if (!Number.isInteger(rfqId) || rfqId <= 0) return res.status(400).json({ error: "RFQ inválido" });
      res.setHeader("Cache-Control", "no-store");
      res.json(await getRfqResolutionAutopilot(rfqId));
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market-maker/rfqs/:id/resolution-autopilot/run", requireAdmin, async (req: Request, res: Response) => {
    try {
      const rfqId = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
      if (!Number.isInteger(rfqId) || rfqId <= 0) return res.status(400).json({ error: "RFQ inválido" });
      res.setHeader("Cache-Control", "no-store");
      res.json(await runRfqResolutionAutopilot(rfqId));
    } catch (error) { fail(res, error); }
  });

  // Starts only safe provider probes. Production order/payment/retirement gates remain untouched.
  startRfqResolutionAutopilot();
}
