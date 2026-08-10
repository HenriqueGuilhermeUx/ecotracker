import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { refreshDemandSupplyRfqCandidates } from "./demand-supply-rfq.js";

type Json = Record<string,unknown>;

function actorName(value?:string|null) {
  const explicit = String(value || "").trim();
  return (explicit || String(process.env.ADMIN_EMAIL || "ecotracker-admin")).slice(0,255);
}

async function event(client:pg.PoolClient,input:{
  rfqId:number;
  selectionId:number;
  responseId:number;
  eventType:string;
  actor:string;
  payload:Json;
}) {
  await client.query(`
    INSERT INTO market_maker_supply_events(
      rfq_id,selection_id,response_id,event_type,actor,payload
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[
    input.rfqId,input.selectionId,input.responseId,input.eventType,input.actor,JSON.stringify(input.payload),
  ]);
}

export async function recordSupplyResponse(input:{
  selectionId:number;
  confirmedAvailableTonnes:number;
  firmPriceUsdTonne?:number|null;
  minOrderTonnes?:number|null;
  retirementSupported?:boolean;
  beneficiaryRetirementSupported?:boolean;
  registryEvidenceUrl?:string|null;
  validUntil?:string|null;
  responseNote?:string|null;
  respondedBy?:string|null;
}) {
  let rfqId = 0;
  const response = await withTransaction(async (client) => {
    const existing = (await client.query(`
      SELECT * FROM market_maker_supply_responses
      WHERE selection_id=$1 FOR UPDATE`,[input.selectionId])).rows[0];
    if (existing) {
      rfqId = Number((await client.query(`SELECT rfq_id FROM market_maker_supply_selections WHERE id=$1`,[input.selectionId])).rows[0]?.rfq_id || 0);
      return existing;
    }

    const bundle = (await client.query(`
      SELECT s.*,r.status AS rfq_status,r.gap_tonnes,
             c.id AS candidate_id,c.status AS candidate_status,
             l.id AS lead_id,l.status AS lead_status,l.contact_status AS lead_contact_status
      FROM market_maker_supply_selections s
      JOIN market_maker_rfqs r ON r.id=s.rfq_id
      JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
      LEFT JOIN supply_leads l ON l.id=s.supply_lead_id
      WHERE s.id=$1
      FOR UPDATE OF s,r,c`,[input.selectionId])).rows[0];
    if (!bundle) throw Object.assign(new Error("Seleção de supply não encontrada"),{status:404});
    if (["cancelled","expired"].includes(String(bundle.status))) {
      throw Object.assign(new Error("Seleção não aceita resposta"),{status:409});
    }

    const confirmed = Math.max(0,Number(input.confirmedAvailableTonnes));
    if (!Number.isFinite(confirmed)) throw Object.assign(new Error("Volume confirmado inválido"),{status:400});
    const firmPrice = input.firmPriceUsdTonne == null ? null : Number(input.firmPriceUsdTonne);
    const minOrder = input.minOrderTonnes == null ? null : Math.max(0,Number(input.minOrderTonnes));
    if (firmPrice != null && (!Number.isFinite(firmPrice) || firmPrice<=0)) {
      throw Object.assign(new Error("Preço firme inválido"),{status:400});
    }
    if (minOrder != null && (!Number.isFinite(minOrder) || (confirmed>0 && minOrder>confirmed+0.001))) {
      throw Object.assign(new Error("Pedido mínimo não pode superar o volume confirmado"),{status:409});
    }

    const responseStatus = confirmed>0 ? "confirmed" : "declined";
    const candidateStatus = responseStatus === "confirmed" ? "qualified" : "rejected";
    const selectionStatus = responseStatus === "confirmed" ? "responded" : "declined";
    const actor = actorName(input.respondedBy);
    const snapshot = {
      confirmedAvailableTonnes:confirmed,
      firmPriceUsdTonne:firmPrice,
      minOrderTonnes:minOrder,
      retirementSupported:Boolean(input.retirementSupported),
      beneficiaryRetirementSupported:Boolean(input.beneficiaryRetirementSupported),
      registryEvidenceUrl:input.registryEvidenceUrl || null,
      validUntil:input.validUntil || null,
      responseNote:input.responseNote || null,
      integrityDisclosure:"Seller confirmation is commercial sourcing evidence only and does not create claim-ready inventory.",
      capturedAt:new Date().toISOString(),
    };

    const created = (await client.query(`
      INSERT INTO market_maker_supply_responses(
        selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,
        retirement_supported,beneficiary_retirement_supported,registry_evidence_url,valid_until,
        response_note,responded_by,response_snapshot
      ) VALUES(
        $1,$2::varchar(30),$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::jsonb
      ) RETURNING *`,[
      input.selectionId,responseStatus,confirmed,firmPrice,minOrder,Boolean(input.retirementSupported),
      Boolean(input.beneficiaryRetirementSupported),input.registryEvidenceUrl || null,input.validUntil || null,
      input.responseNote || null,actor,JSON.stringify(snapshot),
    ])).rows[0];

    rfqId = Number(bundle.rfq_id);
    await client.query(`
      UPDATE market_maker_supply_selections
      SET status=$2::varchar(40),updated_at=NOW()
      WHERE id=$1`,[input.selectionId,selectionStatus]);

    await client.query(`
      UPDATE market_maker_rfq_candidates
      SET status=$2::varchar(40),
          confidence=CASE WHEN $2::varchar(40)='qualified' THEN 'seller_confirmed' ELSE confidence END,
          candidate_tonnes=CASE WHEN $2::varchar(40)='qualified' THEN $3 ELSE candidate_tonnes END,
          rationale=rationale || $4::jsonb,
          snapshot=snapshot || $5::jsonb,
          updated_at=NOW()
      WHERE id=$1`,[
      bundle.candidate_id,candidateStatus,confirmed,
      JSON.stringify({
        supplierResponseStatus:responseStatus,
        sellerConfirmed:responseStatus === "confirmed",
        responseCapturedAt:new Date().toISOString(),
      }),
      JSON.stringify({
        firmPriceUsdTonne:firmPrice,
        minOrderTonnes:minOrder,
        retirementSupported:Boolean(input.retirementSupported),
        beneficiaryRetirementSupported:Boolean(input.beneficiaryRetirementSupported),
        registryEvidenceUrl:input.registryEvidenceUrl || null,
      }),
    ]);

    if (bundle.lead_id) {
      if (responseStatus === "confirmed") {
        await client.query(`
          UPDATE supply_leads SET
            confirmed_free_tonnes=$2,
            availability_confidence='seller_confirmed',
            contact_status=CASE WHEN contact_status='mandate_ready' THEN contact_status ELSE 'qualified' END,
            status=CASE WHEN status='mandated' THEN status ELSE 'qualified' END,
            evidence_url=COALESCE($3,evidence_url),
            notes=CASE WHEN $4::text IS NULL THEN notes ELSE CONCAT_WS(E'\n',NULLIF(notes,''),$4) END,
            metadata=metadata || $5::jsonb,
            last_checked_at=NOW(),updated_at=NOW()
          WHERE id=$1`,[
          bundle.lead_id,confirmed,input.registryEvidenceUrl || null,input.responseNote || null,
          JSON.stringify({lastSupplyResponse:{
            firmPriceUsdTonne:firmPrice,
            minOrderTonnes:minOrder,
            retirementSupported:Boolean(input.retirementSupported),
            beneficiaryRetirementSupported:Boolean(input.beneficiaryRetirementSupported),
            validUntil:input.validUntil || null,
            selectionId:input.selectionId,
          }}),
        ]);
      } else {
        await client.query(`
          UPDATE supply_leads SET
            contact_status='contacted',
            metadata=metadata || $2::jsonb,
            last_checked_at=NOW(),updated_at=NOW()
          WHERE id=$1`,[
          bundle.lead_id,
          JSON.stringify({lastSupplyResponse:{
            declined:true,selectionId:input.selectionId,responseNote:input.responseNote || null,
          }}),
        ]);
      }
    }

    await event(client,{
      rfqId,
      selectionId:input.selectionId,
      responseId:Number(created.id),
      eventType:responseStatus === "confirmed" ? "supplier_confirmed" : "supplier_declined",
      actor,
      payload:snapshot,
    });
    return created;
  });

  if (rfqId>0) {
    await refreshDemandSupplyRfqCandidates(rfqId).catch((error) => {
      console.warn("[supply-outreach] RFQ candidate refresh after supplier response failed",error);
    });
  }
  return response;
}
