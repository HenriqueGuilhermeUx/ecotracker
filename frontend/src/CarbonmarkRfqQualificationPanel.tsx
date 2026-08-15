import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./carbonmark-rail.css";

type Json = Record<string, any>;

const num = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tons = (value: unknown) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(num(value));
const usd = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(num(value));
const candidateType = (item: Json) => String(item.candidateType ?? item.candidate_type ?? "");
const monitoredAssetId = (item: Json) => Number(item.monitoredAssetId ?? item.monitored_asset_id ?? 0);
const candidateTonnes = (item: Json) => num(item.candidateTonnes ?? item.candidate_tonnes);

export function CarbonmarkRfqQualificationPanel() {
  const [rail, setRail] = useState<Json>({});
  const [rfqs, setRfqs] = useState<Json[]>([]);
  const [rfqId, setRfqId] = useState("");
  const [rfqDetail, setRfqDetail] = useState<Json | null>(null);
  const [qualificationData, setQualificationData] = useState<Json>({});
  const [workAssetId, setWorkAssetId] = useState("");
  const [requestedKg, setRequestedKg] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const [eligibilityBasis, setEligibilityBasis] = useState("");
  const [commercialValidUntil, setCommercialValidUntil] = useState("");
  const [tradability, setTradability] = useState(false);
  const [retirement, setRetirement] = useState(false);
  const [beneficiaryRetirement, setBeneficiaryRetirement] = useState(false);
  const [fractional, setFractional] = useState(false);
  const [granularityKg, setGranularityKg] = useState("1000");
  const [ccpStatus, setCcpStatus] = useState("not_assessed");

  const load = useCallback(async () => {
    try {
      const [railData, rfqData, qualifications] = await Promise.all([
        api<Json>("/admin/market/carbonmark/control"),
        api<Json>("/admin/market-maker/rfqs?limit=200"),
        api<Json>("/admin/market-maker/market-signals/qualifications?limit=200"),
      ]);
      setRail(railData || {});
      const items = Array.isArray(rfqData?.items)
        ? rfqData.items.filter((item: Json) => ["open", "partially_sourced"].includes(String(item.status)) && num(item.gap_tonnes) > 0)
        : [];
      items.sort((a: Json, b: Json) => new Date(String(b.updated_at || 0)).getTime() - new Date(String(a.updated_at || 0)).getTime());
      setRfqs(items);
      setQualificationData(qualifications || {});
      if (!rfqId && items[0]?.id) setRfqId(String(items[0].id));
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [rfqId]);

  const inspectRfq = useCallback(async (id: string) => {
    if (!id) { setRfqDetail(null); return; }
    try {
      setRfqDetail(await api<Json>(`/admin/market-maker/rfqs/${id}`));
    } catch (error) {
      setMessage((error as Error).message);
      setRfqDetail(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void inspectRfq(rfqId); }, [inspectRfq, rfqId]);

  const assets = Array.isArray(rail.assets) ? rail.assets : [];
  const qualifications = Array.isArray(qualificationData.items) ? qualificationData.items : [];
  const selectedRfq = useMemo(() => rfqs.find((item) => String(item.id) === rfqId) || null, [rfqs, rfqId]);
  const assetMap = useMemo(() => new Map(assets.map((asset: Json) => [String(asset.id), asset])), [assets]);

  const signals = useMemo(() => {
    const candidates = Array.isArray(rfqDetail?.candidates) ? rfqDetail.candidates : [];
    const gap = num(rfqDetail?.gap_tonnes ?? selectedRfq?.gap_tonnes);
    return candidates
      .filter((candidate: Json) => candidateType(candidate) === "market_signal" && monitoredAssetId(candidate) > 0 && assetMap.has(String(monitoredAssetId(candidate))))
      .sort((a: Json, b: Json) => {
        const aCovers = candidateTonnes(a) >= gap ? 1 : 0;
        const bCovers = candidateTonnes(b) >= gap ? 1 : 0;
        if (aCovers !== bCovers) return bCovers - aCovers;
        const aVintage = Number(String(a.vintage || "").slice(0, 4)) || 0;
        const bVintage = Number(String(b.vintage || "").slice(0, 4)) || 0;
        if (aVintage !== bVintage) return bVintage - aVintage;
        return num(b.sourcingScore ?? b.sourcing_score) - num(a.sourcingScore ?? a.sourcing_score);
      });
  }, [rfqDetail, selectedRfq, assetMap]);

  const workAsset = useMemo(() => assetMap.get(workAssetId) || null, [assetMap, workAssetId]);
  const workQualification = useMemo(
    () => qualifications.find((item: Json) => String(item.monitored_asset_id) === workAssetId) || null,
    [qualifications, workAssetId],
  );
  const gapTonnes = num(rfqDetail?.gap_tonnes ?? selectedRfq?.gap_tonnes);
  const validKg = Math.max(0, Math.round(num(requestedKg)));
  const execution = rail.execution || {};
  const canProbe = Boolean(execution.configured) && Boolean(workAsset) && validKg > 0 && validKg >= num(workAsset?.min_order_kg || 1);
  const canApprove = workQualification?.status === "eligibility_review" && eligibilityBasis.trim().length >= 20 && Boolean(commercialValidUntil) && tradability && retirement && beneficiaryRetirement;

  function useCandidate(candidate: Json) {
    const assetId = monitoredAssetId(candidate);
    const volumeTonnes = Math.min(gapTonnes || candidateTonnes(candidate), candidateTonnes(candidate));
    setWorkAssetId(String(assetId));
    setRequestedKg(String(Math.max(1, Math.round(volumeTonnes * 1000))));
    setMessage(`Candidato ${candidate.projectName ?? candidate.project_name ?? assetId} carregado para ${tons(volumeTonnes)} t. Nenhuma compra foi criada.`);
  }

  async function qualify() {
    if (!canProbe) return;
    setBusy("probe"); setMessage("");
    try {
      const result = await api<Json>("/admin/market-maker/market-signals/probe", {
        method: "POST",
        body: JSON.stringify({ assetId: Number(workAssetId), requestedKg: validKg, createdBy: `Carbonmark Rail · RFQ ${rfqId}` }),
      });
      await load();
      await inspectRfq(rfqId);
      if (result.status === "probed") {
        setMessage(`VOLUME PROVADO NO PROVIDER: ${tons(num(result.probed_kg) / 1000)} t. Próximo gate: eligibility review. Ainda não é seller-confirmed nem claim-ready.`);
      } else if (result.status === "diagnostic_only") {
        setMessage(`Probe diagnóstico funcionou, mas o provider NÃO provou o volume total de ${tons(num(result.requested_kg) / 1000)} t. Esse candidato não fecha o gap nesse volume.`);
      } else {
        setMessage(`Qualification registrada com status ${String(result.status || "unknown")}.`);
      }
    } catch (error) {
      setMessage((error as Error).message);
      await load();
    } finally {
      setBusy("");
    }
  }

  async function submitEligibility() {
    if (!workQualification?.id) return;
    setBusy("submit"); setMessage("");
    try {
      await api<Json>(`/admin/market-maker/market-signals/qualifications/${workQualification.id}/submit-review`, {
        method: "POST", body: JSON.stringify({ submittedBy: `Carbonmark Rail · RFQ ${rfqId}` }),
      });
      await load();
      setMessage("Enviado para eligibility review. O ativo ainda NÃO está claim-ready.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  async function approveEligibility() {
    if (!workQualification?.id || !canApprove) return;
    setBusy("approve"); setMessage("");
    try {
      const result = await api<Json>(`/admin/market-maker/market-signals/qualifications/${workQualification.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          reviewedBy: `Carbonmark Rail · RFQ ${rfqId}`,
          eligibilityBasis,
          tradabilityConfirmed: tradability,
          commercialValidUntil,
          retirementSupported: retirement,
          beneficiaryRetirementSupported: beneficiaryRetirement,
          fractionalRetirementSupported: fractional,
          retirementGranularityKg: Math.max(1, Math.round(num(granularityKg))),
          ccpStatus,
          riskFlags: ["market-signal-provider-qualified", `rfq:${rfqId}`],
        }),
      });
      await load(); await inspectRfq(rfqId);
      setMessage(result.status === "qualified"
        ? `CLAIM-READY aprovado · SHA ${String(result.approval_sha256 || "").slice(0, 12)}… Matching/RFQ recalculados. Execução Carbonmark continua bloqueada.`
        : "Eligibility atualizada.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(""); }
  }

  return <section className="desk-card carbonmark-rail-panel">
    <header className="carbonmark-rail-head">
      <div><span>RFQ → CARBONMARK QUALIFICATION</span><h2>Fechar gap com supply realmente cotável</h2></div>
      <div className={`rail-mode ${execution.live ? "live" : "blocked"}`}><b>{execution.live ? "ORDER LIVE" : "SEM COMPRA"}</b><small>provider probe only</small></div>
    </header>
    <div className="rail-safety"><strong>ATALHO SEGURO</strong><span>Escolha o RFQ. O EcoTracker cruza os market signals com listings Carbonmark, preenche o volume do gap e prova a cotação. Probe não cria order, pagamento ou retirement.</span></div>
    {message && <div className="desk-notice">{message}</div>}
    {loading ? <div className="desk-loading">Carregando RFQs...</div> : <>
      <div className="shadow-quote-form">
        <label>RFQ aberto<select value={rfqId} onChange={(event) => { setRfqId(event.target.value); setWorkAssetId(""); setRequestedKg(""); }}>
          {rfqs.map((item) => <option key={item.id} value={item.id}>{item.company_name} · RFQ #{item.id} · gap {tons(item.gap_tonnes)} t</option>)}
        </select></label>
        <div className="shadow-preview"><small>Gap selecionado</small><b>{selectedRfq ? `${selectedRfq.company_name} · ${tons(gapTonnes)} t` : "Nenhum RFQ aberto"}</b><span>{signals.length} market signal(s) Carbonmark conectado(s) a este RFQ.</span></div>
        <button disabled={!rfqId || busy !== ""} onClick={() => void inspectRfq(rfqId)}>Recarregar candidatos</button>
      </div>

      {rfqId && signals.length === 0 && <div className="rail-blocker">Este RFQ não tem market signal Carbonmark que corresponda a um listing disponível no Rail. Use outro rail/originação; não force o VCS-836 técnico.</div>}

      {signals.slice(0, 20).map((candidate: Json, index: number) => {
        const asset = assetMap.get(String(monitoredAssetId(candidate)));
        const candidateT = candidateTonnes(candidate);
        const useT = Math.min(gapTonnes || candidateT, candidateT);
        const covers = candidateT >= gapTonnes;
        const q = qualifications.find((item: Json) => String(item.monitored_asset_id) === String(monitoredAssetId(candidate)));
        return <div className="shadow-quote-form" key={`${candidate.id}-${monitoredAssetId(candidate)}`}>
          <div className="shadow-preview">
            <small>{index === 0 ? "RECOMENDADO" : covers ? "COBRE O GAP" : "LEG PARCIAL"}</small>
            <b>{candidate.projectName ?? candidate.project_name ?? asset?.project_name ?? `Asset ${monitoredAssetId(candidate)}`}</b>
            <span>{candidate.registry || asset?.registry || "—"} · vintage {candidate.vintage || "—"} · observado {tons(candidateT)} t · score {num(candidate.sourcingScore ?? candidate.sourcing_score)}</span>
            <span>{asset ? `${usd(asset.source_price_usd_ton)}/t · min ${num(asset.min_order_kg || 1)} kg · source ${asset.assetPriceSourceId || "—"}` : "Listing Carbonmark não localizado"}</span>
            <span>Status qualification: {q ? String(q.status).replaceAll("_", " ") : "não iniciado"}. Provider-quotable ≠ seller-confirmed ≠ claim-ready.</span>
          </div>
          <button disabled={!asset || busy !== ""} onClick={() => useCandidate(candidate)}>Usar {tons(useT)} t no qualification</button>
        </div>;
      })}

      {workAsset && <>
        <div className="shadow-quote-form">
          <div className="shadow-preview"><small>QUALIFICATION WORKBENCH</small><b>{workAsset.project_name}</b><span>RFQ #{rfqId} · {tons(validKg / 1000)} t · source {workAsset.assetPriceSourceId || "—"}</span><span>Status: {workQualification ? String(workQualification.status).replaceAll("_", " ") : "não iniciado"}</span></div>
          <label>Quantidade kg<input type="number" min={workAsset.min_order_kg || 1} step="1" value={requestedKg} onChange={(event) => setRequestedKg(event.target.value)} /></label>
          {(!workQualification || ["diagnostic_only", "probe_failed"].includes(String(workQualification.status))) && <button disabled={!canProbe || busy !== ""} onClick={() => void qualify()}>{busy === "probe" ? "Provando volume..." : "Provar volume do gap no Carbonmark"}</button>}
          {workQualification?.status === "probed" && <button disabled={busy !== ""} onClick={() => void submitEligibility()}>{busy === "submit" ? "Enviando..." : "Enviar para eligibility review"}</button>}
          {workQualification?.status === "qualified" && <div className="rail-safe-ready"><b>CLAIM-READY</b> · SHA {String(workQualification.approval_sha256 || "").slice(0, 12)}… · sourcing executable continua {workQualification.sourcing_executable ? "ON" : "OFF"}.</div>}
        </div>

        {workQualification?.status === "eligibility_review" && <div className="shadow-quote-form">
          <label>Fundamentação de elegibilidade<textarea value={eligibilityBasis} onChange={(event) => setEligibilityBasis(event.target.value)} placeholder="Registry/projeto, vintage, evidência, tradability, retirement e justificativa climática." /></label>
          <label>Validade comercial<input type="date" value={commercialValidUntil} onChange={(event) => setCommercialValidUntil(event.target.value)} /></label>
          <label>CCP<select value={ccpStatus} onChange={(event) => setCcpStatus(event.target.value)}><option value="not_assessed">não avaliado</option><option value="approved">aprovado</option><option value="eligible_program">programa elegível</option><option value="not_approved">não aprovado</option></select></label>
          <label>Granularidade retirement kg<input type="number" min="1" step="1" value={granularityKg} onChange={(event) => setGranularityKg(event.target.value)} /></label>
          <div className="shadow-preview"><small>Confirmações humanas</small><label><input type="checkbox" checked={tradability} onChange={(event) => setTradability(event.target.checked)} /> Tradability confirmada</label><label><input type="checkbox" checked={retirement} onChange={(event) => setRetirement(event.target.checked)} /> Retirement suportado</label><label><input type="checkbox" checked={beneficiaryRetirement} onChange={(event) => setBeneficiaryRetirement(event.target.checked)} /> Retirement em nome do beneficiário</label><label><input type="checkbox" checked={fractional} onChange={(event) => setFractional(event.target.checked)} /> Retirement fracionário</label></div>
          <button disabled={!canApprove || busy !== ""} onClick={() => void approveEligibility()}>{busy === "approve" ? "Aprovando..." : "Aprovar claim-ready e recalcular RFQ"}</button>
        </div>}
      </>}
    </>}
  </section>;
}
