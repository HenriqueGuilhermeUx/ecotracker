const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const PRODUCTION_API_URL = "https://ecotracker-api-cik7.onrender.com/api";

// Em produção, tentamos primeiro o proxy same-origin do Netlify.
// Se um deploy antigo devolver o index.html em /api/*, fazemos fallback
// direto para o Render. Isso evita esconder o catálogo real enquanto o
// redirect do Netlify ainda não propagou.
export const API_URL = (
  isLocal
    ? (import.meta.env.VITE_API_URL || "http://localhost:4000/api")
    : "/api"
).replace(/\/$/, "");

function candidateBases() {
  if (isLocal) return [API_URL];
  return [API_URL, PRODUCTION_API_URL];
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("ecotracker_admin_token");
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let lastError: unknown = null;

  for (const base of candidateBases()) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers,
        signal: options.signal || controller.signal,
        cache: "no-store",
      });

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        lastError = new Error(`A rota ${base}${path} não retornou JSON.`);
        // Em produção, HTML no proxy geralmente significa que o redirect ainda
        // não foi aplicado. Tenta a API pública diretamente antes de falhar.
        if (!isLocal && base === API_URL) continue;
        throw lastError;
      }

      const data = await response.json() as { error?: string } | T;
      if (!response.ok) {
        const errorMessage = typeof data === "object" && data && "error" in data ? data.error : null;
        throw new Error(errorMessage || `Falha na operação (${response.status})`);
      }
      return data as T;
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new Error("A API está acordando ou demorou para responder.");
      }
      // Falha de rede/CORS do proxy: em produção ainda tentamos o Render direto.
      if (!isLocal && base === API_URL) continue;
      throw lastError;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`${lastError.message} Não foi possível alcançar o backend do EcoTracker.`);
  }
  throw new Error("Não foi possível alcançar o backend do EcoTracker.");
}
