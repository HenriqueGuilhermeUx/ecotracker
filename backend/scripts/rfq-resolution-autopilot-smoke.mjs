import assert from "node:assert/strict";
import fs from "node:fs";

const core = fs.readFileSync(new URL("../src/rfq-resolution-autopilot.ts", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/sourcing-autopilot-routes.ts", import.meta.url), "utf8");
const sell = fs.readFileSync(new URL("../../frontend/src/SellDesk.tsx", import.meta.url), "utf8");

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

// Sell Desk is intentionally customer-safe. Internal sourcing economics stay hidden.
assert.match(sell, /Informação pronta para o cliente/);
assert.match(sell, /PRONTO PARA CLIENTE/);
assert.match(sell, /Copiar resumo para cliente/);
assert.match(sell, /Preço por tonelada/);
assert.match(sell, /Valor total/);
assert.match(sell, /Ver evidência do projeto/);
assert.match(sell, /review_eligible_now === true/);
assert.match(sell, /review_status === "approved"/);
assert.doesNotMatch(sell, /Custo provider do gap/);
assert.doesNotMatch(sell, /Custo médio provider/);
assert.doesNotMatch(sell, /Legs encontradas/);
assert.doesNotMatch(sell, /Provider provou/);

console.log("RFQ resolution autopilot + client-safe Sell Desk smoke OK");
