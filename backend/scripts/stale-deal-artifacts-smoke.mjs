import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/demand-supply-rfq-routes.ts", import.meta.url), "utf8");

assert.match(source, /status='superseded'/);
assert.match(source, /status='cancelled'/);
assert.match(source, /sourcing_status='invalidated'/);
assert.match(source, /q\.payment_status='not_started'/);
assert.match(source, /q\.status IN \('requested','quoted'\)/);
assert.match(source, /a\.eligibility_status<>'eligible'/);
assert.match(source, /a\.availability_status NOT IN \('confirmed','indicative'\)/);
assert.match(source, /COALESCE\(a\.available_tons,0\)<=0/);
assert.match(source, /STALE_COVERAGE_ACTIVE_COMMERCE/);
assert.match(source, /staleAssistedQuotesCancelled/);
assert.match(source, /totalQuotesCancelled/);
assert.match(source, /status='sourcing_required'/);

console.log("Stale Deal Artifacts smoke OK");
