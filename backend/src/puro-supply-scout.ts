import type { Application, Request, Response } from "express";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";

type Facility = {
  code: string;
  name: string;
  methodologyCode?: string | null;
  supplierName?: string | null;
  supplierListingUrl?: string | null;
  country?: string | null;
  certificationStatus?: string | null;
  creditingPeriod?: { start?: string | null; end?: string | null } | null;
};

type Certificate = {
  certificates: string;
  volume: number;
  accountHolderName?: string | null;
  methodologyCode?: string | null;
  productionFacilityCode: string;
  vintage?: string | number | null;
  productionStartDate?: string | null;
  productionEndDate?: string | null;
  creditType?: string | null;
  issuanceId?: string | null;
};

type Paged<T> = { pagination?: { total?: number; offset?: number; limit?: number }; data?: T[] };

const apiBase = () => (process.env.PURO_REGISTRY_API_BASE || "https://registry.api.puro.earth/registry/api").replace(/\/$/, "");
const auth = () => String(process.env.PURO_REGISTRY_BASIC_AUTH || "").trim();

async function puroGet<T>(path: string): Promise<T> {
  const basic = auth();
  if (!basic) throw Object.assign(new Error("PURO_REGISTRY_BASIC_AUTH não configurado"), { status: 503 });
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(`Puro Registry Connect respondeu ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`), { status: response.status });
  }
  return await response.json() as T;
}

async function fetchAll<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  const limit = 100;
  for (let offset = 0; offset < 100_000; offset += limit) {
    const separator = path.includes("?") ? "&" : "?";
    const page = await puroGet<Paged<T>>(`${path}${separator}limit=${limit}&offset=${offset}`);
    const data = Array.isArray(page.data) ? page.data : [];
    result.push(...data);
    const total = Number(page.pagination?.total ?? result.length);
    if (data.length < limit || result.length >= total) break;
  }
  return result;
}

export type PuroBrazilScoutResult = {
  facilitiesScanned: number;
  brazilFacilities: number;
  activeCertificateBundles: number;
  leadsUpserted: number;
  activeTonnes: number;
  capturedAt: string;
};

export async function refreshPuroBrazilSupplyLeads(): Promise<PuroBrazilScoutResult> {
  const [facilities, certificates] = await Promise.all([
    fetchAll<Facility>("/registry/production-facilities"),
    fetchAll<Certificate>("/registry/certificates"),
  ]);

  const brazil = facilities.filter((facility) => String(facility.country || "").toUpperCase() === "BR");
  const facilityByCode = new Map(brazil.map((facility) => [String(facility.code), facility]));
  const grouped = new Map<string, {
    total: number;
    bundles: number;
    owners: Map<string, number>;
    vintages: Map<string, number>;
    certificates: string[];
    creditTypes: Set<string>;
  }>();

  for (const certificate of certificates) {
    const code = String(certificate.productionFacilityCode || "");
    if (!facilityByCode.has(code)) continue;
    const volume = Number(certificate.volume || 0);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    const current = grouped.get(code) || {
      total: 0, bundles: 0, owners: new Map<string, number>(), vintages: new Map<string, number>(), certificates: [], creditTypes: new Set<string>(),
    };
    current.total += volume;
    current.bundles += 1;
    const owner = String(certificate.accountHolderName || "Não divulgado");
    current.owners.set(owner, (current.owners.get(owner) || 0) + volume);
    const vintage = String(certificate.vintage || "não informado");
    current.vintages.set(vintage, (current.vintages.get(vintage) || 0) + volume);
    if (certificate.certificates && current.certificates.length < 30) current.certificates.push(String(certificate.certificates));
    if (certificate.creditType) current.creditTypes.add(String(certificate.creditType));
    grouped.set(code, current);
  }

  let leadsUpserted = 0;
  let activeTonnes = 0;
  const capturedAt = new Date().toISOString();

  for (const facility of brazil) {
    const code = String(facility.code);
    const active = grouped.get(code);
    const total = Number((active?.total || 0).toFixed(3));
    activeTonnes += total;
    const owners = active ? Object.fromEntries([...active.owners.entries()].sort((a, b) => b[1] - a[1])) : {};
    const vintages = active ? Object.fromEntries([...active.vintages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) : {};
    const sourceUrl = `https://registry.puro.earth/projects/${encodeURIComponent(code)}`;
    const metadata = {
      scout: "puro_registry_connect",
      certificationStatus: facility.certificationStatus || null,
      supplierListingUrl: facility.supplierListingUrl || null,
      creditingPeriod: facility.creditingPeriod || null,
      currentAccountHolders: owners,
      activeByVintage: vintages,
      activeCertificateBundles: active?.bundles || 0,
      certificateRangesSample: active?.certificates || [],
      creditTypes: active ? [...active.creditTypes] : [],
      interpretation: "active_non_retired_registry_balance_not_commercial_availability",
      capturedAt,
    };

    await pool.query(`
      INSERT INTO supply_leads
        (registry,registry_project_id,project_name,country,supplier_name,methodology,
         estimated_unretired_tonnes,evidence_url,source_url,data_source,availability_confidence,status,metadata,last_checked_at)
      VALUES('Puro.earth',$1,$2,'Brazil',$3,$4,$5,$6,$6,'puro_registry_connect','registry_estimate','scouted',$7::jsonb,NOW())
      ON CONFLICT(registry,registry_project_id) DO UPDATE SET
        project_name=EXCLUDED.project_name,country='Brazil',supplier_name=COALESCE(EXCLUDED.supplier_name,supply_leads.supplier_name),
        methodology=COALESCE(EXCLUDED.methodology,supply_leads.methodology),
        estimated_unretired_tonnes=EXCLUDED.estimated_unretired_tonnes,evidence_url=EXCLUDED.evidence_url,
        source_url=EXCLUDED.source_url,data_source='puro_registry_connect',
        availability_confidence=CASE WHEN supply_leads.confirmed_free_tonnes IS NOT NULL THEN 'seller_confirmed' ELSE 'registry_estimate' END,
        metadata=supply_leads.metadata || EXCLUDED.metadata,last_checked_at=NOW(),updated_at=NOW()`,
    [code,facility.name,facility.supplierName || null,facility.methodologyCode || null,total,sourceUrl,JSON.stringify(metadata)]);
    leadsUpserted += 1;
  }

  return {
    facilitiesScanned: facilities.length,
    brazilFacilities: brazil.length,
    activeCertificateBundles: [...grouped.values()].reduce((sum, item) => sum + item.bundles, 0),
    leadsUpserted,
    activeTonnes: Number(activeTonnes.toFixed(3)),
    capturedAt,
  };
}

export function registerPuroSupplyScoutRoutes(app: Application) {
  app.get("/api/admin/supply/scout/puro/status", requireAdmin, async (_req: Request, res: Response) => {
    res.json({
      provider: "puro_registry_connect",
      configured: Boolean(auth()),
      apiBase: apiBase(),
      countryFilter: "BR",
      reads: ["production-facilities", "active-certificates"],
      interpretation: "Certificates são ativos e não aposentados/withdrawn; isso ainda não prova que estejam comercialmente livres.",
    });
  });

  app.post("/api/admin/supply/scout/puro/refresh", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await refreshPuroBrazilSupplyLeads());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha no scanner Puro";
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
      res.status(Number.isFinite(status) ? status : 500).json({ error: message });
    }
  });
}
