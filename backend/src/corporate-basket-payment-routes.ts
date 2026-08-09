import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { corporateBasketPaymentStatus } from "./corporate-basket-payment-db.js";
import { reconcileCorporateBasketPaymentApproved } from "./corporate-basket-payment-reconciliation.js";
import {
  createCorporateBasketCheckout,
  fetchMercadoPagoPayment,
  getCorporateBasketPayment,
  parseBasketExternalReference,
} from "./corporate-basket-payment.js";

const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value || "";
const queryOne = (value: unknown): string => Array.isArray(value) ? String(value[0] || "") : value == null ? "" : String(value);
const centsToBrl = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : undefined;
};
const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  return res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500).json({
    error: error instanceof Error ? error.message : "Erro interno",
    code: typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : undefined,
  });
};

export function registerCorporateBasketPaymentRoutes(app: Application) {
  app.get("/api/admin/demand/basket-payments/status", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control","no-store");
      return res.json(await corporateBasketPaymentStatus());
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/basket-payments/attempts", requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.max(1,Math.min(300,Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT p.*,b.public_code AS basket_public_code,b.status AS basket_status,b.payment_status,b.final_total_brl,
               a.company_name
        FROM corporate_basket_payment_attempts p
        JOIN corporate_baskets b ON b.id=p.basket_id
        JOIN demand_accounts a ON a.id=b.account_id
        ORDER BY p.created_at DESC LIMIT $1`, [limit]);
      res.setHeader("Cache-Control","no-store");
      return res.json({ count:rows.length,items:rows });
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/demand/baskets/:publicCode/checkout", async (req: Request, res: Response) => {
    const parsed = z.object({ method:z.enum(["pix","card"]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:"Método de pagamento inválido" });
    try {
      const checkout = await createCorporateBasketCheckout(one(req.params.publicCode),parsed.data.method);
      return res.status(201).json(checkout);
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/demand/baskets/:publicCode/payment", async (req: Request, res: Response) => {
    try {
      const payment = await getCorporateBasketPayment(one(req.params.publicCode));
      if (!payment) return res.status(404).json({ error:"Basket não encontrado" });
      const feature = await corporateBasketPaymentStatus();
      res.setHeader("Cache-Control","no-store");
      return res.json({ ...payment,paymentRailLive:feature.live });
    } catch (error) { return fail(res,error); }
  });
}

export function registerCorporateBasketPaymentWebhookRoutes(app: Application) {
  // Interceptor: só consome eventos cuja correlação começa por `basket:`.
  // Eventos de quotes normais seguem para registerCommerceRoutes via next().
  app.post("/api/webhooks/woovi/:secret", async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Record<string, unknown>;
    const charge = body.charge && typeof body.charge === "object" ? body.charge as Record<string, unknown> : null;
    const rawReference = String(charge?.correlationID || "");
    const basketCode = parseBasketExternalReference(rawReference);
    if (!basketCode) return next();

    if (!process.env.WOOVI_WEBHOOK_SECRET || one(req.params.secret) !== process.env.WOOVI_WEBHOOK_SECRET) {
      return res.status(401).json({ error:"Webhook não autorizado" });
    }
    const event = String(body.event || "");
    if (!["OPENPIX:CHARGE_COMPLETED","OPENPIX:CHARGE_COMPLETED_NOT_SAME_CUSTOMER_PAYER"].includes(event)) {
      return res.status(200).json({ received:true,ignored:event,basket:true });
    }
    if (!charge) return res.status(400).json({ error:"charge ausente" });
    const pix = body.pix && typeof body.pix === "object" ? body.pix as Record<string, unknown> : {};
    try {
      const result = await reconcileCorporateBasketPaymentApproved({
        basketCode,
        provider:"woovi",
        providerReference:String(charge.identifier || charge.transactionID || rawReference),
        paidAmountBrl:centsToBrl(charge.value),
        providerFeeBrl:centsToBrl(pix.fee || charge.fee),
        raw:body,
        eventKey:`basket:woovi:${event}:${charge.identifier || charge.transactionID || rawReference}`,
      });
      return res.status(200).json({ received:true,basket:true,...result });
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/webhooks/mercadopago", async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Record<string, unknown>;
    const bodyData = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
    const nestedQuery = req.query.data && typeof req.query.data === "object" && !Array.isArray(req.query.data)
      ? req.query.data as Record<string, unknown>
      : {};
    const paymentId = queryOne(req.query["data.id"] || req.query.id || nestedQuery.id || bodyData.id || body.id);
    const type = queryOne(req.query.type || body.type || body.topic || "payment");
    if (!paymentId || !["payment","payments"].includes(type)) return next();
    try {
      const payment = await fetchMercadoPagoPayment(paymentId);
      const rawReference = String(payment.external_reference || "");
      const basketCode = parseBasketExternalReference(rawReference);
      if (!basketCode) return next();
      if (String(payment.status) !== "approved") {
        return res.status(200).json({ received:true,basket:true,status:payment.status });
      }
      const feeDetails = Array.isArray(payment.fee_details) ? payment.fee_details as Array<Record<string, unknown>> : [];
      const fee = feeDetails.reduce((sum,item) => sum+(Number(item.amount)||0),0);
      const result = await reconcileCorporateBasketPaymentApproved({
        basketCode,
        provider:"mercadopago",
        providerReference:paymentId,
        paidAmountBrl:Number(payment.transaction_amount),
        providerFeeBrl:fee,
        raw:payment,
        eventKey:`basket:mercadopago:payment:${paymentId}:approved`,
      });
      return res.status(200).json({ received:true,basket:true,...result });
    } catch (error) { return fail(res,error); }
  });
}
