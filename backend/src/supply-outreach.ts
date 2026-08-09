import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";

type Json = Record<string, unknown>;

export type SupplyOutreachSender = (input:{
  from:string;to:string;subject:string;text:string;html:string;idempotencyKey:string;
}) => Promise<{providerReference:string}>;

const num = (value:unknown,fallback=0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const actor = (value?:string|null) => String(value || process.env.ADMIN_EMAIL || "ecotracker-admin").trim().slice(0,255);
const sha256 = (value:unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const escapeHtml = (value:unknown) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const fmt = (value:unknown) => new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(num(value));

function liveAcknowledged() {
  return process.env.ECOT_SUPPLY_OUTREACH_ENABLED === "true"
    && process.env.ECOT_SUPPLY_OUTREACH_ACK === "ENABLE_LIVE_SUPPLY_EMAILS";
}

async function logEvent(client:pg.PoolClient,input:{rfqId:number;candidateId?:number|null;selectionId?:number|null;outboxId?:number|null;responseId?:number|null;type:string;actor?:string|null;payload?:Json}) {
  await client.query(`
    INSERT INTO supply_outreach_events(rfq_id,candidate_id,selection_id,outbox_id,response_id,event_type,actor,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[
    input.rfqId,input.candidateId ?? null,input.selectionId ?? null,input.outboxId ?? null,input.responseId ?? null,
    input.type,input.actor ?? null,JSON.stringify(input.payload || {}),
  ]);
}

async function candidateBundle(client:pg.PoolClient | typeof pool,rfqId:number,candidateId:number,lock=false) {
  const { rows } = await client.query(`
    SELECT r.*,a.company_name AS buyer_company_name,
           c.id AS candidate_id,c.public_code AS candidate_public_code,c.candidate_type,c.candidate_key,
           c.supply_lead_id,c.supply_inventory_id,c.registry,c.registry_project_id,c.project_name,c.country,c.vintage,
           c.candidate_tonnes,c.confidence,c.sourcing_score,c.status AS candidate_status,c.auto_close_eligible,c.rationale,c.snapshot AS candidate_snapshot,
           l.supplier_name,l.supplier_contact_name,l.supplier_email,l.supplier_phone,l.confirmed_free_tonnes,l.estimated_unretired_tonnes,
           l.evidence_url AS lead_evidence_url,l.source_url AS lead_source_url,l.availability_confidence
    FROM market_maker_rfqs r
    JOIN demand_accounts a ON a.id=r.account_id
    JOIN market_maker_rfq_candidates c ON c.rfq_id=r.id
    LEFT JOIN supply_leads l ON l.id=c.supply_lead_id
    WHERE r.id=$1 AND c.id=$2
    ${lock ? "FOR UPDATE OF r,c" : ""}`,[rfqId,candidateId]);
  return rows[0] || null;
}

function frozenSelectionSnapshot(row:Json,requestedTonnes:number,maxPriceUsdTonne:number|null,responseDueAt:string|null) {
  return {
    version:"ecotracker-supply-rfq-selection-v1",
    rfq:{
      id:Number(row.id),publicCode:row.public_code,claimPurpose:row.claim_purpose,targetYear:row.target_year,
      targetTonnes:num(row.target_tonnes),coveredTonnes:num(row.covered_tonnes),gapTonnes:num(row.gap_tonnes),
      preferredCountry:row.preferred_country,maxPriceUsdTonne:maxPriceUsdTonne ?? (row.max_price_usd_tonne == null ? null : num(row.max_price_usd_tonne)),
      buyerCompanyInternal:row.buyer_company_name,
    },
    candidate:{
      id:Number(row.candidate_id),publicCode:row.candidate_public_code,type:row.candidate_type,registry:row.registry,
      registryProjectId:row.registry_project_id,projectName:row.project_name,country:row.country,vintage:row.vintage,
      candidateTonnes:num(row.candidate_tonnes),confidence:row.confidence,sourcingScore:Number(row.sourcing_score || 0),
      autoCloseEligible:false,rationale:row.rationale || {},
    },
    supplier:{
      leadId:row.supply_lead_id ? Number(row.supply_lead_id) : null,name:row.supplier_name || null,
      contactName:row.supplier_contact_name || null,email:row.supplier_email || null,phone:row.supplier_phone || null,
      evidenceUrl:row.lead_evidence_url || null,sourceUrl:row.lead_source_url || null,
    },
    request:{
      requestedTonnes,maxPriceUsdTonne,responseDueAt,
      fields:["confirmed_free_tonnes","firm_price_usd_tonne","min_order_tonnes","retirement_supported","beneficiary_retirement_supported","registry_evidence","offer_validity","settlement_terms","mandate_or_direct_execution_terms"],
    },
    integrity:{
      claimReady:false,
      rule:"Supplier outreach or seller confirmation never promotes a candidate to claim-ready. Eligibility and monitored-asset gates remain mandatory.",
    },
    frozenAt:new Date().toISOString(),
  };
}

export async function supplyOutreachStatus() {
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM supply_outreach_selections WHERE status='approved') AS selected,
      (SELECT COUNT(*)::int FROM supply_outbox WHERE status='ready') AS ready,
      (SELECT COUNT(*)::int FROM supply_outbox WHERE status='sent') AS sent,
      (SELECT COUNT(*)::int FROM supply_outreach_responses) AS responses`);
  return {
    envEnabled:process.env.ECOT_SUPPLY_OUTREACH_ENABLED === "true",
    acknowledgementValid:process.env.ECOT_SUPPLY_OUTREACH_ACK === "ENABLE_LIVE_SUPPLY_EMAILS",
    live:liveAcknowledged(),provider:"resend",configured:Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    counts:counts.rows[0] || {},
    behavior:{humanSelectionRequired:true,explicitDispatchRequired:true,sellerResponseIsNotClaimReady:true,autoMandate:false,autoPublish:false},
  };
}

export async function selectSupplyCandidate(input:{rfqId:number;candidateId:number;requestedTonnes?:number|null;maxPriceUsdTonne?:number|null;responseDays?:number|null;selectedBy?:string|null;note?:string|null}) {
  return withTransaction(async (client) => {
    const row = await candidateBundle(client,input.rfqId,input.candidateId,true);
    if (!row) throw Object.assign(new Error("RFQ/candidato não encontrado"),{status:404});
    if (!["open","partially_sourced"].includes(String(row.status))) throw Object.assign(new Error("RFQ não está aberto para sourcing"),{status:409});
    if (["stale","rejected"].includes(String(row.candidate_status))) throw Object.assign(new Error("Candidato não está disponível para abordagem"),{status:409});
    const existing = (await client.query(`SELECT * FROM supply_outreach_selections WHERE candidate_id=$1 AND status='approved' FOR UPDATE`,[input.candidateId])).rows[0];
    if (existing) return existing;
    const maxVolume = Math.max(0,num(row.candidate_tonnes));
    const gap = Math.max(0,num(row.gap_tonnes));
    const requested = Number(Math.min(maxVolume,input.requestedTonnes == null ? gap : Math.max(0,input.requestedTonnes)).toFixed(3));
    if (requested<=0 || requested>maxVolume+0.001) throw Object.assign(new Error("Volume solicitado ao fornecedor é inválido"),{status:409});
    const responseDays = Math.max(1,Math.min(30,Math.round(input.responseDays || 5)));
    const responseDueAt = new Date(Date.now()+responseDays*86_400_000).toISOString();
    const maxPrice = input.maxPriceUsdTonne ?? (row.max_price_usd_tonne == null ? null : num(row.max_price_usd_tonne));
    const snapshot = frozenSelectionSnapshot(row,requested,maxPrice,responseDueAt);
    const hash = sha256(snapshot);
    const selection = (await client.query(`
      INSERT INTO supply_outreach_selections(
        rfq_id,candidate_id,status,selected_by,review_note,requested_tonnes,max_price_usd_tonne,response_due_at,snapshot,snapshot_sha256,approved_at
      ) VALUES($1,$2,'approved',$3,$4,$5,$6,$7,$8::jsonb,$9,NOW()) RETURNING *`,[
      input.rfqId,input.candidateId,actor(input.selectedBy),input.note || null,requested,maxPrice,responseDueAt,JSON.stringify(snapshot),hash,
    ])).rows[0];
    await client.query(`UPDATE market_maker_rfq_candidates SET status='selected',updated_at=NOW() WHERE id=$1`,[input.candidateId]);
    await logEvent(client,{rfqId:input.rfqId,candidateId:input.candidateId,selectionId:Number(selection.id),type:"candidate_selected",actor:actor(input.selectedBy),payload:{requestedTonnes:requested,snapshotSha256:hash}});
    return selection;
  });
}

function buildSupplierEmail(snapshot:Json,recipientName?:string|null) {
  const candidate = (snapshot.candidate || {}) as Json;
  const request = (snapshot.request || {}) as Json;
  const supplier = (snapshot.supplier || {}) as Json;
  const name = String(recipientName || supplier.contactName || supplier.name || "Olá");
  const project = String(candidate.projectName || candidate.registryProjectId || "projeto de carbono");
  const volume = fmt(request.requestedTonnes);
  const priceLine = request.maxPriceUsdTonne == null ? "" : ` Faixa máxima indicativa da demanda: US$ ${fmt(request.maxPriceUsdTonne)}/tCO₂e.`;
  const subject = `EcoTracker RFQ — ${volume} tCO₂e — ${project}`;
  const text = `${name},\n\nA EcoTracker está estruturando uma demanda corporativa de compensação e gostaria de confirmar condições comerciais para ${volume} tCO₂e do projeto ${project} (${candidate.registry || "registry a confirmar"}, vintage ${candidate.vintage || "a confirmar"}).${priceLine}\n\nPara qualificarmos o lote, por favor confirme:\n- volume efetivamente livre para negociação;\n- preço firme em US$/tCO₂e e pedido mínimo;\n- capacidade de aposentadoria/retirement e retirement em nome do beneficiário;\n- batch/serial/evidência registral disponível;\n- validade da oferta;\n- condições de liquidação e execução;\n- possibilidade de mandato de distribuição ou execução direta.\n\nEste contato é uma solicitação de cotação e não representa compromisso de compra. Mesmo após confirmação comercial, o ativo só poderá ser ofertado como compensação pela EcoTracker depois de passar pelos gates de elegibilidade, disponibilidade e retirement.\n\nEcoTracker — Alternative Ventures Ltda.`;
  const html = `<p>${escapeHtml(name)},</p><p>A EcoTracker está estruturando uma demanda corporativa de compensação e gostaria de confirmar condições comerciais para <strong>${escapeHtml(volume)} tCO₂e</strong> do projeto <strong>${escapeHtml(project)}</strong> (${escapeHtml(candidate.registry || "registry a confirmar")}, vintage ${escapeHtml(candidate.vintage || "a confirmar")}).${escapeHtml(priceLine)}</p><p><strong>Precisamos confirmar:</strong></p><ul><li>volume efetivamente livre para negociação</li><li>preço firme em US$/tCO₂e e pedido mínimo</li><li>capacidade de retirement e retirement em nome do beneficiário</li><li>batch/serial/evidência registral</li><li>validade da oferta</li><li>condições de liquidação e execução</li><li>mandato de distribuição ou execução direta</li></ul><p>Este contato é uma solicitação de cotação e não representa compromisso de compra. A confirmação comercial não torna o ativo claim-ready: os gates de elegibilidade, disponibilidade e retirement continuam obrigatórios.</p><p>EcoTracker — Alternative Ventures Ltda.</p>`;
  return {subject,text,html};
}

export async function createSupplyOutbox(input:{selectionId:number;recipientEmail?:string|null;recipientName?:string|null;createdBy?:string|null}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM supply_outbox WHERE selection_id=$1 FOR UPDATE`,[input.selectionId])).rows[0];
    if (existing) return existing;
    const { rows } = await client.query(`
      SELECT s.*,c.supply_lead_id,l.supplier_email,l.supplier_contact_name,l.supplier_name,r.status AS rfq_status
      FROM supply_outreach_selections s
      JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
      JOIN market_maker_rfqs r ON r.id=s.rfq_id
      LEFT JOIN supply_leads l ON l.id=c.supply_lead_id
      WHERE s.id=$1 FOR UPDATE OF s,c,r`,[input.selectionId]);
    const selection = rows[0];
    if (!selection) throw Object.assign(new Error("Seleção de supply não encontrada"),{status:404});
    if (selection.status!=="approved") throw Object.assign(new Error("Seleção de supply não está aprovada"),{status:409});
    if (!["open","partially_sourced"].includes(String(selection.rfq_status))) throw Object.assign(new Error("RFQ não está mais aberto"),{status:409});
    const email = String(input.recipientEmail || selection.supplier_email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw Object.assign(new Error("Fornecedor não possui e-mail válido para outreach"),{status:409});
    const recipientName = String(input.recipientName || selection.supplier_contact_name || selection.supplier_name || "").trim() || null;
    const content = buildSupplierEmail(selection.snapshot as Json,recipientName);
    const publicCode = crypto.randomUUID();
    const idempotencyKey = `ecotracker-supply-rfq/${publicCode}`;
    const outbox = (await client.query(`
      INSERT INTO supply_outbox(
        public_code,selection_id,rfq_id,candidate_id,supply_lead_id,recipient_email,recipient_name,subject,text_body,html_body,status,provider,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready','resend',$11) RETURNING *`,[
      publicCode,selection.id,selection.rfq_id,selection.candidate_id,selection.supply_lead_id,email,recipientName,
      content.subject,content.text,content.html,idempotencyKey,
    ])).rows[0];
    await logEvent(client,{rfqId:Number(selection.rfq_id),candidateId:Number(selection.candidate_id),selectionId:Number(selection.id),outboxId:Number(outbox.id),type:"supply_outbox_created",actor:actor(input.createdBy),payload:{recipientEmail:email,idempotencyKey}});
    return outbox;
  });
}

async function sendViaResend(input:Parameters<SupplyOutreachSender>[0]) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(input.from || process.env.EMAIL_FROM || "").trim();
  if (!apiKey || !from) throw new Error("RESEND_API_KEY e EMAIL_FROM são obrigatórios para dispatch");
  const response = await fetch("https://api.resend.com/emails",{
    method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json","Idempotency-Key":input.idempotencyKey},
    body:JSON.stringify({from,to:[input.to],subject:input.subject,text:input.text,html:input.html}),
  });
  const data = await response.json().catch(()=>({})) as Json;
  if (!response.ok) throw new Error(`Resend ${response.status}: ${String(data.message || data.name || "falha no envio")}`);
  const providerReference = String(data.id || "").trim();
  if (!providerReference) throw new Error("Resend não retornou id do e-mail");
  return {providerReference};
}

export async function dispatchSupplyOutbox(outboxId:number,options:{sender?:SupplyOutreachSender;testBypassGate?:boolean;actor?:string|null}={}) {
  const testBypass = process.env.NODE_ENV==="test" && options.testBypassGate===true && Boolean(options.sender);
  if (!liveAcknowledged() && !testBypass) throw Object.assign(new Error("Supply outreach está desligado neste deployment"),{status:409});
  const sender = options.sender || sendViaResend;
  return withTransaction(async (client) => {
    const row = (await client.query(`
      SELECT o.*,s.status AS selection_status,r.status AS rfq_status
      FROM supply_outbox o
      JOIN supply_outreach_selections s ON s.id=o.selection_id
      JOIN market_maker_rfqs r ON r.id=o.rfq_id
      WHERE o.id=$1 FOR UPDATE OF o,s,r`,[outboxId])).rows[0];
    if (!row) throw Object.assign(new Error("Supply outbox não encontrado"),{status:404});
    if (row.status==="sent") return {alreadySent:true,outbox:row};
    if (row.status==="cancelled") throw Object.assign(new Error("Supply outbox cancelado"),{status:409});
    if (row.selection_status!=="approved") throw Object.assign(new Error("Seleção do fornecedor não está aprovada"),{status:409});
    if (!["open","partially_sourced"].includes(String(row.rfq_status))) throw Object.assign(new Error("RFQ não está mais aberto"),{status:409});
    await client.query(`UPDATE supply_outbox SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=NOW() WHERE id=$1`,[outboxId]);
    try {
      const result = await sender({from:String(process.env.EMAIL_FROM || "EcoTracker <noreply@ecotracker.invalid>"),to:row.recipient_email,subject:row.subject,text:row.text_body,html:row.html_body,idempotencyKey:row.idempotency_key});
      const sent = (await client.query(`UPDATE supply_outbox SET status='sent',provider_reference=$2,sent_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[outboxId,result.providerReference])).rows[0];
      await client.query(`UPDATE market_maker_rfq_candidates SET status='contacting',updated_at=NOW() WHERE id=$1 AND status='selected'`,[row.candidate_id]);
      await logEvent(client,{rfqId:Number(row.rfq_id),candidateId:Number(row.candidate_id),selectionId:Number(row.selection_id),outboxId,type:"supply_outbox_sent",actor:actor(options.actor),payload:{providerReference:result.providerReference,idempotencyKey:row.idempotency_key}});
      return {alreadySent:false,outbox:sent};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = (await client.query(`UPDATE supply_outbox SET status='failed',last_error=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[outboxId,message.slice(0,5000)])).rows[0];
      await logEvent(client,{rfqId:Number(row.rfq_id),candidateId:Number(row.candidate_id),selectionId:Number(row.selection_id),outboxId,type:"supply_outbox_failed",actor:actor(options.actor),payload:{error:message}});
      return {alreadySent:false,failed:true,error:message,outbox:failed};
    }
  });
}

export async function recordSupplyResponse(input:{selectionId:number;confirmedAvailableTonnes:number;firmPriceUsdTonne?:number|null;minOrderTonnes?:number|null;retirementSupported?:boolean|null;beneficiaryRetirementSupported?:boolean|null;registryEvidenceUrl?:string|null;offerValidUntil?:string|null;responseNote?:string|null;recordedBy?:string|null;rawResponse?:Json}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM supply_outreach_responses WHERE selection_id=$1 FOR UPDATE`,[input.selectionId])).rows[0];
    if (existing) return existing;
    const row = (await client.query(`
      SELECT s.*,c.supply_lead_id,c.id AS candidate_id,c.rfq_id,o.id AS outbox_id,o.status AS outbox_status
      FROM supply_outreach_selections s
      JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
      LEFT JOIN supply_outbox o ON o.selection_id=s.id
      WHERE s.id=$1 FOR UPDATE OF s,c`,[input.selectionId])).rows[0];
    if (!row) throw Object.assign(new Error("Seleção de supply não encontrada"),{status:404});
    if (row.status!=="approved") throw Object.assign(new Error("Seleção não está ativa"),{status:409});
    const confirmed = Math.max(0,Number(input.confirmedAvailableTonnes.toFixed(3)));
    const response = (await client.query(`
      INSERT INTO supply_outreach_responses(
        selection_id,outbox_id,rfq_id,candidate_id,supply_lead_id,confirmed_available_tonnes,firm_price_usd_tonne,
        min_order_tonnes,retirement_supported,beneficiary_retirement_supported,registry_evidence_url,offer_valid_until,response_note,recorded_by,raw_response
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING *`,[
      row.id,row.outbox_id || null,row.rfq_id,row.candidate_id,row.supply_lead_id || null,confirmed,input.firmPriceUsdTonne ?? null,
      input.minOrderTonnes ?? null,input.retirementSupported ?? null,input.beneficiaryRetirementSupported ?? null,input.registryEvidenceUrl || null,
      input.offerValidUntil || null,input.responseNote || null,actor(input.recordedBy),JSON.stringify(input.rawResponse || {}),
    ])).rows[0];
    await client.query(`
      UPDATE market_maker_rfq_candidates SET candidate_tonnes=$2,confidence='seller_confirmed',status='qualified',auto_close_eligible=FALSE,
        rationale=rationale || $3::jsonb,updated_at=NOW(),last_checked_at=NOW() WHERE id=$1`,[
      row.candidate_id,confirmed,JSON.stringify({sellerResponseRecorded:true,claimReady:false,confirmedAvailableTonnes:confirmed,firmPriceUsdTonne:input.firmPriceUsdTonne ?? null,retirementSupported:input.retirementSupported ?? null,beneficiaryRetirementSupported:input.beneficiaryRetirementSupported ?? null}),
    ]);
    if (row.supply_lead_id) {
      await client.query(`
        UPDATE supply_leads SET confirmed_free_tonnes=$2,availability_confidence='seller_confirmed',
          evidence_url=COALESCE($3,evidence_url),updated_at=NOW(),last_checked_at=NOW()
        WHERE id=$1`,[row.supply_lead_id,confirmed,input.registryEvidenceUrl || null]);
    }
    await logEvent(client,{rfqId:Number(row.rfq_id),candidateId:Number(row.candidate_id),selectionId:Number(row.id),outboxId:row.outbox_id ? Number(row.outbox_id) : null,responseId:Number(response.id),type:"supplier_response_recorded",actor:actor(input.recordedBy),payload:{confirmedAvailableTonnes:confirmed,claimReady:false}});
    return response;
  });
}

export async function listSupplyOutbox(input:{status?:string;limit?:number}={}) {
  const status = String(input.status || "").trim();
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const { rows } = await pool.query(`
    SELECT o.*,s.requested_tonnes,s.snapshot_sha256,c.project_name,c.registry,c.candidate_type,
           l.supplier_name,l.supplier_contact_name,r.gap_tonnes,r.status AS rfq_status
    FROM supply_outbox o
    JOIN supply_outreach_selections s ON s.id=o.selection_id
    JOIN market_maker_rfq_candidates c ON c.id=o.candidate_id
    JOIN market_maker_rfqs r ON r.id=o.rfq_id
    LEFT JOIN supply_leads l ON l.id=o.supply_lead_id
    WHERE ($1='' OR o.status=$1)
    ORDER BY CASE o.status WHEN 'ready' THEN 1 WHEN 'failed' THEN 2 WHEN 'sending' THEN 3 ELSE 4 END,o.created_at DESC
    LIMIT $2`,[status,limit]);
  return rows;
}

export async function listSupplySelections(input:{rfqId?:number|null;limit?:number}={}) {
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const { rows } = await pool.query(`
    SELECT s.*,c.project_name,c.registry,c.candidate_type,c.status AS candidate_status,l.supplier_name,l.supplier_email,
           o.id AS outbox_id,o.status AS outbox_status,o.sent_at,
           resp.id AS response_id,resp.confirmed_available_tonnes,resp.firm_price_usd_tonne,resp.retirement_supported,resp.offer_valid_until
    FROM supply_outreach_selections s
    JOIN market_maker_rfq_candidates c ON c.id=s.candidate_id
    LEFT JOIN supply_leads l ON l.id=c.supply_lead_id
    LEFT JOIN supply_outbox o ON o.selection_id=s.id
    LEFT JOIN supply_outreach_responses resp ON resp.selection_id=s.id
    WHERE ($1::bigint IS NULL OR s.rfq_id=$1)
    ORDER BY s.created_at DESC LIMIT $2`,[input.rfqId ?? null,limit]);
  return rows;
}
