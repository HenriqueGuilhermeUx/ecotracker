import assert from "node:assert/strict";
import fs from "node:fs";

const core = fs.readFileSync(new URL("../src/rfq-resolution-autopilot.ts", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/sourcing-autopilot-routes.ts", import.meta.url), "utf8");
const sell = fs.readFileSync(new URL("../../frontend/src/SellDesk.tsx", import.meta.url), "utf8");
const drawer = fs.readFileSync(new URL("../../frontend/src/SellDetailDrawer.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../../frontend/src/sell-desk.css", import.meta.url), "utf8");

assert.match(core, /createCarbonmarkShadowQuote/);
assert.match(core, /findQuotableCapacity/);
assert.match(core, /maximum quotable quantity exceeded/i);
assert.match(core, /partial_provider_capacity/);
assert.match(core, /provider_capacity_found/);
assert.match(core, /runOpenRfqResolutionAutopilot/);
assert.match(core, /startRfqResolutionAutopilot/);
assert.match(core, /final_human_review_required/);
assert.match(core, /sale_ready=FALSE/);
assert.match(core, /No order, payment or retirement|never creates Carbonmark orders/i);
assert.doesNotMatch(core, /createCarbonmarkOrder|POST \/orders|executeCarbonmarkOrder/);

assert.match(routes, /rfq-resolution-autopilot/);
assert.match(routes, /status\(202\)/);
assert.match(routes, /startRfqResolutionAutopilot/);

// Central Sell Desk stays commercial and action-oriented.
assert.match(sell, /Informação pronta para o cliente/);
assert.match(sell, /PRONTO PARA CLIENTE/);
assert.match(sell, /Copiar resumo/);
assert.match(sell, /Contatar cliente/);
assert.match(sell, /Acompanhar/);
assert.match(sell, /Nova ordem/);
assert.match(sell, /review_eligible_now === true/);
assert.match(sell, /review_status === "approved"/);
assert.match(sell, /SellDetailDrawer/);
assert.doesNotMatch(sell, /Custo de aquisição/);
assert.doesNotMatch(sell, /Custo observado/);
assert.doesNotMatch(sell, /Provider cotável/);

// Internal economics and sourcing diagnostics are allowed only inside the admin drawer.
assert.match(drawer, /SOMENTE ADM/);
assert.match(drawer, /Custo de aquisição/);
assert.match(drawer, /Provider cotável/);
assert.match(drawer, /Custo observado/);
assert.match(drawer, /Acompanhamento operacional/);
assert.match(drawer, /Contato do cliente/);
assert.match(drawer, /Acelerar validação/);
assert.match(styles, /sell-drawer-layer/);
assert.match(styles, /sell-card-grid/);
assert.match(styles, /sell-kpis/);

console.log("RFQ resolution autopilot + admin sales cockpit smoke OK");
