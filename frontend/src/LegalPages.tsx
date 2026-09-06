import { type FormEvent, useState } from "react";
import { api } from "./api";
import { MarketShell } from "./MarketShell";
import "./legal-public.css";

const LEGAL = {
  name: "Alternative Ventures Ltda",
  cnpj: "61.920.356/0001-38",
  address: "Rua Governador Pedro de Toledo, 71, Santos/SP, CEP 11045-550",
};

type DeleteResponse = {
  public_code?: string;
  status?: string;
  message?: string;
};

function LegalHeader({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <section className="legal-hero">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{text}</p>
    </section>
  );
}

function CompanyBox() {
  return (
    <aside className="legal-company">
      <small>RESPONSÁVEL PELO ECOTRACKER</small>
      <strong>{LEGAL.name}</strong>
      <span>CNPJ {LEGAL.cnpj}</span>
      <span>{LEGAL.address}</span>
      <a href="#contact">Canais de contato</a>
    </aside>
  );
}

export function PrivacyPage() {
  const [email, setEmail] = useState("");
  const [quoteCode, setQuoteCode] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DeleteResponse | null>(null);
  const [error, setError] = useState("");

  async function requestDeletion(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      const data = await api<DeleteResponse>("/privacy/deletion-requests", {
        method: "POST",
        body: JSON.stringify({ email, quoteCode }),
      });
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <MarketShell>
      <main className="legal-page">
        <LegalHeader
          eyebrow="PRIVACIDADE · LGPD"
          title="Política de Privacidade"
          text="Como o EcoTracker coleta, usa, protege e elimina dados pessoais em sua operação corporativa."
        />
        <div className="legal-layout">
          <article className="legal-content">
            <section>
              <h2>1. Quem controla seus dados</h2>
              <p>O EcoTracker é uma solução operada por <b>{LEGAL.name}</b>, CNPJ {LEGAL.cnpj}, com endereço em {LEGAL.address}. Para fins da LGPD, a empresa atua como controladora dos dados pessoais tratados diretamente para captação de demanda, propostas, contratos e relacionamento comercial.</p>
            </section>
            <section>
              <h2>2. Dados que podemos tratar</h2>
              <p>Podemos tratar nome, cargo ou função, empresa, e-mail corporativo, telefone, volume de créditos solicitado, finalidade climática, preferências de projeto/registry, dados fornecidos em propostas e contratos, registros técnicos de acesso e, quando houver operação concluída, dados necessários a pagamento, faturamento, aposentadoria e evidências.</p>
              <p>O formulário público não solicita dados pessoais sensíveis.</p>
            </section>
            <section>
              <h2>3. Para que usamos os dados</h2>
              <p>Usamos os dados para responder solicitações, preparar ofertas, realizar procedimentos pré-contratuais solicitados pelo titular, manter relacionamento comercial, prevenir fraude e abuso, proteger a plataforma, cumprir obrigações legais e manter evidências de operações concluídas.</p>
            </section>
            <section>
              <h2>4. Bases legais</h2>
              <p>Dependendo da atividade, o tratamento pode se apoiar no consentimento informado pelo titular, em procedimentos preliminares relacionados a eventual contrato solicitados pelo próprio titular, no cumprimento de obrigação legal/regulatória e, quando aplicável, em legítimo interesse avaliado de forma compatível com os direitos do titular.</p>
            </section>
            <section>
              <h2>5. Compartilhamento e fornecedores</h2>
              <p>Dados podem ser tratados por fornecedores de infraestrutura, hospedagem, banco de dados, e-mail e segurança, e — somente quando necessário à operação — por provedores de pagamento, registries, plataformas de créditos de carbono, prestadores fiscais e autoridades competentes. O EcoTracker não vende dados pessoais para publicidade.</p>
              <p>Alguns fornecedores podem processar dados fora do Brasil. Nessas situações, a operação deve observar a LGPD e a regulamentação aplicável às transferências internacionais.</p>
            </section>
            <section>
              <h2>6. Retenção</h2>
              <p>Dados de leads e solicitações são mantidos enquanto necessários para atender a finalidade comercial, responder ao titular, proteger a operação e cumprir obrigações aplicáveis. Registros de transações, documentos fiscais, evidências de aposentadoria e documentos contratuais podem ser conservados pelo período necessário ao cumprimento de obrigações legais e ao exercício regular de direitos.</p>
            </section>
            <section>
              <h2>7. Seus direitos</h2>
              <p>O titular pode solicitar confirmação de tratamento, acesso, correção, informação sobre compartilhamento, anonimização, bloqueio ou eliminação quando aplicável, revogação do consentimento e demais direitos previstos na LGPD. A eliminação pode ser limitada quando houver obrigação legal, fiscal, contratual ou necessidade de preservação de evidência de uma operação concluída.</p>
            </section>
            <section>
              <h2>8. Segurança</h2>
              <p>Adotamos controles técnicos e administrativos compatíveis com a natureza da plataforma, incluindo segregação de credenciais, proteção de secrets, trilhas de auditoria e limitação de execução automática em operações financeiras e de aposentadoria.</p>
            </section>
            <section>
              <h2>9. Cookies e armazenamento local</h2>
              <p>O site público não depende de cookies publicitários próprios para solicitar uma oferta. Áreas administrativas podem usar armazenamento local do navegador para manter sessão. Logs técnicos podem ser mantidos pelos provedores de infraestrutura para segurança e operação.</p>
            </section>
            <section>
              <h2>10. Atualizações</h2>
              <p>Esta política pode ser atualizada quando houver mudança relevante de produto, fornecedores ou requisitos legais. Versão publicada em 6 de setembro de 2026.</p>
            </section>

            <section className="legal-rights-box">
              <span>EXERCER DIREITOS</span>
              <h2>Solicitar exclusão ou anonimização</h2>
              <p>Informe o e-mail usado no EcoTracker. Se você tiver um código de cotação, ele ajuda na verificação automática da identidade.</p>
              {!result ? (
                <form onSubmit={requestDeletion}>
                  <label>E-mail<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@empresa.com.br" /></label>
                  <label>Código de cotação (opcional)<input value={quoteCode} onChange={(e) => setQuoteCode(e.target.value)} placeholder="UUID da cotação" /></label>
                  {error && <div className="legal-error">{error}</div>}
                  <button disabled={sending}>{sending ? "Registrando..." : "Registrar solicitação"}</button>
                </form>
              ) : (
                <div className="legal-success">
                  <b>Solicitação registrada.</b>
                  <p>{result.message || "Recebemos sua solicitação."}</p>
                  {result.public_code && <span>Protocolo: {result.public_code}</span>}
                </div>
              )}
            </section>
          </article>
          <CompanyBox />
        </div>
      </main>
    </MarketShell>
  );
}

export function TermsPage() {
  return (
    <MarketShell>
      <main className="legal-page">
        <LegalHeader
          eyebrow="TERMOS · ECOTRACKER"
          title="Termos de Uso e Condições Gerais"
          text="Regras gerais para uso do site, solicitações de oferta e operações comerciais EcoTracker."
        />
        <div className="legal-layout">
          <article className="legal-content">
            <section><h2>1. Operador da plataforma</h2><p>O EcoTracker é operado por <b>{LEGAL.name}</b>, CNPJ {LEGAL.cnpj}. Estes termos regulam o uso do site e dos fluxos digitais públicos. Propostas e contratos específicos podem estabelecer condições adicionais para cada operação.</p></section>
            <section><h2>2. Natureza das informações públicas</h2><p>Dados de catálogo, preços indicativos, volumes observados, projetos, registries, vintages e demais informações públicas podem mudar. Um ativo exibido no site não constitui, por si só, obrigação de venda, reserva definitiva ou garantia de disponibilidade.</p></section>
            <section><h2>3. Solicitação de oferta</h2><p>Ao enviar uma demanda, a empresa autoriza o EcoTracker a analisar disponibilidade, elegibilidade e condições comerciais para preparar uma proposta. A solicitação é sem compromisso até que exista proposta válida e aceite conforme o fluxo comercial aplicável.</p></section>
            <section><h2>4. Propostas e validade</h2><p>Preço, volume, composição, validade, forma de pagamento e demais condições somente se tornam aplicáveis quando apresentados em proposta comercial específica. Propostas podem expirar ou exigir nova validação de supply antes do aceite.</p></section>
            <section><h2>5. Créditos de carbono e claims</h2><p>Para compensação voluntária, o EcoTracker considera concluída a destinação climática apenas após a aposentadoria elegível dos créditos para o beneficiário e a disponibilidade de evidência correspondente. A adequação de um crédito a obrigações regulatórias, programas de compliance ou políticas internas do comprador deve ser verificada no contexto aplicável.</p></section>
            <section><h2>6. ECOT e rastreabilidade</h2><p>ECOT é uma unidade de infraestrutura e rastreabilidade usada pelo EcoTracker para organizar alocação em kg de CO₂e. A apresentação de ECOT no produto não deve ser interpretada como promessa de rendimento, investimento financeiro ou substituição das regras do registry de origem.</p></section>
            <section><h2>7. Pagamento e execução</h2><p>Nenhum envio de formulário público gera cobrança automática. Quando houver pagamento, aquisição de créditos ou aposentadoria, essas etapas dependem de condições comerciais aceitas e dos gates operacionais aplicáveis à transação.</p></section>
            <section><h2>8. Responsabilidades do comprador</h2><p>O comprador deve fornecer informações verdadeiras, possuir autoridade para agir em nome da organização indicada e revisar projeto, registry, vintage, finalidade, volume, preço e condições antes do aceite.</p></section>
            <section><h2>9. Disponibilidade tecnológica</h2><p>O EcoTracker busca manter o serviço disponível e seguro, mas pode interromper temporariamente funcionalidades para manutenção, segurança, indisponibilidade de provedores ou proteção da integridade de uma operação.</p></section>
            <section><h2>10. Propriedade intelectual</h2><p>Marca, software, fluxos, textos e interfaces do EcoTracker são protegidos pela legislação aplicável, sem prejuízo dos direitos pertencentes aos registries, projetos, fontes e provedores citados na plataforma.</p></section>
            <section><h2>11. Privacidade</h2><p>O tratamento de dados pessoais segue a <a href="#privacy">Política de Privacidade</a> do EcoTracker.</p></section>
            <section><h2>12. Lei aplicável</h2><p>Estes termos são regidos pela legislação brasileira. Eventual instrumento comercial específico pode definir foro, solução de controvérsias e condições próprias da contratação.</p></section>
            <section><h2>13. Atualizações</h2><p>Versão publicada em 6 de setembro de 2026. O uso continuado do site após alterações relevantes estará sujeito à versão publicada no momento do uso.</p></section>
          </article>
          <CompanyBox />
        </div>
      </main>
    </MarketShell>
  );
}

export function ContactPage() {
  return (
    <MarketShell>
      <main className="legal-page">
        <LegalHeader
          eyebrow="CONTATO · ECOTRACKER"
          title="Fale com o EcoTracker"
          text="Para comprar créditos, acompanhar uma solicitação ou tratar de privacidade, use o canal adequado abaixo."
        />
        <section className="contact-grid">
          <article>
            <span>COMERCIAL</span>
            <h2>Comprar créditos de carbono</h2>
            <p>Informe empresa, volume e finalidade. O EcoTracker inicia matching e sourcing para preparar sua oferta.</p>
            <a className="legal-primary" href="#request">Solicitar oferta empresarial</a>
          </article>
          <article>
            <span>CATÁLOGO</span>
            <h2>Analisar projetos disponíveis</h2>
            <p>Consulte projetos, registries, vintages, volumes e evidências que já estejam liberados para apresentação pública.</p>
            <a className="legal-secondary" href="#marketplace">Comprar créditos</a>
          </article>
          <article>
            <span>PRIVACIDADE</span>
            <h2>Dados pessoais e LGPD</h2>
            <p>Acesse a política e o formulário para exercer direitos de titular.</p>
            <a className="legal-secondary" href="#privacy">Privacidade</a>
          </article>
        </section>
        <section className="contact-company">
          <small>IDENTIFICAÇÃO EMPRESARIAL</small>
          <h2>{LEGAL.name}</h2>
          <p>CNPJ {LEGAL.cnpj}</p>
          <p>{LEGAL.address}</p>
        </section>
      </main>
    </MarketShell>
  );
}
