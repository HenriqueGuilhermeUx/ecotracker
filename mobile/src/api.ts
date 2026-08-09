import type { Asset, Checkout, EligibilityCatalog, Quote, QuoteRequest } from "./types";

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || "https://ecotracker-api-cik7.onrender.com/api").replace(/\/$/, "");

function ptBrError(message: string | null | undefined, status?: number) {
  const raw = String(message || "").trim();
  const normalized = raw.toLowerCase();
  const exact: Record<string, string> = {
    "an error occurred. please try again": "Ocorreu um erro. Tente novamente em instantes.",
    "an error occurred. please try again.": "Ocorreu um erro. Tente novamente em instantes.",
    "internal server error": "O serviço encontrou um erro interno. Tente novamente em instantes.",
    "service unavailable": "O serviço está temporariamente indisponível. Tente novamente em instantes.",
    "bad gateway": "A conexão com um provedor externo falhou. Tente novamente em instantes.",
    "gateway timeout": "Um provedor externo demorou para responder. Tente novamente em instantes.",
    "failed to fetch": "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
    "network error": "Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.",
  };
  if (exact[normalized]) return exact[normalized];
  if (normalized.includes("please try again")) return "Não foi possível concluir a operação. Tente novamente em instantes.";
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "A operação demorou mais que o esperado. Tente novamente em instantes.";
  if (normalized.includes("unauthorized")) return "Sua sessão não está autorizada para esta operação.";
  if (normalized.includes("forbidden")) return "Você não tem permissão para realizar esta operação.";
  if (normalized.includes("not found")) return "O recurso solicitado não foi encontrado.";
  const looksPortuguese = /[áàâãéêíóôõúç]|\b(não|erro|falha|cotação|ativo|operação|pagamento|serviço|solicitação)\b/i.test(raw);
  if (looksPortuguese) return raw;
  if (status && status >= 500) return "O serviço está temporariamente indisponível. Tente novamente em instantes.";
  return raw || "Não foi possível concluir a operação. Tente novamente.";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(ptBrError(error instanceof Error ? error.message : null));
  }

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("A API retornou uma resposta inválida. Tente novamente em instantes.");
  }

  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data
      ? String((data as { error: unknown }).error)
      : `Falha na operação (${response.status})`;
    throw new Error(ptBrError(message, response.status));
  }

  return data as T;
}

export const getAssets = () => request<Asset[]>("/market/assets");
export const refreshAssets = () => request<Asset[]>("/market/refresh");
export const getEligibilityCatalog = () => request<EligibilityCatalog>("/market/catalog/eligibility");
export const getCompensationAssets = (kg = 1000) => request<Asset[]>(`/market/compensation-assets?kg=${encodeURIComponent(String(kg))}`);
export const getQuote = (code: string) => request<Quote>(`/market/quotes/${encodeURIComponent(code)}`);

export const createQuote = (payload: QuoteRequest) =>
  request<{ public_code: string; status: string; final_total?: string | null }>("/market/quotes", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const createCheckout = (code: string, method: "pix" | "card") =>
  request<Checkout>(`/market/quotes/${encodeURIComponent(code)}/checkout`, {
    method: "POST",
    body: JSON.stringify({ method }),
  });

export const receiptUrl = (code: string) => `${API_URL}/market/quotes/${encodeURIComponent(code)}/receipt`;
