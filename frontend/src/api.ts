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

function ptBrError(message: string | null | undefined, status?: number) {
  const raw = String(message || "").trim();
  const normalized = raw.toLowerCase();

  if (!raw) return status && status >= 500
    ? "O serviço está temporariamente indisponível. Tente novamente em instantes."
    : "Não foi possível concluir a operação. Tente novamente.";

  const exact: Record<string, string> = {
    "an error occurred. please try again": "Ocorreu um erro. Tente novamente em instantes.",
    "an error occurred. please try again.": "Ocorreu um erro. Tente novamente em instantes.",
    "internal server error": "O serviço encontrou um erro interno. Tente novamente em instantes.",
    "service unavailable": "O serviço está temporariamente indisponível. Tente novamente em instantes.",
    "bad gateway": "A conexão com um provedor externo falhou. Tente novamente em instantes.",
    "gateway timeout": "Um provedor externo demorou para responder. Tente novamente em instantes.",
    "failed to fetch": "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
    "network error": "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
    "maximum quotable quantity exceeded": "A quantidade solicitada excede o máximo cotável neste listing Carbonmark. Tente uma quantidade menor ou selecione outro listing.",
  };
  if (exact[normalized]) return exact[normalized];

  if (normalized.includes("maximum quotable quantity exceeded")) return "A quantidade solicitada excede o máximo cotável neste listing Carbonmark. Tente uma quantidade menor ou selecione outro listing.";
  if (normalized.includes("please try again")) return "Não foi possível concluir a operação. Tente novamente em instantes.";
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "A operação demorou mais que o esperado. Tente novamente em instantes.";
  if (normalized.includes("unauthorized")) return "Sua sessão não está autorizada para esta operação.";
  if (normalized.includes("forbidden")) return "Você não tem permissão para realizar esta operação.";
  if (normalized.includes("not found")) return "O recurso solicitado não foi encontrado.";

  // Mensagens já em português seguem intactas. Para erros 5xx genéricos vindos
  // de providers externos, evitamos expor texto técnico/inglês ao usuário.
  const looksPortuguese = /[áàâãéêíóôõúç]|\b(não|erro|falha|cotação|ativo|operação|pagamento|serviço|solicitação)\b/i.test(raw);
  if (looksPortuguese) return raw;
  if (status && status >= 500) return "O serviço está temporariamente indisponível. Tente novamente em instantes.";
  return raw;
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
        if (!isLocal && base === API_URL) continue;
        throw lastError;
      }

      const data = await response.json() as { error?: string } | T;
      if (!response.ok) {
        const errorMessage = typeof data === "object" && data && "error" in data ? data.error : null;
        throw new Error(ptBrError(errorMessage, response.status));
      }
      return data as T;
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new Error("A API está acordando ou demorou para responder.");
      } else if (error instanceof TypeError) {
        lastError = new Error(ptBrError(error.message));
      }
      if (!isLocal && base === API_URL) continue;
      throw lastError;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`${ptBrError(lastError.message)} Não foi possível alcançar o backend do EcoTracker.`);
  }
  throw new Error("Não foi possível alcançar o backend do EcoTracker.");
}
