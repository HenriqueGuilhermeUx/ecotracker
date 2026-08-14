import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { withTransaction } from "./db.js";
import {
  cancelDemandSupplyRfq,
  getDemandSupplyRfq,
  listDemandSupplyRfqs,
  marketMakerSummary,
  refreshDemandSupplyRfqCandidates,
  upsertDemandSupplyRfq,
} from "./demand-supply-rfq.js";
import { generateDemandMatches } from "./demand-matching.js";
import { enrichGoldStandardMarketplaceAssets } from "./gold-standard-enrichment.js";
import { refreshGoldStandardMarketplace } from "./gold-standard-marketplace.js";

const one = (value:string|string[]|undefined) => Array.isArray(value) ? value[0] : value || "";

function fail(res:Response,error:unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:unknown}).status) : 500;
  return res.status(Number.isFinite(status) && status>=400 && status<=599 ? status : 500).json({
    error:error instanceof Error ? error.message : "Erro interno",
  });
}

async function invalidateStaleAssistedQuotes() {
  return withTransaction(async (client) => {
    const staleQuotes = await client.query(`
      UPDATE quote_requests q SET
        status='cancelled',
        sourcing_status='invalidated',
        automation_enabled=FALSE,
        admin_notes=CONCAT_WS(E'\n',NULLIF(q.admin_notes,''),
          'AUTO-INVALIDATED: ativo deixou de ser claim-ready/comercialmente disponível em sincronização posterior.'),
        updated_at=NOW()
      FROM monitored_assets a
      WHERE q.asset_id=a.id
        AND q.automation_enabled=FALSE
        AND q.payment_status='not_started'
        AND q.status IN ('requested','quoted')
        AND (
          a.active IS DISTINCT FROM TRUE OR
          a.claim_category<>'voluntary_offset' OR
          a.eligibility_status<>'eligible' OR
          a.source_unit_status<>'tradable' OR
          a.availability_status NOT IN ('confirmed','indicative') OR
          COALESCE(a.available_tons,0)<=0
        )
      RETURNING q.id`);
    return staleQuotes.rowCount || 0;
  });
}

async function supersedePrePaymentArtifacts(opportunityId:number) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      SELECT p.id,p.public_code,p.status,p.converted_quote_id,
             q.status AS quote_status,q.payment_status
      FROM demand_proposals p
      LEFT JOIN quote_requests q ON q.id=p.converted_quote_id
      WHERE p.opportunity_id=$1
        AND p.status IN ('draft','partial','converted')
      ORDER BY p.created_at DESC
      FOR UPDATE OF p`, [opportunityId]);

    let proposalsSuperseded = 0;
    let quotesCancelled = 0;
    for (const row of rows) {
      if (row.converted_quote_id) {
        const paymentStatus = String(row.payment_status || "not_started");
        if (paymentStatus !== "not_started") {
          throw Object.assign(new Error(
            "A cobertura da oportunidade caiu, mas existe cotação derivada com fluxo de pagamento iniciado. Intervenção manual obrigatória; nenhum artefato foi alterado.",
          ), { status:409, code:"STALE_COVERAGE_ACTIVE_COMMERCE" });
        }
        if (String(row.quote_status || "") !== "cancelled") {
          await client.query(`
            UPDATE quote_requests SET
              status='cancelled',
              sourcing_status='invalidated',
              automation_enabled=FALSE,
              admin_notes=CONCAT_WS(E'\n',NULLIF(admin_notes,''),
                'AUTO-SUPERSEDED: cobertura claim-ready perdida em novo matching; quote não pode mais ser confirmada ou cobrada.'),
              updated_at=NOW()
            WHERE id=$1`, [row.converted_quote_id]);
          quotesCancelled += 1;
        }
      }

      await client.query(`
        UPDATE demand_proposals SET
          status='superseded',
          notes=CONCAT_WS(E'\n',NULLIF(notes,''),
            'AUTO-SUPERSEDED: cobertura claim-ready perdida em novo matching; proposta preservada apenas para auditoria.'),
          updated_at=NOW()
        WHERE id=$1`, [row.id]);
      proposalsSuperseded += 1;
    }

    await client.query(`
      UPDATE demand_opportunities
      SET status='sourcing_required',updated_at=NOW()
      WHERE id=$1`, [opportunityId]);

    return { proposalsSuperseded, quotesCancelled };
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
      // Large corporate matching must not rely on a stale Gold Standard snapshot.
      // Force refresh + enrichment and fail closed if the source cannot be verified now.
      try {
        await refreshGoldStandardMarketplace();
        await enrichGoldStandardMarketplaceAssets();
      } catch (error) {
        console.warn("[demand-rfq] Gold Standard pre-match refresh failed", error);
        return res.status(503).json({
          error:"Não foi possível sincronizar o Gold Standard agora. O matching corporativo foi bloqueado para não usar disponibilidade stale.",
          code:"GOLD_STANDARD_REFRESH_REQUIRED",
          detail:error instanceof Error ? error.message : "Falha ao sincronizar Gold Standard",
        });
      }

      const matching = await generateDemandMatches(opportunityId);
      const staleAssistedQuotesCancelled = await invalidateStaleAssistedQuotes();
      const gapTonnes = Number(matching.uncoveredTonnes || 0);
      const coverageInvalidated = gapTonnes > 0.001
        ? await supersedePrePaymentArtifacts(opportunityId)
        : { proposalsSuperseded:0, quotesCancelled:0 };
      const invalidated = {
        ...coverageInvalidated,
        staleAssistedQuotesCancelled,
        totalQuotesCancelled: coverageInvalidated.quotesCancelled + staleAssistedQuotesCancelled,
      };

      const result = await upsertDemandSupplyRfq({
        opportunityId,
        targetTonnes:Number(matching.targetTonnes || 0),
        coveredTonnes:Number(matching.coveredTonnes || 0),
        gapTonnes,
        source:"manual_admin",
      });
      if (!result && gapTonnes<=0.001) {
        return res.json({resolved:true,message:"Oportunidade já possui cobertura claim-ready integral; nenhum RFQ aberto.",matching,invalidated});
      }
      return res.status(201).json({rfq:result,matching,invalidated});
    } catch (error) { return fail(res,error); }
  });
}
