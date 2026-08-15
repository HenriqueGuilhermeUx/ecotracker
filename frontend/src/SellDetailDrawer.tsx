import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Json = Record<string, any>;
type DrawerKind = "proposal" | "rfq";
type DrawerTab = "summary" | "operation" | "assets" | "contact";

type Props = {
  open: boolean;
  kind: DrawerKind | null;
  item: Json | null;
  account?: Json | null;
  busy?: boolean;
  onClose: () => void;
  onCopyProposal?: (proposal: Json) => void | Promise<void>;
  onRunRfq?: (rfqId: number) => void | Promise<void>;
};

const n = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tons = (value: unknown) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n(value));
const brl = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }).format(n(value));
const usd = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n(value));
const dateTime = (value: unknown) => value
  ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(String(value)))
  : "—";
const pct = (value: number) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(Math.max(0, Math.min(100, value)))}%`;

function purpose(value: unknown) {
  return String(value || "voluntary_offset") === "voluntary_offset" ? "Compensação voluntária de emissões" : String(value || "Compensação de emissões");
}

function contactFrom(item: Json | null, account: Json | null | undefined) {
  return {
    name: account?.contact_name || item?.contact_name || "—",
    email: account?.contact_email || item?.contact_email || "",
    phone: account?.contact_phone || "",
    website: account?.website_url || "",
    sector: account?.sector || item?.sector || "",
  };
}

export function SellDetailDrawer({ open, kind, item, account, busy, onClose, onCopyProposal, onRunRfq }: Props) {
  const [tab, setTab] = useState<DrawerTab>("summary");
  const [rfqDetail, setRfqDetail] = useState<Json | null>(null);
  const [detailError, setDetailError] = useState("");
  const contact = useMemo(() => contactFrom(item, account), [item, account]);

  useEffect(() => {
    if (!open) return;
    setTab("summary");
    setDetailError("");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, kind, item?.id, item?.rfq_id, onClose]);

  useEffect(() => {
    if (!open || kind !== "rfq" || !item?.rfq_id) {
      setRfqDetail(null);
      return;
    }
    let active = true;
    void api<Json>(`/admin/market-maker/rfqs/${item.rfq_id}/resolution-autopilot`)
      .then((data) => { if (active) setRfqDetail(data); })
      .catch((error) => { if (active) setDetailError((error as Error).message); });
    return () => { active = false; };
  }, [open, kind, item?.rfq_id]);

  if (!open || !kind || !item) return null;

  const proposalItems = Array.isArray(item.items) ? item.items : [];
  const legs = Array.isArray(rfqDetail?.legs) ? rfqDetail!.legs : [];
  const coverage = n(item.target_tonnes) > 0 ? (n(item.covered_tonnes) / n(item.target_tonnes)) * 100 : 0;
  const providerTonnes = n(rfqDetail?.provider_quotable_kg ?? item.provider_quotable_kg) / 1000;
  const remainingTonnes = n(rfqDetail?.remaining_kg ?? item.remaining_kg) / 1000;
  const sourceCost = n(item.source_cost_brl);
  const finalTotal = n(item.final_total_brl);
  const grossResult = finalTotal > 0 && sourceCost > 0 ? finalTotal - sourceCost : 0;
  const grossMargin = finalTotal > 0 && grossResult > 0 ? (grossResult / finalTotal) * 100 : 0;

  const mailSubject = kind === "proposal"
    ? `EcoTracker — oferta de ${tons(item.target_tonnes)} tCO₂e`
    : `EcoTracker — atualização da solicitação de ${tons(item.target_tonnes)} tCO₂e`;

  return <div className="sell-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="sell-drawer" role="dialog" aria-modal="true" aria-label="Detalhes da operação">
      <header className="sell-drawer-head">
        <div>
          <span>{kind === "proposal" ? "OFERTA COMERCIAL" : "DEMANDA EM ANDAMENTO"}</span>
          <h2>{item.company_name || "Cliente"}</h2>
          <p>{kind === "proposal" ? `${tons(item.target_tonnes)} tCO₂e · ${purpose(item.claim_purpose)}` : `${tons(item.target_tonnes)} tCO₂e solicitadas`}</p>
        </div>
        <button className="sell-icon-button" onClick={onClose} aria-label="Fechar painel">×</button>
      </header>

      <nav className="sell-drawer-tabs" aria-label="Seções do detalhe">
        <button className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>Resumo</button>
        <button className={tab === "operation" ? "active" : ""} onClick={() => setTab("operation")}>Operação</button>
        <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>Ativos</button>
        <button className={tab === "contact" ? "active" : ""} onClick={() => setTab("contact")}>Contato</button>
      </nav>

      <div className="sell-drawer-body">
        {detailError && <div className="sell-inline-alert">{detailError}</div>}

        {tab === "summary" && <section className="sell-detail-section">
          <div className="sell-detail-title"><span>VISÃO RÁPIDA</span><h3>O que importa agora</h3></div>
          {kind === "proposal" ? <>
            <div className="sell-detail-grid">
              <div><small>Volume</small><b>{tons(item.target_tonnes)} tCO₂e</b></div>
              <div><small>Preço / t</small><b>{brl(item.price_per_tonne_brl)}</b></div>
              <div><small>Valor total</small><b>{brl(item.final_total_brl)}</b></div>
              <div><small>Validade</small><b>{dateTime(item.expires_at)}</b></div>
            </div>
            <div className="sell-callout positive"><b>Pronta para repasse</b><span>Revisão comercial aprovada, cobertura integral e ativos válidos neste momento.</span></div>
          </> : <>
            <div className="sell-detail-grid">
              <div><small>Solicitado</small><b>{tons(item.target_tonnes)} t</b></div>
              <div><small>Claim-ready</small><b>{tons(item.covered_tonnes)} t</b></div>
              <div><small>Cobertura</small><b>{pct(coverage)}</b></div>
              <div><small>Gap atual</small><b>{tons(item.gap_tonnes)} t</b></div>
            </div>
            <div className="sell-progress" aria-label={`Cobertura ${pct(coverage)}`}><i style={{ width: `${Math.max(0, Math.min(100, coverage))}%` }} /></div>
            <div className={`sell-callout ${item.autopilot_status === "provider_capacity_found" ? "positive" : "warning"}`}>
              <b>{item.autopilot_status === "provider_capacity_found" ? "Supply comercial encontrado" : "Composição ainda em andamento"}</b>
              <span>{item.autopilot_status === "provider_capacity_found" ? "O volume faltante foi encontrado comercialmente e aguarda validação final." : "O EcoTracker continua buscando e compondo o volume faltante automaticamente."}</span>
            </div>
          </>}
        </section>}

        {tab === "operation" && <section className="sell-detail-section">
          <div className="sell-detail-title"><span>SOMENTE ADM</span><h3>Acompanhamento operacional</h3></div>
          {kind === "proposal" ? <>
            <div className="sell-detail-grid">
              <div><small>Custo de aquisição</small><b>{sourceCost > 0 ? brl(sourceCost) : "—"}</b></div>
              <div><small>Receita de serviço</small><b>{n(item.service_revenue_brl) > 0 ? brl(item.service_revenue_brl) : "—"}</b></div>
              <div><small>Resultado bruto</small><b>{grossResult > 0 ? brl(grossResult) : "—"}</b></div>
              <div><small>Margem bruta</small><b>{grossMargin > 0 ? pct(grossMargin) : "—"}</b></div>
            </div>
            <dl className="sell-definition-list">
              <div><dt>Status da proposta</dt><dd>{String(item.status || "—")}</dd></div>
              <div><dt>Revisão comercial</dt><dd>{String(item.review_status || "—")}</dd></div>
              <div><dt>Cobertura</dt><dd>{pct(n(item.coverage_pct))}</dd></div>
              <div><dt>Modo de execução</dt><dd>{String(item.execution_mode || "—")}</dd></div>
              <div><dt>Snapshot</dt><dd className="mono">{String(item.snapshot_sha256 || "—").slice(0, 24)}{item.snapshot_sha256 ? "…" : ""}</dd></div>
            </dl>
          </> : <>
            <div className="sell-detail-grid">
              <div><small>Provider cotável</small><b>{tons(providerTonnes)} t</b></div>
              <div><small>Ainda falta</small><b>{tons(remainingTonnes || item.gap_tonnes)} t</b></div>
              <div><small>Custo observado</small><b>{n(rfqDetail?.total_cost_usdc ?? item.total_cost_usdc) > 0 ? usd(rfqDetail?.total_cost_usdc ?? item.total_cost_usdc) : "—"}</b></div>
              <div><small>Custo médio</small><b>{n(rfqDetail?.avg_cost_usdc_tonne ?? item.avg_cost_usdc_tonne) > 0 ? `${usd(rfqDetail?.avg_cost_usdc_tonne ?? item.avg_cost_usdc_tonne)}/t` : "—"}</b></div>
            </div>
            <dl className="sell-definition-list">
              <div><dt>Status RFQ</dt><dd>{String(item.rfq_status || "—")}</dd></div>
              <div><dt>Autopilot</dt><dd>{String(rfqDetail?.status || item.autopilot_status || "aguardando")}</dd></div>
              <div><dt>Candidatos testados</dt><dd>{String(rfqDetail?.candidates_tested ?? "—")}</dd></div>
              <div><dt>Última rodada</dt><dd>{dateTime(rfqDetail?.completed_at ?? item.completed_at)}</dd></div>
            </dl>
            <div className="sell-callout neutral"><b>Regra de segurança</b><span>Capacidade cotável é sinal comercial interno. Só vira oferta ao cliente depois de eligibility, preço final e revisão comercial.</span></div>
          </>}
        </section>}

        {tab === "assets" && <section className="sell-detail-section">
          <div className="sell-detail-title"><span>{kind === "proposal" ? "COMPOSIÇÃO VALIDADA" : "LEGS OBSERVADAS"}</span><h3>{kind === "proposal" ? "Ativos da oferta" : "Supply encontrado pelo motor"}</h3></div>
          <div className="sell-asset-list">
            {(kind === "proposal" ? proposalItems : legs).map((asset: Json, index: number) => {
              const volume = kind === "proposal" ? n(asset.amountTonnes) : n(asset.quotable_kg) / 1000;
              const evidenceUrl = kind === "proposal" ? asset.evidenceUrl : asset.evidence?.registryEvidenceUrl || asset.evidence?.sourceUrl;
              return <article key={`${kind}-${asset.id || asset.assetId || index}`}>
                <div><b>{asset.projectName || asset.project_name || "Ativo de carbono"}</b><small>{asset.registry || "Registry"}{asset.vintage ? ` · vintage ${asset.vintage}` : ""}</small></div>
                <strong>{tons(volume)} t</strong>
                {kind === "rfq" && <p>{asset.provider ? `Provider: ${asset.provider}` : ""}{n(asset.cost_usdc_tonne) > 0 ? ` · ${usd(asset.cost_usdc_tonne)}/t` : ""}</p>}
                {evidenceUrl && <a href={String(evidenceUrl)} target="_blank" rel="noreferrer">Abrir evidência ↗</a>}
              </article>;
            })}
            {!(kind === "proposal" ? proposalItems.length : legs.length) && <div className="sell-empty-compact">Nenhum ativo detalhado disponível ainda.</div>}
          </div>
        </section>}

        {tab === "contact" && <section className="sell-detail-section">
          <div className="sell-detail-title"><span>RELACIONAMENTO</span><h3>Contato do cliente</h3></div>
          <dl className="sell-definition-list contact">
            <div><dt>Nome</dt><dd>{contact.name}</dd></div>
            <div><dt>E-mail</dt><dd>{contact.email || "—"}</dd></div>
            <div><dt>Telefone</dt><dd>{contact.phone || "—"}</dd></div>
            <div><dt>Setor</dt><dd>{contact.sector || "—"}</dd></div>
          </dl>
          <div className="sell-contact-actions">
            {contact.email && <a className="sell-primary-action" href={`mailto:${contact.email}?subject=${encodeURIComponent(mailSubject)}`}>Enviar e-mail</a>}
            {contact.phone && <a className="sell-secondary-action" href={`tel:${contact.phone}`}>Ligar</a>}
            {contact.website && <a className="sell-secondary-action" href={contact.website} target="_blank" rel="noreferrer">Site ↗</a>}
          </div>
        </section>}
      </div>

      <footer className="sell-drawer-footer">
        <button className="sell-secondary-action" onClick={onClose}>Fechar</button>
        {kind === "proposal" && onCopyProposal && <button className="sell-primary-action" onClick={() => void onCopyProposal(item)}>Copiar resumo</button>}
        {kind === "rfq" && onRunRfq && <button className="sell-primary-action" disabled={busy} onClick={() => void onRunRfq(Number(item.rfq_id))}>{busy ? "EcoTracker trabalhando…" : "Acelerar validação"}</button>}
      </footer>
    </aside>
  </div>;
}
