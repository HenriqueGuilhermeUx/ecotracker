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
  sellOrderId?: string;
  batchDenom?: string;
  askDenom?: string;
  askAmount?: string;
  displayDenom?: string;
  disableAutoRetire?: boolean;
  autoRetireAvailable?: boolean;
  expiration?: string | null;
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
  tax_id?: string;
  requested_kg: number;
  delivery_mode: string;
  wallet_address?: string;
  purpose: string;
  indicative_total?: string | null;
  final_total?: string | null;
  source_cost_brl?: string | null;
  payment_fee_brl?: string | null;
  tax_reserve_brl?: string | null;
  gross_revenue_brl?: string | null;
  gross_profit_brl?: string | null;
  net_profit_brl?: string | null;
  status: string;
  quote_expires_at?: string | null;
  payment_provider?: string | null;
  payment_method?: string | null;
  payment_status?: string;
  payment_url?: string | null;
  pix_br_code?: string | null;
  pix_qr_code_url?: string | null;
  paid_at?: string | null;
  sourcing_status?: string;
  sourcing_reference?: string | null;
  sourcing_tx_hash?: string | null;
  retirement_status?: string;
  retirement_reference?: string | null;
  retirement_tx_hash?: string | null;
  retired_at?: string | null;
  delivery_status?: string;
  delivery_reference?: string | null;
  delivery_tx_hash?: string | null;
  delivered_at?: string | null;
  receipt_status?: string;
  receipt_public_code?: string | null;
  nfse_status?: string;
  nfse_url?: string | null;
  allocation_public_code?: string | null;
  admin_notes?: string | null;
  registry: string;
  project_name: string;
  created_at: string;
  updated_at?: string;
};

export type CommerceDashboard = {
  quotes: number;
  paid_orders: number;
  paid_revenue_brl: string;
  source_cost_brl: string;
  payment_fees_brl: string;
  tax_reserve_brl: string;
  estimated_net_profit_brl: string;
  delivered_ecot: string;
  jobs: Array<{ status: string; total: number }>;
  providers: Record<string, boolean>;
};

export type AutomationJob = {
  id: number;
  public_code: string;
  quote_code: string;
  job_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error?: string | null;
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
