import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL(path,import.meta.url),"utf8");
const db=read("../src/market-signal-qualification-db.ts");
const core=read("../src/market-signal-qualification.ts");
const routes=read("../src/market-signal-qualification-routes.ts");
const hook=read("../src/market-hook.ts");
const rail=read("../../frontend/src/CarbonmarkRailPanel.tsx");

assert.match(db,/market_signal_qualifications/);
assert.match(db,/commercial_volume_proven/);
assert.match(db,/market_signal_qualification_events/);
assert.match(db,/market_signal_qualification_event_is_immutable/);

assert.match(core,/createCarbonmarkShadowQuote/);
assert.match(core,/Maximum quotable quantity exceeded/i);
assert.match(core,/diagnostic_only/);
assert.match(core,/Provider quote is evidence of a quotable market path, not seller-confirmed inventory/);
assert.match(core,/eligibility_review/);
assert.match(core,/sourcing_executable=FALSE/);
assert.match(core,/evaluateAssetEligibility\(asset,"voluntary_offset",requestedKg\)/);
assert.match(core,/generateDemandMatches/);
assert.match(core,/market_signal_qualification/);
assert.doesNotMatch(core,/POST \/orders/);

assert.match(routes,/market-signals\/probe/);
assert.match(routes,/submit-review/);
assert.match(routes,/qualifications\/:id\/approve/);
assert.match(routes,/tradabilityConfirmed/);
assert.match(routes,/beneficiaryRetirementSupported/);

assert.match(hook,/initMarketSignalQualificationDb/);
assert.match(hook,/registerMarketSignalQualificationRoutes/);
assert.match(hook,/initCarbonmarkRailDb\(\)\)[\s\S]*initMarketSignalQualificationDb\(\)/);

assert.match(rail,/Market Signal Qualification Gate/);
assert.match(rail,/Provider-quotable ≠ seller-confirmed ≠ claim-ready/);
assert.match(rail,/Aprovar claim-ready/);
assert.match(rail,/Produção Carbonmark continua bloqueada/);

console.log("Market signal qualification smoke OK");
