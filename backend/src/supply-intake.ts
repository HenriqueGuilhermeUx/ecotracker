import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";

type Json = Record<string,unknown>;

const num = (value:unknown,fallback=0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function actorName(value?:string|null) {
  const explicit = String(value || "").trim();
  return (explicit || String(process.env.ADMIN_EMAIL || "ecotracker-admin")).slice(0,255);
}

function sha256(value:unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function intakeEvent(client:pg.PoolClient,input:{reviewId:number;eventType:string;actor?:string|null;payload?:Json}) {
  await client.query(`
    INSERT INTO supply_intake_events(review_id,event_type,actor,payload)
    VALUES($1,$2,$3,$4::jsonb)`,[
    input.reviewId,input.eventType,input.actor || null,JSON.stringify(input.payload || {}),
  ]);
}

async function reviewView(id:number) {
  const { rows } = await pool.query(`
    SELECT r.*,
           resp.status AS supplier_response_status,
           resp.confirmed_available_tonnes AS response_confirmed_tonnes,
           resp.firm_price_usd_tonne AS response_price_usd_tonne,
           resp.retirement_supported AS response_retirement_supported,
           resp.beneficiary_retirement_supported AS response_beneficiary_retirement_supported,
           sel.public_code AS selection_public_code,
           rfq.public_code AS rfq_public_code,rfq.status AS rfq_status,rfq.gap_tonnes,
           a.company_name AS buyer_company_name,
           l.supplier_contact_name,l.supplier_email,l.supplier_phone,
           conv.id AS conversion_id,conv.mandate_id,conv.inventory_id,conv.monitored_asset_id,
           ma.eligibility_status AS monitored_eligibility_status,
           ma.claim_category AS monitored_claim_category,
           ma.sourcing_shelf AS monitored_sourcing_shelf,
           ma.sourcing_executable AS monitored_sourcing_executable,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id',e.id,'eventType',e.event_type,'actor',e.actor,'payload',e.payload,'createdAt',e.created_at
           ) ORDER BY e.id) FROM supply_intake_events e WHERE e.review_id=r.id),'[]'::jsonb) AS events
    FROM supply_intake_reviews r
    JOIN market_maker_supply_responses resp ON resp.id=r.response_id
    JOIN market_maker_supply_selections sel ON sel.id=r.selection_id
    JOIN market_maker_rfqs rfq ON rfq.id=r.rfq_id
    JOIN demand_accounts a ON a.id=rfq.account_id
    JOIN supply_leads l ON l.id=r.lead_id
    LEFT JOIN supply_intake_conversions conv ON conv.review_id=r.id
    LEFT JOIN monitored_assets ma ON ma.id=conv.monitored_asset_id
    WHERE r.id=$1`,[id]);
  return rows[0] || null;
}

export async function createSupplyIntakeFromSelection(input:{selectionId:number;createdBy?:string|null}) {
  const review = await withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM supply_intake_reviews WHERE selection_id=$1 FOR UPDATE`,[input.selectionId])).rows[0];
    if (existing) return existing;

    const row = (await client.query(`
      SELECT s.id AS selection_id,s.rfq_id,s.supply_lead_id,s.requested_tonnes,
             resp.id AS response_id,resp.status AS response_status,resp.confirmed_available_tonnes,
             resp.firm_price_usd_tonne,resp.min_order_tonnes,resp.retirement_supported,
             resp.beneficiary_retirement_supported,resp.registry_evidence_url,resp.valid_until,
             c.registry,c.registry_project_id,c.project_name,c.country,c.vintage,
             l.supplier_name,l.methodology,l.region,l.evidence_url AS lead_evidence_url,l.source_url
      FROM market_maker_supply_selections s
      JOIN market_maker_supply_responses resp ON resp.selection_id=s.id
      JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
      JOIN supply_leads l ON l.id=s.supply_lead_id
      WHERE s.id=$1
      FOR UPDATE OF s,resp,c,l`,[input.selectionId])).rows[0];
    if (!row) throw Object.assign(new Error("Seleção ou resposta do fornecedor não encontrada"),{status:404});
    if (row.response_status !== "confirmed" || num(row.confirmed_available_tonnes)<=0) {
      throw Object.assign(new Error("Supply Intake exige resposta seller-confirmed com volume positivo"),{status:409});
    }

    const confirmed = num(row.confirmed_available_tonnes);
    const authorized = Math.min(confirmed,num(row.requested_tonnes,confirmed));
    const reviewRow = (await client.query(`
      INSERT INTO supply_intake_reviews(
        response_id,selection_id,rfq_id,lead_id,status,registry,registry_project_id,project_name,supplier_name,
        confirmed_tonnes,authorized_tonnes,floor_price_usd_tonne,min_order_tonnes,vintage,methodology,country,region,
        registry_evidence_url,source_url,retirement_supported,beneficiary_retirement_supported,
        fractional_retirement_supported,retirement_granularity_kg,commercial_valid_until,metadata
      ) VALUES(
        $1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,FALSE,1000,$21::timestamptz,$22::jsonb
      ) RETURNING *`,[
      row.response_id,row.selection_id,row.rfq_id,row.supply_lead_id,row.registry,row.registry_project_id,row.project_name,
      row.supplier_name,confirmed,authorized,row.firm_price_usd_tonne,row.min_order_tonnes,row.vintage,row.methodology,
      row.country,row.region,row.registry_evidence_url || row.lead_evidence_url || null,row.source_url,
      Boolean(row.retirement_supported),Boolean(row.beneficiary_retirement_supported),row.valid_until || null,
      JSON.stringify({createdFrom:"seller-confirmed-response",createdBy:actorName(input.createdBy),integrityState:"not-claim-ready"}),
    ])).rows[0];
    await intakeEvent(client,{
      reviewId:Number(reviewRow.id),eventType:"intake_created",actor:actorName(input.createdBy),
      payload:{selectionId:input.selectionId,responseId:Number(row.response_id),authorizedTonnes:authorized},
    });
    return reviewRow;
  });
  return reviewView(Number(review.id));
}

export async function updateSupplyIntake(input:{
  reviewId:number;
  authorizedTonnes?:number;
  floorPriceUsdTonne?:number|null;
  minOrderTonnes?:number|null;
  batchReference?:string|null;
  vintage?:string|null;
  serialStart?:string|null;
  serialEnd?:string|null;
  methodology?:string|null;
  registryEvidenceUrl?:string|null;
  sourceUrl?:string|null;
  retirementSupported?:boolean;
  beneficiaryRetirementSupported?:boolean;
  fractionalRetirementSupported?:boolean;
  retirementGranularityKg?:number;
  commercialValidUntil?:string|null;
  legalKycStatus?:"pending"|"approved"|"rejected";
  registryEvidenceStatus?:"pending"|"verified"|"rejected";
  commercialTermsStatus?:"pending"|"approved"|"rejected";
  reviewNote?:string|null;
  actor?:string|null;
}) {
  return withTransaction(async (client) => {
    const current = (await client.query(`SELECT * FROM supply_intake_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if (!current) throw Object.assign(new Error("Supply Intake não encontrado"),{status:404});
    if (!["draft","ready_for_review"].includes(String(current.status))) {
      throw Object.assign(new Error("Supply Intake não pode mais ser editado"),{status:409});
    }
    const own = (key:string) => Object.prototype.hasOwnProperty.call(input,key);
    const authorized = own("authorizedTonnes") ? Number(input.authorizedTonnes) : num(current.authorized_tonnes);
    if (!Number.isFinite(authorized) || authorized<=0 || authorized>num(current.confirmed_tonnes)+0.001) {
      throw Object.assign(new Error("Volume autorizado deve ser positivo e não pode superar o seller-confirmed"),{status:409});
    }
    const price = own("floorPriceUsdTonne") ? input.floorPriceUsdTonne ?? null : current.floor_price_usd_tonne;
    const minOrder = own("minOrderTonnes") ? input.minOrderTonnes ?? null : current.min_order_tonnes;
    if (price != null && (!Number.isFinite(Number(price)) || Number(price)<=0)) throw Object.assign(new Error("Preço mínimo inválido"),{status:400});
    if (minOrder != null && (!Number.isFinite(Number(minOrder)) || Number(minOrder)<0 || Number(minOrder)>authorized+0.001)) {
      throw Object.assign(new Error("Pedido mínimo inválido para o volume autorizado"),{status:409});
    }
    const granularity = own("retirementGranularityKg") ? Number(input.retirementGranularityKg) : Number(current.retirement_granularity_kg);
    if (!Number.isInteger(granularity) || granularity<=0 || granularity>1_000_000_000) {
      throw Object.assign(new Error("Granularidade de retirement inválida"),{status:400});
    }

    const updated = (await client.query(`
      UPDATE supply_intake_reviews SET
        authorized_tonnes=$2,
        floor_price_usd_tonne=$3,
        min_order_tonnes=$4,
        batch_reference=CASE WHEN $5::boolean THEN $6 ELSE batch_reference END,
        vintage=CASE WHEN $7::boolean THEN $8 ELSE vintage END,
        serial_start=CASE WHEN $9::boolean THEN $10 ELSE serial_start END,
        serial_end=CASE WHEN $11::boolean THEN $12 ELSE serial_end END,
        methodology=CASE WHEN $13::boolean THEN $14 ELSE methodology END,
        registry_evidence_url=CASE WHEN $15::boolean THEN $16 ELSE registry_evidence_url END,
        source_url=CASE WHEN $17::boolean THEN $18 ELSE source_url END,
        retirement_supported=CASE WHEN $19::boolean THEN $20 ELSE retirement_supported END,
        beneficiary_retirement_supported=CASE WHEN $21::boolean THEN $22 ELSE beneficiary_retirement_supported END,
        fractional_retirement_supported=CASE WHEN $23::boolean THEN $24 ELSE fractional_retirement_supported END,
        retirement_granularity_kg=$25,
        commercial_valid_until=CASE WHEN $26::boolean THEN $27::timestamptz ELSE commercial_valid_until END,
        legal_kyc_status=CASE WHEN $28::boolean THEN $29::varchar(30) ELSE legal_kyc_status END,
        registry_evidence_status=CASE WHEN $30::boolean THEN $31::varchar(30) ELSE registry_evidence_status END,
        commercial_terms_status=CASE WHEN $32::boolean THEN $33::varchar(30) ELSE commercial_terms_status END,
        review_note=CASE WHEN $34::boolean THEN $35 ELSE review_note END,
        status=CASE
          WHEN COALESCE(CASE WHEN $28::boolean THEN $29::varchar(30) ELSE legal_kyc_status END,'pending')='approved'
           AND COALESCE(CASE WHEN $30::boolean THEN $31::varchar(30) ELSE registry_evidence_status END,'pending')='verified'
           AND COALESCE(CASE WHEN $32::boolean THEN $33::varchar(30) ELSE commercial_terms_status END,'pending')='approved'
          THEN 'ready_for_review' ELSE 'draft' END,
        updated_at=NOW()
      WHERE id=$1 RETURNING *`,[
      input.reviewId,authorized,price,minOrder,
      own("batchReference"),input.batchReference ?? null,
      own("vintage"),input.vintage ?? null,
      own("serialStart"),input.serialStart ?? null,
      own("serialEnd"),input.serialEnd ?? null,
      own("methodology"),input.methodology ?? null,
      own("registryEvidenceUrl"),input.registryEvidenceUrl ?? null,
      own("sourceUrl"),input.sourceUrl ?? null,
      own("retirementSupported"),input.retirementSupported ?? false,
      own("beneficiaryRetirementSupported"),input.beneficiaryRetirementSupported ?? false,
      own("fractionalRetirementSupported"),input.fractionalRetirementSupported ?? false,
      granularity,
      own("commercialValidUntil"),input.commercialValidUntil ?? null,
      own("legalKycStatus"),input.legalKycStatus ?? "pending",
      own("registryEvidenceStatus"),input.registryEvidenceStatus ?? "pending",
      own("commercialTermsStatus"),input.commercialTermsStatus ?? "pending",
      own("reviewNote"),input.reviewNote ?? null,
    ])).rows[0];
    await intakeEvent(client,{
      reviewId:input.reviewId,eventType:"intake_updated",actor:actorName(input.actor),
      payload:{status:updated.status,legalKycStatus:updated.legal_kyc_status,registryEvidenceStatus:updated.registry_evidence_status,commercialTermsStatus:updated.commercial_terms_status},
    });
    return updated;
  });
}

function approvalProblems(row:Json) {
  const problems:string[] = [];
  if (String(row.legal_kyc_status)!=="approved") problems.push("legal/KYC não aprovado");
  if (String(row.registry_evidence_status)!=="verified") problems.push("evidência registral não verificada");
  if (String(row.commercial_terms_status)!=="approved") problems.push("termos comerciais não aprovados");
  if (!String(row.batch_reference || "").trim()) problems.push("batch/reference ausente");
  if (!String(row.vintage || "").trim()) problems.push("vintage ausente");
  if (!String(row.registry_evidence_url || "").trim()) problems.push("URL de evidência registral ausente");
  if (row.retirement_supported !== true) problems.push("retirement não suportado");
  if (row.beneficiary_retirement_supported !== true) problems.push("retirement em nome do beneficiário não suportado");
  if (num(row.authorized_tonnes)<=0 || num(row.authorized_tonnes)>num(row.confirmed_tonnes)+0.001) problems.push("volume autorizado inválido");
  if (row.commercial_valid_until && new Date(String(row.commercial_valid_until)).getTime()<=Date.now()) problems.push("validade comercial expirada");
  return problems;
}

export async function approveSupplyIntake(input:{reviewId:number;approvedBy?:string|null;note?:string|null}) {
  return withTransaction(async (client) => {
    const row = (await client.query(`SELECT * FROM supply_intake_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if (!row) throw Object.assign(new Error("Supply Intake não encontrado"),{status:404});
    if (row.status === "approved" || row.status === "converted") return row;
    if (row.status === "rejected") throw Object.assign(new Error("Supply Intake rejeitado não pode ser aprovado"),{status:409});
    const problems = approvalProblems(row);
    if (problems.length) throw Object.assign(new Error(`Supply Intake ainda não aprovável: ${problems.join("; ")}`),{status:409,problems});
    const actor = actorName(input.approvedBy);
    const snapshot = {
      version:"ecotracker-supply-intake-approval-v1",
      reviewId:Number(row.id),responseId:Number(row.response_id),selectionId:Number(row.selection_id),rfqId:Number(row.rfq_id),leadId:Number(row.lead_id),
      registry:row.registry,registryProjectId:row.registry_project_id,projectName:row.project_name,supplierName:row.supplier_name,
      confirmedTonnes:num(row.confirmed_tonnes),authorizedTonnes:num(row.authorized_tonnes),floorPriceUsdTonne:row.floor_price_usd_tonne,
      minOrderTonnes:row.min_order_tonnes,batchReference:row.batch_reference,vintage:row.vintage,serialStart:row.serial_start,serialEnd:row.serial_end,
      methodology:row.methodology,country:row.country,region:row.region,registryEvidenceUrl:row.registry_evidence_url,sourceUrl:row.source_url,
      retirementSupported:Boolean(row.retirement_supported),beneficiaryRetirementSupported:Boolean(row.beneficiary_retirement_supported),
      fractionalRetirementSupported:Boolean(row.fractional_retirement_supported),retirementGranularityKg:Number(row.retirement_granularity_kg),
      commercialValidUntil:row.commercial_valid_until,legalKycStatus:row.legal_kyc_status,registryEvidenceStatus:row.registry_evidence_status,
      commercialTermsStatus:row.commercial_terms_status,reviewNote:input.note ?? row.review_note ?? null,
      integrityDisclosure:"Approval authorizes creation of mandate/inventory and a restricted monitored candidate only; it does not approve offset eligibility.",
      approvedAt:new Date().toISOString(),approvedBy:actor,
    };
    const hash = sha256(snapshot);
    const approved = (await client.query(`
      UPDATE supply_intake_reviews SET
        status='approved',review_note=COALESCE($2,review_note),approved_by=$3,approved_at=NOW(),
        approval_snapshot=$4::jsonb,approval_sha256=$5,updated_at=NOW()
      WHERE id=$1 RETURNING *`,[
      input.reviewId,input.note ?? null,actor,JSON.stringify(snapshot),hash,
    ])).rows[0];
    await intakeEvent(client,{reviewId:input.reviewId,eventType:"intake_approved",actor,payload:{approvalSha256:hash}});
    return approved;
  });
}

export async function rejectSupplyIntake(input:{reviewId:number;reason:string;rejectedBy?:string|null}) {
  return withTransaction(async (client) => {
    const row = (await client.query(`SELECT * FROM supply_intake_reviews WHERE id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if (!row) throw Object.assign(new Error("Supply Intake não encontrado"),{status:404});
    if (["approved","converted"].includes(String(row.status))) throw Object.assign(new Error("Supply Intake aprovado não pode ser rejeitado"),{status:409});
    if (row.status === "rejected") return row;
    const actor = actorName(input.rejectedBy);
    const rejected = (await client.query(`
      UPDATE supply_intake_reviews SET status='rejected',rejection_reason=$2,updated_at=NOW()
      WHERE id=$1 RETURNING *`,[input.reviewId,input.reason])).rows[0];
    await intakeEvent(client,{reviewId:input.reviewId,eventType:"intake_rejected",actor,payload:{reason:input.reason}});
    return rejected;
  });
}

function vintageDates(vintage:unknown) {
  const match = /^(19|20)\d{2}$/.exec(String(vintage || "").trim());
  if (!match) return {start:null,end:null};
  const year = Number(match[0]);
  return {start:`${year}-01-01`,end:`${year}-12-31`};
}

export async function convertApprovedSupplyIntake(input:{reviewId:number;convertedBy?:string|null}) {
  const conversion = await withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM supply_intake_conversions WHERE review_id=$1 FOR UPDATE`,[input.reviewId])).rows[0];
    if (existing) return existing;
    const row = (await client.query(`
      SELECT r.*,l.evidence_url AS lead_evidence_url,l.source_url AS lead_source_url
      FROM supply_intake_reviews r JOIN supply_leads l ON l.id=r.lead_id
      WHERE r.id=$1 FOR UPDATE OF r,l`,[input.reviewId])).rows[0];
    if (!row) throw Object.assign(new Error("Supply Intake não encontrado"),{status:404});
    if (row.status !== "approved") throw Object.assign(new Error("Supply Intake precisa estar aprovado antes da conversão"),{status:409});
    const actor = actorName(input.convertedBy);
    const serialRanges = row.serial_start || row.serial_end ? [{start:row.serial_start || null,end:row.serial_end || null}] : [];
    const mandate = (await client.query(`
      INSERT INTO supplier_mandates(
        lead_id,supplier_name,status,confirmed_free_tonnes,authorized_tonnes,floor_price_usd_tonne,currency,
        non_exclusive,allowed_channels,serial_ranges,evidence_url,valid_from,valid_until,notes
      ) VALUES($1,$2,'active',$3,$4,$5,'USD',TRUE,$6::jsonb,$7::jsonb,$8,NOW(),$9::timestamptz,$10)
      RETURNING *`,[
      row.lead_id,row.supplier_name,row.confirmed_tonnes,row.authorized_tonnes,row.floor_price_usd_tonne,
      JSON.stringify(["direct","otc"]),JSON.stringify(serialRanges),row.registry_evidence_url,row.commercial_valid_until,
      `Gerado pelo Supply Intake aprovado ${row.public_code}. Elegibilidade climática permanece separada.`,
    ])).rows[0];
    const inventory = (await client.query(`
      INSERT INTO supply_inventory(
        mandate_id,registry,registry_project_id,batch_reference,vintage,serial_start,serial_end,
        authorized_tonnes,registry_evidence_url,metadata
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      RETURNING *`,[
      mandate.id,row.registry,row.registry_project_id,row.batch_reference,row.vintage,row.serial_start,row.serial_end,
      row.authorized_tonnes,row.registry_evidence_url,JSON.stringify({supplyIntakeReviewId:Number(row.id),claimReady:false}),
    ])).rows[0];

    await client.query(`
      UPDATE supply_leads SET
        confirmed_free_tonnes=$2,availability_confidence='seller_confirmed',contact_status='mandate_ready',status='mandated',updated_at=NOW()
      WHERE id=$1`,[row.lead_id,row.confirmed_tonnes]);

    const dates = vintageDates(row.vintage);
    const minOrderKg = Math.max(1,Math.min(2_000_000_000,Math.round(num(row.min_order_tonnes,1)*1000)));
    const sourceReference = `supply-intake:${inventory.id}:${String(row.batch_reference).slice(0,120)}`;
    const monitored = (await client.query(`
      INSERT INTO monitored_assets(
        registry,project_name,source_reference,source_url,methodology,location,vintage,asset_type,quality_tier,description,
        source_price_usd_ton,available_tons,min_order_kg,pricing_mode,availability_status,source_status,monitor_details,active,
        claim_category,eligibility_status,eligibility_basis,source_unit_status,vintage_start,vintage_end,commercial_valid_until,
        offer_expires_at,registry_project_id,registry_batch_id,registry_evidence_url,retirement_supported,
        fractional_retirement_supported,retirement_granularity_kg,beneficiary_retirement_supported,eligibility_risk_flags,
        sourcing_score,sourcing_tier,sourcing_shelf,sourcing_executable,sourcing_checked_at
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,'carbon','screening',$8,$9,$10,$11,'quote','confirmed','manual',$12::jsonb,TRUE,
        'climate_contribution','under_review',$13,'unknown',$14::date,$15::date,$16::timestamptz::date,
        $16::timestamptz,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,
        0,'D','restricted',FALSE,NOW()
      ) RETURNING *`,[
      row.registry,row.project_name,sourceReference,row.source_url || row.lead_source_url || null,row.methodology,
      [row.region,row.country].filter(Boolean).join(", ") || null,row.vintage,
      `Candidato monitorado originado de seller-confirmed + Supply Intake aprovado. Não é compensação elegível até revisão explícita de eligibility.`,
      row.floor_price_usd_tonne,row.authorized_tonnes,minOrderKg,
      JSON.stringify({
        source:"supply-intake",supplyIntakeReviewId:Number(row.id),supplierResponseId:Number(row.response_id),
        supplierSelectionId:Number(row.selection_id),supplierMandateId:Number(mandate.id),supplyInventoryId:Number(inventory.id),claimReady:false,
      }),
      `Supply Intake ${row.public_code} aprovado comercialmente; offset eligibility ainda não aprovada.`,
      dates.start,dates.end,row.commercial_valid_until,row.registry_project_id,row.batch_reference,row.registry_evidence_url,
      Boolean(row.retirement_supported),Boolean(row.fractional_retirement_supported),Number(row.retirement_granularity_kg),
      Boolean(row.beneficiary_retirement_supported),JSON.stringify(["supply-intake-awaiting-eligibility-review"]),
    ])).rows[0];

    const snapshot = {
      reviewId:Number(row.id),mandateId:Number(mandate.id),inventoryId:Number(inventory.id),monitoredAssetId:Number(monitored.id),
      claimCategory:monitored.claim_category,eligibilityStatus:monitored.eligibility_status,sourcingShelf:monitored.sourcing_shelf,
      sourcingExecutable:Boolean(monitored.sourcing_executable),integrityState:"restricted-until-explicit-eligibility-review",
    };
    const created = (await client.query(`
      INSERT INTO supply_intake_conversions(
        review_id,mandate_id,inventory_id,monitored_asset_id,converted_by,conversion_snapshot
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,[
      row.id,mandate.id,inventory.id,monitored.id,actor,JSON.stringify(snapshot),
    ])).rows[0];
    await client.query(`UPDATE supply_intake_reviews SET status='converted',converted_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.id]);
    await intakeEvent(client,{reviewId:Number(row.id),eventType:"intake_converted",actor,payload:snapshot});
    return {...created,mandate,inventory,monitoredAsset:monitored};
  });
  return conversion;
}

export async function listSupplyIntakes(input:{status?:string;limit?:number}={}) {
  const status = String(input.status || "").trim();
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const { rows } = await pool.query(`
    SELECT r.*,
           rfq.public_code AS rfq_public_code,rfq.status AS rfq_status,rfq.gap_tonnes,
           a.company_name AS buyer_company_name,
           l.supplier_contact_name,l.supplier_email,
           conv.mandate_id,conv.inventory_id,conv.monitored_asset_id,
           ma.eligibility_status AS monitored_eligibility_status,ma.claim_category AS monitored_claim_category,
           ma.sourcing_shelf AS monitored_sourcing_shelf,ma.sourcing_executable AS monitored_sourcing_executable
    FROM supply_intake_reviews r
    JOIN market_maker_rfqs rfq ON rfq.id=r.rfq_id
    JOIN demand_accounts a ON a.id=rfq.account_id
    JOIN supply_leads l ON l.id=r.lead_id
    LEFT JOIN supply_intake_conversions conv ON conv.review_id=r.id
    LEFT JOIN monitored_assets ma ON ma.id=conv.monitored_asset_id
    WHERE ($1='' OR r.status=$1)
    ORDER BY CASE r.status WHEN 'ready_for_review' THEN 1 WHEN 'draft' THEN 2 WHEN 'approved' THEN 3 WHEN 'converted' THEN 4 ELSE 5 END,
             r.updated_at DESC
    LIMIT $2`,[status,limit]);
  return rows;
}

export async function getSupplyIntake(reviewId:number) {
  return reviewView(reviewId);
}
