import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

const rootElement = document.getElementById("root");

function showFatalError(error: unknown) {
  if (!rootElement) return;
  const message = error instanceof Error ? error.message : "Falha desconhecida ao iniciar o frontend.";
  rootElement.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#06100c;color:#edf8f1;font-family:sans-serif">
      <section style="width:min(680px,100%);border:1px solid #2c5039;border-radius:16px;background:#0c1c14;padding:28px">
        <div style="color:#69ff9a;font-size:12px;letter-spacing:.15em;font-weight:700">FALHA DE INICIALIZAÇÃO</div>
        <h1>O EcoTracker não conseguiu iniciar.</h1>
        <p style="color:#a5b8ae;line-height:1.6">A mensagem abaixo identifica a causa real. A página não será mais apagada silenciosamente.</p>
        <pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:#050d09;border:1px solid #213b2d;border-radius:10px;padding:16px;color:#ffcf7a">${message.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>
        <button onclick="location.reload()" style="margin-top:16px;border:0;border-radius:10px;padding:12px 18px;background:#69ff9a;color:#06100c;font-weight:700;cursor:pointer">Recarregar página</button>
      </section>
    </main>`;
}

async function clearLegacyRuntime(): Promise<boolean> {
  let hadLegacyController = false;
  let registrationsCount = 0;

  try {
    if ("serviceWorker" in navigator) {
      hadLegacyController = navigator.serviceWorker.controller !== null;
      const registrations = await navigator.serviceWorker.getRegistrations();
      registrationsCount = registrations.length;
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn("[ecotracker] legacy cleanup warning", error);
  }

  const needsFreshNavigation = hadLegacyController || registrationsCount > 0;
  let alreadyReloaded = false;
  try {
    alreadyReloaded = sessionStorage.getItem("ecotracker-runtime-clean-v3") === "1";
  } catch {
    alreadyReloaded = true;
  }

  if (needsFreshNavigation && !alreadyReloaded) {
    try { sessionStorage.setItem("ecotracker-runtime-clean-v3", "1"); } catch { /* ignore */ }
    location.reload();
    return false;
  }

  return true;
}

async function bootstrap() {
  if (!rootElement) throw new Error("Elemento #root não foi encontrado.");
  const canStart = await clearLegacyRuntime();
  if (!canStart) return;

  const { default: MarketApp } = await import("./MarketApp");
  createRoot(rootElement).render(
    <ErrorBoundary>
      <MarketApp />
    </ErrorBoundary>,
  );
}

void bootstrap().catch((error) => {
  console.error("[ecotracker] bootstrap failed", error);
  showFatalError(error);
});
