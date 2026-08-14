import { pool } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
    } catch { return {}; }
  }
  return {};
}

function numberAt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolAt(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function text(value: unknown) {
  return String(value || "").trim();
}

function executionMode(asset: Json) {
  return boolAt(asset.sourcing_executable) || (
    text(asset.pricing_mode) === "dynamic"
    && text(asset.availability_status) === "confirmed"
    && text(asset.source_status) === "connected"
  ) ? "programmatic" : "assisted";
}

function projectCountry(asset: Json) {
  const details = objectAt(asset.monitor_details);
  return text(asset.country || details.country || details.location || asset.location);
}

function capacityTonnes(asset: Json) {
  const available = Number(asset.available_tons);
  return Number.isFinite(available) && available > 0 ? available : 0;
}

function granularityTonnes(asset: Json) {
  if (boolAt(asset.fractional_retirement_supported)) {
    return Math.max(0.001, numberAt(asset.retirement_granularity_kg, 1) / 1000);
  }
  return Math.max(0.001, numberAt(asset.retirement_granularity_kg, 1000) / 1000);
}

function floorToGranularity(tonnes: number, granularity: number) {
  const steps = Math.floor((tonnes + 1e-9) / granularity);
  return Number((steps * granularity).toFixed(3));
}

function candidateScore(asset: Json, opportunity: Json) {
  let score = Math.round(numberAt(asset.sourcing_score, 60));
  const preferredRegistry = text(opportunity.preferred_registry).toLowerCase();
  const preferredCountry = text(opportunity.preferred_country).toLowerCase();
  const preferredType = text(opportunity.preferred_project_type).toLowerCase();
  const registry = text(asset.registry).toLowerCase();
  const country = projectCountry(asset).toLowerCase();
  const methodology = text(asset.methodology).toLowerCase();
  const assetType = text(asset.asset_type).toLowerCase();

  if (preferredRegistry && registry.includes(preferredRegistry)) score += 10;
  if (preferredCountry && country.includes(preferredCountry)) score += 8;
  if (preferredType && `${methodology} ${assetType}`.includes(preferredType)) score += 6;
  if (executionMode(asset) === "programmatic") score += 8;
  if (boolAt(asset.beneficiary_retirement_supported)) score += 4;
  if (boolAt(asset.fractional_retirement_supported)) score += 2;

  const maxPrice = numberAt(opportunity.max_price_usd_tonne, 0);
  const price = numberAt(asset.source_price_usd_ton, 0);
  if (maxPrice > 0 && price > maxPrice) score -= 35;
  else if (maxPrice > 0 && price > 0) score += 5;

  return Math.max(0, Math.min(100, score));
}

async function opportunityById(id: number) {
  const { rows } = await pool.query(`
    SELECT o.*,a.company_name,a.sector,a.country AS account_country,
           i.inventory_year,i.scope1_tonnes,i.scope2_location_tonnes,i.scope2_market_tonnes,i.scope3_tonnes
    FROM demand_opportunities o
    JOIN demand_accounts a ON a.id=o.account_id
    LEFT JOIN demand_inventories i ON i.id=o.inventory_id
    WHERE o.id=$1`, [id]);
  return rows[0] as Json | undefined;
}

async function readyAssetCandidates(opportunity: Json) {
  const { rows } = await pool.query(`
    SELECT * FROM monitored_assets
    WHERE active=TRUE
      AND claim_category='voluntary_offset'
      AND eligibility_status='eligible'
      AND source_unit_status='tradable'
      AND availability_status IN ('confirmed','indicative')
      AND retirement_supported=TRUE
      AND COALESCE(available_tons,0)>0
      AND (commercial_valid_until IS NULL OR commercial_valid_until>=CURRENT_DATE)
    ORDER BY COALESCE(sourcing_score,0) DESC,
             COALESCE(source_price_usd_ton,999999999) ASC,
             COALESCE(available_tons,0) DESC
    LIMIT 250`);

  const maxPrice = numberAt(opportunity.max_price_usd_tonne, 0);
  return rows
    .map((row) => row as Json)
    .filter((asset) => capacityTonnes(asset) > 0)
    .filter((asset) => maxPrice <= 0 || numberAt(asset.source_price_usd_ton, 0) <= 0 || numberAt(asset.source_price_usd_ton, 0) <= maxPrice)
    .map((asset) => ({ asset, score: candidateScore(asset, opportunity) }))
    .sort((a, b) => b.score - a.score || numberAt(a.asset.source_price_usd_ton, 999999999) - numberAt(b.asset.source_price_usd_ton, 999999999));
}

async function supplyDeskCandidates(opportunity: Json) {
  const { rows } = await pool.query(`
    SELECT i.*,m.floor_price_usd_tonne,m.supplier_name,m.allowed_channels,
           l.project_name,l.country,l.region,l.methodology,l.evidence_url,l.source_url,
           COALESCE((SELECT SUM(r.reserved_tonnes) FROM supply_reservations r
                     WHERE r.inventory_id=i.id AND r.status IN ('active','pending')),0) AS reserved_tonnes,
           GREATEST(0,i.authorized_tonnes-i.sold_tonnes-
             COALESCE((SELECT SUM(r.reserved_tonnes) FROM supply_reservations r
                       WHERE r.inventory_id=i.id AND r.status IN ('active','pending')),0)) AS available_tonnes,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'channel',cl.channel,'status',cl.status,'askPriceUsdTonne',cl.ask_price_usd_tonne,
             'externalUrl',cl.external_url,'advertisedTonnes',cl.advertised_tonnes
           ) ORDER BY cl.channel) FROM supply_channel_listings cl
             WHERE cl.inventory_id=i.id AND cl.status IN ('submitted','active')), '[]'::jsonb) AS channel_listings
    FROM supply_inventory i
    JOIN supplier_mandates m ON m.id=i.mandate_id AND m.status='active'
    JOIN supply_leads l ON l.id=m.lead_id
    WHERE i.status='available'
    ORDER BY available_tonnes DESC
    LIMIT 200`);

  const preferredRegistry = text(opportunity.preferred_registry).toLowerCase();
  const preferredCountry = text(opportunity.preferred_country).toLowerCase();
  const maxPrice = numberAt(opportunity.max_price_usd_tonne, 0);
  return rows
    .filter((row) => numberAt(row.available_tonnes, 0) > 0)
    .map((row) => {
      let score = 55;
      const registry = text(row.registry).toLowerCase();
      const country = text(row.country).toLowerCase();
      const price = numberAt(row.floor_price_usd_tonne, 0);
      if (preferredRegistry && registry.includes(preferredRegistry)) score += 10;
      if (preferredCountry && country.includes(preferredCountry)) score += 8;
      if (Array.isArray(row.channel_listings) && row.channel_listings.length) score += 7;
      if (maxPrice > 0 && price > maxPrice) score -= 30;
      if (price > 0) score += 3;
      return {
        sourceKind: "supply_inventory" as const,
        sourceId: Number(row.id),
        registry: row.registry,
        projectName: row.project_name,
        country: row.country,
        vintage: row.vintage,
        availableTonnes: numberAt(row.available_tonnes, 0),
        floorPriceUsdTonne: price || null,
        supplierName: row.supplier_name,
        evidenceUrl: row.registry_evidence_url || row.evidence_url || row.source_url || null,
        channelListings: row.channel_listings,
        score: Math.max(0, Math.min(100, score)),
        claimReady: false,
        executionMode: "commercial_supply_pending_eligibility",
        warning: "Inventário comercial autorizado pelo fornecedor, mas ainda precisa passar pelo gate de elegibilidade EcoTracker antes de ser vendido como compensação.",
      };
    })
    .sort((a, b) => b.score - a.score || b.availableTonnes - a.availableTonnes);
}

export async function generateDemandMatches(opportunityId: number) {
  const opportunity = await opportunityById(opportunityId);
  if (!opportunity) throw Object.assign(new Error("Oportunidade de demanda não encontrada"), { status: 404 });

  const targetTonnes = numberAt(opportunity.target_tonnes, 0);
  if (targetTonnes <= 0) throw new Error("Oportunidade sem volume-alvo válido");

  const candidates = await readyAssetCandidates(opportunity);
  let remaining = targetTonnes;
  const readyMatches: Json[] = [];

  for (const { asset, score } of candidates) {
    if (remaining <= 0.0005) break;
    const granularity = granularityTonnes(asset);
    const maxTonnes = Math.min(remaining, capacityTonnes(asset));
    const allocatedTonnes = floorToGranularity(maxTonnes, granularity);
    if (allocatedTonnes <= 0) continue;
    const requestedKg = Math.max(1, Math.round(allocatedTonnes * 1000));
    const decision = evaluateAssetEligibility(asset, opportunity.claim_purpose || "voluntary_offset", requestedKg);
    if (!decision.allowed) continue;

    const match = {
      sourceKind: "market_asset",
      sourceId: Number(asset.id),
      registry: asset.registry,
      projectName: asset.project_name,
      country: projectCountry(asset) || null,
      vintage: asset.vintage,
      matchedTonnes: allocatedTonnes,
      availableTonnes: capacityTonnes(asset),
      score,
      claimReady: true,
      executionMode: executionMode(asset),
      indicativePriceUsdTonne: numberAt(asset.source_price_usd_ton, 0) || null,
      evidenceUrl: asset.registry_evidence_url || asset.source_url || null,
      eligibility: decision,
      fractional: boolAt(asset.fractional_retirement_supported),
      granularityKg: numberAt(asset.retirement_granularity_kg, 1000),
    };
    readyMatches.push(match);
    remaining = Number(Math.max(0, remaining - allocatedTonnes).toFixed(3));
  }

  const supplyCandidates = await supplyDeskCandidates(opportunity);

  await pool.query("DELETE FROM demand_matches WHERE opportunity_id=$1 AND status='proposed'", [opportunityId]);
  for (const match of readyMatches) {
    await pool.query(`
      INSERT INTO demand_matches
        (opportunity_id,source_kind,source_id,matched_tonnes,score,claim_ready,execution_mode,registry,project_name,vintage,
         indicative_price_usd_tonne,evidence_url,rationale,status)
      VALUES($1,'market_asset',$2,$3,$4,TRUE,$5,$6,$7,$8,$9,$10,$11::jsonb,'proposed')
      ON CONFLICT(opportunity_id,source_kind,source_id) DO UPDATE SET
        matched_tonnes=EXCLUDED.matched_tonnes,score=EXCLUDED.score,claim_ready=TRUE,
        execution_mode=EXCLUDED.execution_mode,registry=EXCLUDED.registry,project_name=EXCLUDED.project_name,
        vintage=EXCLUDED.vintage,indicative_price_usd_tonne=EXCLUDED.indicative_price_usd_tonne,
        evidence_url=EXCLUDED.evidence_url,rationale=EXCLUDED.rationale,status='proposed',updated_at=NOW()`, [
      opportunityId,match.sourceId,match.matchedTonnes,match.score,match.executionMode,match.registry,match.projectName,match.vintage,
      match.indicativePriceUsdTonne,match.evidenceUrl,JSON.stringify({ eligibility: match.eligibility, fractional: match.fractional, granularityKg: match.granularityKg }),
    ]);
  }

  const coveredTonnes = Number((targetTonnes - remaining).toFixed(3));
  return {
    opportunity,
    targetTonnes,
    coveredTonnes,
    uncoveredTonnes: remaining,
    coveragePct: Number(Math.min(100, targetTonnes > 0 ? coveredTonnes / targetTonnes * 100 : 0).toFixed(2)),
    fullyCovered: remaining <= 0.0005,
    readyMatches,
    supplyCandidates: supplyCandidates.slice(0, 30),
    rules: {
      inventoryAccounting: "As emissões corporativas permanecem reportadas separadamente dos offsets.",
      exclusiveClaim: "Somente créditos elegíveis, comercialmente disponíveis e aposentados para o beneficiário podem sustentar claim de compensação.",
      supplyDesk: "Inventário com mandato comercial não é automaticamente claim-ready; passa pelo gate de elegibilidade antes da venda como compensação.",
    },
  };
}
