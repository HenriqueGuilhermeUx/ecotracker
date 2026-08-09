import { refreshCarbonmarkAssets, refreshCarbonmarkIfStale } from "./carbonmark.js";
import { pool } from "./db.js";
import { enrichGoldStandardIfStale } from "./gold-standard-enrichment.js";
import { refreshGoldStandardIfStale, refreshGoldStandardMarketplace } from "./gold-standard-marketplace.js";
import { refreshKlimaX402Assets, refreshKlimaX402IfStale } from "./klima-x402.js";
import { getSourcingSummary, rankSourcingInventory } from "./sourcing-engine.js";
import { getSourcingOpportunityReport } from "./sourcing-opportunities.js";

type Trigger = "boot" | "interval" | "manual" | "replenishment";
type ProviderResult = { ok: boolean; provider: string; data?: unknown; error?: string };

type SourcingAutopilotResult = {
  runId: number;
  trigger: Trigger;
  status: "completed" | "degraded";
  providers: ProviderResult[];
  replenishmentAttempted: boolean;
  summary: Awaited<ReturnType<typeof getSourcingSummary>>;
  opportunitySummary: {
    blockedOpportunities: number;
    policyReviewReady: number;
    topActions: unknown[];
  };
  completedAt: string;
};

let cycleInFlight: Promise<SourcingAutopilotResult> | null = null;
let workerStarted = false;
let lastReplenishmentAt = 0;

const numberEnv = (key: string, fallback: number) => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function settledProvider<T>(result: PromiseSettledResult<T>, provider: string): ProviderResult {
  return result.status === "fulfilled"
    ? { ok: true, provider, data: result.value }
    : { ok: false, provider, error: result.reason instanceof Error ? result.reason.message : String(result.reason || "Falha desconhecida") };
}

async function refreshGoldStandardProvider(force: boolean) {
  const market = force ? await refreshGoldStandardMarketplace() : await refreshGoldStandardIfStale();
  // O coletor base reseta o estado comercial para screening; o enriquecimento deve
  // rodar no mesmo provider-cycle antes de qualquer ranking/autopilot snapshot.
  const enrichment = await enrichGoldStandardIfStale(force ? 0 : 10 * 60 * 1000);
  return { market, enrichment };
}

async function refreshProviders(force: boolean): Promise<ProviderResult[]> {
  const results = await Promise.allSettled([
    force ? refreshCarbonmarkAssets() : refreshCarbonmarkIfStale(),
    force ? refreshKlimaX402Assets() : refreshKlimaX402IfStale(),
    refreshGoldStandardProvider(force),
  ]);
  return [
    settledProvider(results[0], "carbonmark"),
    settledProvider(results[1], "klima-x402"),
    settledProvider(results[2], "gold-standard"),
  ];
}

export async function initSourcingAutopilotDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sourcing_autopilot_runs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      trigger VARCHAR(30) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'running',
      providers JSONB NOT NULL DEFAULT '[]'::jsonb,
      verified_count INTEGER,
      executable_count INTEGER,
      fractional_count INTEGER,
      minimum_target INTEGER,
      needs_replenishment BOOLEAN,
      needs_fractional_source BOOLEAN,
      replenishment_attempted BOOLEAN NOT NULL DEFAULT FALSE,
      blocked_opportunities INTEGER,
      policy_review_ready INTEGER,
      top_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS sourcing_autopilot_runs_started_idx
      ON sourcing_autopilot_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS sourcing_autopilot_alerts (
      alert_key VARCHAR(80) PRIMARY KEY,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      severity VARCHAR(20) NOT NULL DEFAULT 'warning',
      title VARCHAR(255) NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS sourcing_autopilot_alerts_status_idx
      ON sourcing_autopilot_alerts(status,last_seen_at DESC);
  `);
}

async function pruneHistory() {
  const retentionDays = Math.max(1, Math.min(365, numberEnv("ECOT_SOURCING_RUN_RETENTION_DAYS", 30)));
  const result = await pool.query(
    `DELETE FROM sourcing_autopilot_runs
     WHERE started_at < NOW() - ($1::text || ' days')::interval
     RETURNING id`,
    [String(retentionDays)],
  );
  return { retentionDays, deletedRuns: result.rowCount || 0 };
}

async function setAlert(input: {
  key: string;
  active: boolean;
  severity: "warning" | "critical";
  title: string;
  details: Record<string, unknown>;
}) {
  if (input.active) {
    await pool.query(`
      INSERT INTO sourcing_autopilot_alerts(alert_key,status,severity,title,details,first_seen_at,last_seen_at,resolved_at)
      VALUES($1,'open',$2,$3,$4::jsonb,NOW(),NOW(),NULL)
      ON CONFLICT(alert_key) DO UPDATE SET
        status='open',severity=EXCLUDED.severity,title=EXCLUDED.title,details=EXCLUDED.details,
        last_seen_at=NOW(),resolved_at=NULL`,
    [input.key, input.severity, input.title, JSON.stringify(input.details)]);
  } else {
    await pool.query(`
      UPDATE sourcing_autopilot_alerts SET status='resolved',details=$2::jsonb,last_seen_at=NOW(),
        resolved_at=CASE WHEN status='open' THEN NOW() ELSE resolved_at END
      WHERE alert_key=$1`, [input.key, JSON.stringify(input.details)]);
  }
}

async function syncAlerts(
  summary: Awaited<ReturnType<typeof getSourcingSummary>>,
  providers: ProviderResult[],
) {
  await Promise.all([
    setAlert({
      key: "verified_inventory_below_target",
      active: summary.needsReplenishment,
      severity: summary.verifiedCompensationAssets === 0 ? "critical" : "warning",
      title: "Inventário de compensação verificada abaixo da meta",
      details: {
        verified: summary.verifiedCompensationAssets,
        executable: summary.executableCompensationAssets,
        target: summary.minimumVerifiedTarget,
      },
    }),
    setAlert({
      key: "fractional_source_missing",
      active: summary.needsFractionalSource,
      severity: "warning",
      title: "Nenhuma fonte de compensação fracionária em 1 kg disponível",
      details: { fractional: summary.fractionalCompensationAssets },
    }),
    setAlert({
      key: "all_sourcing_providers_degraded",
      active: providers.length > 0 && providers.every((provider) => !provider.ok),
      severity: "critical",
      title: "Todas as fontes automáticas de sourcing estão degradadas",
      details: { providers },
    }),
  ]);
}

async function executeCycle(trigger: Trigger, forceProviders: boolean): Promise<SourcingAutopilotResult> {
  const run = await pool.query(
    `INSERT INTO sourcing_autopilot_runs(trigger,status) VALUES($1,'running') RETURNING id`,
    [trigger],
  );
  const runId = Number(run.rows[0].id);
  let providers: ProviderResult[] = [];
  let replenishmentAttempted = false;

  try {
    providers = await refreshProviders(forceProviders);
    let summary = await rankSourcingInventory(forceProviders ? 0 : undefined);

    const replenishMinIntervalMs = Math.max(60_000, numberEnv("ECOT_SOURCING_REPLENISH_MIN_INTERVAL_MS", 15 * 60 * 1000));
    const mayReplenish = !forceProviders
      && summary.needsReplenishment
      && Date.now() - lastReplenishmentAt >= replenishMinIntervalMs;

    if (mayReplenish) {
      replenishmentAttempted = true;
      lastReplenishmentAt = Date.now();
      providers = await refreshProviders(true);
      summary = await rankSourcingInventory(0);
    }

    const opportunity = await getSourcingOpportunityReport();
    const status = providers.some((provider) => !provider.ok) ? "degraded" : "completed";
    await syncAlerts(summary, providers);

    const topActions = opportunity.actionQueue.slice(0, 8);
    await pool.query(`
      UPDATE sourcing_autopilot_runs SET
        status=$2,providers=$3::jsonb,verified_count=$4,executable_count=$5,fractional_count=$6,
        minimum_target=$7,needs_replenishment=$8,needs_fractional_source=$9,replenishment_attempted=$10,
        blocked_opportunities=$11,policy_review_ready=$12,top_actions=$13::jsonb,completed_at=NOW()
      WHERE id=$1`,
    [runId, status, JSON.stringify(providers), summary.verifiedCompensationAssets,
      summary.executableCompensationAssets, summary.fractionalCompensationAssets,
      summary.minimumVerifiedTarget, summary.needsReplenishment, summary.needsFractionalSource,
      replenishmentAttempted, opportunity.blockedOpportunities, opportunity.policyReviewReady,
      JSON.stringify(topActions)]);

    await pruneHistory().catch((error) => console.warn("[sourcing-autopilot] retention cleanup failed", error));

    return {
      runId,
      trigger: replenishmentAttempted ? "replenishment" : trigger,
      status,
      providers,
      replenishmentAttempted,
      summary,
      opportunitySummary: {
        blockedOpportunities: opportunity.blockedOpportunities,
        policyReviewReady: opportunity.policyReviewReady,
        topActions,
      },
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha desconhecida no sourcing autopilot";
    await pool.query(
      `UPDATE sourcing_autopilot_runs SET status='failed',providers=$2::jsonb,error=$3,completed_at=NOW() WHERE id=$1`,
      [runId, JSON.stringify(providers), message],
    ).catch(() => undefined);
    await pruneHistory().catch(() => undefined);
    throw error;
  }
}

export function runSourcingAutopilot(trigger: Trigger = "manual", forceProviders = false): Promise<SourcingAutopilotResult> {
  if (!cycleInFlight) {
    cycleInFlight = executeCycle(trigger, forceProviders).finally(() => { cycleInFlight = null; });
  }
  return cycleInFlight;
}

export async function getSourcingAutopilotStatus() {
  const [latest, alerts, summary] = await Promise.all([
    pool.query("SELECT * FROM sourcing_autopilot_runs ORDER BY started_at DESC LIMIT 1"),
    pool.query("SELECT * FROM sourcing_autopilot_alerts ORDER BY CASE status WHEN 'open' THEN 1 ELSE 2 END,last_seen_at DESC"),
    getSourcingSummary(),
  ]);
  return {
    enabled: process.env.ECOT_SOURCING_AUTOPILOT_DISABLED !== "true",
    intervalMs: Math.max(60_000, numberEnv("ECOT_SOURCING_AUTOPILOT_INTERVAL_MS", 10 * 60 * 1000)),
    replenishMinIntervalMs: Math.max(60_000, numberEnv("ECOT_SOURCING_REPLENISH_MIN_INTERVAL_MS", 15 * 60 * 1000)),
    runRetentionDays: Math.max(1, Math.min(365, numberEnv("ECOT_SOURCING_RUN_RETENTION_DAYS", 30))),
    inFlight: Boolean(cycleInFlight),
    latestRun: latest.rows[0] || null,
    openAlerts: alerts.rows.filter((alert) => alert.status === "open"),
    recentAlerts: alerts.rows.slice(0, 20),
    currentSummary: summary,
  };
}

export function startSourcingAutopilot() {
  if (workerStarted || process.env.ECOT_SOURCING_AUTOPILOT_DISABLED === "true") return;
  workerStarted = true;
  const intervalMs = Math.max(60_000, numberEnv("ECOT_SOURCING_AUTOPILOT_INTERVAL_MS", 10 * 60 * 1000));

  void runSourcingAutopilot("boot", false).catch((error) => console.warn("[sourcing-autopilot] boot cycle failed", error));
  const timer = setInterval(() => {
    void runSourcingAutopilot("interval", false).catch((error) => console.warn("[sourcing-autopilot] interval cycle failed", error));
  }, intervalMs);
  timer.unref();
}
