import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../../frontend/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../frontend/src/MarketApp.tsx", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../../frontend/src/MarketShell.tsx", import.meta.url), "utf8");
const legal = fs.readFileSync(new URL("../../frontend/src/LegalPages.tsx", import.meta.url), "utf8");
const intake = fs.readFileSync(new URL("../src/public-corporate-demand-routes.ts", import.meta.url), "utf8");
const notify = fs.readFileSync(new URL("../src/inbound-lead-notification.ts", import.meta.url), "utf8");
const render = fs.readFileSync(new URL("../../render.yaml", import.meta.url), "utf8");
const robots = fs.readFileSync(new URL("../../frontend/public/robots.txt", import.meta.url), "utf8");
const sitemap = fs.readFileSync(new URL("../../frontend/public/sitemap.xml", import.meta.url), "utf8");

assert.match(index, /EcoTracker \| Créditos de carbono para empresas/);
assert.doesNotMatch(index, /Carbon Tokenization Protocol/);
assert.match(index, /og:title/);
assert.match(index, /application\/ld\+json/);
assert.match(index, /Alternative Ventures Ltda/);

for (const route of ["privacy", "terms", "contact", "request"]) {
  assert.match(app, new RegExp('page === "' + route + '"'));
}
assert.match(shell, /#privacy/);
assert.match(shell, /#terms/);
assert.match(shell, /61\.920\.356\/0001-38/);
assert.match(legal, /Política de Privacidade/);
assert.match(legal, /Termos de Uso e Condições Gerais/);
assert.match(legal, /Solicitar exclusão ou anonimização/);

assert.match(intake, /notifyInboundCorporateLead/);
assert.match(intake, /sendInboundCorporateReceipt/);
assert.match(notify, /RESEND_API_KEY/);
assert.match(notify, /ECOT_LEAD_NOTIFY_EMAIL/);
assert.match(notify, /ecotracker-inbound-receipt/);

assert.match(render, /CARBONMARK_ORDER_EXECUTION_ENABLED\n\s+value: "false"/);
assert.match(render, /CORPORATE_BASKET_PAYMENT_ENABLED\n\s+value: "false"/);
assert.match(render, /ECOT_COMMERCIAL_OUTREACH_ENABLED\n\s+value: "false"/);
assert.match(render, /ECOT_SUPPLY_OUTREACH_ENABLED\n\s+value: "false"/);
assert.match(render, /ECOT_LEAD_NOTIFY_EMAIL/);

assert.match(robots, /Sitemap:/);
assert.match(sitemap, /ecotracker10\.netlify\.app/);

console.log("EcoTracker launch readiness smoke OK");
