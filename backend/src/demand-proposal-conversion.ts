import { withTransaction } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";
import { calculateAutomaticPricing } from "./commerce-service.js";

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function providerKey(asset: Json) {
  const details = objectAt(asset.monitor_details);
  const explicit = String(details.providerKey || "").trim();
  if (explicit) return explicit;
  const ref = String(asset.source_reference || "").toLowerCase();
  if (ref.startsWith("gold-standard-marketplace-")) return "gold-standard";
  if (ref.startsWith("klima-x402-")) return "klima-x402";
  if (ref.startsWith("carbonmark-")) return "carbonmark";
  return String(asset.registry || "assisted").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "assisted";
}

function providerSpecific(asset: Json) {
  const ref = String(asset.source_reference || "").toLowerCase();
  return ref.startsWith("carbonmark-") || (
    ref.startsWith("klima-x402-") && String(asset.pricing_mode || "") === "dynamic"
  );
}

function automaticGenericSource(asset: Json, requestedKg: number) {
  if (providerSpecific(asset)) return false;
  const availableTons = Number(asset.available_tons);
  return asset.sourcing_executable === true
    && String(asset.pricing_mode || "") === "dynamic"
    && String(asset.availability_status || "") === "confirmed"
    && String(asset.source_status || "") === "connected"
    && Number.isFinite(availableTons)
    && availableTons > 0
    && availableTons * 1000 >= requestedKg;
}

export async function convertSingleAssetProposal(proposalId: number) {
  return withTransaction(async (client) => {
    const proposalResult = await client.query(`
      SELECT p.*,o.claim_purpose,o.target_year,a.company_name,a.legal_name,a.tax_id,
             a.contact_name,a.contact_email,a.contact_phone
      FROM demand_proposals p
      JOIN demand_opportunities o ON o.id=p.opportunity_id
      JOIN demand_accounts a ON a.id=p.account_id
      WHERE p.id=$1
      FOR UPDATE OF p`, [proposalId]);
    const proposal = proposalResult.rows[0];
    if (!proposal) throw Object.assign(new Error("Proposta não encontrada"), { status: 404 });

    if (proposal.converted_quote_id) {
      const existing = await client.query(`SELECT public_code,status,requested_kg,final_total,quote_expires_at FROM quote_requests WHERE id=$1`, [proposal.converted_quote_id]);
      return { alreadyConverted: true, proposalId: proposal.id, quote: existing.rows[0] || null };
    }
    if (proposal.checkout_mode !== "single_asset_quote") {
      throw Object.assign(new Error("Esta proposta exige basket quote e não pode ser convertida como single-asset"), { status: 409, code: "BASKET_QUOTE_REQUIRED" });
    }
    if (Number(proposal.uncovered_tonnes || 0) > 0.0005) {
      throw Object.assign(new Error("A proposta ainda possui volume sem cobertura"), { status: 409 });
    }
    if (proposal.expires_at && new Date(proposal.expires_at).getTime() < Date.now()) {
      throw Object.assign(new Error("A proposta expirou e precisa ser recalculada"), { status: 409 });
    }
    if (!["draft","sent","accepted"].includes(String(proposal.status))) {
      throw Object.assign(new Error("A proposta não está em estado conversível"), { status: 409 });
    }
    if (!proposal.contact_email) {
      throw Object.assign(new Error("Cadastre o e-mail do contato antes de converter a proposta"), { status: 409 });
    }

    const items = await client.query(`SELECT * FROM demand_proposal_items WHERE proposal_id=$1 ORDER BY id`, [proposal.id]);
    if (items.rows.length !== 1) throw Object.assign(new Error("A proposta não possui exatamente um lote"), { status: 409 });
    const item = items.rows[0];
    if (!item.asset_id) throw Object.assign(new Error("O lote da proposta não está mais vinculado a um ativo"), { status: 409 });

    const assetResult = await client.query(`SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE`, [item.asset_id]);
    const asset = assetResult.rows[0] as Json | undefined;
    if (!asset) throw Object.assign(new Error("O ativo da proposta não está mais ativo"), { status: 409 });

    const requestedKg = Math.round(Number(item.amount_tonnes) * 1000);
    if (!Number.isInteger(requestedKg) || requestedKg <= 0 || requestedKg > 10_000_000) {
      throw Object.assign(new Error("O volume da proposta excede o limite do checkout single-asset; use a rail corporativa basket"), { status: 409, code: "ENTERPRISE_BASKET_REQUIRED" });
    }
    if (requestedKg < Number(asset.min_order_kg || 1)) {
      throw Object.assign(new Error("O volume da proposta está abaixo do mínimo atual da fonte"), { status: 409 });
    }
    const availableTons = asset.available_tons == null ? null : Number(asset.available_tons);
    if (availableTons != null && Number.isFinite(availableTons) && requestedKg > availableTons * 1000) {
      throw Object.assign(new Error("O estoque monitorado não cobre mais a proposta"), { status: 409 });
    }

    const purpose = String(proposal.claim_purpose || "voluntary_offset");
    const decision = evaluateAssetEligibility(asset, purpose, requestedKg);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.reason), { status: 409, code: "ASSET_NO_LONGER_ELIGIBLE" });
    }

    if (providerSpecific(asset)) {
      throw Object.assign(new Error("Este ativo usa um adapter de quote específico. Recrie a cotação pela rail do provider antes de cobrar."), {
        status: 409,
        code: "PROVIDER_SPECIFIC_QUOTE_REQUIRED",
        provider: providerKey(asset),
      });
    }

    const automatic = automaticGenericSource(asset, requestedKg);
    if (automatic) {
      const pricing = calculateAutomaticPricing(asset, requestedKg);
      if (!pricing.automatic || pricing.finalTotalBrl == null) {
        throw Object.assign(new Error("A fonte deixou de fornecer preço executável"), { status: 409 });
      }
      const taxPct = Number(process.env.ECOT_TAX_RESERVE_PCT || 0);
      const taxReserve = Number((pricing.finalTotalBrl * Math.max(0, taxPct) / 100).toFixed(2));
      const netProfit = pricing.grossProfitBrl == null ? null : Number((pricing.grossProfitBrl - taxReserve).toFixed(2));
      const snapshot = {
        ...pricing.snapshot,
        proposalId: proposal.id,
        proposalPublicCode: proposal.public_code,
        conversionMode: "single_asset_automatic",
      };
      const quoteResult = await client.query(`
        INSERT INTO quote_requests
          (asset_id,buyer_name,buyer_email,buyer_phone,company_name,tax_id,requested_kg,delivery_mode,purpose,
           indicative_price_per_kg,indicative_total,source_cost_brl,final_total,gross_revenue_brl,gross_profit_brl,
           tax_reserve_brl,net_profit_brl,status,quote_expires_at,pricing_snapshot,automation_enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,'email',$8,$9,$10,$11,$12,$12,$13,$14,$15,'quoted',$16,$17::jsonb,TRUE)
        RETURNING id,public_code,status,requested_kg,final_total,quote_expires_at`, [
        asset.id,proposal.contact_name || proposal.company_name,proposal.contact_email,proposal.contact_phone || null,
        proposal.company_name,proposal.tax_id || null,requestedKg,purpose,
        pricing.finalTotalBrl / requestedKg,pricing.finalTotalBrl,pricing.sourceCostBrl,pricing.finalTotalBrl,
        pricing.grossProfitBrl,taxReserve,netProfit,pricing.quoteExpiresAt,JSON.stringify(snapshot),
      ]);
      const quote = quoteResult.rows[0];
      await client.query(`UPDATE demand_proposals SET status='converted',converted_quote_id=$2,converted_at=NOW(),updated_at=NOW() WHERE id=$1`, [proposal.id,quote.id]);
      await client.query(`UPDATE demand_opportunities SET status='converted',updated_at=NOW() WHERE id=$1`, [proposal.opportunity_id]);
      return { alreadyConverted: false, proposalId: proposal.id, checkoutReady: true, pricingMode: "automatic", quote };
    }

    const provider = providerKey(asset);
    const snapshot = {
      pricingMode: "assisted",
      proposalId: proposal.id,
      proposalPublicCode: proposal.public_code,
      conversionMode: "single_asset_assisted",
      sourceReference: asset.source_reference,
      sourceStatus: asset.source_status,
      availabilityStatus: asset.availability_status,
      monitoredSourcePriceUsdTon: asset.source_price_usd_ton,
      monitoredAvailableTons: asset.available_tons,
      requestedKg,
      capturedAt: new Date().toISOString(),
    };
    const quoteResult = await client.query(`
      INSERT INTO quote_requests
        (asset_id,buyer_name,buyer_email,buyer_phone,company_name,tax_id,requested_kg,delivery_mode,purpose,
         status,pricing_snapshot,automation_enabled,sourcing_provider,sourcing_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'email',$8,'requested',$9::jsonb,FALSE,$10,'manual_quote_pending')
      RETURNING id,public_code,status,requested_kg,created_at`, [
      asset.id,proposal.contact_name || proposal.company_name,proposal.contact_email,proposal.contact_phone || null,
      proposal.company_name,proposal.tax_id || null,requestedKg,purpose,JSON.stringify(snapshot),provider,
    ]);
    const quote = quoteResult.rows[0];
    await client.query(`UPDATE demand_proposals SET status='converted',converted_quote_id=$2,converted_at=NOW(),updated_at=NOW() WHERE id=$1`, [proposal.id,quote.id]);
    await client.query(`UPDATE demand_opportunities SET status='converted',updated_at=NOW() WHERE id=$1`, [proposal.opportunity_id]);
    return {
      alreadyConverted: false,
      proposalId: proposal.id,
      checkoutReady: false,
      pricingMode: "assisted",
      quote,
      message: "Cotação criada a partir da proposta. Fonte, estoque e custo precisam ser reconfirmados antes do checkout.",
    };
  });
}
