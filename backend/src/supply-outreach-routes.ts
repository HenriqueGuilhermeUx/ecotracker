import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  createSupplyOutbox,
  dispatchSupplyOutbox,
  listSupplyOutbox,
  listSupplySelections,
  recordSupplyResponse,
  selectSupplyCandidate,
  supplyOutreachStatus,
} from "./supply-outreach.js";

const one = (value:string|string[]|undefined) => Array.isArray(value) ? value[0] : value || "";
function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : 500).json({error:error instanceof Error ? error.message : "Erro interno"});
}

export function registerSupplyOutreachRoutes(app:Application) {
  app.get("/api/admin/market-maker/supply-outreach/status",requireAdmin,async (_req:Request,res:Response) => {
    try { res.setHeader("Cache-Control","no-store"); return res.json(await supplyOutreachStatus()); }
    catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/rfqs/:rfqId/candidates/:candidateId/select",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      requestedTonnes:z.coerce.number().positive().max(1_000_000_000).nullable().optional(),
      maxPriceUsdTonne:z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
      responseDays:z.coerce.number().int().min(1).max(30).nullable().optional(),
      selectedBy:z.string().min(2).max(255).nullable().optional(),
      note:z.string().max(5000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Seleção de fornecedor inválida",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await selectSupplyCandidate({
        rfqId:Number(one(req.params.rfqId)),candidateId:Number(one(req.params.candidateId)),
        requestedTonnes:parsed.data.requestedTonnes,maxPriceUsdTonne:parsed.data.maxPriceUsdTonne,
        responseDays:parsed.data.responseDays,selectedBy:parsed.data.selectedBy,note:parsed.data.note,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-selections/:id/outbox",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      recipientEmail:z.string().email().max(320).nullable().optional(),
      recipientName:z.string().max(255).nullable().optional(),
      createdBy:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Supply outbox inválido",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await createSupplyOutbox({selectionId:Number(one(req.params.id)),...parsed.data}));
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/market-maker/supply-outbox",requireAdmin,async (req:Request,res:Response) => {
    try {
      const items = await listSupplyOutbox({status:String(req.query.status || ""),limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store"); return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/market-maker/supply-selections",requireAdmin,async (req:Request,res:Response) => {
    try {
      const rfqRaw = req.query.rfqId == null ? null : Number(req.query.rfqId);
      const items = await listSupplySelections({rfqId:Number.isFinite(rfqRaw as number) ? rfqRaw as number : null,limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store"); return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-outbox/:id/dispatch",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({actor:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Dispatch inválido"});
    try {
      const result = await dispatchSupplyOutbox(Number(one(req.params.id)),{actor:parsed.data.actor});
      if (result.failed) return res.status(502).json(result);
      return res.json(result);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-selections/:id/response",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      confirmedAvailableTonnes:z.coerce.number().nonnegative().max(1_000_000_000),
      firmPriceUsdTonne:z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
      minOrderTonnes:z.coerce.number().nonnegative().max(1_000_000_000).nullable().optional(),
      retirementSupported:z.boolean().nullable().optional(),
      beneficiaryRetirementSupported:z.boolean().nullable().optional(),
      registryEvidenceUrl:z.string().url().nullable().optional(),
      offerValidUntil:z.string().datetime({offset:true}).nullable().optional(),
      responseNote:z.string().max(10000).nullable().optional(),
      recordedBy:z.string().min(2).max(255).nullable().optional(),
      rawResponse:z.record(z.string(),z.unknown()).default({}),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Resposta do fornecedor inválida",details:parsed.error.flatten()});
    try { return res.status(201).json(await recordSupplyResponse({selectionId:Number(one(req.params.id)),...parsed.data})); }
    catch (error) { return fail(res,error); }
  });
}
