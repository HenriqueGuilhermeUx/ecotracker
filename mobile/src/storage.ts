import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
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

function hasWebStorage() {
  return Platform.OS === "web" && typeof globalThis !== "undefined" && "localStorage" in globalThis;
}

async function getItem(key: string): Promise<string | null> {
  if (hasWebStorage()) {
    try { return globalThis.localStorage.getItem(key); } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (hasWebStorage()) {
    try { globalThis.localStorage.setItem(key, value); return; } catch { return; }
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteItem(key: string): Promise<void> {
  if (hasWebStorage()) {
    try { globalThis.localStorage.removeItem(key); return; } catch { return; }
  }
  await SecureStore.deleteItemAsync(key);
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export const loadProfile = () => readJson<LocalProfile>(PROFILE_KEY, emptyProfile);
export const saveProfile = (profile: LocalProfile) => setItem(PROFILE_KEY, JSON.stringify(profile));
export const loadQuoteCodes = () => readJson<string[]>(QUOTES_KEY, []);

export async function saveQuoteCode(code: string): Promise<string[]> {
  const current = await loadQuoteCodes();
  const next = [code, ...current.filter((item) => item !== code)].slice(0, 50);
  await setItem(QUOTES_KEY, JSON.stringify(next));
  return next;
}

export async function removeQuoteCode(code: string): Promise<string[]> {
  const next = (await loadQuoteCodes()).filter((item) => item !== code);
  await setItem(QUOTES_KEY, JSON.stringify(next));
  return next;
}

export async function loadRecommendation(): Promise<number> {
  const value = await getItem(RECOMMENDATION_KEY);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export const saveRecommendation = (kg: number) =>
  setItem(RECOMMENDATION_KEY, String(Math.max(1, Math.round(kg))));

export async function clearLocalData(): Promise<void> {
  await Promise.all([
    deleteItem(PROFILE_KEY),
    deleteItem(QUOTES_KEY),
    deleteItem(RECOMMENDATION_KEY),
  ]);
}
