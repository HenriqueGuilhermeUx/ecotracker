import assert from "node:assert/strict";
import fs from "node:fs";

const db = fs.readFileSync(new URL("../src/demand-supply-rfq-db.ts", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/demand-supply-rfq.ts", import.meta.url), "utf8");

assert.match(db, /monitored_asset_id BIGINT REFERENCES monitored_assets/);
assert.match(db, /'market_signal'/);
assert.match(source, /candidateType.*monitoredAssetId/s);
assert.match(source, /COALESCE\(a\.available_tons,0\)>0/);
assert.match(source, /a\.availability_status IN \('confirmed','indicative'\) OR a\.source_status='connected'/);
assert.match(source, /a\.claim_category='voluntary_offset'/);
assert.match(source, /a\.eligibility_status='eligible'/);
assert.match(source, /a\.source_unit_status='tradable'/);
assert.match(source, /a\.retirement_supported=TRUE/);
assert.match(source, /VALUES\(\$1,'market_signal'/);
assert.match(source, /'identified',FALSE/);
assert.match(source, /eligibilityReviewRequired:true/);
assert.match(source, /commercialInventoryConfirmed:false/);
assert.match(source, /Market signal only\. It cannot close demand/);

console.log("RFQ market signals safety smoke OK");
