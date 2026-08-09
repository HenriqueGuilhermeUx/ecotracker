import { pool, withTransaction } from "./db.js";
import { createWooviPix, fetchMercadoPagoPayment, type PaymentCheckout } from "./commerce-providers.js";
import { corporateBasketPaymentStatus } from "./corporate-basket-payment-db.js";
import { expireStaleCorporateBasketReservations } from "./corporate-basket-reservations.js";
import { evaluateAssetEligibility } from "./eligibility-policy.js";

export type BasketPaymentMethod = "pix" | "card";
type Json = Record<string, unknown>;

const money = (value: number) => Number(value.toFixed(2));
const apiUrl = () => (process.env.PUBLIC_API_URL || "https://ecotracker-api-cik7.onrender.com").replace(/\/$/, "");
const appUrl = () => (process.env.PUBLIC_APP_URL || "https://ecotracker10.netlify.app").replace(/\/$/, "");
const numberEnv = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

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

export const basketExternalReference = (publicCode: string) => `basket:${publicCode}`;
export const parseBasketExternalReference = (value: unknown) => {
  const raw = String(value || "");
  return raw.startsWith("basket:") ? raw.slice("basket:".length) : null;
};

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15000): Promise<Json> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data: Json = {};
  try { data = text ? JSON.parse(text) as Json : {}; }
  catch { data = { raw: text }; }
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function createBasketMercadoPagoCheckout(input: {
  externalReference: string;
  basketPublicCode: string;
  amountBrl: number;
  requestedKg: number;
  buyer: { name: string; email: string };
  expiresAt: string;
}): Promise<PaymentCheckout> {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw Object.assign(new Error("MP_ACCESS_TOKEN não configurado"), { code: "PROVIDER_NOT_CONFIGURED" });
  const data = await fetchJson("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{
        id: input.externalReference,
        title: `${input.requestedKg} kg CO₂e · EcoTracker Corporate`,
        description: "Basket corporativo de aquisição e aposentadoria rastreável de créditos ambientais",
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(input.amountBrl.toFixed(2)),
      }],
      payer: input.buyer,
      external_reference: input.externalReference,
      notification_url: `${apiUrl()}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${appUrl()}/?basket=${encodeURIComponent(input.basketPublicCode)}&payment=approved#marketplace`,
        pending: `${appUrl()}/?basket=${encodeURIComponent(input.basketPublicCode)}&payment=pending#marketplace`,
        failure: `${appUrl()}/?basket=${encodeURIComponent(input.basketPublicCode)}&payment=failure#marketplace`,
      },
      auto_return: "approved",
      expires: true,
      expiration_date_to: input.expiresAt,
      statement_descriptor: "ECOTRACKER",
    }),
  });
  const useSandbox = process.env.MP_USE_SANDBOX === "true";
  const checkoutUrl = useSandbox && typeof data.sandbox_init_point === "string"
    ? data.sandbox_init_point
    : typeof data.init_point === "string" ? data.init_point : null;
  if (!checkoutUrl) throw new Error("Mercado Pago não retornou URL de checkout");
  return {
    provider: "mercadopago",
    method: "card",
    providerReference: String(data.id || input.externalReference),
    status: "pending",
    checkoutUrl,
    raw: data,
  };
}

async function logBasketEvent(basketId: number, eventType: string, provider: string | null, payload: unknown, eventKey?: string) {
  await pool.query(`
    INSERT INTO corporate_basket_events(event_key,basket_id,event_type,provider,payload)
    VALUES(COALESCE($1,gen_random_uuid()::text),$2,$3,$4,$5::jsonb)
    ON CONFLICT(event_key) DO NOTHING`, [eventKey || null,basketId,eventType,provider,JSON.stringify(payload || {})]);
}

async function assertPaymentLive() {
  const status = await corporateBasketPaymentStatus();
  if (!status.live) {
    throw Object.assign(new Error("Pagamento corporativo multi-lote está implementado, mas permanece desativado neste deployment"), {
      status: 503,
      code: "CORPORATE_BASKET_PAYMENT_DISABLED",
    });
  }
  return status;
}

async function preparePayment(publicCode: string, method: BasketPaymentMethod) {
  await expireStaleCorporateBasketReservations();
  return withTransaction(async (client) => {
    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE public_code=$1 FOR UPDATE`, [publicCode]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status: 404 });
    if (basket.payment_status === "paid_awaiting_fulfillment") throw Object.assign(new Error("Pagamento do basket já foi confirmado"), { status: 409 });
    if (basket.status !== "reserved") throw Object.assign(new Error("O basket precisa estar reservado antes do checkout"), { status: 409 });
    if (!basket.final_total_brl || Number(basket.final_total_brl) <= 0) throw Object.assign(new Error("Basket sem preço final confirmado"), { status: 409 });
    const reservedUntilMs = basket.reserved_until ? new Date(basket.reserved_until).getTime() : 0;
    const quoteExpiryMs = basket.quote_expires_at ? new Date(basket.quote_expires_at).getTime() : 0;
    const hardExpiryMs = Math.min(reservedUntilMs || Infinity,quoteExpiryMs || Infinity);
    const remainingSeconds = Math.floor((hardExpiryMs-Date.now())/1000);
    if (!Number.isFinite(hardExpiryMs) || remainingSeconds < 120) {
      throw Object.assign(new Error("A janela de reserva é curta demais para abrir um checkout. Renove a reserva."), { status: 409 });
    }

    const legsResult = await client.query(`
      SELECT l.*,a.*,
             l.id AS leg_id,l.requested_kg AS leg_requested_kg,l.status AS leg_status,
             l.quote_expires_at AS leg_quote_expires_at,l.source_available_kg AS leg_source_available_kg,
             r.id AS reservation_id,r.status AS reservation_status,r.expires_at AS reservation_expires_at,r.reserved_kg
      FROM corporate_basket_legs l
      JOIN monitored_assets a ON a.id=l.asset_id
      LEFT JOIN corporate_basket_reservations r ON r.leg_id=l.id
      WHERE l.basket_id=$1
      ORDER BY l.asset_id,l.id
      FOR UPDATE OF l,a,r`, [basket.id]);
    if (!legsResult.rows.length) throw Object.assign(new Error("Basket sem legs"), { status: 409 });
    const purpose = String(objectAt(basket.buyer_snapshot).claimPurpose || "voluntary_offset");
    for (const row of legsResult.rows) {
      if (row.leg_status !== "confirmed") throw Object.assign(new Error(`Leg ${row.leg_id} não confirmada`), { status: 409 });
      if (row.reservation_status !== "active" || !row.reservation_expires_at || new Date(row.reservation_expires_at).getTime() <= Date.now()) {
        throw Object.assign(new Error(`Reserva da leg ${row.leg_id} não está ativa`), { status: 409 });
      }
      if (Number(row.reserved_kg) !== Number(row.leg_requested_kg)) throw Object.assign(new Error(`Reserva da leg ${row.leg_id} não cobre o volume integral`), { status: 409 });
      if (!row.leg_source_available_kg || Number(row.leg_source_available_kg) < Number(row.leg_requested_kg)) {
        throw Object.assign(new Error(`Estoque confirmado da leg ${row.leg_id} não cobre o volume`), { status: 409 });
      }
      const decision = evaluateAssetEligibility(row,purpose,Number(row.leg_requested_kg));
      if (!decision.allowed) throw Object.assign(new Error(`${row.project_name}: ${decision.reason}`), { status: 409, code: "LEG_NO_LONGER_ELIGIBLE" });
      const monitoredKg = row.available_tons == null ? null : Number(row.available_tons)*1000;
      if (monitoredKg != null && Number.isFinite(monitoredKg) && monitoredKg < Number(row.leg_requested_kg)) {
        throw Object.assign(new Error(`Estoque monitorado caiu abaixo da leg ${row.leg_id}`), { status: 409 });
      }
    }

    const existingResult = await client.query(`
      SELECT * FROM corporate_basket_payment_attempts WHERE basket_id=$1 AND method=$2 FOR UPDATE`, [basket.id,method]);
    const existing = existingResult.rows[0];
    if (existing) {
      if (["pending","active","paid","approved"].includes(String(existing.status))) {
        return { basket, existing, legs: legsResult.rows, remainingSeconds, hardExpiryMs, alreadyExists: true };
      }
      throw Object.assign(new Error("Já existe uma tentativa de pagamento encerrada para este método. Revise/cancele o basket antes de criar outra."), { status: 409 });
    }

    const buyer = objectAt(basket.buyer_snapshot);
    if (!buyer.contactEmail) throw Object.assign(new Error("Basket sem e-mail do contato"), { status: 409 });
    const provider = method === "pix" ? "woovi" : "mercadopago";
    const externalReference = basketExternalReference(String(basket.public_code));
    const attemptResult = await client.query(`
      INSERT INTO corporate_basket_payment_attempts
        (basket_id,provider,method,external_reference,status,amount_brl,expires_at)
      VALUES($1,$2,$3,$4,'creating',$5,$6)
      RETURNING *`, [basket.id,provider,method,externalReference,Number(basket.final_total_brl),new Date(hardExpiryMs).toISOString()]);
    await client.query(`UPDATE corporate_baskets SET status='payment_preparing',updated_at=NOW() WHERE id=$1`, [basket.id]);
    return { basket, existing: attemptResult.rows[0], legs: legsResult.rows, remainingSeconds, hardExpiryMs, alreadyExists: false };
  });
}

export async function createCorporateBasketCheckout(publicCode: string, method: BasketPaymentMethod) {
  await assertPaymentLive();
  const prepared = await preparePayment(publicCode,method);
  const attempt = prepared.existing;
  if (prepared.alreadyExists) {
    return {
      provider: attempt.provider,
      method: attempt.method,
      providerReference: attempt.provider_reference,
      status: attempt.status,
      checkoutUrl: attempt.checkout_url,
      pixBrCode: attempt.pix_br_code,
      qrCodeUrl: attempt.qr_code_url,
      amountBrl: Number(attempt.amount_brl),
      expiresAt: attempt.expires_at,
      existing: true,
    };
  }

  const basket = prepared.basket;
  const buyerSnapshot = objectAt(basket.buyer_snapshot);
  const buyer = {
    name: String(buyerSnapshot.contactName || buyerSnapshot.companyName || "Cliente EcoTracker"),
    email: String(buyerSnapshot.contactEmail),
    phone: buyerSnapshot.contactPhone == null ? null : String(buyerSnapshot.contactPhone),
    taxId: buyerSnapshot.taxId == null ? null : String(buyerSnapshot.taxId),
  };
  const amountBrl = Number(basket.final_total_brl);
  const expiresAt = new Date(prepared.hardExpiryMs).toISOString();
  const externalReference = basketExternalReference(String(basket.public_code));
  let checkout: PaymentCheckout;

  try {
    checkout = method === "pix"
      ? await createWooviPix({ quoteCode: externalReference,amountBrl,buyer,expiresInSeconds: prepared.remainingSeconds })
      : await createBasketMercadoPagoCheckout({
        externalReference,basketPublicCode:String(basket.public_code),amountBrl,requestedKg:Number(basket.covered_kg),
        buyer:{ name:buyer.name,email:buyer.email },expiresAt,
      });
  } catch (error) {
    await withTransaction(async (client) => {
      await client.query(`UPDATE corporate_basket_payment_attempts SET status='failed',raw_payload=$2::jsonb,updated_at=NOW() WHERE id=$1`, [
        attempt.id,JSON.stringify({ error:error instanceof Error ? error.message : String(error) }),
      ]);
      await client.query(`UPDATE corporate_baskets SET status='reserved',updated_at=NOW() WHERE id=$1 AND status='payment_preparing'`, [basket.id]);
    });
    throw error;
  }

  const feePct = method === "pix" ? numberEnv("ECOT_PIX_FEE_PCT",0) : numberEnv("ECOT_CARD_FEE_PCT",0);
  const estimatedFee = money(amountBrl*Math.max(0,feePct)/100);
  const taxReserve = money(amountBrl*Math.max(0,numberEnv("ECOT_TAX_RESERVE_PCT",0))/100);
  const sourceCost = Number(basket.source_cost_brl || 0);
  const netProfit = money(amountBrl-sourceCost-estimatedFee-taxReserve);

  const result = await withTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [basket.id]);
    const currentBasket = current.rows[0];
    if (!currentBasket || !["payment_preparing","reserved"].includes(String(currentBasket.status))) {
      throw new Error("Basket mudou de estado durante a criação do checkout");
    }
    if (!currentBasket.reserved_until || new Date(currentBasket.reserved_until).getTime() <= Date.now()) {
      await client.query(`UPDATE corporate_basket_payment_attempts SET status='orphaned_requires_cancel',provider_reference=$2,raw_payload=$3::jsonb,updated_at=NOW() WHERE id=$1`, [
        attempt.id,checkout.providerReference,JSON.stringify(checkout.raw || {}),
      ]);
      throw Object.assign(new Error("A reserva expirou durante a criação do checkout; o link não será exposto"), { status: 409 });
    }
    await client.query(`
      UPDATE corporate_basket_payment_attempts SET provider_reference=$2,status=$3,provider_fee_brl=$4,
        checkout_url=$5,pix_br_code=$6,qr_code_url=$7,raw_payload=$8::jsonb,updated_at=NOW()
      WHERE id=$1`, [attempt.id,checkout.providerReference,checkout.status || "pending",estimatedFee,checkout.checkoutUrl || null,
      checkout.pixBrCode || null,checkout.qrCodeUrl || null,JSON.stringify(checkout.raw || {})]);
    const updated = await client.query(`
      UPDATE corporate_baskets SET status='awaiting_payment',payment_status='pending',checkout_enabled=TRUE,
        payment_provider=$2,payment_method=$3,payment_reference=$4,payment_url=$5,pix_br_code=$6,pix_qr_code_url=$7,
        payment_fee_brl=$8,tax_reserve_brl=$9,net_profit_brl=$10,updated_at=NOW()
      WHERE id=$1 RETURNING *`, [basket.id,checkout.provider,method,checkout.providerReference,checkout.checkoutUrl || null,
      checkout.pixBrCode || null,checkout.qrCodeUrl || null,estimatedFee,taxReserve,netProfit]);
    return updated.rows[0];
  });
  await logBasketEvent(Number(basket.id),"payment.checkout_created",checkout.provider,checkout.raw);
  return { ...checkout,amountBrl,expiresAt,basketStatus:result.status,existing:false };
}

export async function markCorporateBasketPaymentApproved(input: {
  basketCode: string;
  provider: string;
  providerReference: string;
  paidAmountBrl?: number;
  providerFeeBrl?: number;
  raw?: unknown;
  eventKey?: string;
}) {
  const result = await withTransaction(async (client) => {
    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE public_code=$1 FOR UPDATE`, [input.basketCode]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado para o pagamento"), { status: 404 });
    if (basket.payment_status === "paid_awaiting_fulfillment") return { basketId:Number(basket.id),alreadyPaid:true,reviewRequired:false };

    const attemptResult = await client.query(`
      SELECT * FROM corporate_basket_payment_attempts
      WHERE basket_id=$1 AND provider=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [basket.id,input.provider]);
    const attempt = attemptResult.rows[0];
    if (!attempt) throw Object.assign(new Error("Tentativa de pagamento do basket não encontrada"), { status: 404 });
    const expected = Number(basket.final_total_brl || attempt.amount_brl || 0);
    const paidAmount = input.paidAmountBrl == null ? null : money(input.paidAmountBrl);
    const amountMatches = paidAmount != null && Math.abs(paidAmount-expected) <= 0.01;
    const fee = input.providerFeeBrl == null ? Number(attempt.provider_fee_brl || basket.payment_fee_brl || 0) : Math.max(0,input.providerFeeBrl);
    const taxReserve = Number(basket.tax_reserve_brl || 0);
    const sourceCost = Number(basket.source_cost_brl || 0);
    const netProfit = money(expected-sourceCost-fee-taxReserve);

    await client.query(`
      UPDATE corporate_basket_reservations SET status='committed',updated_at=NOW()
      WHERE basket_id=$1 AND status='active'`, [basket.id]);

    if (!amountMatches) {
      await client.query(`
        UPDATE corporate_basket_payment_attempts SET status='amount_mismatch',provider_reference=$2,
          provider_fee_brl=$3,raw_payload=raw_payload || $4::jsonb,updated_at=NOW()
        WHERE id=$1`, [attempt.id,input.providerReference,fee,JSON.stringify(input.raw || {})]);
      await client.query(`
        UPDATE corporate_baskets SET status='payment_review_required',payment_status='review_required',checkout_enabled=FALSE,
          payment_provider=$2,payment_reference=$3,payment_fee_brl=$4,net_profit_brl=$5,updated_at=NOW()
        WHERE id=$1`, [basket.id,input.provider,input.providerReference,fee,netProfit]);
      return { basketId:Number(basket.id),alreadyPaid:false,reviewRequired:true,expectedAmountBrl:expected,paidAmountBrl:paidAmount };
    }

    await client.query(`
      UPDATE corporate_basket_payment_attempts SET status='paid',provider_reference=$2,provider_fee_brl=$3,
        raw_payload=raw_payload || $4::jsonb,paid_at=NOW(),updated_at=NOW()
      WHERE id=$1`, [attempt.id,input.providerReference,fee,JSON.stringify(input.raw || {})]);
    await client.query(`
      UPDATE corporate_baskets SET status='paid_awaiting_fulfillment',payment_status='paid_awaiting_fulfillment',
        checkout_enabled=FALSE,payment_provider=$2,payment_reference=$3,payment_fee_brl=$4,net_profit_brl=$5,
        paid_at=NOW(),updated_at=NOW()
      WHERE id=$1`, [basket.id,input.provider,input.providerReference,fee,netProfit]);
    return { basketId:Number(basket.id),alreadyPaid:false,reviewRequired:false,expectedAmountBrl:expected,paidAmountBrl:paidAmount };
  });

  await logBasketEvent(result.basketId,result.reviewRequired ? "payment.amount_mismatch" : "payment.approved",input.provider,input.raw || {},input.eventKey);
  return result;
}

export async function getCorporateBasketPayment(publicCode: string) {
  const { rows } = await pool.query(`
    SELECT b.public_code,b.status,b.payment_status,b.checkout_enabled,b.payment_provider,b.payment_method,
           b.payment_reference,b.payment_url,b.pix_br_code,b.pix_qr_code_url,b.final_total_brl,b.reserved_until,b.paid_at,
           p.status AS attempt_status,p.expires_at AS payment_expires_at,p.provider_reference AS attempt_reference
    FROM corporate_baskets b
    LEFT JOIN LATERAL (
      SELECT * FROM corporate_basket_payment_attempts x WHERE x.basket_id=b.id ORDER BY x.created_at DESC LIMIT 1
    ) p ON TRUE
    WHERE b.public_code=$1`, [publicCode]);
  return rows[0] || null;
}

export { fetchMercadoPagoPayment };
