import express from "express";
import { initMarketDb } from "./market-db.js";
import { registerMarketRoutes } from "./market-routes.js";

const proto=express.application as unknown as {listen:(...args:unknown[])=>unknown;__marketInstalled?:boolean};
if(!proto.__marketInstalled){
  const original=proto.listen;
  proto.listen=function(this:unknown,...args:unknown[]){
    const app=this as Parameters<typeof registerMarketRoutes>[0];
    registerMarketRoutes(app);
    void initMarketDb().then(()=>original.apply(this,args)).catch(error=>{console.error("[market] initialization failed",error);process.exit(1);});
    return this;
  };
  proto.__marketInstalled=true;
}
