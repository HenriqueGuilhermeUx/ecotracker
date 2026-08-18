import assert from "node:assert/strict";
import fs from "node:fs";

const hook = fs.readFileSync(new URL("../src/market-hook.ts", import.meta.url), "utf8");
const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");

assert.match(hook, /process\.env\.WOOVI_ENABLED === "true"/);
assert.match(hook, /WOOVI_CREDENTIAL_ROTATION_REQUIRED/);
assert.match(hook, /req\.path\.endsWith\("\/checkout"\)/);
assert.match(hook, /req\.path\.startsWith\("\/api\/webhooks\/woovi"\)/);
assert.match(envExample, /WOOVI_ENABLED=false/);
assert.match(envExample, /WOOVI_APP_ID=\s*$/m);
assert.doesNotMatch(envExample, /WOOVI_APP_ID=\S+/);

console.log("Woovi incident-response kill switch smoke OK");
