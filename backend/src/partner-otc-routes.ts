import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";

const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value||"";
const requestStatuses=["draft","ready_to_send","sent","options_received","erpa_pending","erpa_signed","funding_pending","paid","delivered","retired","cancelled"] as const;
const optionStatuses=["received","shortlisted","selected","rejected","expired"] as const;

function fail(res:Response,error:unknown){
  const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;
  return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json({error:error instanceof Error?error.message:"Erro interno"});
}

async function requestView(id:number){
  const request=(await pool.query(`
    SELECT r.*,
      o.target_tonnes AS opportunity_target_tonnes,
      o.status AS opportunity_status
    FROM partner_otc_requests r
    JOIN demand_opportunities o ON o.id=r.opportunity_id
    WHERE r.id=$1`,[id])).rows[0];
  if(!request) return null;
  const {rows:options}=await pool.query(`
    SELECT o.*,
      CASE WHEN o.fx_brl_usd IS NOT NULL THEN ROUND(o.source_price_usd_tonne*o.fx_brl_usd,4) END AS source_cost_brl_tonne,
      CASE WHEN o.fx_brl_usd IS NOT NULL AND o.sell_price_brl_tonne IS NOT NULL
        THEN ROUND(o.sell_price_brl_tonne-(o.source_price_usd_tonne*o.fx_brl_usd),4) END AS margin_brl_tonne,
      CASE WHEN o.fx_brl_usd IS NOT NULL AND o.sell_price_brl_tonne IS NOT NULL AND o.sell_price_brl_tonne>0
        THEN ROUND(((o.sell_price_brl_tonne-(o.source_price_usd_tonne*o.fx_brl_usd))/o.sell_price_brl_tonne)*100,2) END AS margin_pct
    FROM partner_otc_options o
    WHERE o.request_id=$1
    ORDER BY CASE o.status WHEN 'selected' THEN 1 WHEN 'shortlisted' THEN 2 WHEN 'received' THEN 3 ELSE 4 END,o.created_at DESC`,[id]);
  return {...request,options};
}

export function registerPartnerOtcRoutes(app:Application){
  app.get("/api/admin/deal-desk/otc",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const opportunityId=Number(req.query.opportunityId||0);
      const limit=Math.max(1,Math.min(100,Number(req.query.limit||40)));
      const {rows}=await pool.query(`
        SELECT r.*,o.target_tonnes AS opportunity_target_tonnes
        FROM partner_otc_requests r
        JOIN demand_opportunities o ON o.id=r.opportunity_id
        WHERE ($1::bigint=0 OR r.opportunity_id=$1)
        ORDER BY r.updated_at DESC
        LIMIT $2`,[opportunityId,limit]);
      res.setHeader("Cache-Control","no-store");
      return res.json({count:rows.length,items:rows});
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/opportunities/:id/otc",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const opportunityId=Number(one(req.params.id));
      const opportunity=(await pool.query(`
        SELECT o.* FROM demand_opportunities o WHERE o.id=$1`,[opportunityId])).rows[0];
      if(!opportunity) return res.status(404).json({error:"Oportunidade não encontrada"});

      const rfq=(await pool.query(`SELECT id FROM market_maker_rfqs WHERE opportunity_id=$1`,[opportunityId])).rows[0];
      const safePayload={
        ecoTrackerOpportunityId:opportunityId,
        requestedTonnes:Number(opportunity.target_tonnes||0),
        claimPurpose:opportunity.claim_purpose,
        targetYear:opportunity.target_year,
        preferredRegistry:opportunity.preferred_registry||null,
        preferredCountry:opportunity.preferred_country||null,
        preferredProjectType:opportunity.preferred_project_type||null,
        maxPriceUsdTonne:opportunity.max_price_usd_tonne==null?null:Number(opportunity.max_price_usd_tonne),
        constraints:opportunity.constraints||{},
        privacy:"Client identity intentionally excluded from partner RFQ package.",
      };

      const {rows}=await pool.query(`
        INSERT INTO partner_otc_requests(
          opportunity_id,market_maker_rfq_id,partner_key,status,requested_tonnes,claim_purpose,target_year,
          preferred_registry,preferred_country,preferred_project_type,max_price_usd_tonne,request_payload,notes
        ) VALUES($1,$2,'carbonmark','ready_to_send',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
        ON CONFLICT(opportunity_id,partner_key) DO UPDATE SET
          market_maker_rfq_id=EXCLUDED.market_maker_rfq_id,
          requested_tonnes=EXCLUDED.requested_tonnes,
          claim_purpose=EXCLUDED.claim_purpose,
          target_year=EXCLUDED.target_year,
          preferred_registry=EXCLUDED.preferred_registry,
          preferred_country=EXCLUDED.preferred_country,
          preferred_project_type=EXCLUDED.preferred_project_type,
          max_price_usd_tonne=EXCLUDED.max_price_usd_tonne,
          request_payload=EXCLUDED.request_payload,
          status=CASE WHEN partner_otc_requests.status IN ('draft','ready_to_send') THEN 'ready_to_send' ELSE partner_otc_requests.status END,
          updated_at=NOW()
        RETURNING *`,[
          opportunityId,rfq?.id||null,Number(opportunity.target_tonnes||0),String(opportunity.claim_purpose||"voluntary_offset"),
          opportunity.target_year||null,opportunity.preferred_registry||null,opportunity.preferred_country||null,
          opportunity.preferred_project_type||null,opportunity.max_price_usd_tonne||null,JSON.stringify(safePayload),
          "Criado pelo Deal Desk. Nenhuma solicitação externa foi enviada automaticamente.",
        ]);
      return res.status(201).json(await requestView(Number(rows[0].id)));
    }catch(error){return fail(res,error);}
  });

  app.get("/api/admin/deal-desk/otc/:id",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const item=await requestView(Number(one(req.params.id)));
      if(!item) return res.status(404).json({error:"Pedido OTC não encontrado"});
      res.setHeader("Cache-Control","no-store");
      return res.json(item);
    }catch(error){return fail(res,error);}
  });

  app.get("/api/admin/deal-desk/otc/:id/package",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const item=await requestView(Number(one(req.params.id)));
      if(!item) return res.status(404).json({error:"Pedido OTC não encontrado"});
      const purpose=String(item.claim_purpose||"voluntary_offset")==="voluntary_offset"?"voluntary corporate retirement":"climate contribution";
      const lines=[
        "Hi Drew,",
        "",
        "We have a new EcoTracker corporate OTC RFQ and would like a portfolio of suitable carbon options.",
        "",
        `EcoTracker opportunity: #${item.opportunity_id}`,
        `Target volume: ${Number(item.requested_tonnes).toLocaleString("en-US",{maximumFractionDigits:3})} tCO2e`,
        `Purpose: ${purpose}`,
        `Target year: ${item.target_year||"flexible"}`,
        `Preferred registry: ${item.preferred_registry||"open"}`,
        `Preferred country/region: ${item.preferred_country||"open"}`,
        `Preferred project type: ${item.preferred_project_type||"open"}`,
        `Maximum source price: ${item.max_price_usd_tonne==null?"open":`USD ${Number(item.max_price_usd_tonne).toFixed(2)}/t`}`,
        "",
        "Please send project options with registry, project name/ID, country, methodology, vintage, available volume, price, validity and retirement/beneficiary capabilities.",
        "",
        "Client identity is intentionally retained by EcoTracker at the RFQ stage.",
        "",
        "Best regards,",
        "EcoTracker",
      ];
      return res.json({
        requestId:item.id,
        partnerKey:item.partner_key,
        subject:`EcoTracker OTC RFQ · ${Number(item.requested_tonnes).toLocaleString("en-US",{maximumFractionDigits:3})} tCO2e · #${item.opportunity_id}`,
        body:lines.join("\n"),
        clientIdentityIncluded:false,
      });
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/otc/:id/status",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({
      status:z.enum(requestStatuses),
      partnerReference:z.string().max(255).nullable().optional(),
      erpaReference:z.string().max(255).nullable().optional(),
      notes:z.string().max(10000).nullable().optional(),
    }).safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Atualização OTC inválida",details:parsed.error.flatten()});
    try{
      const id=Number(one(req.params.id));
      const {rows}=await pool.query(`
        UPDATE partner_otc_requests SET
          status=$2,
          partner_reference=COALESCE($3,partner_reference),
          erpa_reference=COALESCE($4,erpa_reference),
          notes=COALESCE($5,notes),
          requested_at=CASE WHEN $2='sent' THEN COALESCE(requested_at,NOW()) ELSE requested_at END,
          response_received_at=CASE WHEN $2='options_received' THEN COALESCE(response_received_at,NOW()) ELSE response_received_at END,
          retired_at=CASE WHEN $2='retired' THEN COALESCE(retired_at,NOW()) ELSE retired_at END,
          updated_at=NOW()
        WHERE id=$1 RETURNING id`,[id,parsed.data.status,parsed.data.partnerReference??null,parsed.data.erpaReference??null,parsed.data.notes??null]);
      if(!rows[0]) return res.status(404).json({error:"Pedido OTC não encontrado"});
      return res.json(await requestView(id));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/otc/:id/options",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({
      projectName:z.string().min(2).max(255),
      registry:z.string().max(120).nullable().optional(),
      registryProjectId:z.string().max(180).nullable().optional(),
      country:z.string().max(120).nullable().optional(),
      methodology:z.string().max(255).nullable().optional(),
      vintage:z.string().max(100).nullable().optional(),
      availableTonnes:z.coerce.number().positive().max(100000000),
      sourcePriceUsdTonne:z.coerce.number().min(0).max(1000000),
      fxBrlUsd:z.coerce.number().positive().max(100).nullable().optional(),
      sellPriceBrlTonne:z.coerce.number().positive().max(10000000).nullable().optional(),
      validityUntil:z.string().max(100).nullable().optional(),
      retirementSupported:z.boolean().default(true),
      beneficiarySupported:z.boolean().default(true),
      evidenceUrl:z.string().url().max(4000).nullable().optional(),
      notes:z.string().max(10000).nullable().optional(),
    }).safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Opção OTC inválida",details:parsed.error.flatten()});
    try{
      const requestId=Number(one(req.params.id));
      const exists=(await pool.query(`SELECT id FROM partner_otc_requests WHERE id=$1`,[requestId])).rows[0];
      if(!exists) return res.status(404).json({error:"Pedido OTC não encontrado"});
      const p=parsed.data;
      await pool.query(`
        INSERT INTO partner_otc_options(
          request_id,project_name,registry,registry_project_id,country,methodology,vintage,available_tonnes,
          source_price_usd_tonne,fx_brl_usd,sell_price_brl_tonne,validity_until,retirement_supported,
          beneficiary_supported,evidence_url,notes,snapshot
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,'')::timestamptz,$13,$14,$15,$16,$17::jsonb)`,[
        requestId,p.projectName,p.registry??null,p.registryProjectId??null,p.country??null,p.methodology??null,p.vintage??null,
        p.availableTonnes,p.sourcePriceUsdTonne,p.fxBrlUsd??null,p.sellPriceBrlTonne??null,p.validityUntil??null,
        p.retirementSupported,p.beneficiarySupported,p.evidenceUrl??null,p.notes??null,
        JSON.stringify({capturedAt:new Date().toISOString(),source:"manual_partner_option"}),
      ]);
      await pool.query(`UPDATE partner_otc_requests SET status='options_received',response_received_at=COALESCE(response_received_at,NOW()),updated_at=NOW() WHERE id=$1 AND status IN ('ready_to_send','sent','options_received')`,[requestId]);
      return res.status(201).json(await requestView(requestId));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/otc/options/:id/status",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({status:z.enum(optionStatuses)}).safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({error:"Status da opção inválido"});
    try{
      const optionId=Number(one(req.params.id));
      const {rows}=await pool.query(`UPDATE partner_otc_options SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING request_id`,[optionId,parsed.data.status]);
      if(!rows[0]) return res.status(404).json({error:"Opção OTC não encontrada"});
      if(parsed.data.status==="selected"){
        await pool.query(`UPDATE partner_otc_options SET status='shortlisted',updated_at=NOW() WHERE request_id=$1 AND id<>$2 AND status='selected'`,[rows[0].request_id,optionId]);
        await pool.query(`UPDATE partner_otc_requests SET status='erpa_pending',updated_at=NOW() WHERE id=$1 AND status<>'cancelled'`,[rows[0].request_id]);
      }
      return res.json(await requestView(Number(rows[0].request_id)));
    }catch(error){return fail(res,error);}
  });
}
