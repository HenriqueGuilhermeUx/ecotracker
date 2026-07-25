import express from "express";
import { initMarketDb } from "./market-db.js";
import { initCommerceDb } from "./commerce-db.js";
import { registerCommerceRoutes } from "./commerce-routes.js";
import { registerMarketRoutes } from "./market-routes.js";
import { startCommerceWorker } from "./commerce-service.js";

const proto = express.application as unknown as {
  listen: (...args: unknown[]) => unknown;
  __marketInstalled?: boolean;
};

if (!proto.__marketInstalled) {
  const original = proto.listen;
  proto.listen = function (this: unknown, ...args: unknown[]) {
    const app = this as Parameters<typeof registerMarketRoutes>[0];
    // As rotas de comércio vêm primeiro para enriquecer o acompanhamento público.
    registerCommerceRoutes(app);
    registerMarketRoutes(app);
    void Promise.all([initMarketDb(), initCommerceDb()])
      .then(() => {
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
