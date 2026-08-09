import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  cancelDemandSupplyRfq,
  getDemandSupplyRfq,
  listDemandSupplyRfqs,
  marketMakerSummary,
  refreshDemandSupplyRfqCandidates,
  upsertDemandSupplyRfq,
} from "./demand-supply-rfq.js";
import { generateDemandMatches } from "./demand-matching.js";

const one = (value:string|string[]|undefined) => Array.isArray(value) ? value[0] : value || "";

function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : 500).json({
    error:error instanceof Error ? error.message : "Erro interno",
  });
}

export function registerDemandSupplyRfqRoutes(app:Application) {
  app.get("/api/admin/market-maker/summary",requireAdmin,async (_req:Request,res:Response) => {
    try {
      res.setHeader("Cache-Control","no-store");
      return res.json(await marketMakerSummary());
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/market-maker/rfqs",requireAdmin,async (req:Request,res:Response) => {
    try {
      const items = await listDemandSupplyRfqs({status:String(req.query.status || ""),limit:Number(req.query.limit || 100)});
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,items});
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/market-maker/rfqs/:id",requireAdmin,async (req:Request,res:Response) => {
    try {
      const item = await getDemandSupplyRfq(Number(one(req.params.id)));
      if (!item) return res.status(404).json({error:"RFQ não encontrado"});
      res.setHeader("Cache-Control","no-store");
      return res.json(item);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/rfqs/:id/refresh",requireAdmin,async (req:Request,res:Response) => {
    try { return res.json(await refreshDemandSupplyRfqCandidates(Number(one(req.params.id)))); }
    catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/market-maker/rfqs/:id/cancel",requireAdmin,async (req:Request,res:Response) => {
    const parsed = z.object({reason:z.string().max(5000).nullable().optional()}).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({error:"Cancelamento inválido"});
    try {
      return res.json(await cancelDemandSupplyRfq({rfqId:Number(one(req.params.id)),reason:parsed.data.reason}));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/opportunities/:id/rfq",requireAdmin,async (req:Request,res:Response) => {
    try {
      const opportunityId = Number(one(req.params.id));
      const matching = await generateDemandMatches(opportunityId);
      const result = await upsertDemandSupplyRfq({
        opportunityId,
        targetTonnes:Number(matching.targetTonnes || 0),
        coveredTonnes:Number(matching.coveredTonnes || 0),
        gapTonnes:Number(matching.uncoveredTonnes || 0),
        source:"manual_admin",
      });
      if (!result && Number(matching.uncoveredTonnes || 0)<=0.001) {
        return res.json({resolved:true,message:"Oportunidade já possui cobertura claim-ready integral; nenhum RFQ aberto.",matching});
      }
      return res.status(201).json({rfq:result,matching});
    } catch (error) { return fail(res,error); }
  });
}
