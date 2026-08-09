import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool, withTransaction } from "./db.js";

const fail = (res: Response, error: unknown) => {
  const message = error instanceof Error ? error.message : "Erro interno";
  if (message.includes("supply_inventory_overallocated")) return res.status(409).json({ error: "A reserva ultrapassa o saldo global disponível deste lote" });
  if (message.includes("supplier_mandate_overallocated")) return res.status(409).json({ error: "A soma dos lotes ultrapassa a quantidade autorizada pelo fornecedor" });
  return res.status(500).json({ error: message });
};

const nullableUrl = z.string().url().nullable().optional();
const tonnes = z.coerce.number().nonnegative().max(1_000_000_000);
const positiveTonnes = z.coerce.number().positive().max(1_000_000_000);
const channels = ["carbonmark", "regen", "otc", "direct", "toucan", "other"] as const;

const leadSchema = z.object({
  registry: z.string().min(2).max(80),
  registryProjectId: z.string().min(1).max(180),
  projectName: z.string().min(2).max(255),
  country: z.string().max(100).nullable().optional(),
  region: z.string().max(180).nullable().optional(),
  supplierName: z.string().max(255).nullable().optional(),
  supplierContactName: z.string().max(255).nullable().optional(),
  supplierEmail: z.string().email().nullable().optional(),
  supplierPhone: z.string().max(80).nullable().optional(),
  methodology: z.string().max(255).nullable().optional(),
  vintage: z.string().max(80).nullable().optional(),
  issuedTonnes: tonnes.nullable().optional(),
  retiredTonnes: tonnes.nullable().optional(),
  withdrawnTonnes: tonnes.default(0),
  evidenceUrl: nullableUrl,
  sourceUrl: nullableUrl,
  dataSource: z.string().min(2).max(80).default("manual"),
  notes: z.string().max(10000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

function estimatedUnretired(issued: number | null | undefined, retired: number | null | undefined, withdrawn: number | null | undefined) {
  if (issued == null || retired == null) return null;
  return Math.max(0, Number((issued - retired - Math.max(0, withdrawn || 0)).toFixed(3)));
}

async function inventoryView(id?: number) {
  const params: unknown[] = [];
  const where = id ? "WHERE i.id=$1" : "";
  if (id) params.push(id);
  const { rows } = await pool.query(`
    SELECT i.*,m.public_code AS mandate_public_code,m.supplier_name,m.floor_price_usd_tonne,m.non_exclusive,
           l.public_code AS lead_public_code,l.project_name,l.country,l.region,
           COALESCE((SELECT SUM(r.reserved_tonnes) FROM supply_reservations r
                     WHERE r.inventory_id=i.id AND r.status IN ('active','pending')),0) AS reserved_tonnes,
           GREATEST(0,i.authorized_tonnes-i.sold_tonnes-
             COALESCE((SELECT SUM(r.reserved_tonnes) FROM supply_reservations r
                       WHERE r.inventory_id=i.id AND r.status IN ('active','pending')),0)) AS available_tonnes
    FROM supply_inventory i
    JOIN supplier_mandates m ON m.id=i.mandate_id
    JOIN supply_leads l ON l.id=m.lead_id
    ${where}
    ORDER BY i.updated_at DESC`, params);
  return rows;
}

export function registerSupplyDeskRoutes(app: Application) {
  app.get("/api/admin/supply/leads", requireAdmin, async (req: Request, res: Response) => {
    try {
      const country = String(req.query.country || "").trim();
      const status = String(req.query.status || "").trim();
      const { rows } = await pool.query(`
        SELECT *,
          CASE
            WHEN confirmed_free_tonnes IS NOT NULL THEN 'seller_confirmed'
            WHEN estimated_unretired_tonnes IS NOT NULL THEN 'registry_estimate'
            ELSE 'unknown'
          END AS inventory_basis
        FROM supply_leads
        WHERE ($1='' OR LOWER(country)=LOWER($1))
          AND ($2='' OR status=$2)
        ORDER BY
          CASE WHEN confirmed_free_tonnes IS NOT NULL THEN 1
               WHEN estimated_unretired_tonnes IS NOT NULL THEN 2 ELSE 3 END,
          COALESCE(confirmed_free_tonnes,estimated_unretired_tonnes,0) DESC,updated_at DESC`, [country, status]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/leads", requireAdmin, async (req: Request, res: Response) => {
    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Lead de supply inválido", details: parsed.error.flatten() });
    try {
      const data = parsed.data;
      const estimate = estimatedUnretired(data.issuedTonnes ?? null, data.retiredTonnes ?? null, data.withdrawnTonnes);
      const { rows } = await pool.query(`
        INSERT INTO supply_leads
          (registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,
           supplier_phone,methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,
           evidence_url,source_url,data_source,notes,metadata,last_checked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,NOW())
        ON CONFLICT(registry,registry_project_id) DO UPDATE SET
          project_name=EXCLUDED.project_name,country=COALESCE(EXCLUDED.country,supply_leads.country),
          region=COALESCE(EXCLUDED.region,supply_leads.region),supplier_name=COALESCE(EXCLUDED.supplier_name,supply_leads.supplier_name),
          supplier_contact_name=COALESCE(EXCLUDED.supplier_contact_name,supply_leads.supplier_contact_name),
          supplier_email=COALESCE(EXCLUDED.supplier_email,supply_leads.supplier_email),
          supplier_phone=COALESCE(EXCLUDED.supplier_phone,supply_leads.supplier_phone),
          methodology=COALESCE(EXCLUDED.methodology,supply_leads.methodology),vintage=COALESCE(EXCLUDED.vintage,supply_leads.vintage),
          issued_tonnes=COALESCE(EXCLUDED.issued_tonnes,supply_leads.issued_tonnes),
          retired_tonnes=COALESCE(EXCLUDED.retired_tonnes,supply_leads.retired_tonnes),
          withdrawn_tonnes=EXCLUDED.withdrawn_tonnes,
          estimated_unretired_tonnes=COALESCE(EXCLUDED.estimated_unretired_tonnes,supply_leads.estimated_unretired_tonnes),
          evidence_url=COALESCE(EXCLUDED.evidence_url,supply_leads.evidence_url),source_url=COALESCE(EXCLUDED.source_url,supply_leads.source_url),
          data_source=EXCLUDED.data_source,notes=COALESCE(EXCLUDED.notes,supply_leads.notes),
          metadata=supply_leads.metadata || EXCLUDED.metadata,last_checked_at=NOW(),updated_at=NOW()
        RETURNING *`, [
        data.registry,data.registryProjectId,data.projectName,data.country ?? null,data.region ?? null,data.supplierName ?? null,
        data.supplierContactName ?? null,data.supplierEmail ?? null,data.supplierPhone ?? null,data.methodology ?? null,data.vintage ?? null,
        data.issuedTonnes ?? null,data.retiredTonnes ?? null,data.withdrawnTonnes,estimate,data.evidenceUrl ?? null,data.sourceUrl ?? null,
        data.dataSource,data.notes ?? null,JSON.stringify(data.metadata),
      ]);
      res.status(201).json({ ...rows[0], warning: "Saldo estimado do registry não é estoque comercial livre até confirmação do fornecedor." });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/leads/:id/confirm-inventory", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      confirmedFreeTonnes: positiveTonnes,
      contactStatus: z.enum(["contacted", "qualified", "negotiating", "mandate_ready"]).default("qualified"),
      evidenceUrl: nullableUrl,
      notes: z.string().max(10000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Confirmação de inventário inválida", details: parsed.error.flatten() });
    try {
      const { rows } = await pool.query(`
        UPDATE supply_leads SET confirmed_free_tonnes=$2,availability_confidence='seller_confirmed',contact_status=$3,
          status=CASE WHEN $3='mandate_ready' THEN 'qualified' ELSE status END,
          evidence_url=COALESCE($4,evidence_url),notes=CASE WHEN $5::text IS NULL THEN notes ELSE CONCAT_WS(E'\n',NULLIF(notes,''),$5) END,
          updated_at=NOW()
        WHERE id=$1 RETURNING *`, [req.params.id,parsed.data.confirmedFreeTonnes,parsed.data.contactStatus,parsed.data.evidenceUrl ?? null,parsed.data.notes ?? null]);
      if (!rows[0]) return res.status(404).json({ error: "Lead não encontrado" });
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/mandates", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      leadId: z.coerce.number().int().positive(),
      supplierName: z.string().min(2).max(255),
      confirmedFreeTonnes: positiveTonnes,
      authorizedTonnes: positiveTonnes,
      floorPriceUsdTonne: z.coerce.number().positive().nullable().optional(),
      nonExclusive: z.boolean().default(true),
      allowedChannels: z.array(z.enum(channels)).min(1).default(["carbonmark","regen","otc"]),
      serialRanges: z.array(z.record(z.string(), z.unknown())).default([]),
      evidenceUrl: nullableUrl,
      signedAt: z.string().datetime().nullable().optional(),
      validFrom: z.string().datetime().nullable().optional(),
      validUntil: z.string().datetime().nullable().optional(),
      notes: z.string().max(10000).nullable().optional(),
      batchReference: z.string().min(1).max(255),
      vintage: z.string().max(80).nullable().optional(),
      serialStart: z.string().max(255).nullable().optional(),
      serialEnd: z.string().max(255).nullable().optional(),
      registryEvidenceUrl: nullableUrl,
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Mandato de distribuição inválido", details: parsed.error.flatten() });
    if (parsed.data.authorizedTonnes > parsed.data.confirmedFreeTonnes) {
      return res.status(409).json({ error: "A quantidade autorizada não pode superar o saldo livre confirmado pelo fornecedor" });
    }

    try {
      const result = await withTransaction(async (client) => {
        const leadResult = await client.query("SELECT * FROM supply_leads WHERE id=$1 FOR UPDATE", [parsed.data.leadId]);
        const lead = leadResult.rows[0];
        if (!lead) throw Object.assign(new Error("Lead não encontrado"), { status: 404 });
        const mandate = await client.query(`
          INSERT INTO supplier_mandates
            (lead_id,supplier_name,status,confirmed_free_tonnes,authorized_tonnes,floor_price_usd_tonne,non_exclusive,
             allowed_channels,serial_ranges,evidence_url,signed_at,valid_from,valid_until,notes)
          VALUES($1,$2,'active',$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::timestamptz,$11::timestamptz,$12::timestamptz,$13)
          RETURNING *`, [parsed.data.leadId,parsed.data.supplierName,parsed.data.confirmedFreeTonnes,parsed.data.authorizedTonnes,
          parsed.data.floorPriceUsdTonne ?? null,parsed.data.nonExclusive,JSON.stringify(parsed.data.allowedChannels),JSON.stringify(parsed.data.serialRanges),
          parsed.data.evidenceUrl ?? null,parsed.data.signedAt ?? null,parsed.data.validFrom ?? null,parsed.data.validUntil ?? null,parsed.data.notes ?? null]);
        const inventory = await client.query(`
          INSERT INTO supply_inventory
            (mandate_id,registry,registry_project_id,batch_reference,vintage,serial_start,serial_end,authorized_tonnes,registry_evidence_url)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [mandate.rows[0].id,lead.registry,lead.registry_project_id,parsed.data.batchReference,
          parsed.data.vintage ?? lead.vintage ?? null,parsed.data.serialStart ?? null,parsed.data.serialEnd ?? null,parsed.data.authorizedTonnes,
          parsed.data.registryEvidenceUrl ?? lead.evidence_url ?? null]);
        await client.query(`UPDATE supply_leads SET confirmed_free_tonnes=$2,availability_confidence='seller_confirmed',contact_status='mandate_ready',status='mandated',updated_at=NOW() WHERE id=$1`, [lead.id,parsed.data.confirmedFreeTonnes]);
        return { mandate: mandate.rows[0], inventory: inventory.rows[0] };
      });
      res.status(201).json(result);
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
      if (status === 404) return res.status(404).json({ error: "Lead não encontrado" });
      fail(res, error);
    }
  });

  app.get("/api/admin/supply/inventory", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await inventoryView();
      res.setHeader("Cache-Control", "no-store");
      res.json({ count: rows.length, items: rows });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/inventory/:id/allocate-channel", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      channel: z.enum(channels),
      advertisedTonnes: positiveTonnes,
      askPriceUsdTonne: z.coerce.number().positive().nullable().optional(),
      externalListingId: z.string().max(255).nullable().optional(),
      externalUrl: nullableUrl,
      status: z.enum(["planned","submitted","active","paused","closed"]).default("planned"),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Alocação de canal inválida", details: parsed.error.flatten() });
    try {
      const inventory = await inventoryView(Number(req.params.id));
      if (!inventory[0]) return res.status(404).json({ error: "Inventário não encontrado" });
      if (parsed.data.advertisedTonnes > Number(inventory[0].authorized_tonnes)) {
        return res.status(409).json({ error: "A quantidade anunciada não pode superar a quantidade autorizada deste lote" });
      }
      const { rows } = await pool.query(`
        INSERT INTO supply_channel_listings
          (inventory_id,channel,advertised_tonnes,ask_price_usd_tonne,external_listing_id,external_url,status,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT(inventory_id,channel) DO UPDATE SET advertised_tonnes=EXCLUDED.advertised_tonnes,
          ask_price_usd_tonne=EXCLUDED.ask_price_usd_tonne,external_listing_id=EXCLUDED.external_listing_id,
          external_url=EXCLUDED.external_url,status=EXCLUDED.status,metadata=supply_channel_listings.metadata || EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`, [req.params.id,parsed.data.channel,parsed.data.advertisedTonnes,parsed.data.askPriceUsdTonne ?? null,
          parsed.data.externalListingId ?? null,parsed.data.externalUrl ?? null,parsed.data.status,JSON.stringify(parsed.data.metadata)]);
      res.status(201).json({ ...rows[0], note: "Listar em vários canais não duplica o estoque; reservas e vendas usam o saldo global do lote." });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/inventory/:id/reserve", requireAdmin, async (req: Request, res: Response) => {
    const parsed = z.object({
      channel: z.enum(channels),
      reservedTonnes: positiveTonnes,
      externalOrderId: z.string().max(255).nullable().optional(),
      reservedUntil: z.string().datetime().nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Reserva inválida", details: parsed.error.flatten() });
    try {
      const { rows } = await pool.query(`
        INSERT INTO supply_reservations(inventory_id,channel,external_order_id,reserved_tonnes,status,reserved_until,metadata)
        VALUES($1,$2,$3,$4,'active',$5::timestamptz,$6::jsonb) RETURNING *`, [req.params.id,parsed.data.channel,
          parsed.data.externalOrderId ?? null,parsed.data.reservedTonnes,parsed.data.reservedUntil ?? null,JSON.stringify(parsed.data.metadata)]);
      res.status(201).json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/reservations/:id/release", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { rows } = await pool.query(`UPDATE supply_reservations SET status='released',updated_at=NOW() WHERE id=$1 AND status IN ('active','pending') RETURNING *`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "Reserva ativa não encontrada" });
      res.json(rows[0]);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/admin/supply/reservations/:id/settle", requireAdmin, async (req: Request, res: Response) => {
    try {
      const settled = await withTransaction(async (client) => {
        const reservationResult = await client.query("SELECT * FROM supply_reservations WHERE id=$1 FOR UPDATE", [req.params.id]);
        const reservation = reservationResult.rows[0];
        if (!reservation) throw Object.assign(new Error("Reserva não encontrada"), { status: 404 });
        if (reservation.status === "sold") return { alreadySold: true, reservation };
        if (!['active','pending'].includes(String(reservation.status))) throw Object.assign(new Error("Reserva não está ativa"), { status: 409 });
        const inventoryResult = await client.query("SELECT * FROM supply_inventory WHERE id=$1 FOR UPDATE", [reservation.inventory_id]);
        const inventory = inventoryResult.rows[0];
        const nextSold = Number(inventory.sold_tonnes) + Number(reservation.reserved_tonnes);
        if (nextSold > Number(inventory.authorized_tonnes) + 0.000001) throw new Error("supply_inventory_overallocated");
        await client.query("UPDATE supply_inventory SET sold_tonnes=$2,status=CASE WHEN $2>=authorized_tonnes THEN 'sold_out' ELSE status END,updated_at=NOW() WHERE id=$1", [inventory.id,nextSold]);
        const updated = await client.query("UPDATE supply_reservations SET status='sold',updated_at=NOW() WHERE id=$1 RETURNING *", [reservation.id]);
        return { alreadySold: false, reservation: updated.rows[0], soldTonnes: nextSold };
      });
      res.json(settled);
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
      if (status === 404) return res.status(404).json({ error: "Reserva não encontrada" });
      if (status === 409) return res.status(409).json({ error: "Reserva não está ativa" });
      fail(res, error);
    }
  });
}
