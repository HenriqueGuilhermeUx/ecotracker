import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { approveSupplyEligibility, listSupplyEligibilityQueue, restrictSupplyEligibility } from "./supply-eligibility.js";

const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value||"";

function fail(res:Response,error:unknown) {
  const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;
  const body:Record<string,unknown>={error:error instanceof Error?error.message:"Erro interno"};
  if(typeof error==="object"&&error&&"problems" in error) body.problems=(error as {problems:unknown}).problems;
  if(typeof error==="object"&&error&&"decision" in error) body.decision=(error as {decision:unknown}).decision;
  return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json(body);
}

const approvalSchema=z.object({
  reviewedBy:z.string().max(255).nullable().optional(),
  eligibilityBasis:z.string().min(20).max(5000),
  tradabilityConfirmed:z.literal(true),
  ccpStatus:z.enum(["approved","eligible_program","not_approved","not_assessed"]).default("not_assessed"),
  vintagePolicyOverride:z.boolean().default(false),
  vintageExceptionReason:z.string().max(3000).nullable().optional(),
  riskFlags:z.array(z.string().min(1).max(120)).max(30).default([]),
}).superRefine((data,ctx)=>{
  if(data.vintagePolicyOverride&&!String(data.vintageExceptionReason||"").trim()) {
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["vintageExceptionReason"],message:"Override de vintage exige justificativa"});
  }
});

const restrictSchema=z.object({
  reviewedBy:z.string().max(255).nullable().optional(),
  reason:z.string().min(10).max(5000),
  riskFlags:z.array(z.string().min(1).max(120)).max(30).default(["supply-eligibility-restricted"]),
});

export function registerSupplyEligibilityRoutes(app:Application) {
  app.get("/api/admin/supply/eligibility-queue",requireAdmin,async(_req:Request,res:Response)=>{
    try {
      const items=await listSupplyEligibilityQueue();
      const summary=items.reduce((acc,item)=>{
        const state=String(item.eligibility_review_status||"")==="approved"?"approved":String(item.eligibility_review_status||"")==="restricted"?"restricted":"pending";
        acc[state]+=1;
        acc[`${state}Tonnes`]+=Number(item.authorized_tonnes||0);
        return acc;
      },{pending:0,approved:0,restricted:0,pendingTonnes:0,approvedTonnes:0,restrictedTonnes:0} as Record<string,number>);
      res.setHeader("Cache-Control","no-store");
      return res.json({count:items.length,summary,items});
    } catch(error){return fail(res,error);}
  });

  app.post("/api/admin/supply/intakes/:id/eligibility/approve",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=approvalSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Revisão de claim-ready inválida",details:parsed.error.flatten()});
    try {
      return res.json(await approveSupplyEligibility({
        intakeReviewId:Number(one(req.params.id)),
        reviewedBy:parsed.data.reviewedBy,
        eligibilityBasis:parsed.data.eligibilityBasis,
        tradabilityConfirmed:parsed.data.tradabilityConfirmed,
        ccpStatus:parsed.data.ccpStatus,
        vintagePolicyOverride:parsed.data.vintagePolicyOverride,
        vintageExceptionReason:parsed.data.vintageExceptionReason,
        riskFlags:parsed.data.riskFlags,
      }));
    } catch(error){return fail(res,error);}
  });

  app.post("/api/admin/supply/intakes/:id/eligibility/restrict",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=restrictSchema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Decisão restritiva inválida",details:parsed.error.flatten()});
    try {
      return res.json(await restrictSupplyEligibility({
        intakeReviewId:Number(one(req.params.id)),reviewedBy:parsed.data.reviewedBy,
        reason:parsed.data.reason,riskFlags:parsed.data.riskFlags,
      }));
    } catch(error){return fail(res,error);}
  });
}
