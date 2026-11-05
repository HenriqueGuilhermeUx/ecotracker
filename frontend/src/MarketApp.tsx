import { useEffect, useState } from "react";
import LegacyApp from "./App";
import { CarbonDesk } from "./CarbonDeskV2";
import { CarbonmarkRailPanel } from "./CarbonmarkRailPanel";
import { CarbonmarkRfqQualificationPanel } from "./CarbonmarkRfqQualificationPanel";
import { ClientAgreementPage } from "./ClientAgreementPage";
import { CorporateDemandIntake } from "./CorporateDemandIntake";
import { CorporateHome } from "./CorporateHome";
import { CorporateMarketplace } from "./CorporateMarketplace";
import { LargeOrderDealDesk } from "./LargeOrderDealDesk";
import { ContactPage, PrivacyPage, TermsPage } from "./LegalPages";
import { MarketAdmin } from "./MarketAdmin";
import { MarketShell } from "./MarketShell";
import { SellDesk } from "./SellDesk";
import "./market.css";
import "./market-live.css";
import "./commerce.css";
import "./corporate-state.css";

function LiquidityRailPage() {
  const token = localStorage.getItem("ecotracker_admin_token");
  if (!token) return <CorporateHome />;
  return <MarketShell><main className="carbon-desk"><header className="desk-head"><div><span className="tag">ECOTRACKER MARKET MAKER · ADMIN</span><h1>Infra de Liquidez</h1><p>RFQ → validação de liquidez → qualificação → elegibilidade.</p></div><div className="desk-head-actions"><a className="desk-button ghost" href="#carbon-desk">← Carbon Desk</a></div></header><CarbonmarkRfqQualificationPanel /><CarbonmarkRailPanel /></main></MarketShell>;
}

export default function MarketApp() {
  const [page, setPage] = useState(location.hash.replace("#", "") || "home");

  useEffect(() => {
    const handleHashChange = () => setPage(location.hash.replace("#", "") || "home");
    addEventListener("hashchange", handleHashChange);
    return () => removeEventListener("hashchange", handleHashChange);
  }, []);

  if (page.startsWith("agreement/")) return <ClientAgreementPage publicCode={page.slice("agreement/".length)} />;
  if (page === "home") return <CorporateHome />;
  if (page === "marketplace") return <CorporateMarketplace />;
  if (page === "request") return <CorporateDemandIntake />;
  if (page === "privacy") return <PrivacyPage />;
  if (page === "terms") return <TermsPage />;
  if (page === "contact") return <ContactPage />;
  if (page === "market-admin") return <MarketAdmin />;
  if (page === "carbon-desk") return <CarbonDesk />;
  if (page === "liquidity-rail" || page === "carbonmark-rail") return <LiquidityRailPage />;
  if (page === "deal-desk") return <LargeOrderDealDesk />;
  if (page === "sell") return <SellDesk />;
  return <LegacyApp />;
}
