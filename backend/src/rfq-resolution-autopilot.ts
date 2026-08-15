import { createCarbonmarkShadowQuote } from "./carbonmark-rail.js";
import { pool } from "./db.js";
import { refreshDemandSupplyRfqCandidates } from "./demand-supply-rfq.js";

type Json = Record<string, unknown>;
type QuoteResult = { ok: true; quote: Json } | { ok: false; error: string; maxExceeded: boolean };

type ResolutionResult = {
  runId: number;
  rfqId: number;
  opportunityId: number;
  status: "already_covered" | "provider_capacity_found" | "partial_provider_capacity" | "no_provider_capacity" | "failed";
  targetGapKg: number;
  providerQuotableKg: number;
  remainingKg: number;
  legs: Json[];
  candidatesTested: number;
  totalCostUsdc: number;
  avgCostUsdcTonne: number | null;
  saleReady: boolean;
  commerciallyFillable: boolean;
  finalHumanReviewRequired: boolean;
  message: string;
};

const num = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";
const isMaximumExceeded = (message: string) => /maximum quotable quantity exceeded|maximum.*quotable|quantidade.*m[aá]xima.*cot/i.test(message);
const providerKey = (row: Json) => {
  const details = row.monitor_details && typeof row.monitor_details === "object" && !Array.isArray(row.monitor_details)
    ? row.monitor_details as Json : {};
  return String(details.providerKey || "").toLowerCase() || String(row.source_reference || "").split("-")[0].toLowerCase();
};
const quoteCost = (quote: Json, kg: number) => {
  const direct = num(quote.cost_usdc, NaN);
  if (Number.isFinite(direct)) return direct;
  return num(quote.cost_usdc_tonne) * (kg / 1000);
};

let dbReady: Promise<void> | null = null;
let workerStarted = false;
const inFlight = new Map<number, Promise<ResolutionResult>>();

async function ensureDb() {
  if (!dbReady) dbReady = pool.query(`
    CREATE TABLE IF NOT EXISTS rfq_resolution_autopilot_runs(
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      opportunity_id BIGINT NOT NULL REFERENCES demand_opportunities(id) ON DELETE CASCADE,
      status VARCHAR(40) NOT NULL CHECK(status IN ('running','already_covered','provider_capacity_found','partial_provider_capacity','no_provider_capacity','failed')),
      target_gap_kg BIGINT NOT NULL DEFAULT 0,
      provider_quotable_kg BIGINT NOT NULL DEFAULT 0,
      remaining_kg BIGINT NOT NULL DEFAULT 0,
      candidates_tested INTEGER NOT NULL DEFAULT 0,
      legs_count INTEGER NOT NULL DEFAULT 0,
      total_cost_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
      avg_cost_usdc_tonne NUMERIC(18,6),
      sale_ready BOOLEAN NOT NULL DEFAULT FALSE,
      commercially_fillable BOOLEAN NOT NULL DEFAULT FALSE,
      final_human_review_required BOOLEAN NOT NULL DEFAULT TRUE,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS rfq_resolution_autopilot_runs_rfq_idx ON rfq_resolution_autopilot_runs(rfq_id,started_at DESC);

    CREATE TABLE IF NOT EXISTS rfq_resolution_autopilot_legs(
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES rfq_resolution_autopilot_runs(id) ON DELETE CASCADE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_id BIGINT REFERENCES market_maker_rfq_candidates(id) ON DELETE SET NULL,
      monitored_asset_id BIGINT REFERENCES monitored_assets(id) ON DELETE SET NULL,
      provider VARCHAR(80) NOT NULL,
      requested_kg BIGINT NOT NULL,
      quotable_kg BIGINT NOT NULL DEFAULT 0,
      quote_uuid VARCHAR(255),
      cost_usdc NUMERIC(18,6),
      cost_usdc_tonne NUMERIC(18,6),
      status VARCHAR(40) NOT NULL,
      project_name TEXT,
      registry VARCHAR(80),
      vintage VARCHAR(80),
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS rfq_resolution_autopilot_legs_run_idx ON rfq_resolution_autopilot_legs(run_id,id);
  `).then(() => undefined).catch((error) => { dbReady = null; throw error; });
  return dbReady;
}

async function tryQuote(assetId: number, kg: number, actor: string): Promise<QuoteResult> {
  try {
    const quote = await createCarbonmarkShadowQuote({ assetId, requestedKg: kg, createdBy: actor }) as unknown as Json;
    return { ok: true, quote };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, maxExceeded: isMaximumExceeded(message) };
  }
}

async function findQuotableCapacity(input: { assetId: number; targetKg: number; minimumKg: number; actor: string }) {
  const targetKg = Math.max(input.minimumKg, Math.round(input.targetKg));
  const full = await tryQuote(input.assetId, targetKg, input.actor);
  if (full.ok) return { quotableKg: targetKg, quote: full.quote, attempts: 1, error: null };
  if (!full.maxExceeded) return { quotableKg: 0, quote: null, attempts: 1, error: full.error };

  const minimum = await tryQuote(input.assetId, input.minimumKg, input.actor);
  if (!minimum.ok) return { quotableKg: 0, quote: null, attempts: 2, error: minimum.error };

  let low = input.minimumKg;
  let high = targetKg - 1;
  let best = minimum.quote;
  let attempts = 2;
  const toleranceKg = 1000; // 1 t precision is enough for sourcing allocation.

  while (high > low && high - low > toleranceKg && attempts < 12) {
    const mid = Math.max(input.minimumKg, Math.floor((low + high + 1) / 2));
    const probe = await tryQuote(input.assetId, mid, input.actor);
    attempts += 1;
    if (probe.ok) {
      low = mid;
      best = probe.quote;
      continue;
    }
    if (probe.maxExceeded) {
      high = mid - 1;
      continue;
    }
    break;
  }

  return { quotableKg: low, quote: best, attempts, error: full.error };
}

async function insertLeg(runId: number, rfqId: number, row: Json, requestedKg: number, capacity: Awaited<ReturnType<typeof findQuotableCapacity>>) {
  const quote = capacity.quote || {};
  const quotableKg = Math.max(0, Math.round(capacity.quotableKg));
  const costUsdc = quotableKg > 0 ? quoteCost(quote, quotableKg) : 0;
  const costUsdcTonne = quotableKg > 0 ? num(quote.cost_usdc_tonne, costUsdc / (quotableKg / 1000)) : 0;
  const evidence = {
    quoteAttempts: capacity.attempts,
    firstFailure: capacity.error,
    sourceReference: row.source_reference,
    sourceUrl: row.source_url,
    registryEvidenceUrl: row.registry_evidence_url,
    candidateTonnes: num(row.candidate_tonnes),
    observedAvailableTonnes: num(row.available_tons),
    sourcingScore: num(row.sourcing_score),
    invariant: "RFQ resolution autopilot only probes POST /quotes. It never creates Carbonmark orders, payments or retirements.",
  };
  const status = quotableKg > 0 ? (quotableKg >= requestedKg ? "full" : "partial") : "unavailable";
  await pool.query(`
    INSERT INTO rfq_resolution_autopilot_legs(
      run_id,rfq_id,candidate_id,monitored_asset_id,provider,requested_kg,quotable_kg,quote_uuid,
      cost_usdc,cost_usdc_tonne,status,project_name,registry,vintage,evidence
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`, [
    runId, rfqId, row.candidate_id, row.monitored_asset_id, providerKey(row) || "unknown", requestedKg, quotableKg,
    quote.quote_uuid || null, costUsdc || null, costUsdcTonne || null, status, row.project_name || null,
    row.registry || null, row.vintage || null, JSON.stringify(evidence),
  ]);
  return { candidateId: Number(row.candidate_id), assetId: Number(row.monitored_asset_id), provider: providerKey(row), projectName: row.project_name,
    registry: row.registry, vintage: row.vintage, requestedKg, quotableKg, status, quoteUuid: quote.quote_uuid || null,
    costUsdc, costUsdcTonne, attempts: capacity.attempts, error: capacity.error, sourceUrl: row.source_url || null };
}

async function executeRfq(rfqId: number): Promise<ResolutionResult> {
  await ensureDb();
  await refreshDemandSupplyRfqCandidates(rfqId);
  const { rows } = await pool.query(`
    SELECT r.*,a.company_name
    FROM market_maker_rfqs r JOIN demand_accounts a ON a.id=r.account_id
    WHERE r.id=$1`, [rfqId]);
  const rfq = rows[0] as Json | undefined;
  if (!rfq) throw Object.assign(new Error("RFQ não encontrado"), { status: 404 });

  const gapKg = Math.max(0, Math.round(num(rfq.gap_tonnes) * 1000));
  const run = await pool.query(`
    INSERT INTO rfq_resolution_autopilot_runs(rfq_id,opportunity_id,status,target_gap_kg,remaining_kg)
    VALUES($1,$2,'running',$3,$3) RETURNING id`, [rfqId, rfq.opportunity_id, gapKg]);
  const runId = Number(run.rows[0].id);

  if (gapKg <= 1) {
    const summary = { verdict: "READY_TO_SELL", reason: "Matching Engine já cobre a ordem integralmente com supply claim-ready." };
    await pool.query(`UPDATE rfq_resolution_autopilot_runs SET status='already_covered',sale_ready=TRUE,commercially_fillable=TRUE,
      final_human_review_required=FALSE,summary=$2::jsonb,completed_at=NOW() WHERE id=$1`, [runId, JSON.stringify(summary)]);
    return { runId, rfqId, opportunityId: Number(rfq.opportunity_id), status: "already_covered", targetGapKg: 0, providerQuotableKg: 0,
      remainingKg: 0, legs: [], candidatesTested: 0, totalCostUsdc: 0, avgCostUsdcTonne: null, saleReady: true,
      commerciallyFillable: true, finalHumanReviewRequired: false, message: "Supply claim-ready já cobre 100% do pedido." };
  }

  const maxCandidates = Math.max(1, Math.min(12, Number(process.env.ECOT_RFQ_AUTOPILOT_MAX_CANDIDATES || 6)));
  const candidates = await pool.query(`
    SELECT c.id AS candidate_id,c.candidate_tonnes,c.sourcing_score,c.confidence,c.snapshot,
           a.id AS monitored_asset_id,a.registry,a.project_name,a.vintage,a.available_tons,a.min_order_kg,
           a.source_reference,a.source_url,a.registry_evidence_url,a.monitor_details,a.source_price_usd_ton,
           a.claim_category,a.eligibility_status,a.source_unit_status,a.retirement_supported,a.beneficiary_retirement_supported
    FROM market_maker_rfq_candidates c
    JOIN monitored_assets a ON a.id=c.monitored_asset_id AND a.active=TRUE
    WHERE c.rfq_id=$1 AND c.candidate_type='market_signal' AND c.status<>'stale'
      AND (a.source_reference LIKE 'carbonmark-%' OR a.monitor_details->>'providerKey'='carbonmark')
    ORDER BY
      CASE WHEN c.candidate_tonnes >= $2 THEN 0 ELSE 1 END,
      NULLIF(regexp_replace(COALESCE(a.vintage,''),'[^0-9]','','g'),'')::BIGINT DESC NULLS LAST,
      c.sourcing_score DESC,c.candidate_tonnes DESC,c.id
    LIMIT $3`, [rfqId, num(rfq.gap_tonnes), maxCandidates]);

  const actor = `RFQ Resolution Autopilot #${rfqId}`;
  let remainingKg = gapKg;
  let totalCostUsdc = 0;
  let providerQuotableKg = 0;
  let candidatesTested = 0;
  const legs: Json[] = [];

  for (const raw of candidates.rows) {
    if (remainingKg <= 1) break;
    const row = raw as Json;
    const candidateLimitKg = Math.max(0, Math.round(Math.min(num(row.candidate_tonnes), num(row.available_tons), remainingKg / 1000) * 1000));
    const minimumKg = Math.max(1, Math.round(num(row.min_order_kg, 1)));
    if (candidateLimitKg < minimumKg) continue;
    candidatesTested += 1;
    const capacity = await findQuotableCapacity({ assetId: Number(row.monitored_asset_id), targetKg: candidateLimitKg, minimumKg, actor });
    const leg = await insertLeg(runId, rfqId, row, candidateLimitKg, capacity);
    legs.push(leg);
    const quoted = num(leg.quotableKg);
    if (quoted <= 0) continue;
    providerQuotableKg += quoted;
    remainingKg = Math.max(0, remainingKg - quoted);
    totalCostUsdc += num(leg.costUsdc);
  }

  const commerciallyFillable = remainingKg <= 1000; // tolerate <=1 t residual caused by binary-search precision.
  const status: ResolutionResult["status"] = commerciallyFillable
    ? "provider_capacity_found"
    : providerQuotableKg > 0 ? "partial_provider_capacity" : "no_provider_capacity";
  const avgCostUsdcTonne = providerQuotableKg > 0 ? totalCostUsdc / (providerQuotableKg / 1000) : null;
  const summary = {
    verdict: commerciallyFillable ? "SUPPLY_FOUND_REVIEW_REQUIRED" : providerQuotableKg > 0 ? "PARTIAL_SUPPLY_ONLY" : "NO_PROVABLE_SUPPLY",
    companyName: rfq.company_name,
    targetGapTonnes: gapKg / 1000,
    providerQuotableTonnes: providerQuotableKg / 1000,
    remainingTonnes: remainingKg / 1000,
    legs: legs.filter((leg) => num(leg.quotableKg) > 0),
    finalHumanReviewRequired: commerciallyFillable,
    saleReady: false,
    nextAction: commerciallyFillable
      ? "EcoTracker encontrou capacidade cotável suficiente. Falta apenas consolidar a revisão climática/comercial final antes de proposta/contrato."
      : "EcoTracker continuará procurando supply; não prometa o volume faltante ao comprador ainda.",
    invariant: "Provider-quotable is not claim-ready. No order, payment or retirement is created by this autopilot.",
  };

  await pool.query(`
    UPDATE rfq_resolution_autopilot_runs SET status=$2,provider_quotable_kg=$3,remaining_kg=$4,candidates_tested=$5,
      legs_count=$6,total_cost_usdc=$7,avg_cost_usdc_tonne=$8,sale_ready=FALSE,commercially_fillable=$9,
      final_human_review_required=$9,summary=$10::jsonb,completed_at=NOW() WHERE id=$1`, [
    runId, status, providerQuotableKg, remainingKg, candidatesTested, legs.filter((leg) => num(leg.quotableKg) > 0).length,
    totalCostUsdc, avgCostUsdcTonne, commerciallyFillable, JSON.stringify(summary),
  ]);

  return { runId, rfqId, opportunityId: Number(rfq.opportunity_id), status, targetGapKg: gapKg, providerQuotableKg, remainingKg,
    legs, candidatesTested, totalCostUsdc, avgCostUsdcTonne, saleReady: false, commerciallyFillable,
    finalHumanReviewRequired: commerciallyFillable,
    message: commerciallyFillable
      ? `EcoTracker encontrou ${providerQuotableKg / 1000} t cotáveis para cobrir o gap. Falta uma revisão final, não novos probes manuais.`
      : `EcoTracker provou ${providerQuotableKg / 1000} t; ainda faltam ${remainingKg / 1000} t.` };
}

export function runRfqResolutionAutopilot(rfqId: number) {
  const existing = inFlight.get(rfqId);
  if (existing) return existing;
  const promise = executeRfq(rfqId).catch(async (error) => {
    await ensureDb().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(`UPDATE rfq_resolution_autopilot_runs SET status='failed',error=$2,completed_at=NOW()
      WHERE id=(SELECT id FROM rfq_resolution_autopilot_runs WHERE rfq_id=$1 ORDER BY started_at DESC LIMIT 1) AND status='running'`, [rfqId, message]).catch(() => undefined);
    throw error;
  }).finally(() => inFlight.delete(rfqId));
  inFlight.set(rfqId, promise);
  return promise;
}

export async function getRfqResolutionAutopilot(rfqId: number) {
  await ensureDb();
  const run = (await pool.query(`SELECT * FROM rfq_resolution_autopilot_runs WHERE rfq_id=$1 ORDER BY started_at DESC LIMIT 1`, [rfqId])).rows[0] || null;
  if (!run) return null;
  const legs = (await pool.query(`SELECT * FROM rfq_resolution_autopilot_legs WHERE run_id=$1 ORDER BY id`, [run.id])).rows;
  return { ...run, legs };
}

export async function getOpenRfqResolutionStatus(limit = 50) {
  await ensureDb();
  const { rows } = await pool.query(`
    SELECT r.id AS rfq_id,r.public_code,r.company_name,r.status AS rfq_status,r.target_tonnes,r.covered_tonnes,r.gap_tonnes,
           x.id AS run_id,x.status AS autopilot_status,x.provider_quotable_kg,x.remaining_kg,x.total_cost_usdc,
           x.avg_cost_usdc_tonne,x.commercially_fillable,x.sale_ready,x.final_human_review_required,x.summary,x.completed_at
    FROM (
      SELECT r0.*,a.company_name FROM market_maker_rfqs r0 JOIN demand_accounts a ON a.id=r0.account_id
      WHERE r0.status IN ('open','partially_sourced') AND r0.gap_tonnes>0
      ORDER BY r0.priority_score DESC,r0.updated_at DESC LIMIT $1
    ) r
    LEFT JOIN LATERAL (
      SELECT * FROM rfq_resolution_autopilot_runs rr WHERE rr.rfq_id=r.id ORDER BY rr.started_at DESC LIMIT 1
    ) x ON TRUE
    ORDER BY r.priority_score DESC,r.updated_at DESC`, [Math.max(1, Math.min(200, limit))]);
  return rows;
}

export async function runOpenRfqResolutionAutopilot() {
  await ensureDb();
  const maxRfqs = Math.max(1, Math.min(10, Number(process.env.ECOT_RFQ_AUTOPILOT_MAX_RFQS_PER_CYCLE || 3)));
  const minAgeMinutes = Math.max(2, Math.min(120, Number(process.env.ECOT_RFQ_AUTOPILOT_MIN_AGE_MINUTES || 10)));
  const { rows } = await pool.query(`
    SELECT r.id
    FROM market_maker_rfqs r
    LEFT JOIN LATERAL (SELECT started_at FROM rfq_resolution_autopilot_runs x WHERE x.rfq_id=r.id ORDER BY started_at DESC LIMIT 1) last ON TRUE
    WHERE r.status IN ('open','partially_sourced') AND r.gap_tonnes>0
      AND (last.started_at IS NULL OR last.started_at < NOW() - ($1::text || ' minutes')::interval)
    ORDER BY r.priority_score DESC,r.updated_at DESC LIMIT $2`, [String(minAgeMinutes), maxRfqs]);
  const results: Json[] = [];
  for (const row of rows) {
    try { results.push(await runRfqResolutionAutopilot(Number(row.id))); }
    catch (error) { results.push({ rfqId: Number(row.id), status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export function startRfqResolutionAutopilot() {
  if (workerStarted || process.env.ECOT_RFQ_RESOLUTION_AUTOPILOT_DISABLED === "true") return;
  workerStarted = true;
  const intervalMs = Math.max(60_000, Number(process.env.ECOT_RFQ_RESOLUTION_AUTOPILOT_INTERVAL_MS || 10 * 60 * 1000));
  const first = setTimeout(() => { void runOpenRfqResolutionAutopilot().catch((error) => console.warn("[rfq-resolution-autopilot] boot cycle failed", error)); }, 20_000);
  first.unref();
  const timer = setInterval(() => { void runOpenRfqResolutionAutopilot().catch((error) => console.warn("[rfq-resolution-autopilot] cycle failed", error)); }, intervalMs);
  timer.unref();
}
