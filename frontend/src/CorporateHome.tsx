import { MarketShell } from "./MarketShell";
import "./corporate-public.css";

export function CorporateHome() {
  return (
    <MarketShell>
      <main className="corp-public">
        <section className="corp-hero">
          <div className="corp-hero-copy">
            <span className="corp-eyebrow">ECOTRACKER · CRÉDITOS DE CARBONO</span>
            <h1>Compre créditos de carbono com <em>origem verificável.</em></h1>
            <p>
              Para empresas que precisam compensar emissões ou estruturar uma compra climática com clareza.
              O EcoTracker organiza projeto, registry, vintage, volume, preço, aposentadoria e evidências em uma única operação.
            </p>
            <div className="corp-actions">
              <a className="corp-primary" href="#marketplace">Ver créditos disponíveis</a>
              <a className="corp-secondary" href="#marketplace">Solicitar cotação empresarial</a>
            </div>
            <div className="corp-trust-row">
              <span>Projeto + registry</span>
              <span>Vintage + volume</span>
              <span>Preço + validade</span>
              <span>Aposentadoria + evidência</span>
            </div>
          </div>

          <aside className="corp-offer-card" aria-label="O que acompanha uma oferta EcoTracker">
            <small>OFERTA CORPORATIVA</small>
            <h2>O que sua empresa analisa antes de comprar</h2>
            <div className="corp-offer-line"><span>01</span><div><b>Origem</b><p>Projeto, registry, país/local e metodologia.</p></div></div>
            <div className="corp-offer-line"><span>02</span><div><b>Crédito</b><p>Vintage, volume e situação de elegibilidade.</p></div></div>
            <div className="corp-offer-line"><span>03</span><div><b>Comercial</b><p>Preço por tCO₂e, valor total e validade.</p></div></div>
            <div className="corp-offer-line"><span>04</span><div><b>Conclusão</b><p>Aposentadoria para o beneficiário e evidência registral.</p></div></div>
          </aside>
        </section>

        <section className="corp-section">
          <div className="corp-section-head">
            <span>COMPRA DE CRÉDITOS DE CARBONO</span>
            <h2>Da seleção do projeto ao comprovante final.</h2>
            <p>Você não precisa entender infraestrutura, blockchain ou providers para comprar. A camada técnica fica por baixo da operação.</p>
          </div>
          <div className="corp-grid-three">
            <article>
              <small>01 · SELEÇÃO</small>
              <h3>Projetos com informações de origem</h3>
              <p>Apresentamos o nome oficial do projeto, registry, localização, metodologia, vintage e evidências disponíveis.</p>
            </article>
            <article>
              <small>02 · OFERTA</small>
              <h3>Preço e volume em linguagem comercial</h3>
              <p>Você recebe quantidade em tCO₂e, preço por tonelada, valor total, composição da oferta e prazo de validade.</p>
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
            <span>PARA EMPRESAS E GRANDES VOLUMES</span>
            <h2>Precisa comprar 100, 1.000 ou 10.000+ tCO₂e?</h2>
            <p>
              O EcoTracker pode estruturar uma oferta com um ou mais projetos, respeitando volume disponível,
              elegibilidade, validade comercial e a finalidade climática informada pela empresa.
            </p>
          </div>
          <a className="corp-primary" href="#marketplace">Começar uma cotação</a>
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
