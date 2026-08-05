import * as SecureStore from "expo-secure-store";
import type { LocalProfile } from "./types";

const PROFILE_KEY = "ecotracker.profile.v1";
const QUOTES_KEY = "ecotracker.quotes.v1";
const RECOMMENDATION_KEY = "ecotracker.recommendation.v1";

export const emptyProfile: LocalProfile = {
  name: "",
  email: "",
  phone: "",
  companyName: "",
  taxId: "",
  preferredDelivery: "email",
  walletAddress: "",
};

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await SecureStore.getItemAsync(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export const loadProfile = () => readJson<LocalProfile>(PROFILE_KEY, emptyProfile);
export const saveProfile = (profile: LocalProfile) => SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(profile));
export const loadQuoteCodes = () => readJson<string[]>(QUOTES_KEY, []);

export async function saveQuoteCode(code: string): Promise<string[]> {
  const current = await loadQuoteCodes();
  const next = [code, ...current.filter((item) => item !== code)].slice(0, 50);
  await SecureStore.setItemAsync(QUOTES_KEY, JSON.stringify(next));
  return next;
}

export async function removeQuoteCode(code: string): Promise<string[]> {
  const next = (await loadQuoteCodes()).filter((item) => item !== code);
  await SecureStore.setItemAsync(QUOTES_KEY, JSON.stringify(next));
  return next;
}

export async function loadRecommendation(): Promise<number> {
  const value = await SecureStore.getItemAsync(RECOMMENDATION_KEY);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export const saveRecommendation = (kg: number) =>
  SecureStore.setItemAsync(RECOMMENDATION_KEY, String(Math.max(1, Math.round(kg))));

export async function clearLocalData(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(PROFILE_KEY),
    SecureStore.deleteItemAsync(QUOTES_KEY),
    SecureStore.deleteItemAsync(RECOMMENDATION_KEY),
  ]);
}
