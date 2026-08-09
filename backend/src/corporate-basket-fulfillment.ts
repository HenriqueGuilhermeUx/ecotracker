import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
    } catch { return {}; }
  }
  return {};
}

function sha256(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fulfillmentView(client: pg.PoolClient | typeof pool, basketId: number) {
  const { rows } = await client.query(`
    SELECT f.*,b.public_code AS basket_public_code,b.status AS basket_status,b.payment_status,
           b.covered_kg,b.final_total_brl,b.buyer_snapshot,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id',l.id,'publicCode',l.public_code,'basketLegId',l.basket_leg_id,'assetId',l.asset_id,
             'requestedKg',l.requested_kg,'status',l.status,'providerKey',l.provider_key,'registry',l.registry,
             'projectName',l.project_name,'vintage',l.vintage,'sourceReference',l.source_reference,
             'sourceTxHash',l.source_tx_hash,'sourceEvidenceUrl',l.source_evidence_url,'acquiredKg',l.acquired_kg,
             'acquiredAt',l.acquired_at,'retirementReference',l.retirement_reference,
             'retirementTxHash',l.retirement_tx_hash,'retirementEvidenceUrl',l.retirement_evidence_url,
             'certificateUrl',l.certificate_url,'retiredKg',l.retired_kg,'retiredAt',l.retired_at,
             'beneficiaryName',l.beneficiary_name,'beneficiaryTaxId',l.beneficiary_tax_id,
             'retirementEvidence',l.retirement_evidence,'reviewReason',l.review_reason
           ) ORDER BY l.id) FROM corporate_basket_fulfillment_legs l WHERE l.fulfillment_id=f.id),'[]'::jsonb) AS legs,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'documentType',d.document_type,'status',d.status,'provider',d.provider,
             'providerReference',d.provider_reference,'documentUrl',d.document_url,'issuedAt',d.issued_at
           ) ORDER BY d.document_type) FROM corporate_basket_documents d WHERE d.basket_id=b.id),'[]'::jsonb) AS documents
    FROM corporate_basket_fulfillments f
    JOIN corporate_baskets b ON b.id=f.basket_id
    WHERE f.basket_id=$1`, [basketId]);
  return rows[0];
}

async function refreshFulfillmentTotals(client: pg.PoolClient, fulfillmentId: number) {
  const totals = await client.query(`
    SELECT COALESCE(SUM(acquired_kg),0)::bigint AS acquired_kg,
           COALESCE(SUM(retired_kg),0)::bigint AS retired_kg,
           COUNT(*)::int AS legs,
           COUNT(*) FILTER (WHERE status='retired')::int AS retired_legs,
           COUNT(*) FILTER (WHERE status='review_required')::int AS review_legs
    FROM corporate_basket_fulfillment_legs WHERE fulfillment_id=$1`, [fulfillmentId]);
  const row = totals.rows[0];
  const fulfillmentResult = await client.query(`SELECT * FROM corporate_basket_fulfillments WHERE id=$1 FOR UPDATE`, [fulfillmentId]);
  const fulfillment = fulfillmentResult.rows[0];
  if (!fulfillment) throw new Error("Fulfillment não encontrado");
  const totalRequested = Number(fulfillment.total_requested_kg);
  const acquired = Number(row.acquired_kg || 0);
  const retired = Number(row.retired_kg || 0);
  let status = String(fulfillment.status);
  let reviewReason: string | null = null;
  if (Number(row.review_legs || 0)>0) {
    status = "review_required";
    reviewReason = "Uma ou mais legs exigem revisão operacional";
  } else if (Number(row.retired_legs || 0)===Number(row.legs || 0) && retired===totalRequested) {
    status = "retired";
  } else if (retired>0 || acquired>0) {
    status = "in_progress";
  } else if (status!=="pending") {
    status = "in_progress";
  }
  await client.query(`
    UPDATE corporate_basket_fulfillments SET total_acquired_kg=$2,total_retired_kg=$3,status=$4::varchar(40),
      retired_at=CASE WHEN $4::varchar(40)='retired' THEN COALESCE(retired_at,NOW()) ELSE retired_at END,
      review_reason=$5,updated_at=NOW()
    WHERE id=$1`, [fulfillmentId,acquired,retired,status,reviewReason]);
  return { acquired,retired,status };
}

export async function startCorporateBasketFulfillment(basketId: number) {
  return withTransaction(async (client) => {
    const existing = await client.query(`SELECT id FROM corporate_basket_fulfillments WHERE basket_id=$1 FOR UPDATE`, [basketId]);
    if (existing.rows[0]) return fulfillmentView(client,basketId);

    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [basketId]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status:404 });
    if (basket.payment_status!=="paid_awaiting_fulfillment" || basket.status!=="paid_awaiting_fulfillment") {
      throw Object.assign(new Error("Fulfillment só pode começar após pagamento corporativo reconciliado"), { status:409 });
    }
    const reservations = await client.query(`
      SELECT r.*,l.id AS leg_id,l.asset_id,l.requested_kg,l.registry,l.project_name,l.vintage,l.provider_key,l.status AS leg_status
      FROM corporate_basket_reservations r
      JOIN corporate_basket_legs l ON l.id=r.leg_id
      WHERE r.basket_id=$1 ORDER BY l.id FOR UPDATE OF r,l`, [basketId]);
    const legCount = await client.query(`SELECT COUNT(*)::int AS count FROM corporate_basket_legs WHERE basket_id=$1`, [basketId]);
    if (!reservations.rows.length || reservations.rows.length!==Number(legCount.rows[0]?.count || 0)) {
      throw Object.assign(new Error("Basket pago não possui reservas completas para fulfillment"), { status:409 });
    }
    if (!reservations.rows.every((row) => row.status==="committed" && row.leg_status==="confirmed" && Number(row.reserved_kg)===Number(row.requested_kg))) {
      throw Object.assign(new Error("Todas as legs precisam estar confirmadas e com reserva committed"), { status:409 });
    }

    const buyer = objectAt(basket.buyer_snapshot);
    const fulfillmentResult = await client.query(`
      INSERT INTO corporate_basket_fulfillments
        (basket_id,status,total_requested_kg,beneficiary_name,beneficiary_tax_id,beneficiary_email,started_at)
      VALUES($1,'in_progress',$2,$3,$4,$5,NOW()) RETURNING *`, [
      basket.id,Number(basket.covered_kg),
      buyer.companyName || buyer.contactName || null,buyer.taxId || null,buyer.contactEmail || null,
    ]);
    const fulfillment = fulfillmentResult.rows[0];
    for (const row of reservations.rows) {
      await client.query(`
        INSERT INTO corporate_basket_fulfillment_legs
          (fulfillment_id,basket_leg_id,asset_id,requested_kg,status,provider_key,registry,project_name,vintage,
           beneficiary_name,beneficiary_tax_id)
        VALUES($1,$2,$3,$4,'pending_acquisition',$5,$6,$7,$8,$9,$10)`, [
        fulfillment.id,row.leg_id,row.asset_id,Number(row.requested_kg),row.provider_key,row.registry,row.project_name,row.vintage,
        buyer.companyName || buyer.contactName || null,buyer.taxId || null,
      ]);
    }
    await client.query(`UPDATE corporate_baskets SET status='fulfillment_in_progress',updated_at=NOW() WHERE id=$1`, [basket.id]);
    return fulfillmentView(client,basket.id);
  });
}

export async function recordCorporateBasketAcquisition(input: {
  basketId:number;
  fulfillmentLegId:number;
  sourceReference:string;
  sourceTxHash?:string | null;
  sourceEvidenceUrl?:string | null;
  acquiredKg?:number | null;
}) {
  return withTransaction(async (client) => {
    const legResult = await client.query(`
      SELECT l.*,f.basket_id FROM corporate_basket_fulfillment_legs l
      JOIN corporate_basket_fulfillments f ON f.id=l.fulfillment_id
      WHERE l.id=$1 AND f.basket_id=$2 FOR UPDATE OF l,f`, [input.fulfillmentLegId,input.basketId]);
    const leg = legResult.rows[0];
    if (!leg) throw Object.assign(new Error("Leg de fulfillment não encontrada"), { status:404 });
    if (["retired","review_required"].includes(String(leg.status))) {
      throw Object.assign(new Error("Leg não aceita nova aquisição neste estado"), { status:409 });
    }
    const acquiredKg = Math.round(input.acquiredKg ?? Number(leg.requested_kg));
    if (acquiredKg!==Number(leg.requested_kg)) {
      throw Object.assign(new Error("A aquisição deve cobrir exatamente o volume da leg antes do retirement"), { status:409 });
    }
    await client.query(`
      UPDATE corporate_basket_fulfillment_legs SET status='acquired',source_reference=$3,source_tx_hash=$4,
        source_evidence_url=$5,acquired_kg=$6,acquired_at=NOW(),review_reason=NULL,updated_at=NOW()
      WHERE id=$1 AND fulfillment_id=$2`, [
      leg.id,leg.fulfillment_id,input.sourceReference,input.sourceTxHash || null,input.sourceEvidenceUrl || null,acquiredKg,
    ]);
    await refreshFulfillmentTotals(client,Number(leg.fulfillment_id));
    return fulfillmentView(client,input.basketId);
  });
}

export async function recordCorporateBasketRetirement(input: {
  basketId:number;
  fulfillmentLegId:number;
  retirementReference:string;
  retirementTxHash?:string | null;
  retirementEvidenceUrl?:string | null;
  certificateUrl?:string | null;
  retiredKg?:number | null;
  beneficiaryName?:string | null;
  beneficiaryTaxId?:string | null;
  evidence?:Json;
}) {
  return withTransaction(async (client) => {
    const legResult = await client.query(`
      SELECT l.*,f.basket_id,f.beneficiary_name AS parent_beneficiary_name,f.beneficiary_tax_id AS parent_beneficiary_tax_id
      FROM corporate_basket_fulfillment_legs l
      JOIN corporate_basket_fulfillments f ON f.id=l.fulfillment_id
      WHERE l.id=$1 AND f.basket_id=$2 FOR UPDATE OF l,f`, [input.fulfillmentLegId,input.basketId]);
    const leg = legResult.rows[0];
    if (!leg) throw Object.assign(new Error("Leg de fulfillment não encontrada"), { status:404 });
    if (leg.status==="retired") return fulfillmentView(client,input.basketId);
    if (leg.status!=="acquired") {
      throw Object.assign(new Error("Registre a aquisição integral da leg antes do retirement"), { status:409 });
    }
    const retiredKg = Math.round(input.retiredKg ?? Number(leg.requested_kg));
    if (retiredKg!==Number(leg.requested_kg)) {
      throw Object.assign(new Error("O retirement deve cobrir exatamente o volume vendido da leg"), { status:409 });
    }
    const beneficiaryName = input.beneficiaryName || leg.parent_beneficiary_name || leg.beneficiary_name || null;
    const beneficiaryTaxId = input.beneficiaryTaxId || leg.parent_beneficiary_tax_id || leg.beneficiary_tax_id || null;
    if (!beneficiaryName) throw Object.assign(new Error("Beneficiário do retirement é obrigatório"), { status:409 });
    if (!input.retirementEvidenceUrl && !input.certificateUrl && !input.retirementTxHash) {
      throw Object.assign(new Error("Informe evidência registral, certificado ou transaction hash do retirement"), { status:409 });
    }
    const evidence = {
      ...(input.evidence || {}),
      providerKey:leg.provider_key,
      registry:leg.registry,
      projectName:leg.project_name,
      vintage:leg.vintage,
      requestedKg:Number(leg.requested_kg),
      retiredKg,
      sourceReference:leg.source_reference,
      sourceEvidenceUrl:leg.source_evidence_url,
      retirementReference:input.retirementReference,
      retirementTxHash:input.retirementTxHash || null,
      retirementEvidenceUrl:input.retirementEvidenceUrl || null,
      certificateUrl:input.certificateUrl || null,
      beneficiaryName,
      beneficiaryTaxId,
      recordedAt:new Date().toISOString(),
    };
    await client.query(`
      UPDATE corporate_basket_fulfillment_legs SET status='retired',retirement_reference=$3,retirement_tx_hash=$4,
        retirement_evidence_url=$5,certificate_url=$6,retired_kg=$7,beneficiary_name=$8,beneficiary_tax_id=$9,
        retirement_evidence=$10::jsonb,retired_at=NOW(),review_reason=NULL,updated_at=NOW()
      WHERE id=$1 AND fulfillment_id=$2`, [
      leg.id,leg.fulfillment_id,input.retirementReference,input.retirementTxHash || null,input.retirementEvidenceUrl || null,
      input.certificateUrl || null,retiredKg,beneficiaryName,beneficiaryTaxId,JSON.stringify(evidence),
    ]);
    await refreshFulfillmentTotals(client,Number(leg.fulfillment_id));
    return fulfillmentView(client,input.basketId);
  });
}

export async function flagCorporateBasketFulfillmentLegReview(input:{basketId:number;fulfillmentLegId:number;reason:string}) {
  return withTransaction(async (client) => {
    const result = await client.query(`
      UPDATE corporate_basket_fulfillment_legs l SET status='review_required',review_reason=$3,updated_at=NOW()
      FROM corporate_basket_fulfillments f
      WHERE l.fulfillment_id=f.id AND l.id=$1 AND f.basket_id=$2
      RETURNING l.fulfillment_id`, [input.fulfillmentLegId,input.basketId,input.reason]);
    if (!result.rows[0]) throw Object.assign(new Error("Leg de fulfillment não encontrada"), { status:404 });
    await refreshFulfillmentTotals(client,Number(result.rows[0].fulfillment_id));
    await client.query(`UPDATE corporate_baskets SET status='fulfillment_review_required',updated_at=NOW() WHERE id=$1`, [input.basketId]);
    return fulfillmentView(client,input.basketId);
  });
}

export async function finalizeCorporateBasketFulfillment(basketId:number) {
  return withTransaction(async (client) => {
    const basketResult = await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [basketId]);
    const basket = basketResult.rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status:404 });
    if (basket.payment_status!=="paid_awaiting_fulfillment") {
      throw Object.assign(new Error("Basket não possui pagamento reconciliado aguardando fulfillment"), { status:409 });
    }
    const fulfillmentResult = await client.query(`SELECT * FROM corporate_basket_fulfillments WHERE basket_id=$1 FOR UPDATE`, [basketId]);
    const fulfillment = fulfillmentResult.rows[0];
    if (!fulfillment) throw Object.assign(new Error("Fulfillment não iniciado"), { status:409 });
    await refreshFulfillmentTotals(client,Number(fulfillment.id));
    const refreshed = (await client.query(`SELECT * FROM corporate_basket_fulfillments WHERE id=$1 FOR UPDATE`, [fulfillment.id])).rows[0];
    if (refreshed.status!=="retired" || Number(refreshed.total_retired_kg)!==Number(refreshed.total_requested_kg)) {
      throw Object.assign(new Error("Todas as legs precisam estar integralmente aposentadas antes da finalização"), { status:409 });
    }
    const legsResult = await client.query(`SELECT * FROM corporate_basket_fulfillment_legs WHERE fulfillment_id=$1 ORDER BY id`, [fulfillment.id]);
    if (!legsResult.rows.every((leg) => leg.status==="retired" && Number(leg.retired_kg)===Number(leg.requested_kg))) {
      throw Object.assign(new Error("Há leg sem retirement integral"), { status:409 });
    }
    const bundle = {
      version:"ecotracker-corporate-retirement-bundle-v1",
      basketPublicCode:basket.public_code,
      beneficiary:{ name:refreshed.beneficiary_name,taxId:refreshed.beneficiary_tax_id,email:refreshed.beneficiary_email },
      totalKg:Number(refreshed.total_requested_kg),
      finalTotalBrl:Number(basket.final_total_brl || 0),
      paidAt:basket.paid_at,
      legs:legsResult.rows.map((leg) => ({
        registry:leg.registry,projectName:leg.project_name,vintage:leg.vintage,requestedKg:Number(leg.requested_kg),
        sourceReference:leg.source_reference,sourceTxHash:leg.source_tx_hash,sourceEvidenceUrl:leg.source_evidence_url,
        retirementReference:leg.retirement_reference,retirementTxHash:leg.retirement_tx_hash,
        retirementEvidenceUrl:leg.retirement_evidence_url,certificateUrl:leg.certificate_url,
        beneficiaryName:leg.beneficiary_name,beneficiaryTaxId:leg.beneficiary_tax_id,retiredKg:Number(leg.retired_kg),retiredAt:leg.retired_at,
      })),
      generatedAt:new Date().toISOString(),
    };
    const bundleHash = sha256(bundle);
    await client.query(`
      UPDATE corporate_basket_fulfillments SET status='completed',evidence_bundle=$2::jsonb,bundle_sha256=$3,
        completed_at=NOW(),updated_at=NOW() WHERE id=$1`, [fulfillment.id,JSON.stringify(bundle),bundleHash]);
    await client.query(`
      INSERT INTO corporate_basket_ecot_allocations
        (basket_id,fulfillment_id,amount_kg,recipient_name,recipient_email,status,evidence_bundle_sha256,metadata)
      VALUES($1,$2,$3,$4,$5,'allocated',$6,$7::jsonb)
      ON CONFLICT(basket_id) DO NOTHING`, [
      basket.id,fulfillment.id,Number(refreshed.total_requested_kg),refreshed.beneficiary_name,refreshed.beneficiary_email,bundleHash,
      JSON.stringify({ claimPurpose:objectAt(basket.buyer_snapshot).claimPurpose || "voluntary_offset",bundleVersion:bundle.version }),
    ]);
    await client.query(`
      UPDATE corporate_basket_reservations SET status='consumed',consumed_at=NOW(),updated_at=NOW()
      WHERE basket_id=$1 AND status='committed'`, [basket.id]);
    await client.query(`
      UPDATE corporate_baskets SET status='fulfilled_climate',payment_status='paid',updated_at=NOW() WHERE id=$1`, [basket.id]);
    await client.query(`
      UPDATE demand_proposals SET status='converted',updated_at=NOW() WHERE id=$1`, [basket.proposal_id]);
    const proposal = await client.query(`SELECT opportunity_id FROM demand_proposals WHERE id=$1`, [basket.proposal_id]);
    if (proposal.rows[0]) {
      await client.query(`UPDATE demand_opportunities SET status='fulfilled',updated_at=NOW() WHERE id=$1`, [proposal.rows[0].opportunity_id]);
    }
    return { ...(await fulfillmentView(client,basketId)),bundle,bundleSha256:bundleHash,ecotAllocatedKg:Number(refreshed.total_requested_kg) };
  });
}

export async function recordCorporateBasketDocument(input:{
  basketId:number;
  documentType:"receipt"|"nfse";
  provider?:string | null;
  providerReference?:string | null;
  documentUrl:string;
  data?:Json;
}) {
  return withTransaction(async (client) => {
    const basket = (await client.query(`SELECT * FROM corporate_baskets WHERE id=$1 FOR UPDATE`, [input.basketId])).rows[0];
    if (!basket) throw Object.assign(new Error("Basket não encontrado"), { status:404 });
    if (!["fulfilled_climate","completed"].includes(String(basket.status))) {
      throw Object.assign(new Error("Documentos finais só podem ser vinculados após fulfillment climático"), { status:409 });
    }
    const result = await client.query(`
      INSERT INTO corporate_basket_documents
        (basket_id,document_type,status,provider,provider_reference,document_url,data,issued_at)
      VALUES($1,$2,'issued',$3,$4,$5,$6::jsonb,NOW())
      ON CONFLICT(basket_id,document_type) DO UPDATE SET status='issued',provider=EXCLUDED.provider,
        provider_reference=EXCLUDED.provider_reference,document_url=EXCLUDED.document_url,data=EXCLUDED.data,
        issued_at=NOW(),updated_at=NOW()
      RETURNING *`, [input.basketId,input.documentType,input.provider || null,input.providerReference || null,input.documentUrl,JSON.stringify(input.data || {})]);
    return result.rows[0];
  });
}

export async function getCorporateBasketFulfillment(basketId:number) {
  return fulfillmentView(pool,basketId);
}

export async function getCorporateBasketEvidence(publicCode:string) {
  const { rows } = await pool.query(`
    SELECT f.public_code AS fulfillment_public_code,f.status,f.total_requested_kg,f.total_retired_kg,
           f.beneficiary_name,f.beneficiary_tax_id,f.evidence_bundle,f.bundle_sha256,f.completed_at,
           b.public_code AS basket_public_code,b.status AS basket_status,b.final_total_brl,b.paid_at,
           e.public_code AS allocation_public_code,e.amount_kg,e.status AS allocation_status,e.allocated_at,e.delivered_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('type',d.document_type,'status',d.status,'url',d.document_url,'issuedAt',d.issued_at) ORDER BY d.document_type)
                     FROM corporate_basket_documents d WHERE d.basket_id=b.id),'[]'::jsonb) AS documents
    FROM corporate_basket_fulfillments f
    JOIN corporate_baskets b ON b.id=f.basket_id
    LEFT JOIN corporate_basket_ecot_allocations e ON e.basket_id=b.id
    WHERE b.public_code=$1`, [publicCode]);
  const row = rows[0];
  if (!row) return null;
  return {
    basketPublicCode:row.basket_public_code,
    status:row.status,
    beneficiaryName:row.beneficiary_name,
    totalKg:Number(row.total_requested_kg),
    totalRetiredKg:Number(row.total_retired_kg),
    bundle:row.evidence_bundle,
    bundleSha256:row.bundle_sha256,
    completedAt:row.completed_at,
    ecotAllocation:row.allocation_public_code ? { publicCode:row.allocation_public_code,amountKg:Number(row.amount_kg),status:row.allocation_status,allocatedAt:row.allocated_at,deliveredAt:row.delivered_at } : null,
    documents:row.documents,
    disclosure:"O bundle reúne evidências das aposentadorias que sustentam a compensação. O inventário corporativo de emissões permanece reportado separadamente.",
  };
}
