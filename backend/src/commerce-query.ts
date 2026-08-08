import { pool } from "./db.js";

export async function getPublicCommerceQuote(publicCode: string) {
  const { rows } = await pool.query(
    `SELECT q.public_code,q.requested_kg,q.delivery_mode,q.wallet_address,q.purpose,q.claim_category,
       q.indicative_total,q.final_total,q.status,q.quote_expires_at,q.payment_provider,q.payment_method,q.payment_status,q.payment_url,
       q.pix_br_code,q.pix_qr_code_url,q.paid_at,q.sourcing_status,q.retirement_status,q.retirement_reference,
       q.retirement_tx_hash,q.retired_at,q.delivery_status,q.delivery_reference,q.delivered_at,q.receipt_status,
       q.nfse_status,q.created_at,q.updated_at,a.registry,a.project_name,
       q.pricing_snapshot->'carbonmarkRetirement'->>'viewRetirementUrl' AS retirement_url,
       q.pricing_snapshot->'carbonmarkRetirement'->>'certificateUrl' AS retirement_certificate_url,
       q.pricing_snapshot->'carbonmarkRetirement'->>'provenanceUrl' AS retirement_provenance_url,
       q.pricing_snapshot->'carbonmarkRetirement'->>'retirementId' AS carbonmark_retirement_id,
       receipt.public_code AS receipt_public_code,
       nfse.document_url AS nfse_url,
       allocation.public_code AS allocation_public_code,
       allocation.chain_tx_hash AS delivery_tx_hash
     FROM quote_requests q
     JOIN monitored_assets a ON a.id=q.asset_id
     LEFT JOIN fiscal_documents receipt ON receipt.quote_id=q.id AND receipt.document_type='receipt'
     LEFT JOIN fiscal_documents nfse ON nfse.quote_id=q.id AND nfse.document_type='nfse'
     LEFT JOIN ecot_allocations allocation ON allocation.quote_id=q.id
     WHERE q.public_code=$1`,
    [publicCode],
  );
  return rows[0] || null;
}
