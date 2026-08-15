import crypto from "node:crypto";
import type pg from "pg";
import { pool, withTransaction } from "./db.js";

type Json = Record<string, unknown>;

export type OutreachSender = (input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}) => Promise<{ providerReference: string }>;

function actorName(value?: string | null) {
  const explicit = String(value || "").trim();
  if (explicit) return explicit.slice(0,255);
  return String(process.env.ADMIN_EMAIL || "ecotracker-admin").slice(0,255);
}

function sha256(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function money(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function brl(value: unknown) {
  return new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(money(value));
}

function tonnes(value: unknown) {
  return new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(money(value));
}

function liveOutreachAcknowledged() {
  return process.env.ECOT_COMMERCIAL_OUTREACH_ENABLED === "true"
    && process.env.ECOT_COMMERCIAL_OUTREACH_ACK === "ENABLE_LIVE_COMMERCIAL_EMAILS";
}

async function proposalBundle(client: pg.PoolClient | typeof pool, proposalId:number, lock=false) {
  const proposalResult = await client.query(`
    SELECT p.*,a.company_name,a.legal_name,a.tax_id,a.sector,a.contact_name,a.contact_email,a.contact_phone,
           o.claim_purpose,o.target_year,o.target_basis,o.status AS opportunity_status
    FROM demand_proposals p
    JOIN demand_accounts a ON a.id=p.account_id
    JOIN demand_opportunities o ON o.id=p.opportunity_id
    WHERE p.id=$1
    ${lock ? "FOR UPDATE OF p,a,o" : ""}`, [proposalId]);
  const proposal = proposalResult.rows[0];
  if (!proposal) return null;
  const items = (await client.query(`
    SELECT pi.id,pi.asset_id,pi.registry,pi.project_name,pi.vintage,pi.amount_tonnes,pi.source_price_usd_tonne,
           pi.source_cost_brl,pi.indicative_sale_brl,pi.execution_mode,pi.retirement_supported,pi.evidence_url,pi.item_snapshot,
           ma.id AS current_asset_id,ma.active AS current_active,ma.claim_category AS current_claim_category,
           ma.eligibility_status AS current_eligibility_status,ma.source_unit_status AS current_source_unit_status,
           ma.availability_status AS current_availability_status,ma.retirement_supported AS current_retirement_supported,
           ma.available_tons AS current_available_tons,ma.commercial_valid_until AS current_commercial_valid_until,
           ma.offer_expires_at AS current_offer_expires_at
    FROM demand_proposal_items pi
    LEFT JOIN monitored_assets ma ON ma.id=pi.asset_id
    WHERE pi.proposal_id=$1 ORDER BY pi.id`, [proposalId])).rows;
  return { proposal,items };
}

function currentProposalProblems(bundle:{proposal:Json;items:Json[]}) {
  const problems:string[]=[];
  const p=bundle.proposal;
  if (String(p.opportunity_status||"")==="sourcing_required") problems.push("oportunidade voltou para sourcing_required");
  for (const item of bundle.items) {
    const label=`ativo #${item.asset_id} (${String(item.project_name||item.registry||"lote")})`;
    if (!item.current_asset_id) { problems.push(`${label}: ativo monitorado não existe mais`); continue; }
    if (item.current_active!==true) problems.push(`${label}: ativo inativo`);
    if (String(item.current_claim_category)!=="voluntary_offset") problems.push(`${label}: claim atual não é voluntary_offset`);
    if (String(item.current_eligibility_status)!=="eligible") problems.push(`${label}: elegibilidade atual não é eligible`);
    if (String(item.current_source_unit_status)!=="tradable") problems.push(`${label}: unidade atual não está tradable`);
    if (!["confirmed","indicative"].includes(String(item.current_availability_status))) problems.push(`${label}: disponibilidade atual não é confirmed/indicative`);
    if (item.current_retirement_supported!==true) problems.push(`${label}: retirement não está confirmado`);
    if (money(item.current_available_tons)+0.0005 < money(item.amount_tonnes)) problems.push(`${label}: volume atual insuficiente`);
    if (item.current_commercial_valid_until && new Date(String(item.current_commercial_valid_until)).getTime()<Date.now()-86_400_000) problems.push(`${label}: validade comercial expirada`);
    if (item.current_offer_expires_at && new Date(String(item.current_offer_expires_at)).getTime()<=Date.now()) problems.push(`${label}: oferta da fonte expirada`);
  }
  return problems;
}

function assertCurrentProposal(bundle:{proposal:Json;items:Json[]}) {
  const problems=currentProposalProblems(bundle);
  if (problems.length) {
    throw Object.assign(new Error("Proposta obsoleta: o supply atual não sustenta mais o snapshot. Refaça o matching antes de aprovar."),{
      status:409,code:"STALE_PROPOSAL_REQUIRES_REMATCH",problems,
    });
  }
}

function freezeSnapshot(bundle:{proposal:Json;items:Json[]}) {
  const p = bundle.proposal;
  return {
    version:"ecotracker-commercial-proposal-v1",
    proposalId:Number(p.id),
    proposalPublicCode:p.public_code,
    accountId:Number(p.account_id),
    opportunityId:Number(p.opportunity_id),
    company:{
      name:p.company_name,
      legalName:p.legal_name,
      taxId:p.tax_id,
      sector:p.sector,
      contactName:p.contact_name,
      contactEmail:p.contact_email,
      contactPhone:p.contact_phone,
    },
    climate:{
      claimPurpose:p.claim_purpose,
      targetYear:p.target_year,
      targetBasis:p.target_basis,
      targetTonnes:money(p.target_tonnes),
      coveredTonnes:money(p.covered_tonnes),
      uncoveredTonnes:money(p.uncovered_tonnes),
      coveragePct:money(p.coverage_pct),
    },
    commercial:{
      sourceCostBrl:money(p.source_cost_brl),
      finalTotalBrl:money(p.final_total_brl),
      pricePerTonneBrl:money(p.price_per_tonne_brl),
      checkoutMode:p.checkout_mode,
      executionMode:p.execution_mode,
      expiresAt:p.expires_at,
    },
    items:bundle.items.map((item) => ({
      assetId:Number(item.asset_id),registry:item.registry,projectName:item.project_name,vintage:item.vintage,
      amountTonnes:money(item.amount_tonnes),sourcePriceUsdTonne:money(item.source_price_usd_tonne),
      sourceCostBrl:money(item.source_cost_brl),indicativeSaleBrl:money(item.indicative_sale_brl),
      executionMode:item.execution_mode,retirementSupported:Boolean(item.retirement_supported),evidenceUrl:item.evidence_url,
    })),
    disclosure:"O inventário corporativo de emissões permanece reportado separadamente. A compensação só é concluída após aposentadoria exclusiva dos créditos para o beneficiário, com evidência registral.",
    frozenAt:new Date().toISOString(),
  };
}

async function event(client:pg.PoolClient,input:{
  proposalId:number;reviewId?:number|null;outboxId?:number|null;eventType:string;actor?:string|null;payload?:Json;
}) {
  await client.query(`
    INSERT INTO demand_outreach_events(proposal_id,review_id,outbox_id,event_type,actor,payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
    input.proposalId,input.reviewId ?? null,input.outboxId ?? null,input.eventType,input.actor ?? null,JSON.stringify(input.payload || {}),
  ]);
}

export async function commercialOutreachStatus() {
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM demand_proposal_reviews WHERE status='approved') AS approved,
      (SELECT COUNT(*)::int FROM demand_outbox WHERE status='ready') AS ready,
      (SELECT COUNT(*)::int FROM demand_outbox WHERE status='sent') AS sent,
      (SELECT COUNT(*)::int FROM demand_outbox WHERE status='failed') AS failed`);
  return {
    envEnabled:process.env.ECOT_COMMERCIAL_OUTREACH_ENABLED === "true",
    acknowledgementValid:process.env.ECOT_COMMERCIAL_OUTREACH_ACK === "ENABLE_LIVE_COMMERCIAL_EMAILS",
    live:liveOutreachAcknowledged(),
    provider:"resend",
    configured:Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
    counts:counts.rows[0] || {approved:0,ready:0,sent:0,failed:0},
    behavior:{humanApprovalRequired:true,explicitDispatchRequired:true,opensCheckout:false,reservesInventory:false,chargesMoney:false},
  };
}

export async function approveDemandProposal(input:{proposalId:number;reviewedBy?:string|null;note?:string|null}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM demand_proposal_reviews WHERE proposal_id=$1 FOR UPDATE`,[input.proposalId])).rows[0];
    if (existing) {
      if (existing.status==="approved") return existing;
      throw Object.assign(new Error("Esta proposta já possui uma decisão comercial; gere uma nova proposta para nova revisão"),{status:409});
    }
    const bundle = await proposalBundle(client,input.proposalId,true);
    if (!bundle) throw Object.assign(new Error("Proposta não encontrada"),{status:404});
    const p = bundle.proposal;
    if (String(p.status)!=="draft") throw Object.assign(new Error("Apenas propostas draft podem ser aprovadas comercialmente"),{status:409});
    if (p.expires_at && new Date(String(p.expires_at)).getTime()<=Date.now()) {
      throw Object.assign(new Error("A proposta expirou e precisa ser recalculada"),{status:409});
    }
    if (money(p.coverage_pct)<99.99 || money(p.uncovered_tonnes)>0.001) {
      throw Object.assign(new Error("Aprovação exige cobertura integral da proposta"),{status:409});
    }
    if (money(p.final_total_brl)<=0) throw Object.assign(new Error("A proposta não possui preço comercial válido"),{status:409});
    if (!bundle.items.length) throw Object.assign(new Error("A proposta não possui lotes"),{status:409});
    if (!bundle.items.every((item) => Boolean(item.retirement_supported))) {
      throw Object.assign(new Error("Todos os lotes precisam suportar retirement antes da aprovação"),{status:409});
    }
    assertCurrentProposal(bundle);
    const snapshot = freezeSnapshot(bundle);
    const snapshotHash = sha256(snapshot);
    const actor = actorName(input.reviewedBy);
    const review = (await client.query(`
      INSERT INTO demand_proposal_reviews(
        proposal_id,status,reviewed_by,review_note,snapshot,snapshot_sha256,approved_at
      ) VALUES($1,'approved',$2,$3,$4::jsonb,$5,NOW()) RETURNING *`, [
      input.proposalId,actor,input.note || null,JSON.stringify(snapshot),snapshotHash,
    ])).rows[0];
    await event(client,{proposalId:input.proposalId,reviewId:Number(review.id),eventType:"proposal_approved",actor,payload:{snapshotSha256:snapshotHash}});
    return review;
  });
}

export async function rejectDemandProposal(input:{proposalId:number;reviewedBy?:string|null;reason:string}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM demand_proposal_reviews WHERE proposal_id=$1 FOR UPDATE`,[input.proposalId])).rows[0];
    if (existing) throw Object.assign(new Error("Esta proposta já possui uma decisão comercial"),{status:409});
    const bundle = await proposalBundle(client,input.proposalId,true);
    if (!bundle) throw Object.assign(new Error("Proposta não encontrada"),{status:404});
    if (!["draft","partial"].includes(String(bundle.proposal.status))) {
      throw Object.assign(new Error("Proposta não está disponível para revisão"),{status:409});
    }
    const actor = actorName(input.reviewedBy);
    const review = (await client.query(`
      INSERT INTO demand_proposal_reviews(proposal_id,status,reviewed_by,rejection_reason,rejected_at)
      VALUES($1,'rejected',$2,$3,NOW()) RETURNING *`, [input.proposalId,actor,input.reason])).rows[0];
    await client.query(`UPDATE demand_proposals SET status='rejected',updated_at=NOW() WHERE id=$1`,[input.proposalId]);
    await event(client,{proposalId:input.proposalId,reviewId:Number(review.id),eventType:"proposal_rejected",actor,payload:{reason:input.reason}});
    return review;
  });
}

export async function getDemandProposalReview(proposalId:number) {
  const { rows } = await pool.query(`
    SELECT r.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'eventType',e.event_type,'actor',e.actor,'payload',e.payload,'createdAt',e.created_at
      ) ORDER BY e.id) FROM demand_outreach_events e WHERE e.proposal_id=r.proposal_id),'[]'::jsonb) AS events
    FROM demand_proposal_reviews r WHERE r.proposal_id=$1`,[proposalId]);
  return rows[0] || null;
}

function proposalPublicUrl(publicCode:string) {
  const base = String(process.env.PUBLIC_API_URL || "https://ecotracker-api-cik7.onrender.com").replace(/\/$/,"");
  return `${base}/api/demand/proposals/${encodeURIComponent(publicCode)}`;
}

function buildEmail(snapshot:Json,recipientName?:string|null) {
  const company = (snapshot.company || {}) as Json;
  const climate = (snapshot.climate || {}) as Json;
  const commercial = (snapshot.commercial || {}) as Json;
  const items = Array.isArray(snapshot.items) ? snapshot.items as Json[] : [];
  const name = String(recipientName || company.contactName || company.name || "Olá");
  const target = tonnes(climate.targetTonnes);
  const proposalUrl = proposalPublicUrl(String(snapshot.proposalPublicCode || ""));
  const subject = `EcoTracker — proposta de compensação rastreável de ${target} tCO₂e`;
  const lotLines = items.map((item,index) => `${index+1}. ${item.registry} — ${item.projectName} — vintage ${item.vintage || "n/d"} — ${tonnes(item.amountTonnes)} tCO₂e`).join("\n");
  const text = `${name},\n\nPreparamos uma proposta EcoTracker para ${target} tCO₂e, com cobertura de ${tonnes(climate.coveragePct)}% e valor total de ${brl(commercial.finalTotalBrl)}.\n\nLotes selecionados:\n${lotLines}\n\nA compensação só é concluída após a aposentadoria exclusiva dos créditos em nome do beneficiário, com evidência registral. O inventário corporativo de emissões permanece reportado separadamente.\n\nProposta: ${proposalUrl}\n\nEcoTracker — Alternative Ventures Ltda.`;
  const lotsHtml = items.map((item) => `<li><strong>${htmlEscape(item.registry)}</strong> — ${htmlEscape(item.projectName)} — vintage ${htmlEscape(item.vintage || "n/d")} — ${htmlEscape(tonnes(item.amountTonnes))} tCO₂e</li>`).join("");
  const html = `<p>${htmlEscape(name)},</p><p>Preparamos uma proposta EcoTracker para <strong>${htmlEscape(target)} tCO₂e</strong>, com cobertura de <strong>${htmlEscape(tonnes(climate.coveragePct))}%</strong> e valor total de <strong>${htmlEscape(brl(commercial.finalTotalBrl))}</strong>.</p><p><strong>Lotes selecionados:</strong></p><ul>${lotsHtml}</ul><p>A compensação só é concluída após a aposentadoria exclusiva dos créditos em nome do beneficiário, com evidência registral. O inventário corporativo de emissões permanece reportado separadamente.</p><p><a href="${htmlEscape(proposalUrl)}">Consultar proposta EcoTracker</a></p><p>EcoTracker — Alternative Ventures Ltda.</p>`;
  return {subject,text,html};
}

export async function createDemandProposalOutbox(input:{proposalId:number;recipientEmail?:string|null;recipientName?:string|null;actor?:string|null}) {
  return withTransaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM demand_outbox WHERE proposal_id=$1 FOR UPDATE`,[input.proposalId])).rows[0];
    if (existing) return existing;
    const review = (await client.query(`SELECT * FROM demand_proposal_reviews WHERE proposal_id=$1 FOR UPDATE`,[input.proposalId])).rows[0];
    if (!review || review.status!=="approved") throw Object.assign(new Error("A proposta precisa de aprovação comercial antes do outbox"),{status:409});
    const currentBundle = await proposalBundle(client,input.proposalId,true);
    if (!currentBundle) throw Object.assign(new Error("Proposta não encontrada"),{status:404});
    assertCurrentProposal(currentBundle);
    const snapshot = review.snapshot as Json;
    const company = (snapshot.company || {}) as Json;
    const email = String(input.recipientEmail || company.contactEmail || "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw Object.assign(new Error("Contato corporativo não possui e-mail válido"),{status:409});
    const recipientName = String(input.recipientName || company.contactName || company.name || "").trim() || null;
    const content = buildEmail(snapshot,recipientName);
    const publicCode = crypto.randomUUID();
    const idempotencyKey = `ecotracker-proposal/${publicCode}`;
    const outbox = (await client.query(`
      INSERT INTO demand_outbox(
        public_code,proposal_id,review_id,recipient_email,recipient_name,subject,text_body,html_body,status,provider,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready','resend',$9) RETURNING *`, [
      publicCode,input.proposalId,review.id,email,recipientName,content.subject,content.text,content.html,idempotencyKey,
    ])).rows[0];
    await event(client,{proposalId:input.proposalId,reviewId:Number(review.id),outboxId:Number(outbox.id),eventType:"outbox_created",actor:actorName(input.actor),payload:{recipientEmail:email,idempotencyKey}});
    return outbox;
  });
}

async function sendViaResend(input:Parameters<OutreachSender>[0]) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(input.from || process.env.EMAIL_FROM || "").trim();
  if (!apiKey || !from) throw new Error("RESEND_API_KEY e EMAIL_FROM são obrigatórios para dispatch");
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

export async function dispatchDemandOutbox(
  outboxId:number,
  options:{sender?:OutreachSender;testBypassGate?:boolean;actor?:string|null} = {},
) {
  const testBypass = process.env.NODE_ENV==="test" && options.testBypassGate===true && Boolean(options.sender);
  if (!liveOutreachAcknowledged() && !testBypass) {
    throw Object.assign(new Error("Commercial outreach está desligado neste deployment"),{status:409});
  }
  const sender = options.sender || sendViaResend;
  return withTransaction(async (client) => {
    const row = (await client.query(`
      SELECT o.*,r.status AS review_status,r.snapshot_sha256,p.status AS proposal_status,p.expires_at
      FROM demand_outbox o
      JOIN demand_proposal_reviews r ON r.id=o.review_id
      JOIN demand_proposals p ON p.id=o.proposal_id
      WHERE o.id=$1 FOR UPDATE OF o,r,p`,[outboxId])).rows[0];
    if (!row) throw Object.assign(new Error("Outbox não encontrado"),{status:404});
    if (row.status==="sent") return {alreadySent:true,outbox:row};
    if (row.status==="cancelled") throw Object.assign(new Error("Outbox cancelado"),{status:409});
    if (row.review_status!=="approved") throw Object.assign(new Error("A aprovação comercial não está válida"),{status:409});
    if (row.expires_at && new Date(row.expires_at).getTime()<=Date.now()) throw Object.assign(new Error("A proposta expirou antes do envio"),{status:409});
    if (row.proposal_status!=="draft" && row.proposal_status!=="sent") throw Object.assign(new Error("Status da proposta não permite envio"),{status:409});

    const currentBundle = await proposalBundle(client,Number(row.proposal_id),true);
    if (!currentBundle) throw Object.assign(new Error("Proposta não encontrada"),{status:404});
    assertCurrentProposal(currentBundle);

    await client.query(`UPDATE demand_outbox SET status='sending',attempts=attempts+1,last_error=NULL,updated_at=NOW() WHERE id=$1`,[outboxId]);
    try {
      const result = await sender({
        from:String(process.env.EMAIL_FROM || "EcoTracker <noreply@ecotracker.invalid>"),
        to:row.recipient_email,
        subject:row.subject,
        text:row.text_body,
        html:row.html_body,
        idempotencyKey:row.idempotency_key,
      });
      const sent = (await client.query(`
        UPDATE demand_outbox SET status='sent',provider_reference=$2,sent_at=NOW(),updated_at=NOW()
        WHERE id=$1 RETURNING *`,[outboxId,result.providerReference])).rows[0];
      await client.query(`UPDATE demand_proposals SET status='sent',updated_at=NOW() WHERE id=$1`,[row.proposal_id]);
      await event(client,{proposalId:Number(row.proposal_id),reviewId:Number(row.review_id),outboxId,eventType:"outbox_sent",actor:actorName(options.actor),payload:{provider:"resend",providerReference:result.providerReference,idempotencyKey:row.idempotency_key}});
      return {alreadySent:false,outbox:sent};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = (await client.query(`
        UPDATE demand_outbox SET status='failed',last_error=$2,updated_at=NOW()
        WHERE id=$1 RETURNING *`,[outboxId,message.slice(0,5000)])).rows[0];
      await event(client,{proposalId:Number(row.proposal_id),reviewId:Number(row.review_id),outboxId,eventType:"outbox_failed",actor:actorName(options.actor),payload:{error:message}});
      return {alreadySent:false,failed:true,error:message,outbox:failed};
    }
  });
}

export async function cancelDemandOutbox(input:{outboxId:number;actor?:string|null;reason?:string|null}) {
  return withTransaction(async (client) => {
    const row = (await client.query(`SELECT * FROM demand_outbox WHERE id=$1 FOR UPDATE`,[input.outboxId])).rows[0];
    if (!row) throw Object.assign(new Error("Outbox não encontrado"),{status:404});
    if (row.status==="sent") throw Object.assign(new Error("E-mail já enviado não pode ser cancelado"),{status:409});
    if (row.status==="cancelled") return row;
    const cancelled = (await client.query(`
      UPDATE demand_outbox SET status='cancelled',cancelled_at=NOW(),last_error=$2,updated_at=NOW()
      WHERE id=$1 RETURNING *`,[row.id,input.reason || null])).rows[0];
    await event(client,{proposalId:Number(row.proposal_id),reviewId:Number(row.review_id),outboxId:Number(row.id),eventType:"outbox_cancelled",actor:actorName(input.actor),payload:{reason:input.reason || null}});
    return cancelled;
  });
}

export async function listDemandOutbox(input:{status?:string;limit?:number}={}) {
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const status = String(input.status || "").trim();
  const { rows } = await pool.query(`
    SELECT o.*,p.public_code AS proposal_public_code,p.status AS proposal_status,
           a.company_name,a.contact_name,a.contact_email,r.snapshot_sha256,r.reviewed_by,r.approved_at
    FROM demand_outbox o
    JOIN demand_proposals p ON p.id=o.proposal_id
    JOIN demand_accounts a ON a.id=p.account_id
    JOIN demand_proposal_reviews r ON r.id=o.review_id
    WHERE ($1='' OR o.status=$1)
    ORDER BY CASE o.status WHEN 'ready' THEN 1 WHEN 'failed' THEN 2 WHEN 'sending' THEN 3 ELSE 4 END,o.created_at DESC
    LIMIT $2`,[status,limit]);
  return rows;
}
