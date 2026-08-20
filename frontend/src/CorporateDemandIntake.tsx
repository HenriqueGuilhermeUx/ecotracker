import { type FormEvent, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import "./corporate-demand.css";

type IntakeResponse = {
  received: boolean;
  protocol: string;
  targetTonnes: number;
  claimPurpose: string;
  status: "commercial_review" | "sourcing_and_validation";
  message: string;
};

const initialForm = {
  companyName: "",
  contactName: "",
  email: "",
  phone: "",
  targetTonnes: "1000",
  claimPurpose: "voluntary_offset",
  preferredRegistry: "",
  preferredCountry: "",
  preferredProjectType: "",
  desiredBy: "",
  notes: "",
  privacyConsent: false,
  website: "",
};

export function CorporateDemandIntake() {
  const [form, setForm] = useState(initialForm);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<IntakeResponse | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setMessage("");
    try {
      const response = await api<IntakeResponse>("/public/corporate-demand", {
        method: "POST",
        body: JSON.stringify({ ...form, targetTonnes: Number(form.targetTonnes) }),
      });
      setResult(response);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (result) {
    return (
      <MarketShell>
        <main className="demand-intake-page">
          <section className="demand-success">
            <span className="demand-eyebrow">SOLICITAÇÃO RECEBIDA</span>
            <div className="demand-success-mark">✓</div>
            <h1>Sua demanda já entrou no EcoTracker.</h1>
            <p>{result.message}</p>
            <div className="demand-protocol">
              <small>PROTOCOLO</small>
              <strong>{result.protocol}</strong>
            </div>
            <div className="demand-success-facts">
              <div><small>Volume solicitado</small><b>{Number(result.targetTonnes).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} tCO₂e</b></div>
              <div><small>Finalidade</small><b>{result.claimPurpose === "voluntary_offset" ? "Compensação voluntária" : "Contribuição climática"}</b></div>
              <div><small>Próxima etapa</small><b>{result.status === "commercial_review" ? "Revisão comercial" : "Composição e validação"}</b></div>
            </div>
            <p className="demand-success-note">Nenhum pagamento é realizado nesta etapa. Primeiro validamos a composição, condições comerciais, aposentadoria e evidências da oferta.</p>
            <div className="demand-success-actions">
              <a className="corp-primary" href="#marketplace">Ver créditos disponíveis</a>
              <a className="corp-secondary" href="#home">Voltar ao início</a>
            </div>
          </section>
        </main>
      </MarketShell>
    );
  }

  return (
    <MarketShell>
      <main className="demand-intake-page">
        <section className="demand-intake-hero">
          <div>
            <span className="demand-eyebrow">OFERTA CORPORATIVA SOB DEMANDA</span>
            <h1>Diga quanto sua empresa precisa. <em>O EcoTracker monta a oferta.</em></h1>
            <p>Você não precisa escolher provider, listing ou infraestrutura. Informe sua demanda e nós organizamos a busca, composição, elegibilidade e condições comerciais.</p>
            <div className="demand-promise-grid">
              <div><b>1</b><span>Você informa o volume</span></div>
              <div><b>2</b><span>O motor busca e combina supply</span></div>
              <div><b>3</b><span>Revisamos a oferta comercial</span></div>
              <div><b>4</b><span>Você recebe preço + origem + evidências</span></div>
            </div>
          </div>
          <aside>
            <small>GRANDES VOLUMES</small>
            <strong>100 → 10.000+ tCO₂e</strong>
            <p>Uma demanda pode ser composta por um ou mais projetos, conforme disponibilidade, elegibilidade, finalidade e preferências informadas.</p>
          </aside>
        </section>

        <section className="demand-form-section">
          <div className="demand-form-copy">
            <span className="demand-eyebrow">30 SEGUNDOS</span>
            <h2>Solicitar uma oferta</h2>
            <p>Os campos marcados são suficientes para iniciar. Preferências de registry, país ou tipo de projeto são opcionais.</p>
            <ul>
              <li>Sem compromisso de compra</li>
              <li>Sem pagamento nesta etapa</li>
              <li>Preço só é apresentado após validação comercial</li>
              <li>Compensação exige aposentadoria elegível</li>
            </ul>
          </div>

          <form className="demand-form" onSubmit={submit}>
            <label>Empresa *<input required minLength={2} value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} placeholder="Nome da empresa" /></label>
            <label>Responsável *<input required minLength={2} value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} placeholder="Seu nome" /></label>
            <div className="demand-form-row">
              <label>E-mail corporativo *<input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="nome@empresa.com.br" /></label>
              <label>Telefone / WhatsApp<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="(11) 99999-9999" /></label>
            </div>
            <div className="demand-form-row">
              <label>Volume desejado *<div className="demand-unit-input"><input required type="number" min="0.001" step="0.001" value={form.targetTonnes} onChange={(event) => setForm({ ...form, targetTonnes: event.target.value })} /><span>tCO₂e</span></div></label>
              <label>Finalidade<select value={form.claimPurpose} onChange={(event) => setForm({ ...form, claimPurpose: event.target.value })}><option value="voluntary_offset">Compensação voluntária</option><option value="climate_contribution">Contribuição climática</option></select></label>
            </div>

            <details className="demand-preferences">
              <summary>Preferências do crédito (opcional)</summary>
              <div className="demand-preference-body">
                <div className="demand-form-row">
                  <label>Registry<input value={form.preferredRegistry} onChange={(event) => setForm({ ...form, preferredRegistry: event.target.value })} placeholder="Ex.: Verra, Gold Standard" /></label>
                  <label>País / região<input value={form.preferredCountry} onChange={(event) => setForm({ ...form, preferredCountry: event.target.value })} placeholder="Ex.: Brasil" /></label>
                </div>
                <div className="demand-form-row">
                  <label>Tipo de projeto<input value={form.preferredProjectType} onChange={(event) => setForm({ ...form, preferredProjectType: event.target.value })} placeholder="Ex.: florestal, solar, remoção" /></label>
                  <label>Prazo desejado<input type="date" value={form.desiredBy} onChange={(event) => setForm({ ...form, desiredBy: event.target.value })} /></label>
                </div>
                <label>Observações<textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Ex.: preferência por projetos brasileiros ou por determinado vintage." /></label>
              </div>
            </details>

            <input className="demand-honeypot" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} />
            <label className="demand-consent"><input required type="checkbox" checked={form.privacyConsent} onChange={(event) => setForm({ ...form, privacyConsent: event.target.checked })} /><span>Autorizo o EcoTracker a usar estes dados para analisar esta solicitação e entrar em contato sobre a oferta.</span></label>
            {message && <div className="form-msg">{message}</div>}
            <button className="demand-submit" disabled={sending}>{sending ? "Registrando e iniciando análise..." : "Solicitar oferta empresarial"}</button>
            <small className="demand-form-footnote">Ao enviar, o EcoTracker inicia a análise de disponibilidade e matching. Nenhum crédito é comprado ou aposentado automaticamente.</small>
          </form>
        </section>
      </main>
    </MarketShell>
  );
}
