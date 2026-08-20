import type { ReactNode } from "react";
import "./admin-nav.css";

export function MarketShell({ children }: { children: ReactNode }) {
  const isAdmin = Boolean(localStorage.getItem("ecotracker_admin_token"));

  return (
    <div className="market-shell">
      <header className="market-header">
        <a className="brand" href="#home" aria-label="EcoTracker — início"><span>eco</span>tracker</a>
        <nav>
          <a href="#home">Início</a>
          <a className="marketplace-nav" href="#marketplace">Comprar créditos</a>
          <a href="#planos">Planos</a>
          <a href="#rewards">EcoRewards</a>
          {isAdmin && (
            <details className="admin-nav">
              <summary>Admin</summary>
              <div className="admin-nav-menu">
                <a href="#sell">Vender</a>
                <a href="#deal-desk">Deal Desk</a>
                <a href="#carbon-desk">Carbon Desk</a>
                <a href="#carbonmark-rail">Carbonmark Rail</a>
                <a href="#market-admin">Operação</a>
              </div>
            </details>
          )}
        </nav>
      </header>
      {children}
      <footer className="market-footer">
        <div>
          <div className="brand"><span>eco</span>tracker</div>
          <p>Créditos de carbono com origem, rastreabilidade e evidências.</p>
          <a href="https://ecotracker10.netlify.app/">ecotracker10.netlify.app</a>
        </div>
        <small>O EcoTracker apresenta projeto, registry, vintage, volume, condições comerciais e evidências disponíveis. Compensação de emissões só é concluída após aposentadoria elegível e rastreável.</small>
      </footer>
    </div>
  );
}
