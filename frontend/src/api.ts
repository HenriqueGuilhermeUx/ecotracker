export const API_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("ecotracker_admin_token");
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${API_URL}${path}`, { ...options, headers, signal: options.signal || controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Falha na operação (${response.status})`);
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
