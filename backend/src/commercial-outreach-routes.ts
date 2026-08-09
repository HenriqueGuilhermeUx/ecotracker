import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  approveDemandProposal,
  cancelDemandOutbox,
  commercialOutreachStatus,
  createDemandProposalOutbox,
  dispatchDemandOutbox,
  getDemandProposalReview,
  listDemandOutbox,
  rejectDemandProposal,
} from "./commercial-outreach.js";

const one = (value:string|string[]|undefined) => Array.isArray(value) ? value[0] : value || "";

function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : 500).json({
    error:error instanceof Error ? error.message : "Erro interno",
  });
}

export function registerCommercialOutreachRoutes(app:Application) {
  app.get("/api/admin/demand/outreach/status",requireAdmin,async (_req:Request,res:Response) => {
    try {
      res.setHeader("Cache-Control","no-store");
      return res.json(await commercialOutreachStatus());
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/proposals/:id/review/approve",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      reviewedBy:z.string().min(2).max(255).nullable().optional(),
      note:z.string().max(5000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Aprovação comercial inválida",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await approveDemandProposal({
        proposalId:Number(one(req.params.id)),reviewedBy:parsed.data.reviewedBy,note:parsed.data.note,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/proposals/:id/review/reject",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      reviewedBy:z.string().min(2).max(255).nullable().optional(),
      reason:z.string().min(3).max(5000),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Rejeição comercial inválida",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await rejectDemandProposal({
        proposalId:Number(one(req.params.id)),reviewedBy:parsed.data.reviewedBy,reason:parsed.data.reason,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/proposals/:id/review",requireAdmin,async (req:Request,res:Response) => {
    try {
      const review = await getDemandProposalReview(Number(one(req.params.id)));
      if (!review) return res.status(404).json({error:"Proposta ainda não possui revisão comercial"});
      res.setHeader("Cache-Control","no-store");
      return res.json(review);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/proposals/:id/outbox",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      recipientEmail:z.string().email().max(320).nullable().optional(),
      recipientName:z.string().max(255).nullable().optional(),
      actor:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Outbox inválido",details:parsed.error.flatten()});
    try {
      return res.status(201).json(await createDemandProposalOutbox({
        proposalId:Number(one(req.params.id)),recipientEmail:parsed.data.recipientEmail,
        recipientName:parsed.data.recipientName,actor:parsed.data.actor,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/outbox",requireAdmin,async (req:Request,res:Response) => {
    try {
      const items = await listDemandOutbox({status:String(req.query.status || ""),limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/outbox/:id/dispatch",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({actor:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Dispatch inválido"});
    try {
      const result = await dispatchDemandOutbox(Number(one(req.params.id)),{actor:parsed.data.actor});
      if (result.failed) return res.status(502).json(result);
      return res.json(result);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/outbox/:id/cancel",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      actor:z.string().min(2).max(255).nullable().optional(),
      reason:z.string().max(5000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Cancelamento inválido"});
    try {
      return res.json(await cancelDemandOutbox({
        outboxId:Number(one(req.params.id)),actor:parsed.data.actor,reason:parsed.data.reason,
      }));
    } catch (error) { return fail(res,error); }
  });
}
