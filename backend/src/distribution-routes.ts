import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  activateDistributionChannel,
  amendMandateChannels,
  distributionChannels,
  distributionDesk,
  planDistribution,
  reserveDistribution,
  type DistributionChannel,
} from "./distribution-orchestrator.js";

const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value||"";
const channelSchema=z.enum(distributionChannels);

function fail(res:Response,error:unknown){
  const message=error instanceof Error?error.message:"Erro interno";
  const serviceStatus=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):0;
  const status=message.includes("supply_inventory_overallocated")?409:
    Number.isFinite(serviceStatus)&&serviceStatus>=400&&serviceStatus<=599?serviceStatus:500;
  const body:Record<string,unknown>={error:message.includes("supply_inventory_overallocated")?"Reserva ultrapassa o saldo econômico global disponível deste lote":message};
  if(typeof error==="object"&&error&&"decision" in error) body.decision=(error as {decision:unknown}).decision;
  if(typeof error==="object"&&error&&"unauthorized" in error) body.unauthorized=(error as {unauthorized:unknown}).unauthorized;
  return res.status(status).json(body);
}

const amendmentSchema=z.object({
  allowedChannels:z.array(channelSchema).min(1),
  evidenceUrl:z.string().url(),
  note:z.string().min(20).max(5000),
  amendedBy:z.string().max(255).nullable().optional(),
});

const planSchema=z.object({
  channels:z.array(channelSchema).min(1),
  markupPct:z.coerce.number().min(0).max(500).optional(),
  askPriceUsdTonne:z.coerce.number().positive().nullable().optional(),
  preparedBy:z.string().max(255).nullable().optional(),
});

const activateSchema=z.object({
  externalListingId:z.string().min(1).max(255).nullable().optional(),
  externalUrl:z.string().url().nullable().optional(),
  actor:z.string().max(255).nullable().optional(),
});

const reserveSchema=z.object({
  externalOrderId:z.string().min(3).max(255),
  reservedTonnes:z.coerce.number().positive().max(1_000_000_000),
  reservedUntil:z.string().datetime().nullable().optional(),
  actor:z.string().max(255).nullable().optional(),
});

export function registerDistributionRoutes(app:Application){
  app.get("/api/admin/distribution/desk",requireAdmin,async(_req:Request,res:Response)=>{
    try{
      const data=await distributionDesk();
      res.setHeader("Cache-Control","no-store");
      return res.json(data);
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/distribution/mandates/:id/channels",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=amendmentSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Amendment de canais inválido",details:parsed.error.flatten()});
    try{
      return res.status(201).json(await amendMandateChannels({
        mandateId:Number(one(req.params.id)),
        allowedChannels:parsed.data.allowedChannels as DistributionChannel[],
        evidenceUrl:parsed.data.evidenceUrl,
        note:parsed.data.note,
        amendedBy:parsed.data.amendedBy,
      }));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/distribution/inventory/:id/plan",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=planSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Plano de distribuição inválido",details:parsed.error.flatten()});
    try{
      return res.status(201).json(await planDistribution({
        inventoryId:Number(one(req.params.id)),
        channels:parsed.data.channels as DistributionChannel[],
        markupPct:parsed.data.markupPct,
        askPriceUsdTonne:parsed.data.askPriceUsdTonne,
        preparedBy:parsed.data.preparedBy,
      }));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/distribution/inventory/:id/channels/:channel/activate",requireAdmin,async(req:Request,res:Response)=>{
    const channel=channelSchema.safeParse(one(req.params.channel));
    if(!channel.success) return res.status(400).json({error:"Canal de distribuição inválido"});
    const parsed=activateSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Ativação de canal inválida",details:parsed.error.flatten()});
    try{
      return res.json(await activateDistributionChannel({
        inventoryId:Number(one(req.params.id)),channel:channel.data,
        externalListingId:parsed.data.externalListingId,externalUrl:parsed.data.externalUrl,actor:parsed.data.actor,
      }));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/distribution/inventory/:id/channels/:channel/reserve",requireAdmin,async(req:Request,res:Response)=>{
    const channel=channelSchema.safeParse(one(req.params.channel));
    if(!channel.success) return res.status(400).json({error:"Canal de distribuição inválido"});
    const parsed=reserveSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Reserva de distribuição inválida",details:parsed.error.flatten()});
    try{
      return res.status(201).json(await reserveDistribution({
        inventoryId:Number(one(req.params.id)),channel:channel.data,
        externalOrderId:parsed.data.externalOrderId,reservedTonnes:parsed.data.reservedTonnes,
        reservedUntil:parsed.data.reservedUntil,actor:parsed.data.actor,
      }));
    }catch(error){return fail(res,error);}
  });
}
