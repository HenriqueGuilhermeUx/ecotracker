import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
const source=path.resolve("mobile/dist");
const target=path.resolve("frontend/dist/app");
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
await cp(source,target,{recursive:true});
console.log("EcoTracker native PWA merged into frontend/dist/app");
