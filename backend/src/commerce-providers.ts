import { executeCarbonmarkRetirement } from "./carbonmark.js";
import { pool } from "./db.js";

type Buyer = {
  name: string;
  email: string;
  phone?: string | null;
  taxId?: string | null;
};

export type PaymentCheckout = {
  provider: "woovi" | "mercadopago";
  method: "pix" | "card";
  providerReference: string;
  status: string;
  checkoutUrl?: string | null;
  pixBrCode?: string | null;
  qrCodeUrl?: string | null;
  raw: unknown;
};

export type ExecutorResult = {
  configured: boolean;
  status: "completed" | "processing" | "blocked";
  reference?: string | null;
  txHash?: string | null;
  retired?: boolean;
  metadata?: Record<string, unknown>;
};

const appUrl = () => (process.env.PUBLIC_APP_URL || "https://ecotracker10.netlify.app").replace(/\/$/, "");
const apiUrl = () => (process.env.PUBLIC_API_URL || "https://ecotracker-api-cik7.onrender.com").replace(/\/$/, "");

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; }
  catch { data = { raw: text }; }
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function createWooviPix(input: {
  quoteCode: string;
  amountBrl: number;
  buyer: Buyer;
  expiresInSeconds?: number;
}): Promise<PaymentCheckout> {
  const appId = process.env.WOOVI_APP_ID;
  if (!appId) throw Object.assign(new Error("WOOVI_APP_ID não configurado"), { code: "PROVIDER_NOT_CONFIGURED" });

  const value = Math.max(1, Math.round(input.amountBrl * 100));
  const customer: Record<string, string> = { name: input.buyer.name, email: input.buyer.email };
  if (input.buyer.phone) customer.phone = input.buyer.phone.replace(/\D/g, "");
  if (input.buyer.taxId) customer.taxID = input.buyer.taxId;

  const data = await fetchJson("https://api.woovi.com/api/openpix/v1/charge?return_existing=true", {
    method: "POST",
    headers: { Authorization: appId, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      correlationID: input.quoteCode,
      value,
      type: "DYNAMIC",
      expiresIn: input.expiresInSeconds || 1800,
      comment: `EcoTracker · ${input.quoteCode}`,
      customer,
    }),
  });

  const charge = (data.charge || {}) as Record<string, unknown>;
  return {
    provider: "woovi",
    method: "pix",
    providerReference: String(charge.identifier || charge.correlationID || input.quoteCode),
    status: String(charge.status || "ACTIVE").toLowerCase(),
    checkoutUrl: typeof charge.paymentLinkUrl === "string" ? charge.paymentLinkUrl : null,
    pixBrCode: typeof data.brCode === "string" ? data.brCode : typeof charge.brCode === "string" ? charge.brCode : null,
    qrCodeUrl: typeof charge.qrCodeImage === "string" ? charge.qrCodeImage : null,
    raw: data,
  };
}

export async function createMercadoPagoCheckout(input: {
  quoteCode: string;
  amountBrl: number;
  requestedKg: number;
  buyer: Buyer;
}): Promise<PaymentCheckout> {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw Object.assign(new Error("MP_ACCESS_TOKEN não configurado"), { code: "PROVIDER_NOT_CONFIGURED" });

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const data = await fetchJson("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{
        id: input.quoteCode,
        title: `${input.requestedKg} ECOT · EcoTracker`,
        description: "Serviço de aquisição, aposentadoria e alocação rastreável de impacto ambiental",
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(input.amountBrl.toFixed(2)),
      }],
      payer: { name: input.buyer.name, email: input.buyer.email },
      external_reference: input.quoteCode,
      notification_url: `${apiUrl()}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${appUrl()}/?payment=approved#marketplace`,
        pending: `${appUrl()}/?payment=pending#marketplace`,
        failure: `${appUrl()}/?payment=failure#marketplace`,
      },
      auto_return: "approved",
      expires: true,
      expiration_date_to: expiresAt,
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
    providerReference: String(data.id || input.quoteCode),
    status: "pending",
    checkoutUrl,
    raw: data,
  };
}

export async function fetchMercadoPagoPayment(paymentId: string): Promise<Record<string, unknown>> {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN não configurado");
  return fetchJson(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
}

async function executeCarbonmarkSource(payload: Record<string, unknown>): Promise<ExecutorResult> {
  const sourceReference = String(payload.sourceReference || "");
  if (!sourceReference.startsWith("carbonmark-")) throw new Error("Fonte Carbonmark inválida");
  const quoteUuid = String(payload.sourceOrderId || "");
  if (!quoteUuid) return { configured: true, status: "blocked", metadata: { reason: "Carbonmark quote UUID ausente" } };
  if (!process.env.CARBONMARK_API_KEY) return { configured: false, status: "blocked", metadata: { reason: "CARBONMARK_API_KEY não configurada" } };

  const result = await executeCarbonmarkRetirement({
    quoteUuid,
    beneficiaryName: String(payload.beneficiary || "EcoTracker beneficiary"),
    retirementMessage: `EcoTracker ${String(payload.quoteCode || quoteUuid)} · ${String(payload.requestedKg || "")} kg CO2e`,
  });

  const metadata: Record<string, unknown> = {
    provider: "carbonmark",
    status: result.status,
    viewRetirementUrl: result.viewRetirementUrl,
    certificateUrl: result.certificateUrl,
    provenanceUrl: result.provenanceUrl,
    retirementId: result.retirementId,
    raw: result.raw,
  };

  if (result.status === "completed") {
    await pool.query(`
      UPDATE quote_requests SET
        retirement_reference=$2,
        retirement_tx_hash=$3,
        retired_at=COALESCE(retired_at,NOW()),
        pricing_snapshot=pricing_snapshot || jsonb_build_object('carbonmarkRetirement',$4::jsonb),
        updated_at=NOW()
      WHERE public_code=$1`,
      [String(payload.quoteCode || ""), result.reference, result.txHash, JSON.stringify(metadata)],
    );
  }

  return {
    configured: true,
    status: result.status,
    reference: result.reference,
    txHash: result.txHash,
    retired: result.status === "completed",
    metadata,
  };
}

export async function callCommerceExecutor(
  stage: "source" | "retire" | "deliver",
  payload: Record<string, unknown>,
): Promise<ExecutorResult> {
  if (stage === "source" && String(payload.sourceReference || "").startsWith("carbonmark-")) {
    return executeCarbonmarkSource(payload);
  }

  const urlKey = stage === "source" ? "SOURCE_EXECUTOR_URL" : stage === "retire" ? "RETIREMENT_EXECUTOR_URL" : "DELIVERY_EXECUTOR_URL";
  const tokenKey = stage === "source" ? "SOURCE_EXECUTOR_TOKEN" : stage === "retire" ? "RETIREMENT_EXECUTOR_TOKEN" : "DELIVERY_EXECUTOR_TOKEN";
  const url = process.env[urlKey];
  if (!url) return { configured: false, status: "blocked", metadata: { reason: `${urlKey} não configurado` } };

  const token = process.env[tokenKey];
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await fetchJson(url, { method: "POST", headers, body: JSON.stringify({ stage, ...payload }) }, 30000);
  const rawStatus = String(data.status || "completed").toLowerCase();
  const status: ExecutorResult["status"] = rawStatus === "processing" || rawStatus === "pending" ? "processing" : rawStatus === "blocked" ? "blocked" : "completed";
  return {
    configured: true,
    status,
    reference: data.reference == null ? null : String(data.reference),
    txHash: data.txHash == null && data.tx_hash == null ? null : String(data.txHash || data.tx_hash),
    retired: data.retired === true,
    metadata: data,
  };
}

export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ sent: boolean; reference?: string; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return { sent: false, reason: "RESEND_API_KEY ou EMAIL_FROM não configurado" };
  const data = await fetchJson("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
  });
  return { sent: true, reference: data.id == null ? undefined : String(data.id) };
}

export async function issueNfseWithProvider(payload: Record<string, unknown>): Promise<ExecutorResult> {
  const url = process.env.NFSE_PROVIDER_URL;
  if (!url) return { configured: false, status: "blocked", metadata: { reason: "NFSE_PROVIDER_URL não configurado" } };
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (process.env.NFSE_PROVIDER_TOKEN) headers.Authorization = `Bearer ${process.env.NFSE_PROVIDER_TOKEN}`;
  const data = await fetchJson(url, { method: "POST", headers, body: JSON.stringify(payload) }, 30000);
  return {
    configured: true,
    status: String(data.status || "completed").toLowerCase() === "processing" ? "processing" : "completed",
    reference: data.reference == null ? null : String(data.reference),
    metadata: data,
  };
}
