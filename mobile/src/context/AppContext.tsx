import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LocalProfile } from "../types";
import {
  emptyProfile,
  loadProfile,
  loadQuoteCodes,
  loadRecommendation,
  removeQuoteCode as removeStoredQuote,
  saveProfile as persistProfile,
  saveQuoteCode as persistQuote,
  saveRecommendation as persistRecommendation,
} from "../storage";

type AppContextValue = {
  hydrated: boolean;
  profile: LocalProfile;
  quoteCodes: string[];
  recommendationKg: number;
  updateProfile: (profile: LocalProfile) => Promise<void>;
  addQuote: (code: string) => Promise<void>;
  removeQuote: (code: string) => Promise<void>;
  updateRecommendation: (kg: number) => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [profile, setProfile] = useState<LocalProfile>(emptyProfile);
  const [quoteCodes, setQuoteCodes] = useState<string[]>([]);
  const [recommendationKg, setRecommendationKg] = useState(100);

  useEffect(() => {
    Promise.all([loadProfile(), loadQuoteCodes(), loadRecommendation()])
      .then(([savedProfile, savedQuotes, savedRecommendation]) => {
        setProfile(savedProfile);
        setQuoteCodes(savedQuotes);
        setRecommendationKg(savedRecommendation);
      })
      .finally(() => setHydrated(true));
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    hydrated,
    profile,
    quoteCodes,
    recommendationKg,
    updateProfile: async (next) => {
      setProfile(next);
      await persistProfile(next);
    },
    addQuote: async (code) => {
      const next = await persistQuote(code);
      setQuoteCodes(next);
    },
    removeQuote: async (code) => {
      const next = await removeStoredQuote(code);
      setQuoteCodes(next);
    },
    updateRecommendation: async (kg) => {
      const next = Math.max(1, Math.round(kg));
      setRecommendationKg(next);
      await persistRecommendation(next);
    },
  }), [hydrated, profile, quoteCodes, recommendationKg]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp precisa estar dentro de AppProvider");
  return context;
}
