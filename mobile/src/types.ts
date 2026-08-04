export type Asset = {
  id: number;
  public_code: string;
  registry: string;
  project_name: string;
  source_reference: string;
  source_url?: string | null;
  methodology?: string | null;
  location?: string | null;
  vintage?: string | null;
  asset_type: string;
  quality_tier: string;
  description?: string | null;
  source_price_usd_ton?: string | null;
  fx_brl_usd: string;
  service_margin_pct: string;
  fixed_fee_brl: string;
  available_tons?: string | null;
  min_order_kg: number;
  pricing_mode: "quote" | "dynamic";
  availability_status: "monitoring" | "indicative" | "confirmed";
  source_status: "manual" | "connected" | "degraded";
  monitor_details?: {
    note?: string;
    sellOrderId?: string;
    batchDenom?: string;
    askDenom?: string;
    orderCount?: number;
  } | null;
  last_checked_at?: string | null;
  active: boolean;
  indicative_price_brl_kg?: string | null;
  indicative_price_brl_ton?: string | null;
};

export type Quote = {
  public_code: string;
  requested_kg: number;
  delivery_mode: "email" | "wallet";
  wallet_address?: string | null;
  indicative_total?: string | null;
  final_total?: string | null;
  status: string;
  quote_expires_at?: string | null;
  payment_provider?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_url?: string | null;
  pix_br_code?: string | null;
  pix_qr_code_url?: string | null;
  paid_at?: string | null;
  sourcing_status?: string | null;
  retirement_status?: string | null;
  retirement_reference?: string | null;
  retired_at?: string | null;
  delivery_status?: string | null;
  delivery_reference?: string | null;
  delivered_at?: string | null;
  receipt_status?: string | null;
  nfse_status?: string | null;
  receipt_public_code?: string | null;
  nfse_url?: string | null;
  allocation_public_code?: string | null;
  delivery_tx_hash?: string | null;
  registry: string;
  project_name: string;
  created_at: string;
  updated_at?: string;
};

export type Checkout = {
  provider: "woovi" | "mercadopago";
  method: "pix" | "card";
  providerReference: string;
  status: string;
  checkoutUrl?: string | null;
  pixBrCode?: string | null;
  qrCodeUrl?: string | null;
  amountBrl: number;
};

export type QuoteRequest = {
  assetId: number;
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string;
  companyName?: string;
  taxId?: string;
  requestedKg: number;
  deliveryMode: "email" | "wallet";
  walletAddress?: string;
  purpose: "neutralization" | "rewards" | "corporate" | "other";
};

export type LocalProfile = {
  name: string;
  email: string;
  phone: string;
  companyName: string;
  taxId: string;
  preferredDelivery: "email" | "wallet";
  walletAddress: string;
};

export type FootprintInput = {
  people: number;
  flights: number;
  vehicles: number;
};
