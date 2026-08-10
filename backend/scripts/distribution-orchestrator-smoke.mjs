import assert from "node:assert/strict";
import { initDb, pool } from "../dist/db.js";
import { initMarketDb } from "../dist/market-db.js";
import { initEligibilityDb } from "../dist/eligibility-db.js";
import { initCommerceDb } from "../dist/commerce-db.js";
import { initAssistedSourcingDb } from "../dist/assisted-sourcing-db.js";
import { initSupplyDeskDb } from "../dist/supply-desk-db.js";
import { initDemandDeskDb } from "../dist/demand-desk-db.js";
import { initDemandProposalDb } from "../dist/demand-proposal-db.js";
import { initDemandSupplyRfqDb } from "../dist/demand-supply-rfq-db.js";
import { initSupplyOutreachDb } from "../dist/supply-outreach-db.js";
import { initSupplyIntakeDb } from "../dist/supply-intake-db.js";
import { initSupplyEligibilityDb } from "../dist/supply-eligibility-db.js";
import { initDistributionDb } from "../dist/distribution-db.js";
import { createSupplyIntakeFromSelection, updateSupplyIntake, approveSupplyIntake, convertApprovedSupplyIntake } from "../dist/supply-intake.js";
import { approveSupplyEligibility } from "../dist/supply-eligibility.js";
import { amendMandateChannels, planDistribution, activateDistributionChannel, reserveDistribution, distributionDesk } from "../dist/distribution-orchestrator.js";

const tag=Date.now();
const future="2026-12-31T23:59:59.000Z";

async function init(){
  await initDb();await initMarketDb();await initEligibilityDb();await initCommerceDb();await initAssistedSourcingDb();
  await initSupplyDeskDb();await initDemandDeskDb();await initDemandProposalDb();await initDemandSupplyRfqDb();
  await initSupplyOutreachDb();await initSupplyIntakeDb();await initSupplyEligibilityDb();await initDistributionDb();
}

async function seed(){
  await pool.query(`UPDATE monitored_assets SET active=FALSE WHERE active=TRUE`);
  const account=(await pool.query(`INSERT INTO demand_accounts(source,source_reference,company_name,legal_name,tax_id,sector,country,contact_name,contact_email,contact_status,status,lead_score,metadata,last_checked_at)
    VALUES('distribution_smoke',$1,'Buyer Distribution S.A.','Buyer Distribution S.A.','52.000.000/0001-00','Industrial','Brasil','ESG',$2,'qualified','qualified',99,'{}'::jsonb,NOW()) RETURNING *`,[`buyer-${tag}`,`buyer-${tag}@example.com`])).rows[0];
  const opp=(await pool.query(`INSERT INTO demand_opportunities(account_id,status,target_tonnes,target_basis,claim_purpose,target_year,priority_score,constraints,notes)
    VALUES($1,'sourcing_required',10000,'custom','voluntary_offset',2026,99,'{}'::jsonb,'Distribution smoke') RETURNING *`,[account.id])).rows[0];
  const rfq=(await pool.query(`INSERT INTO market_maker_rfqs(opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,preferred_country,priority_score,requirements,source)
    VALUES($1,$2,'open','voluntary_offset',2026,10000,0,10000,'Brasil',99,'{}'::jsonb,'distribution_smoke') RETURNING *`,[opp.id,account.id])).rows[0];
  const evidence=`https://example.com/registry/${tag}`;
  const source=`https://example.com/source/${tag}`;
  const lead=(await pool.query(`INSERT INTO supply_leads(registry,registry_project_id,project_name,country,region,supplier_name,supplier_contact_name,supplier_email,methodology,vintage,issued_tonnes,retired_tonnes,withdrawn_tonnes,estimated_unretired_tonnes,confirmed_free_tonnes,evidence_url,source_url,data_source,availability_confidence,contact_status,status,notes,metadata,last_checked_at)
    VALUES('Verra VCS',$1,'Projeto Distribution Smoke','Brasil','Pará','Fornecedor Distribution Ltda','Mesa',$2,'VM0047','2026',20000,10000,0,10000,10000,$3,$4,'distribution_smoke','seller_confirmed','qualified','qualified','Seller-confirmed','{}'::jsonb,NOW()) RETURNING *`,[`VCS-DIST-${tag}`,`supplier-${tag}@example.com`,evidence,source])).rows[0];
  const candidate=(await pool.query(`INSERT INTO market_maker_rfq_candidates(rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at)
    VALUES($1,'seller_confirmed',$2,$3,'Verra VCS',$4,'Projeto Distribution Smoke','Brasil','2026',10000,'seller_confirmed',95,'qualified',FALSE,'{}'::jsonb,'{}'::jsonb,NOW()) RETURNING *`,[rfq.id,`lead:${lead.id}`,lead.id,lead.registry_project_id])).rows[0];
  const selection=(await pool.query(`INSERT INTO market_maker_supply_selections(rfq_id,candidate_id,supply_lead_id,requested_tonnes,status,response_due_at,selected_by,selected_note,snapshot)
    VALUES($1,$2,$3,10000,'responded',NOW()+INTERVAL '5 days','Distribution Smoke','Seller respondeu','{}'::jsonb) RETURNING *`,[rfq.id,candidate.id,lead.id])).rows[0];
  await pool.query(`INSERT INTO market_maker_supply_responses(selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,retirement_supported,beneficiary_retirement_supported,registry_evidence_url,valid_until,response_note,responded_by,response_snapshot)
    VALUES($1,'confirmed',10000,8.75,1,TRUE,TRUE,$2,$3::timestamptz,'Confirmado','Distribution Smoke','{}'::jsonb)`,[selection.id,evidence,future]);
  return {opp,rfq,selection,evidence,source};
}

async function prepare(seed){
  const intake=await createSupplyIntakeFromSelection({selectionId:Number(seed.selection.id),createdBy:"Distribution Smoke"});
  await updateSupplyIntake({reviewId:Number(intake.id),authorizedTonnes:10000,floorPriceUsdTonne:8.75,minOrderTonnes:1,batchReference:`BATCH-DIST-${tag}`,vintage:"2026",serialStart:`SERIAL-${tag}-1`,serialEnd:`SERIAL-${tag}-10000`,methodology:"VM0047",registryEvidenceUrl:seed.evidence,sourceUrl:seed.source,retirementSupported:true,beneficiaryRetirementSupported:true,fractionalRetirementSupported:true,retirementGranularityKg:1,commercialValidUntil:future,legalKycStatus:"approved",registryEvidenceStatus:"verified",commercialTermsStatus:"approved",reviewNote:"Diligência completa distribution smoke.",actor:"Distribution Smoke"});
  await approveSupplyIntake({reviewId:Number(intake.id),approvedBy:"Distribution Smoke",note:"Aprovado"});
  const conversion=await convertApprovedSupplyIntake({reviewId:Number(intake.id),convertedBy:"Distribution Smoke"});
  await approveSupplyEligibility({intakeReviewId:Number(intake.id),reviewedBy:"Distribution Smoke",eligibilityBasis:"Registry, batch, serials, tradability, vintage e retirement verificados para distribuição comercial.",tradabilityConfirmed:true,riskFlags:[]});
  return {intake,conversion};
}

async function expectError(fn,status){
  try{await fn();assert.fail("Expected error");}catch(error){assert.equal(Number(error?.status||0),status);return error;}
}

async function run(){
  await init();const seed=await seed();const {conversion}=await prepare(seed);
  const inventoryId=Number(conversion.inventory.id);const mandateId=Number(conversion.mandate.id);const assetId=Number(conversion.monitoredAsset.id);

  assert.deepEqual(conversion.mandate.allowed_channels,["direct","otc"]);
  await expectError(()=>planDistribution({inventoryId,channels:["carbonmark","regen","otc"],preparedBy:"Distribution Smoke"}),409);

  const amendment=await amendMandateChannels({mandateId,allowedChannels:["direct","otc","carbonmark","regen"],evidenceUrl:`https://example.com/mandate/${tag}`,note:"Fornecedor autorizou distribuição não exclusiva em Carbonmark, Regen, OTC e canal direto.",amendedBy:"Distribution Smoke"});
  assert.equal(String(amendment.amendment_sha256).length,64);

  const plan=await planDistribution({inventoryId,channels:["carbonmark","regen","otc"],markupPct:15,preparedBy:"Distribution Smoke"});
  assert.equal(Number(plan.globalAvailableTonnes),10000);
  assert.ok(Number(plan.askPriceUsdTonne)>8.75);
  assert.equal(String(plan.deployment_sha256).length,64);

  const listings=(await pool.query(`SELECT * FROM supply_channel_listings WHERE inventory_id=$1 ORDER BY channel`,[inventoryId])).rows;
  assert.equal(listings.length,3);
  listings.forEach(row=>assert.equal(Number(row.advertised_tonnes),10000,"Each channel may expose full global balance without multiplying inventory"));
  const inventory=(await pool.query(`SELECT * FROM supply_inventory WHERE id=$1`,[inventoryId])).rows[0];
  assert.equal(Number(inventory.authorized_tonnes),10000);
  assert.equal(Number(inventory.sold_tonnes),0);

  await expectError(()=>activateDistributionChannel({inventoryId,channel:"carbonmark",actor:"Distribution Smoke"}),409);
  await activateDistributionChannel({inventoryId,channel:"carbonmark",externalListingId:`CM-${tag}`,externalUrl:`https://example.com/carbonmark/${tag}`,actor:"Distribution Smoke"});
  await activateDistributionChannel({inventoryId,channel:"otc",actor:"Distribution Smoke"});

  const first=await reserveDistribution({inventoryId,channel:"carbonmark",externalOrderId:`ORDER-A-${tag}`,reservedTonnes:6000,actor:"Distribution Smoke"});
  assert.equal(first.idempotent,false);
  const duplicate=await reserveDistribution({inventoryId,channel:"carbonmark",externalOrderId:`ORDER-A-${tag}`,reservedTonnes:6000,actor:"Distribution Smoke"});
  assert.equal(duplicate.idempotent,true);
  assert.equal(Number(duplicate.id),Number(first.id));

  await expectError(()=>reserveDistribution({inventoryId,channel:"otc",externalOrderId:`ORDER-B-${tag}`,reservedTonnes:5000,actor:"Distribution Smoke"}),409);
  const second=await reserveDistribution({inventoryId,channel:"otc",externalOrderId:`ORDER-C-${tag}`,reservedTonnes:4000,actor:"Distribution Smoke"});
  assert.equal(Number(second.reserved_tonnes),4000);

  const total=(await pool.query(`SELECT COALESCE(SUM(reserved_tonnes),0) AS total FROM supply_reservations WHERE inventory_id=$1 AND status IN ('active','pending')`,[inventoryId])).rows[0];
  assert.equal(Number(total.total),10000);
  const desk=await distributionDesk();const row=desk.items.find(item=>Number(item.id)===inventoryId);
  assert.ok(row);assert.equal(Number(row.available_tonnes),0);assert.equal(row.claimReady,true);assert.equal(Boolean(row.asset.sourcing_executable),false);

  let deploymentImmutable=false;try{await pool.query(`UPDATE distribution_deployments SET markup_pct=99 WHERE id=$1`,[plan.id]);}catch(error){deploymentImmutable=String(error?.message||error).includes("distribution_audit_record_is_immutable");}
  assert.equal(deploymentImmutable,true);
  let amendmentImmutable=false;try{await pool.query(`UPDATE distribution_mandate_amendments SET note='mutated' WHERE id=$1`,[amendment.id]);}catch(error){amendmentImmutable=String(error?.message||error).includes("distribution_audit_record_is_immutable");}
  assert.equal(amendmentImmutable,true);
  const asset=(await pool.query(`SELECT * FROM monitored_assets WHERE id=$1`,[assetId])).rows[0];assert.equal(asset.sourcing_executable,false);

  console.log("Distribution Orchestrator smoke OK",{sameInventoryAcrossThreeChannels:true,authorizedTonnes:10000,advertisedExposureTonnes:30000,economicInventoryTonnes:10000,reservationA:6000,reservationB:4000,overbookingBlocked:true,idempotentExternalOrder:true,claimReady:true,programmaticExecution:false,auditImmutable:true});
}

try{await run();}finally{await pool.end();}
