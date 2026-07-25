import { pool, withTransaction } from "./db.js";
import {
  callCommerceExecutor,
  createMercadoPagoCheckout,
  createWooviPix,
  issueNfseWithProvider,
  sendTransactionalEmail,
  type PaymentCheckout,
} from "./commerce-providers.js";

export type PaymentMethod = "pix" | "card";

type PricingResult = {
  automatic: boolean;
  sourceCostBrl: number | null;
  finalTotalBrl: number | null;
  grossProfitBrl: number | null;
  quoteExpiresAt: string | null;
  snapshot: Record<string, unknown>;
};

const numberEnv = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

const money = (value: number) => Number(value.toFixed(2));
const appUrl = () => (process.env.PUBLIC_APP_URL || "https://ecotracker10.netlify.app").replace(/\/$/, "");

export function calculateAutomaticPricing(asset: Record<string, unknown>, requestedKg: number): PricingResult {
  const sourcePriceUsdTon = Number(asset.source_price_usd_ton);
  const fx = Number(asset.fx_brl_usd);
  const marginPct = Number(asset.service_margin_pct);
  const fixedFee = Number(asset.fixed_fee_brl || 0);
  const minServiceFee = numberEnv("ECOT_MIN_SERVICE_FEE_BRL", 29.9);
  const availableTons = asset.available_tons == null ? null : Number(asset.available_tons);
  const enoughVolume = availableTons == null || !Number.isFinite(availableTons) || availableTons * 1000 >= requestedKg;

  if (!Number.isFinite(sourcePriceUsdTon) || sourcePriceUsdTon <= 0 || !Number.isFinite(fx) || fx <= 0 || !enoughVolume) {
    return {
      automatic: false,
      sourceCostBrl: null,
      finalTotalBrl: null,
      grossProfitBrl: null,
      quoteExpiresAt: null,
      snapshot: {
        pricingMode: "assisted",
        reason: !enoughVolume ? "insufficient_monitored_volume" : "source_price_unavailable",
        requestedKg,
        availableTons,
      },
    };
  }

  const sourceCost = sourcePriceUsdTon * fx * requestedKg / 1000;
  const percentageServiceRevenue = sourceCost * Math.max(0, marginPct) / 100;
  const serviceRevenue = Math.max(percentageServiceRevenue, minServiceFee) + Math.max(0, fixedFee);
  const finalTotal = sourceCost + serviceRevenue;
  const expiresAt = new Date(Date.now() + numberEnv("ECOT_QUOTE_TTL_MINUTES", 15) * 60 * 1000).toISOString();

  return {
    automatic: true,
    sourceCostBrl: money(sourceCost),
    finalTotalBrl: money(finalTotal),
    grossProfitBrl: money(serviceRevenue),
    quoteExpiresAt: expiresAt,
    snapshot: {
      pricingMode: "automatic",
      sourcePriceUsdTon,
      fxBrlUsd: fx,
      serviceMarginPct: marginPct,
      minimumServiceFeeBrl: minServiceFee,
      fixedFeeBrl: fixedFee,
      requestedKg,
      sourceReference: asset.source_reference,
      capturedAt: new Date().toISOString(),
    },
  };
}

export async function enqueueAutomationJob(
  quoteId: number,
  jobType: "source_asset" | "retire_asset" | "deliver_ecot" | "issue_receipt" | "issue_nfse",
  payload: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO automation_jobs(quote_id,job_type,idempotency_key,payload)
     VALUES($1,$2,$3,$4::jsonb)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [quoteId, jobType, `quote:${quoteId}:${jobType}`, JSON.stringify(payload)],
  );
}

async function logEvent(quoteId: number | null, eventType: string, provider: string | null, payload: unknown, eventKey?: string) {
  await pool.query(
    `INSERT INTO commerce_events(event_key,quote_id,event_type,provider,payload)
     VALUES(COALESCE($1,gen_random_uuid()::text),$2,$3,$4,$5::jsonb)
     ON CONFLICT(event_key) DO NOTHING`,
    [eventKey || null, quoteId, eventType, provider, JSON.stringify(payload || {})],
  );
}

export async function createCheckout(publicCode: string, method: PaymentMethod): Promise<PaymentCheckout & { amountBrl: number }> {
  const quoteResult = await pool.query(
    `SELECT q.*,a.registry,a.project_name,a.source_reference,a.monitor_details
     FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id
     WHERE q.public_code=$1`,
    [publicCode],
  );
  const quote = quoteResult.rows[0];
  if (!quote) throw Object.assign(new Error("Cotação não encontrada"), { status: 404 });
  if (!quote.final_total || Number(quote.final_total) <= 0) throw Object.assign(new Error("A cotação ainda não possui valor final"), { status: 409 });
  if (quote.quote_expires_at && new Date(quote.quote_expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error("A cotação expirou. Solicite uma atualização de preço."), { status: 409 });
  }
  if (!["quoted", "awaiting_payment"].includes(String(quote.status))) {
    throw Object.assign(new Error("Esta cotação ainda não está liberada para pagamento"), { status: 409 });
  }
  if (quote.payment_status === "paid") throw Object.assign(new Error("Pagamento já confirmado"), { status: 409 });

  const existing = await pool.query(
    `SELECT * FROM payment_attempts WHERE quote_id=$1 AND method=$2 AND status IN ('created','active','pending') ORDER BY created_at DESC LIMIT 1`,
    [quote.id, method],
  );
  if (existing.rows[0]) {
    const attempt = existing.rows[0];
    return {
      provider: attempt.provider,
      method: attempt.method,
      providerReference: attempt.provider_reference,
      status: attempt.status,
      checkoutUrl: attempt.checkout_url,
      pixBrCode: attempt.pix_br_code,
      qrCodeUrl: attempt.qr_code_url,
      raw: attempt.raw_payload,
      amountBrl: Number(attempt.amount_brl),
    } as PaymentCheckout & { amountBrl: number };
  }

  const amountBrl = Number(quote.final_total);
  const buyer = { name: quote.buyer_name, email: quote.buyer_email, phone: quote.buyer_phone, taxId: quote.tax_id };
  const checkout = method === "pix"
    ? await createWooviPix({ quoteCode: quote.public_code, amountBrl, buyer })
    : await createMercadoPagoCheckout({ quoteCode: quote.public_code, amountBrl, requestedKg: Number(quote.requested_kg), buyer });

  const feePct = method === "pix" ? numberEnv("ECOT_PIX_FEE_PCT", 0) : numberEnv("ECOT_CARD_FEE_PCT", 0);
  const estimatedFee = money(amountBrl * Math.max(0, feePct) / 100);
  const taxPct = numberEnv("ECOT_TAX_RESERVE_PCT", 0);
  const taxReserve = money(amountBrl * Math.max(0, taxPct) / 100);
  const sourceCost = quote.source_cost_brl == null ? null : Number(quote.source_cost_brl);
  const netProfit = sourceCost == null ? null : money(amountBrl - sourceCost - estimatedFee - taxReserve);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO payment_attempts
        (quote_id,provider,method,provider_reference,status,amount_brl,provider_fee_brl,checkout_url,pix_br_code,qr_code_url,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [quote.id, checkout.provider, method, checkout.providerReference, checkout.status, amountBrl, estimatedFee,
        checkout.checkoutUrl || null, checkout.pixBrCode || null, checkout.qrCodeUrl || null, JSON.stringify(checkout.raw || {})],
    );
    await client.query(
      `UPDATE quote_requests SET status='awaiting_payment',payment_provider=$2,payment_method=$3,
         payment_status='pending',payment_reference=$4,payment_url=$5,pix_br_code=$6,pix_qr_code_url=$7,
         payment_fee_brl=$8,tax_reserve_brl=$9,gross_revenue_brl=final_total,
         gross_profit_brl=CASE WHEN source_cost_brl IS NULL THEN NULL ELSE final_total-source_cost_brl END,
         net_profit_brl=$10,updated_at=NOW()
       WHERE id=$1`,
      [quote.id, checkout.provider, method, checkout.providerReference, checkout.checkoutUrl || null,
        checkout.pixBrCode || null, checkout.qrCodeUrl || null, estimatedFee, taxReserve, netProfit],
    );
  });
  await logEvent(Number(quote.id), "payment.checkout_created", checkout.provider, checkout.raw);
  return { ...checkout, amountBrl };
}

export async function markPaymentApproved(input: {
  quoteCode: string;
  provider: string;
  providerReference: string;
  providerFeeBrl?: number;
  raw?: unknown;
  eventKey?: string;
}): Promise<{ quoteId: number; alreadyPaid: boolean }> {
  const result = await withTransaction(async (client) => {
    const quoteResult = await client.query("SELECT * FROM quote_requests WHERE public_code=$1 FOR UPDATE", [input.quoteCode]);
    const quote = quoteResult.rows[0];
    if (!quote) throw Object.assign(new Error("Cotação não encontrada para o pagamento"), { status: 404 });
    if (quote.payment_status === "paid") return { quoteId: Number(quote.id), alreadyPaid: true };

    const actualFee = input.providerFeeBrl == null ? Number(quote.payment_fee_brl || 0) : Math.max(0, input.providerFeeBrl);
    const revenue = Number(quote.final_total || 0);
    const sourceCost = quote.source_cost_brl == null ? null : Number(quote.source_cost_brl);
    const taxReserve = Number(quote.tax_reserve_brl || 0);
    const netProfit = sourceCost == null ? null : money(revenue - sourceCost - actualFee - taxReserve);

    await client.query(
      `UPDATE quote_requests SET payment_status='paid',status='sourcing',payment_provider=$2,
         payment_reference=$3,payment_fee_brl=$4,net_profit_brl=$5,paid_at=NOW(),
         sourcing_status=CASE WHEN sourcing_status='not_started' THEN 'queued' ELSE sourcing_status END,updated_at=NOW()
       WHERE id=$1`,
      [quote.id, input.provider, input.providerReference, actualFee, netProfit],
    );
    await client.query(
      `UPDATE payment_attempts SET status='paid',paid_at=NOW(),updated_at=NOW(),provider_fee_brl=$3,
         raw_payload=raw_payload || $4::jsonb
       WHERE quote_id=$1 AND provider=$2`,
      [quote.id, input.provider, actualFee, JSON.stringify(input.raw || {})],
    );
    return { quoteId: Number(quote.id), alreadyPaid: false };
  });

  await logEvent(result.quoteId, "payment.approved", input.provider, input.raw || {}, input.eventKey);
  if (!result.alreadyPaid) await enqueueAutomationJob(result.quoteId, "source_asset");
  return result;
}

async function loadQuoteForAutomation(quoteId: number) {
  const { rows } = await pool.query(
    `SELECT q.*,a.registry,a.project_name,a.source_reference,a.source_url,a.monitor_details,a.source_price_usd_ton,a.fx_brl_usd
     FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id WHERE q.id=$1`,
    [quoteId],
  );
  if (!rows[0]) throw new Error("Cotação da automação não encontrada");
  return rows[0];
}

async function finishJob(jobId: number, status: "completed" | "blocked" | "retry", result: unknown, error?: string, delaySeconds = 60) {
  await pool.query(
    `UPDATE automation_jobs SET status=$2,result=$3::jsonb,last_error=$4,
       run_after=CASE WHEN $2='retry' THEN NOW()+($5 || ' seconds')::interval ELSE run_after END,
       completed_at=CASE WHEN $2 IN ('completed','blocked') THEN NOW() ELSE NULL END,
       updated_at=NOW() WHERE id=$1`,
    [jobId, status, JSON.stringify(result || {}), error || null, String(delaySeconds)],
  );
}

async function queuePostRetirement(quoteId: number) {
  await Promise.all([
    enqueueAutomationJob(quoteId, "deliver_ecot"),
    enqueueAutomationJob(quoteId, "issue_receipt"),
    enqueueAutomationJob(quoteId, "issue_nfse"),
  ]);
}

async function processSourceJob(job: Record<string, unknown>, quote: Record<string, unknown>) {
  const payload = {
    idempotencyKey: job.idempotency_key,
    quoteCode: quote.public_code,
    registry: quote.registry,
    sourceReference: quote.source_reference,
    sourceOrderId: quote.source_order_id || (quote.monitor_details as Record<string, unknown> | null)?.sellOrderId || null,
    sourceBatchDenom: quote.source_batch_denom || (quote.monitor_details as Record<string, unknown> | null)?.batchDenom || null,
    requestedKg: Number(quote.requested_kg),
    requestedTons: Number(quote.requested_kg) / 1000,
    sourceCostBrl: quote.source_cost_brl,
    purpose: quote.purpose,
    beneficiary: quote.company_name || quote.buyer_name,
  };
  const execution = await callCommerceExecutor("source", payload);
  if (!execution.configured || execution.status === "blocked") {
    await pool.query("UPDATE quote_requests SET sourcing_status='awaiting_configuration',updated_at=NOW() WHERE id=$1", [quote.id]);
    await finishJob(Number(job.id), "blocked", execution.metadata || {});
    return;
  }
  if (execution.status === "processing") {
    await pool.query("UPDATE quote_requests SET sourcing_status='processing',updated_at=NOW() WHERE id=$1", [quote.id]);
    await finishJob(Number(job.id), "retry", execution.metadata || {}, undefined, 90);
    return;
  }

  await pool.query(
    `UPDATE quote_requests SET sourcing_status='acquired',sourcing_provider=$2,sourcing_reference=$3,
       sourcing_tx_hash=$4,retirement_status=CASE WHEN $5 THEN 'retired' ELSE 'queued' END,
       retired_at=CASE WHEN $5 THEN NOW() ELSE retired_at END,status=CASE WHEN $5 THEN 'retired' ELSE 'sourcing' END,updated_at=NOW()
     WHERE id=$1`,
    [quote.id, String(quote.registry), execution.reference || null, execution.txHash || null, execution.retired === true],
  );
  await finishJob(Number(job.id), "completed", execution.metadata || {});
  await logEvent(Number(quote.id), "sourcing.completed", String(quote.registry), execution.metadata || {});
  if (execution.retired) await queuePostRetirement(Number(quote.id));
  else await enqueueAutomationJob(Number(quote.id), "retire_asset");
}

async function processRetirementJob(job: Record<string, unknown>, quote: Record<string, unknown>) {
  const execution = await callCommerceExecutor("retire", {
    idempotencyKey: job.idempotency_key,
    quoteCode: quote.public_code,
    registry: quote.registry,
    sourceReference: quote.source_reference,
    sourcingReference: quote.sourcing_reference,
    sourcingTxHash: quote.sourcing_tx_hash,
    requestedKg: Number(quote.requested_kg),
    requestedTons: Number(quote.requested_kg) / 1000,
    beneficiary: quote.company_name || quote.buyer_name,
    retirementReason: `EcoTracker ${quote.public_code} · ${quote.purpose}`,
  });
  if (!execution.configured || execution.status === "blocked") {
    await pool.query("UPDATE quote_requests SET retirement_status='awaiting_configuration',updated_at=NOW() WHERE id=$1", [quote.id]);
    await finishJob(Number(job.id), "blocked", execution.metadata || {});
    return;
  }
  if (execution.status === "processing") {
    await pool.query("UPDATE quote_requests SET retirement_status='processing',updated_at=NOW() WHERE id=$1", [quote.id]);
    await finishJob(Number(job.id), "retry", execution.metadata || {}, undefined, 90);
    return;
  }

  await pool.query(
    `UPDATE quote_requests SET retirement_status='retired',retirement_reference=$2,retirement_tx_hash=$3,
       retired_at=NOW(),status='retired',updated_at=NOW() WHERE id=$1`,
    [quote.id, execution.reference || null, execution.txHash || null],
  );
  await finishJob(Number(job.id), "completed", execution.metadata || {});
  await logEvent(Number(quote.id), "retirement.completed", String(quote.registry), execution.metadata || {});
  await queuePostRetirement(Number(quote.id));
}

async function processDeliveryJob(job: Record<string, unknown>, quote: Record<string, unknown>) {
  let execution: Awaited<ReturnType<typeof callCommerceExecutor>> | null = null;
  if (quote.delivery_mode === "wallet") {
    execution = await callCommerceExecutor("deliver", {
      idempotencyKey: job.idempotency_key,
      quoteCode: quote.public_code,
      walletAddress: quote.wallet_address,
      amountEcot: Number(quote.requested_kg),
      retirementReference: quote.retirement_reference,
      retirementTxHash: quote.retirement_tx_hash,
    });
    if (!execution.configured || execution.status === "blocked") {
      await pool.query("UPDATE quote_requests SET delivery_status='awaiting_configuration',updated_at=NOW() WHERE id=$1", [quote.id]);
      await finishJob(Number(job.id), "blocked", execution.metadata || {});
      return;
    }
    if (execution.status === "processing") {
      await pool.query("UPDATE quote_requests SET delivery_status='processing',updated_at=NOW() WHERE id=$1", [quote.id]);
      await finishJob(Number(job.id), "retry", execution.metadata || {}, undefined, 60);
      return;
    }
  }

  const allocation = await pool.query(
    `INSERT INTO ecot_allocations
      (quote_id,amount_kg,delivery_mode,recipient_email,wallet_address,status,chain,chain_tx_hash,metadata,delivered_at)
     VALUES($1,$2,$3,$4,$5,'delivered',$6,$7,$8::jsonb,NOW())
     ON CONFLICT(quote_id) DO UPDATE SET status='delivered',chain_tx_hash=EXCLUDED.chain_tx_hash,
       metadata=ecot_allocations.metadata || EXCLUDED.metadata,delivered_at=NOW()
     RETURNING public_code`,
    [quote.id, quote.requested_kg, quote.delivery_mode, quote.buyer_email, quote.wallet_address || null,
      quote.delivery_mode === "wallet" ? "base" : "internal", execution?.txHash || null,
      JSON.stringify({ retirementReference: quote.retirement_reference, executor: execution?.metadata || null })],
  );
  const allocationCode = String(allocation.rows[0].public_code);
  await pool.query(
    `UPDATE quote_requests SET delivery_status='delivered',delivery_reference=$2,delivered_at=NOW(),status='delivered',updated_at=NOW() WHERE id=$1`,
    [quote.id, allocationCode],
  );

  const receiptUrl = `${appUrl()}/api/market/quotes/${quote.public_code}/receipt`;
  const email = await sendTransactionalEmail({
    to: String(quote.buyer_email),
    subject: `${quote.requested_kg} ECOT entregues · EcoTracker`,
    html: `<h1>Seu impacto foi registrado</h1><p>${quote.requested_kg} ECOT foram alocados para ${quote.buyer_name}.</p><p>Referência de aposentadoria: ${quote.retirement_reference || "registrada no processo EcoTracker"}</p><p><a href="${receiptUrl}">Abrir recibo e comprovante</a></p>`,
  });
  await finishJob(Number(job.id), "completed", { allocationCode, email });
  await logEvent(Number(quote.id), "delivery.completed", quote.delivery_mode === "wallet" ? "base" : "internal", { allocationCode, email });
}

async function processReceiptJob(job: Record<string, unknown>, quote: Record<string, unknown>) {
  const data = {
    seller: { name: "Alternative Ventures Ltda", cnpj: "61.920.356/0001-38" },
    buyer: { name: quote.buyer_name, email: quote.buyer_email, taxId: quote.tax_id, company: quote.company_name },
    quoteCode: quote.public_code,
    amountEcot: Number(quote.requested_kg),
    amountKgCo2e: Number(quote.requested_kg),
    totalBrl: Number(quote.final_total),
    paidAt: quote.paid_at,
    registry: quote.registry,
    project: quote.project_name,
    retirementReference: quote.retirement_reference,
    deliveryReference: quote.delivery_reference,
  };
  await pool.query(
    `INSERT INTO fiscal_documents(quote_id,document_type,status,provider,data,issued_at)
     VALUES($1,'receipt','issued','ecotracker',$2::jsonb,NOW())
     ON CONFLICT(quote_id,document_type) DO UPDATE SET status='issued',data=EXCLUDED.data,issued_at=NOW(),updated_at=NOW()`,
    [quote.id, JSON.stringify(data)],
  );
  await pool.query("UPDATE quote_requests SET receipt_status='issued',updated_at=NOW() WHERE id=$1", [quote.id]);
  await finishJob(Number(job.id), "completed", data);
}

async function processNfseJob(job: Record<string, unknown>, quote: Record<string, unknown>) {
  const payload = {
    idempotencyKey: job.idempotency_key,
    quoteCode: quote.public_code,
    providerTaxId: "61.920.356/0001-38",
    customer: { name: quote.buyer_name, email: quote.buyer_email, taxId: quote.tax_id, companyName: quote.company_name },
    amountBrl: Number(quote.final_total),
    description: `Serviço EcoTracker de aquisição, aposentadoria e comprovação de ${quote.requested_kg} kg CO₂e`,
  };
  const result = await issueNfseWithProvider(payload);
  if (!result.configured || result.status === "blocked") {
    await pool.query(
      `INSERT INTO fiscal_documents(quote_id,document_type,status,provider,data)
       VALUES($1,'nfse','awaiting_configuration','not_configured',$2::jsonb)
       ON CONFLICT(quote_id,document_type) DO UPDATE SET status='awaiting_configuration',data=EXCLUDED.data,updated_at=NOW()`,
      [quote.id, JSON.stringify(payload)],
    );
    await pool.query("UPDATE quote_requests SET nfse_status='awaiting_configuration',updated_at=NOW() WHERE id=$1", [quote.id]);
    await finishJob(Number(job.id), "blocked", result.metadata || {});
    return;
  }
  if (result.status === "processing") {
    await pool.query("UPDATE quote_requests SET nfse_status='processing',updated_at=NOW() WHERE id=$1", [quote.id]);
    await finishJob(Number(job.id), "retry", result.metadata || {}, undefined, 120);
    return;
  }
  const metadata = result.metadata || {};
  const documentUrl = typeof metadata.documentUrl === "string" ? metadata.documentUrl : typeof metadata.url === "string" ? metadata.url : null;
  await pool.query(
    `INSERT INTO fiscal_documents(quote_id,document_type,status,provider,provider_reference,document_url,data,issued_at)
     VALUES($1,'nfse','issued','configured_provider',$2,$3,$4::jsonb,NOW())
     ON CONFLICT(quote_id,document_type) DO UPDATE SET status='issued',provider_reference=EXCLUDED.provider_reference,
       document_url=EXCLUDED.document_url,data=EXCLUDED.data,issued_at=NOW(),updated_at=NOW()`,
    [quote.id, result.reference || null, documentUrl, JSON.stringify(metadata)],
  );
  await pool.query("UPDATE quote_requests SET nfse_status='issued',updated_at=NOW() WHERE id=$1", [quote.id]);
  await finishJob(Number(job.id), "completed", metadata);
}

async function processNextJob(): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE automation_jobs SET status='processing',attempts=attempts+1,locked_at=NOW(),updated_at=NOW()
     WHERE id=(
       SELECT id FROM automation_jobs
       WHERE status IN ('pending','retry') AND run_after<=NOW() AND attempts<max_attempts
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING *`,
  );
  const job = rows[0];
  if (!job) return false;
  try {
    const quote = await loadQuoteForAutomation(Number(job.quote_id));
    if (job.job_type === "source_asset") await processSourceJob(job, quote);
    else if (job.job_type === "retire_asset") await processRetirementJob(job, quote);
    else if (job.job_type === "deliver_ecot") await processDeliveryJob(job, quote);
    else if (job.job_type === "issue_receipt") await processReceiptJob(job, quote);
    else if (job.job_type === "issue_nfse") await processNfseJob(job, quote);
    else await finishJob(Number(job.id), "blocked", {}, `Tipo de job desconhecido: ${job.job_type}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    const attempts = Number(job.attempts);
    const maxAttempts = Number(job.max_attempts);
    if (attempts >= maxAttempts) await finishJob(Number(job.id), "blocked", {}, message);
    else await finishJob(Number(job.id), "retry", {}, message, Math.min(900, Math.pow(2, attempts) * 15));
  }
  return true;
}

let workerStarted = false;
export function startCommerceWorker() {
  if (workerStarted || process.env.COMMERCE_WORKER_DISABLED === "true") return;
  workerStarted = true;
  const run = async () => {
    try {
      for (let index = 0; index < 5; index += 1) {
        if (!await processNextJob()) break;
      }
    } catch (error) { console.error("[commerce] worker failed", error); }
  };
  void run();
  const timer = setInterval(() => void run(), numberEnv("COMMERCE_WORKER_INTERVAL_MS", 15000));
  timer.unref();
}

export async function markManualWorkflowStage(input: {
  quoteId: number;
  stage: "sourcing" | "retirement" | "delivery";
  reference?: string;
  txHash?: string;
}) {
  if (input.stage === "sourcing") {
    await pool.query(
      `UPDATE quote_requests SET sourcing_status='acquired',sourcing_reference=$2,sourcing_tx_hash=$3,
       retirement_status='queued',status='sourcing',updated_at=NOW() WHERE id=$1`,
      [input.quoteId, input.reference || null, input.txHash || null],
    );
    await enqueueAutomationJob(input.quoteId, "retire_asset");
  } else if (input.stage === "retirement") {
    await pool.query(
      `UPDATE quote_requests SET retirement_status='retired',retirement_reference=$2,retirement_tx_hash=$3,
       retired_at=NOW(),status='retired',updated_at=NOW() WHERE id=$1`,
      [input.quoteId, input.reference || null, input.txHash || null],
    );
    await queuePostRetirement(input.quoteId);
  } else {
    const quote = await loadQuoteForAutomation(input.quoteId);
    await pool.query(
      `INSERT INTO ecot_allocations(quote_id,amount_kg,delivery_mode,recipient_email,wallet_address,status,chain,chain_tx_hash,delivered_at)
       VALUES($1,$2,$3,$4,$5,'delivered',$6,$7,NOW())
       ON CONFLICT(quote_id) DO UPDATE SET status='delivered',chain_tx_hash=EXCLUDED.chain_tx_hash,delivered_at=NOW()`,
      [input.quoteId, quote.requested_kg, quote.delivery_mode, quote.buyer_email, quote.wallet_address || null,
        quote.delivery_mode === "wallet" ? "base" : "internal", input.txHash || null],
    );
    await pool.query("UPDATE quote_requests SET delivery_status='delivered',delivery_reference=$2,delivered_at=NOW(),status='delivered',updated_at=NOW() WHERE id=$1", [input.quoteId, input.reference || null]);
  }
  await logEvent(input.quoteId, `workflow.${input.stage}.manual`, "admin", input);
}

export async function getPublicQuote(publicCode: string) {
  const { rows } = await pool.query(
    `SELECT q.public_code,q.requested_kg,q.delivery_mode,q.wallet_address,q.indicative_total,q.final_total,
       q.status,q.quote_expires_at,q.payment_provider,q.payment_method,q.payment_status,q.payment_url,
       q.pix_br_code,q.pix_qr_code_url,q.paid_at,q.sourcing_status,q.retirement_status,q.retirement_reference,
       q.retirement_tx_hash,q.retired_at,q.delivery_status,q.delivery_reference,q.delivered_at,q.receipt_status,
       q.nfse_status,q.created_at,q.updated_at,a.registry,a.project_name,
       fd.public_code AS receipt_public_code,fd.document_url AS nfse_url,
       ea.public_code AS allocation_public_code,ea.chain_tx_hash AS delivery_tx_hash
     FROM quote_requests q
     JOIN monitored_assets a ON a.id=q.asset_id
     LEFT JOIN fiscal_documents fd ON fd.quote_id=q.id AND fd.document_type='receipt'
     LEFT JOIN fiscal_documents nf ON nf.quote_id=q.id AND nf.document_type='nfse'
     LEFT JOIN ecot_allocations ea ON ea.quote_id=q.id
     WHERE q.public_code=$1`,
    [publicCode],
  );
  return rows[0] || null;
}

export async function getCommerceDashboard() {
  const summary = await pool.query(`
    SELECT
      COUNT(*)::int AS quotes,
      COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid_orders,
      COALESCE(SUM(final_total) FILTER (WHERE payment_status='paid'),0) AS paid_revenue_brl,
      COALESCE(SUM(source_cost_brl) FILTER (WHERE payment_status='paid'),0) AS source_cost_brl,
      COALESCE(SUM(payment_fee_brl) FILTER (WHERE payment_status='paid'),0) AS payment_fees_brl,
      COALESCE(SUM(tax_reserve_brl) FILTER (WHERE payment_status='paid'),0) AS tax_reserve_brl,
      COALESCE(SUM(net_profit_brl) FILTER (WHERE payment_status='paid'),0) AS estimated_net_profit_brl,
      COALESCE(SUM(requested_kg) FILTER (WHERE delivery_status='delivered'),0) AS delivered_ecot
    FROM quote_requests
  `);
  const jobs = await pool.query(`SELECT status,COUNT(*)::int AS total FROM automation_jobs GROUP BY status ORDER BY status`);
  const providerStatus = {
    woovi: Boolean(process.env.WOOVI_APP_ID),
    mercadoPago: Boolean(process.env.MP_ACCESS_TOKEN),
    sourceExecutor: Boolean(process.env.SOURCE_EXECUTOR_URL),
    retirementExecutor: Boolean(process.env.RETIREMENT_EXECUTOR_URL),
    deliveryExecutor: Boolean(process.env.DELIVERY_EXECUTOR_URL),
    email: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    nfse: Boolean(process.env.NFSE_PROVIDER_URL),
  };
  return { ...summary.rows[0], jobs: jobs.rows, providers: providerStatus };
}

export async function getAutomationJobs() {
  const { rows } = await pool.query(
    `SELECT j.*,q.public_code AS quote_code,q.buyer_email,q.status AS quote_status
     FROM automation_jobs j JOIN quote_requests q ON q.id=j.quote_id
     ORDER BY j.created_at DESC LIMIT 200`,
  );
  return rows;
}

const escapeHtml = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export async function buildReceiptHtml(publicCode: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT q.*,a.registry,a.project_name,fd.public_code AS document_code,ea.public_code AS allocation_code
     FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id
     LEFT JOIN fiscal_documents fd ON fd.quote_id=q.id AND fd.document_type='receipt'
     LEFT JOIN ecot_allocations ea ON ea.quote_id=q.id
     WHERE q.public_code=$1 AND q.payment_status='paid'`,
    [publicCode],
  );
  const q = rows[0];
  if (!q) return null;
  const total = Number(q.final_total || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recibo EcoTracker ${escapeHtml(q.public_code)}</title><style>body{font-family:Arial,sans-serif;background:#f3f7f4;color:#11251a;margin:0;padding:32px}.paper{max-width:780px;margin:auto;background:white;border:1px solid #cfe0d5;border-radius:16px;padding:36px}.brand{font-size:26px;font-weight:800;color:#168f4a}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:28px 0}.box{border:1px solid #dce9e1;border-radius:10px;padding:16px}.muted{color:#607569}.amount{font-size:32px;color:#168f4a;font-weight:800}button{padding:12px 18px;border:0;border-radius:8px;background:#168f4a;color:white;font-weight:700}@media print{button{display:none}body{background:white;padding:0}.paper{border:0}}</style></head><body><main class="paper"><div class="brand">EcoTracker</div><p>Recibo operacional e comprovante de alocação ambiental</p><hr><h1>${escapeHtml(q.requested_kg)} ECOT</h1><p class="amount">${total}</p><div class="grid"><div class="box"><b>Cliente</b><p>${escapeHtml(q.buyer_name)}<br>${escapeHtml(q.buyer_email)}<br>${escapeHtml(q.tax_id)}</p></div><div class="box"><b>Emitente</b><p>Alternative Ventures Ltda<br>CNPJ 61.920.356/0001-38</p></div><div class="box"><b>Ativo ambiental</b><p>${escapeHtml(q.project_name)}<br>${escapeHtml(q.registry)}</p></div><div class="box"><b>Equivalência</b><p>${escapeHtml(q.requested_kg)} ECOT = ${escapeHtml(q.requested_kg)} kg CO₂e</p></div><div class="box"><b>Aposentadoria</b><p>${escapeHtml(q.retirement_reference || "Em processamento")}</p></div><div class="box"><b>Entrega</b><p>${escapeHtml(q.allocation_code || q.delivery_reference || "Em processamento")}</p></div></div><p class="muted">Código da operação: ${escapeHtml(q.public_code)}<br>Pagamento confirmado em: ${escapeHtml(q.paid_at)}<br>Este documento é um recibo operacional. A NFS-e, quando aplicável, é emitida separadamente pelo emissor fiscal configurado.</p><button onclick="window.print()">Imprimir / salvar em PDF</button></main></body></html>`;
}
