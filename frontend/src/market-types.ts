export type MonitorDetails = {
  note?: string;
  endpoint?: string;
  checkedAt?: string;
  orderCount?: number;
  pricingOrderCount?: number;
  askDenoms?: string[];
  regenUsd?: number;
  minSourceUsdTon?: number;
  medianSourceUsdTon?: number;
  maxSourceUsdTon?: number;
  websiteStatus?: number;
  error?: string;
};

export type Asset = {
  id: number;
  public_code: string;
  registry: string;
  project_name: string;
  source_reference: string;
  source_url?: string;
  methodology?: string;
  location?: string;
  vintage?: string;
  asset_type: string;
  quality_tier: string;
  description?: string;
  source_price_usd_ton?: string | null;
  fx_brl_usd: string;
  service_margin_pct: string;
  fixed_fee_brl: string;
  available_tons?: string | null;
  min_order_kg: number;
  pricing_mode: "quote" | "dynamic";
  availability_status: "monitoring" | "indicative" | "confirmed";
  source_status: "manual" | "connected" | "degraded";
  monitor_details?: MonitorDetails;
  last_checked_at?: string;
  active: boolean;
  indicative_price_brl_kg?: string | null;
  indicative_price_brl_ton?: string | null;
};

export type Quote = {
  id: number;
  public_code: string;
  asset_id: number;
  buyer_name: string;
  buyer_email: string;
  buyer_phone?: string;
  company_name?: string;
  requested_kg: number;
  delivery_mode: string;
  wallet_address?: string;
  purpose: string;
  indicative_total?: string | null;
  final_total?: string | null;
  status: string;
  quote_expires_at?: string | null;
  admin_notes?: string | null;
  registry: string;
  project_name: string;
  created_at: string;
};

export const money = (value: number | string | null | undefined) =>
  value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const num = (value: number | string | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });

export const dateTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString("pt-BR") : "Ainda não atualizado";
