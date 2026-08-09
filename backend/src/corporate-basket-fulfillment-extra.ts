import { pool, withTransaction } from "./db.js";
import { getCorporateBasketFulfillment } from "./corporate-basket-fulfillment.js";

export async function resolveCorporateBasketFulfillmentLegReview(input:{basketId:number;fulfillmentLegId:number}) {
  await withTransaction(async (client) => {
    const legResult = await client.query(`
      SELECT l.*,f.id AS parent_fulfillment_id,f.total_requested_kg
      FROM corporate_basket_fulfillment_legs l
      JOIN corporate_basket_fulfillments f ON f.id=l.fulfillment_id
      WHERE l.id=$1 AND f.basket_id=$2
      FOR UPDATE OF l,f`, [input.fulfillmentLegId,input.basketId]);
    const leg = legResult.rows[0];
    if (!leg) throw Object.assign(new Error("Leg de fulfillment não encontrada"), { status:404 });
    if (leg.status!=="review_required") {
      throw Object.assign(new Error("A leg não está em revisão"), { status:409 });
    }

    let nextStatus = "pending_acquisition";
    if (Number(leg.retired_kg)===Number(leg.requested_kg) && leg.retirement_reference) {
      nextStatus = "retired";
    } else if (Number(leg.acquired_kg)===Number(leg.requested_kg) && leg.source_reference) {
      nextStatus = "acquired";
    }

    await client.query(`
      UPDATE corporate_basket_fulfillment_legs
      SET status=$2,review_reason=NULL,updated_at=NOW()
      WHERE id=$1`, [leg.id,nextStatus]);

    const totals = await client.query(`
      SELECT COALESCE(SUM(acquired_kg),0)::bigint AS acquired_kg,
             COALESCE(SUM(retired_kg),0)::bigint AS retired_kg,
             COUNT(*)::int AS legs,
             COUNT(*) FILTER (WHERE status='retired')::int AS retired_legs,
             COUNT(*) FILTER (WHERE status='review_required')::int AS review_legs
      FROM corporate_basket_fulfillment_legs
      WHERE fulfillment_id=$1`, [leg.parent_fulfillment_id]);
    const row = totals.rows[0];
    const totalRequested = Number(leg.total_requested_kg);
    const retired = Number(row.retired_kg || 0);
    const reviewLegs = Number(row.review_legs || 0);
    const allRetired = Number(row.legs || 0)>0
      && Number(row.retired_legs || 0)===Number(row.legs || 0)
      && retired===totalRequested;
    const fulfillmentStatus = reviewLegs>0 ? "review_required" : allRetired ? "retired" : "in_progress";

    await client.query(`
      UPDATE corporate_basket_fulfillments
      SET total_acquired_kg=$2,total_retired_kg=$3,status=$4::varchar(40),
          review_reason=CASE WHEN $4::varchar(40)='review_required' THEN 'Uma ou mais legs exigem revisão operacional' ELSE NULL END,
          retired_at=CASE WHEN $4::varchar(40)='retired' THEN COALESCE(retired_at,NOW()) ELSE retired_at END,
          updated_at=NOW()
      WHERE id=$1`, [leg.parent_fulfillment_id,Number(row.acquired_kg || 0),retired,fulfillmentStatus]);

    await client.query(`
      UPDATE corporate_baskets
      SET status=$2,updated_at=NOW()
      WHERE id=$1`, [input.basketId,reviewLegs>0 ? "fulfillment_review_required" : "fulfillment_in_progress"]);
  });

  return getCorporateBasketFulfillment(input.basketId);
}

export async function markCorporateBasketEcotDelivered(basketId:number) {
  return withTransaction(async (client) => {
    const basketResult = await client.query(`
      SELECT b.*,f.status AS fulfillment_status,f.bundle_sha256
      FROM corporate_baskets b
      JOIN corporate_basket_fulfillments f ON f.basket_id=b.id
      WHERE b.id=$1
      FOR UPDATE OF b,f`, [basketId]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket ou fulfillment não encontrado"), { status:404 });
    if (basket.fulfillment_status!=="completed") {
      throw Object.assign(new Error("ECOT só pode ser entregue após conclusão integral do fulfillment"), { status:409 });
    }
    if (!["fulfilled_climate","completed"].includes(String(basket.status))) {
      throw Object.assign(new Error("Basket ainda não está pronto para entrega ECOT"), { status:409 });
    }

    const allocationResult = await client.query(`
      SELECT * FROM corporate_basket_ecot_allocations
      WHERE basket_id=$1
      FOR UPDATE`, [basketId]);
    const allocation = allocationResult.rows[0];
    if (!allocation) {
      throw Object.assign(new Error("Alocação ECOT do basket não encontrada"), { status:409 });
    }
    if (allocation.status==="delivered") {
      return {
        basketId,
        basketPublicCode:basket.public_code,
        allocationPublicCode:allocation.public_code,
        amountKg:Number(allocation.amount_kg),
        status:"delivered",
        deliveredAt:allocation.delivered_at,
        bundleSha256:allocation.evidence_bundle_sha256,
      };
    }
    if (allocation.status!=="allocated") {
      throw Object.assign(new Error("Alocação ECOT não está em estado entregável"), { status:409 });
    }

    const delivered = (await client.query(`
      UPDATE corporate_basket_ecot_allocations
      SET status='delivered',delivered_at=NOW()
      WHERE id=$1
      RETURNING *`, [allocation.id])).rows[0];
    await client.query(`
      UPDATE corporate_baskets
      SET status='completed',updated_at=NOW()
      WHERE id=$1`, [basketId]);

    return {
      basketId,
      basketPublicCode:basket.public_code,
      allocationPublicCode:delivered.public_code,
      amountKg:Number(delivered.amount_kg),
      status:delivered.status,
      deliveredAt:delivered.delivered_at,
      bundleSha256:delivered.evidence_bundle_sha256,
    };
  });
}
