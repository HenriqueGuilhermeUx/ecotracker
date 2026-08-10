import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { carbonmarkRailControl, createCarbonmarkShadowQuote } from "./carbonmark-rail.js";

const shadowSchema=z.object({
  assetId:z.coerce.number().int().positive(),
  requestedKg:z.coerce.number().int().positive().max(10_000_000),
  createdBy:z.string().max(255).nullable().optional(),
});

function fail(res:Response,error:unknown){
  const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;
  const body:Record<string,unknown>={error:error instanceof Error?error.message:"Erro interno"};
  if(typeof error==="object"&&error&&"decision" in error) body.decision=(error as {decision:unknown}).decision;
  return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json(body);
}

export function registerCarbonmarkRailRoutes(app:Application){
  app.get("/api/admin/market/carbonmark/control",requireAdmin,async(_req:Request,res:Response)=>{
    try{res.setHeader("Cache-Control","no-store");return res.json(await carbonmarkRailControl());}
    catch(error){return fail(res,error);}
  });

  app.post("/api/admin/market/carbonmark/shadow-quote",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=shadowSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Shadow quote inválida",details:parsed.error.flatten()});
    try{return res.status(201).json(await createCarbonmarkShadowQuote(parsed.data));}
    catch(error){return fail(res,error);}
  });
}
