import type { Application, Request, Response } from "express";
import { requireAdmin } from "./auth.js";
import { generateDemandMatches } from "./demand-matching.js";
import { resolveDemandSupplyRfq, upsertDemandSupplyRfq } from "./demand-supply-rfq.js";

export function registerDealDeskRoutes(app: Application) {
  app.post("/api/admin/deal-desk/opportunities/:id/source", requireAdmin, async (req: Request, res: Response) => {
    try {
      const opportunityId = Number(req.params.id);
      const matching = await generateDemandMatches(opportunityId);
      let rfq = null;
      if (matching.fullyCovered) {
        await resolveDemandSupplyRfq(opportunityId, Number(matching.coveredTonnes));
      } else {
        rfq = await upsertDemandSupplyRfq({
          opportunityId,
          targetTonnes: Number(matching.targetTonnes),
          coveredTonnes: Number(matching.coveredTonnes),
          gapTonnes: Number(matching.uncoveredTonnes),
          source: "deal_desk",
        });
      }
      res.json({
        matching,
        rfq,
        nextAction: matching.fullyCovered ? "create_proposal" : "source_more_credits",
        safeguards: { claimReadyRequiredToClose: true, commercialReviewRequired: true },
      });
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : 500;
      res.status(status >= 400 && status < 600 ? status : 500).json({ error: error instanceof Error ? error.message : "Falha no Deal Desk" });
    }
  });
}
