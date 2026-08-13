import { type FormEvent, useEffect, useState } from "react";
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
  const [assistedQuotes,setAssistedQuotes]=useState<Array<Json>>([]);
  const [assistedQuote,setAssistedQuote]=useState<Json|null>(null);
  const [sourceReview,setSourceReview]=useState<Json|null>(null);
  const [sourceCostBrl,setSourceCostBrl]=useState("");
  const [sourceReference,setSourceReference]=useState("");
  const [sourceEvidenceUrl,setSourceEvidenceUrl]=useState("");
  const [sourceAvailableKg,setSourceAvailableKg]=useState("");
  const [quoteTtlMinutes,setQuoteTtlMinutes]=useState("30");
  const [sourceNotes,setSourceNotes]=useState("");
  const [clientAgreement,setClientAgreement]=useState<Json|null>(null);
  const [agreementConfig,setAgreementConfig]=useState<Json|null>(null);

  async function loadAssistedQuotes(preferId?:number){
    const data=await api<Json>("/admin/market/assisted-sourcing?limit=40");
    const items:Array<Json>=Array.isArray(data.items)?data.items:[];
    setAssistedQuotes(items);
    const wanted=preferId?items.find(item=>Number(item.id)===preferId):assistedQuote?items.find(item=>Number(item.id)===Number(assistedQuote.id)):null;
    if(wanted) setAssistedQuote(wanted);
    return {items,wanted};
  }

  async function loadSourceReview(quoteId:number){
    try{const review=await api<Json>(`/admin/market/assisted-sourcing/${quoteId}/review`);setSourceReview(review);return review}
    catch{setSourceReview(null);return null}
  }

  async function loadAgreement(quoteId:number){
    try{
      const [agreement,config]=await Promise.all([
        api<Json>(`/admin/market/assisted-sourcing/${quoteId}/agreement`),
        api<Json>("/admin/market/client-agreements/config"),
      ]);
      setClientAgreement(agreement);setAgreementConfig(config);return agreement;
    }catch{setClientAgreement(null);return null}
  }

  useEffect(()=>{void loadAssistedQuotes().catch(()=>undefined);void api<Json>("/admin/market/client-agreements/config").then(setAgreementConfig).catch(()=>undefined)},[]);

  async function selectAssisted(quoteId:number){
    const quote=assistedQuotes.find(item=>Number(item.id)===quoteId)||null;
    setAssistedQuote(quote);setSourceReview(null);setClientAgreement(null);
    setSourceCostBrl("");setSourceReference("");setSourceEvidenceUrl("");setSourceNotes("");
    setSourceAvailableKg(quote?.requested_kg?String(quote.requested_kg):"");
    if(quote) await Promise.all([loadSourceReview(Number(quote.id)),loadAgreement(Number(quote.id))]);
  }

  async function runSourcing(opportunityId:number,existing?:Json|null){
    const sourcing=await api<Json>(`/admin/demand/opportunities/${opportunityId}/rfq`,{method:"POST",body:"{}"});
    const matching=sourcing.matching||{};
    let proposal:Json|null=existing?.proposal||null; let basket:Json|null=existing?.basket||null;
    if(matching.fullyCovered&&!proposal){
      proposal=await api<Json>(`/admin/demand/opportunities/${opportunityId}/proposal`,{method:"POST",body:JSON.stringify({validityMinutes:1440,notes:"Large Corporate Deal Desk · revisão comercial obrigatória antes do envio."})});
      if(proposal.basketQuoteRequired||proposal.checkout_mode==="basket_quote_required") basket=await api<Json>(`/admin/demand/proposals/${proposal.id}/basket`,{method:"POST",body:JSON.stringify({notes:"Large Corporate Deal Desk · basket interno; checkout permanece desabilitado."})});
    }
    return {sourcing,proposal,basket,review:existing?.review||null,conversion:existing?.conversion||null};
  }

  async function submit(event:FormEvent){
    event.preventDefault(); setBusy(true); setMessage(""); setResult(null);
    try{
      const cleanTax=taxId.replace(/\D/g,"");
      const account=await api<Json>("/admin/demand/accounts",{method:"POST",body:JSON.stringify({source:"deal_desk",sourceReference:cleanTax?`buyer:${cleanTax}`:`request:${clientRequestId}`,companyName,taxId:taxId||null,country:"Brasil",contactName:contactName||null,contactEmail:contactEmail||null,leadScore:100,notes:notes||null,metadata:{dealDesk:true,inboundIntent:"buy_carbon_credits",clientRequestId}})});
      const opportunity=await api<Json>(`/admin/demand/accounts/${account.id}/opportunities`,{method:"POST",body:JSON.stringify({targetTonnes:Number(targetTonnes),targetBasis:"custom",claimPurpose,targetYear:Number(targetYear)||null,maxPriceUsdTonne:maxPrice?Number(maxPrice):null,preferredCountry:country||null,preferredRegistry:registry||null,preferredProjectType:projectType||null,priorityScore:100,constraints:{dealDesk:true,clientRequestId,commercialReviewRequired:true},notes:notes||null})});
      const flow=await runSourcing(Number(opportunity.id));setResult({account,opportunity,...flow});
      setMessage(flow.sourcing?.matching?.fullyCovered?"Cobertura claim-ready integral encontrada. Revise o ativo e aprove o snapshot comercial.":"Ordem aberta e RFQ de supply materializado para o gap.");setClientRequestId(requestId());
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function refresh(){
    if(!result?.opportunity?.id)return;setBusy(true);setMessage("");
    try{const flow=await runSourcing(Number(result.opportunity.id),result);setResult({...result,...flow});setMessage(flow.sourcing?.matching?.fullyCovered?"Cobertura integral preservada. Revise a proposta antes da cotação.":"Matching e RFQ atualizados.")}catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function approve(){
    if(!result?.proposal?.id)return;setBusy(true);setMessage("");
    try{const review=await api<Json>(`/admin/demand/proposals/${result.proposal.id}/review/approve`,{method:"POST",body:JSON.stringify({reviewedBy:"Deal Desk",note:"Snapshot aprovado manualmente no Large Corporate Order Deal Desk."})});setResult({...result,review});setMessage("Snapshot comercial aprovado e congelado com SHA-256. Nenhuma mensagem foi enviada ao comprador.")}catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function convert(){
    if(!result?.proposal?.id)return;if(!(result.account?.contact_email||contactEmail)){setMessage("Para converter a proposta em cotação, abra o pedido com um e-mail válido do contato comprador.");return}if(!result.review){setMessage("Aprove primeiro o snapshot comercial.");return}
    setBusy(true);setMessage("");
    try{
      const conversion=await api<Json>(`/admin/demand/proposals/${result.proposal.id}/convert-single`,{method:"POST",body:"{}"});setResult({...result,conversion});
      if(conversion.quote?.id&&!conversion.checkoutReady){const loaded=await loadAssistedQuotes(Number(conversion.quote.id));const selected=loaded.wanted||loaded.items.find(item=>Number(item.id)===Number(conversion.quote.id));if(selected){setAssistedQuote(selected);setSourceAvailableKg(String(selected.requested_kg||""));await Promise.all([loadSourceReview(Number(selected.id)),loadAgreement(Number(selected.id))])}}
      setMessage(conversion.checkoutReady?"Cotação single-asset criada e revalidada. Checkout NÃO foi acionado.":conversion.message||"Cotação criada em modo assistido. Confirme agora fonte, estoque e custo.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function confirmSource(){
    if(!assistedQuote?.id)return;if(!sourceCostBrl||!sourceReference||!sourceAvailableKg){setMessage("Informe custo total da fonte, referência da confirmação e estoque confirmado.");return}
    setBusy(true);setMessage("");
    try{
      const confirmed=await api<Json>(`/admin/market/assisted-sourcing/${assistedQuote.id}/confirm-source`,{method:"POST",body:JSON.stringify({sourceCostBrl:Number(sourceCostBrl),sourceReference,sourceEvidenceUrl:sourceEvidenceUrl||null,sourceAvailableKg:Number(sourceAvailableKg),quoteTtlMinutes:Number(quoteTtlMinutes)||30,notes:sourceNotes||null})});
      await loadAssistedQuotes(Number(assistedQuote.id));setSourceReview(null);await loadAgreement(Number(assistedQuote.id));setMessage(confirmed.message||"Fonte confirmada e cotação reprificada. Nova aprovação comercial obrigatória.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function approveRepricedQuote(){
    if(!assistedQuote?.id)return;setBusy(true);setMessage("");
    try{
      const approved=await api<Json>(`/admin/market/assisted-sourcing/${assistedQuote.id}/review/approve`,{method:"POST",body:JSON.stringify({reviewedBy:"Deal Desk",note:"Preço pós-sourcing aprovado manualmente no Large Corporate Order Deal Desk."})});
      setSourceReview(approved);await loadAssistedQuotes(Number(assistedQuote.id));await loadAgreement(Number(assistedQuote.id));setMessage(approved.message||"Cotação reprificada aprovada. Checkout não foi criado.");
    }catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function generateAgreement(){
    if(!assistedQuote?.id)return;setBusy(true);setMessage("");
    try{const generated=await api<Json>(`/admin/market/assisted-sourcing/${assistedQuote.id}/agreement/generate`,{method:"POST",body:"{}"});setClientAgreement(generated);setAgreementConfig(generated.provider?{configured:generated.provider.configured,missing:generated.provider.missing}:agreementConfig);setMessage(generated.message||"Contrato gerado.")}catch(error){setMessage((error as Error).message)}finally{setBusy(false)}
  }

  async function copyAgreementLink(){
    const link=clientAgreement?.shareUrl;if(!link)return;
    try{await navigator.clipboard.writeText(link);setMessage("Link do contrato copiado. Nenhum e-mail foi enviado automaticamente.")}catch{setMessage(link)}
  }

  const matching=result?.sourcing?.matching||{};const gap=n(matching.uncoveredTonnes);const coverage=n(matching.coveragePct);
  const items:Array<Json>=Array.isArray(result?.proposal?.snapshot?.items)?result.proposal.snapshot.items:[];
  const singleAsset=result?.proposal?.checkout_mode==="single_asset_quote"||result?.proposal?.checkoutMode==="single_asset_quote";
  const buyerEmail=result?.account?.contact_email||contactEmail||"";
  const assistedPricing:Json=assistedQuote?.pricing_snapshot&&typeof assistedQuote.pricing_snapshot==="object"?assistedQuote.pricing_snapshot:{};
  const assistedReviewCurrent=Boolean(assistedQuote?.commercialReviewCurrent||sourceReview?.current);
  const sourceConfirmed=assistedQuote?.sourcing_status==="manual_source_confirmed";
  const requestedKg=n(assistedQuote?.requested_kg);
  const agreementRecord=clientAgreement?.agreement||null;
  const agreementCurrent=Boolean(clientAgreement?.current);
  const agreementAccepted=Boolean(clientAgreement?.acceptedCurrent||(agreementCurrent&&agreementRecord?.status==="accepted"));

  return <MarketShell><main className="deal-desk">
    <header className="deal-head"><div><span className="tag">LARGE CORPORATE ORDER</span><h1>Deal Desk</h1><p>Pedido inbound → matching → proposta → revisão → sourcing → contrato → pagamento.</p></div><div><a className="deal-secondary" href="#carbon-desk">Carbon Desk</a><a className="deal-secondary" href="#market-admin">Operação</a></div></header>
    <section className="deal-safety"><b>SAFE MODE</b><span>Confirmação de sourcing, contrato e aprovações são gates separados. Este fluxo não cria checkout, não cobra dinheiro e não executa purchase/retirement automaticamente.</span></section>
    {message&&<div className="deal-message">{message}</div>}
    <div className="deal-layout"><form className="deal-form" onSubmit={submit}>
      <h2>Abrir ordem corporativa</h2><label>Empresa<input required value={companyName} onChange={e=>setCompanyName(e.target.value)} placeholder="Empresa compradora"/></label>
      <div className="deal-two"><label>CNPJ<input value={taxId} onChange={e=>setTaxId(e.target.value)} placeholder="00.000.000/0000-00"/></label><label>Contato<input value={contactName} onChange={e=>setContactName(e.target.value)} placeholder="Nome"/></label></div>
      <label>E-mail do comprador<input type="email" value={contactEmail} onChange={e=>setContactEmail(e.target.value)} placeholder="compras@empresa.com"/><small>Necessário para quote_request e contrato. Nada é enviado sem ação explícita.</small></label>
      <div className="deal-two"><label>Volume tCO₂e<input required type="number" min="0.001" step="0.001" value={targetTonnes} onChange={e=>setTargetTonnes(e.target.value)}/></label><label>Ano alvo<input type="number" value={targetYear} onChange={e=>setTargetYear(e.target.value)}/></label></div>
      <div className="deal-two"><label>Claim<select value={claimPurpose} onChange={e=>setClaimPurpose(e.target.value)}><option value="voluntary_offset">Compensação voluntária</option><option value="climate_contribution">Contribuição climática</option><option value="compliance">Compliance</option></select></label><label>Preço máx. US$/t<input type="number" min="0" step="0.01" value={maxPrice} onChange={e=>setMaxPrice(e.target.value)} placeholder="opcional"/></label></div>
      <div className="deal-two"><label>Registry preferido<select value={registry} onChange={e=>setRegistry(e.target.value)}><option value="">Qualquer</option><option>Verra VCS</option><option>Puro.earth</option><option>American Carbon Registry</option><option>Gold Standard</option></select></label><label>País preferido<input value={country} onChange={e=>setCountry(e.target.value)} placeholder="opcional"/></label></div>
      <label>Tipo de projeto<input value={projectType} onChange={e=>setProjectType(e.target.value)} placeholder="REDD+, biochar, reflorestamento..."/></label><label>Notas<textarea value={notes} onChange={e=>setNotes(e.target.value)} rows={3}/></label>
      <button className="deal-primary" disabled={busy}>{busy?"Rodando matching...":"Abrir ordem e buscar supply"}</button>
    </form>
    <section className="deal-result"><h2>Status da ordem</h2>{!result?<div className="deal-empty">Abra uma nova ordem ou retome uma quote_request assistida abaixo.</div>:<>
      <div className="deal-company"><div><b>{result.account?.company_name}</b><small>Opportunity #{result.opportunity?.id}</small></div><strong>{tons(matching.targetTonnes)} t</strong></div>
      <div className="deal-progress"><i style={{width:`${Math.min(100,coverage)}%`}}/></div>
      <div className="deal-kpis"><span><small>Coberto</small><b>{tons(matching.coveredTonnes)} t</b></span><span><small>Gap</small><b>{tons(gap)} t</b></span><span><small>Cobertura</small><b>{coverage.toFixed(1)}%</b></span></div>
      <div className="deal-stage"><span className={matching.fullyCovered?"ok":"warn"}>{matching.fullyCovered?"COBERTURA INTEGRAL":"SOURCING REQUIRED"}</span><p>{matching.fullyCovered?"Créditos claim-ready cobrem o pedido. Próximo passo: revisão comercial.":`RFQ #${result.sourcing?.rfq?.id||"—"} aberto para ${tons(gap)} t.`}</p></div>
      {result.proposal&&<div className="deal-artifact"><small>PROPOSTA</small><b>{result.proposal.public_code?.slice(0,8)} · {result.proposal.checkout_mode}</b><span>{result.proposal.final_total_brl?`${money(result.proposal.final_total_brl)} · ${money(result.proposal.price_per_tonne_brl)}/t`:"Preço final depende da confirmação das legs"}</span></div>}
      {items.map((item,index)=><div className="deal-asset" key={`${item.assetId}-${index}`}><div><small>ATIVO CLAIM-READY</small><b>{item.projectName||`Ativo #${item.assetId}`}</b><span>{item.registry||"registry n/d"} · vintage {item.vintage||"n/d"}</span></div><div><strong>{tons(item.amountTonnes)} t</strong><small>{item.executionMode||"assisted"}</small></div></div>)}
      {result.proposal&&matching.fullyCovered&&!result.review&&<button type="button" className="deal-primary full" disabled={busy} onClick={()=>void approve()}>{busy?"Aprovando...":"Aprovar snapshot comercial"}</button>}
      {result.review&&<div className="deal-review"><b>REVISÃO APROVADA</b><span>SHA {String(result.review.snapshot_sha256||"").slice(0,16)}…</span><small>Nenhum e-mail enviado.</small></div>}
      {result.review&&singleAsset&&!result.conversion&&<><div className={`deal-email ${buyerEmail?"ok":"warn"}`}><b>{buyerEmail?"E-mail pronto para quote_request":"E-mail obrigatório para conversão"}</b><span>{buyerEmail||"Cadastre um e-mail válido no pedido de teste."}</span></div><button type="button" className="deal-secondary full" disabled={busy||!buyerEmail} onClick={()=>void convert()}>{busy?"Convertendo...":"Converter para cotação single-asset"}</button></>}
      {result.conversion&&<div className="deal-quote"><small>QUOTE_REQUEST</small><b>{result.conversion.quote?.public_code?.slice(0,8)||`#${result.conversion.quote?.id||"—"}`} · {result.conversion.quote?.status||"criada"}</b><span>{result.conversion.quote?.requested_kg?`${tons(n(result.conversion.quote.requested_kg)/1000)} t`:""}{result.conversion.quote?.final_total?` · ${money(result.conversion.quote.final_total)}`:""}</span><em>{result.conversion.checkoutReady?"Cotação pronta; checkout não acionado.":"Modo assistido; confirmar fonte/estoque/custo antes de checkout."}</em></div>}
      {result.basket&&<div className="deal-artifact"><small>BASKET</small><b>{result.basket.public_code?.slice(0,8)} · {result.basket.status}</b><span>Checkout: OFF · confirmar legs antes da reserva.</span></div>}
      <button type="button" className="deal-secondary full" disabled={busy} onClick={()=>void refresh()}>{busy?"Atualizando...":"Recalcular sourcing"}</button>
    </>}

      <div className="deal-sourcing-divider"><span>SOURCING + CLIENT AGREEMENT GATES</span></div>
      <label className="deal-resume">Retomar quote_request assistida<select value={assistedQuote?.id||""} onChange={e=>void selectAssisted(Number(e.target.value))}><option value="">Selecione...</option>{assistedQuotes.map(q=><option value={q.id} key={q.id}>{String(q.public_code||"").slice(0,8)} · {q.project_name||q.registry} · {tons(n(q.requested_kg)/1000)} t · {q.nextAction}</option>)}</select></label>
      {assistedQuote&&<div className="deal-source-panel">
        <div className="deal-source-head"><div><small>QUOTE ASSISTIDA</small><b>{String(assistedQuote.public_code||"").slice(0,8)} · {assistedQuote.status}</b><span>{assistedQuote.project_name} · {assistedQuote.registry} · vintage {assistedQuote.vintage||"n/d"}</span></div><strong>{tons(requestedKg/1000)} t</strong></div>
        <div className="deal-monitor"><span><small>DISPONÍVEL MONITORADO</small><b>{assistedQuote.available_tons==null?"n/d":`${tons(assistedQuote.available_tons)} t`}</b></span><span><small>PREÇO MONITORADO</small><b>{assistedPricing.monitoredSourcePriceUsdTon?`US$ ${n(assistedPricing.monitoredSourcePriceUsdTon).toFixed(2)}/t`:"n/d"}</b></span></div>
        {assistedQuote.sourcePreview&&<a className="deal-source-link" href={assistedQuote.sourcePreview} target="_blank" rel="noreferrer">Abrir fonte/evidência monitorada ↗</a>}
        {!sourceConfirmed?<div className="deal-source-form"><p><b>Confirmação manual obrigatória.</b> O valor abaixo é o custo TOTAL para adquirir as {tons(requestedKg/1000)} t — não o preço por tonelada.</p>
          <label>Custo total confirmado da fonte (R$)<input type="number" min="0.01" step="0.01" value={sourceCostBrl} onChange={e=>setSourceCostBrl(e.target.value)} placeholder="Ex.: 600000,00"/></label>
          <label>Estoque confirmado (kg)<input type="number" min={requestedKg||1} step="1" value={sourceAvailableKg} onChange={e=>setSourceAvailableKg(e.target.value)}/><small>Para 10.000 t, precisa ser no mínimo 10.000.000 kg.</small></label>
          <label>Referência da confirmação<input value={sourceReference} onChange={e=>setSourceReference(e.target.value)} placeholder="ID da cotação, orderbook, e-mail/quote do fornecedor..."/></label>
          <label>URL de evidência<input type="url" value={sourceEvidenceUrl} onChange={e=>setSourceEvidenceUrl(e.target.value)} placeholder="https://... (opcional)"/></label>
          <div className="deal-two"><label>Validade (min)<input type="number" min="5" max="1440" value={quoteTtlMinutes} onChange={e=>setQuoteTtlMinutes(e.target.value)}/></label><label>Notas<input value={sourceNotes} onChange={e=>setSourceNotes(e.target.value)} placeholder="opcional"/></label></div>
          <button type="button" className="deal-primary full" disabled={busy||!sourceCostBrl||!sourceReference||n(sourceAvailableKg)<requestedKg} onClick={()=>void confirmSource()}>{busy?"Confirmando...":"Confirmar fonte, estoque e custo"}</button>
        </div>:<div className="deal-source-confirmed"><b>FONTE CONFIRMADA · REPRIFICADA</b><div className="deal-kpis"><span><small>Custo fonte</small><b>{money(assistedQuote.source_cost_brl)}</b></span><span><small>Preço venda</small><b>{money(assistedQuote.final_total)}</b></span><span><small>Preço / t</small><b>{money(n(assistedQuote.final_total)/(requestedKg/1000))}</b></span></div><small>Referência: {assistedQuote.sourcing_reference||"—"} · validade até {assistedQuote.quote_expires_at?new Date(assistedQuote.quote_expires_at).toLocaleString("pt-BR"):"n/d"}</small></div>}
        {sourceConfirmed&&!assistedReviewCurrent&&<div className="deal-reapproval"><b>NOVA APROVAÇÃO OBRIGATÓRIA</b><span>A confirmação da fonte alterou o preço executável. A aprovação da proposta anterior não libera checkout.</span><button type="button" className="deal-primary full" disabled={busy} onClick={()=>void approveRepricedQuote()}>{busy?"Aprovando...":"Aprovar cotação reprificada"}</button></div>}
        {sourceConfirmed&&assistedReviewCurrent&&<div className="deal-execution-ready"><b>COTAÇÃO COMERCIALMENTE APROVADA</b><span>SHA {String(sourceReview?.review?.snapshot_sha256||assistedQuote.commercial_review_sha256||"").slice(0,16)}…</span><small>Fonte + estoque + custo + preço estão congelados. Agora o contrato do cliente é obrigatório antes do pagamento.</small></div>}

        {sourceConfirmed&&assistedReviewCurrent&&<div className="deal-contract-gate"><div className="deal-contract-head"><div><small>CLIENT AGREEMENT GATE</small><b>Contrato de aquisição e aposentadoria</b></div><span className={agreementAccepted?"ok":agreementCurrent?"warn":"pending"}>{agreementAccepted?"ACEITO":agreementCurrent?(agreementRecord?.status==="draft"?"RASCUNHO":"AGUARDANDO CLIENTE"):"NÃO GERADO"}</span></div>
          {!agreementCurrent&&<button type="button" className="deal-primary full" disabled={busy} onClick={()=>void generateAgreement()}>{busy?"Gerando...":"Gerar contrato do cliente"}</button>}
          {agreementCurrent&&agreementRecord&&<div className="deal-contract-card"><div><small>CONTRATO</small><b>{String(agreementRecord.public_code||"").slice(0,8)} · v{agreementRecord.version}</b></div><div><small>DOCUMENT SHA</small><code>{String(agreementRecord.document_sha256||"").slice(0,18)}…</code></div></div>}
          {agreementCurrent&&agreementRecord?.status==="draft"&&<div className="deal-contract-warning"><b>RASCUNHO — NÃO ENVIAR</b><span>Faltam dados jurídicos da CONTRATADA no Render: {(agreementConfig?.missing||clientAgreement?.provider?.missing||[]).join(", ")||"verifique a configuração"}.</span><button type="button" className="deal-secondary full" disabled={busy} onClick={()=>void generateAgreement()}>Regenerar após configurar identidade</button></div>}
          {agreementCurrent&&agreementRecord?.status==="awaiting_signature"&&<div className="deal-contract-actions"><a className="deal-secondary" href={clientAgreement?.shareUrl} target="_blank" rel="noreferrer">Abrir contrato ↗</a><button type="button" className="deal-secondary" onClick={()=>void copyAgreementLink()}>Copiar link para cliente</button><span>Checkout continua bloqueado até o aceite.</span></div>}
          {agreementAccepted&&<div className="deal-contract-accepted"><b>CONTRATO ACEITO ✓</b><span>{agreementRecord?.accepted_by_name||"Representante registrado"} · {agreementRecord?.accepted_at?new Date(agreementRecord.accepted_at).toLocaleString("pt-BR"):"aceite registrado"}</span><small>PAYMENT GATE ELIGIBLE · pagamento continua dependendo de ação explícita.</small></div>}
        </div>}
      </div>}
    </section></div>
  </main></MarketShell>;
}
