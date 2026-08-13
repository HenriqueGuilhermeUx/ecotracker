import crypto from "node:crypto";
import type { Application, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";

type Json = Record<string, unknown>;

const fail = (res: Response, error: unknown) => {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 500;
  return res.status(Number.isFinite(status) && status >= 400 && status <= 599 ? status : 500)
    .json({ error: error instanceof Error ? error.message : "Erro interno" });
};

const objectAt = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const num = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const esc = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const sha = (value: unknown) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const brl = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const tonnes = (kg: unknown) => (Number(kg || 0) / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 3 });

function providerIdentity() {
  const identity = {
    legalName: String(process.env.ECOT_LEGAL_NAME || "").trim(),
    taxId: String(process.env.ECOT_LEGAL_TAX_ID || "").trim(),
    address: String(process.env.ECOT_LEGAL_ADDRESS || "").trim(),
    email: String(process.env.ECOT_LEGAL_EMAIL || "").trim(),
    forumCity: String(process.env.ECOT_CONTRACT_FORUM_CITY || "").trim(),
    forumState: String(process.env.ECOT_CONTRACT_FORUM_STATE || "").trim(),
  };
  const missing = Object.entries(identity).filter(([, value]) => !value).map(([key]) => key);
  return { ...identity, configured: missing.length === 0, missing };
}

function publicAppUrl() {
  return (process.env.PUBLIC_APP_URL || "https://ecotracker10.netlify.app").replace(/\/$/, "");
}

function reviewMatchesQuote(row: Json) {
  if (String(row.commercial_review_status || "") !== "approved") return false;
  const snapshot = objectAt(row.commercial_review_snapshot);
  const quote = objectAt(snapshot.quote);
  const sourcing = objectAt(snapshot.sourcing);
  const commercial = objectAt(snapshot.commercial);
  return Number(quote.id || 0) === Number(row.id || 0)
    && Number(quote.requestedKg || 0) === Number(row.requested_kg || 0)
    && Number(commercial.sourceCostBrl || 0) === Number(row.source_cost_brl || 0)
    && Number(commercial.finalTotalBrl || 0) === Number(row.final_total || 0)
    && String(sourcing.status || "") === String(row.sourcing_status || "")
    && String(sourcing.confirmedReference || "") === String(row.sourcing_reference || "");
}

function agreementFingerprint(row: Json) {
  const pricing = objectAt(row.pricing_snapshot);
  return sha({
    version: "ecotracker-client-agreement-fingerprint-v1",
    quoteId: Number(row.id || 0),
    quotePublicCode: String(row.public_code || ""),
    requestedKg: Number(row.requested_kg || 0),
    purpose: String(row.purpose || "voluntary_offset"),
    finalTotalBrl: num(row.final_total),
    sourceCostBrl: num(row.source_cost_brl),
    quoteExpiresAt: row.quote_expires_at || null,
    sourcingStatus: row.sourcing_status || null,
    sourcingProvider: row.sourcing_provider || null,
    sourcingReference: row.sourcing_reference || null,
    sourceAvailableKg: num(pricing.sourceAvailableKg),
    sourceEvidenceUrl: pricing.sourceEvidenceUrl || null,
    registry: row.registry || null,
    projectName: row.project_name || null,
    vintage: row.vintage || null,
    assetSourceReference: row.asset_source_reference || null,
    commercialReviewSha256: row.commercial_review_sha256 || null,
  });
}

function agreementCurrent(row: Json, agreement: Json | null | undefined) {
  if (!agreement || !["awaiting_signature", "accepted"].includes(String(agreement.status || ""))) return false;
  if (!reviewMatchesQuote(row)) return false;
  return String(agreement.quote_snapshot_sha256 || "") === agreementFingerprint(row)
    && String(agreement.commercial_review_sha256 || "") === String(row.commercial_review_sha256 || "");
}

async function loadQuote(quoteId: number) {
  const { rows } = await pool.query(`
    SELECT q.*,a.registry,a.project_name,a.vintage,a.source_reference AS asset_source_reference,
           a.source_url,a.registry_evidence_url,a.methodology,a.location,
           r.status AS commercial_review_status,r.snapshot AS commercial_review_snapshot,
           r.snapshot_sha256 AS commercial_review_sha256,r.reviewed_by AS commercial_reviewed_by,
           r.approved_at AS commercial_reviewed_at
    FROM quote_requests q
    JOIN monitored_assets a ON a.id=q.asset_id
    LEFT JOIN assisted_quote_reviews r ON r.quote_id=q.id
    WHERE q.id=$1`, [quoteId]);
  return rows[0] as Json | undefined;
}

async function latestAgreement(quoteId: number) {
  const { rows } = await pool.query("SELECT * FROM client_agreements WHERE quote_id=$1 ORDER BY version DESC LIMIT 1", [quoteId]);
  return rows[0] as Json | undefined;
}

function agreementSnapshot(row: Json, legal: ReturnType<typeof providerIdentity>, version: number) {
  const pricing = objectAt(row.pricing_snapshot);
  return {
    version: "ecotracker-client-agreement-snapshot-v1",
    agreementVersion: version,
    generatedAt: new Date().toISOString(),
    provider: legal,
    buyer: {
      companyName: row.company_name || row.buyer_name || null,
      taxId: row.tax_id || null,
      contactName: row.buyer_name || null,
      contactEmail: row.buyer_email || null,
    },
    operation: {
      requestedKg: Number(row.requested_kg || 0),
      tonnes: Number(row.requested_kg || 0) / 1000,
      purpose: row.purpose || "voluntary_offset",
      beneficiary: row.company_name || row.buyer_name || null,
      registry: row.registry || null,
      projectName: row.project_name || null,
      vintage: row.vintage || null,
      methodology: row.methodology || null,
      location: row.location || null,
      sourceReference: row.sourcing_reference || row.asset_source_reference || null,
      sourceEvidenceUrl: pricing.sourceEvidenceUrl || row.registry_evidence_url || row.source_url || null,
      confirmedAvailableKg: num(pricing.sourceAvailableKg),
    },
    commercial: {
      sourceCostBrl: num(row.source_cost_brl),
      finalTotalBrl: num(row.final_total),
      pricePerTonneBrl: Number(row.requested_kg || 0) > 0 ? Number((Number(row.final_total || 0) / (Number(row.requested_kg) / 1000)).toFixed(6)) : null,
      quoteExpiresAt: row.quote_expires_at || null,
    },
    audit: {
      quoteId: Number(row.id || 0),
      quotePublicCode: row.public_code || null,
      commercialReviewSha256: row.commercial_review_sha256 || null,
      quoteSnapshotSha256: agreementFingerprint(row),
    },
  };
}

function buildAgreementHtml(snapshot: Json, draft: boolean) {
  const provider = objectAt(snapshot.provider);
  const buyer = objectAt(snapshot.buyer);
  const op = objectAt(snapshot.operation);
  const commercial = objectAt(snapshot.commercial);
  const audit = objectAt(snapshot.audit);
  const purpose = String(op.purpose || "voluntary_offset") === "voluntary_offset" ? "compensação voluntária" : String(op.purpose || "uso declarado");
  const forum = provider.forumCity && provider.forumState ? `${provider.forumCity}/${provider.forumState}` : "[FORO A DEFINIR]";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contrato EcoTracker</title><style>
  body{font-family:Arial,Helvetica,sans-serif;color:#17211d;background:#f4f7f5;margin:0}.page{max-width:900px;margin:28px auto;background:white;padding:54px;box-shadow:0 8px 30px #0001}.draft{padding:12px 16px;background:#fff3cd;border:1px solid #e7c86b;font-weight:700;margin-bottom:24px}.eyebrow{font-size:12px;letter-spacing:.12em;color:#34775a;font-weight:700}.meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}.box{border:1px solid #dce7e1;padding:14px;border-radius:8px}h1{font-size:28px}h2{font-size:17px;margin-top:28px}.terms{line-height:1.55;font-size:14px}.audit{font-family:monospace;font-size:11px;overflow-wrap:anywhere;background:#f6f8f7;padding:12px;border-radius:8px}@media print{body{background:white}.page{box-shadow:none;margin:0;max-width:none;padding:25mm}.no-print{display:none}}</style></head><body><main class="page">
  ${draft ? '<div class="draft">RASCUNHO — identidade jurídica da CONTRATADA ainda não está completamente configurada. Não assinar nem usar para cobrança.</div>' : ''}
  <div class="eyebrow">ECOTRACKER · CLIENT AGREEMENT</div><h1>Contrato de Aquisição e Aposentadoria de Créditos de Carbono</h1>
  <p class="terms">Por este instrumento, as partes abaixo identificadas celebram contrato empresarial para aquisição, aposentadoria e entrega de evidências de créditos de carbono, conforme as condições a seguir.</p>
  <h2>1. Partes</h2><div class="meta"><div class="box"><b>CONTRATADA</b><br>${esc(provider.legalName || "[RAZÃO SOCIAL]")}<br>CNPJ/ID: ${esc(provider.taxId || "[CNPJ]")}<br>${esc(provider.address || "[ENDEREÇO]")}<br>${esc(provider.email || "[E-MAIL]")}</div><div class="box"><b>CONTRATANTE</b><br>${esc(buyer.companyName || "[EMPRESA]")}<br>CNPJ/ID: ${esc(buyer.taxId || "não informado")}<br>Contato: ${esc(buyer.contactName || "não informado")}<br>${esc(buyer.contactEmail || "não informado")}</div></div>
  <h2>2. Objeto e especificação da operação</h2><div class="meta"><div class="box"><b>Volume</b><br>${esc(tonnes(op.requestedKg))} tCO₂e</div><div class="box"><b>Finalidade declarada</b><br>${esc(purpose)}</div><div class="box"><b>Registry</b><br>${esc(op.registry || "n/d")}</div><div class="box"><b>Vintage</b><br>${esc(op.vintage || "n/d")}</div></div>
  <p class="terms"><b>Projeto:</b> ${esc(op.projectName || "n/d")}<br><b>Metodologia:</b> ${esc(op.methodology || "n/d")}<br><b>Localização:</b> ${esc(op.location || "n/d")}<br><b>Beneficiário da aposentadoria:</b> ${esc(op.beneficiary || buyer.companyName || "n/d")}<br><b>Referência da fonte:</b> ${esc(op.sourceReference || "n/d")}</p>
  <h2>3. Preço, validade e pagamento</h2><p class="terms">O preço total desta operação é de <b>${esc(brl(commercial.finalTotalBrl))}</b>, equivalente a aproximadamente <b>${esc(brl(commercial.pricePerTonneBrl))}/tCO₂e</b>. A cotação é válida até ${esc(commercial.quoteExpiresAt || "o prazo indicado pela EcoTracker")}. Nenhuma aquisição ou aposentadoria será iniciada antes da confirmação do pagamento nos termos acordados.</p>
  <h2>4. Confirmação de fonte e indisponibilidade superveniente</h2><p class="terms">A fonte, o estoque e o custo foram confirmados para a geração deste instrumento. Se a fonte se tornar indisponível antes da aquisição definitiva, a CONTRATADA não substituirá projeto, registry, vintage ou características materiais sem aprovação expressa da CONTRATANTE. Na impossibilidade de execução sem substituição aceita, valores eventualmente recebidos e ainda não aplicados na aquisição serão restituídos, ressalvadas obrigações legais inderrogáveis.</p>
  <h2>5. Aquisição, aposentadoria e irreversibilidade</h2><p class="terms">Após o pagamento e a aquisição, a CONTRATADA providenciará a aposentadoria dos créditos em favor do beneficiário indicado e entregará as evidências disponíveis do registry, incluindo referência de aposentadoria, certificado, URL pública ou identificador equivalente. A aposentadoria concluída no registry é, por sua natureza, definitiva e não poderá ser revertida por mera desistência posterior.</p>
  <h2>6. Claims e uso ambiental</h2><p class="terms">A CONTRATANTE utilizará a operação somente para a finalidade declarada e de forma compatível com a documentação do registry e com a política de elegibilidade apresentada. Este contrato não constitui garantia de valorização financeira do ativo, autorização regulatória futura ou certificação de declarações ambientais além das expressamente documentadas.</p>
  <h2>7. Evidências e rastreabilidade</h2><p class="terms">A CONTRATADA manterá trilha de auditoria da operação, incluindo snapshots comerciais, referências da fonte e evidências de aposentadoria. O documento e seus dados críticos são vinculados a hashes SHA-256 para permitir detecção de alterações posteriores.</p>
  <h2>8. Obrigações da CONTRATANTE</h2><p class="terms">A CONTRATANTE declara que as informações de identificação, beneficiário, finalidade e representante são verdadeiras; que o representante possui poderes para contratar; e que revisará as informações do projeto antes do aceite. Alterações materiais solicitadas pela CONTRATANTE poderão exigir nova cotação e novo contrato.</p>
  <h2>9. Proteção de dados</h2><p class="terms">Os dados pessoais de representantes e contatos serão tratados para procedimentos preliminares, execução do contrato, cumprimento de obrigações legais e exercício regular de direitos, observada a legislação aplicável de proteção de dados. Serão coletados registros técnicos de aceite, como data/hora, endereço IP e user-agent, para segurança e prova da manifestação de vontade.</p>
  <h2>10. Aceite e assinatura eletrônica</h2><p class="terms">As partes reconhecem como válida a manifestação eletrônica de vontade vinculada a este documento, inclusive por meio eletrônico distinto de certificado ICP-Brasil quando admitido entre as partes e preservadas autoria e integridade. Quando utilizado provedor de assinatura eletrônica, prevalecerão também as evidências técnicas emitidas por esse provedor. Para operações que exijam nível adicional de executividade ou autenticação, poderá ser solicitada assinatura avançada ou qualificada.</p>
  <h2>11. Responsabilidade, boa-fé e força maior</h2><p class="terms">As partes atuarão de boa-fé e cooperarão para execução da operação. Cada parte responde por perdas diretas decorrentes de descumprimento que lhe seja imputável, sem exclusão de responsabilidades inderrogáveis por lei. Eventos comprovadamente fora do controle razoável das partes poderão suspender prazos pelo período necessário, sem autorizar alteração material do ativo sem novo consentimento.</p>
  <h2>12. Cancelamento</h2><p class="terms">Antes da aquisição definitiva dos créditos, eventual cancelamento seguirá as condições da cotação e os custos efetivamente incorridos e informados. Após aposentadoria concluída, não há cancelamento por conveniência, sem prejuízo de direitos decorrentes de defeito, fraude ou descumprimento comprovado.</p>
  <h2>13. Lei aplicável e foro</h2><p class="terms">Aplica-se a legislação brasileira. Fica eleito o foro de ${esc(forum)}, salvo hipótese de competência legal obrigatória diversa.</p>
  <h2>14. Integridade documental</h2><div class="audit">Quote: ${esc(audit.quotePublicCode)}<br>Commercial review SHA-256: ${esc(audit.commercialReviewSha256)}<br>Quote snapshot SHA-256: ${esc(audit.quoteSnapshotSha256)}</div>
  <p class="terms"><small>Template operacional EcoTracker v1.0. Recomenda-se revisão jurídica da versão final antes da primeira operação comercial em produção.</small></p>
  </main></body></html>`;
}

export function registerClientAgreementRoutes(app: Application) {
  app.post("/api/market/quotes/:publicCode/checkout", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.params.publicCode;
      const publicCode = Array.isArray(raw) ? raw[0] : raw;
      const { rows } = await pool.query("SELECT id,automation_enabled FROM quote_requests WHERE public_code=$1", [publicCode]);
      const base = rows[0];
      if (!base || base.automation_enabled !== false) return next();
      const row = await loadQuote(Number(base.id));
      if (!row) return res.status(404).json({ error: "Cotação não encontrada" });
      const latest = await latestAgreement(Number(row.id));
      if (!agreementCurrent(row, latest) || String(latest?.status || "") !== "accepted") {
        return res.status(409).json({ error: "O contrato do cliente precisa estar aceito e corresponder à cotação comercial vigente antes do checkout", code: "CLIENT_AGREEMENT_REQUIRED" });
      }
      return next();
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/admin/market/client-agreements/config", requireAdmin, (_req: Request, res: Response) => {
    const identity = providerIdentity();
    res.setHeader("Cache-Control", "no-store");
    return res.json({ configured: identity.configured, missing: identity.missing, identity: { ...identity, missing: undefined } });
  });

  app.get("/api/admin/market/assisted-sourcing/:id/agreement", requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await loadQuote(Number(req.params.id));
      if (!row) return res.status(404).json({ error: "Cotação não encontrada" });
      const latest = await latestAgreement(Number(row.id));
      res.setHeader("Cache-Control", "no-store");
      return res.json({ agreement: latest || null, current: agreementCurrent(row, latest), acceptedCurrent: agreementCurrent(row, latest) && String(latest?.status || "") === "accepted", shareUrl: latest ? `${publicAppUrl()}/#agreement/${latest.public_code}` : null, provider: providerIdentity() });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/market/assisted-sourcing/:id/agreement/generate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await loadQuote(Number(req.params.id));
      if (!row) return res.status(404).json({ error: "Cotação não encontrada" });
      if (row.automation_enabled !== false) return res.status(409).json({ error: "Este gate foi criado para cotações de sourcing assistido" });
      if (String(row.sourcing_status || "") !== "manual_source_confirmed") return res.status(409).json({ error: "Confirme fonte, estoque e custo antes de gerar o contrato" });
      if (String(row.status || "") !== "quoted") return res.status(409).json({ error: "A cotação precisa estar em estado quoted" });
      if (String(row.payment_status || "not_started") !== "not_started") return res.status(409).json({ error: "Não é permitido gerar nova versão depois que o pagamento começou" });
      if (row.quote_expires_at && new Date(String(row.quote_expires_at)).getTime() <= Date.now()) return res.status(409).json({ error: "A cotação expirou; reconfirme a fonte" });
      if (!reviewMatchesQuote(row)) return res.status(409).json({ error: "A aprovação comercial pós-sourcing está ausente ou desatualizada" });

      const existing = await latestAgreement(Number(row.id));
      if (existing && agreementCurrent(row, existing) && ["awaiting_signature", "accepted"].includes(String(existing.status))) {
        return res.json({ agreement: existing, current: true, shareUrl: `${publicAppUrl()}/#agreement/${existing.public_code}`, provider: providerIdentity(), reused: true });
      }

      const versionResult = await pool.query("SELECT COALESCE(MAX(version),0)+1 AS version FROM client_agreements WHERE quote_id=$1", [row.id]);
      const version = Number(versionResult.rows[0].version || 1);
      const legal = providerIdentity();
      const snapshot = agreementSnapshot(row, legal, version);
      const snapshotSha = sha(snapshot);
      const documentHtml = buildAgreementHtml(snapshot, !legal.configured);
      const documentSha = sha(documentHtml);
      const status = legal.configured ? "awaiting_signature" : "draft";

      await pool.query(`UPDATE client_agreements SET status='superseded',superseded_at=NOW(),superseded_reason='new_agreement_version',updated_at=NOW() WHERE quote_id=$1 AND status IN ('draft','awaiting_signature','accepted')`, [row.id]);
      const { rows } = await pool.query(`
        INSERT INTO client_agreements(quote_id,version,status,language,agreement_type,template_version,commercial_review_sha256,
          quote_snapshot_sha256,snapshot,snapshot_sha256,document_html,document_sha256,provider_identity,generated_by)
        VALUES($1,$2,$3,'pt-BR','carbon_credit_purchase_retirement','ecotracker-client-agreement-v1',$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11)
        RETURNING *`, [row.id, version, status, row.commercial_review_sha256, agreementFingerprint(row), JSON.stringify(snapshot), snapshotSha, documentHtml, documentSha, JSON.stringify(legal), process.env.ADMIN_EMAIL || "ecotracker-admin"]);
      const agreement = rows[0];
      return res.status(201).json({ agreement, current: true, acceptanceEnabled: legal.configured, shareUrl: `${publicAppUrl()}/#agreement/${agreement.public_code}`, provider: legal, message: legal.configured ? "Contrato gerado e pronto para aceite do cliente. Checkout continua bloqueado até o aceite." : "Rascunho gerado. Configure a identidade jurídica da EcoTracker antes de enviar para aceite." });
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/market/agreements/:publicCode", async (req: Request, res: Response) => {
    try {
      const raw = req.params.publicCode;
      const publicCode = Array.isArray(raw) ? raw[0] : raw;
      const { rows } = await pool.query("SELECT * FROM client_agreements WHERE public_code=$1", [publicCode]);
      const agreement = rows[0] as Json | undefined;
      if (!agreement) return res.status(404).json({ error: "Contrato não encontrado" });
      const row = await loadQuote(Number(agreement.quote_id));
      if (!row) return res.status(404).json({ error: "Cotação vinculada não encontrada" });
      const current = agreementCurrent(row, agreement);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ publicCode: agreement.public_code, version: agreement.version, status: current ? agreement.status : "superseded", current, acceptanceEnabled: current && String(agreement.status) === "awaiting_signature" && providerIdentity().configured, acceptedAt: agreement.accepted_at, acceptedByName: agreement.accepted_by_name, documentSha256: agreement.document_sha256, snapshotSha256: agreement.snapshot_sha256, documentHtml: agreement.document_html });
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/market/agreements/:publicCode/document", async (req: Request, res: Response) => {
    try {
      const raw = req.params.publicCode;
      const publicCode = Array.isArray(raw) ? raw[0] : raw;
      const { rows } = await pool.query("SELECT document_html FROM client_agreements WHERE public_code=$1", [publicCode]);
      if (!rows[0]) return res.status(404).send("Contrato não encontrado");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(rows[0].document_html);
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/market/agreements/:publicCode/accept", async (req: Request, res: Response) => {
    const parsed = z.object({ representativeName: z.string().min(2).max(255), representativeEmail: z.string().email(), representativeTitle: z.string().max(255).nullable().optional(), authorityConfirmed: z.literal(true), termsAccepted: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados de aceite inválidos", details: parsed.error.flatten() });
    try {
      const raw = req.params.publicCode;
      const publicCode = Array.isArray(raw) ? raw[0] : raw;
      const { rows } = await pool.query("SELECT * FROM client_agreements WHERE public_code=$1", [publicCode]);
      const agreement = rows[0] as Json | undefined;
      if (!agreement) return res.status(404).json({ error: "Contrato não encontrado" });
      if (String(agreement.status) === "accepted") return res.json({ alreadyAccepted: true, status: "accepted", acceptedAt: agreement.accepted_at });
      if (String(agreement.status) !== "awaiting_signature") return res.status(409).json({ error: "Este contrato não está aberto para aceite" });
      if (!providerIdentity().configured) return res.status(409).json({ error: "Identidade jurídica da CONTRATADA ainda não está configurada" });
      const row = await loadQuote(Number(agreement.quote_id));
      if (!row || !agreementCurrent(row, agreement)) return res.status(409).json({ error: "A cotação mudou; este contrato precisa ser substituído", code: "AGREEMENT_SUPERSEDED" });
      if (String(row.payment_status || "not_started") !== "not_started") return res.status(409).json({ error: "O pagamento já começou e este aceite não pode ser alterado" });
      if (row.quote_expires_at && new Date(String(row.quote_expires_at)).getTime() <= Date.now()) return res.status(409).json({ error: "A cotação expirou; solicite um novo contrato" });

      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const userAgent = String(req.headers["user-agent"] || "").slice(0, 1000);
      const acceptedAt = new Date().toISOString();
      const evidence = { method: "electronic_acceptance_v1", acceptedAt, representativeName: parsed.data.representativeName, representativeEmail: parsed.data.representativeEmail, representativeTitle: parsed.data.representativeTitle || null, authorityConfirmed: true, termsAccepted: true, documentSha256: agreement.document_sha256, snapshotSha256: agreement.snapshot_sha256, ip, userAgent };
      const evidenceSha256 = sha(evidence);
      const updated = await pool.query(`UPDATE client_agreements SET status='accepted',accepted_at=$2,accepted_by_name=$3,accepted_by_email=$4,
        accepted_by_title=$5,acceptance_ip=$6,acceptance_user_agent=$7,acceptance_evidence=$8::jsonb,acceptance_sha256=$9,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [agreement.id, acceptedAt, parsed.data.representativeName, parsed.data.representativeEmail, parsed.data.representativeTitle || null, ip || null, userAgent || null, JSON.stringify(evidence), evidenceSha256]);
      await pool.query(`INSERT INTO commerce_events(event_key,quote_id,event_type,provider,payload) VALUES($1,$2,'client_agreement.accepted','ecotracker',$3::jsonb) ON CONFLICT(event_key) DO NOTHING`, [`client-agreement:${agreement.id}:accepted`, agreement.quote_id, JSON.stringify({ agreementId: agreement.id, agreementPublicCode: agreement.public_code, documentSha256: agreement.document_sha256, evidenceSha256 })]);
      return res.json({ status: "accepted", acceptedAt, acceptedByName: parsed.data.representativeName, documentSha256: agreement.document_sha256, acceptanceSha256: evidenceSha256, checkoutEligible: true, message: "Contrato aceito. O pagamento ainda depende de ação explícita no fluxo comercial.", agreement: updated.rows[0] });
    } catch (error) { return fail(res, error); }
  });
}
