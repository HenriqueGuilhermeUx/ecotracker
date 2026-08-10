import express from "express";
import { initMarketDb } from "./market-db.js";
import { initCommerceDb } from "./commerce-db.js";
import { initCorporateBasketDb } from "./corporate-basket-db.js";
import { initCorporateBasketPaymentDb } from "./corporate-basket-payment-db.js";
import { registerCorporateBasketPaymentRoutes, registerCorporateBasketPaymentWebhookRoutes } from "./corporate-basket-payment-routes.js";
import { initCorporateBasketFulfillmentDb } from "./corporate-basket-fulfillment-db.js";
import { registerCorporateBasketFulfillmentRoutes } from "./corporate-basket-fulfillment-routes.js";
import { registerCorporateBasketRoutes } from "./corporate-basket-routes.js";
import { initDemandDeskDb } from "./demand-desk-db.js";
import { registerDemandDeskRoutes } from "./demand-desk-routes.js";
import { initDemandProposalDb } from "./demand-proposal-db.js";
import { registerDemandProposalRoutes } from "./demand-proposal-routes.js";
import { initDemandAutopilotDb } from "./demand-autopilot-db.js";
import { registerDemandAutopilotRoutes } from "./demand-autopilot-routes.js";
import { startDemandAutopilotWorker } from "./demand-autopilot.js";
import { initDemandSupplyRfqDb } from "./demand-supply-rfq-db.js";
import { registerDemandSupplyRfqRoutes } from "./demand-supply-rfq-routes.js";
import { initSupplyOutreachDb } from "./supply-outreach-db.js";
import { registerSupplyOutreachRoutes } from "./supply-outreach-routes.js";
import { initCommercialOutreachDb } from "./commercial-outreach-db.js";
import { registerCommercialOutreachRoutes } from "./commercial-outreach-routes.js";
import { initEligibilityDb } from "./eligibility-db.js";
import { initPrivacyDb } from "./privacy-db.js";
import { getPublicCommerceQuote } from "./commerce-query.js";
import { registerAcrSupplyScoutRoutes } from "./acr-supply-scout.js";
import { registerAssistedQuoteRoutes } from "./assisted-quote-routes.js";
import { initAssistedSourcingDb } from "./assisted-sourcing-db.js";
import { registerAssistedSourcingOpsRoutes } from "./assisted-sourcing-ops-routes.js";
import { registerCarbonmarkRoutes } from "./carbonmark-routes.js";
import { refreshCarbonmarkIfStale } from "./carbonmark.js";
import { registerCommerceRoutes } from "./commerce-routes.js";
import { registerEligibilityRoutes } from "./eligibility-routes.js";
import { enrichGoldStandardIfStale, startGoldStandardEnrichmentWorker } from "./gold-standard-enrichment.js";
import { registerGoldStandardRoutes } from "./gold-standard-routes.js";
import { refreshGoldStandardIfStale } from "./gold-standard-marketplace.js";
import { registerKlimaX402Routes } from "./klima-x402-routes.js";
import { refreshKlimaX402IfStale } from "./klima-x402.js";
import { registerMarketRoutes } from "./market-routes.js";
import { registerPrivacyRoutes } from "./privacy-routes.js";
import { registerPuroSupplyScoutRoutes } from "./puro-supply-scout.js";
import { registerSourcingRoutes } from "./sourcing-routes.js";
import { registerSourcingAutopilotRoutes } from "./sourcing-autopilot-routes.js";
import { initSourcingAutopilotDb, startSourcingAutopilot } from "./sourcing-autopilot.js";
import { rankSourcingInventory } from "./sourcing-engine.js";
import { initSupplyDeskDb } from "./supply-desk-db.js";
import { registerSupplyDeskRoutes } from "./supply-desk-routes.js";
import { registerVerraSupplyScoutRoutes } from "./verra-supply-scout.js";
import { enrichX402CfcIfStale, startX402CfcEnrichmentWorker } from "./x402-cfc-enrichment.js";
import { startCommerceWorker } from "./commerce-service.js";

const proto = express.application as unknown as {
  listen: (...args: unknown[]) => unknown;
  __marketInstalled?: boolean;
};

if (!proto.__marketInstalled) {
  const original = proto.listen;
  proto.listen = function (this: unknown, ...args: unknown[]) {
    const app = this as Parameters<typeof registerMarketRoutes>[0];
    app.get("/api/market/quotes/:publicCode", async (req, res) => {
      try {
        const raw = req.params.publicCode;
        const publicCode = Array.isArray(raw) ? raw[0] : raw;
        const quote = await getPublicCommerceQuote(publicCode);
        if (!quote) return res.status(404).json({ error: "Cotação não encontrada" });
        res.setHeader("Cache-Control", "no-store");
        return res.json(quote);
      } catch (error) {
        console.error("[commerce] public quote failed", error);
        return res.status(500).json({ error: error instanceof Error ? error.message : "Erro interno" });
      }
    });
    registerPrivacyRoutes(app);
    registerCarbonmarkRoutes(app);
    registerKlimaX402Routes(app);
    registerGoldStandardRoutes(app);
    registerSourcingRoutes(app);
    registerSourcingAutopilotRoutes(app);
    registerEligibilityRoutes(app);
    registerAssistedQuoteRoutes(app);
    registerAssistedSourcingOpsRoutes(app);
    registerSupplyDeskRoutes(app);
    registerPuroSupplyScoutRoutes(app);
    registerVerraSupplyScoutRoutes(app);
    registerAcrSupplyScoutRoutes(app);
    registerDemandDeskRoutes(app);
    registerDemandProposalRoutes(app);
    registerDemandAutopilotRoutes(app);
    registerDemandSupplyRfqRoutes(app);
    registerSupplyOutreachRoutes(app);
    registerCommercialOutreachRoutes(app);
    registerCorporateBasketPaymentWebhookRoutes(app);
    registerCorporateBasketPaymentRoutes(app);
    registerCorporateBasketFulfillmentRoutes(app);
    registerCorporateBasketRoutes(app);
    registerCommerceRoutes(app);
    registerMarketRoutes(app);

    void initMarketDb()
      .then(() => initEligibilityDb())
      .then(() => initCommerceDb())
      .then(() => initAssistedSourcingDb())
      .then(() => initSupplyDeskDb())
      .then(() => initDemandDeskDb())
      .then(() => initDemandProposalDb())
      .then(() => initDemandAutopilotDb())
      .then(() => initDemandSupplyRfqDb())
      .then(() => initSupplyOutreachDb())
      .then(() => initCommercialOutreachDb())
      .then(() => initCorporateBasketDb())
      .then(() => initCorporateBasketPaymentDb())
      .then(() => initCorporateBasketFulfillmentDb())
      .then(() => initPrivacyDb())
      .then(() => initSourcingAutopilotDb())
      .then(async () => {
        await Promise.allSettled([
          refreshCarbonmarkIfStale(0),
          refreshKlimaX402IfStale(0),
          refreshGoldStandardIfStale(0),
        ]).then((results) => {
          const names = ["carbonmark", "klima-x402", "gold-standard"];
          results.forEach((result, index) => {
            if (result.status === "rejected") console.warn(`[${names[index]}] initial refresh failed`, result.reason);
          });
        });
        await Promise.allSettled([
          enrichGoldStandardIfStale(0),
          enrichX402CfcIfStale(0),
        ]).then((results) => {
          const names = ["gold-standard", "x402-cfc"];
          results.forEach((result, index) => {
            if (result.status === "rejected") console.warn(`[${names[index]}] initial enrichment failed`, result.reason);
          });
        });
        await rankSourcingInventory(0).catch((error) => console.warn("[sourcing] initial ranking failed", error));
        startGoldStandardEnrichmentWorker();
        startX402CfcEnrichmentWorker();
        startSourcingAutopilot();
        startDemandAutopilotWorker();
        startCommerceWorker();
        return original.apply(this, args);
      })
      .catch((error) => {
        console.error("[commerce] initialization failed", error);
        process.exit(1);
      });
    return this;
  };
  proto.__marketInstalled = true;
}
