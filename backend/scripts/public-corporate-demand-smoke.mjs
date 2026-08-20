import assert from "node:assert/strict";
import fs from "node:fs";

const backend = fs.readFileSync(new URL("../src/public-corporate-demand-routes.ts", import.meta.url), "utf8");
const hook = fs.readFileSync(new URL("../src/market-hook.ts", import.meta.url), "utf8");
const frontend = fs.readFileSync(new URL("../../frontend/src/CorporateDemandIntake.tsx", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../frontend/src/MarketApp.tsx", import.meta.url), "utf8");

assert.match(backend, /\/api\/public\/corporate-demand/);
assert.match(backend, /generateDemandMatches/);
assert.match(backend, /upsertDemandSupplyRfq/);
assert.match(backend, /createDemandProposal/);
assert.match(backend, /privacyConsent/);
assert.match(backend, /website_inbound/);
assert.doesNotMatch(backend, /createCarbonmarkOrder|\/orders|beginPayment|retirement_status\s*=|payment_status\s*=/);
assert.match(hook, /registerPublicCorporateDemandRoutes\(app\)/);
assert.match(frontend, /Solicitar oferta empresarial/);
assert.match(frontend, /Sem pagamento nesta etapa/);
assert.match(frontend, /Nenhum crédito é comprado ou aposentado automaticamente/);
assert.match(app, /page === "request"/);

console.log("Public corporate demand intake smoke OK");
