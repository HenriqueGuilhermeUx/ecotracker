import { useEffect, useState } from "react";
import LegacyApp from "./App";
import { CarbonDesk } from "./CarbonDeskV2";
import { CarbonmarkRailPanel } from "./CarbonmarkRailPanel";
import { ClientAgreementPage } from "./ClientAgreementPage";
import { LargeOrderDealDesk } from "./LargeOrderDealDesk";
import { MarketCatalog } from "./MarketCatalog";
import { MarketAdmin } from "./MarketAdmin";
import { MarketShell } from "./MarketShell";
import "./market.css";
import "./market-live.css";
import "./commerce.css";

function CarbonmarkRailPage() {
  const token = localStorage.getItem("ecotracker_admin_token");
  if (!token) {
    return <MarketShell><main className="carbon-desk"><div className="desk-notice">Carbonmark Rail exige sessão admin. Entre primeiro na <a href="#carbon-desk">Carbon Desk</a> e depois volte para esta tela.</div></main></MarketShell>;
  }
  return <MarketShell><main className="carbon-desk"><header className="desk-head"><div><span className="tag">ECOTRACKER MARKET MAKER</span><h1>Carbonmark Rail</h1><p>Provider probe → qualification → eligibility.</p></div><div className="desk-head-actions"><a className="desk-button ghost" href="#carbon-desk">← Carbon Desk</a></div></header><CarbonmarkRailPanel /></main></MarketShell>;
}

export default function MarketApp() {
  const [page, setPage] = useState(location.hash.replace("#", "") || "home");

  useEffect(() => {
    const handleHashChange = () => setPage(location.hash.replace("#", "") || "home");
    addEventListener("hashchange", handleHashChange);
    return () => removeEventListener("hashchange", handleHashChange);
  }, []);

  if (page.startsWith("agreement/")) return <ClientAgreementPage publicCode={page.slice("agreement/".length)} />;
  if (page === "marketplace") return <MarketCatalog />;
  if (page === "market-admin") return <MarketAdmin />;
  if (page === "carbon-desk") return <CarbonDesk />;
  if (page === "carbonmark-rail") return <CarbonmarkRailPage />;
  if (page === "deal-desk") return <LargeOrderDealDesk />;
  return <LegacyApp />;
}
