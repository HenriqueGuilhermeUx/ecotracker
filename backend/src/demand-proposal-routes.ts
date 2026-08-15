import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { convertSingleAssetProposal } from "./demand-proposal-conversion.js";
import { createDemandProposal } from "./demand-proposal.js";

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const message = error instanceof Error ? error.message : "Erro interno";
  const body:Record<string,unknown>={error:message};
  if (typeof error === "object" && error && "code" in error) body.code=(error as {code:unknown}).code;
  if (typeof error === "object" && error && "problems" in error) body.problems=(error as {problems:unknown}).problems;
  res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500).json(body);
};

async function proposalView(idColumn: "p.id" | "p.public_code", id: string | number) {
  const { rows } = await pool.query(`
    SELECT p.*,a.company_name,a.legal_name,a.sector,a.contact_name,a.contact_email,
           o.claim_purpose,o.target_year,o.target_basis,o.status AS opportunity_status,
           r.status AS review_status,r.snapshot_sha256,r.reviewed_by,r.approved_at,r.rejected_at,
           ob.id AS outbox_id,ob.status AS outbox_status,ob.recipient_email AS outbox_recipient_email,
           ob.provider_reference AS outreach_provider_reference,ob.sent_at AS outreach_sent_at,
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
    LEFT JOIN demand_proposal_reviews r ON r.proposal_id=p.id
    LEFT JOIN demand_outbox ob ON ob.proposal_id=p.id
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
        SELECT p.*,a.company_name,a.sector,a.contact_name,a.contact_email,o.claim_purpose,o.target_year,o.status AS opportunity_status,
               r.status AS review_status,r.snapshot_sha256,r.reviewed_by,r.approved_at,
               ob.id AS outbox_id,ob.status AS outbox_status,ob.sent_at AS outreach_sent_at,
               (SELECT COUNT(*) FROM demand_proposal_items pi WHERE pi.proposal_id=p.id)::int AS item_count,
               (
                 o.status<>'sourcing_required'
                 AND p.expires_at>NOW()
                 AND NOT EXISTS (
                   SELECT 1
                   FROM demand_proposal_items pi
                   LEFT JOIN monitored_assets ma ON ma.id=pi.asset_id
                   WHERE pi.proposal_id=p.id AND (
                     ma.id IS NULL OR
                     ma.active IS DISTINCT FROM TRUE OR
                     ma.claim_category<>'voluntary_offset' OR
                     ma.eligibility_status<>'eligible' OR
                     ma.source_unit_status<>'tradable' OR
                     ma.availability_status NOT IN ('confirmed','indicative') OR
                     ma.retirement_supported IS DISTINCT FROM TRUE OR
                     COALESCE(ma.available_tons,0)+0.0005<pi.amount_tonnes OR
                     (ma.commercial_valid_until IS NOT NULL AND ma.commercial_valid_until<CURRENT_DATE) OR
                     (ma.offer_expires_at IS NOT NULL AND ma.offer_expires_at<=NOW())
                   )
                 )
               ) AS review_eligible_now
        FROM demand_proposals p
        JOIN demand_accounts a ON a.id=p.account_id
        JOIN demand_opportunities o ON o.id=p.opportunity_id
        LEFT JOIN demand_proposal_reviews r ON r.proposal_id=p.id
        LEFT JOIN demand_outbox ob ON ob.proposal_id=p.id
        WHERE ($1='' OR p.status=$1)
        ORDER BY CASE
          WHEN p.status='draft' AND r.status IS NULL THEN 1
          WHEN p.status='draft' AND r.status='approved' AND ob.id IS NULL THEN 2
          WHEN ob.status='ready' THEN 3
          WHEN p.status='partial' THEN 4
          ELSE 5 END,p.created_at DESC
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

  app.post("/api/admin/demand/proposals/:id/convert-single", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await convertSingleAssetProposal(Number(req.params.id)));
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/demand/proposals/:id/status", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ status: z.enum(["draft","partial","accepted","rejected","expired","converted"]) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Status de proposta inválido. O status sent só pode ser produzido pelo dispatch do outbox comercial aprovado.",
      });
    }
    try {
      const current = (await pool.query(`SELECT * FROM demand_proposals WHERE id=$1`,[req.params.id])).rows[0];
      if (!current) return res.status(404).json({ error: "Proposta não encontrada" });
      if (parsed.data.status === "accepted" && current.status !== "sent") {
        return res.status(409).json({ error: "A proposta só pode ser aceita depois de enviada pelo fluxo comercial aprovado" });
      }
      if (["draft","partial"].includes(parsed.data.status) && !["draft","partial"].includes(String(current.status))) {
        return res.status(409).json({ error: "Não é permitido reabrir manualmente uma proposta após avanço comercial" });
      }
      const { rows } = await pool.query(`UPDATE demand_proposals SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id,parsed.data.status]);
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/demand/proposals/:publicCode", async (req: Request, res: Response) => {
    try {
      const raw = req.params.publicCode;
      const publicCode = Array.isArray(raw) ? raw[0] : raw;
      const proposal = await proposalView("p.public_code", publicCode);
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
