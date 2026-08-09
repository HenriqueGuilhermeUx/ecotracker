import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { fgvDemandScoutStatus, importFgvParticipants } from "./fgv-demand-scout.js";
import { generateDemandMatches } from "./demand-matching.js";

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const message = error instanceof Error ? error.message : "Erro interno";
  return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500).json({ error: message });
};

const nullableUrl = z.string().url().nullable().optional();
const nonNegative = z.coerce.number().nonnegative().max(1_000_000_000).nullable().optional();

const accountSchema = z.object({
  source: z.string().min(2).max(80).default("manual"),
  sourceReference: z.string().min(1).max(180),
  companyName: z.string().min(2).max(255),
  legalName: z.string().max(255).nullable().optional(),
  taxId: z.string().max(40).nullable().optional(),
  sector: z.string().max(180).nullable().optional(),
  subSector: z.string().max(180).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  country: z.string().max(100).default("Brasil"),
  participantUrl: nullableUrl,
  websiteUrl: nullableUrl,
  contactName: z.string().max(255).nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().max(80).nullable().optional(),
  leadScore: z.coerce.number().int().min(0).max(100).default(0),
  notes: z.string().max(10000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const inventorySchema = z.object({
  inventoryYear: z.coerce.number().int().min(1990).max(2200),
  scope1Tonnes: nonNegative,
  scope2LocationTonnes: nonNegative,
  scope2MarketTonnes: nonNegative,
  scope3Tonnes: nonNegative,
  biogenicTonnes: nonNegative,
  removalsTonnes: nonNegative,
  reportedTotalTonnes: nonNegative,
  verificationLevel: z.string().max(30).default("unknown"),
  verificationProvider: z.string().max(255).nullable().optional(),
  inventoryUrl: nullableUrl,
  sourceUrl: nullableUrl,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const fgvParticipantSchema = z.object({
  participantId: z.string().min(1).max(180),
  companyName: z.string().min(2).max(255),
  legalName: z.string().max(255).nullable().optional(),
  taxId: z.string().max(40).nullable().optional(),
  sector: z.string().max(180).nullable().optional(),
  subSector: z.string().max(180).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  participantUrl: nullableUrl,
  websiteUrl: nullableUrl,
  contactName: z.string().max(255).nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().max(80).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  inventories: z.array(z.object({
    year: z.coerce.number().int().min(1990).max(2200),
    scope1Tonnes: nonNegative,
    scope2LocationTonnes: nonNegative,
    scope2MarketTonnes: nonNegative,
    scope3Tonnes: nonNegative,
    biogenicTonnes: nonNegative,
    removalsTonnes: nonNegative,
    reportedTotalTonnes: nonNegative,
    verificationLevel: z.string().max(30).nullable().optional(),
    verificationProvider: z.string().max(255).nullable().optional(),
    inventoryUrl: nullableUrl,
    sourceUrl: nullableUrl,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
});

function operationalTonnes(row: Record<string, unknown>) {
  const scope1 = Number(row.scope1_tonnes || 0);
  const scope2Market = row.scope2_market_tonnes == null ? null : Number(row.scope2_market_tonnes);
  const scope2Location = Number(row.scope2_location_tonnes || 0);
  const scope2 = scope2Market != null && Number.isFinite(scope2Market) ? scope2Market : scope2Location;
  return Number((Math.max(0, scope1) + Math.max(0, scope2)).toFixed(3));
}

async function latestInventory(accountId: number) {
  const { rows } = await pool.query("SELECT * FROM demand_inventories WHERE account_id=$1 ORDER BY inventory_year DESC LIMIT 1", [accountId]);
  return rows[0] as Record<string, unknown> | undefined;
}

export function registerDemandDeskRoutes(app: Application) {
  app.get("/api/admin/demand/fgv/status", requireAdmin, async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(fgvDemandScoutStatus());
  });

  app.post("/api/admin/demand/fgv/import", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ participants: z.array(fgvParticipantSchema).min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Importação FGV inválida", details: parsed.error.flatten() });
    try {
      const result = await importFgvParticipants(parsed.data.participants);
      res.status(201).json({ ...result, source: fgvDemandScoutStatus() });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/demand/accounts", requireAdmin, async (req: Request, res: Response) => {
    try {
      const source = String(req.query.source || "").trim();
      const status = String(req.query.status || "").trim();
      const minScore = Math.max(0, Math.min(100, Number(req.query.minScore || 0)));
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
      const { rows } = await pool.query(`
        SELECT a.*,
               i.id AS latest_inventory_id,i.inventory_year,i.scope1_tonnes,i.scope2_location_tonnes,
               i.scope2_market_tonnes,i.scope3_tonnes,i.reported_total_tonnes,i.verification_level,i.inventory_url,
               (COALESCE(i.scope1_tonnes,0)+COALESCE(i.scope2_market_tonnes,i.scope2_location_tonnes,0)) AS operational_tonnes
        FROM demand_accounts a
        LEFT JOIN LATERAL (
          SELECT * FROM demand_inventories di WHERE di.account_id=a.id ORDER BY di.inventory_year DESC LIMIT 1
        ) i ON TRUE
        WHERE ($1='' OR a.source=$1)
          AND ($2='' OR a.status=$2)
          AND a.lead_score >= $3
        ORDER BY a.lead_score DESC,COALESCE(i.inventory_year,0) DESC,a.updated_at DESC
        LIMIT $4`, [source,status,minScore,limit]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/demand/accounts", requireAdmin, async (req: Request, res: Response) => {
    const parsed = accountSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Conta de demanda inválida", details: parsed.error.flatten() });
    try {
      const d = parsed.data;
      const { rows } = await pool.query(`
        INSERT INTO demand_accounts
          (source,source_reference,company_name,legal_name,tax_id,sector,sub_sector,city,state,country,participant_url,
           website_url,contact_name,contact_email,contact_phone,lead_score,notes,metadata,last_checked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,NOW())
        ON CONFLICT(source,source_reference) DO UPDATE SET
          company_name=EXCLUDED.company_name,legal_name=COALESCE(EXCLUDED.legal_name,demand_accounts.legal_name),
          tax_id=COALESCE(EXCLUDED.tax_id,demand_accounts.tax_id),sector=COALESCE(EXCLUDED.sector,demand_accounts.sector),
          sub_sector=COALESCE(EXCLUDED.sub_sector,demand_accounts.sub_sector),city=COALESCE(EXCLUDED.city,demand_accounts.city),
          state=COALESCE(EXCLUDED.state,demand_accounts.state),country=EXCLUDED.country,
          participant_url=COALESCE(EXCLUDED.participant_url,demand_accounts.participant_url),
          website_url=COALESCE(EXCLUDED.website_url,demand_accounts.website_url),
          contact_name=COALESCE(EXCLUDED.contact_name,demand_accounts.contact_name),
          contact_email=COALESCE(EXCLUDED.contact_email,demand_accounts.contact_email),
          contact_phone=COALESCE(EXCLUDED.contact_phone,demand_accounts.contact_phone),
          lead_score=GREATEST(demand_accounts.lead_score,EXCLUDED.lead_score),
          notes=COALESCE(EXCLUDED.notes,demand_accounts.notes),metadata=demand_accounts.metadata || EXCLUDED.metadata,
          last_checked_at=NOW(),updated_at=NOW()
        RETURNING *`, [d.source,d.sourceReference,d.companyName,d.legalName ?? null,d.taxId ?? null,d.sector ?? null,d.subSector ?? null,
        d.city ?? null,d.state ?? null,d.country,d.participantUrl ?? null,d.websiteUrl ?? null,d.contactName ?? null,d.contactEmail ?? null,
        d.contactPhone ?? null,d.leadScore,d.notes ?? null,JSON.stringify(d.metadata)]);
      res.status(201).json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/demand/accounts/:id/inventories", requireAdmin, async (req: Request, res: Response) => {
    const parsed = inventorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Inventário de demanda inválido", details: parsed.error.flatten() });
    try {
      const d = parsed.data;
      const { rows } = await pool.query(`
        INSERT INTO demand_inventories
          (account_id,inventory_year,scope1_tonnes,scope2_location_tonnes,scope2_market_tonnes,scope3_tonnes,
           biogenic_tonnes,removals_tonnes,reported_total_tonnes,verification_level,verification_provider,inventory_url,source_url,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
        ON CONFLICT(account_id,inventory_year) DO UPDATE SET
          scope1_tonnes=EXCLUDED.scope1_tonnes,scope2_location_tonnes=EXCLUDED.scope2_location_tonnes,
          scope2_market_tonnes=EXCLUDED.scope2_market_tonnes,scope3_tonnes=EXCLUDED.scope3_tonnes,
          biogenic_tonnes=EXCLUDED.biogenic_tonnes,removals_tonnes=EXCLUDED.removals_tonnes,
          reported_total_tonnes=EXCLUDED.reported_total_tonnes,verification_level=EXCLUDED.verification_level,
          verification_provider=EXCLUDED.verification_provider,inventory_url=EXCLUDED.inventory_url,
          source_url=EXCLUDED.source_url,metadata=demand_inventories.metadata || EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`, [req.params.id,d.inventoryYear,d.scope1Tonnes ?? null,d.scope2LocationTonnes ?? null,d.scope2MarketTonnes ?? null,
        d.scope3Tonnes ?? null,d.biogenicTonnes ?? null,d.removalsTonnes ?? null,d.reportedTotalTonnes ?? null,
        d.verificationLevel,d.verificationProvider ?? null,d.inventoryUrl ?? null,d.sourceUrl ?? null,JSON.stringify(d.metadata)]);
      res.status(201).json({ ...rows[0], operationalTonnes: operationalTonnes(rows[0]) });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/demand/radar", requireAdmin, async (req: Request, res: Response) => {
    try {
      const source = String(req.query.source || "fgv_rpe").trim();
      const minScore = Math.max(0, Math.min(100, Number(req.query.minScore || 40)));
      const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT a.*,
               i.id AS inventory_id,i.inventory_year,i.scope1_tonnes,i.scope2_location_tonnes,i.scope2_market_tonnes,
               i.scope3_tonnes,i.reported_total_tonnes,i.verification_level,i.inventory_url,
               (COALESCE(i.scope1_tonnes,0)+COALESCE(i.scope2_market_tonnes,i.scope2_location_tonnes,0)) AS operational_tonnes,
               COALESCE(i.scope3_tonnes,0) AS value_chain_tonnes,
               CASE
                 WHEN a.contact_status='negotiating' THEN 1
                 WHEN a.contact_status='contacted' THEN 2
                 WHEN a.contact_status='qualified' THEN 3
                 ELSE 4 END AS contact_order
        FROM demand_accounts a
        JOIN LATERAL (
          SELECT * FROM demand_inventories di WHERE di.account_id=a.id ORDER BY di.inventory_year DESC LIMIT 1
        ) i ON TRUE
        WHERE ($1='' OR a.source=$1) AND a.lead_score >= $2
        ORDER BY contact_order,a.lead_score DESC,operational_tonnes DESC
        LIMIT $3`, [source,minScore,limit]);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        count: rows.length,
        totalOperationalTonnes: Number(rows.reduce((sum,row) => sum + Number(row.operational_tonnes || 0), 0).toFixed(3)),
        items: rows.map((row) => ({
          ...row,
          suggestedFirstOfferTonnes: Number(Math.max(0, Number(row.operational_tonnes || 0)).toFixed(3)),
          suggestedClaim: "Compensação voluntária separada do inventário corporativo; retirement exclusivo em nome do beneficiário.",
        })),
      });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/demand/accounts/:id/opportunities", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      inventoryId: z.coerce.number().int().positive().nullable().optional(),
      targetTonnes: z.coerce.number().positive().max(1_000_000_000).nullable().optional(),
      targetBasis: z.enum(["custom","scope1","scope1_2","scope1_2_percent"]).default("scope1_2"),
      targetPercent: z.coerce.number().positive().max(100).default(100),
      claimPurpose: z.enum(["voluntary_offset","climate_contribution","compliance"]).default("voluntary_offset"),
      targetYear: z.coerce.number().int().min(1990).max(2200).nullable().optional(),
      budgetUsd: z.coerce.number().positive().nullable().optional(),
      maxPriceUsdTonne: z.coerce.number().positive().nullable().optional(),
      preferredCountry: z.string().max(100).nullable().optional(),
      preferredRegistry: z.string().max(120).nullable().optional(),
      preferredProjectType: z.string().max(180).nullable().optional(),
      priorityScore: z.coerce.number().int().min(0).max(100).nullable().optional(),
      constraints: z.record(z.string(), z.unknown()).default({}),
      notes: z.string().max(10000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Oportunidade de demanda inválida", details: parsed.error.flatten() });

    try {
      const accountId = Number(req.params.id);
      const accountResult = await pool.query("SELECT * FROM demand_accounts WHERE id=$1", [accountId]);
      const account = accountResult.rows[0];
      if (!account) return res.status(404).json({ error: "Conta de demanda não encontrada" });
      let inventory: Record<string, unknown> | undefined;
      if (parsed.data.inventoryId) {
        const result = await pool.query("SELECT * FROM demand_inventories WHERE id=$1 AND account_id=$2", [parsed.data.inventoryId,accountId]);
        inventory = result.rows[0];
      } else {
        inventory = await latestInventory(accountId);
      }
      if (!inventory && !parsed.data.targetTonnes) return res.status(409).json({ error: "Informe targetTonnes ou cadastre um inventário para dimensionar a oportunidade" });

      let targetTonnes = parsed.data.targetTonnes || 0;
      if (!targetTonnes && inventory) {
        const scope1 = Number(inventory.scope1_tonnes || 0);
        const scope2 = inventory.scope2_market_tonnes == null ? Number(inventory.scope2_location_tonnes || 0) : Number(inventory.scope2_market_tonnes || 0);
        if (parsed.data.targetBasis === "scope1") targetTonnes = scope1;
        else targetTonnes = scope1 + scope2;
        if (parsed.data.targetBasis === "scope1_2_percent") targetTonnes = targetTonnes * parsed.data.targetPercent / 100;
      }
      targetTonnes = Number(targetTonnes.toFixed(3));
      if (!(targetTonnes > 0)) return res.status(409).json({ error: "O volume-alvo calculado é zero; informe um targetTonnes explícito" });

      const priorityScore = parsed.data.priorityScore ?? Math.max(0, Math.min(100, Number(account.lead_score || 0) + (targetTonnes >= 10_000 ? 10 : targetTonnes >= 1_000 ? 5 : 0)));
      const { rows } = await pool.query(`
        INSERT INTO demand_opportunities
          (account_id,inventory_id,status,target_tonnes,target_basis,claim_purpose,target_year,budget_usd,max_price_usd_tonne,
           preferred_country,preferred_registry,preferred_project_type,priority_score,constraints,notes)
        VALUES($1,$2,'identified',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
        RETURNING *`, [accountId,inventory?.id ?? null,targetTonnes,parsed.data.targetBasis,parsed.data.claimPurpose,
        parsed.data.targetYear ?? inventory?.inventory_year ?? null,parsed.data.budgetUsd ?? null,parsed.data.maxPriceUsdTonne ?? null,
        parsed.data.preferredCountry ?? null,parsed.data.preferredRegistry ?? null,parsed.data.preferredProjectType ?? null,
        priorityScore,JSON.stringify(parsed.data.constraints),parsed.data.notes ?? null]);
      res.status(201).json({ ...rows[0], companyName: account.company_name });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/demand/opportunities", requireAdmin, async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status || "").trim();
      const { rows } = await pool.query(`
        SELECT o.*,a.company_name,a.sector,a.contact_status,a.contact_email,a.contact_phone,
               i.inventory_year,i.scope1_tonnes,i.scope2_location_tonnes,i.scope2_market_tonnes,i.scope3_tonnes,
               COALESCE((SELECT COUNT(*) FROM demand_matches m WHERE m.opportunity_id=o.id AND m.status='proposed'),0) AS match_count,
               COALESCE((SELECT SUM(m.matched_tonnes) FROM demand_matches m WHERE m.opportunity_id=o.id AND m.status='proposed' AND m.claim_ready=TRUE),0) AS matched_tonnes
        FROM demand_opportunities o
        JOIN demand_accounts a ON a.id=o.account_id
        LEFT JOIN demand_inventories i ON i.id=o.inventory_id
        WHERE ($1='' OR o.status=$1)
        ORDER BY o.priority_score DESC,o.created_at DESC`, [status]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/demand/opportunities/:id/match", requireAdmin, async (req: Request, res: Response) => {
    try {
      const result = await generateDemandMatches(Number(req.params.id));
      res.json(result);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/demand/opportunities/:id/matches", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(`
        SELECT * FROM demand_matches WHERE opportunity_id=$1 ORDER BY claim_ready DESC,score DESC,indicative_price_usd_tonne ASC NULLS LAST`,
      [req.params.id]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) { fail(res, error); }
  });
}
