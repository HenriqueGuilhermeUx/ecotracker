import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { demandAutopilotStatus, runDemandAutopilot, updateDemandAutopilotSettings } from "./demand-autopilot.js";

function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  return res.status(Number.isInteger(status) && status>=400 && status<=599 ? status : 500).json({
    error:error instanceof Error ? error.message : "Erro interno",
  });
}

export function registerDemandAutopilotRoutes(app:Application) {
  app.get("/api/admin/demand/autopilot/status",requireAdmin,async (_req:Request,res:Response) => {
    try {
      res.setHeader("Cache-Control","no-store");
      return res.json(await demandAutopilotStatus());
    } catch (error) { return fail(res,error); }
  });

  app.patch("/api/admin/demand/autopilot/settings",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      enabled:z.boolean().optional(),
      minLeadScore:z.coerce.number().int().min(0).max(100).optional(),
      minOperationalTonnes:z.coerce.number().nonnegative().max(1_000_000_000).optional(),
      targetPercent:z.coerce.number().positive().max(100).optional(),
      maxAccountsPerRun:z.coerce.number().int().min(1).max(1000).optional(),
      intervalMinutes:z.coerce.number().int().min(15).max(10080).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:"Configuração do Demand Autopilot inválida",details:parsed.error.flatten() });
    try {
      const settings = await updateDemandAutopilotSettings(parsed.data);
      return res.json({ settings,status:await demandAutopilotStatus() });
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/autopilot/run",requireAdmin,async (_req:Request,res:Response) => {
    try {
      const result = await runDemandAutopilot({ triggerMode:"manual",force:true });
      return res.json(result);
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/autopilot/runs",requireAdmin,async (req:Request,res:Response) => {
    try {
      const limit = Math.max(1,Math.min(200,Number(req.query.limit || 50)));
      const { rows } = await pool.query(`SELECT * FROM demand_autopilot_runs ORDER BY id DESC LIMIT $1`,[limit]);
      res.setHeader("Cache-Control","no-store");
      return res.json({ count:rows.length,items:rows });
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/autopilot/pipeline",requireAdmin,async (req:Request,res:Response) => {
    try {
      const limit = Math.max(1,Math.min(500,Number(req.query.limit || 200)));
      const { rows } = await pool.query(`
        SELECT o.id,o.public_code,o.account_id,o.inventory_id,o.status,o.target_tonnes,o.claim_purpose,
               o.priority_score,o.autopilot_key,o.autopilot_metadata,o.created_at,o.updated_at,
               a.company_name,a.tax_id,a.sector,a.contact_name,a.contact_email,a.contact_phone,a.lead_score,
               i.inventory_year,i.scope1_tonnes,i.scope2_location_tonnes,i.scope2_market_tonnes,i.scope3_tonnes,
               p.id AS proposal_id,p.public_code AS proposal_public_code,p.status AS proposal_status,
               p.coverage_pct,p.checkout_mode,p.final_total_brl,p.expires_at AS proposal_expires_at
        FROM demand_opportunities o
        JOIN demand_accounts a ON a.id=o.account_id
        LEFT JOIN demand_inventories i ON i.id=o.inventory_id
        LEFT JOIN LATERAL (
          SELECT * FROM demand_proposals dp WHERE dp.opportunity_id=o.id ORDER BY dp.id DESC LIMIT 1
        ) p ON TRUE
        WHERE o.autopilot_key IS NOT NULL
        ORDER BY CASE o.status
          WHEN 'proposal_ready' THEN 1
          WHEN 'sourcing_required' THEN 2
          WHEN 'identified' THEN 3
          ELSE 4 END,
          o.priority_score DESC,o.updated_at DESC
        LIMIT $1`,[limit]);
      res.setHeader("Cache-Control","no-store");
      return res.json({
        count:rows.length,
        proposalReady:rows.filter((row) => row.proposal_id && Number(row.coverage_pct || 0)>=99.99).length,
        sourcingRequired:rows.filter((row) => row.status==="sourcing_required").length,
        targetTonnes:Number(rows.reduce((sum,row) => sum+Number(row.target_tonnes || 0),0).toFixed(3)),
        items:rows,
      });
    } catch (error) { return fail(res,error); }
  });
}
