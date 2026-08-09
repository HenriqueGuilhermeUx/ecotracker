import { withTransaction } from "./db.js";

type Json = Record<string, unknown>;

const money = (value: number) => Number(value.toFixed(2));
const numberEnv = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

export type BasketPaymentApprovalInput = {
  basketCode: string;
  provider: string;
  providerReference: string;
  paidAmountBrl?: number;
  providerFeeBrl?: number;
  raw?: unknown;
  eventKey?: string;
};

function payload(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : { value };
}

export async function reconcileCorporateBasketPaymentApproved(input: BasketPaymentApprovalInput) {
  return withTransaction(async (client) => {
    const basketResult = await client.query(
      `SELECT * FROM corporate_baskets WHERE public_code=$1 FOR UPDATE`,
      [input.basketCode],
    );
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado para o pagamento"), { status: 404 });

    if (basket.payment_status === "paid_awaiting_fulfillment") {
      return {
        basketId: Number(basket.id),
        alreadyPaid: true,
        reviewRequired: false,
        status: "paid_awaiting_fulfillment",
      };
    }

    const attemptResult = await client.query(`
      SELECT * FROM corporate_basket_payment_attempts
      WHERE basket_id=$1 AND provider=$2
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE`, [basket.id,input.provider]);
    const attempt = attemptResult.rows[0];
    if (!attempt) throw Object.assign(new Error("Tentativa de pagamento do basket não encontrada"), { status: 404 });

    const expectedAmount = Number(basket.final_total_brl || attempt.amount_brl || 0);
    const paidAmount = input.paidAmountBrl == null ? null : money(input.paidAmountBrl);
    const amountMatches = paidAmount != null && Math.abs(paidAmount-expectedAmount) <= 0.01;
    const providerFee = input.providerFeeBrl == null
      ? Number(attempt.provider_fee_brl || basket.payment_fee_brl || 0)
      : Math.max(0,input.providerFeeBrl);
    const taxReserve = Number(basket.tax_reserve_brl || 0);
    const sourceCost = Number(basket.source_cost_brl || 0);
    const netProfit = money(expectedAmount-sourceCost-providerFee-taxReserve);

    const graceMs = Math.max(30_000,Math.min(15*60_000,numberEnv("ECOT_BASKET_PAYMENT_WEBHOOK_GRACE_MS",5*60_000)));
    const attemptExpiryMs = attempt.expires_at ? new Date(attempt.expires_at).getTime() : 0;
    const withinWebhookGrace = Boolean(attemptExpiryMs) && Date.now() <= attemptExpiryMs+graceMs;

    const reservationResult = await client.query(`
      SELECT r.*,l.requested_kg,l.status AS leg_status
      FROM corporate_basket_reservations r
      JOIN corporate_basket_legs l ON l.id=r.leg_id
      WHERE r.basket_id=$1
      ORDER BY r.id
      FOR UPDATE OF r,l`, [basket.id]);
    const legCountResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM corporate_basket_legs WHERE basket_id=$1`,
      [basket.id],
    );
    const legCount = Number(legCountResult.rows[0]?.count || 0);
    const reservations = reservationResult.rows;
    const reservationsComplete = legCount > 0
      && reservations.length === legCount
      && reservations.every((row) =>
        ["active","expired","committed"].includes(String(row.status))
        && String(row.leg_status) === "confirmed"
        && Number(row.reserved_kg) === Number(row.requested_kg));
    const canReconcileReservations = withinWebhookGrace && reservationsComplete;

    const provisionalStatus = amountMatches ? "approved_reconciling" : "amount_mismatch";
    await client.query(`
      UPDATE corporate_basket_payment_attempts SET
        status=$2,provider_reference=$3,provider_fee_brl=$4,
        raw_payload=raw_payload || $5::jsonb,updated_at=NOW()
      WHERE id=$1`, [attempt.id,provisionalStatus,input.providerReference,providerFee,JSON.stringify(payload(input.raw))]);

    let reservationsCommitted = false;
    let reservationError: string | null = null;
    if (canReconcileReservations) {
      await client.query("SAVEPOINT basket_payment_reservation_commit");
      try {
        await client.query(`
          UPDATE corporate_basket_reservations SET status='committed',updated_at=NOW()
          WHERE basket_id=$1 AND status IN ('active','expired')`, [basket.id]);
        const committed = await client.query(`
          SELECT COUNT(*)::int AS count FROM corporate_basket_reservations
          WHERE basket_id=$1 AND status='committed'`, [basket.id]);
        if (Number(committed.rows[0]?.count || 0) !== legCount) {
          throw new Error("Nem todas as reservas do basket foram consolidadas");
        }
        await client.query("RELEASE SAVEPOINT basket_payment_reservation_commit");
        reservationsCommitted = true;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT basket_payment_reservation_commit");
        await client.query("RELEASE SAVEPOINT basket_payment_reservation_commit");
        reservationError = error instanceof Error ? error.message : String(error);
      }
    } else {
      reservationError = withinWebhookGrace
        ? "Conjunto de reservas não corresponde integralmente às legs confirmadas"
        : "Webhook recebido fora da janela de reconciliação da reserva";
    }

    const reviewRequired = !amountMatches || !reservationsCommitted;
    if (reviewRequired) {
      const reviewStatus = amountMatches ? "review_required" : "amount_mismatch";
      await client.query(`
        UPDATE corporate_basket_payment_attempts SET
          status=$2,provider_reference=$3,provider_fee_brl=$4,paid_at=NOW(),updated_at=NOW(),
          raw_payload=raw_payload || $5::jsonb
        WHERE id=$1`, [attempt.id,reviewStatus,input.providerReference,providerFee,JSON.stringify({
        reconciliation: {
          expectedAmountBrl: expectedAmount,
          paidAmountBrl: paidAmount,
          amountMatches,
          withinWebhookGrace,
          reservationsCommitted,
          reservationError,
        },
      })]);
      await client.query(`
        UPDATE corporate_baskets SET
          status='payment_review_required',payment_status='review_required',checkout_enabled=FALSE,
          payment_provider=$2,payment_reference=$3,payment_fee_brl=$4,net_profit_brl=$5,paid_at=NOW(),updated_at=NOW()
        WHERE id=$1`, [basket.id,input.provider,input.providerReference,providerFee,netProfit]);
      await client.query(`
        INSERT INTO corporate_basket_events(event_key,basket_id,event_type,provider,payload)
        VALUES(COALESCE($1,gen_random_uuid()::text),$2,$3,$4,$5::jsonb)
        ON CONFLICT(event_key) DO NOTHING`, [input.eventKey || null,basket.id,
        amountMatches ? "payment.reconciliation_review_required" : "payment.amount_mismatch",
        input.provider,JSON.stringify({
          expectedAmountBrl:expectedAmount,paidAmountBrl:paidAmount,withinWebhookGrace,
          reservationsCommitted,reservationError,raw:input.raw || {},
        })]);
      return {
        basketId:Number(basket.id),
        alreadyPaid:false,
        reviewRequired:true,
        status:"payment_review_required",
        expectedAmountBrl:expectedAmount,
        paidAmountBrl:paidAmount,
        amountMatches,
        reservationsCommitted,
        reservationError,
      };
    }

    await client.query(`
      UPDATE corporate_basket_payment_attempts SET
        status='paid',provider_reference=$2,provider_fee_brl=$3,paid_at=NOW(),updated_at=NOW()
      WHERE id=$1`, [attempt.id,input.providerReference,providerFee]);
    await client.query(`
      UPDATE corporate_baskets SET
        status='paid_awaiting_fulfillment',payment_status='paid_awaiting_fulfillment',checkout_enabled=FALSE,
        payment_provider=$2,payment_reference=$3,payment_fee_brl=$4,net_profit_brl=$5,paid_at=NOW(),updated_at=NOW()
      WHERE id=$1`, [basket.id,input.provider,input.providerReference,providerFee,netProfit]);
    await client.query(`
      INSERT INTO corporate_basket_events(event_key,basket_id,event_type,provider,payload)
      VALUES(COALESCE($1,gen_random_uuid()::text),$2,'payment.approved',$3,$4::jsonb)
      ON CONFLICT(event_key) DO NOTHING`, [input.eventKey || null,basket.id,input.provider,JSON.stringify({
      expectedAmountBrl:expectedAmount,paidAmountBrl:paidAmount,reservationsCommitted:true,raw:input.raw || {},
    })]);

    return {
      basketId:Number(basket.id),
      alreadyPaid:false,
      reviewRequired:false,
      status:"paid_awaiting_fulfillment",
      expectedAmountBrl:expectedAmount,
      paidAmountBrl:paidAmount,
      reservationsCommitted:true,
      fulfillmentStarted:false,
    };
  });
}
