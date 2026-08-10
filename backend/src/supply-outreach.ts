import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";
import { refreshDemandSupplyRfqCandidates } from "./demand-supply-rfq.js";

type Json = Record<string,unknown>;

export type SupplyOutreachSender = (input:{
  from:string;
  to:string;
  subject:string;
  text:string;
  html:string;
  idempotencyKey:string;
}) => Promise<{providerReference:string}>;

const num = (value:unknown,fallback=0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function actorName(value?:string|null) {
  const explicit = String(value || "").trim();
  return (explicit || String(process.env.ADMIN_EMAIL || "ecotracker-admin")).slice(0,255);
}

function htmlEscape(value:unknown) {
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function tonnes(value:unknown) {
  return new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));
}

function usd(value:unknown) {
  const parsed = num(value,NaN);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("pt-BR",{style:"currency",currency:"USD"}).format(parsed)
    : "não informado";
}

function liveSupplyOutreachAcknowledged() {
  return process.env.ECOT_SUPPLY_OUTREACH_ENABLED === "true"
    && process.env.ECOT_SUPPLY_OUTREACH_ACK === "ENABLE_LIVE_SUPPLY_EMAILS";
}

async function supplyEvent(client:pg.PoolClient,input:{
  rfqId:number;
  selectionId?:number|null;
  outboxId?:number|null;
  responseId?:number|null;
  eventType:string;
  actor?:string|null;
  payload?:Json;
}) {
  await client.query(`
    INSERT INTO market_maker_supply_events(
      rfq_id,selection_id,outbox_id,response_id,event_type,actor,payload
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[
    input.rfqId,input.selectionId ?? null,input.outboxId ?? null,input.responseId ?? null,
    input.eventType,input.actor ?? null,JSON.stringify(input.payload || {}),
  ]);
}

async function selectionBundle(client:pg.PoolClient|typeof pool,selectionId:number,lock=false) {
  const { rows } = await client.query(`
    SELECT s.*,
           r.public_code AS rfq_public_code,r.status AS rfq_status,r.claim_purpose,r.target_year,
           r.target_tonnes,r.covered_tonnes,r.gap_tonnes,r.preferred_country,r.max_price_usd_tonne,
           a.company_name AS buyer_company_name,
           c.candidate_type,c.candidate_key,c.registry,c.registry_project_id,c.project_name,c.country,c.vintage,
           c.candidate_tonnes,c.confidence,c.sourcing_score,c.status AS candidate_status,c.rationale,c.snapshot AS candidate_snapshot,
           l.supplier_name,l.supplier_contact_name,l.supplier_email,l.supplier_phone,l.methodology,l.evidence_url,l.source_url,
           i.batch_reference,i.registry_evidence_url AS inventory_evidence_url
    FROM market_maker_supply_selections s
    JOIN market_maker_rfqs r ON r.id=s.rfq_id
    JOIN demand_accounts a ON a.id=r.account_id
    JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
    LEFT JOIN supply_leads l ON l.id=s.supply_lead_id
    LEFT JOIN supply_inventory i ON i.id=s.supply_inventory_id
    WHERE s.id=$1
    ${lock ? "FOR UPDATE OF s,r,c,l" : ""}`,[selectionId]);
  return rows[0] || null;
}

export async function supplyOutreachStatus() {
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM market_maker_supply_selections WHERE status IN ('selected','outbox_ready','contacting')) AS active_selections,
      (SELECT COUNT(*)::int FROM market_maker_supply_outbox WHERE status='ready') AS ready,
      (SELECT COUNT(*)::int FROM market_maker_supply_outbox WHERE status='sent') AS sent,
      (SELECT COUNT(*)::int FROM market_maker_supply_outbox WHERE status='failed') AS failed,
      (SELECT COUNT(*)::int FROM market_maker_supply_responses WHERE status='confirmed') AS confirmed_responses,
      (SELECT COUNT(*)::int FROM market_maker_supply_responses WHERE status='declined') AS declined_responses`);
  return {
    envEnabled:process.env.ECOT_SUPPLY_OUTREACH_ENABLED === "true",
    acknowledgementValid:process.env.ECOT_SUPPLY_OUTREACH_ACK === "ENABLE_LIVE_SUPPLY_EMAILS",
    live:liveSupplyOutreachAcknowledged(),
    provider:"resend",
    configured:Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    counts:counts.rows[0] || {},
    behavior:{
      humanSelectionRequired:true,
      explicitDispatchRequired:true,
      sellerConfirmationDoesNotCreateClaimReadyAsset:true,
      sellerConfirmationDoesNotResolveRfq:true,
      chargesMoney:false,
    },
  };
}

export async function selectSupplyCandidate(input:{
  rfqId:number;
  candidateId:number;
  requestedTonnes:number;
  responseDays?:number;
  selectedBy?:string|null;
  note?:string|null;
}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`
      SELECT * FROM market_maker_supply_selections
      WHERE rfq_id=$1 AND candidate_id=$2 FOR UPDATE`,[input.rfqId,input.candidateId])).rows[0];
    if (existing) return existing;

    const candidate = (await client.query(`
      SELECT c.*,r.status AS rfq_status,r.gap_tonnes,r.claim_purpose,r.target_year,r.preferred_country,
             l.supplier_name,l.supplier_contact_name,l.supplier_email,l.supplier_phone,l.evidence_url,l.source_url
      FROM market_maker_rfq_candidates c
      JOIN market_maker_rfqs r ON r.id=c.rfq_id
      LEFT JOIN supply_leads l ON l.id=c.supply_lead_id
      WHERE c.id=$1 AND c.rfq_id=$2
      FOR UPDATE OF c,r,l`,[input.candidateId,input.rfqId])).rows[0];
    if (!candidate) throw Object.assign(new Error("Candidato de supply não encontrado neste RFQ"),{status:404});
    if (!["open","partially_sourced"].includes(String(candidate.rfq_status))) {
      throw Object.assign(new Error("RFQ não está aberto para seleção de fornecedor"),{status:409});
    }
    if (["rejected","stale"].includes(String(candidate.status))) {
      throw Object.assign(new Error("Candidato de supply não está selecionável"),{status:409});
    }
    if (!candidate.supply_lead_id) {
      throw Object.assign(new Error("Candidato não possui supply lead associado para contato"),{status:409});
    }
    const requested = Number(input.requestedTonnes);
    const maxRequest = Math.min(num(candidate.gap_tonnes),num(candidate.candidate_tonnes));
    if (!Number.isFinite(requested) || requested<=0 || requested>maxRequest+0.001) {
      throw Object.assign(new Error(`Volume solicitado deve estar entre 0 e ${maxRequest.toFixed(3)} t`),{status:409});
    }
    const responseDays = Math.max(1,Math.min(30,Math.round(input.responseDays || 5)));
    const actor = actorName(input.selectedBy);
    const snapshot = {
      version:"ecotracker-supply-selection-v1",
      rfq:{
        id:Number(input.rfqId),claimPurpose:candidate.claim_purpose,targetYear:candidate.target_year,
        gapTonnes:num(candidate.gap_tonnes),preferredCountry:candidate.preferred_country,
      },
      candidate:{
        id:Number(candidate.id),type:candidate.candidate_type,key:candidate.candidate_key,
        registry:candidate.registry,registryProjectId:candidate.registry_project_id,projectName:candidate.project_name,
        country:candidate.country,vintage:candidate.vintage,candidateTonnes:num(candidate.candidate_tonnes),
        confidence:candidate.confidence,sourcingScore:Number(candidate.sourcing_score),
      },
      supplier:{
        leadId:Number(candidate.supply_lead_id),name:candidate.supplier_name,contactName:candidate.supplier_contact_name,
        email:candidate.supplier_email,phone:candidate.supplier_phone,evidenceUrl:candidate.evidence_url,sourceUrl:candidate.source_url,
      },
      requestedTonnes:requested,
      integrityDisclosure:"Commercial supplier confirmation is sourcing evidence only; it never creates or publishes a claim-ready carbon asset.",
      selectedAt:new Date().toISOString(),
    };
    const selection = (await client.query(`
      INSERT INTO market_maker_supply_selections(
        rfq_id,candidate_id,supply_lead_id,supply_inventory_id,requested_tonnes,status,response_due_at,
        selected_by,selected_note,snapshot
      ) VALUES($1,$2,$3,$4,$5,'selected',NOW()+($6::int * INTERVAL '1 day'),$7,$8,$9::jsonb)
      RETURNING *`,[
      input.rfqId,input.candidateId,candidate.supply_lead_id,candidate.supply_inventory_id,requested,responseDays,
      actor,input.note || null,JSON.stringify(snapshot),
    ])).rows[0];
    await client.query(`UPDATE market_maker_rfq_candidates SET status='selected',updated_at=NOW() WHERE id=$1`,[input.candidateId]);
    await supplyEvent(client,{
      rfqId:input.rfqId,selectionId:Number(selection.id),eventType:"supplier_selected",actor,
      payload:{requestedTonnes:requested,responseDays,candidateId:input.candidateId},
    });
    return selection;
  });
}

function buildSupplierEmail(bundle:Json,recipientName?:string|null) {
  const name = String(recipientName || bundle.supplier_contact_name || bundle.supplier_name || "Olá");
  const supplier = String(bundle.supplier_name || "fornecedor");
  const requested = tonnes(bundle.requested_tonnes);
  const project = String(bundle.project_name || bundle.registry_project_id || "projeto de carbono");
  const registry = String(bundle.registry || "registry");
  const reference = String(bundle.public_code || "");
  const deadline = bundle.response_due_at
    ? new Intl.DateTimeFormat("pt-BR",{dateStyle:"short"}).format(new Date(String(bundle.response_due_at)))
    : "em até 5 dias";
  const subject = `EcoTracker RFQ — ${requested} tCO₂e · ${registry} · ${project}`;
  const text = `${name},\n\nA EcoTracker está qualificando oferta para uma demanda corporativa de compensação voluntária e identificou o projeto ${project} (${registry}) como candidato de sourcing.\n\nSolicitação: ${requested} tCO₂e\nVintage: ${String(bundle.vintage || "n/d")}\nPrazo para resposta: ${deadline}\nReferência: ${reference}\n\nPor favor confirme por resposta a este e-mail:\n1. volume comercialmente livre disponível;\n2. preço firme em US$/tCO₂e;\n3. pedido mínimo;\n4. suporte a retirement/aposentadoria;\n5. possibilidade de retirement em nome do beneficiário final;\n6. URL/evidência registral e validade da oferta.\n\nImportante: esta consulta não representa compra, reserva, aceite ou compromisso financeiro. Uma confirmação comercial do fornecedor não torna o ativo automaticamente elegível para claims EcoTracker; elegibilidade, tradability e retirement readiness são validados separadamente.\n\nEcoTracker — Alternative Ventures Ltda.`;
  const html = `<p>${htmlEscape(name)},</p><p>A EcoTracker está qualificando oferta para uma demanda corporativa de compensação voluntária e identificou o projeto <strong>${htmlEscape(project)}</strong> (${htmlEscape(registry)}) como candidato de sourcing.</p><ul><li><strong>Solicitação:</strong> ${htmlEscape(requested)} tCO₂e</li><li><strong>Vintage:</strong> ${htmlEscape(bundle.vintage || "n/d")}</li><li><strong>Prazo para resposta:</strong> ${htmlEscape(deadline)}</li><li><strong>Referência:</strong> ${htmlEscape(reference)}</li></ul><p>Por favor confirme por resposta a este e-mail: volume comercialmente livre, preço firme em US$/tCO₂e, pedido mínimo, suporte a retirement, retirement em nome do beneficiário final, evidência registral e validade da oferta.</p><p><strong>Importante:</strong> esta consulta não representa compra, reserva, aceite ou compromisso financeiro. Uma confirmação comercial do fornecedor não torna o ativo automaticamente elegível para claims EcoTracker; elegibilidade, tradability e retirement readiness são validados separadamente.</p><p>EcoTracker — Alternative Ventures Ltda.</p>`;
  return {subject,text,html,supplier};
}

export async function createSupplySelectionOutbox(input:{
  selectionId:number;
  recipientEmail?:string|null;
  recipientName?:string|null;
  createdBy?:string|null;
}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM market_maker_supply_outbox WHERE selection_id=$1 FOR UPDATE`,[input.selectionId])).rows[0];
    if (existing) return existing;
    const bundle = await selectionBundle(client,input.selectionId,true);
    if (!bundle) throw Object.assign(new Error("Seleção de supply não encontrada"),{status:404});
    if (["responded","declined","cancelled","expired"].includes(String(bundle.status))) {
      throw Object.assign(new Error("Seleção não aceita novo outbox"),{status:409});
    }
    const email = String(input.recipientEmail || bundle.supplier_email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw Object.assign(new Error("Fornecedor selecionado não possui e-mail válido"),{status:409});
    }
    const recipientName = String(input.recipientName || bundle.supplier_contact_name || bundle.supplier_name || "").trim() || null;
    const content = buildSupplierEmail(bundle,recipientName);
    const publicCode = crypto.randomUUID();
    const idempotencyKey = `ecotracker-supply-rfq/${String(bundle.public_code)}`;
    const outbox = (await client.query(`
      INSERT INTO market_maker_supply_outbox(
        public_code,selection_id,recipient_email,recipient_name,supplier_name,subject,text_body,html_body,
        status,provider,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready','resend',$9) RETURNING *`,[
      publicCode,input.selectionId,email,recipientName,content.supplier,content.subject,content.text,content.html,idempotencyKey,
    ])).rows[0];
    await client.query(`UPDATE market_maker_supply_selections SET status='outbox_ready',updated_at=NOW() WHERE id=$1`,[input.selectionId]);
    await supplyEvent(client,{
      rfqId:Number(bundle.rfq_id),selectionId:input.selectionId,outboxId:Number(outbox.id),eventType:"supply_outbox_created",
      actor:actorName(input.createdBy),payload:{recipientEmail:email,idempotencyKey},
    });
    return outbox;
  });
}

async function sendViaResend(input:Parameters<SupplyOutreachSender>[0]) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(input.from || process.env.EMAIL_FROM || "").trim();
  if (!apiKey || !from) throw new Error("Resend/EMAIL_FROM não configurados");
  const response = await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${apiKey}`,
      "Content-Type":"application/json",
      "Idempotency-Key":input.idempotencyKey,
    },
    body:JSON.stringify({from,to:[input.to],subject:input.subject,text:input.text,html:input.html}),
  });
  const data = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw new Error(`Resend ${response.status}: ${String(data.message || data.name || "falha no envio")}`);
  const providerReference = String(data.id || "").trim();
  if (!providerReference) throw new Error("Resend não retornou id do e-mail");
  return {providerReference};
}

export async function dispatchSupplyOutbox(
  outboxId:number,
  options:{sender?:SupplyOutreachSender;testBypassGate?:boolean;actor?:string|null} = {},
) {
  const testBypass = process.env.NODE_ENV === "test" && options.testBypassGate === true && Boolean(options.sender);
  if (!liveSupplyOutreachAcknowledged() && !testBypass) {
    throw Object.assign(new Error("Supply outreach está desligado neste deployment"),{status:409});
  }
  const sender = options.sender || sendViaResend;
  return withTransaction(async (client) => {
    const row = (await client.query(`
      SELECT o.*,s.rfq_id,s.candidate_id,s.status AS selection_status,s.response_due_at
      FROM market_maker_supply_outbox o
      JOIN market_maker_supply_selections s ON s.id=o.selection_id
      WHERE o.id=$1 FOR UPDATE OF o,s`,[outboxId])).rows[0];
    if (!row) throw Object.assign(new Error("Supply outbox não encontrado"),{status:404});
    if (row.status === "sent") return {alreadySent:true,outbox:row};
    if (row.status === "cancelled") throw Object.assign(new Error("Supply outbox cancelado"),{status:409});
    if (["responded","declined","cancelled","expired"].includes(String(row.selection_status))) {
      throw Object.assign(new Error("Seleção de supply não permite envio"),{status:409});
    }

    await client.query(`UPDATE market_maker_supply_outbox SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=NOW() WHERE id=$1`,[outboxId]);
    try {
      const result = await sender({
        from:String(process.env.EMAIL_FROM || "EcoTracker <noreply@ecotracker.invalid>"),
        to:row.recipient_email,subject:row.subject,text:row.text_body,html:row.html_body,idempotencyKey:row.idempotency_key,
      });
      const sent = (await client.query(`
        UPDATE market_maker_supply_outbox SET status='sent',provider_reference=$2,sent_at=NOW(),updated_at=NOW()
        WHERE id=$1 RETURNING *`,[outboxId,result.providerReference])).rows[0];
      await client.query(`UPDATE market_maker_supply_selections SET status='contacting',updated_at=NOW() WHERE id=$1`,[row.selection_id]);
      await client.query(`UPDATE market_maker_rfq_candidates SET status='contacting',updated_at=NOW() WHERE id=$1 AND status NOT IN ('qualified','rejected','stale')`,[row.candidate_id]);
      await supplyEvent(client,{
        rfqId:Number(row.rfq_id),selectionId:Number(row.selection_id),outboxId,eventType:"supply_outbox_sent",
        actor:actorName(options.actor),payload:{provider:"resend",providerReference:result.providerReference,idempotencyKey:row.idempotency_key},
      });
      return {alreadySent:false,outbox:sent};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = (await client.query(`
        UPDATE market_maker_supply_outbox SET status='failed',last_error=$2,updated_at=NOW()
        WHERE id=$1 RETURNING *`,[outboxId,message.slice(0,5000)])).rows[0];
      await supplyEvent(client,{
        rfqId:Number(row.rfq_id),selectionId:Number(row.selection_id),outboxId,eventType:"supply_outbox_failed",
        actor:actorName(options.actor),payload:{error:message},
      });
      return {alreadySent:false,failed:true,error:message,outbox:failed};
    }
  });
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
    const existing = (await client.query(`SELECT * FROM market_maker_supply_responses WHERE selection_id=$1 FOR UPDATE`,[input.selectionId])).rows[0];
    if (existing) return existing;
    const bundle = await selectionBundle(client,input.selectionId,true);
    if (!bundle) throw Object.assign(new Error("Seleção de supply não encontrada"),{status:404});
    if (["cancelled","expired"].includes(String(bundle.status))) {
      throw Object.assign(new Error("Seleção não aceita resposta"),{status:409});
    }
    const confirmed = Math.max(0,Number(input.confirmedAvailableTonnes));
    if (!Number.isFinite(confirmed)) throw Object.assign(new Error("Volume confirmado inválido"),{status:400});
    const firmPrice = input.firmPriceUsdTonne == null ? null : Number(input.firmPriceUsdTonne);
    const minOrder = input.minOrderTonnes == null ? null : Math.max(0,Number(input.minOrderTonnes));
    if (firmPrice != null && (!Number.isFinite(firmPrice) || firmPrice<=0)) throw Object.assign(new Error("Preço firme inválido"),{status:400});
    if (minOrder != null && (!Number.isFinite(minOrder) || (confirmed>0 && minOrder>confirmed+0.001))) {
      throw Object.assign(new Error("Pedido mínimo não pode superar o volume confirmado"),{status:409});
    }
    const status = confirmed>0 ? "confirmed" : "declined";
    const actor = actorName(input.respondedBy);
    const responseSnapshot = {
      confirmedAvailableTonnes:confirmed,firmPriceUsdTonne:firmPrice,minOrderTonnes:minOrder,
      retirementSupported:Boolean(input.retirementSupported),
      beneficiaryRetirementSupported:Boolean(input.beneficiaryRetirementSupported),
      registryEvidenceUrl:input.registryEvidenceUrl || null,validUntil:input.validUntil || null,
      responseNote:input.responseNote || null,
      integrityDisclosure:"Seller confirmation is commercial sourcing evidence only and does not create claim-ready inventory.",
      capturedAt:new Date().toISOString(),
    };
    const created = (await client.query(`
      INSERT INTO market_maker_supply_responses(
        selection_id,status,confirmed_available_tonnes,firm_price_usd_tonne,min_order_tonnes,
        retirement_supported,beneficiary_retirement_supported,registry_evidence_url,valid_until,
        response_note,responded_by,response_snapshot
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12::jsonb)
      RETURNING *`,[
      input.selectionId,status,confirmed,firmPrice,minOrder,Boolean(input.retirementSupported),
      Boolean(input.beneficiaryRetirementSupported),input.registryEvidenceUrl || null,input.validUntil || null,
      input.responseNote || null,actor,JSON.stringify(responseSnapshot),
    ])).rows[0];

    rfqId = Number(bundle.rfq_id);
    await client.query(`
      UPDATE market_maker_supply_selections
      SET status=$2,updated_at=NOW() WHERE id=$1`,[
      input.selectionId,status === "confirmed" ? "responded" : "declined",
    ]);
    await client.query(`
      UPDATE market_maker_rfq_candidates
      SET status=$2,confidence=CASE WHEN $2='qualified' THEN 'seller_confirmed' ELSE confidence END,
          candidate_tonnes=CASE WHEN $2='qualified' THEN $3 ELSE candidate_tonnes END,
          rationale=rationale || $4::jsonb,snapshot=snapshot || $5::jsonb,updated_at=NOW()
      WHERE id=$1`,[
      bundle.candidate_id,status === "confirmed" ? "qualified" : "rejected",confirmed,
      JSON.stringify({supplierResponseStatus:status,sellerConfirmed:status === "confirmed",responseCapturedAt:new Date().toISOString()}),
      JSON.stringify({firmPriceUsdTonne:firmPrice,minOrderTonnes:minOrder,retirementSupported:Boolean(input.retirementSupported),beneficiaryRetirementSupported:Boolean(input.beneficiaryRetirementSupported),registryEvidenceUrl:input.registryEvidenceUrl || null}),
    ]);

    if (bundle.supply_lead_id) {
      if (status === "confirmed") {
        await client.query(`
          UPDATE supply_leads SET
            confirmed_free_tonnes=$2,availability_confidence='seller_confirmed',
            contact_status=CASE WHEN contact_status='mandate_ready' THEN contact_status ELSE 'qualified' END,
            status=CASE WHEN status='mandated' THEN status ELSE 'qualified' END,
            evidence_url=COALESCE($3,evidence_url),
            notes=CASE WHEN $4::text IS NULL THEN notes ELSE CONCAT_WS(E'\n',NULLIF(notes,''),$4) END,
            metadata=metadata || $5::jsonb,last_checked_at=NOW(),updated_at=NOW()
          WHERE id=$1`,[
          bundle.supply_lead_id,confirmed,input.registryEvidenceUrl || null,input.responseNote || null,
          JSON.stringify({lastSupplyResponse:{firmPriceUsdTonne:firmPrice,minOrderTonnes:minOrder,retirementSupported:Boolean(input.retirementSupported),beneficiaryRetirementSupported:Boolean(input.beneficiaryRetirementSupported),validUntil:input.validUntil || null,selectionId:input.selectionId}}),
        ]);
      } else {
        await client.query(`
          UPDATE supply_leads SET contact_status='contacted',metadata=metadata || $2::jsonb,last_checked_at=NOW(),updated_at=NOW()
          WHERE id=$1`,[
          bundle.supply_lead_id,JSON.stringify({lastSupplyResponse:{declined:true,selectionId:input.selectionId,responseNote:input.responseNote || null}}),
        ]);
      }
    }
    await supplyEvent(client,{
      rfqId,selectionId:input.selectionId,responseId:Number(created.id),eventType:status === "confirmed" ? "supplier_confirmed" : "supplier_declined",
      actor,payload:responseSnapshot,
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

export async function cancelSupplyOutbox(input:{outboxId:number;actor?:string|null;reason?:string|null}) {
  return withTransaction(async (client) => {
    const row = (await client.query(`
      SELECT o.*,s.rfq_id,s.status AS selection_status
      FROM market_maker_supply_outbox o JOIN market_maker_supply_selections s ON s.id=o.selection_id
      WHERE o.id=$1 FOR UPDATE OF o,s`,[input.outboxId])).rows[0];
    if (!row) throw Object.assign(new Error("Supply outbox não encontrado"),{status:404});
    if (row.status === "sent") throw Object.assign(new Error("RFQ já enviado não pode ser cancelado"),{status:409});
    if (row.status === "cancelled") return row;
    const cancelled = (await client.query(`
      UPDATE market_maker_supply_outbox SET status='cancelled',cancelled_at=NOW(),last_error=$2,updated_at=NOW()
      WHERE id=$1 RETURNING *`,[input.outboxId,input.reason || null])).rows[0];
    if (!["responded","declined"].includes(String(row.selection_status))) {
      await client.query(`UPDATE market_maker_supply_selections SET status='cancelled',updated_at=NOW() WHERE id=$1`,[row.selection_id]);
    }
    await supplyEvent(client,{
      rfqId:Number(row.rfq_id),selectionId:Number(row.selection_id),outboxId:input.outboxId,eventType:"supply_outbox_cancelled",
      actor:actorName(input.actor),payload:{reason:input.reason || null},
    });
    return cancelled;
  });
}

export async function listSupplySelections(input:{status?:string;limit?:number}={}) {
  const status = String(input.status || "").trim();
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const { rows } = await pool.query(`
    SELECT s.*,
           r.public_code AS rfq_public_code,r.status AS rfq_status,r.gap_tonnes,r.target_tonnes,
           a.company_name,
           c.candidate_type,c.registry,c.registry_project_id,c.project_name,c.country,c.vintage,c.confidence,c.sourcing_score,
           l.supplier_name,l.supplier_contact_name,l.supplier_email,l.supplier_phone,
           o.id AS outbox_id,o.status AS outbox_status,o.sent_at,o.provider_reference,
           resp.id AS response_id,resp.status AS response_status,resp.confirmed_available_tonnes,
           resp.firm_price_usd_tonne,resp.min_order_tonnes,resp.retirement_supported,
           resp.beneficiary_retirement_supported,resp.registry_evidence_url,resp.valid_until,resp.response_note,resp.responded_by
    FROM market_maker_supply_selections s
    JOIN market_maker_rfqs r ON r.id=s.rfq_id
    JOIN demand_accounts a ON a.id=r.account_id
    JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
    LEFT JOIN supply_leads l ON l.id=s.supply_lead_id
    LEFT JOIN market_maker_supply_outbox o ON o.selection_id=s.id
    LEFT JOIN market_maker_supply_responses resp ON resp.selection_id=s.id
    WHERE ($1='' OR s.status=$1)
    ORDER BY CASE s.status WHEN 'selected' THEN 1 WHEN 'outbox_ready' THEN 2 WHEN 'contacting' THEN 3 WHEN 'responded' THEN 4 ELSE 5 END,
             s.created_at DESC
    LIMIT $2`,[status,limit]);
  return rows;
}

export async function listSupplyOutbox(input:{status?:string;limit?:number}={}) {
  const status = String(input.status || "").trim();
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const { rows } = await pool.query(`
    SELECT o.*,s.rfq_id,s.candidate_id,s.requested_tonnes,s.response_due_at,s.status AS selection_status,
           r.public_code AS rfq_public_code,r.claim_purpose,r.target_year,r.gap_tonnes,
           a.company_name,
           c.registry,c.registry_project_id,c.project_name,c.country,c.vintage,
           l.supplier_name,l.supplier_contact_name,l.supplier_email
    FROM market_maker_supply_outbox o
    JOIN market_maker_supply_selections s ON s.id=o.selection_id
    JOIN market_maker_rfqs r ON r.id=s.rfq_id
    JOIN demand_accounts a ON a.id=r.account_id
    JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
    LEFT JOIN supply_leads l ON l.id=s.supply_lead_id
    WHERE ($1='' OR o.status=$1)
    ORDER BY CASE o.status WHEN 'ready' THEN 1 WHEN 'failed' THEN 2 WHEN 'sending' THEN 3 ELSE 4 END,o.created_at DESC
    LIMIT $2`,[status,limit]);
  return rows;
}
