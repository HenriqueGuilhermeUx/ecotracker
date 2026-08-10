import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { callCommerceExecutor, carbonmarkOrderExecutionStatus } from "../dist/commerce-providers.js";

const payload={
  sourceReference:"carbonmark-listing-smoke",
  sourceOrderId:"quote-smoke-uuid",
  quoteCode:"ECOT-CARBONMARK-SMOKE",
  requestedKg:1000,
  beneficiary:"EcoTracker Smoke",
};

async function run(){
  const original={
    key:process.env.CARBONMARK_API_KEY,
    enabled:process.env.CARBONMARK_ORDER_EXECUTION_ENABLED,
    ack:process.env.CARBONMARK_ORDER_EXECUTION_ACK,
    environment:process.env.CARBONMARK_ENVIRONMENT,
  };
  try{
    delete process.env.CARBONMARK_API_KEY;
    process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="false";
    process.env.CARBONMARK_ORDER_EXECUTION_ACK="DISABLED";
    process.env.CARBONMARK_ENVIRONMENT="sandbox";
    let status=carbonmarkOrderExecutionStatus();
    assert.equal(status.configured,false);
    assert.equal(status.live,false);
    assert.equal(status.stableApiVersion,"v18");

    process.env.CARBONMARK_API_KEY="cm_api_fake_smoke_never_sent";
    status=carbonmarkOrderExecutionStatus();
    assert.equal(status.configured,true);
    assert.equal(status.enabled,false);
    assert.equal(status.acknowledged,false);
    assert.equal(status.live,false);
    assert.equal(status.quoteMode,"shadow_quote_available");
    assert.equal(status.orderMode,"blocked");

    const flagOff=await callCommerceExecutor("source",payload);
    assert.equal(flagOff.configured,true);
    assert.equal(flagOff.status,"blocked");
    assert.equal(flagOff.retired,undefined);
    assert.equal(flagOff.metadata?.gate?.live,false);

    process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="true";
    process.env.CARBONMARK_ORDER_EXECUTION_ACK="DISABLED";
    const ackOff=await callCommerceExecutor("source",payload);
    assert.equal(ackOff.status,"blocked");
    assert.equal(ackOff.metadata?.gate?.enabled,true);
    assert.equal(ackOff.metadata?.gate?.acknowledged,false);

    process.env.CARBONMARK_ORDER_EXECUTION_ENABLED="false";
    process.env.CARBONMARK_ORDER_EXECUTION_ACK="ENABLE_LIVE_CARBONMARK_RETIREMENTS";
    const flagStillOff=await callCommerceExecutor("source",payload);
    assert.equal(flagStillOff.status,"blocked");
    assert.equal(flagStillOff.metadata?.gate?.enabled,false);
    assert.equal(flagStillOff.metadata?.gate?.acknowledged,true);

    const render=await readFile("../render.yaml","utf8");
    assert.match(render,/CARBONMARK_API_BASE[\s\S]*https:\/\/v18\.api\.carbonmark\.com/);
    assert.match(render,/CARBONMARK_ORDER_EXECUTION_ENABLED[\s\S]*value: "false"/);
    assert.match(render,/CARBONMARK_ORDER_EXECUTION_ACK[\s\S]*value: DISABLED/);
    assert.equal(render.includes("https://v19.api.carbonmark.com"),false,"Render must not point Carbonmark at non-stable v19");

    console.log("Carbonmark execution gate smoke OK",{
      stableApiVersion:"v18",
      shadowQuoteAllowedWithKey:true,
      orderBlockedWithFlagOff:true,
      orderBlockedWithoutAck:true,
      doubleGateRequired:true,
      noProviderCallMade:true,
      renderLiveExecution:false,
    });
  }finally{
    if(original.key===undefined) delete process.env.CARBONMARK_API_KEY; else process.env.CARBONMARK_API_KEY=original.key;
    if(original.enabled===undefined) delete process.env.CARBONMARK_ORDER_EXECUTION_ENABLED; else process.env.CARBONMARK_ORDER_EXECUTION_ENABLED=original.enabled;
    if(original.ack===undefined) delete process.env.CARBONMARK_ORDER_EXECUTION_ACK; else process.env.CARBONMARK_ORDER_EXECUTION_ACK=original.ack;
    if(original.environment===undefined) delete process.env.CARBONMARK_ENVIRONMENT; else process.env.CARBONMARK_ENVIRONMENT=original.environment;
  }
}

await run();
