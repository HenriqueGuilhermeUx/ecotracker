import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";

const publicReportsUrl = "https://acrcarbon.org/acr-registry/public-reports/";

const holdingSchema = z.object({
  projectId: z.string().min(1).max(180),
  projectName: z.string().min(2).max(255),
  projectType: z.string().max(180).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  region: z.string().max(180).nullable().optional(),
  methodology: z.string().max(255).nullable().optional(),
  accountHolderName: z.string().min(2).max(255),
  accountHolderPublicProfileUrl: z.string().url().nullable().optional(),
  vintage: z.string().max(80).nullable().optional(),
  holdingTonnes: z.coerce.number().positive().max(1_000_000_000),
  serialStart: z.string().max(255).nullable().optional(),
  serialEnd: z.string().max(255).nullable().optional(),
  corsiaEligible: z.boolean().nullable().optional(),
  ccpApproved: z.boolean().nullable().optional(),
  verifiedRemoval: z.boolean().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  evidenceUrl: z.string().url().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

type Holding = z.infer<typeof holdingSchema>;

function normalizedCountry(value: unknown) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function isBrazil(value: unknown) {
  return ["brazil","brasil","br"].includes(normalizedCountry(value));
}

export async function importAcrPublicHoldings(holdings: Holding[], countryFilter = "Brazil") {
  const useBrazilFilter = isBrazil(countryFilter);
  const filtered = useBrazilFilter ? holdings.filter((item) => isBrazil(item.country)) : holdings;
  const grouped = new Map<string, {
    project: Holding;
    total: number;
    holders: Map<string, number>;
    vintages: Map<string, number>;
    serials: Array<{ start: string | null; end: string | null; tonnes: number; holder: string }>;
    labels: Set<string>;
  }>();

  for (const holding of filtered) {
    const key = String(holding.projectId);
    const current = grouped.get(key) || {
      project: holding,
      total: 0,
      holders: new Map<string, number>(),
      vintages: new Map<string, number>(),
      serials: [],
      labels: new Set<string>(),
    };
    current.total += holding.holdingTonnes;
    current.holders.set(holding.accountHolderName, (current.holders.get(holding.accountHolderName) || 0) + holding.holdingTonnes);
    if (holding.vintage) current.vintages.set(holding.vintage, (current.vintages.get(holding.vintage) || 0) + holding.holdingTonnes);
    if (current.serials.length < 50) current.serials.push({ start: holding.serialStart || null, end: holding.serialEnd || null, tonnes: holding.holdingTonnes, holder: holding.accountHolderName });
    if (holding.corsiaEligible) current.labels.add("CORSIA eligible");
    if (holding.ccpApproved) current.labels.add("CCP approved");
    if (holding.verifiedRemoval) current.labels.add("Verified removal");
    grouped.set(key, current);
  }

  let leadsUpserted = 0;
  let publicHoldingTonnes = 0;
  const items: Array<Record<string, unknown>> = [];

  for (const entry of grouped.values()) {
    const project = entry.project;
    const total = Number(entry.total.toFixed(3));
    publicHoldingTonnes += total;
    const holderRows = [...entry.holders.entries()].sort((a,b) => b[1]-a[1]);
    const primaryHolder = holderRows[0]?.[0] || project.accountHolderName;
    const metadata = {
      scout: "acr_public_holdings",
      publicHoldingsByAccount: Object.fromEntries(holderRows),
      vintages: Object.fromEntries([...entry.vintages.entries()].sort((a,b) => a[0].localeCompare(b[0]))),
      serialSample: entry.serials,
      labels: [...entry.labels],
      projectType: project.projectType || null,
      accountHolderPublicProfileUrl: project.accountHolderPublicProfileUrl || null,
      interpretation: "public_holding_is_active_registry_balance_not_confirmed_commercial_availability",
      capturedAt: new Date().toISOString(),
      ...(project.metadata || {}),
    };
    const evidence = project.evidenceUrl || project.sourceUrl || publicReportsUrl;
    const { rows } = await pool.query(`
      INSERT INTO supply_leads
        (registry,registry_project_id,project_name,country,region,supplier_name,methodology,vintage,
         estimated_unretired_tonnes,evidence_url,source_url,data_source,availability_confidence,contact_status,status,metadata,last_checked_at)
      VALUES('ACR',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'acr_public_holdings','registry_estimate','not_contacted','scouted',$11::jsonb,NOW())
      ON CONFLICT(registry,registry_project_id) DO UPDATE SET
        project_name=EXCLUDED.project_name,country=COALESCE(EXCLUDED.country,supply_leads.country),
        region=COALESCE(EXCLUDED.region,supply_leads.region),supplier_name=COALESCE(EXCLUDED.supplier_name,supply_leads.supplier_name),
        methodology=COALESCE(EXCLUDED.methodology,supply_leads.methodology),vintage=COALESCE(EXCLUDED.vintage,supply_leads.vintage),
        estimated_unretired_tonnes=EXCLUDED.estimated_unretired_tonnes,evidence_url=EXCLUDED.evidence_url,
        source_url=EXCLUDED.source_url,data_source='acr_public_holdings',
        availability_confidence=CASE WHEN supply_leads.confirmed_free_tonnes IS NOT NULL THEN 'seller_confirmed' ELSE 'registry_estimate' END,
        metadata=supply_leads.metadata || EXCLUDED.metadata,last_checked_at=NOW(),updated_at=NOW()
      RETURNING id,public_code,project_name,supplier_name,estimated_unretired_tonnes,status`, [
      project.projectId,project.projectName,project.country || null,project.region || null,primaryHolder,
      project.methodology || project.projectType || null,[...entry.vintages.keys()].join(" | ") || null,total,evidence,
      project.sourceUrl || publicReportsUrl,JSON.stringify(metadata),
    ]);
    leadsUpserted += 1;
    items.push(rows[0]);
  }

  return {
    holdingsReceived: holdings.length,
    holdingsUsed: filtered.length,
    projectsGrouped: grouped.size,
    leadsUpserted,
    publicHoldingTonnes: Number(publicHoldingTonnes.toFixed(3)),
    countryFilter: useBrazilFilter ? "Brazil" : countryFilter,
    warning: "Public Holdings indica saldo ativo publicamente visível no registry, mas não revela contratos OTC, reservas ou exclusividade. O saldo só vira inventário EcoTracker após confirmação do holder e mandato.",
    items,
  };
}

export function registerAcrSupplyScoutRoutes(app: Application) {
  app.get("/api/admin/supply/scout/acr/status", requireAdmin, async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      provider: "acr_public_holdings",
      publicReportsUrl,
      structuredImportEnabled: true,
      automaticPrivateRegistryAccess: false,
      reports: ["Projects","Credits","Public Profiles","Public Holdings","retirement logs"],
      commercialModel: "ACR informa que contratação para compra/retirement ocorre OTC ou em plataforma vinculada; o registry registra transferência/retirement depois da transação.",
      interpretation: "Public Holdings é um excelente sinal de saldo registral ativo, não uma confirmação de disponibilidade comercial.",
    });
  });

  app.post("/api/admin/supply/scout/acr/import", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      countryFilter: z.string().max(100).default("Brazil"),
      holdings: z.array(holdingSchema).min(1).max(5000),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Importação ACR inválida", details: parsed.error.flatten() });
    try {
      res.status(201).json(await importAcrPublicHoldings(parsed.data.holdings, parsed.data.countryFilter));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Falha ao importar ACR Public Holdings" });
    }
  });

  app.get("/api/admin/supply/scout/acr/candidates", requireAdmin, async (req: Request, res: Response) => {
    try {
      const minTonnes = Math.max(0, Number(req.query.minTonnes || 1));
      const country = String(req.query.country || "Brazil").trim();
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT * FROM supply_leads
        WHERE registry='ACR'
          AND COALESCE(estimated_unretired_tonnes,0) >= $1
          AND ($2='' OR LOWER(country)=LOWER($2))
        ORDER BY CASE WHEN confirmed_free_tonnes IS NOT NULL THEN 1 ELSE 2 END,
                 COALESCE(confirmed_free_tonnes,estimated_unretired_tonnes,0) DESC,updated_at DESC
        LIMIT $3`, [minTonnes,country,limit]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Falha ao consultar ACR Public Holdings" });
    }
  });
}
