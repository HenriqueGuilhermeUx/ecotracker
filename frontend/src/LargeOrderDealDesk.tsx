import { type FormEvent, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import "./deal-desk.css";

type Json = Record<string, any>;
const n=(v:unknown)=>{const x=Number(v||0);return Number.isFinite(x)?x:0};
const tons=(v:unknown)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:3}).format(n(v));
const money=(v:unknown)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(n(v));
const requestId=()=>crypto.randomUUID();

export function LargeOrderDealDesk(){
  const token=localStorage.getItem("ecotracker_admin_token");
  if(!token) return <MarketShell><main className="deal-desk locked"><span className="tag">LARGE CORPORATE ORDER</span><h1>Deal Desk</h1><p>Use a sessão administrativa da Carbon Desk para abrir ordens corporativas.</p><a className="deal-primary" href="#carbon-desk">Entrar no Carbon Desk</a></main></MarketShell>;
  return <DealDeskPanel/>;
}

function DealDeskPanel(){
  const [clientRequestId,setClientRequestId]=useState(requestId());
  const [companyName,setCompanyName]=useState("");
  const [taxId,setTaxId]=useState("");
  const [contactName,setContactName]=useState("");
  const [contactEmail,setContactEmail]=useState("");
  const [targetTonnes,setTargetTonnes]=useState("10000");
  const [claimPurpose,setClaimPurpose]=useState("voluntary_offset");
  const [targetYear,setTargetYear]=useState(String(new Date().getFullYear()));
  const [maxPrice,setMaxPrice]=useState("");
  const [registry,setRegistry]=useState("");
  const [country,setCountry]=useState("");
  const [projectType,setProjectType]=useState("");
  const [notes,setNotes]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [result,setResult]=useState<Json|null>(null);

  async function runSourcing(opportunityId:number,existing?:Json|null){
    const sourcing=await api<Json>(`/admin/demand/opportunities/${opportunityId}/rfq`,{method:"POST",body:"{}"});
    const matching=sourcing.matching||{};
    let proposal:Json|null=existing?.proposal||null; let basket:Json|null=existing?.basket||null;
    if(matching.fullyCovered&&!proposal){
      proposal=await api<Json>(`/admin/demand/opportunities/${opportunityId}/proposal`,{method:"POST",body:JSON.stringify({validityMinutes:1440,notes:"Large Corporate Deal Desk · revisão comercial obrigatória antes do envio."})});
      if(proposal.basketQuoteRequired||proposal.checkout_mode==="basket_quote_required"){
        basket=await api<Json>(`/admin/demand/proposals/${proposal.id}/basket`,{method:"POST",body:JSON.stringify({notes:"Large Corporate Deal Desk · basket interno; checkout permanece desabilitado."})});
      }
    }
    return {sourcing,proposal,basket,review:existing?.review||null,conversion:existing?.conversion||null};
  }

  async function submit(event:FormEvent){
    event.preventDefault(); setBusy(true); setMessage(""); setResult(null);
    try{
      const cleanTax=taxId.replace(/\D/g,"");
      const account=await api<Json>("/admin/demand/accounts",{method:"POST",body:JSON.stringify({
        source:"deal_desk",sourceReference:cleanTax?`buyer:${cleanTax}`:`request:${clientRequestId}`,
        companyName,taxId:taxId||null,country:"Brasil",contactName:contactName||null,contactEmail:contactEmail||null,
        leadScore:100,notes:notes||null,metadata:{dealDesk:true,inboundIntent:"buy_carbon_credits",clientRequestId},
      })});
      const opportunity=await api<Json>(`/admin/demand/accounts/${account.id}/opportunities`,{method:"POST",body:JSON.stringify({
        targetTonnes:Number(targetTonnes),targetBasis:"custom",claimPurpose,targetYear:Number(targetYear)||null,
        maxPriceUsdTonne:maxPrice?Number(maxPrice):null,preferredCountry:country||null,preferredRegistry:registry||null,
        preferredProjectType:projectType||null,priorityScore:100,constraints:{dealDesk:true,clientRequestId,commercialReviewRequired:true},notes:notes||null,
      })});
      const flow=await runSourcing(Number(opportunity.id));
      setResult({account,opportunity,...flow});
      setMessage(flow.sourcing?.matching?.fullyCovered?"Cobertura claim-ready integral encontrada. Revise o ativo e aprove o snapshot comercial.":"Ordem aberta e RFQ de supply materializado para o gap.");
      setClientRequestId(requestId());
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function refresh(){
    if(!result?.opportunity?.id)return;
    setBusy(true);setMessage("");
    try{const flow=await runSourcing(Number(result.opportunity.id),result);setResult({...result,...flow});setMessage(flow.sourcing?.matching?.fullyCovered?"Cobertura integral preservada. Revise a proposta antes da cotação.":"Matching e RFQ atualizados.")}catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function approve(){
    if(!result?.proposal?.id)return;
    setBusy(true);setMessage("");
    try{
      const review=await api<Json>(`/admin/demand/proposals/${result.proposal.id}/review/approve`,{method:"POST",body:JSON.stringify({reviewedBy:"Deal Desk",note:"Snapshot aprovado manualmente no Large Corporate Order Deal Desk."})});
      setResult({...result,review});
      setMessage("Snapshot comercial aprovado e congelado com SHA-256. Nenhuma mensagem foi enviada ao comprador.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function convert(){
    if(!result?.proposal?.id)return;
    if(!(result.account?.contact_email||contactEmail)){
      setMessage("Para converter a proposta em cotação, abra o pedido com um e-mail válido do contato comprador. O backend exige e-mail antes de criar quote_request.");
      return;
    }
    if(!result.review){setMessage("Aprove primeiro o snapshot comercial.");return;}
    setBusy(true);setMessage("");
    try{
      const conversion=await api<Json>(`/admin/demand/proposals/${result.proposal.id}/convert-single`,{method:"POST",body:"{}"});
      setResult({...result,conversion});
      setMessage(conversion.checkoutReady?"Cotação single-asset criada e revalidada. Checkout NÃO foi acionado.":conversion.message||"Cotação criada em modo assistido. Checkout permanece bloqueado.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  const matching=result?.sourcing?.matching||{};
  const gap=n(matching.uncoveredTonnes);
  const coverage=n(matching.coveragePct);
  const items:Array<Json>=Array.isArray(result?.proposal?.snapshot?.items)?result.proposal.snapshot.items:[];
  const singleAsset=result?.proposal?.checkout_mode==="single_asset_quote"||result?.proposal?.checkoutMode==="single_asset_quote";
  const buyerEmail=result?.account?.contact_email||contactEmail||"";
  return <MarketShell><main className="deal-desk">
    <header className="deal-head"><div><span className="tag">LARGE CORPORATE ORDER</span><h1>Deal Desk</h1><p>Pedido inbound → matching → proposta → revisão → cotação.</p></div><div><a className="deal-secondary" href="#carbon-desk">Carbon Desk</a><a className="deal-secondary" href="#market-admin">Operação</a></div></header>
    <section className="deal-safety"><b>SAFE MODE</b><span>Revisão e conversão de proposta são internas. Este fluxo não envia e-mail, não abre checkout, não cobra dinheiro e não executa purchase/retirement automaticamente.</span></section>
    {message&&<div className="deal-message">{message}</div>}
    <div className="deal-layout"><form className="deal-form" onSubmit={submit}>
      <h2>Abrir ordem corporativa</h2><label>Empresa<input required value={companyName} onChange={e=>setCompanyName(e.target.value)} placeholder="Empresa compradora"/></label>
      <div className="deal-two"><label>CNPJ<input value={taxId} onChange={e=>setTaxId(e.target.value)} placeholder="00.000.000/0000-00"/></label><label>Contato<input value={contactName} onChange={e=>setContactName(e.target.value)} placeholder="Nome"/></label></div>
      <label>E-mail do comprador<input type="email" value={contactEmail} onChange={e=>setContactEmail(e.target.value)} placeholder="compras@empresa.com"/><small>Necessário somente para converter uma proposta single-asset em quote_request. Nada é enviado sem dispatch explícito.</small></label>
      <div className="deal-two"><label>Volume tCO₂e<input required type="number" min="0.001" step="0.001" value={targetTonnes} onChange={e=>setTargetTonnes(e.target.value)}/></label><label>Ano alvo<input type="number" value={targetYear} onChange={e=>setTargetYear(e.target.value)}/></label></div>
      <div className="deal-two"><label>Claim<select value={claimPurpose} onChange={e=>setClaimPurpose(e.target.value)}><option value="voluntary_offset">Compensação voluntária</option><option value="climate_contribution">Contribuição climática</option><option value="compliance">Compliance</option></select></label><label>Preço máx. US$/t<input type="number" min="0" step="0.01" value={maxPrice} onChange={e=>setMaxPrice(e.target.value)} placeholder="opcional"/></label></div>
      <div className="deal-two"><label>Registry preferido<select value={registry} onChange={e=>setRegistry(e.target.value)}><option value="">Qualquer</option><option>Verra VCS</option><option>Puro.earth</option><option>American Carbon Registry</option><option>Gold Standard</option></select></label><label>País preferido<input value={country} onChange={e=>setCountry(e.target.value)} placeholder="opcional"/></label></div>
      <label>Tipo de projeto<input value={projectType} onChange={e=>setProjectType(e.target.value)} placeholder="REDD+, biochar, reflorestamento..."/></label><label>Notas<textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={3}/></label>
      <button className="deal-primary" disabled={busy}>{busy?"Rodando matching...":"Abrir ordem e buscar supply"}</button>
    </form>
    <section className="deal-result"><h2>Status da ordem</h2>{!result?<div className="deal-empty">Abra uma ordem para o motor montar a cobertura.</div>:<>
      <div className="deal-company"><div><b>{result.account?.company_name}</b><small>Opportunity #{result.opportunity?.id}</small></div><strong>{tons(matching.targetTonnes)} t</strong></div>
      <div className="deal-progress"><i style={{width:`${Math.min(100,coverage)}%`}}/></div>
      <div className="deal-kpis"><span><small>Coberto</small><b>{tons(matching.coveredTonnes)} t</b></span><span><small>Gap</small><b>{tons(gap)} t</b></span><span><small>Cobertura</small><b>{coverage.toFixed(1)}%</b></span></div>
      <div className="deal-stage"><span className={matching.fullyCovered?"ok":"warn"}>{matching.fullyCovered?"COBERTURA INTEGRAL":"SOURCING REQUIRED"}</span><p>{matching.fullyCovered?"Créditos claim-ready cobrem o pedido. Próximo passo: revisão comercial.":`RFQ #${result.sourcing?.rfq?.id||"—"} aberto para ${tons(gap)} t.`}</p></div>
      {result.proposal&&<div className="deal-artifact"><small>PROPOSTA</small><b>{result.proposal.public_code?.slice(0,8)} · {result.proposal.checkout_mode}</b><span>{result.proposal.final_total_brl?`${money(result.proposal.final_total_brl)} · ${money(result.proposal.price_per_tonne_brl)}/t`:"Preço final depende da confirmação das legs"}</span></div>}
      {items.map((item,index)=><div className="deal-asset" key={`${item.assetId}-${index}`}><div><small>ATIVO CLAIM-READY</small><b>{item.projectName||`Ativo #${item.assetId}`}</b><span>{item.registry||"registry n/d"} · vintage {item.vintage||"n/d"}</span></div><div><strong>{tons(item.amountTonnes)} t</strong><small>{item.executionMode||"assisted"}</small></div></div>)}
      {result.proposal&&matching.fullyCovered&&!result.review&&<button className="deal-primary full" disabled={busy} onClick={()=>void approve()}>{busy?"Aprovando...":"Aprovar snapshot comercial"}</button>}
      {result.review&&<div className="deal-review"><b>REVISÃO APROVADA</b><span>SHA {String(result.review.snapshot_sha256||"").slice(0,16)}…</span><small>Nenhum e-mail enviado.</small></div>}
      {result.review&&singleAsset&&!result.conversion&&<><div className={`deal-email ${buyerEmail?"ok":"warn"}`}><b>{buyerEmail?"E-mail pronto para quote_request":"E-mail obrigatório para conversão"}</b><span>{buyerEmail||"Cadastre um e-mail válido no pedido de teste."}</span></div><button className="deal-secondary full" disabled={busy||!buyerEmail} onClick={()=>void convert()}>{busy?"Convertendo...":"Converter para cotação single-asset"}</button></>}
      {result.conversion&&<div className="deal-quote"><small>QUOTE_REQUEST</small><b>{result.conversion.quote?.public_code?.slice(0,8)||`#${result.conversion.quote?.id||"—"}`} · {result.conversion.quote?.status||"criada"}</b><span>{result.conversion.quote?.requested_kg?`${tons(n(result.conversion.quote.requested_kg)/1000)} t`:""}{result.conversion.quote?.final_total?` · ${money(result.conversion.quote.final_total)}`:""}</span><em>{result.conversion.checkoutReady?"Cotação pronta; checkout não acionado.":"Modo assistido; reconfirmar fonte/estoque/custo antes de checkout."}</em></div>}
      {result.basket&&<div className="deal-artifact"><small>BASKET</small><b>{result.basket.public_code?.slice(0,8)} · {result.basket.status}</b><span>Checkout: OFF · confirmar legs antes da reserva.</span></div>}
      <button className="deal-secondary full" disabled={busy} onClick={()=>void refresh()}>{busy?"Atualizando...":"Recalcular sourcing"}</button>
    </>}</section></div>
  </main></MarketShell>;
}
