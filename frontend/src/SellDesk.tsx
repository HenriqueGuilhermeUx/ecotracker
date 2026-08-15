import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import "./carbon-desk.css";

type Json = Record<string, any>;

const n = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tons = (value: unknown) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n(value));
const brl = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }).format(n(value));
const dateTime = (value: unknown) => value
  ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(String(value)))
  : "—";

function purpose(value: unknown) {
  return String(value || "voluntary_offset") === "voluntary_offset" ? "Compensação voluntária de emissões" : String(value || "Compensação de emissões");
}

function sourcingStatus(item: Json) {
  if (item.autopilot_status === "provider_capacity_found") {
    return {
      title: "OFERTA EM VALIDAÇÃO FINAL",
      tone: "money",
      text: "O volume solicitado foi encontrado no mercado e está na revisão final antes da proposta comercial.",
    };
  }
  if (item.autopilot_status === "partial_provider_capacity") {
    return {
      title: "DISPONIBILIDADE EM COMPOSIÇÃO",
      tone: "alert",
      text: "A disponibilidade ainda está sendo consolidada. Não há oferta comercial fechada para repassar neste momento.",
    };
  }
  if (item.autopilot_status === "no_provider_capacity") {
    return {
      title: "EM BUSCA DE DISPONIBILIDADE",
      tone: "alert",
      text: "O mercado está sendo consultado automaticamente. Ainda não há volume comercial fechado para apresentar ao cliente.",
    };
  }
  return {
    title: "EM PREPARAÇÃO",
    tone: "open",
    text: "O EcoTracker está consolidando disponibilidade, qualidade e condições comerciais antes de gerar a oferta.",
  };
}

function clientText(proposal: Json) {
  const items = Array.isArray(proposal.items) ? proposal.items : [];
  const assetLines = items.map((item: Json) => {
    const vintage = item.vintage ? ` · vintage ${item.vintage}` : "";
    return `• ${item.projectName || "Projeto"} · ${item.registry || "Registry"}${vintage} · ${tons(item.amountTonnes)} tCO₂e`;
  });
  return [
    "ECOTRACKER — OFERTA DE CRÉDITOS DE CARBONO",
    "",
    `Empresa: ${proposal.company_name || proposal.companyName || "Cliente"}`,
    `Finalidade: ${purpose(proposal.claim_purpose)}`,
    `Volume: ${tons(proposal.target_tonnes)} tCO₂e`,
    `Preço: ${brl(proposal.price_per_tonne_brl)}/tCO₂e`,
    `Valor total: ${brl(proposal.final_total_brl)}`,
    `Validade da oferta: ${dateTime(proposal.expires_at)}`,
    "",
    "Créditos propostos:",
    ...(assetLines.length ? assetLines : ["• Composição validada na proposta comercial."]),
    "",
    "Aposentadoria: os créditos serão aposentados de forma exclusiva para o beneficiário após a contratação, com evidência registral.",
    "Documentação: identificação dos projetos, registry, vintage e evidências ficam vinculadas à operação.",
    "",
    "Condições sujeitas à validade da proposta e ao contrato final.",
  ].join("\n");
}

export function SellDesk() {
  const token = localStorage.getItem("ecotracker_admin_token");
  const [rfqs, setRfqs] = useState<Json[]>([]);
  const [proposals, setProposals] = useState<Json[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [rfqData, proposalData] = await Promise.all([
        api<Json>("/admin/market-maker/rfq-resolution-autopilot?limit=100"),
        api<Json>("/admin/demand/proposals?limit=200"),
      ]);
      setRfqs(Array.isArray(rfqData?.items) ? rfqData.items : []);

      const shareable = (Array.isArray(proposalData?.items) ? proposalData.items : [])
        .filter((item: Json) => item.review_status === "approved" && item.review_eligible_now === true && n(item.coverage_pct) >= 99.99)
        .slice(0, 50);
      const details = await Promise.all(shareable.map((item: Json) => api<Json>(`/admin/demand/proposals/${item.id}`)));
      setProposals(details);
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function copyProposal(proposal: Json) {
    const text = clientText(proposal);
    await navigator.clipboard.writeText(text);
    setCopied(String(proposal.id));
    window.setTimeout(() => setCopied(""), 2500);
  }

  if (!token) {
    return <MarketShell><main className="carbon-desk"><div className="desk-notice">Entre uma vez na <a href="#carbon-desk">Carbon Desk</a>. Depois volte para <b>Vender</b>.</div></main></MarketShell>;
  }

  return <MarketShell><main className="carbon-desk">
    <header className="desk-head">
      <div>
        <span className="tag">ECOTRACKER · VENDER</span>
        <h1>Informação pronta para o cliente</h1>
        <p>Só mostramos o que faz sentido comercialmente repassar. Custos internos, providers, margem e detalhes técnicos ficam fora desta tela.</p>
      </div>
      <div className="desk-head-actions">
        <a className="desk-button ghost" href="#deal-desk">Nova ordem</a>
        <button className="desk-button ghost" onClick={() => void load()}>Atualizar</button>
      </div>
    </header>

    {message && <div className="desk-notice">{message}</div>}

    {loading ? <div className="desk-loading">Preparando visão comercial...</div> : <>
      <section className="desk-card">
        <div className="section-title"><span>PRONTO PARA REPASSAR</span><h2>Ofertas comerciais validadas</h2></div>
        <div className="desk-list">
          {proposals.map((proposal) => {
            const items = Array.isArray(proposal.items) ? proposal.items : [];
            return <article className="desk-row rfq-row" key={`proposal-${proposal.id}`}>
              <div className="row-main">
                <div><b>{proposal.company_name}</b><small>{purpose(proposal.claim_purpose)}</small></div>
                <span className="status-safe">PRONTO PARA CLIENTE</span>
              </div>

              <div className="row-metrics">
                <span><small>Volume</small><b>{tons(proposal.target_tonnes)} tCO₂e</b></span>
                <span><small>Preço por tonelada</small><b>{brl(proposal.price_per_tonne_brl)}</b></span>
                <span><small>Valor total</small><b>{brl(proposal.final_total_brl)}</b></span>
                <span><small>Validade</small><b>{dateTime(proposal.expires_at)}</b></span>
              </div>

              <div className="desk-list compact">
                {items.map((item: Json, index: number) => <div className="desk-row" key={`${proposal.id}-${index}`}>
                  <div className="row-main"><div><b>{item.projectName}</b><small>{item.registry}{item.vintage ? ` · vintage ${item.vintage}` : ""}</small></div><span>{tons(item.amountTonnes)} t</span></div>
                  <p>{item.retirementSupported ? "Aposentadoria suportada para a operação." : "Condição de aposentadoria descrita na proposta final."}</p>
                  {item.evidenceUrl && <a href={item.evidenceUrl} target="_blank" rel="noreferrer">Ver evidência do projeto ↗</a>}
                </div>)}
              </div>

              <p>Após a contratação, os créditos serão aposentados de forma exclusiva para o beneficiário, com evidência registral vinculada à operação.</p>
              <footer>
                <small>Oferta comercial aprovada e válida neste momento.</small>
                <div className="row-actions"><button onClick={() => void copyProposal(proposal)}>{copied === String(proposal.id) ? "Resumo copiado ✓" : "Copiar resumo para cliente"}</button></div>
              </footer>
            </article>;
          })}
          {!proposals.length && <div className="empty">Nenhuma oferta está pronta para repassar neste momento. O EcoTracker só libera esta área quando volume, ativos e preço comercial estiverem válidos.</div>}
        </div>
      </section>

      <section className="desk-card">
        <div className="section-title"><span>EM PREPARAÇÃO</span><h2>Demandas ainda sem oferta final</h2></div>
        <div className="desk-list">
          {rfqs.map((item) => {
            const status = sourcingStatus(item);
            return <article className="desk-row rfq-row" key={`rfq-${item.rfq_id}`}>
              <div className="row-main"><div><b>{item.company_name}</b><small>Solicitação de {tons(item.target_tonnes)} tCO₂e</small></div><span className={`status-${status.tone}`}>{status.title}</span></div>
              <div className="row-metrics">
                <span><small>Volume solicitado</small><b>{tons(item.target_tonnes)} tCO₂e</b></span>
                <span><small>Finalidade</small><b>Compensação voluntária</b></span>
              </div>
              <p>{status.text}</p>
              <footer><small>Preço, projetos e documentos só aparecem acima quando estiverem prontos para repasse.</small></footer>
            </article>;
          })}
          {!rfqs.length && <div className="empty">Nenhuma demanda em preparação.</div>}
        </div>
      </section>
    </>}
  </main></MarketShell>;
}
