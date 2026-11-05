import { MarketShell } from "./MarketShell";
import "./corporate-public.css";

export function CorporateHome() {
  return (
    <MarketShell>
      <main className="corp-public">
        <section className="corp-hero">
          <div className="corp-hero-copy">
            <span className="corp-eyebrow">ECOTRACKER · COMPRA CORPORATIVA DE CRÉDITOS DE CARBONO</span>
            <h1>Compre créditos de carbono com <em>origem verificável.</em></h1>
            <p>
              Para empresas que precisam compensar emissões ou adquirir créditos de carbono com clareza.\n              O EcoTracker estrutura uma operação assistida com projeto, registry, vintage, volume, preço, aposentadoria e evidências em um único fluxo.
            </p>
            <div className="corp-actions">
              <a className="corp-primary" href="#request">Solicitar cotação corporativa</a>
              <a className="corp-secondary" href="#marketplace">Ver créditos disponíveis</a>
            </div>
            <div className="corp-trust-row">
              <span>Projeto + registry</span>
              <span>Vintage + volume</span>
              <span>Preço + validade</span>
              <span>Aposentadoria + evidência</span>\n              <span>Disponibilidade validada antes do fechamento</span>
            </div>
          </div>

          <aside className="corp-offer-card" aria-label="O que acompanha uma oferta EcoTracker">
            <small>OFERTA CORPORATIVA</small>
            <h2>O que sua empresa recebe antes de decidir</h2>
            <div className="corp-offer-line"><span>01</span><div><b>Origem</b><p>Projeto, registry, país/local e metodologia.</p></div></div>
            <div className="corp-offer-line"><span>02</span><div><b>Crédito</b><p>Vintage, volume e situação de elegibilidade.</p></div></div>
            <div className="corp-offer-line"><span>03</span><div><b>Comercial</b><p>Preço por tCO₂e, valor total e validade.</p></div></div>
            <div className="corp-offer-line"><span>04</span><div><b>Conclusão</b><p>Quando aplicável, aposentadoria com beneficiário identificado e evidência registral.</p></div></div>
          </aside>
        </section>

        <section className="launch-trust" aria-label="Confiança institucional EcoTracker">
          <div><small>OPERAÇÃO BRASILEIRA</small><b>Alternative Ventures Ltda</b><span>CNPJ 61.920.356/0001-38 · Santos/SP</span></div>
          <div><small>PROCESSO COMERCIAL</small><b>Oferta antes de cobrança</b><span>Preço, volume, validade e composição são apresentados antes de qualquer contratação.</span></div>
          <div><small>CONCLUSÃO CLIMÁTICA</small><b>Aposentadoria + evidência</b><span>Claims de compensação dependem de retirement elegível e evidência registral.</span></div>
        </section>

        <section className="corp-section">
          <div className="corp-section-head">
            <span>COMPRA DE CRÉDITOS DE CARBONO</span>
            <h2>Da seleção do projeto ao comprovante final.</h2>
            <p>Você não precisa entender infraestrutura, blockchain ou providers para comprar. A camada técnica fica por baixo da operação.</p>
          </div>
          <div className="corp-grid-three">
            <article>
              <small>01 · DEMANDA</small>
              <h3>Informe quanto sua empresa precisa</h3>
              <p>Volume e finalidade são suficientes para iniciar. Registry, país e tipo de projeto podem ser informados como preferência.</p>
            </article>
            <article>
              <small>02 · OFERTA</small>
              <h3>Preço e volume em linguagem comercial</h3>
              <p>O EcoTracker busca, combina e valida supply. Você recebe quantidade em tCO₂e, preço por tonelada, valor total e composição da oferta.</p>
            </article>
            <article>
              <small>03 · APOSENTADORIA</small>
              <h3>Créditos destinados ao beneficiário</h3>
              <p>Quando a operação exigir compensação, a conclusão depende da aposentadoria elegível e da respectiva evidência.</p>
            </article>
          </div>
        </section>

        <section className="corp-enterprise">
          <div>
            <span>OPERAÇÃO ASSISTIDA · GRANDES VOLUMES</span>
            <h2>Sua empresa pode solicitar uma cotação agora.</h2>
            <p>
              Informe sua demanda mesmo quando o volume não estiver visível no catálogo. O EcoTracker pode estruturar uma cotação com um ou mais projetos, sujeita à disponibilidade, elegibilidade, validade comercial e finalidade climática.
            </p>
          </div>
          <a className="corp-primary" href="#request">Quero solicitar uma cotação</a>
        </section>

        <section className="corp-section corp-ecot-layer">
          <div className="corp-section-head">
            <span>RASTREABILIDADE ECOT</span>
            <h2>ECOT é a infraestrutura. O que você compra é impacto com origem documentada.</h2>
            <p>
              A unidade ECOT ajuda o EcoTracker a organizar alocação e rastreabilidade em kg de CO₂e. Para o comprador,
              o que importa continua sendo o crédito, o projeto, o registry, o vintage, a aposentadoria e as evidências.
            </p>
          </div>
          <div className="corp-trust-row wide">
            <span>1 ECOT = 1 kg CO₂e alocado</span>
            <span>Documentação por lote</span>
            <span>Histórico da operação</span>
            <span>Evidência vinculada</span>
          </div>
        </section>
      </main>
    </MarketShell>
  );
}
