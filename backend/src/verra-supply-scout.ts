import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";

const publicBase = () => (process.env.VERRA_REGISTRY_PUBLIC_BASE || "https://registry.verra.org").replace(/\/$/, "");

const unitSchema = z.object({
  issuanceDate: z.string().max(40).nullable().optional(),
  vintageStart: z.string().max(40).nullable().optional(),
  vintageEnd: z.string().max(40).nullable().optional(),
  totalVintageQuantity: z.coerce.number().nonnegative().nullable().optional(),
  quantityIssued: z.coerce.number().nonnegative(),
  serialNumber: z.string().max(1000).nullable().optional(),
  retirementCancellationDate: z.string().max(40).nullable().optional(),
  retirementBeneficiary: z.string().max(500).nullable().optional(),
  retirementReason: z.string().max(1000).nullable().optional(),
  retirementDetail: z.string().max(3000).nullable().optional(),
  disposition: z.enum(["active","retired","cancelled","canceled","unknown"]).default("unknown"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const projectSchema = z.object({
  projectId: z.string().min(1).max(180),
  projectName: z.string().min(2).max(255),
  country: z.string().max(100).default("Brazil"),
  region: z.string().max(180).nullable().optional(),
  proponentName: z.string().max(255).nullable().optional(),
  proponentEmail: z.string().email().nullable().optional(),
  proponentPhone: z.string().max(80).nullable().optional(),
  methodology: z.string().max(255).nullable().optional(),
  projectType: z.string().max(180).nullable().optional(),
  projectStatus: z.string().max(120).nullable().optional(),
  estimatedAnnualReductions: z.coerce.number().nonnegative().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  evidenceUrl: z.string().url().nullable().optional(),
  units: z.array(unitSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

type Unit = z.infer<typeof unitSchema>;
type Project = z.infer<typeof projectSchema>;

function disposition(unit: Unit) {
  if (["retired"].includes(unit.disposition)) return "retired";
  if (["cancelled","canceled"].includes(unit.disposition)) return "cancelled";
  const reason = String(unit.retirementReason || "").toLowerCase();
  const detail = String(unit.retirementDetail || "").toLowerCase();
  if (unit.retirementCancellationDate) {
    if (reason.includes("cancel") || detail.includes("cancel")) return "cancelled";
    return "retired";
  }
  return "active";
}

function yearFrom(value: unknown): number | null {
  const match = String(value || "").match(/(?:19|20)\d{2}/);
  if (!match) return null;
  const year = Number(match[0]);
  return Number.isInteger(year) ? year : null;
}

function summarize(project: Project) {
  let issued = 0;
  let retired = 0;
  let cancelled = 0;
  const activeSerials: string[] = [];
  const vintages = new Set<number>();
  const beneficiaries = new Set<string>();

  for (const unit of project.units) {
    const quantity = Number(unit.quantityIssued || 0);
    if (!(quantity > 0)) continue;
    issued += quantity;
    const state = disposition(unit);
    if (state === "retired") retired += quantity;
    else if (state === "cancelled") cancelled += quantity;
    else if (unit.serialNumber && activeSerials.length < 50) activeSerials.push(unit.serialNumber);
    const vintage = yearFrom(unit.vintageStart || unit.vintageEnd);
    if (vintage) vintages.add(vintage);
    if (unit.retirementBeneficiary) beneficiaries.add(unit.retirementBeneficiary);
  }

  const unretired = Math.max(0, issued - retired - cancelled);
  return {
    issuedTonnes: Number(issued.toFixed(3)),
    retiredTonnes: Number(retired.toFixed(3)),
    cancelledTonnes: Number(cancelled.toFixed(3)),
    estimatedUnretiredTonnes: Number(unretired.toFixed(3)),
    vintages: [...vintages].sort((a,b) => a-b),
    activeSerialSample: activeSerials,
    retirementBeneficiarySample: [...beneficiaries].slice(0, 20),
  };
}

function isBrazil(country: string) {
  const normalized = country.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return ["brazil","brasil","br"].includes(normalized);
}

export async function importVerraBrazilPublicReport(projects: Project[]) {
  const brazilProjects = projects.filter((project) => isBrazil(project.country));
  let leadsUpserted = 0;
  let totalEstimatedUnretired = 0;
  const items: Array<Record<string, unknown>> = [];

  for (const project of brazilProjects) {
    const summary = summarize(project);
    totalEstimatedUnretired += summary.estimatedUnretiredTonnes;
    const sourceUrl = project.sourceUrl || `${publicBase()}/app/projectDetail/VCS/${encodeURIComponent(project.projectId)}`;
    const projectStatus = String(project.projectStatus || "unknown");
    const statusNormalized = projectStatus.toLowerCase();
    const registryEligibleForOutreach = statusNormalized.includes("registered") || statusNormalized.includes("active") || statusNormalized === "unknown";
    const metadata = {
      scout: "verra_public_report",
      projectStatus,
      projectType: project.projectType || null,
      estimatedAnnualReductions: project.estimatedAnnualReductions ?? null,
      vintages: summary.vintages,
      activeSerialSample: summary.activeSerialSample,
      retirementBeneficiarySample: summary.retirementBeneficiarySample,
      unitRowsImported: project.units.length,
      interpretation: "issued_minus_retired_minus_cancelled_is_registry_estimate_not_confirmed_commercial_availability",
      registryEligibleForOutreach,
      ...(project.metadata || {}),
      capturedAt: new Date().toISOString(),
    };

    const { rows } = await pool.query(`
      INSERT INTO supply_leads
        (registry,registry_project_id,project_name,country,region,supplier_name,supplier_email,supplier_phone,
         methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,
         evidence_url,source_url,data_source,availability_confidence,contact_status,status,metadata,last_checked_at)
      VALUES('Verra VCS',$1,$2,'Brazil',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'verra_public_report',
        'registry_estimate','not_contacted',$14,$15::jsonb,NOW())
      ON CONFLICT(registry,registry_project_id) DO UPDATE SET
        project_name=EXCLUDED.project_name,country='Brazil',region=COALESCE(EXCLUDED.region,supply_leads.region),
        supplier_name=COALESCE(EXCLUDED.supplier_name,supply_leads.supplier_name),
        supplier_email=COALESCE(EXCLUDED.supplier_email,supply_leads.supplier_email),
        supplier_phone=COALESCE(EXCLUDED.supplier_phone,supply_leads.supplier_phone),
        methodology=COALESCE(EXCLUDED.methodology,supply_leads.methodology),
        vintage=COALESCE(EXCLUDED.vintage,supply_leads.vintage),issued_tonnes=EXCLUDED.issued_tonnes,
        retired_tonnes=EXCLUDED.retired_tonnes,withdrawn_tonnes=EXCLUDED.withdrawn_tonnes,
        estimated_unretired_tonnes=EXCLUDED.estimated_unretired_tonnes,
        evidence_url=EXCLUDED.evidence_url,source_url=EXCLUDED.source_url,data_source='verra_public_report',
        availability_confidence=CASE WHEN supply_leads.confirmed_free_tonnes IS NOT NULL THEN 'seller_confirmed' ELSE 'registry_estimate' END,
        status=CASE WHEN supply_leads.status IN ('mandated','qualified') THEN supply_leads.status ELSE EXCLUDED.status END,
        metadata=supply_leads.metadata || EXCLUDED.metadata,last_checked_at=NOW(),updated_at=NOW()
      RETURNING id,public_code,project_name,supplier_name,estimated_unretired_tonnes,status`, [
      project.projectId,project.projectName,project.region ?? null,project.proponentName ?? null,project.proponentEmail ?? null,
      project.proponentPhone ?? null,project.methodology ?? null,summary.vintages.join(" | ") || null,
      summary.issuedTonnes,summary.retiredTonnes,summary.cancelledTonnes,summary.estimatedUnretiredTonnes,
      project.evidenceUrl || sourceUrl,registryEligibleForOutreach ? "scouted" : "watchlist",JSON.stringify(metadata),
    ]);
    leadsUpserted += 1;
    items.push(rows[0]);
  }

  return {
    projectsReceived: projects.length,
    brazilProjects: brazilProjects.length,
    leadsUpserted,
    estimatedUnretiredTonnes: Number(totalEstimatedUnretired.toFixed(3)),
    warning: "Saldo não aposentado é apenas potencial registral. O EcoTracker só transforma esse valor em estoque distribuível após confirmação de saldo livre e mandato do fornecedor.",
    items,
  };
}

export function registerVerraSupplyScoutRoutes(app: Application) {
  app.get("/api/admin/supply/scout/verra/status", requireAdmin, async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      provider: "verra_public_report",
      publicBase: publicBase(),
      program: "VCS",
      countryFilter: "Brazil",
      structuredImportEnabled: true,
      automaticApiRefreshEnabled: false,
      publicDataUsefulFor: ["projects","proponents","issuances","retirements","cancellations","serials","vintages"],
      interpretation: "Public registry data estimates unretired balance but does not reveal OTC commitments, exclusivity or other commercial reservations.",
      transition: "Verra launched a new S&P Global Energy-powered registry in July 2026. Transaction-ready/data API services are being rolled out in future phases, so EcoTracker avoids hard-coding legacy private endpoints.",
    });
  });

  app.post("/api/admin/supply/scout/verra/import", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ projects: z.array(projectSchema).min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Importação Verra inválida", details: parsed.error.flatten() });
    try {
      res.status(201).json(await importVerraBrazilPublicReport(parsed.data.projects));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Falha ao importar Public Report da Verra" });
    }
  });

  app.get("/api/admin/supply/scout/verra/candidates", requireAdmin, async (req: Request, res: Response) => {
    try {
      const minTonnes = Math.max(0, Number(req.query.minTonnes || 1));
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT * FROM supply_leads
        WHERE registry='Verra VCS' AND country='Brazil'
          AND COALESCE(estimated_unretired_tonnes,0) >= $1
        ORDER BY
          CASE WHEN confirmed_free_tonnes IS NOT NULL THEN 1 ELSE 2 END,
          COALESCE(confirmed_free_tonnes,estimated_unretired_tonnes,0) DESC,
          updated_at DESC
        LIMIT $2`, [minTonnes,limit]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Falha ao consultar leads Verra" });
    }
  });
}
