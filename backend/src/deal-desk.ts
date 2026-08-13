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
