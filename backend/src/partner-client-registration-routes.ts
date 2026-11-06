import type { Application, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { pool } from "./db.js";

const one=(value:string|string[]|undefined)=>Array.isArray(value)?value[0]:value||"";
const registrationStatuses=["draft","ready_to_send","sent","confirmed","declined","deemed_confirmed","cancelled"] as const;

function fail(res:Response,error:unknown){
  const status=typeof error==="object"&&error&&"status" in error?Number((error as {status:unknown}).status):500;
  return res.status(Number.isFinite(status)&&status>=400&&status<=599?status:500).json({error:error instanceof Error?error.message:"Erro interno"});
}

function addWeekdaysUtc(start:Date,count:number){
  const date=new Date(start);
  let added=0;
  while(added<count){
    date.setUTCDate(date.getUTCDate()+1);
    const day=date.getUTCDay();
    if(day!==0&&day!==6) added++;
  }
  return date;
}

async function opportunityContext(opportunityId:number){
  const {rows}=await pool.query(`
    SELECT
      o.id AS opportunity_id,o.account_id,o.target_tonnes,o.claim_purpose,o.target_year,
      o.preferred_country,o.preferred_registry,o.preferred_project_type,o.notes AS opportunity_notes,
      a.company_name,a.legal_name,a.tax_id,a.country,a.contact_name,a.contact_email
    FROM demand_opportunities o
    JOIN demand_accounts a ON a.id=o.account_id
    WHERE o.id=$1
  `,[opportunityId]);
  return rows[0]||null;
}

async function registrationViewById(id:number){
  const {rows}=await pool.query(`
    SELECT r.*,a.company_name,a.legal_name AS account_legal_name,a.tax_id,a.contact_name,a.contact_email,
      o.target_tonnes,o.claim_purpose,o.target_year,o.preferred_country,o.preferred_registry,o.preferred_project_type
    FROM partner_client_registrations r
    JOIN demand_accounts a ON a.id=r.account_id
    LEFT JOIN demand_opportunities o ON o.id=r.source_opportunity_id
    WHERE r.id=$1
  `,[id]);
  const row=rows[0];
  if(!row)return null;
  const now=Date.now();
  const due=row.response_due_at?new Date(row.response_due_at).getTime():null;
  return {
    ...row,
    overdue:row.status==="sent"&&due!==null&&Number.isFinite(due)&&now>=due,
    deadlineBasis:"5 weekdays from sent_at; final legal check must account for U.S. federal and Brazilian national public holidays.",
    deemedConfirmationRequiresHolidayCheck:true,
  };
}

async function registrationViewByOpportunity(opportunityId:number){
  const context=await opportunityContext(opportunityId);
  if(!context)return null;
  const {rows}=await pool.query(`
    SELECT * FROM partner_client_registrations
    WHERE account_id=$1 AND partner_key='carbonmark'
    LIMIT 1
  `,[context.account_id]);
  if(rows[0]) return registrationViewById(Number(rows[0].id));
  return {
    id:null,
    status:"draft",
    account_id:context.account_id,
    source_opportunity_id:context.opportunity_id,
    partner_key:"carbonmark",
    agreement_date:"2026-11-06",
    client_legal_name:context.legal_name||context.company_name,
    client_country:context.country||"Brazil",
    covered_affiliates:[],
    nature_of_engagement:"EcoTracker is advising and acting as commercial procurement partner for corporate carbon credit sourcing and retirement.",
    strategic_account:false,
    expected_credit_type:[context.preferred_project_type,context.preferred_registry].filter(Boolean).join(" · ")||"Carbon credits suitable for the client's corporate climate objective",
    expected_volume_tonnes:Number(context.target_tonnes||0),
    expected_timing:context.target_year?String(context.target_year):"To be confirmed",
    partner_contact:"Henrique Guilherme Dias de Campos · Managing Director · Alternative Ventures IS (EcoTracker)",
    company_name:context.company_name,
    account_legal_name:context.legal_name,
    tax_id:context.tax_id,
    contact_name:context.contact_name,
    contact_email:context.contact_email,
    overdue:false,
    deadlineBasis:"5 weekdays from sent_at; final legal check must account for U.S. federal and Brazilian national public holidays.",
    deemedConfirmationRequiresHolidayCheck:true,
  };
}

const upsertSchema=z.object({
  agreementDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-11-06"),
  clientLegalName:z.string().min(2).max(255),
  clientCountry:z.string().min(2).max(120),
  coveredAffiliates:z.array(z.string().min(1).max(255)).max(100).default([]),
  natureOfEngagement:z.string().min(5).max(5000),
  strategicAccount:z.boolean().default(false),
  expectedCreditType:z.string().max(255).nullable().optional(),
  expectedVolumeTonnes:z.coerce.number().positive().max(1_000_000_000).nullable().optional(),
  expectedTiming:z.string().max(180).nullable().optional(),
  partnerContact:z.string().min(3).max(320),
  notes:z.string().max(10000).nullable().optional(),
});

export function registerPartnerClientRegistrationRoutes(app:Application){
  app.get("/api/admin/deal-desk/opportunities/:id/partner-registration",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const opportunityId=Number(one(req.params.id));
      const view=await registrationViewByOpportunity(opportunityId);
      if(!view)return res.status(404).json({error:"Oportunidade não encontrada"});
      res.setHeader("Cache-Control","no-store");
      return res.json(view);
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/opportunities/:id/partner-registration",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=upsertSchema.safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Dados do Schedule 1 inválidos",details:parsed.error.flatten()});
    try{
      const opportunityId=Number(one(req.params.id));
      const context=await opportunityContext(opportunityId);
      if(!context)return res.status(404).json({error:"Oportunidade não encontrada"});
      const d=parsed.data;
      const {rows}=await pool.query(`
        INSERT INTO partner_client_registrations(
          account_id,source_opportunity_id,partner_key,agreement_date,status,client_legal_name,client_country,
          covered_affiliates,nature_of_engagement,strategic_account,expected_credit_type,expected_volume_tonnes,
          expected_timing,partner_contact,notes
        ) VALUES($1,$2,'carbonmark',$3::date,'ready_to_send',$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(account_id,partner_key) DO UPDATE SET
          source_opportunity_id=EXCLUDED.source_opportunity_id,
          agreement_date=EXCLUDED.agreement_date,
          client_legal_name=EXCLUDED.client_legal_name,
          client_country=EXCLUDED.client_country,
          covered_affiliates=EXCLUDED.covered_affiliates,
          nature_of_engagement=EXCLUDED.nature_of_engagement,
          strategic_account=EXCLUDED.strategic_account,
          expected_credit_type=EXCLUDED.expected_credit_type,
          expected_volume_tonnes=EXCLUDED.expected_volume_tonnes,
          expected_timing=EXCLUDED.expected_timing,
          partner_contact=EXCLUDED.partner_contact,
          notes=EXCLUDED.notes,
          status=CASE WHEN partner_client_registrations.status IN ('draft','ready_to_send') THEN 'ready_to_send' ELSE partner_client_registrations.status END,
          updated_at=NOW()
        RETURNING id
      `,[
        context.account_id,opportunityId,d.agreementDate,d.clientLegalName,d.clientCountry,JSON.stringify(d.coveredAffiliates),
        d.natureOfEngagement,d.strategicAccount,d.expectedCreditType??null,d.expectedVolumeTonnes??Number(context.target_tonnes||0),
        d.expectedTiming??(context.target_year?String(context.target_year):null),d.partnerContact,d.notes??null,
      ]);
      return res.status(201).json(await registrationViewById(Number(rows[0].id)));
    }catch(error){return fail(res,error);}
  });

  app.get("/api/admin/deal-desk/partner-registration/:id/package",requireAdmin,async(req:Request,res:Response)=>{
    try{
      const id=Number(one(req.params.id));
      const item=await registrationViewById(id);
      if(!item)return res.status(404).json({error:"Registro de cliente não encontrado"});
      const affiliates=Array.isArray(item.covered_affiliates)&&item.covered_affiliates.length?item.covered_affiliates.join(", "):"None";
      const body=[
        "Hi Drew,",
        "",
        `Please treat this email as a Registration Notice under Clause 3 and Schedule 1 of the Channel Partner Agreement dated ${item.agreement_date} between Offsetra LLC and Alternative Ventures IS (d/b/a EcoTracker).`,
        "",
        "SCHEDULE 1 · DEAL REGISTRATION NOTICE",
        "",
        `Prospective Client (legal name): ${item.client_legal_name}`,
        `Country of incorporation: ${item.client_country}`,
        `Affiliates to be covered (if any): ${affiliates}`,
        `Nature of engagement with Partner: ${item.nature_of_engagement}`,
        `Proposed as Strategic Account (Clause 3.7): ${item.strategic_account?"Yes":"No"}`,
        `Expected credit type, volume and timing: ${item.expected_credit_type||"Open"} · ${item.expected_volume_tonnes==null?"Volume TBD":Number(item.expected_volume_tonnes).toLocaleString("en-US",{maximumFractionDigits:3})+" tCO2e"} · ${item.expected_timing||"Timing TBD"}`,
        `Partner contact: ${item.partner_contact}`,
        "",
        "Please confirm or decline the registration in accordance with Clause 3.2/3.3.",
        "",
        "Best regards,",
        "Henrique Guilherme Dias de Campos",
        "Managing Director",
        "Alternative Ventures IS · EcoTracker",
      ].join("\n");
      return res.json({
        registrationId:item.id,
        to:"drew@carbonmark.com",
        subject:`EcoTracker · Schedule 1 Deal Registration · ${item.client_legal_name}`,
        body,
        clientIdentityIncluded:true,
        requiresHumanReviewBeforeSend:true,
      });
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/partner-registration/:id/mark-sent",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({
      sentAt:z.string().datetime().optional(),
      responseDueAt:z.string().datetime().nullable().optional(),
    }).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Envio do Schedule 1 inválido",details:parsed.error.flatten()});
    try{
      const id=Number(one(req.params.id));
      const sentAt=parsed.data.sentAt?new Date(parsed.data.sentAt):new Date();
      const due=parsed.data.responseDueAt?new Date(parsed.data.responseDueAt):addWeekdaysUtc(sentAt,5);
      const {rows}=await pool.query(`
        UPDATE partner_client_registrations SET
          status='sent',sent_at=$2,response_due_at=$3,confirmation_date=NULL,decline_ground=NULL,partner_response=NULL,updated_at=NOW()
        WHERE id=$1 RETURNING id
      `,[id,sentAt.toISOString(),due.toISOString()]);
      if(!rows[0])return res.status(404).json({error:"Registro de cliente não encontrado"});
      return res.json(await registrationViewById(id));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/partner-registration/:id/decision",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({
      decision:z.enum(["confirmed","declined"]),
      confirmationDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      declineGround:z.enum(["3.2(a)","3.2(b)","3.2(c)","other"]).nullable().optional(),
      partnerResponse:z.string().max(10000).nullable().optional(),
    }).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Resposta do parceiro inválida",details:parsed.error.flatten()});
    try{
      const id=Number(one(req.params.id));
      if(parsed.data.decision==="declined"&&!parsed.data.declineGround){
        return res.status(400).json({error:"Informe o fundamento da recusa para preservar a trilha contratual"});
      }
      const {rows}=await pool.query(`
        UPDATE partner_client_registrations SET
          status=$2,
          confirmation_date=COALESCE($3::date,CASE WHEN $2='confirmed' THEN CURRENT_DATE ELSE confirmation_date END),
          decline_ground=$4,
          partner_response=$5,
          updated_at=NOW()
        WHERE id=$1 RETURNING id
      `,[id,parsed.data.decision,parsed.data.confirmationDate??null,parsed.data.declineGround??null,parsed.data.partnerResponse??null]);
      if(!rows[0])return res.status(404).json({error:"Registro de cliente não encontrado"});
      return res.json(await registrationViewById(id));
    }catch(error){return fail(res,error);}
  });

  app.post("/api/admin/deal-desk/partner-registration/:id/deemed-confirmed",requireAdmin,async(req:Request,res:Response)=>{
    const parsed=z.object({
      holidayCheckConfirmed:z.literal(true),
      note:z.string().max(10000).nullable().optional(),
    }).safeParse(req.body||{});
    if(!parsed.success)return res.status(400).json({error:"Confirme a checagem de feriados antes de usar a confirmação presumida"});
    try{
      const id=Number(one(req.params.id));
      const current=await registrationViewById(id);
      if(!current)return res.status(404).json({error:"Registro de cliente não encontrado"});
      if(current.status!=="sent")return res.status(409).json({error:"Apenas registros enviados e ainda sem resposta podem ser confirmados por decurso de prazo"});
      if(!current.response_due_at||Date.now()<new Date(current.response_due_at).getTime()){
        return res.status(409).json({error:"O prazo estimado de cinco Business Days ainda não venceu"});
      }
      const confirmationDate=new Date(current.response_due_at).toISOString().slice(0,10);
      const {rows}=await pool.query(`
        UPDATE partner_client_registrations SET
          status='deemed_confirmed',confirmation_date=$2::date,
          partner_response=COALESCE($3,partner_response),updated_at=NOW()
        WHERE id=$1 RETURNING id
      `,[id,confirmationDate,parsed.data.note??"No partner response recorded within the validated five-Business-Day period."]);
      if(!rows[0])return res.status(404).json({error:"Registro de cliente não encontrado"});
      return res.json(await registrationViewById(id));
    }catch(error){return fail(res,error);}
  });
}
