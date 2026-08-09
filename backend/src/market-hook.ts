import express from "express";
import { initMarketDb } from "./market-db.js";
import { initCommerceDb } from "./commerce-db.js";
import { initEligibilityDb } from "./eligibility-db.js";
import { initPrivacyDb } from "./privacy-db.js";
import { getPublicCommerceQuote } from "./commerce-query.js";
import { registerAssistedQuoteRoutes } from "./assisted-quote-routes.js";
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
import { registerSourcingRoutes } from "./sourcing-routes.js";
import { registerSourcingAutopilotRoutes } from "./sourcing-autopilot-routes.js";
import { initSourcingAutopilotDb, startSourcingAutopilot } from "./sourcing-autopilot.js";
import { rankSourcingInventory } from "./sourcing-engine.js";
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
    // A rota enriquecida vem primeiro para retornar pagamentos, fulfillment e documentos.
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
    // Carbonmark clássico é executável quando o quote real da fonte é travado.
    registerCarbonmarkRoutes(app);
    // x402 amplia discovery; CFC preservation pode virar compensação assistida/fracionária.
    registerKlimaX402Routes(app);
    // Gold Standard acrescenta ofertas comerciais reais; checkout continua assistido.
    registerGoldStandardRoutes(app);
    // Sourcing e Autopilot ficam depois dos provedores e antes das rotas genéricas.
    registerSourcingRoutes(app);
    registerSourcingAutopilotRoutes(app);
    // Toda cotação passa primeiro pela política de elegibilidade.
    registerEligibilityRoutes(app);
    // Fontes quote/indicative/manual podem registrar demanda, nunca cobrança automática.
    registerAssistedQuoteRoutes(app);
    registerCommerceRoutes(app);
    registerMarketRoutes(app);
    // quote_requests nasce em initMarketDb; a elegibilidade adiciona campos/snapshot;
    // depois o módulo de comércio e o Autopilot adicionam suas estruturas operacionais.
    void initMarketDb()
      .then(() => initEligibilityDb())
      .then(() => initCommerceDb())
      .then(() => initPrivacyDb())
      .then(() => initSourcingAutopilotDb())
      .then(async () => {
        // Nenhum provedor impede o boot se estiver temporariamente indisponível.
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
        // Enriquecimentos rodam antes do primeiro ranking para que o shelf reflita
        // o estado verificável mais recente de cada registry/provider.
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
