import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";
import { priceFromSourceCost } from "./pricing-policy.js";

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

function executionMode(asset: Json) {
  return asset.sourcing_executable === true ? "programmatic" : "assisted";
}

function requestedKgFromTonnes(value: unknown) {
  const tonnes = Number(value);
  const kg = Math.round(tonnes * 1000);
  if (!Number.isFinite(tonnes) || tonnes <= 0 || !Number.isInteger(kg) || kg <= 0) {
    throw Object.assign(new Error("Item da proposta possui volume inválido"), { status: 409 });
  }
  return kg;
}

async function getBasketAdmin(client: pg.PoolClient | typeof pool, basketId: number) {
  const { rows } = await client.query(`
    SELECT b.*,a.company_name,a.legal_name,a.tax_id,a.contact_name,a.contact_email,a.contact_phone,
           p.public_code AS proposal_public_code,p.opportunity_id,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id',l.id,'publicCode',l.public_code,'proposalItemId',l.proposal_item_id,'assetId',l.asset_id,
             'requestedKg',l.requested_kg,'registry',l.registry,'projectName',l.project_name,'vintage',l.vintage,
             'providerKey',l.provider_key,'executionMode',l.execution_mode,'status',l.status,
             'sourceCostBrl',l.source_cost_brl,'sourceReference',l.source_reference,
             'sourceAvailableKg',l.source_available_kg,'sourceEvidenceUrl',l.source_evidence_url,
             'quoteExpiresAt',l.quote_expires_at,'eligibilitySnapshot',l.eligibility_snapshot,
             'sourceSnapshot',l.source_snapshot,'confirmedAt',l.confirmed_at
           ) ORDER BY l.id) FROM corporate_basket_legs l WHERE l.basket_id=b.id),'[]'::jsonb) AS legs
    FROM corporate_baskets b
    JOIN demand_accounts a ON a.id=b.account_id
    JOIN demand_proposals p ON p.id=b.proposal_id
    WHERE b.id=$1`, [basketId]);
  return rows[0];
}

async function recalculateBasket(client: pg.PoolClient, basketId: number) {
  const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [basketId]);
  const basket = basketResult.rows[0];
  if (!basket) throw Object.assign(new Error("Basket corporativo não encontrado"), { status: 404 });
  if (["cancelled","expired"].includes(String(basket.status))) return basket;

  const legsResult = await client.query(`
    SELECT l.*,a.fixed_fee_brl
    FROM corporate_basket_legs l JOIN monitored_assets a ON a.id=l.asset_id
    WHERE l.basket_id=$1 ORDER BY l.id FOR UPDATE OF l`, [basketId]);
  const legs = legsResult.rows;
  if (!legs.length) throw new Error("Basket sem legs");

  const allConfirmed = legs.every((leg) => leg.status === "confirmed" && Number(leg.source_cost_brl) > 0 && leg.quote_expires_at);
  if (!allConfirmed) {
    await client.query(`
      UPDATE corporate_baskets SET status='awaiting_leg_confirmation',source_cost_brl=NULL,
        service_revenue_brl=NULL,final_total_brl=NULL,price_per_tonne_brl=NULL,quote_expires_at=NULL,
        pricing_snapshot=jsonb_build_object('pricingMode','basket_assisted','allLegsConfirmed',FALSE,'updatedAt',NOW()),
        updated_at=NOW() WHERE id=$1`, [basketId]);
    return (await client.query(`SELECT * FROM corporate_baskets WHERE id=$1`, [basketId])).rows[0];
  }

  const now = Date.now();
  const expiryMs = Math.min(...legs.map((leg) => new Date(leg.quote_expires_at).getTime()));
  if (!Number.isFinite(expiryMs) || expiryMs <= now) {
    await client.query(`
      UPDATE corporate_baskets SET status='expired',source_cost_brl=NULL,service_revenue_brl=NULL,
        final_total_brl=NULL,price_per_tonne_brl=NULL,quote_expires_at=to_timestamp($2/1000.0),updated_at=NOW()
      WHERE id=$1`, [basketId,expiryMs || now]);
    return (await client.query(`SELECT * FROM corporate_baskets WHERE id=$1`, [basketId])).rows[0];
  }

  const sourceCostBrl = Number(legs.reduce((sum, leg) => sum + Number(leg.source_cost_brl || 0), 0).toFixed(2));
  const fixedFeesBrl = Number(legs.reduce((sum, leg) => sum + Math.max(0, Number(leg.fixed_fee_brl || 0)), 0).toFixed(2));
  const coveredKg = Number(basket.covered_kg);
  const priced = priceFromSourceCost({ sourceCostBrl, requestedKg: coveredKg, fixedFeeBrl: fixedFeesBrl });
  const pricePerTonneBrl = Number((priced.finalTotalBrl / (coveredKg / 1000)).toFixed(2));
  const pricingSnapshot = {
    pricingMode: "basket_assisted_confirmed",
    legs: legs.map((leg) => ({
      legId: leg.id,
      assetId: leg.asset_id,
      requestedKg: Number(leg.requested_kg),
      sourceCostBrl: Number(leg.source_cost_brl),
      providerKey: leg.provider_key,
      executionMode: leg.execution_mode,
      quoteExpiresAt: leg.quote_expires_at,
    })),
    sourceCostBrl: priced.sourceCostBrl,
    serviceRevenueBrl: priced.serviceRevenueBrl,
    finalTotalBrl: priced.finalTotalBrl,
    tier: priced.tier,
    checkoutEnabled: false,
    confirmedAt: new Date().toISOString(),
  };

  await client.query(`
    UPDATE corporate_baskets SET status='quoted',source_cost_brl=$2,service_revenue_brl=$3,
      final_total_brl=$4,price_per_tonne_brl=$5,quote_expires_at=$6,checkout_enabled=FALSE,payment_status='disabled',
      pricing_snapshot=$7::jsonb,updated_at=NOW()
    WHERE id=$1`, [basketId,priced.sourceCostBrl,priced.serviceRevenueBrl,priced.finalTotalBrl,pricePerTonneBrl,new Date(expiryMs).toISOString(),JSON.stringify(pricingSnapshot)]);
  return (await client.query(`SELECT * FROM corporate_baskets WHERE id=$1`, [basketId])).rows[0];
}

export async function createCorporateBasket(proposalId: number, notes?: string | null) {
  return withTransaction(async (client) => {
    const existing = await client.query(`SELECT id FROM corporate_baskets WHERE proposal_id=$1 FOR UPDATE`, [proposalId]);
    if (existing.rows[0]) return getBasketAdmin(client, Number(existing.rows[0].id));

    const proposalResult = await client.query(`
      SELECT p.*,o.claim_purpose,a.company_name,a.legal_name,a.tax_id,a.contact_name,a.contact_email,a.contact_phone
      FROM demand_proposals p
      JOIN demand_opportunities o ON o.id=p.opportunity_id
      JOIN demand_accounts a ON a.id=p.account_id
      WHERE p.id=$1 FOR UPDATE OF p`, [proposalId]);
    const proposal = proposalResult.rows[0];
    if (!proposal) throw Object.assign(new Error("Proposta não encontrada"), { status: 404 });
    if (proposal.checkout_mode !== "basket_quote_required") {
      throw Object.assign(new Error("Esta proposta não exige basket corporativo"), { status: 409 });
    }
    if (proposal.converted_quote_id) {
      throw Object.assign(new Error("A proposta já foi convertida em cotação single-asset"), { status: 409 });
    }
    if (Number(proposal.uncovered_tonnes || 0) > 0.0005) {
      throw Object.assign(new Error("A proposta ainda possui volume sem cobertura; refaça o matching antes de criar o basket"), { status: 409 });
    }
    if (proposal.expires_at && new Date(proposal.expires_at).getTime() < Date.now()) {
      throw Object.assign(new Error("A proposta expirou; gere uma nova proposta antes do basket"), { status: 409 });
    }

    const itemResult = await client.query(`SELECT * FROM demand_proposal_items WHERE proposal_id=$1 ORDER BY id`, [proposalId]);
    if (itemResult.rows.length < 1) throw Object.assign(new Error("Proposta sem itens"), { status: 409 });

    const validated: Array<{ item: Json; asset: Json; requestedKg: number; decision: unknown }> = [];
    for (const item of itemResult.rows as Json[]) {
      if (!item.asset_id) throw Object.assign(new Error("Item da proposta sem ativo vinculado"), { status: 409 });
      const assetResult = await client.query(`SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE`, [item.asset_id]);
      const asset = assetResult.rows[0] as Json | undefined;
      if (!asset) throw Object.assign(new Error(`Ativo ${item.asset_id} não está mais ativo`), { status: 409 });
      const requestedKg = requestedKgFromTonnes(item.amount_tonnes);
      if (requestedKg < Number(asset.min_order_kg || 1)) {
        throw Object.assign(new Error(`O lote ${asset.project_name} está abaixo do mínimo atual da fonte`), { status: 409 });
      }
      const availableTons = asset.available_tons == null ? null : Number(asset.available_tons);
      if (availableTons != null && Number.isFinite(availableTons) && requestedKg > availableTons * 1000) {
        throw Object.assign(new Error(`Estoque insuficiente no lote ${asset.project_name}`), { status: 409 });
      }
      const decision = evaluateAssetEligibility(asset, String(proposal.claim_purpose || "voluntary_offset"), requestedKg);
      if (!decision.allowed) throw Object.assign(new Error(`${asset.project_name}: ${decision.reason}`), { status: 409 });
      validated.push({ item, asset, requestedKg, decision });
    }

    const coveredKg = validated.reduce((sum, entry) => sum + entry.requestedKg, 0);
    const buyerSnapshot = {
      companyName: proposal.company_name,
      legalName: proposal.legal_name,
      taxId: proposal.tax_id,
      contactName: proposal.contact_name,
      contactEmail: proposal.contact_email,
      contactPhone: proposal.contact_phone,
      claimPurpose: proposal.claim_purpose,
    };
    const basketResult = await client.query(`
      INSERT INTO corporate_baskets
        (proposal_id,account_id,status,target_kg,covered_kg,payment_status,checkout_enabled,buyer_snapshot,pricing_snapshot,notes)
      VALUES($1,$2,'awaiting_leg_confirmation',$3,$4,'disabled',FALSE,$5::jsonb,$6::jsonb,$7)
      RETURNING *`, [
      proposal.id,proposal.account_id,Math.round(Number(proposal.target_tonnes)*1000),coveredKg,
      JSON.stringify(buyerSnapshot),JSON.stringify({ pricingMode: "basket_assisted", allLegsConfirmed: false }),notes || null,
    ]);
    const basket = basketResult.rows[0];

    for (const entry of validated) {
      const { item,asset,requestedKg,decision } = entry;
      await client.query(`
        INSERT INTO corporate_basket_legs
          (basket_id,proposal_item_id,asset_id,requested_kg,registry,project_name,vintage,provider_key,execution_mode,
           status,eligibility_snapshot,source_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_confirmation',$10::jsonb,$11::jsonb)`, [
        basket.id,item.id,asset.id,requestedKg,asset.registry,asset.project_name,asset.vintage,providerKey(asset),executionMode(asset),
        JSON.stringify(decision),JSON.stringify({
          sourceReference: asset.source_reference,
          sourceUrl: asset.source_url,
          monitoredPriceUsdTonne: asset.source_price_usd_ton,
          monitoredAvailableTons: asset.available_tons,
          pricingMode: asset.pricing_mode,
          availabilityStatus: asset.availability_status,
          sourcingExecutable: asset.sourcing_executable === true,
          capturedAt: new Date().toISOString(),
        }),
      ]);
    }

    await client.query(`UPDATE demand_proposals SET status='basket_preparing',updated_at=NOW() WHERE id=$1`, [proposal.id]);
    return getBasketAdmin(client, Number(basket.id));
  });
}

export async function confirmCorporateBasketLeg(input: {
  basketId: number;
  legId: number;
  sourceCostBrl: number;
  sourceReference: string;
  sourceAvailableKg?: number | null;
  sourceEvidenceUrl?: string | null;
  quoteTtlMinutes?: number;
  confirmedBy?: string | null;
}) {
  return withTransaction(async (client) => {
    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [input.basketId]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status: 404 });
    if (["cancelled","expired"].includes(String(basket.status))) throw Object.assign(new Error("Basket encerrado"), { status: 409 });

    const legResult = await client.query(`SELECT * FROM corporate_basket_legs WHERE id=$1 AND basket_id=$2 FOR UPDATE`, [input.legId,input.basketId]);
    const leg = legResult.rows[0];
    if (!leg) throw Object.assign(new Error("Leg não encontrada"), { status: 404 });
    const assetResult = await client.query(`SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE`, [leg.asset_id]);
    const asset = assetResult.rows[0] as Json | undefined;
    if (!asset) throw Object.assign(new Error("Ativo da leg não está mais ativo"), { status: 409 });

    const decision = evaluateAssetEligibility(asset, String(objectAt(basket.buyer_snapshot).claimPurpose || "voluntary_offset"), Number(leg.requested_kg));
    if (!decision.allowed) throw Object.assign(new Error(decision.reason), { status: 409, code: "LEG_NO_LONGER_ELIGIBLE" });
    if (input.sourceAvailableKg != null && input.sourceAvailableKg < Number(leg.requested_kg)) {
      throw Object.assign(new Error("Estoque confirmado da fonte é inferior à quantidade da leg"), { status: 409 });
    }
    const monitoredTons = asset.available_tons == null ? null : Number(asset.available_tons);
    if (monitoredTons != null && Number.isFinite(monitoredTons) && Number(leg.requested_kg) > monitoredTons * 1000) {
      throw Object.assign(new Error("Estoque monitorado atual não cobre mais a leg"), { status: 409 });
    }

    const ttl = Math.max(5,Math.min(1440,Math.round(input.quoteTtlMinutes || 30)));
    const expiresAt = new Date(Date.now()+ttl*60*1000).toISOString();
    const sourceSnapshot = {
      ...objectAt(leg.source_snapshot),
      confirmedSourceReference: input.sourceReference,
      confirmedAvailableKg: input.sourceAvailableKg ?? null,
      confirmedEvidenceUrl: input.sourceEvidenceUrl ?? null,
      confirmedCostBrl: Number(input.sourceCostBrl.toFixed(2)),
      confirmedAt: new Date().toISOString(),
    };
    await client.query(`
      UPDATE corporate_basket_legs SET status='confirmed',source_cost_brl=$3,source_reference=$4,
        source_available_kg=$5,source_evidence_url=$6,quote_expires_at=$7,eligibility_snapshot=$8::jsonb,
        source_snapshot=$9::jsonb,confirmed_at=NOW(),confirmed_by=$10,updated_at=NOW()
      WHERE id=$1 AND basket_id=$2`, [
      input.legId,input.basketId,Number(input.sourceCostBrl.toFixed(2)),input.sourceReference,input.sourceAvailableKg ?? null,
      input.sourceEvidenceUrl ?? null,expiresAt,JSON.stringify(decision),JSON.stringify(sourceSnapshot),input.confirmedBy || "admin",
    ]);

    await recalculateBasket(client,input.basketId);
    return getBasketAdmin(client,input.basketId);
  });
}

export async function getCorporateBasketAdmin(basketId: number) {
  return getBasketAdmin(pool,basketId);
}

export async function getCorporateBasketPublic(publicCode: string) {
  const { rows } = await pool.query(`
    SELECT b.public_code,b.status,b.target_kg,b.covered_kg,b.final_total_brl,b.price_per_tonne_brl,
           b.payment_status,b.checkout_enabled,b.quote_expires_at,b.buyer_snapshot,b.created_at,b.updated_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'registry',l.registry,'projectName',l.project_name,'vintage',l.vintage,'requestedKg',l.requested_kg,
             'executionMode',l.execution_mode,'status',l.status,'evidenceUrl',l.source_evidence_url
           ) ORDER BY l.id) FROM corporate_basket_legs l WHERE l.basket_id=b.id),'[]'::jsonb) AS legs
    FROM corporate_baskets b WHERE b.public_code=$1`, [publicCode]);
  const basket = rows[0];
  if (!basket) return null;
  return {
    publicCode: basket.public_code,
    status: basket.status,
    companyName: objectAt(basket.buyer_snapshot).companyName || null,
    targetKg: Number(basket.target_kg),
    coveredKg: Number(basket.covered_kg),
    finalTotalBrl: basket.final_total_brl == null ? null : Number(basket.final_total_brl),
    pricePerTonneBrl: basket.price_per_tonne_brl == null ? null : Number(basket.price_per_tonne_brl),
    quoteExpiresAt: basket.quote_expires_at,
    checkoutEnabled: false,
    paymentStatus: "disabled",
    legs: basket.legs,
    disclosure: "Cotação corporativa multi-lote. Cada crédito será adquirido e aposentado com evidência própria antes do claim final. Pagamento do basket ainda não está habilitado nesta fase.",
  };
}

export async function cancelCorporateBasket(basketId: number) {
  return withTransaction(async (client) => {
    const result = await client.query(`
      UPDATE corporate_baskets SET status='cancelled',final_total_brl=NULL,source_cost_brl=NULL,
        service_revenue_brl=NULL,price_per_tonne_brl=NULL,quote_expires_at=NULL,checkout_enabled=FALSE,
        payment_status='disabled',updated_at=NOW()
      WHERE id=$1 AND status NOT IN ('cancelled') RETURNING *`, [basketId]);
    if (!result.rows[0]) throw Object.assign(new Error("Basket não encontrado ou já cancelado"), { status: 404 });
    await client.query(`UPDATE corporate_basket_legs SET status='cancelled',updated_at=NOW() WHERE basket_id=$1 AND status<>'cancelled'`, [basketId]);
    return result.rows[0];
  });
}
