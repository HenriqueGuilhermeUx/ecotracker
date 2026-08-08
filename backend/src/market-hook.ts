import express from "express";
import { initMarketDb } from "./market-db.js";
import { initCommerceDb } from "./commerce-db.js";
import { initEligibilityDb } from "./eligibility-db.js";
import { initPrivacyDb } from "./privacy-db.js";
import { getPublicCommerceQuote } from "./commerce-query.js";
import { registerCarbonmarkRoutes } from "./carbonmark-routes.js";
import { refreshCarbonmarkIfStale } from "./carbonmark.js";
import { registerCommerceRoutes } from "./commerce-routes.js";
import { registerEligibilityRoutes } from "./eligibility-routes.js";
import { registerMarketRoutes } from "./market-routes.js";
import { registerPrivacyRoutes } from "./privacy-routes.js";
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
    // Carbonmark é registrado antes das rotas genéricas: sincroniza o catálogo e,
    // para listings Carbonmark, trava o custo real da fonte antes da cobrança.
    registerCarbonmarkRoutes(app);
    // A trava de elegibilidade continua protegendo todas as demais fontes.
    registerEligibilityRoutes(app);
    registerCommerceRoutes(app);
    registerMarketRoutes(app);
    // quote_requests nasce em initMarketDb; a elegibilidade adiciona campos/snapshot;
    // depois o módulo de comércio adiciona pagamento e fulfillment.
    void initMarketDb()
      .then(() => initEligibilityDb())
      .then(() => initCommerceDb())
      .then(() => initPrivacyDb())
      .then(async () => {
        // Não impede o boot se a Carbonmark estiver temporariamente indisponível.
        await refreshCarbonmarkIfStale(0).catch((error) => console.warn("[carbonmark] initial refresh failed", error));
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
