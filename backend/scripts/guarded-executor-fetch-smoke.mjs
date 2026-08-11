import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { pool } from "../dist/db.js";
import { guardedExecutorFetch } from "../dist/guarded-executor-fetch.js";

async function run(){
  const supply=(await pool.query(`SELECT id FROM monitored_assets WHERE source_reference LIKE 'supply-intake:%' AND sourcing_executable=FALSE ORDER BY id LIMIT 1`)).rows[0];
  const provider=(await pool.query(`SELECT id FROM monitored_assets WHERE source_reference LIKE 'carbonmark:%' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.ok(supply?.id,"Supply-intake fixture ausente; execute execution-readiness-smoke primeiro");
  assert.ok(provider?.id,"Provider-managed fixture ausente; execute execution-readiness-smoke primeiro");

  let networkCalls=0;
  const server=http.createServer(async(req,res)=>{
    for await(const _chunk of req){}
    networkCalls+=1;
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw new Error("Mock executor unavailable");
  const base=`http://127.0.0.1:${address.port}/source`;
  process.env.SOURCE_EXECUTOR_URL=base;
  process.env.SOURCE_EXECUTOR_TOKEN="guard-smoke-token";
  delete process.env.RETIREMENT_EXECUTOR_URL;
  delete process.env.RETIREMENT_EXECUTOR_TOKEN;

  try{
    let supplyBlocked=false;
    try{
      await guardedExecutorFetch(`${base}/execute`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({assetId:Number(supply.id),operation:"acquisition"})});
    }catch(error){supplyBlocked=String(error?.code||"")==="EXECUTION_READINESS_REQUIRED";}
    assert.equal(supplyBlocked,true,"Unauthorized supply-intake must be blocked before executor network call");
    assert.equal(networkCalls,0,"Blocked supply-intake must not reach executor HTTP server");

    const providerResponse=await guardedExecutorFetch(`${base}/execute`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({assetId:Number(provider.id),operation:"acquisition"})});
    assert.equal(providerResponse.ok,true);
    assert.equal(networkCalls,1,"Provider-managed source should reach executor when asset identity is known");

    let identityBlocked=false;
    try{
      await guardedExecutorFetch(`${base}/execute`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation:"acquisition"})});
    }catch(error){identityBlocked=String(error?.code||"")==="EXECUTION_ASSET_IDENTITY_REQUIRED";}
    assert.equal(identityBlocked,true,"Generic executor call without asset identity must fail closed");
    assert.equal(networkCalls,1,"Identity-less executor call must not reach network");

    console.log("Guarded Executor Fetch smoke OK",{supplyBlockedBeforeNetwork:true,providerManagedPassed:true,identityRequired:true,networkCalls});
  }finally{
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
}

try{await run();}finally{await pool.end();}
