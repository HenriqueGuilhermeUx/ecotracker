import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  approveExecutionReadinessReview,
  createExecutionReadinessReview,
  executionReadinessEnvironmentStatus,
  executionReadinessForAsset,
  executionReadinessQueue,
  listExecutionReadinessReviews,
  rejectExecutionReadinessReview,
  revokeExecutionAuthorization,
} from "./execution-readiness.js";

const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value||"";
function fail(res:Response,error:unknown){
  const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;
  const payload:Record<string,unknown>={error:error instanceof Error?error.message:"Erro interno"};
  for(const key of ["code","preview","review","executionReadiness"]){if(typeof error==="object"&&error&&key in error)payload[key]=(error as Record<string,unknown>)[key];}
  return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json(payload);
}

export function registerExecutionReadinessRoutes(app:Application){
  app.get("/api/admin/execution-readiness/status",requireAdmin,async(_req:Request,res:Response)=>{
    try{res.setHeader("Cache-Control","no-store");return res.json(await executionReadinessEnvironmentStatus());}catch(error){return fail(res,error);}
  });

  app.get("/api/admin/execution-readiness/queue",requireAdmin,async(req:Request,res:Response)=>{
    try{const items=await executionReadinessQueue(Number(req.query.limit||100));res.setHeader("Cache-Control","no-store");return res.json({count:items.length,items});}catch(error){return fail(res,error);}
  });

  app.get("/api/admin/execution-readiness/reviews",requireAdmin,async(req:Request,res:Response)=>{
    try{const items=await listExecutionReadinessReviews({status:String(req.query.status||""),limit:Number(req.query.limit||100)});res.setHeader("Cache-Control","no-store");return res.json({count:items.length,items});}catch(error){return fail(res,error);}
  });

  app.get("/api/admin/market/assets/:id/execution-readiness",requireAdmin,async(req:Request,res:Response)=>{
    try{res.setHeader("Cache-Control","no-store");return res.json(await executionReadinessForAsset(Number(one(req.params.id))));}catch(error){return fail(res,error);}
  });

  app.post("/api/admin/market/assets/:id/execution-reviews",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({
      supplierSettlementMode:z.enum(["supplier_invoice","prepaid","postpaid","manual_contract"]),
      proofSlaHours:z.coerce.number().int().min(1).max(720),
      authorizationTtlHours:z.coerce.number().int().min(1).max(168).optional(),
      sourceAdapter:z.literal("external_http_executor").optional(),
      retirementAdapter:z.literal("external_http_executor").optional(),
      note:z.string().max(10000).nullable().optional(),
      actor:z.string().min(2).max(255).nullable().optional(),
    }).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Execution Readiness Review inválida",details:parsed.error.flatten()});
    try{return res.status(201).json(await createExecutionReadinessReview({assetId:Number(one(req.params.id)),...parsed.data}));}catch(error){return fail(res,error);}
  });

  app.post("/api/admin/execution-readiness/reviews/:id/approve",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({reviewedBy:z.string().min(2).max(255).nullable().optional(),note:z.string().max(10000).nullable().optional()}).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Aprovação de Execution Readiness inválida"});
    try{return res.json(await approveExecutionReadinessReview({reviewId:Number(one(req.params.id)),...parsed.data}));}catch(error){return fail(res,error);}
  });

  app.post("/api/admin/execution-readiness/reviews/:id/reject",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({reason:z.string().min(2).max(10000),reviewedBy:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Rejeição de Execution Readiness inválida",details:parsed.error.flatten()});
    try{return res.json(await rejectExecutionReadinessReview({reviewId:Number(one(req.params.id)),...parsed.data}));}catch(error){return fail(res,error);}
  });

  app.post("/api/admin/market/assets/:id/execution-revoke",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({reason:z.string().min(2).max(10000),revokedBy:z.string().min(2).max(255).nullable().optional()}).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Revogação inválida",details:parsed.error.flatten()});
    try{return res.json(await revokeExecutionAuthorization({assetId:Number(one(req.params.id)),...parsed.data}));}catch(error){return fail(res,error);}
  });
}
