import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  approveSupplyIntake,
  convertApprovedSupplyIntake,
  createSupplyIntakeFromSelection,
  getSupplyIntake,
  listSupplyIntakes,
  rejectSupplyIntake,
  updateSupplyIntake,
} from "./supply-intake.js";

const one = (value:string|string[]|undefined) => Array.isArray(value) ? value[0] : value || "";

function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : 500).json({
    error:error instanceof Error ? error.message : "Erro interno",
    problems:typeof error === "object" && error && "problems" in error ? (error as {problems:unknown}).problems : undefined,
  });
}

const optionalUrl = z.string().url().max(5000).nullable().optional();

export function registerSupplyIntakeRoutes(app:Application) {
  app.get("/api/admin/supply/intakes",requireAdmin,async (req:Request,res:Response) => {
    try {
      const items = await listSupplyIntakes({status:String(req.query.status || ""),limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/supply/intakes/:id",requireAdmin,async (req:Request,res:Response) => {
    try {
      const item = await getSupplyIntake(Number(one(req.params.id)));
      if (!item) return res.status(404).json({error:"Supply Intake não encontrado"});
      res.setHeader("Cache-Control","no-store");
      return res.json(item);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/supply-selections/:id/intake",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({createdBy:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Criação de Supply Intake inválida"});
    try {
      return res.status(201).json(await createSupplyIntakeFromSelection({
        selectionId:Number(one(req.params.id)),createdBy:parsed.data.createdBy,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.patch("/api/admin/supply/intakes/:id",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      authorizedTonnes:z.coerce.number().positive().max(1_000_000_000).optional(),
      floorPriceUsdTonne:z.coerce.number().positive().max(1_000_000).nullable().optional(),
      minOrderTonnes:z.coerce.number().nonnegative().max(1_000_000_000).nullable().optional(),
      batchReference:z.string().max(255).nullable().optional(),
      vintage:z.string().max(80).nullable().optional(),
      serialStart:z.string().max(255).nullable().optional(),
      serialEnd:z.string().max(255).nullable().optional(),
      methodology:z.string().max(255).nullable().optional(),
      registryEvidenceUrl:optionalUrl,
      sourceUrl:optionalUrl,
      retirementSupported:z.boolean().optional(),
      beneficiaryRetirementSupported:z.boolean().optional(),
      fractionalRetirementSupported:z.boolean().optional(),
      retirementGranularityKg:z.coerce.number().int().positive().max(1_000_000_000).optional(),
      commercialValidUntil:z.string().datetime().nullable().optional(),
      legalKycStatus:z.enum(["pending","approved","rejected"]).optional(),
      registryEvidenceStatus:z.enum(["pending","verified","rejected"]).optional(),
      commercialTermsStatus:z.enum(["pending","approved","rejected"]).optional(),
      reviewNote:z.string().max(10000).nullable().optional(),
      actor:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Atualização do Supply Intake inválida",details:parsed.error.flatten()});
    try {
      return res.json(await updateSupplyIntake({reviewId:Number(one(req.params.id)),...parsed.data}));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/supply/intakes/:id/approve",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      approvedBy:z.string().min(2).max(255).nullable().optional(),
      note:z.string().max(10000).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Aprovação do Supply Intake inválida"});
    try {
      return res.json(await approveSupplyIntake({reviewId:Number(one(req.params.id)),...parsed.data}));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/supply/intakes/:id/reject",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({
      reason:z.string().min(2).max(10000),
      rejectedBy:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Rejeição do Supply Intake inválida",details:parsed.error.flatten()});
    try {
      return res.json(await rejectSupplyIntake({reviewId:Number(one(req.params.id)),...parsed.data}));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/supply/intakes/:id/convert",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({convertedBy:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Conversão do Supply Intake inválida"});
    try {
      return res.status(201).json(await convertApprovedSupplyIntake({reviewId:Number(one(req.params.id)),...parsed.data}));
    } catch (error) { return fail(res,error); }
  });
}
