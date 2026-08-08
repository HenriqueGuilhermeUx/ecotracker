export type PricingTier = {
  key: string;
  minKg: number;
  maxKg: number | null;
  markupPct: number;
  minimumServiceFeeBrl: number;
};

const envNumber = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

export function getPricingTier(requestedKg: number): PricingTier {
  const kg = Math.max(1, Math.floor(requestedKg));
  if (kg <= 24) return {
    key: "retail_micro",
    minKg: 1,
    maxKg: 24,
    markupPct: envNumber("ECOT_MARKUP_1_24_PCT", 40),
    minimumServiceFeeBrl: envNumber("ECOT_MIN_FEE_1_24_BRL", 2.9),
  };
  if (kg <= 99) return {
    key: "retail_small",
    minKg: 25,
    maxKg: 99,
    markupPct: envNumber("ECOT_MARKUP_25_99_PCT", 35),
    minimumServiceFeeBrl: envNumber("ECOT_MIN_FEE_25_99_BRL", 4.9),
  };
  if (kg <= 999) return {
    key: "retail_standard",
    minKg: 100,
    maxKg: 999,
    markupPct: envNumber("ECOT_MARKUP_100_999_PCT", 25),
    minimumServiceFeeBrl: envNumber("ECOT_MIN_FEE_100_999_BRL", 9.9),
  };
  if (kg <= 9999) return {
    key: "business",
    minKg: 1000,
    maxKg: 9999,
    markupPct: envNumber("ECOT_MARKUP_1000_9999_PCT", 20),
    minimumServiceFeeBrl: envNumber("ECOT_MIN_FEE_1000_9999_BRL", 29.9),
  };
  return {
    key: "enterprise",
    minKg: 10000,
    maxKg: null,
    markupPct: envNumber("ECOT_MARKUP_10000_PLUS_PCT", 15),
    minimumServiceFeeBrl: envNumber("ECOT_MIN_FEE_10000_PLUS_BRL", 0),
  };
}

export function priceFromSourceCost(input: {
  sourceCostBrl: number;
  requestedKg: number;
  fixedFeeBrl?: number;
}) {
  const tier = getPricingTier(input.requestedKg);
  const sourceCostBrl = Number(input.sourceCostBrl.toFixed(2));
  const percentageRevenue = sourceCostBrl * Math.max(0, tier.markupPct) / 100;
  const serviceRevenueBrl = Number((Math.max(percentageRevenue, tier.minimumServiceFeeBrl) + Math.max(0, input.fixedFeeBrl || 0)).toFixed(2));
  const finalTotalBrl = Number((sourceCostBrl + serviceRevenueBrl).toFixed(2));
  return { tier, sourceCostBrl, serviceRevenueBrl, finalTotalBrl };
}

export function publicPricingPolicy() {
  return [1, 25, 100, 1000, 10000].map((kg) => getPricingTier(kg));
}
