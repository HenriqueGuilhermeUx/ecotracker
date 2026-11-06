import assert from "node:assert/strict";
import fs from "node:fs";

const db=fs.readFileSync(new URL("../src/partner-client-registration-db.ts",import.meta.url),"utf8");
const routes=fs.readFileSync(new URL("../src/partner-client-registration-routes.ts",import.meta.url),"utf8");
const panel=fs.readFileSync(new URL("../../frontend/src/PartnerRegistrationPanel.tsx",import.meta.url),"utf8");
const desk=fs.readFileSync(new URL("../../frontend/src/LargeOrderDealDesk.tsx",import.meta.url),"utf8");
const hook=fs.readFileSync(new URL("../src/market-hook.ts",import.meta.url),"utf8");

assert.match(db,/CREATE TABLE IF NOT EXISTS partner_client_registrations/);
assert.match(db,/UNIQUE\(account_id,partner_key\)/);
assert.match(db,/deemed_confirmed/);
assert.match(db,/confirmation_date/);

assert.match(routes,/Schedule 1/);
assert.match(routes,/drew@carbonmark\.com/);
assert.match(routes,/requiresHumanReviewBeforeSend:true/);
assert.match(routes,/5 weekdays from sent_at/);
assert.match(routes,/holidayCheckConfirmed:z\.literal\(true\)/);
assert.match(routes,/status='deemed_confirmed'/);
assert.doesNotMatch(routes,/sendMail|nodemailer|resend|smtp|createCarbonmarkOrder|POST \/orders/);

assert.match(panel,/Preparar e-mail para Drew/);
assert.match(panel,/Marcar enviado/);
assert.match(panel,/Validar confirmação presumida/);
assert.match(panel,/não envia automaticamente sem revisão humana/);
assert.match(panel,/Strategic Account/);

assert.match(desk,/PartnerRegistrationPanel/);
assert.match(hook,/initPartnerClientRegistrationDb/);
assert.match(hook,/registerPartnerClientRegistrationRoutes/);

console.log("Schedule 1 client registration workflow smoke OK");
