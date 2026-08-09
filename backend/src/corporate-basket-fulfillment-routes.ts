import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import {
  finalizeCorporateBasketFulfillment,
  flagCorporateBasketFulfillmentLegReview,
  getCorporateBasketEvidence,
  getCorporateBasketFulfillment,
  markCorporateBasketEcotDelivered,
  recordCorporateBasketAcquisition,
  recordCorporateBasketDocument,
  recordCorporateBasketRetirement,
  resolveCorporateBasketFulfillmentLegReview,
  startCorporateBasketFulfillment,
} from "./corporate-basket-fulfillment.js";

const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value || "";
const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : undefined;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : 500).json({
    error:error instanceof Error ? error.message : "Erro interno",
    ...(code ? { code } : {}),
  });
};

export function registerCorporateBasketFulfillmentRoutes(app: Application) {
  app.post("/api/admin/demand/baskets/:id/fulfillment/start", requireAdmin, async (req:Request,res:Response) => {
    try { return res.status(201).json(await startCorporateBasketFulfillment(Number(one(req.params.id)))); }
    catch (error) { return fail(res,error); }
  });

  app.get("/api/admin/demand/baskets/:id/fulfillment", requireAdmin, async (req:Request,res:Response) => {
    try {
      const fulfillment = await getCorporateBasketFulfillment(Number(one(req.params.id)));
      if (!fulfillment) return res.status(404).json({ error:"Fulfillment não iniciado" });
      res.setHeader("Cache-Control","no-store");
      return res.json(fulfillment);
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:basketId/fulfillment/legs/:legId/acquire", requireAdmin, async (req:Request,res:Response) => {
    const parsed = z.object({
      sourceReference:z.string().min(2).max(1000),
      sourceTxHash:z.string().max(255).nullable().optional(),
      sourceEvidenceUrl:z.string().url().nullable().optional(),
      acquiredKg:z.coerce.number().int().positive().max(1_000_000_000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:"Registro de aquisição inválido",details:parsed.error.flatten() });
    try {
      return res.json(await recordCorporateBasketAcquisition({
        basketId:Number(one(req.params.basketId)),fulfillmentLegId:Number(one(req.params.legId)),
        sourceReference:parsed.data.sourceReference,sourceTxHash:parsed.data.sourceTxHash || null,
        sourceEvidenceUrl:parsed.data.sourceEvidenceUrl || null,acquiredKg:parsed.data.acquiredKg || null,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:basketId/fulfillment/legs/:legId/retire", requireAdmin, async (req:Request,res:Response) => {
    const parsed = z.object({
      retirementReference:z.string().min(2).max(1000),
      retirementTxHash:z.string().max(255).nullable().optional(),
      retirementEvidenceUrl:z.string().url().nullable().optional(),
      certificateUrl:z.string().url().nullable().optional(),
      retiredKg:z.coerce.number().int().positive().max(1_000_000_000).nullable().optional(),
      beneficiaryName:z.string().max(255).nullable().optional(),
      beneficiaryTaxId:z.string().max(40).nullable().optional(),
      evidence:z.record(z.string(),z.unknown()).default({}),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:"Registro de retirement inválido",details:parsed.error.flatten() });
    try {
      return res.json(await recordCorporateBasketRetirement({
        basketId:Number(one(req.params.basketId)),fulfillmentLegId:Number(one(req.params.legId)),
        retirementReference:parsed.data.retirementReference,retirementTxHash:parsed.data.retirementTxHash || null,
        retirementEvidenceUrl:parsed.data.retirementEvidenceUrl || null,certificateUrl:parsed.data.certificateUrl || null,
        retiredKg:parsed.data.retiredKg || null,beneficiaryName:parsed.data.beneficiaryName || null,
        beneficiaryTaxId:parsed.data.beneficiaryTaxId || null,evidence:parsed.data.evidence,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:basketId/fulfillment/legs/:legId/review", requireAdmin, async (req:Request,res:Response) => {
    const parsed = z.object({ reason:z.string().min(3).max(5000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:"Motivo de revisão inválido" });
    try {
      return res.json(await flagCorporateBasketFulfillmentLegReview({
        basketId:Number(one(req.params.basketId)),fulfillmentLegId:Number(one(req.params.legId)),reason:parsed.data.reason,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:basketId/fulfillment/legs/:legId/resolve-review", requireAdmin, async (req:Request,res:Response) => {
    try {
      return res.json(await resolveCorporateBasketFulfillmentLegReview({
        basketId:Number(one(req.params.basketId)),fulfillmentLegId:Number(one(req.params.legId)),
      }));
    } catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/fulfillment/finalize", requireAdmin, async (req:Request,res:Response) => {
    try { return res.json(await finalizeCorporateBasketFulfillment(Number(one(req.params.id)))); }
    catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/fulfillment/deliver-ecot", requireAdmin, async (req:Request,res:Response) => {
    try { return res.json(await markCorporateBasketEcotDelivered(Number(one(req.params.id)))); }
    catch (error) { return fail(res,error); }
  });

  app.post("/api/admin/demand/baskets/:id/documents", requireAdmin, async (req:Request,res:Response) => {
    const parsed = z.object({
      documentType:z.enum(["receipt","nfse"]),provider:z.string().max(60).nullable().optional(),
      providerReference:z.string().max(255).nullable().optional(),documentUrl:z.string().url(),
      data:z.record(z.string(),z.unknown()).default({}),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:"Documento inválido",details:parsed.error.flatten() });
    try {
      return res.json(await recordCorporateBasketDocument({
        basketId:Number(one(req.params.id)),documentType:parsed.data.documentType,provider:parsed.data.provider || null,
        providerReference:parsed.data.providerReference || null,documentUrl:parsed.data.documentUrl,data:parsed.data.data,
      }));
    } catch (error) { return fail(res,error); }
  });

  app.get("/api/demand/baskets/:publicCode/evidence", async (req:Request,res:Response) => {
    try {
      const evidence = await getCorporateBasketEvidence(one(req.params.publicCode));
      if (!evidence) return res.status(404).json({ error:"Evidência ainda não disponível" });
      res.setHeader("Cache-Control","no-store");
      return res.json(evidence);
    } catch (error) { return fail(res,error); }
  });
}
