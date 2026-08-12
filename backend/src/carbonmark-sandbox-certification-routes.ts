import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { carbonmarkSandboxCertificationControl, runCarbonmarkSandboxCertification } from "./carbonmark-sandbox-certification.js";

const runSchema=z.object({
  assetId:z.coerce.number().int().positive(),
  requestedKg:z.coerce.number().int().positive().max(100000),
  beneficiaryName:z.string().min(2).max(255),
  retirementMessage:z.string().max(500).optional(),
  executedBy:z.string().max(255).nullable().optional(),
  certificationMode:z.enum(["claim_ready","technical_probe"]).optional(),
});
function fail(res:Response,error:unknown){const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;const body:Record<string,unknown>={error:error instanceof Error?error.message:"Erro interno"};if(typeof error==="object"&&error&&"gate" in error)body.gate=(error as {gate:unknown}).gate;if(typeof error==="object"&&error&&"decision" in error)body.decision=(error as {decision:unknown}).decision;return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json(body);}

export function registerCarbonmarkSandboxCertificationRoutes(app:Application){
  app.get("/api/admin/market/carbonmark/sandbox-certification",requireAdmin,async(_req:Request,res:Response)=>{try{res.setHeader("Cache-Control","no-store");return res.json(await carbonmarkSandboxCertificationControl());}catch(error){return fail(res,error);}});
  app.post("/api/admin/market/carbonmark/sandbox-certification/run",requireAdmin,async(req:Request,res:Response)=>{const parsed=runSchema.safeParse(req.body||{});if(!parsed.success)return res.status(400).json({error:"Certificação sandbox inválida",details:parsed.error.flatten()});try{return res.status(201).json(await runCarbonmarkSandboxCertification(parsed.data));}catch(error){return fail(res,error);}});
}
