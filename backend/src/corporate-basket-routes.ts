import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import {
  cancelCorporateBasket,
  confirmCorporateBasketLeg,
  createCorporateBasket,
  getCorporateBasketAdmin,
  getCorporateBasketPublic,
} from "./corporate-basket-service.js";

const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value || "";
const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const message = error instanceof Error ? error.message : "Erro interno";
  return res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500).json({ error: message });
};

export function registerCorporateBasketRoutes(app: Application) {
  app.post("/api/admin/demand/proposals/:id/basket", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ notes: z.string().max(10000).nullable().optional() }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Dados do basket inválidos", details: parsed.error.flatten() });
    try {
      const basket = await createCorporateBasket(Number(one(req.params.id)), parsed.data.notes ?? null);
      return res.status(201).json({
        ...basket,
        checkoutReady: false,
        paymentEnabled: false,
        message: "Basket criado. Confirme custo, estoque e referência de cada leg antes de fechar o preço corporativo.",
      });
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/baskets", requireAdmin, async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status || "").trim();
      const limit = Math.max(1,Math.min(300,Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT b.*,a.company_name,a.sector,p.public_code AS proposal_public_code,
               (SELECT COUNT(*) FROM corporate_basket_legs l WHERE l.basket_id=b.id)::int AS leg_count,
               (SELECT COUNT(*) FROM corporate_basket_legs l WHERE l.basket_id=b.id AND l.status='confirmed')::int AS confirmed_legs
        FROM corporate_baskets b
        JOIN demand_accounts a ON a.id=b.account_id
        JOIN demand_proposals p ON p.id=b.proposal_id
        WHERE ($1='' OR b.status=$1)
        ORDER BY CASE b.status WHEN 'quoted' THEN 1 WHEN 'awaiting_leg_confirmation' THEN 2 ELSE 3 END,b.created_at DESC
        LIMIT $2`, [status,limit]);
      res.setHeader("Cache-Control","no-store");
      return res.json({ count: rows.length, items: rows });
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/baskets/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const basket = await getCorporateBasketAdmin(Number(one(req.params.id)));
      if (!basket) return res.status(404).json({ error: "Basket não encontrado" });
      res.setHeader("Cache-Control","no-store");
      return res.json(basket);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:basketId/legs/:legId/confirm", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      sourceCostBrl: z.coerce.number().positive().max(1_000_000_000),
      sourceReference: z.string().min(2).max(500),
      sourceAvailableKg: z.coerce.number().positive().max(1_000_000_000).nullable().optional(),
      sourceEvidenceUrl: z.string().url().nullable().optional(),
      quoteTtlMinutes: z.coerce.number().int().min(5).max(1440).default(30),
      confirmedBy: z.string().max(255).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Confirmação da leg inválida", details: parsed.error.flatten() });
    try {
      const result = await confirmCorporateBasketLeg({
        basketId: Number(one(req.params.basketId)),
        legId: Number(one(req.params.legId)),
        sourceCostBrl: parsed.data.sourceCostBrl,
        sourceReference: parsed.data.sourceReference,
        sourceAvailableKg: parsed.data.sourceAvailableKg ?? null,
        sourceEvidenceUrl: parsed.data.sourceEvidenceUrl ?? null,
        quoteTtlMinutes: parsed.data.quoteTtlMinutes,
        confirmedBy: parsed.data.confirmedBy ?? null,
      });
      return res.json({
        ...result,
        checkoutReady: false,
        paymentEnabled: false,
        message: result.status === "quoted"
          ? "Todas as legs foram confirmadas e o preço agregado foi travado. Pagamento continua desabilitado neste estágio."
          : "Leg confirmada. Ainda faltam outras legs antes do preço final do basket.",
      });
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/cancel", requireAdmin, async (req: Request, res: Response) => {
    try { return res.json(await cancelCorporateBasket(Number(one(req.params.id)))); }
    catch (error) { return fail(res,error); }
  });

  app.get("/api/demand/baskets/:publicCode", async (req: Request, res: Response) => {
    try {
      const basket = await getCorporateBasketPublic(one(req.params.publicCode));
      if (!basket) return res.status(404).json({ error: "Basket não encontrado" });
      res.setHeader("Cache-Control","no-store");
      return res.json(basket);
    } catch (error) { return fail(res,error); }
  });
}
