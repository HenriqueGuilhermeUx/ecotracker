const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

// Em produção, todas as chamadas passam pelo mesmo domínio Netlify em /api.
// VITE_API_URL fica restrito ao desenvolvimento local para evitar apontamentos antigos.
export const API_URL = (
  isLocal
    ? (import.meta.env.VITE_API_URL || "http://localhost:4000/api")
    : "/api"
).replace(/\/$/, "");

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("ecotracker_admin_token");
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      signal: options.signal || controller.signal,
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(`A rota ${API_URL}${path} não retornou JSON. O proxy da API ainda não foi aplicado neste deploy.`);
    }

    const data = await response.json() as { error?: string } | T;
    if (!response.ok) {
      const errorMessage = typeof data === "object" && data && "error" in data ? data.error : null;
      throw new Error(errorMessage || `Falha na operação (${response.status})`);
    }
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("A API está acordando ou demorou para responder. Tente atualizar novamente em alguns segundos.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
