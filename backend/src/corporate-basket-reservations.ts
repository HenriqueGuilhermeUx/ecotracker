import { withTransaction } from "./db.js";
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

export async function reserveCorporateBasket(input: {
  basketId: number;
  reservationMinutes?: number;
}) {
  return withTransaction(async (client) => {
    await client.query(`
      UPDATE corporate_basket_reservations
      SET status='expired',updated_at=NOW()
      WHERE status='active' AND expires_at<=NOW()`);

    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [input.basketId]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status: 404 });
    if (basket.status === "cancelled") throw Object.assign(new Error("Basket cancelado"), { status: 409 });
    if (basket.status === "expired") throw Object.assign(new Error("Basket expirado"), { status: 409 });
    if (!["quoted","reserved"].includes(String(basket.status))) {
      throw Object.assign(new Error("Todas as legs precisam estar confirmadas e o basket cotado antes da reserva"), { status: 409 });
    }
    const basketExpiry = basket.quote_expires_at ? new Date(basket.quote_expires_at).getTime() : 0;
    if (!basketExpiry || basketExpiry <= Date.now()) {
      await client.query(`UPDATE corporate_baskets SET status='expired',reserved_until=NULL,updated_at=NOW() WHERE id=$1`, [basket.id]);
      throw Object.assign(new Error("A cotação do basket expirou"), { status: 409 });
    }

    const legResult = await client.query(`
      SELECT l.*,a.*,
             l.id AS leg_id,l.requested_kg AS leg_requested_kg,l.status AS leg_status,
             l.quote_expires_at AS leg_quote_expires_at,l.source_available_kg AS leg_source_available_kg
      FROM corporate_basket_legs l
      JOIN monitored_assets a ON a.id=l.asset_id
      WHERE l.basket_id=$1
      ORDER BY l.asset_id,l.id
      FOR UPDATE OF l,a`, [basket.id]);
    if (!legResult.rows.length) throw Object.assign(new Error("Basket sem legs"), { status: 409 });

    const purpose = String(objectAt(basket.buyer_snapshot).claimPurpose || "voluntary_offset");
    for (const row of legResult.rows) {
      if (row.leg_status !== "confirmed") throw Object.assign(new Error(`Leg ${row.leg_id} não está confirmada`), { status: 409 });
      const legExpiry = row.leg_quote_expires_at ? new Date(row.leg_quote_expires_at).getTime() : 0;
      if (!legExpiry || legExpiry <= Date.now()) throw Object.assign(new Error(`A confirmação da leg ${row.leg_id} expirou`), { status: 409 });
      const decision = evaluateAssetEligibility(row, purpose, Number(row.leg_requested_kg));
      if (!decision.allowed) {
        throw Object.assign(new Error(`${row.project_name}: ${decision.reason}`), { status: 409, code: "LEG_NO_LONGER_ELIGIBLE" });
      }
      const monitoredCapacityKg = row.available_tons == null ? null : Number(row.available_tons) * 1000;
      const confirmedCapacityKg = row.leg_source_available_kg == null ? null : Number(row.leg_source_available_kg);
      const capacity = monitoredCapacityKg == null
        ? confirmedCapacityKg
        : confirmedCapacityKg == null
          ? monitoredCapacityKg
          : Math.min(monitoredCapacityKg,confirmedCapacityKg);
      if (capacity == null || !Number.isFinite(capacity)) {
        throw Object.assign(new Error(`A leg ${row.leg_id} precisa de capacidade conhecida antes da reserva`), { status: 409 });
      }
      if (Number(row.leg_requested_kg) > capacity + 0.000001) {
        throw Object.assign(new Error(`Estoque insuficiente para reservar ${row.project_name}`), { status: 409 });
      }
    }

    const requestedMs = Math.max(5,Math.min(120,Math.round(input.reservationMinutes || 15))) * 60 * 1000;
    const legExpiryMin = Math.min(...legResult.rows.map((row) => new Date(row.leg_quote_expires_at).getTime()));
    const reservedUntilMs = Math.min(Date.now()+requestedMs,basketExpiry,legExpiryMin);
    if (reservedUntilMs <= Date.now()) throw Object.assign(new Error("Não há janela válida para reserva"), { status: 409 });
    const reservedUntil = new Date(reservedUntilMs).toISOString();

    for (const row of legResult.rows) {
      await client.query(`
        INSERT INTO corporate_basket_reservations
          (basket_id,leg_id,asset_id,reserved_kg,status,expires_at)
        VALUES($1,$2,$3,$4,'active',$5)
        ON CONFLICT(leg_id) DO UPDATE SET
          basket_id=EXCLUDED.basket_id,asset_id=EXCLUDED.asset_id,reserved_kg=EXCLUDED.reserved_kg,
          status='active',expires_at=EXCLUDED.expires_at,released_at=NULL,consumed_at=NULL,updated_at=NOW()`, [
        basket.id,row.leg_id,row.asset_id,Number(row.leg_requested_kg),reservedUntil,
      ]);
    }

    const countResult = await client.query(`
      SELECT COUNT(*)::int AS active_count,COALESCE(SUM(reserved_kg),0)::bigint AS reserved_kg
      FROM corporate_basket_reservations
      WHERE basket_id=$1 AND status='active' AND expires_at>NOW()`, [basket.id]);
    if (Number(countResult.rows[0]?.active_count || 0) !== legResult.rows.length) {
      throw new Error("Falha ao reservar todas as legs atomicamente");
    }

    const snapshot = {
      ...objectAt(basket.pricing_snapshot),
      reservation: {
        status: "active",
        reservedUntil,
        legs: legResult.rows.length,
        reservedKg: Number(countResult.rows[0]?.reserved_kg || 0),
        localReservationOnly: true,
        externalProviderRecheckRequiredBeforePayment: true,
      },
    };
    const updated = await client.query(`
      UPDATE corporate_baskets SET status='reserved',reserved_until=$2,pricing_snapshot=$3::jsonb,
        checkout_enabled=FALSE,payment_status='disabled',updated_at=NOW()
      WHERE id=$1 RETURNING *`, [basket.id,reservedUntil,JSON.stringify(snapshot)]);

    return {
      ...updated.rows[0],
      reservations: legResult.rows.map((row) => ({ legId: row.leg_id,assetId: row.asset_id,reservedKg: Number(row.leg_requested_kg),expiresAt: reservedUntil })),
      checkoutReady: false,
      paymentEnabled: false,
      message: "Todas as legs foram reservadas atomicamente no controle local. A disponibilidade externa ainda deverá ser revalidada imediatamente antes da futura cobrança.",
    };
  });
}

export async function releaseCorporateBasketReservations(basketId: number) {
  return withTransaction(async (client) => {
    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [basketId]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status: 404 });
    if (basket.status === "cancelled") throw Object.assign(new Error("Basket cancelado"), { status: 409 });

    const release = await client.query(`
      UPDATE corporate_basket_reservations
      SET status='released',released_at=NOW(),updated_at=NOW()
      WHERE basket_id=$1 AND status='active'
      RETURNING id,reserved_kg`, [basket.id]);

    const stillValid = basket.quote_expires_at && new Date(basket.quote_expires_at).getTime()>Date.now();
    const status = stillValid ? "quoted" : "expired";
    const snapshot = {
      ...objectAt(basket.pricing_snapshot),
      reservation: {
        status: "released",
        releasedAt: new Date().toISOString(),
        releasedLegs: release.rows.length,
      },
    };
    const updated = await client.query(`
      UPDATE corporate_baskets SET status=$2,reserved_until=NULL,pricing_snapshot=$3::jsonb,
        checkout_enabled=FALSE,payment_status='disabled',updated_at=NOW()
      WHERE id=$1 RETURNING *`, [basket.id,status,JSON.stringify(snapshot)]);
    return { ...updated.rows[0], releasedLegs: release.rows.length };
  });
}

export async function expireStaleCorporateBasketReservations() {
  return withTransaction(async (client) => {
    const expired = await client.query(`
      UPDATE corporate_basket_reservations
      SET status='expired',updated_at=NOW()
      WHERE status='active' AND expires_at<=NOW()
      RETURNING basket_id`);
    const basketIds = [...new Set(expired.rows.map((row) => Number(row.basket_id)))];
    if (basketIds.length) {
      await client.query(`
        UPDATE corporate_baskets SET status=CASE WHEN quote_expires_at>NOW() THEN 'quoted' ELSE 'expired' END,
          reserved_until=NULL,checkout_enabled=FALSE,payment_status='disabled',updated_at=NOW()
        WHERE id=ANY($1::bigint[]) AND status='reserved'`, [basketIds]);
    }
    return { expiredReservations: expired.rows.length, basketsReleased: basketIds.length };
  });
}
