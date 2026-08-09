import { pool, withTransaction } from "./db.js";

type Json = Record<string,unknown>;

const num = (value:unknown,fallback=0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function scoreCandidate(input:{type:string;country?:string|null;preferredCountry?:string|null;tonnes:number;gap:number}) {
  let score = input.type==="mandated_inventory" ? 85 : input.type==="seller_confirmed" ? 70 : 40;
  if (input.preferredCountry && input.country && input.preferredCountry.toLowerCase()===input.country.toLowerCase()) score += 10;
  if (input.tonnes>=input.gap) score += 5;
  return Math.max(0,Math.min(100,score));
}

async function rfqView(id:number) {
  const { rows } = await pool.query(`
    SELECT r.*,a.company_name,a.tax_id,a.sector,a.contact_name,a.contact_email,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',c.id,'publicCode',c.public_code,'candidateType',c.candidate_type,'candidateKey',c.candidate_key,
        'supplyLeadId',c.supply_lead_id,'supplyInventoryId',c.supply_inventory_id,'registry',c.registry,
        'registryProjectId',c.registry_project_id,'projectName',c.project_name,'country',c.country,'vintage',c.vintage,
        'candidateTonnes',c.candidate_tonnes,'confidence',c.confidence,'sourcingScore',c.sourcing_score,
        'status',c.status,'autoCloseEligible',c.auto_close_eligible,'rationale',c.rationale,'snapshot',c.snapshot,
        'lastCheckedAt',c.last_checked_at
      ) ORDER BY c.sourcing_score DESC,c.candidate_tonnes DESC,c.id)
      FROM market_maker_rfq_candidates c WHERE c.rfq_id=r.id),'[]'::jsonb) AS candidates
    FROM market_maker_rfqs r
    JOIN demand_accounts a ON a.id=r.account_id
    WHERE r.id=$1`,[id]);
  return rows[0] || null;
}

export async function refreshDemandSupplyRfqCandidates(rfqId:number) {
  await withTransaction(async (client) => {
    const rfq = (await client.query(`SELECT * FROM market_maker_rfqs WHERE id=$1 FOR UPDATE`,[rfqId])).rows[0];
    if (!rfq) throw Object.assign(new Error("RFQ não encontrado"),{status:404});
    if (["resolved","cancelled"].includes(String(rfq.status))) return;

    await client.query(`UPDATE market_maker_rfq_candidates SET status='stale',updated_at=NOW() WHERE rfq_id=$1 AND status<>'selected'`,[rfqId]);

    const inventory = await client.query(`
      SELECT i.id AS inventory_id,i.registry,i.registry_project_id,i.batch_reference,i.vintage,
             l.id AS lead_id,l.project_name,l.country,l.region,m.supplier_name,m.floor_price_usd_tonne,
             GREATEST(0,i.authorized_tonnes-i.sold_tonnes-
               COALESCE((SELECT SUM(sr.reserved_tonnes) FROM supply_reservations sr
                         WHERE sr.inventory_id=i.id AND sr.status IN ('active','pending')),0)) AS available_tonnes,
             i.registry_evidence_url
      FROM supply_inventory i
      JOIN supplier_mandates m ON m.id=i.mandate_id AND m.status='active'
      JOIN supply_leads l ON l.id=m.lead_id
      WHERE i.status='available'
      ORDER BY available_tonnes DESC`);

    for (const row of inventory.rows) {
      const tonnes = Math.max(0,num(row.available_tonnes));
      if (tonnes<=0) continue;
      const score = scoreCandidate({type:"mandated_inventory",country:row.country,preferredCountry:rfq.preferred_country,tonnes,gap:num(rfq.gap_tonnes)});
      await client.query(`
        INSERT INTO market_maker_rfq_candidates(
          rfq_id,candidate_type,candidate_key,supply_lead_id,supply_inventory_id,registry,registry_project_id,
          project_name,country,vintage,candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
        ) VALUES($1,'mandated_inventory',$2,$3,$4,$5,$6,$7,$8,$9,$10,'mandated',$11,'identified',FALSE,$12::jsonb,$13::jsonb,NOW())
        ON CONFLICT(rfq_id,candidate_type,candidate_key) DO UPDATE SET
          supply_lead_id=EXCLUDED.supply_lead_id,supply_inventory_id=EXCLUDED.supply_inventory_id,
          candidate_tonnes=EXCLUDED.candidate_tonnes,confidence=EXCLUDED.confidence,sourcing_score=EXCLUDED.sourcing_score,
          status=CASE WHEN market_maker_rfq_candidates.status='selected' THEN 'selected' ELSE 'identified' END,
          rationale=EXCLUDED.rationale,snapshot=EXCLUDED.snapshot,last_checked_at=NOW(),updated_at=NOW()`,[
        rfqId,`inventory:${row.inventory_id}`,row.lead_id,row.inventory_id,row.registry,row.registry_project_id,row.project_name,row.country,row.vintage,
        tonnes,score,
        JSON.stringify({basis:"supplier_mandate",commercialInventoryConfirmed:true,claimReady:false,warning:"Mandated supply only closes demand after entering the claim-ready monitored catalog."}),
        JSON.stringify({supplierName:row.supplier_name,batchReference:row.batch_reference,availableTonnes:tonnes,floorPriceUsdTonne:row.floor_price_usd_tonne,registryEvidenceUrl:row.registry_evidence_url}),
      ]);
    }

    const leads = await client.query(`
      SELECT l.*,
        EXISTS(SELECT 1 FROM supplier_mandates m WHERE m.lead_id=l.id AND m.status='active') AS has_active_mandate
      FROM supply_leads l
      WHERE l.status NOT IN ('rejected','cancelled')
        AND COALESCE(l.confirmed_free_tonnes,l.estimated_unretired_tonnes,0)>0
      ORDER BY CASE WHEN l.confirmed_free_tonnes IS NOT NULL THEN 1 ELSE 2 END,
               COALESCE(l.confirmed_free_tonnes,l.estimated_unretired_tonnes,0) DESC`);

    for (const row of leads.rows) {
      if (row.has_active_mandate) continue;
      const sellerConfirmed = row.confirmed_free_tonnes != null;
      const type = sellerConfirmed ? "seller_confirmed" : "registry_estimate";
      const tonnes = Math.max(0,num(sellerConfirmed ? row.confirmed_free_tonnes : row.estimated_unretired_tonnes));
      if (tonnes<=0) continue;
      const score = scoreCandidate({type,country:row.country,preferredCountry:rfq.preferred_country,tonnes,gap:num(rfq.gap_tonnes)});
      const rationale = sellerConfirmed
        ? {basis:"seller_confirmed_free_inventory",commercialInventoryConfirmed:true,mandateRequired:true,claimReady:false}
        : {basis:"registry_estimate_only",commercialInventoryConfirmed:false,mandateRequired:true,claimReady:false,warning:"Registry estimate is not commercially free inventory until supplier confirmation."};
      await client.query(`
        INSERT INTO market_maker_rfq_candidates(
          rfq_id,candidate_type,candidate_key,supply_lead_id,registry,registry_project_id,project_name,country,vintage,
          candidate_tonnes,confidence,sourcing_score,status,auto_close_eligible,rationale,snapshot,last_checked_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'identified',FALSE,$13::jsonb,$14::jsonb,NOW())
        ON CONFLICT(rfq_id,candidate_type,candidate_key) DO UPDATE SET
          candidate_tonnes=EXCLUDED.candidate_tonnes,confidence=EXCLUDED.confidence,sourcing_score=EXCLUDED.sourcing_score,
          status=CASE WHEN market_maker_rfq_candidates.status='selected' THEN 'selected' ELSE 'identified' END,
          rationale=EXCLUDED.rationale,snapshot=EXCLUDED.snapshot,last_checked_at=NOW(),updated_at=NOW()`,[
        rfqId,type,`lead:${row.id}`,row.id,row.registry,row.registry_project_id,row.project_name,row.country,row.vintage,
        tonnes,sellerConfirmed ? "seller_confirmed" : "registry_estimate",score,JSON.stringify(rationale),
        JSON.stringify({supplierName:row.supplier_name,supplierContactName:row.supplier_contact_name,supplierEmail:row.supplier_email,supplierPhone:row.supplier_phone,evidenceUrl:row.evidence_url,sourceUrl:row.source_url,availabilityConfidence:row.availability_confidence,contactStatus:row.contact_status}),
      ]);
    }

    const liveCandidates = await client.query(`
      SELECT COALESCE(SUM(candidate_tonnes),0) AS candidate_tonnes
      FROM market_maker_rfq_candidates WHERE rfq_id=$1 AND status<>'stale'`,[rfqId]);
    const nextStatus = num(liveCandidates.rows[0]?.candidate_tonnes)>0 ? "partially_sourced" : "open";
    await client.query(`
      UPDATE market_maker_rfqs SET status=$2,last_match_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND status NOT IN ('resolved','cancelled')`,[rfqId,nextStatus]);
  });
  return rfqView(rfqId);
}

export async function upsertDemandSupplyRfq(input:{opportunityId:number;targetTonnes:number;coveredTonnes:number;gapTonnes:number;source?:string}) {
  const result = await withTransaction(async (client) => {
    const opportunity = (await client.query(`
      SELECT o.*,a.company_name,a.country AS account_country
      FROM demand_opportunities o JOIN demand_accounts a ON a.id=o.account_id
      WHERE o.id=$1 FOR UPDATE OF o,a`,[input.opportunityId])).rows[0];
    if (!opportunity) throw Object.assign(new Error("Oportunidade não encontrada"),{status:404});
    if (input.gapTonnes<=0.001) {
      return (await client.query(`
        UPDATE market_maker_rfqs SET status='resolved',covered_tonnes=$2,gap_tonnes=0,resolved_at=NOW(),updated_at=NOW()
        WHERE opportunity_id=$1 RETURNING *`,[input.opportunityId,input.coveredTonnes])).rows[0] || null;
    }
    const requirements = {
      claimPurpose:opportunity.claim_purpose || "voluntary_offset",
      targetBasis:opportunity.target_basis,
      constraints:opportunity.constraints || {},
      strictRule:"Only claim-ready monitored assets can close the RFQ automatically.",
    };
    return (await client.query(`
      INSERT INTO market_maker_rfqs(
        opportunity_id,account_id,status,claim_purpose,target_year,target_tonnes,covered_tonnes,gap_tonnes,
        preferred_country,max_price_usd_tonne,priority_score,requirements,source,last_match_at
      ) VALUES($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,NOW())
      ON CONFLICT(opportunity_id) DO UPDATE SET
        status=CASE WHEN market_maker_rfqs.status='cancelled' THEN 'cancelled' ELSE 'open' END,
        target_tonnes=EXCLUDED.target_tonnes,covered_tonnes=EXCLUDED.covered_tonnes,gap_tonnes=EXCLUDED.gap_tonnes,
        preferred_country=EXCLUDED.preferred_country,max_price_usd_tonne=EXCLUDED.max_price_usd_tonne,
        priority_score=EXCLUDED.priority_score,requirements=EXCLUDED.requirements,source=EXCLUDED.source,
        resolved_at=NULL,last_match_at=NOW(),updated_at=NOW()
      RETURNING *`,[
      opportunity.id,opportunity.account_id,opportunity.claim_purpose || "voluntary_offset",opportunity.target_year,
      input.targetTonnes,input.coveredTonnes,input.gapTonnes,opportunity.preferred_country || opportunity.account_country || null,
      opportunity.max_price_usd_tonne,Math.max(0,Math.min(100,Math.round(num(opportunity.priority_score,50)))),
      JSON.stringify(requirements),input.source || "demand_autopilot",
    ])).rows[0];
  });
  if (!result) return null;
  if (result.status==="resolved") return rfqView(Number(result.id));
  return refreshDemandSupplyRfqCandidates(Number(result.id));
}

export async function resolveDemandSupplyRfq(opportunityId:number,coveredTonnes?:number) {
  const { rows } = await pool.query(`
    UPDATE market_maker_rfqs SET status='resolved',covered_tonnes=COALESCE($2,covered_tonnes),gap_tonnes=0,
      resolved_at=NOW(),updated_at=NOW()
    WHERE opportunity_id=$1 AND status<>'cancelled' RETURNING *`,[opportunityId,coveredTonnes ?? null]);
  return rows[0] || null;
}

export async function listDemandSupplyRfqs(input:{status?:string;limit?:number}={}) {
  const status = String(input.status || "").trim();
  const limit = Math.max(1,Math.min(300,Math.round(input.limit || 100)));
  const { rows } = await pool.query(`
    SELECT r.*,a.company_name,a.tax_id,a.sector,a.contact_name,a.contact_email,
      (SELECT COUNT(*)::int FROM market_maker_rfq_candidates c WHERE c.rfq_id=r.id AND c.status<>'stale') AS candidate_count,
      COALESCE((SELECT SUM(c.candidate_tonnes) FROM market_maker_rfq_candidates c WHERE c.rfq_id=r.id AND c.status<>'stale'),0) AS candidate_tonnes
    FROM market_maker_rfqs r JOIN demand_accounts a ON a.id=r.account_id
    WHERE ($1='' OR r.status=$1)
    ORDER BY CASE r.status WHEN 'open' THEN 1 WHEN 'partially_sourced' THEN 2 ELSE 3 END,
             r.priority_score DESC,r.gap_tonnes DESC,r.updated_at DESC LIMIT $2`,[status,limit]);
  return rows;
}

export async function getDemandSupplyRfq(id:number) { return rfqView(id); }

export async function cancelDemandSupplyRfq(input:{rfqId:number;reason?:string|null}) {
  const { rows } = await pool.query(`
    UPDATE market_maker_rfqs SET status='cancelled',cancelled_at=NOW(),
      requirements=requirements || $2::jsonb,updated_at=NOW()
    WHERE id=$1 AND status<>'resolved' RETURNING *`,[
    input.rfqId,JSON.stringify({cancelReason:input.reason || null,cancelledAt:new Date().toISOString()}),
  ]);
  if (!rows[0]) throw Object.assign(new Error("RFQ não encontrado ou já resolvido"),{status:404});
  return rows[0];
}

export async function marketMakerSummary() {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE status IN ('open','partially_sourced'))::int AS open_rfqs,
      COALESCE(SUM(gap_tonnes) FILTER (WHERE status IN ('open','partially_sourced')),0) AS open_gap_tonnes,
      COALESCE(SUM(target_tonnes) FILTER (WHERE status IN ('open','partially_sourced')),0) AS open_target_tonnes,
      COUNT(*) FILTER (WHERE status='resolved')::int AS resolved_rfqs
    FROM market_maker_rfqs`);
  const candidates = await pool.query(`
    SELECT candidate_type,COUNT(*)::int AS count,COALESCE(SUM(candidate_tonnes),0) AS tonnes
    FROM market_maker_rfq_candidates WHERE status<>'stale' GROUP BY candidate_type ORDER BY candidate_type`);
  return {rfqs:rows[0] || {},supplyCandidates:candidates.rows};
}
