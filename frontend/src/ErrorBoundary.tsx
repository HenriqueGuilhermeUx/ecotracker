import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ecotracker] frontend crash", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#06100c", color: "#edf8f1", fontFamily: "sans-serif" }}>
        <section style={{ width: "min(680px, 100%)", border: "1px solid #2c5039", borderRadius: 16, background: "#0c1c14", padding: 28 }}>
          <div style={{ color: "#69ff9a", fontSize: 12, letterSpacing: ".15em", fontWeight: 700 }}>DIAGNÓSTICO DO FRONTEND</div>
          <h1 style={{ margin: "14px 0 10px" }}>O EcoTracker encontrou um erro de carregamento.</h1>
          <p style={{ color: "#a5b8ae", lineHeight: 1.6 }}>A tela não será mais apagada. Copie a mensagem abaixo para corrigirmos a causa exata.</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#050d09", border: "1px solid #213b2d", borderRadius: 10, padding: 16, color: "#ffcf7a" }}>{this.state.error.message}</pre>
          <button onClick={() => location.reload()} style={{ marginTop: 16, border: 0, borderRadius: 10, padding: "12px 18px", background: "#69ff9a", color: "#06100c", fontWeight: 700, cursor: "pointer" }}>Recarregar página</button>
        </section>
      </main>
    );
  }
}
