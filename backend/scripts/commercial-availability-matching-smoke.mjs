import assert from "node:assert/strict";
import fs from "node:fs";

const enrichment = fs.readFileSync(new URL("../src/gold-standard-enrichment.ts", import.meta.url), "utf8");
const matching = fs.readFileSync(new URL("../src/demand-matching.ts", import.meta.url), "utf8");

assert.match(enrichment, /const storefrontAvailable = boolAt\(marketplace\.storefrontAvailable\)/);
assert.match(enrichment, /const commercialStock = storefrontAvailable && hasStock \? stock : 0/);
assert.match(enrichment, /const verified = storefrontAvailable && hasStock && allVintagesWithinPolicy && hasEvidence/);
assert.match(enrichment, /storefrontAvailable && hasStock \? "tradable" : "unknown"/);
assert.match(enrichment, /gold-standard-marketplace-currently-unavailable/);

assert.match(matching, /availability_status IN \('confirmed','indicative'\)/);
assert.match(matching, /COALESCE\(available_tons,0\)>0/);

console.log("Commercial availability matching smoke OK");
