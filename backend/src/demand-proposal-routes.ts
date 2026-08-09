import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { createDemandProposal } from "./demand-proposal.js";

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const message = error instanceof Error ? error.message : "Erro interno";
  res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500).json({ error: message });
};

async function proposalView(idColumn: "p.id" | "p.public_code", id: string | number) {
  const { rows } = await pool.query(`
    SELECT p.*,a.company_name,a.legal_name,a.sector,a.contact_name,a.contact_email,
           o.claim_purpose,o.target_year,o.target_basis,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id',pi.id,'assetId',pi.asset_id,'registry',pi.registry,'projectName',pi.project_name,'vintage',pi.vintage,
             'amountTonnes',pi.amount_tonnes,'sourcePriceUsdTonne',pi.source_price_usd_tonne,
             'sourceCostBrl',pi.source_cost_brl,'indicativeSaleBrl',pi.indicative_sale_brl,
             'executionMode',pi.execution_mode,'retirementSupported',pi.retirement_supported,
             'evidenceUrl',pi.evidence_url,'snapshot',pi.item_snapshot
           ) ORDER BY pi.id) FROM demand_proposal_items pi WHERE pi.proposal_id=p.id), '[]'::jsonb) AS items
    FROM demand_proposals p
    JOIN demand_accounts a ON a.id=p.account_id
    JOIN demand_opportunities o ON o.id=p.opportunity_id
    WHERE ${idColumn}=$1`, [id]);
  return rows[0];
}

export function registerDemandProposalRoutes(app: Application) {
  app.post("/api/admin/demand/opportunities/:id/proposal", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      validityMinutes: z.coerce.number().int().min(5).max(10080).default(60),
      notes: z.string().max(10000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Configuração da proposta inválida", details: parsed.error.flatten() });
    try {
      res.status(201).json(await createDemandProposal({
        opportunityId: Number(req.params.id),
        validityMinutes: parsed.data.validityMinutes,
        notes: parsed.data.notes ?? null,
      }));
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/demand/proposals", requireAdmin, async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status || "").trim();
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT p.*,a.company_name,a.sector,a.contact_name,a.contact_email,o.claim_purpose,o.target_year,
               (SELECT COUNT(*) FROM demand_proposal_items pi WHERE pi.proposal_id=p.id)::int AS item_count
        FROM demand_proposals p
        JOIN demand_accounts a ON a.id=p.account_id
        JOIN demand_opportunities o ON o.id=p.opportunity_id
        WHERE ($1='' OR p.status=$1)
        ORDER BY CASE WHEN p.status='draft' THEN 1 WHEN p.status='partial' THEN 2 ELSE 3 END,p.created_at DESC
        LIMIT $2`, [status,limit]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/demand/proposals/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const proposal = await proposalView("p.id", Number(req.params.id));
      if (!proposal) return res.status(404).json({ error: "Proposta não encontrada" });
      res.setHeader("Cache-Control", "no-store");
      res.json(proposal);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/demand/proposals/:id/status", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ status: z.enum(["draft","partial","sent","accepted","rejected","expired","converted"]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Status de proposta inválido" });
    try {
      const { rows } = await pool.query(`UPDATE demand_proposals SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id,parsed.data.status]);
      if (!rows[0]) return res.status(404).json({ error: "Proposta não encontrada" });
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/demand/proposals/:publicCode", async (req: Request, res: Response) => {
    try {
      const proposal = await proposalView("p.public_code", req.params.publicCode);
      if (!proposal) return res.status(404).json({ error: "Proposta não encontrada" });
      if (proposal.expires_at && new Date(proposal.expires_at).getTime() < Date.now() && !["accepted","converted"].includes(String(proposal.status))) {
        return res.status(410).json({ error: "Esta proposta expirou" });
      }
      const items = Array.isArray(proposal.items) ? proposal.items : [];
      res.setHeader("Cache-Control", "no-store");
      res.json({
        publicCode: proposal.public_code,
        status: proposal.status,
        companyName: proposal.company_name,
        claimPurpose: proposal.claim_purpose,
        targetYear: proposal.target_year,
        targetTonnes: proposal.target_tonnes,
        coveredTonnes: proposal.covered_tonnes,
        uncoveredTonnes: proposal.uncovered_tonnes,
        coveragePct: proposal.coverage_pct,
        finalTotalBrl: proposal.final_total_brl,
        pricePerTonneBrl: proposal.price_per_tonne_brl,
        checkoutMode: proposal.checkout_mode,
        executionMode: proposal.execution_mode,
        expiresAt: proposal.expires_at,
        items: items.map((item: Record<string, unknown>) => ({
          registry: item.registry,
          projectName: item.projectName,
          vintage: item.vintage,
          amountTonnes: item.amountTonnes,
          executionMode: item.executionMode,
          retirementSupported: item.retirementSupported,
          evidenceUrl: item.evidenceUrl,
        })),
        disclosure: "A compensação é contabilizada separadamente do inventário corporativo e só se conclui após aposentadoria exclusiva dos créditos para o beneficiário, com evidência registral.",
      });
    } catch (error) { fail(res, error); }
  });
}
