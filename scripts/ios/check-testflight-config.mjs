#!/usr/bin/env node
// Static release configuration guard only; no network, Apple or EAS access.
import {readFileSync} from 'node:fs';
const expo=JSON.parse(readFileSync('mobile/app.json','utf8')).expo;
const pkg=JSON.parse(readFileSync('mobile/package.json','utf8'));
const eas=JSON.parse(readFileSync('mobile/eas.json','utf8'));
const errors=[];
const check=(valid,reason)=>{if(!valid) errors.push(reason)};
const https=(value)=>{try{return new URL(value).protocol==='https:'}catch{return false}};
check(expo.ios?.bundleIdentifier==='com.alternativeventures.ecotracker','iOS bundle identifier differs from the inventory');
check(expo.android?.package==='com.alternativeventures.ecotracker','Android package differs; reconcile AAB');
check(expo.ios?.supportsTablet===true,'Declared iPad support changed');
check(/^~?56\./.test(pkg.dependencies?.expo??''),'Unexpected Expo SDK; inspect compatibility');
check(pkg.main==='expo-router/entry','Expo Router entry point changed');
check(/^[0-9a-f-]{36}$/i.test(expo.extra?.eas?.projectId??''),'Missing EAS project ID; verify ownership');
for(const key of ['privacyUrl','termsUrl','deletionUrl']) check(https(expo.extra?.[key]),'Missing HTTPS '+key);
check(https(eas.build?.production?.env?.EXPO_PUBLIC_API_URL),'Production API must be HTTPS');
check(eas.cli?.appVersionSource==='remote','Remote EAS version source changed; check Apple build version behavior');
check(eas.build?.production?.autoIncrement===true,'EAS autoIncrement changed; inspect build numbering');
check(eas.build?.production?.android?.buildType==='app-bundle','Android production profile differs; do not change existing release');
check(eas.submit?.production?.ios && typeof eas.submit.production.ios==='object','Explicit iOS submit profile missing; verify ASC connection before publishing');
console.log('INFO: Expo remote versioning / autoIncrement is configured; inspect current App Store Connect build before EAS production build');
console.log('INFO: iOS usesNonExemptEncryption declaration and company/registered publisher information require legal review');
console.log('INFO: iOS signed build, Apple Team, App Store Connect association, Play AAB and real QA are NOT verified');
for(const err of errors) console.error('FAIL:',err);
if(errors.length) process.exitCode=1;
else console.log('PASS: EcoTracker static release configuration only; NOT TestFlight-ready');
