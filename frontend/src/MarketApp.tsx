import { useEffect, useState } from "react";
import LegacyApp from "./App";
import { CarbonDesk } from "./CarbonDeskV2";
import { ClientAgreementPage } from "./ClientAgreementPage";
import { LargeOrderDealDesk } from "./LargeOrderDealDesk";
import { MarketCatalog } from "./MarketCatalog";
import { MarketAdmin } from "./MarketAdmin";
import "./market.css";
import "./market-live.css";
import "./commerce.css";

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
  if (page === "deal-desk") return <LargeOrderDealDesk />;
  return <LegacyApp />;
}
