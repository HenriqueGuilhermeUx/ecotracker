import crypto from "node:crypto";
import type express from "express";
import { z } from "zod";
import { pool, withTransaction } from "./db.js";

const deletionSchema = z.object({
  email: z.string().trim().email().max(320),
  quoteCode: z.union([z.string().uuid(), z.literal("")]).optional(),
});

function hashEmail(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function deletedAlias(hash: string): string {
  return `deleted+${hash.slice(0, 20)}@privacy.invalid`;
}

export function registerPrivacyRoutes(app: express.Application): void {
  app.post("/api/privacy/deletion-requests", async (req, res) => {
    const parsed = deletionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Informe um e-mail válido e, se disponível, um código de cotação válido." });

    const email = parsed.data.email.trim().toLowerCase();
    const quoteCode = parsed.data.quoteCode || null;
    const emailHash = hashEmail(email);

    try {
      if (!quoteCode) {
        const { rows } = await pool.query(
          `INSERT INTO privacy_deletion_requests(request_email,email_hash,verification_method,status)
           VALUES($1,$2,'email_support','pending_verification')
           RETURNING public_code,status,requested_at`,
          [email, emailHash],
        );
        return res.status(202).json({
          ...rows[0],
          message: "Solicitação registrada. A identidade será verificada antes da exclusão dos dados do servidor.",
        });
      }

      const verification = await pool.query(
        `SELECT id FROM quote_requests
         WHERE public_code=$1 AND LOWER(buyer_email)=LOWER($2)
         LIMIT 1`,
        [quoteCode, email],
      );
      if (!verification.rowCount) {
        return res.status(400).json({ error: "O código informado não pertence a esse e-mail." });
      }

      const alias = deletedAlias(emailHash);
      const result = await withTransaction(async (client) => {
        const request = await client.query(
          `INSERT INTO privacy_deletion_requests(request_email,email_hash,verification_method,status)
           VALUES(NULL,$1,'quote_code','processing')
           RETURNING id,public_code,requested_at`,
          [emailHash],
        );

        const quoteRows = await client.query(
          `SELECT id,payment_status,paid_at,sourcing_status,retirement_status,delivery_status
           FROM quote_requests WHERE LOWER(buyer_email)=LOWER($1) FOR UPDATE`,
          [email],
        );

        let deletedQuotes = 0;
        let retainedTransactions = 0;
        for (const quote of quoteRows.rows) {
          const mustRetain = Boolean(quote.paid_at)
            || ["paid", "approved", "confirmed"].includes(String(quote.payment_status))
            || !["not_started", "failed", "cancelled"].includes(String(quote.sourcing_status))
            || !["not_started", "failed", "cancelled"].includes(String(quote.retirement_status))
            || !["not_started", "failed", "cancelled"].includes(String(quote.delivery_status));

          if (!mustRetain) {
            await client.query("DELETE FROM quote_requests WHERE id=$1", [quote.id]);
            deletedQuotes += 1;
            continue;
          }

          await client.query(
            `UPDATE quote_requests SET
              buyer_name='Usuário excluído', buyer_email=$2, buyer_phone=NULL,
              company_name=NULL, tax_id=NULL, wallet_address=NULL, admin_notes=NULL,
              updated_at=NOW()
             WHERE id=$1`,
            [quote.id, alias],
          );
          await client.query("UPDATE payment_attempts SET raw_payload='{}'::jsonb WHERE quote_id=$1", [quote.id]);
          await client.query("UPDATE commerce_events SET payload='{}'::jsonb WHERE quote_id=$1", [quote.id]);
          await client.query(
            `UPDATE fiscal_documents SET data=jsonb_build_object(
              'retained_for','legal_fiscal_compliance',
              'personal_data_removed',TRUE
            ) WHERE quote_id=$1`,
            [quote.id],
          );
          await client.query(
            `UPDATE ecot_allocations SET recipient_email=$2,wallet_address=NULL,
              metadata=jsonb_build_object('personal_data_removed',TRUE)
             WHERE quote_id=$1`,
            [quote.id, alias],
          );
          retainedTransactions += 1;
        }

        const subscriptions = await client.query("DELETE FROM subscription_requests WHERE LOWER(email)=LOWER($1)", [email]);
        const rewards = await client.query("DELETE FROM reward_leads WHERE LOWER(email)=LOWER($1)", [email]);
        const pendingOrders = await client.query(
          `DELETE FROM orders WHERE LOWER(buyer_email)=LOWER($1)
           AND payment_status NOT IN ('confirmed','paid','approved')`,
          [email],
        );
        const retainedOrders = await client.query(
          `UPDATE orders SET buyer_name='Usuário excluído',buyer_email=$2
           WHERE LOWER(buyer_email)=LOWER($1)`,
          [email, alias],
        );
        const retainedDistributions = await client.query(
          `UPDATE distributions SET recipient_name='Usuário excluído',recipient_email=$2,organization_name=NULL
           WHERE LOWER(recipient_email)=LOWER($1)`,
          [email, alias],
        );

        const summary = {
          deletedQuotes,
          retainedTransactions,
          deletedSubscriptions: subscriptions.rowCount ?? 0,
          deletedRewardLeads: rewards.rowCount ?? 0,
          deletedPendingOrders: pendingOrders.rowCount ?? 0,
          anonymizedOrders: retainedOrders.rowCount ?? 0,
          anonymizedDistributions: retainedDistributions.rowCount ?? 0,
          retainedCategories: retainedTransactions > 0 || (retainedOrders.rowCount ?? 0) > 0
            ? ["payment_reference", "fiscal_record", "retirement_and_delivery_proof"]
            : [],
        };

        await client.query(
          `UPDATE privacy_deletion_requests
           SET status='completed',result=$2::jsonb,completed_at=NOW(),request_email=NULL
           WHERE id=$1`,
          [request.rows[0].id, JSON.stringify(summary)],
        );

        return { ...request.rows[0], status: "completed", result: summary };
      });

      return res.json({
        ...result,
        message: "Dados não obrigatórios foram excluídos. Registros legais ou fiscais foram anonimizados e permanecem somente pelo prazo exigido.",
      });
    } catch (error) {
      console.error("[privacy] deletion request failed", error);
      return res.status(500).json({ error: "Não foi possível concluir a solicitação agora." });
    }
  });

  app.get("/api/privacy/deletion-requests/:publicCode", async (req, res) => {
    const raw = req.params.publicCode;
    const publicCode = Array.isArray(raw) ? raw[0] : raw;
    if (!z.string().uuid().safeParse(publicCode).success) return res.status(400).json({ error: "Código inválido" });
    try {
      const { rows } = await pool.query(
        `SELECT public_code,status,result,requested_at,completed_at
         FROM privacy_deletion_requests WHERE public_code=$1`,
        [publicCode],
      );
      if (!rows[0]) return res.status(404).json({ error: "Solicitação não encontrada" });
      res.setHeader("Cache-Control", "no-store");
      return res.json(rows[0]);
    } catch (error) {
      console.error("[privacy] status failed", error);
      return res.status(500).json({ error: "Erro interno" });
    }
  });
}
