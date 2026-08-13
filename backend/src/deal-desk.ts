import crypto from "node:crypto";
import { pool, withTransaction } from "./db.js";
import { generateDemandMatches } from "./demand-matching.js";
import { createDemandProposal } from "./demand-proposal.js";
import { resolveDemandSupplyRfq, upsertDemandSupplyRfq } from "./demand-supply-rfq.js";
import { createCorporateBasket } from "./corporate-basket-service.js";

type Json = Record<string, unknown>;

export type LargeCorporateOrderInput = {
  clientRequestId?: string;
  companyName: string;
  legalName?: string | null;
  taxId?: string | null;
  sector?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  targetTonnes: number;
  claimPurpose?: "voluntary_offset" | "climate_contribution" | "compliance";
  targetYear?: number | null;
  budgetUsd?: number | null;
  maxPriceUsdTonne?: number | null;
  preferredCountry?: string | null;
  preferredRegistry?: string | null;
  preferredProjectType?: string | null;
  validityMinutes?: number;
  notes?: string | null;
};

const num = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const cleanTaxId = (value?: string | null) => String(value || "").replace(/\D/g, "");

function nextAction(row: Json) {
  const uncovered = num(row.uncovered_tonnes ?? row.gap_tonnes);
  if (uncovered > 0.0005) return "source_more_credits";
  if (row.basket_id) return "confirm_and_reserve_basket";
  if (row.proposal_id) return "commercial_review";
  return "rerun_matching";
}

async function orderView(opportunityId: number) {
  const { rows } = await pool.query(`
    SELECT o.id AS opportunity_id,o.status AS opportunity_status,o.target_tonnes,o.claim_purpose,o.target_year,
           o.budget_usd,o.max_price_usd_tonne,o.preferred_country,o.preferred_registry,o.preferred_project_type,
           o.priority_score,o.constraints,o.notes,o.created_at,o.updated_at,
           a.id AS account_id,a.company_name,a.legal_name,a.tax_id,a.sector,a.contact_name,a.contact_email,a.contact_phone,
           r.id AS rfq_id,r.public_code AS rfq_public_code,r.status AS rfq_status,r.covered_tonnes AS rfq_covered_tonnes,r.gap_tonnes,
           p.id AS proposal_id,p.public_code AS proposal_public_code,p.status AS proposal_status,
           p.covered_tonnes,p.uncovered_tonnes,p.coverage_pct,p.final_total_brl,p.price_per_tonne_brl,
           p.checkout_mode,p.execution_mode,p.expires_at AS proposal_expires_at,
           b.id AS basket_id,b.public_code AS basket_public_code,b.status AS basket_status,b.payment_status,
           b.covered_kg AS basket_covered_kg,b.final_total_brl AS basket_final_total_brl,b.reserved_until
    FROM demand_opportunities o
    JOIN demand_accounts a ON a.id=o.account_id
    LEFT JOIN LATERAL (SELECT * FROM market_maker_rfqs mr WHERE mr.opportunity_id=o.id ORDER BY mr.id DESC LIMIT 1) r ON TRUE
    LEFT JOIN LATERAL (SELECT * FROM demand_proposals dp WHERE dp.opportunity_id=o.id ORDER BY dp.id DESC LIMIT 1) p ON TRUE
    LEFT JOIN corporate_baskets b ON b.proposal_id=p.id
    WHERE o.id=$1`, [opportunityId]);
  const row = rows[0] as Json | undefined;
  if (!row) return null;
  return {
    ...row,
    nextAction: nextAction(row),
    invariants: {
      createsExternalOrder: false,
      sendsEmail: false,
      opensCheckout: false,
      chargesMoney: false,
      claimReadyRequiredToClose: true,
      externalAvailabilityRecheckRequiredBeforePayment: true,
    },
  };
}

async function existingUsableProposal(opportunityId: number) {
  const { rows } = await pool.query(`
    SELECT * FROM demand_proposals
    WHERE opportunity_id=$1 AND COALESCE(uncovered_tonnes,0)<=0.0005
      AND status NOT IN ('rejected','expired') AND (expires_at IS NULL OR expires_at>NOW())
    ORDER BY id DESC LIMIT 1`, [opportunityId]);
  return rows[0] as Json | undefined;
}
