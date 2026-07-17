import type { ReactNode } from "react";

export function MarketShell({ children }: { children: ReactNode }) {
  return (
    <div className="market-shell">
      <header className="market-header">
        <a className="brand" href="#home"><span>eco</span>tracker</a>
        <nav>
          <a href="#home">Protocolo</a>
          <a href="#marketplace">Ativos monitorados</a>
          <a href="#planos">Planos</a>
          <a className="ghost" href="#market-admin">Operação</a>
        </nav>
      </header>
      {children}
      <footer className="market-footer">
        <div>
          <div className="brand"><span>eco</span>tracker</div>
          <p>Carbon Tokenization Protocol.</p>
        </div>
        <small>Preços são indicativos. Nenhum ECOT é emitido antes da confirmação, aquisição ou aposentadoria do lastro.</small>
      </footer>
    </div>
  );
}
