import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL(path,import.meta.url),"utf8");
const rfq=read("../src/demand-supply-rfq.ts");
const outreach=read("../src/supply-outreach-routes.ts");
const commercial=read("../src/commercial-outreach.ts");
const proposalRoutes=read("../src/demand-proposal-routes.ts");
const ui=read("../../frontend/src/CarbonDeskV2.tsx");

assert.match(rfq,/marketplace_observed/);
assert.match(rfq,/marketplace_indicative/);
assert.match(rfq,/provider_connected_signal/);
assert.doesNotMatch(rfq,/"market_confirmed"/);
assert.match(rfq,/supplierConfirmationRequired:true/);
assert.match(rfq,/supplyAccounting:"unique_economic_supply"/);
assert.match(rfq,/DISTINCT ON \(candidate_type,economic_key\)/);
assert.match(rfq,/monitored_asset_id/);

assert.match(outreach,/MARKET_SIGNAL_REQUIRES_QUALIFICATION/);
assert.match(outreach,/candidate_type\)==="market_signal"/);
assert.match(outreach,/SUPPLY_LEAD_REQUIRED_FOR_OUTREACH/);

assert.match(commercial,/STALE_PROPOSAL_REQUIRES_REMATCH/);
assert.match(commercial,/current_eligibility_status/);
assert.match(commercial,/current_availability_status/);
assert.match(commercial,/current_available_tons/);
assert.match(commercial,/assertCurrentProposal\(bundle\)/);
assert.match(commercial,/assertCurrentProposal\(currentBundle\)/);

assert.match(proposalRoutes,/review_eligible_now/);
assert.match(proposalRoutes,/ma\.eligibility_status<>'eligible'/);
assert.match(proposalRoutes,/ma\.availability_status NOT IN \('confirmed','indicative'\)/);

assert.match(ui,/candidate\.candidateType==="market_signal"/);
assert.match(ui,/Qualificação obrigatória/);
assert.match(ui,/Sinal de mercado/);
assert.match(ui,/Supply único observado/);
assert.match(ui,/review_eligible_now===false/);
assert.match(ui,/proposta\(s\) obsoleta\(s\) ocultada\(s\)/);

console.log("Market signal operational integrity smoke OK");
