import { pool, withTransaction } from "./db.js";
import { generateDemandMatches } from "./demand-matching.js";
import { createDemandProposal } from "./demand-proposal.js";
import { resolveDemandSupplyRfq, upsertDemandSupplyRfq } from "./demand-supply-rfq.js";

type Json = Record<string, unknown>;

type DemandAutopilotSettings = {
  singleton: boolean;
  enabled: boolean;
  min_lead_score: number;
  min_operational_tonnes: string | number;
  target_percent: string | number;
  max_accounts_per_run: number;
  interval_minutes: number;
  last_run_at: string | Date | null;
  updated_at: string | Date;
};

const num = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";

function envEnabled() {
  return process.env.ECOT_DEMAND_AUTOPILOT_ENABLED === "true";
}

function operationalTonnes(row: Json) {
  const scope1 = Math.max(0,num(row.scope1_tonnes));
  const scope2Market = row.scope2_market_tonnes == null ? null : num(row.scope2_market_tonnes,NaN);
  const scope2 = scope2Market != null && Number.isFinite(scope2Market)
    ? Math.max(0,scope2Market)
    : Math.max(0,num(row.scope2_location_tonnes));
  return Number((scope1+scope2).toFixed(3));
}

function priorityScore(row: Json, operational: number) {
  let score = Math.max(0,Math.min(100,Math.round(num(row.lead_score))));
  if (operational >= 100_000) score += 15;
  else if (operational >= 10_000) score += 12;
  else if (operational >= 1_000) score += 8;
  else if (operational >= 100) score += 4;
  const verification = String(row.verification_level || "").toLowerCase();
  if (["gold","ouro","verified","verificado"].includes(verification)) score += 10;
  else if (verification && verification !== "unknown") score += 4;
  if (row.contact_email || row.contact_phone) score += 3;
  return Math.max(0,Math.min(100,score));
}

function keyFor(accountId: number, inventoryId: number, targetPercent: number) {
  return `demand-auto:v1:${accountId}:${inventoryId}:scope1_2:${targetPercent.toFixed(2)}`;
}

async function settingsRow(): Promise<DemandAutopilotSettings> {
  const { rows } = await pool.query(`SELECT * FROM demand_autopilot_settings WHERE singleton=TRUE`);
  if (!rows[0]) throw new Error("Demand Autopilot settings não inicializadas");
  return rows[0] as DemandAutopilotSettings;
}

export async function demandAutopilotStatus() {
  const settings = await settingsRow();
  const lastRun = await pool.query(`SELECT * FROM demand_autopilot_runs ORDER BY id DESC LIMIT 1`);
  return {
    envEnabled:envEnabled(),
    databaseEnabled:bool(settings.enabled),
    live:envEnabled() && bool(settings.enabled),
    settings:{
      minLeadScore:Number(settings.min_lead_score),
      minOperationalTonnes:num(settings.min_operational_tonnes),
      targetPercent:num(settings.target_percent),
      maxAccountsPerRun:Number(settings.max_accounts_per_run),
      intervalMinutes:Number(settings.interval_minutes),
      lastRunAt:settings.last_run_at,
    },
    lastRun:lastRun.rows[0] || null,
    behavior:{
      createsInternalOpportunities:true,
      createsDraftProposals:true,
      createsSupplyRfqsForCoverageGaps:true,
      resolvesSupplyRfqsWhenClaimReadyCoverageArrives:true,
      sendsOutreach:false,
      opensCheckout:false,
      chargesMoney:false,
      automaticWorkerRequiresBothGates:true,
    },
  };
}

export async function updateDemandAutopilotSettings(input:{
  enabled?:boolean;
  minLeadScore?:number;
  minOperationalTonnes?:number;
  targetPercent?:number;
  maxAccountsPerRun?:number;
  intervalMinutes?:number;
}) {
  const current = await settingsRow();
  const enabled = input.enabled ?? bool(current.enabled);
  const minLeadScore = Math.max(0,Math.min(100,Math.round(input.minLeadScore ?? Number(current.min_lead_score))));
  const minOperationalTonnes = Math.max(0,input.minOperationalTonnes ?? num(current.min_operational_tonnes));
  const targetPercent = Math.max(0.01,Math.min(100,input.targetPercent ?? num(current.target_percent)));
  const maxAccountsPerRun = Math.max(1,Math.min(1000,Math.round(input.maxAccountsPerRun ?? Number(current.max_accounts_per_run))));
  const intervalMinutes = Math.max(15,Math.min(10080,Math.round(input.intervalMinutes ?? Number(current.interval_minutes))));
  const { rows } = await pool.query(`
    UPDATE demand_autopilot_settings SET
      enabled=$1,min_lead_score=$2,min_operational_tonnes=$3,target_percent=$4,
      max_accounts_per_run=$5,interval_minutes=$6,updated_at=NOW()
    WHERE singleton=TRUE RETURNING *`, [
    enabled,minLeadScore,minOperationalTonnes,targetPercent,maxAccountsPerRun,intervalMinutes,
  ]);
  return rows[0];
}

async function qualifyingAccounts(settings:DemandAutopilotSettings) {
  const { rows } = await pool.query(`
    SELECT a.id AS account_id,a.company_name,a.legal_name,a.tax_id,a.sector,a.country,
           a.contact_name,a.contact_email,a.contact_phone,a.lead_score,a.source,a.source_reference,a.status AS account_status,
           i.id AS inventory_id,i.inventory_year,i.scope1_tonnes,i.scope2_location_tonnes,i.scope2_market_tonnes,
           i.scope3_tonnes,i.reported_total_tonnes,i.verification_level,i.verification_provider,i.inventory_url,i.source_url
    FROM demand_accounts a
    JOIN LATERAL (
      SELECT * FROM demand_inventories di
      WHERE di.account_id=a.id
      ORDER BY di.inventory_year DESC,di.id DESC
      LIMIT 1
    ) i ON TRUE
    WHERE a.lead_score >= $1
      AND a.status NOT IN ('archived','do_not_contact')
      AND (COALESCE(i.scope1_tonnes,0)+COALESCE(i.scope2_market_tonnes,i.scope2_location_tonnes,0)) >= $2
    ORDER BY a.lead_score DESC,
             (COALESCE(i.scope1_tonnes,0)+COALESCE(i.scope2_market_tonnes,i.scope2_location_tonnes,0)) DESC,
             i.inventory_year DESC
    LIMIT $3`, [
    Number(settings.min_lead_score),num(settings.min_operational_tonnes),Number(settings.max_accounts_per_run),
  ]);
  return rows as Json[];
}

async function ensureAutopilotOpportunity(row:Json, runId:number, targetPercent:number) {
  const accountId = Number(row.account_id);
  const inventoryId = Number(row.inventory_id);
  const operational = operationalTonnes(row);
  const targetTonnes = Number((operational*targetPercent/100).toFixed(3));
  const autopilotKey = keyFor(accountId,inventoryId,targetPercent);
  const priority = priorityScore(row,operational);
  const constraints = {
    autopilot:true,
    version:"v1",
    operationalTonnes:operational,
    targetPercent,
    inventoryYear:Number(row.inventory_year),
    source:String(row.source || "unknown"),
    sourceReference:String(row.source_reference || ""),
    inventoryAccounting:"Scope 1 + Scope 2 permanece reportado separadamente da eventual compensação.",
  };

  const inserted = await pool.query(`
    INSERT INTO demand_opportunities (
      account_id,inventory_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,
      constraints,notes,autopilot_key,autopilot_run_id,autopilot_metadata
    ) VALUES ($1,$2,'identified',$3,'scope1_2_percent','voluntary_offset',$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING *`, [
    accountId,inventoryId,targetTonnes,Number(row.inventory_year),priority,JSON.stringify(constraints),
    `Oportunidade criada automaticamente pelo Demand Autopilot para ${targetPercent.toFixed(2)}% de Scope 1 + Scope 2.`,
    autopilotKey,runId,JSON.stringify({ createdBy:"demand-autopilot-v1",createdAt:new Date().toISOString() }),
  ]);

  let opportunity = inserted.rows[0];
  let created = true;
  if (!opportunity) {
    created = false;
    opportunity = (await pool.query(`SELECT * FROM demand_opportunities WHERE autopilot_key=$1`,[autopilotKey])).rows[0];
  }
  if (!opportunity) throw new Error(`Falha ao materializar oportunidade ${autopilotKey}`);

  await pool.query(`
    UPDATE demand_opportunities SET status='superseded',updated_at=NOW(),
      autopilot_metadata=autopilot_metadata || $3::jsonb
    WHERE account_id=$1
      AND autopilot_key IS NOT NULL
      AND inventory_id<>$2
      AND status NOT IN ('fulfilled','cancelled','superseded')`, [
    accountId,inventoryId,JSON.stringify({ supersededByAutopilotKey:autopilotKey,supersededAt:new Date().toISOString() }),
  ]);

  return { opportunity,created,targetTonnes,operational,priority,autopilotKey };
}

export async function runDemandAutopilot(input:{triggerMode?:"manual"|"worker";force?:boolean} = {}) {
  const triggerMode = input.triggerMode || "manual";
  const settings = await settingsRow();
  const live = envEnabled() && bool(settings.enabled);
  if (!input.force && !live) {
    return { skipped:true,reason:"Demand Autopilot recorrente está desligado",live:false };
  }

  const run = await withTransaction(async (client) => {
    const locked = (await client.query(`SELECT * FROM demand_autopilot_settings WHERE singleton=TRUE FOR UPDATE`)).rows[0] as DemandAutopilotSettings;
    const intervalMs = Number(locked.interval_minutes)*60_000;
    const lastMs = locked.last_run_at ? new Date(locked.last_run_at).getTime() : 0;
    if (!input.force && lastMs && Date.now()-lastMs < intervalMs) return null;
    const snapshot = {
      enabled:bool(locked.enabled),envEnabled:envEnabled(),minLeadScore:Number(locked.min_lead_score),
      minOperationalTonnes:num(locked.min_operational_tonnes),targetPercent:num(locked.target_percent),
      maxAccountsPerRun:Number(locked.max_accounts_per_run),intervalMinutes:Number(locked.interval_minutes),
    };
    const created = (await client.query(`
      INSERT INTO demand_autopilot_runs(status,trigger_mode,settings_snapshot)
      VALUES('running',$1,$2::jsonb) RETURNING *`, [triggerMode,JSON.stringify(snapshot)])).rows[0];
    await client.query(`UPDATE demand_autopilot_settings SET last_run_at=NOW(),updated_at=NOW() WHERE singleton=TRUE`);
    return created;
  });
  if (!run) return { skipped:true,reason:"Intervalo mínimo do Demand Autopilot ainda não venceu",live };

  const candidates = await qualifyingAccounts(settings);
  let qualified = 0;
  let opportunitiesCreated = 0;
  let opportunitiesReused = 0;
  let proposalsCreated = 0;
  let fullyCovered = 0;
  let sourcingRequired = 0;
  let targetTonnesTotal = 0;
  let coveredTonnesTotal = 0;
  let uncoveredTonnesTotal = 0;
  const errors:Array<Record<string,unknown>> = [];
  const items:Array<Record<string,unknown>> = [];
  const targetPercent = num(settings.target_percent,100);

  for (const row of candidates) {
    const accountId = Number(row.account_id);
    try {
      qualified += 1;
      const materialized = await ensureAutopilotOpportunity(row,Number(run.id),targetPercent);
      if (materialized.created) opportunitiesCreated += 1;
      else opportunitiesReused += 1;
      targetTonnesTotal += materialized.targetTonnes;

      const existingProposal = await pool.query(`
        SELECT * FROM demand_proposals
        WHERE opportunity_id=$1 AND (expires_at IS NULL OR expires_at>NOW())
        ORDER BY id DESC LIMIT 1`, [materialized.opportunity.id]);

      const matching = await generateDemandMatches(Number(materialized.opportunity.id));
      const covered = num(matching.coveredTonnes);
      const uncovered = num(matching.uncoveredTonnes);
      coveredTonnesTotal += covered;
      uncoveredTonnesTotal += uncovered;

      let proposal:Json | null = existingProposal.rows[0] || null;
      let rfq:Json | null = null;
      if (matching.fullyCovered) {
        fullyCovered += 1;
        await resolveDemandSupplyRfq(Number(materialized.opportunity.id),covered);
        if (!proposal) {
          proposal = await createDemandProposal({
            opportunityId:Number(materialized.opportunity.id),
            validityMinutes:1440,
            notes:"Draft criado automaticamente pelo Demand Autopilot. Revisão comercial obrigatória antes de envio.",
          }) as Json;
          proposalsCreated += 1;
        }
      } else {
        sourcingRequired += 1;
        await pool.query(`
          UPDATE demand_opportunities SET status='sourcing_required',autopilot_run_id=$2,
            autopilot_metadata=autopilot_metadata || $3::jsonb,updated_at=NOW()
          WHERE id=$1`, [
          materialized.opportunity.id,run.id,JSON.stringify({
            lastAutopilotMatchAt:new Date().toISOString(),coveredTonnes:covered,uncoveredTonnes:uncovered,
            coveragePct:num(matching.coveragePct),sourcingRequired:true,
          }),
        ]);
        rfq = await upsertDemandSupplyRfq({
          opportunityId:Number(materialized.opportunity.id),
          targetTonnes:materialized.targetTonnes,
          coveredTonnes:covered,
          gapTonnes:uncovered,
          source:"demand_autopilot",
        }) as Json | null;
      }

      items.push({
        accountId,companyName:row.company_name,inventoryId:Number(row.inventory_id),inventoryYear:Number(row.inventory_year),
        operationalTonnes:materialized.operational,targetTonnes:materialized.targetTonnes,priorityScore:materialized.priority,
        opportunityId:Number(materialized.opportunity.id),opportunityCreated:materialized.created,
        coveredTonnes:covered,uncoveredTonnes:uncovered,coveragePct:num(matching.coveragePct),fullyCovered:Boolean(matching.fullyCovered),
        proposalId:proposal ? Number(proposal.id) : null,proposalMode:proposal ? proposal.checkout_mode : null,
        rfqId:rfq ? Number(rfq.id) : null,rfqStatus:rfq ? rfq.status : matching.fullyCovered ? "resolved_or_not_needed" : null,
        nextAction:matching.fullyCovered ? "commercial_review" : "source_more_credits",
      });
    } catch (error) {
      errors.push({
        accountId,companyName:row.company_name,
        error:error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = {
    accountsScanned:candidates.length,accountsQualified:qualified,opportunitiesCreated,opportunitiesReused,
    proposalsCreated,fullyCovered,sourcingRequired,targetTonnes:Number(targetTonnesTotal.toFixed(3)),
    coveredTonnes:Number(coveredTonnesTotal.toFixed(3)),uncoveredTonnes:Number(uncoveredTonnesTotal.toFixed(3)),
    errors:errors.length,
  };
  const finalStatus = errors.length && !items.length ? "failed" : errors.length ? "completed_with_errors" : "completed";
  const updated = (await pool.query(`
    UPDATE demand_autopilot_runs SET status=$2,accounts_scanned=$3,accounts_qualified=$4,
      opportunities_created=$5,opportunities_reused=$6,proposals_created=$7,fully_covered=$8,sourcing_required=$9,
      target_tonnes=$10,covered_tonnes=$11,uncovered_tonnes=$12,errors=$13::jsonb,completed_at=NOW()
    WHERE id=$1 RETURNING *`, [
    run.id,finalStatus,summary.accountsScanned,summary.accountsQualified,opportunitiesCreated,opportunitiesReused,
    proposalsCreated,fullyCovered,sourcingRequired,summary.targetTonnes,summary.coveredTonnes,summary.uncoveredTonnes,JSON.stringify(errors),
  ])).rows[0];

  return { skipped:false,run:updated,summary,items };
}

let workerTimer:NodeJS.Timeout | null = null;
let workerRunning = false;

async function workerTick() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    await runDemandAutopilot({ triggerMode:"worker",force:false });
  } catch (error) {
    console.warn("[demand-autopilot] worker tick failed",error);
  } finally {
    workerRunning = false;
  }
}

export function startDemandAutopilotWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => { void workerTick(); },15*60_000);
  workerTimer.unref?.();
  void workerTick();
}
