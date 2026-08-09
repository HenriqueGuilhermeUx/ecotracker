import { pool, withTransaction } from "./db.js";
import { priceFromSourceCost } from "./pricing-policy.js";
import { generateDemandMatches } from "./demand-matching.js";

type Json = Record<string, unknown>;

function numberAt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolAt(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export async function createDemandProposal(input: {
  opportunityId: number;
  validityMinutes?: number;
  notes?: string | null;
}) {
  const matchPlan = await generateDemandMatches(input.opportunityId);
  const ready = matchPlan.readyMatches as Json[];
  if (!ready.length) {
    throw Object.assign(new Error("Nenhum crédito claim-ready cobre esta oportunidade no inventário atual"), { status: 409 });
  }

  const opportunityResult = await pool.query(`
    SELECT o.*,a.company_name,a.legal_name,a.tax_id,a.contact_name,a.contact_email,a.contact_phone,a.sector
    FROM demand_opportunities o JOIN demand_accounts a ON a.id=o.account_id
    WHERE o.id=$1`, [input.opportunityId]);
  const opportunity = opportunityResult.rows[0];
  if (!opportunity) throw Object.assign(new Error("Oportunidade não encontrada"), { status: 404 });

  const assetIds = ready.map((item) => Number(item.sourceId)).filter((id) => Number.isInteger(id) && id > 0);
  const assetsResult = await pool.query(`
    SELECT * FROM monitored_assets WHERE id=ANY($1::bigint[])`, [assetIds]);
  const assets = new Map<number, Json>(assetsResult.rows.map((asset) => [Number(asset.id), asset as Json]));

  let sourceCostBrl = 0;
  let fixedFeesBrl = 0;
  let allPriced = true;
  const itemDrafts: Json[] = [];
  const modes = new Set<string>();

  for (const match of ready) {
    const assetId = Number(match.sourceId);
    const asset = assets.get(assetId);
    if (!asset) continue;
    const tonnes = numberAt(match.matchedTonnes, 0);
    if (!(tonnes > 0)) continue;
    const usdTon = numberAt(asset.source_price_usd_ton, 0);
    const fx = numberAt(asset.fx_brl_usd, 0);
    const sourceCost = usdTon > 0 && fx > 0 ? Number((usdTon * fx * tonnes).toFixed(2)) : null;
    if (sourceCost == null) allPriced = false;
    else sourceCostBrl += sourceCost;
    fixedFeesBrl += Math.max(0, numberAt(asset.fixed_fee_brl, 0));
    const mode = String(match.executionMode || "assisted");
    modes.add(mode);
    itemDrafts.push({
      matchId: null,
      assetId,
      registry: asset.registry,
      projectName: asset.project_name,
      vintage: asset.vintage,
      amountTonnes: tonnes,
      sourcePriceUsdTonne: usdTon || null,
      fxBrlUsd: fx || null,
      sourceCostBrl: sourceCost,
      executionMode: mode,
      retirementSupported: boolAt(asset.retirement_supported),
      beneficiarySupported: boolAt(asset.beneficiary_retirement_supported),
      evidenceUrl: asset.registry_evidence_url || asset.source_url || null,
      claimCategory: asset.claim_category,
      eligibilityStatus: asset.eligibility_status,
      sourcingScore: asset.sourcing_score,
      sourcingTier: asset.sourcing_tier,
    });
  }

  if (!itemDrafts.length) throw Object.assign(new Error("Matching sem ativos comercialmente utilizáveis"), { status: 409 });

  const targetTonnes = numberAt(matchPlan.targetTonnes, 0);
  const coveredTonnes = numberAt(matchPlan.coveredTonnes, 0);
  const uncoveredTonnes = numberAt(matchPlan.uncoveredTonnes, 0);
  const coveragePct = numberAt(matchPlan.coveragePct, 0);
  const requestedKg = Math.max(1, Math.round(coveredTonnes * 1000));
  const priced = allPriced
    ? priceFromSourceCost({ sourceCostBrl: Number(sourceCostBrl.toFixed(2)), requestedKg, fixedFeeBrl: Number(fixedFeesBrl.toFixed(2)) })
    : null;
  const finalTotalBrl = priced?.finalTotalBrl ?? null;
  const pricePerTonneBrl = finalTotalBrl != null && coveredTonnes > 0 ? Number((finalTotalBrl / coveredTonnes).toFixed(2)) : null;
  const executionMode = modes.size === 1 ? [...modes][0] : "mixed";
  const fullyCovered = uncoveredTonnes <= 0.0005;
  const checkoutMode = fullyCovered && itemDrafts.length === 1 ? "single_asset_quote" : "basket_quote_required";
  const validityMinutes = Math.max(5, Math.min(10080, Math.round(input.validityMinutes || 60)));
  const expiresAt = new Date(Date.now() + validityMinutes * 60 * 1000).toISOString();

  const snapshot = {
    company: {
      name: opportunity.company_name,
      legalName: opportunity.legal_name,
      taxId: opportunity.tax_id,
      contactName: opportunity.contact_name,
      contactEmail: opportunity.contact_email,
      contactPhone: opportunity.contact_phone,
      sector: opportunity.sector,
    },
    opportunity: {
      id: opportunity.id,
      targetTonnes,
      targetBasis: opportunity.target_basis,
      claimPurpose: opportunity.claim_purpose,
      targetYear: opportunity.target_year,
    },
    coverage: { coveredTonnes, uncoveredTonnes, coveragePct, fullyCovered },
    pricing: priced ? {
      sourceCostBrl: priced.sourceCostBrl,
      serviceRevenueBrl: priced.serviceRevenueBrl,
      finalTotalBrl: priced.finalTotalBrl,
      pricePerTonneBrl,
      tier: priced.tier,
      indicative: true,
    } : { indicative: false, reason: "one_or_more_sources_require_live_quote" },
    checkoutMode,
    executionMode,
    items: itemDrafts,
    claimRule: "O inventário corporativo permanece reportado separadamente. A compensação só se conclui após retirement exclusivo dos créditos para o beneficiário.",
    createdAt: new Date().toISOString(),
  };

  return await withTransaction(async (client) => {
    const proposalResult = await client.query(`
      INSERT INTO demand_proposals
        (opportunity_id,account_id,status,target_tonnes,covered_tonnes,uncovered_tonnes,coverage_pct,
         source_cost_brl,service_revenue_brl,final_total_brl,price_per_tonne_brl,checkout_mode,execution_mode,
         validity_minutes,expires_at,proposal_snapshot,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
      RETURNING *`, [
      opportunity.id,opportunity.account_id,fullyCovered ? "draft" : "partial",targetTonnes,coveredTonnes,uncoveredTonnes,coveragePct,
      priced?.sourceCostBrl ?? null,priced?.serviceRevenueBrl ?? null,finalTotalBrl,pricePerTonneBrl,checkoutMode,executionMode,
      validityMinutes,expiresAt,JSON.stringify(snapshot),input.notes ?? null,
    ]);
    const proposal = proposalResult.rows[0];

    for (const item of itemDrafts) {
      const itemSale = priced && priced.sourceCostBrl > 0 && item.sourceCostBrl != null
        ? Number((priced.finalTotalBrl * numberAt(item.sourceCostBrl, 0) / priced.sourceCostBrl).toFixed(2))
        : null;
      await client.query(`
        INSERT INTO demand_proposal_items
          (proposal_id,match_id,asset_id,registry,project_name,vintage,amount_tonnes,source_price_usd_tonne,
           fx_brl_usd,source_cost_brl,indicative_sale_brl,execution_mode,retirement_supported,evidence_url,item_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`, [
        proposal.id,item.matchId,item.assetId,item.registry,item.projectName,item.vintage,item.amountTonnes,item.sourcePriceUsdTonne,
        item.fxBrlUsd,item.sourceCostBrl,itemSale,item.executionMode,item.retirementSupported,item.evidenceUrl,JSON.stringify(item),
      ]);
    }

    await client.query(`UPDATE demand_opportunities SET status='proposal_ready',updated_at=NOW() WHERE id=$1`, [opportunity.id]);

    const singleItem = itemDrafts.length === 1 ? itemDrafts[0] : null;
    return {
      ...proposal,
      snapshot,
      quoteRequestTemplate: checkoutMode === "single_asset_quote" && singleItem ? {
        assetId: singleItem.assetId,
        buyerName: opportunity.contact_name || opportunity.company_name,
        buyerEmail: opportunity.contact_email || null,
        companyName: opportunity.company_name,
        taxId: opportunity.tax_id || undefined,
        requestedKg,
        deliveryMode: "email",
        purpose: opportunity.claim_purpose || "voluntary_offset",
        ready: Boolean(opportunity.contact_email),
      } : null,
      basketQuoteRequired: checkoutMode === "basket_quote_required",
      warning: checkoutMode === "basket_quote_required"
        ? "A proposta usa múltiplos lotes ou cobertura parcial. O checkout atual é single-asset; não criar cobrança única até a basket rail ser implementada."
        : "Template pronto para criar a cotação single-asset existente, sujeito a revalidação de preço/estoque no momento da cotação.",
    };
  });
}
