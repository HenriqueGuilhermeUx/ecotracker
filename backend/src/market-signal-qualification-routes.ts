import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  approveMarketSignalEligibility,
  listMarketSignalQualifications,
  probeMarketSignal,
  submitMarketSignalEligibilityReview,
} from "./market-signal-qualification.js";

const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value||"";

function fail(res:Response,error:unknown){
  const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;
  const body:Record<string,unknown>={error:error instanceof Error?error.message:"Erro interno"};
  if(typeof error==="object"&&error&&"code" in error) body.code=(error as {code:unknown}).code;
  if(typeof error==="object"&&error&&"problems" in error) body.problems=(error as {problems:unknown}).problems;
  if(typeof error==="object"&&error&&"decision" in error) body.decision=(error as {decision:unknown}).decision;
  if(typeof error==="object"&&error&&"qualification" in error) body.qualification=(error as {qualification:unknown}).qualification;
  return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json(body);
}

const probeSchema=z.object({
  assetId:z.coerce.number().int().positive(),
  requestedKg:z.coerce.number().int().positive().max(10_000_000).optional(),
  createdBy:z.string().max(255).nullable().optional(),
});

const reviewSchema=z.object({submittedBy:z.string().max(255).nullable().optional()});

const approvalSchema=z.object({
  reviewedBy:z.string().max(255).nullable().optional(),
  eligibilityBasis:z.string().min(20).max(5000),
  tradabilityConfirmed:z.boolean(),
  commercialValidUntil:z.string().date(),
  registryEvidenceUrl:z.string().url().max(5000).nullable().optional(),
  retirementSupported:z.boolean(),
  beneficiaryRetirementSupported:z.boolean(),
  fractionalRetirementSupported:z.boolean().optional(),
  retirementGranularityKg:z.coerce.number().int().positive().max(1_000_000).optional(),
  ccpStatus:z.enum(["approved","eligible_program","not_approved","not_assessed"]).optional(),
  vintageStart:z.string().date().nullable().optional(),
  vintageEnd:z.string().date().nullable().optional(),
  riskFlags:z.array(z.string().max(120)).max(30).optional(),
});

export function registerMarketSignalQualificationRoutes(app:Application){
  app.get("/api/admin/market-maker/market-signals/qualifications",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const items=await listMarketSignalQualifications({status:String(req.query.status||""),limit:Number(req.query.limit||100)});
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,items});
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/market-maker/market-signals/probe",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=probeSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Probe de market signal inválido",details:parsed.error.flatten()});
    try{return res.status(201).json(await probeMarketSignal(parsed.data));}
    catch(error){return fail(res,error);}
  });

  app.post("/api/admin/market-maker/market-signals/qualifications/:id/submit-review",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=reviewSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Submissão para eligibility inválida"});
    try{return res.json(await submitMarketSignalEligibilityReview({qualificationId:Number(one(req.params.id)),submittedBy:parsed.data.submittedBy}));}
    catch(error){return fail(res,error);}
  });

  app.post("/api/admin/market-maker/market-signals/qualifications/:id/approve",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=approvalSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Revisão claim-ready inválida",details:parsed.error.flatten()});
    try{return res.json(await approveMarketSignalEligibility({qualificationId:Number(one(req.params.id)),...parsed.data}));}
    catch(error){return fail(res,error);}
  });
}
