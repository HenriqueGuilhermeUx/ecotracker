import type { Asset, Checkout, EligibilityCatalog, Quote, QuoteRequest } from "./types";

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || "https://ecotracker-api-cik7.onrender.com/api").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });

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
    throw new Error(message);
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
