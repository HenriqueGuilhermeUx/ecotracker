import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";
import { assetProjection } from "./market-db.js";
import { refreshIfStale, refreshMarketData } from "./market-refresh.js";
import { calculateAutomaticPricing } from "./commerce-service.js";

const statuses = ["requested", "reviewing", "quoted", "awaiting_payment", "sourcing", "retired", "delivered", "cancelled"] as const;

const assetSchema = z.object({
  registry: z.string().min(2).max(120),
  projectName: z.string().min(3).max(255),
  sourceReference: z.string().min(2).max(180),
  sourceUrl: z.string().url().nullable().optional(),
  methodology: z.string().max(255).nullable().optional(),
  location: z.string().max(255).nullable().optional(),
  vintage: z.string().max(40).nullable().optional(),
  assetType: z.string().min(2).max(40).default("carbon"),
  qualityTier: z.string().min(2).max(40).default("screening"),
  description: z.string().max(5000).nullable().optional(),
  sourcePriceUsdTon: z.coerce.number().positive().nullable().optional(),
  fxBrlUsd: z.coerce.number().positive().default(5.5),
  serviceMarginPct: z.coerce.number().min(0).max(500).default(25),
  fixedFeeBrl: z.coerce.number().min(0).default(0),
  availableTons: z.coerce.number().min(0).nullable().optional(),
  minOrderKg: z.coerce.number().int().positive().default(100),
  pricingMode: z.enum(["quote", "dynamic"]).default("quote"),
  availabilityStatus: z.enum(["monitoring", "indicative", "confirmed"]).default("monitoring"),
  sourceStatus: z.enum(["manual", "connected", "degraded"]).default("manual"),
  active: z.boolean().default(true),
});

type AssetInput = z.infer<typeof assetSchema>;

const values = (data: AssetInput) => [
  data.registry, data.projectName, data.sourceReference, data.sourceUrl || null,
  data.methodology || null, data.location || null, data.vintage || null,
  data.assetType, data.qualityTier, data.description || null,
  data.sourcePriceUsdTon ?? null, data.fxBrlUsd, data.serviceMarginPct,
  data.fixedFeeBrl, data.availableTons ?? null, data.minOrderKg,
  data.pricingMode, data.availabilityStatus, data.sourceStatus, data.active,
];

const fail = (res: Response, error: unknown) =>
  res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });

async function listPublicAssets() {
  const { rows } = await pool.query(
    `SELECT ${assetProjection} FROM monitored_assets a
     WHERE a.active=TRUE
     ORDER BY CASE a.availability_status WHEN 'confirmed' THEN 1 WHEN 'indicative' THEN 2 ELSE 3 END,a.updated_at DESC`,
  );
  return rows;
}

export function registerMarketRoutes(app: Application) {
  app.get("/api/market/assets", async (_req: Request, res: Response) => {
    try {
      await refreshIfStale();
      res.setHeader("Cache-Control", "no-store");
      res.json(await listPublicAssets());
    } catch (error) { fail(res, error); }
  });

  app.get("/api/market/refresh", async (_req: Request, res: Response) => {
    try {
      await refreshIfStale(60 * 1000);
      res.setHeader("Cache-Control", "no-store");
      res.json(await listPublicAssets());
    } catch (error) { fail(res, error); }
  });

  app.post("/api/market/quotes", async (req: Request, res: Response) => {
    const parsed = z.object({
      assetId: z.coerce.number().int().positive(),
      buyerName: z.string().min(2).max(255),
      buyerEmail: z.string().email(),
      buyerPhone: z.string().max(40).optional(),
      companyName: z.string().max(255).optional(),
      taxId: z.string().max(40).optional(),
      requestedKg: z.coerce.number().int().positive().max(10000000),
      deliveryMode: z.enum(["email", "wallet"]).default("email"),
      walletAddress: z.string().max(100).optional(),
      purpose: z.string().max(120).default("neutralization"),
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: "Dados da cotação inválidos", details: parsed.error.flatten() });
    if (parsed.data.deliveryMode === "wallet" && !/^0x[a-fA-F0-9]{40}$/.test(parsed.data.walletAddress || "")) {
      return res.status(400).json({ error: "Informe um endereço 0x válido" });
    }

    try {
      const assetResult = await pool.query("SELECT * FROM monitored_assets WHERE id=$1 AND active=TRUE", [parsed.data.assetId]);
      const asset = assetResult.rows[0];
      if (!asset) return res.status(404).json({ error: "Ativo monitorado não encontrado" });
      if (parsed.data.requestedKg < Number(asset.min_order_kg)) {
        return res.status(400).json({ error: `Pedido mínimo: ${asset.min_order_kg} ECOT` });
      }

      const pricing = calculateAutomaticPricing(asset, parsed.data.requestedKg);
      const taxPct = Number(process.env.ECOT_TAX_RESERVE_PCT || 0);
      const taxReserve = pricing.finalTotalBrl == null ? 0 : Number((pricing.finalTotalBrl * Math.max(0, taxPct) / 100).toFixed(2));
      const netProfit = pricing.grossProfitBrl == null ? null : Number((pricing.grossProfitBrl - taxReserve).toFixed(2));
      const initialStatus = pricing.automatic ? "quoted" : "requested";

      const { rows } = await pool.query(
        `INSERT INTO quote_requests
          (asset_id,buyer_name,buyer_email,buyer_phone,company_name,tax_id,requested_kg,delivery_mode,wallet_address,purpose,
           indicative_price_per_kg,indicative_total,source_cost_brl,final_total,gross_revenue_brl,gross_profit_brl,
           tax_reserve_brl,net_profit_brl,status,quote_expires_at,pricing_snapshot,source_order_id,source_batch_denom)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22)
         RETURNING public_code,status,requested_kg,indicative_price_per_kg,indicative_total,final_total,quote_expires_at,created_at`,
        [parsed.data.assetId, parsed.data.buyerName, parsed.data.buyerEmail, parsed.data.buyerPhone || null,
          parsed.data.companyName || null, parsed.data.taxId || null, parsed.data.requestedKg,
          parsed.data.deliveryMode, parsed.data.walletAddress || null, parsed.data.purpose,
          pricing.finalTotalBrl == null ? null : pricing.finalTotalBrl / parsed.data.requestedKg,
          pricing.finalTotalBrl, pricing.sourceCostBrl, pricing.finalTotalBrl, pricing.grossProfitBrl,
          taxReserve, netProfit, initialStatus, pricing.quoteExpiresAt, JSON.stringify(pricing.snapshot),
          (asset.monitor_details || {}).sellOrderId || null, (asset.monitor_details || {}).batchDenom || null],
      );
      res.status(201).json({
        ...rows[0],
        checkoutReady: pricing.automatic,
        asset: { id: asset.id, registry: asset.registry, projectName: asset.project_name },
        message: pricing.automatic
          ? "Cotação executável gerada. Você já pode escolher Pix ou cartão."
          : "Solicitação registrada. Preço e disponibilidade serão confirmados antes de qualquer cobrança.",
      });
    } catch (error) { fail(res, error); }
  });

  // A versão enriquecida desta rota é registrada primeiro pelo módulo de comércio.
  app.get("/api/market/quotes/:publicCode", async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT q.public_code,q.requested_kg,q.delivery_mode,q.indicative_total,q.final_total,q.status,q.quote_expires_at,q.created_at,q.updated_at,a.registry,a.project_name
         FROM quote_requests q JOIN monitored_assets a ON a.id=q.asset_id WHERE q.public_code=$1`,
        [req.params.publicCode],
      );
      if (!rows[0]) return res.status(404).json({ error: "Cotação não encontrada" });
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/admin/market/assets", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(`SELECT ${assetProjection} FROM monitored_assets a ORDER BY a.updated_at DESC`);
      res.json(rows);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market/assets", requireAdmin, async (req: Request, res: Response) => {
    const parsed = assetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Ativo inválido", details: parsed.error.flatten() });
    try {
      const { rows } = await pool.query(
        `INSERT INTO monitored_assets
          (registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,source_price_usd_ton,fx_brl_usd,service_margin_pct,fixed_fee_brl,available_tons,min_order_kg,pricing_mode,availability_status,source_status,active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        values(parsed.data),
      );
      res.status(201).json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.patch("/api/admin/market/assets/:id", requireAdmin, async (req: Request, res: Response) => {
    const parsed = assetSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Atualização inválida", details: parsed.error.flatten() });
    try {
      const currentResult = await pool.query("SELECT * FROM monitored_assets WHERE id=$1", [req.params.id]);
      const current = currentResult.rows[0];
      if (!current) return res.status(404).json({ error: "Ativo não encontrado" });
      const has = (key: keyof typeof parsed.data) => Object.prototype.hasOwnProperty.call(parsed.data, key);
      const data = assetSchema.parse({
        registry: has("registry") ? parsed.data.registry : current.registry,
        projectName: has("projectName") ? parsed.data.projectName : current.project_name,
        sourceReference: has("sourceReference") ? parsed.data.sourceReference : current.source_reference,
        sourceUrl: has("sourceUrl") ? parsed.data.sourceUrl : current.source_url,
        methodology: has("methodology") ? parsed.data.methodology : current.methodology,
        location: has("location") ? parsed.data.location : current.location,
        vintage: has("vintage") ? parsed.data.vintage : current.vintage,
        assetType: has("assetType") ? parsed.data.assetType : current.asset_type,
        qualityTier: has("qualityTier") ? parsed.data.qualityTier : current.quality_tier,
        description: has("description") ? parsed.data.description : current.description,
        sourcePriceUsdTon: has("sourcePriceUsdTon") ? parsed.data.sourcePriceUsdTon : current.source_price_usd_ton,
        fxBrlUsd: has("fxBrlUsd") ? parsed.data.fxBrlUsd : current.fx_brl_usd,
        serviceMarginPct: has("serviceMarginPct") ? parsed.data.serviceMarginPct : current.service_margin_pct,
        fixedFeeBrl: has("fixedFeeBrl") ? parsed.data.fixedFeeBrl : current.fixed_fee_brl,
        availableTons: has("availableTons") ? parsed.data.availableTons : current.available_tons,
        minOrderKg: has("minOrderKg") ? parsed.data.minOrderKg : current.min_order_kg,
        pricingMode: has("pricingMode") ? parsed.data.pricingMode : current.pricing_mode,
        availabilityStatus: has("availabilityStatus") ? parsed.data.availabilityStatus : current.availability_status,
        sourceStatus: has("sourceStatus") ? parsed.data.sourceStatus : current.source_status,
        active: has("active") ? parsed.data.active : current.active,
      });
      const { rows } = await pool.query(
        `UPDATE monitored_assets SET registry=$2,project_name=$3,source_reference=$4,source_url=$5,methodology=$6,location=$7,vintage=$8,asset_type=$9,quality_tier=$10,description=$11,source_price_usd_ton=$12,fx_brl_usd=$13,service_margin_pct=$14,fixed_fee_brl=$15,available_tons=$16,min_order_kg=$17,pricing_mode=$18,availability_status=$19,source_status=$20,active=$21,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, ...values(data)],
      );
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/market/refresh", requireAdmin, async (_req: Request, res: Response) => {
    try { res.json(await refreshMarketData()); }
    catch (error) { fail(res, error); }
  });

  app.get("/api/admin/market/quotes", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(
        `SELECT q.*,a.registry,a.project_name,a.source_reference FROM quote_requests q
         JOIN monitored_assets a ON a.id=q.asset_id ORDER BY q.created_at DESC`,
      );
      res.json(rows);
    } catch (error) { fail(res, error); }
  });

  app.patch("/api/admin/market/quotes/:id", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      status: z.enum(statuses).optional(),
      finalTotal: z.coerce.number().nonnegative().nullable().optional(),
      quoteExpiresAt: z.string().datetime().nullable().optional(),
      adminNotes: z.string().max(5000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Atualização inválida", details: parsed.error.flatten() });
    try {
      const own = (key: string) => Object.prototype.hasOwnProperty.call(parsed.data, key);
      const { rows } = await pool.query(
        `UPDATE quote_requests SET status=COALESCE($2,status),
           final_total=CASE WHEN $3::boolean THEN $4 ELSE final_total END,
           quote_expires_at=CASE WHEN $5::boolean THEN $6::timestamptz ELSE quote_expires_at END,
           admin_notes=CASE WHEN $7::boolean THEN $8 ELSE admin_notes END,updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [req.params.id, parsed.data.status || null, own("finalTotal"), parsed.data.finalTotal ?? null,
          own("quoteExpiresAt"), parsed.data.quoteExpiresAt ?? null, own("adminNotes"), parsed.data.adminNotes ?? null],
      );
      if (!rows[0]) return res.status(404).json({ error: "Cotação não encontrada" });
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });
}
