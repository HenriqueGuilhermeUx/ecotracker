import assert from "node:assert/strict";
import fs from "node:fs";
const routes=fs.readFileSync(new URL("../src/client-agreement-routes.ts",import.meta.url),"utf8");
const desk=fs.readFileSync(new URL("../../frontend/src/LargeOrderDealDesk.tsx",import.meta.url),"utf8");
for(const expected of ["CLIENT_AGREEMENT_REQUIRED","agreement/generate","electronic_acceptance_v1","document_sha256","quote_snapshot_sha256"]) assert.match(routes,new RegExp(expected));
for(const expected of ["Gerar contrato do cliente","Copiar link para cliente","PAYMENT GATE ELIGIBLE"]) assert.match(desk,new RegExp(expected));
console.log("Client Agreement static smoke OK");
