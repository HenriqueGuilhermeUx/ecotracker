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
import {
  expireStaleCorporateBasketReservations,
  releaseCorporateBasketReservations,
  reserveCorporateBasket,
} from "./corporate-basket-reservations.js";

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
      await expireStaleCorporateBasketReservations().catch(() => undefined);
      const status = String(req.query.status || "").trim();
      const limit = Math.max(1,Math.min(300,Number(req.query.limit || 100)));
      const { rows } = await pool.query(`
        SELECT b.*,a.company_name,a.sector,p.public_code AS proposal_public_code,
               (SELECT COUNT(*) FROM corporate_basket_legs l WHERE l.basket_id=b.id)::int AS leg_count,
               (SELECT COUNT(*) FROM corporate_basket_legs l WHERE l.basket_id=b.id AND l.status='confirmed')::int AS confirmed_legs,
               (SELECT COUNT(*) FROM corporate_basket_reservations r
                 WHERE r.basket_id=b.id AND r.status='active' AND r.expires_at>NOW())::int AS active_reservations
        FROM corporate_baskets b
        JOIN demand_accounts a ON a.id=b.account_id
        JOIN demand_proposals p ON p.id=b.proposal_id
        WHERE ($1='' OR b.status=$1)
        ORDER BY CASE b.status WHEN 'reserved' THEN 1 WHEN 'quoted' THEN 2 WHEN 'awaiting_leg_confirmation' THEN 3 ELSE 4 END,b.created_at DESC
        LIMIT $2`, [status,limit]);
      res.setHeader("Cache-Control","no-store");
      return res.json({ count: rows.length, items: rows });
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/baskets/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      await expireStaleCorporateBasketReservations().catch(() => undefined);
      const basketId = Number(one(req.params.id));
      const basket = await getCorporateBasketAdmin(basketId);
      if (!basket) return res.status(404).json({ error: "Basket não encontrado" });
      const reservations = await pool.query(`
        SELECT id,public_code,leg_id,asset_id,reserved_kg,status,expires_at,released_at,consumed_at,created_at,updated_at
        FROM corporate_basket_reservations WHERE basket_id=$1 ORDER BY id`, [basketId]);
      res.setHeader("Cache-Control","no-store");
      return res.json({ ...basket, reservations: reservations.rows });
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
          ? "Todas as legs foram confirmadas e o preço agregado foi travado. O próximo passo é reservar todas as legs atomicamente."
          : "Leg confirmada. Ainda faltam outras legs antes do preço final do basket.",
      });
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/reserve", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({ reservationMinutes: z.coerce.number().int().min(5).max(120).default(15) }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Janela de reserva inválida" });
    try {
      return res.json(await reserveCorporateBasket({
        basketId: Number(one(req.params.id)),
        reservationMinutes: parsed.data.reservationMinutes,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/release", requireAdmin, async (req: Request, res: Response) => {
    try { return res.json(await releaseCorporateBasketReservations(Number(one(req.params.id)))); }
    catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/cancel", requireAdmin, async (req: Request, res: Response) => {
    try {
      await releaseCorporateBasketReservations(Number(one(req.params.id))).catch(() => undefined);
      return res.json(await cancelCorporateBasket(Number(one(req.params.id))));
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/demand/baskets/:publicCode", async (req: Request, res: Response) => {
    try {
      await expireStaleCorporateBasketReservations().catch(() => undefined);
      const basket = await getCorporateBasketPublic(one(req.params.publicCode));
      if (!basket) return res.status(404).json({ error: "Basket não encontrado" });
      res.setHeader("Cache-Control","no-store");
      return res.json(basket);
    } catch (error) { return fail(res,error); }
  });
}
