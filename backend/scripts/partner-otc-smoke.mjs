import assert from "node:assert/strict";
import fs from "node:fs";

const db=fs.readFileSync(new URL("../src/partner-otc-db.ts",import.meta.url),"utf8");
const routes=fs.readFileSync(new URL("../src/partner-otc-routes.ts",import.meta.url),"utf8");
const panel=fs.readFileSync(new URL("../../frontend/src/OtcDeskPanel.tsx",import.meta.url),"utf8");
const hook=fs.readFileSync(new URL("../src/market-hook.ts",import.meta.url),"utf8");
const home=fs.readFileSync(new URL("../../frontend/src/CorporateHome.tsx",import.meta.url),"utf8");
const demand=fs.readFileSync(new URL("../../frontend/src/CorporateDemandIntake.tsx",import.meta.url),"utf8");
const shell=fs.readFileSync(new URL("../../frontend/src/MarketShell.tsx",import.meta.url),"utf8");

assert.match(db,/CREATE TABLE IF NOT EXISTS partner_otc_requests/);
assert.match(db,/CREATE TABLE IF NOT EXISTS partner_otc_options/);
assert.match(db,/erpa_pending/);
assert.match(db,/retired/);

assert.match(routes,/requireAdmin/);
assert.match(routes,/Client identity intentionally excluded/);
assert.match(routes,/clientIdentityIncluded:false/);
assert.match(routes,/partner_key.*carbonmark/s);
assert.match(routes,/source_price_usd_tonne/);
assert.match(routes,/sell_price_brl_tonne/);
assert.match(routes,/margin_pct/);
assert.doesNotMatch(routes,/createCarbonmarkOrder|createCarbonmarkQuote|beginPayment|POST \/orders/);

assert.match(panel,/Mesa OTC/);
assert.match(panel,/Cliente no RFQ/);
assert.match(panel,/NÃO EXPOSTO/);
assert.match(panel,/Nenhuma solicitação foi enviada ao parceiro automaticamente/);
assert.match(panel,/não compra créditos, não cobra o cliente e não executa retirement automaticamente/);
assert.doesNotMatch(panel,/Carbonmark/i);

assert.match(hook,/initPartnerOtcDb/);
assert.match(hook,/registerPartnerOtcRoutes/);

assert.doesNotMatch(home,/Carbonmark/i);
assert.doesNotMatch(demand,/Carbonmark|provider, listing|trading desk/i);
assert.doesNotMatch(shell,/Carbonmark/i);

console.log("Partner OTC desk + provider-hidden public surface smoke OK");
