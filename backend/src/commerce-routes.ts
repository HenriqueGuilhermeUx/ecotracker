import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { fetchMercadoPagoPayment } from "./commerce-providers.js";
import {
  buildReceiptHtml,
  createCheckout,
  getAutomationJobs,
  getCommerceDashboard,
  getPublicQuote,
  markManualWorkflowStage,
  markPaymentApproved,
} from "./commerce-service.js";

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 500;
  return res.status(status).json({ error: error instanceof Error ? error.message : "Erro interno" });
};

const centsToBrl = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : undefined;
};

export function registerCommerceRoutes(app: Application) {
  app.get("/api/market/quotes/:publicCode", async (req: Request, res: Response) => {
    try {
      const quote = await getPublicQuote(req.params.publicCode);
      if (!quote) return res.status(404).json({ error: "Cotação não encontrada" });
      res.setHeader("Cache-Control", "no-store");
      return res.json(quote);
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/market/quotes/:publicCode/checkout", async (req: Request, res: Response) => {
    const parsed = z.object({ method: z.enum(["pix", "card"]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Método de pagamento inválido" });
    try {
      const checkout = await createCheckout(req.params.publicCode, parsed.data.method);
      return res.status(201).json(checkout);
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/market/quotes/:publicCode/receipt", async (req: Request, res: Response) => {
    try {
      const html = await buildReceiptHtml(req.params.publicCode);
      if (!html) return res.status(404).send("Recibo ainda não disponível");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(html);
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/webhooks/woovi/:secret", async (req: Request, res: Response) => {
    if (!process.env.WOOVI_WEBHOOK_SECRET || req.params.secret !== process.env.WOOVI_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Webhook não autorizado" });
    }
    const body = req.body as Record<string, unknown>;
    const event = String(body.event || "");
    if (!body.charge) return res.status(200).json({ received: true, test: true });
    if (!["OPENPIX:CHARGE_COMPLETED", "OPENPIX:CHARGE_COMPLETED_NOT_SAME_CUSTOMER_PAYER"].includes(event)) {
      return res.status(200).json({ received: true, ignored: event });
    }
    const charge = body.charge as Record<string, unknown>;
    const quoteCode = String(charge.correlationID || "");
    if (!quoteCode) return res.status(400).json({ error: "correlationID ausente" });
    const pix = (body.pix || {}) as Record<string, unknown>;
    try {
      await markPaymentApproved({
        quoteCode,
        provider: "woovi",
        providerReference: String(charge.identifier || charge.transactionID || quoteCode),
        providerFeeBrl: centsToBrl(pix.fee || charge.fee),
        raw: body,
        eventKey: `woovi:${event}:${charge.identifier || charge.transactionID || quoteCode}`,
      });
      return res.status(200).json({ received: true });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/webhooks/mercadopago", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const queryData = req.query.data as Record<string, unknown> | undefined;
    const bodyData = body.data as Record<string, unknown> | undefined;
    const paymentId = String(queryData?.id || bodyData?.id || body.id || "");
    const type = String(req.query.type || body.type || body.topic || "payment");
    if (!paymentId || !["payment", "payments"].includes(type)) return res.status(200).json({ received: true, ignored: true });
    try {
      const payment = await fetchMercadoPagoPayment(paymentId);
      if (String(payment.status) !== "approved") return res.status(200).json({ received: true, status: payment.status });
      const quoteCode = String(payment.external_reference || "");
      if (!quoteCode) return res.status(400).json({ error: "external_reference ausente" });
      const feeDetails = Array.isArray(payment.fee_details) ? payment.fee_details as Array<Record<string, unknown>> : [];
      const fee = feeDetails.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      await markPaymentApproved({
        quoteCode,
        provider: "mercadopago",
        providerReference: paymentId,
        providerFeeBrl: fee,
        raw: payment,
        eventKey: `mercadopago:payment:${paymentId}:approved`,
      });
      return res.status(200).json({ received: true });
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/admin/commerce/dashboard", requireAdmin, async (_req: Request, res: Response) => {
    try { return res.json(await getCommerceDashboard()); }
    catch (error) { return fail(res, error); }
  });

  app.get("/api/admin/commerce/jobs", requireAdmin, async (_req: Request, res: Response) => {
    try { return res.json(await getAutomationJobs()); }
    catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/commerce/jobs/:id/retry", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `UPDATE automation_jobs SET status='pending',attempts=0,run_after=NOW(),last_error=NULL,completed_at=NULL,updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [req.params.id],
      );
      if (!rows[0]) return res.status(404).json({ error: "Job não encontrado" });
      return res.json(rows[0]);
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/market/quotes/:id/workflow", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      stage: z.enum(["sourcing", "retirement", "delivery"]),
      reference: z.string().max(255).optional(),
      txHash: z.string().max(255).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Etapa inválida" });
    try {
      await markManualWorkflowStage({ quoteId: Number(req.params.id), ...parsed.data });
      return res.json({ success: true });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/market/quotes/:id/reprice", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      sourceCostBrl: z.coerce.number().nonnegative(),
      finalTotalBrl: z.coerce.number().positive(),
      expiresInMinutes: z.coerce.number().int().min(5).max(1440).default(60),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados de preço inválidos", details: parsed.error.flatten() });
    if (parsed.data.finalTotalBrl < parsed.data.sourceCostBrl) return res.status(400).json({ error: "O valor final não pode ser menor que o custo" });
    try {
      const taxPct = Number(process.env.ECOT_TAX_RESERVE_PCT || 0);
      const taxReserve = Number((parsed.data.finalTotalBrl * Math.max(0, taxPct) / 100).toFixed(2));
      const grossProfit = Number((parsed.data.finalTotalBrl - parsed.data.sourceCostBrl).toFixed(2));
      const netProfit = Number((grossProfit - taxReserve).toFixed(2));
      const expiresAt = new Date(Date.now() + parsed.data.expiresInMinutes * 60 * 1000).toISOString();
      const { rows } = await pool.query(
        `UPDATE quote_requests SET source_cost_brl=$2,final_total=$3,gross_revenue_brl=$3,
           gross_profit_brl=$4,tax_reserve_brl=$5,net_profit_brl=$6,status='quoted',quote_expires_at=$7,
           pricing_snapshot=pricing_snapshot || $8::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, parsed.data.sourceCostBrl, parsed.data.finalTotalBrl, grossProfit, taxReserve, netProfit, expiresAt,
          JSON.stringify({ pricingMode: "manual", repricedAt: new Date().toISOString() })],
      );
      if (!rows[0]) return res.status(404).json({ error: "Cotação não encontrada" });
      return res.json(rows[0]);
    } catch (error) { return fail(res, error); }
  });
}
