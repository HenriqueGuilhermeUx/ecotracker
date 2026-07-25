import type { ReactNode } from "react";

export function MarketShell({ children }: { children: ReactNode }) {
  return (
    <div className="market-shell">
      <header className="market-header">
        <a className="brand" href="#home" aria-label="EcoTracker — início"><span>eco</span>tracker</a>
        <nav>
          <a href="#home">Protocolo</a>
          <a className="marketplace-nav" href="#marketplace">Marketplace</a>
          <a href="#planos">Planos</a>
          <a className="ghost" href="#market-admin">Operação</a>
        </nav>
      </header>
      {children}
      <footer className="market-footer">
        <div>
          <div className="brand"><span>eco</span>tracker</div>
          <p>Carbon Tokenization Protocol.</p>
          <a href="https://ecotracker10.netlify.app/">ecotracker10.netlify.app</a>
        </div>
        <small>1 ECOT representa a alocação rastreável de 1 kg de CO₂e. Preços são indicativos e nenhum ECOT é emitido antes da confirmação, aquisição ou aposentadoria do lastro.</small>
      </footer>
    </div>
  );
}
