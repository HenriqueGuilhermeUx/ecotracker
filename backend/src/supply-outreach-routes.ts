import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  cancelSupplyOutbox,
  createSupplySelectionOutbox,
  dispatchSupplyOutbox,
  listSupplyOutbox,
  listSupplySelections,
  selectSupplyCandidate,
  supplyOutreachStatus,
} from "./supply-outreach.js";
import { recordSupplyResponse } from "./supply-outreach-response.js";

const one = (value:string|string[]|undefined) => Array.isArray(value) ? value[0] : value || "";

function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  const message = error instanceof Error ? error.message : "Erro interno";
  const mapped = message.includes("market_maker_supply_selection_overallocated") ? "Volume solicitado ultrapassa o gap ou o volume disponível do candidato"
    : message.includes("market_maker_supply_candidate_wrong_rfq") ? "Candidato não pertence a este RFQ"
    : message.includes("market_maker_rfq_not_open") ? "RFQ não está aberto"
    : message.includes("market_maker_supply_candidate_not_selectable") ? "Candidato de supply não está selecionável"
    : message;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : message.startsWith("market_maker_") ? 409 : 500).json({error:mapped});
}

export function registerSupplyOutreachRoutes(app:Application) {
  app.get("/api/admin/market-maker/supply-outreach/status",requireAdmin,async (_req:Request,res:Response) => {
    try {
      res.setHeader("Cache-Control","no-store");
      return res.json(await supplyOutreachStatus());
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/market-maker/supply-selections",requireAdmin,async (req:Request,res:Response) => {
    try {
      const items = await listSupplySelections({status:String(req.query.status || ""),limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/rfqs/:rfqId/candidates/:candidateId/select",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      requestedTonnes:z.coerce.number().positive().max(1_000_000_000),
      responseDays:z.coerce.number().int().min(1).max(30).default(5),
      selectedBy:z.string().min(2).max(255).nullable().optional(),
      note:z.string().max(5000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Seleção de fornecedor inválida",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await selectSupplyCandidate({
        rfqId:Number(one(req.params.rfqId)),candidateId:Number(one(req.params.candidateId)),
        requestedTonnes:parsed.data.requestedTonnes,responseDays:parsed.data.responseDays,
        selectedBy:parsed.data.selectedBy,note:parsed.data.note,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-selections/:id/outbox",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      recipientEmail:z.string().email().max(320).nullable().optional(),
      recipientName:z.string().max(255).nullable().optional(),
      createdBy:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Outbox de fornecedor inválido",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await createSupplySelectionOutbox({
        selectionId:Number(one(req.params.id)),recipientEmail:parsed.data.recipientEmail,
        recipientName:parsed.data.recipientName,createdBy:parsed.data.createdBy,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/market-maker/supply-outbox",requireAdmin,async (req:Request,res:Response) => {
    try {
      const items = await listSupplyOutbox({status:String(req.query.status || ""),limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-outbox/:id/dispatch",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({actor:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Dispatch de supply inválido"});
    try {
      const result = await dispatchSupplyOutbox(Number(one(req.params.id)),{actor:parsed.data.actor});
      if (result.failed) return res.status(502).json(result);
      return res.json(result);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-outbox/:id/cancel",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      actor:z.string().min(2).max(255).nullable().optional(),
      reason:z.string().max(5000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Cancelamento de supply inválido"});
    try {
      return res.json(await cancelSupplyOutbox({
        outboxId:Number(one(req.params.id)),actor:parsed.data.actor,reason:parsed.data.reason,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-selections/:id/response",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      confirmedAvailableTonnes:z.coerce.number().nonnegative().max(1_000_000_000),
      firmPriceUsdTonne:z.coerce.number().positive().max(1_000_000).nullable().optional(),
      minOrderTonnes:z.coerce.number().nonnegative().max(1_000_000_000).nullable().optional(),
      retirementSupported:z.boolean().default(false),
      beneficiaryRetirementSupported:z.boolean().default(false),
      registryEvidenceUrl:z.string().url().max(5000).nullable().optional(),
      validUntil:z.string().datetime().nullable().optional(),
      responseNote:z.string().max(10000).nullable().optional(),
      respondedBy:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Resposta do fornecedor inválida",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await recordSupplyResponse({
        selectionId:Number(one(req.params.id)),confirmedAvailableTonnes:parsed.data.confirmedAvailableTonnes,
        firmPriceUsdTonne:parsed.data.firmPriceUsdTonne,minOrderTonnes:parsed.data.minOrderTonnes,
        retirementSupported:parsed.data.retirementSupported,
        beneficiaryRetirementSupported:parsed.data.beneficiaryRetirementSupported,
        registryEvidenceUrl:parsed.data.registryEvidenceUrl,validUntil:parsed.data.validUntil,
        responseNote:parsed.data.responseNote,respondedBy:parsed.data.respondedBy,
      }));
    } catch (error) { return fail(res,error); }
  });
}
