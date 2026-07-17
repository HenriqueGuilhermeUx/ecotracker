import { useEffect, useState } from "react";
import LegacyApp from "./App";
import { MarketCatalog } from "./MarketCatalog";
import { MarketAdmin } from "./MarketAdmin";
import "./market.css";

export default function MarketApp() {
  const [page, setPage] = useState(location.hash.replace("#", "") || "home");

  useEffect(() => {
    const handleHashChange = () => setPage(location.hash.replace("#", "") || "home");
    addEventListener("hashchange", handleHashChange);
    return () => removeEventListener("hashchange", handleHashChange);
  }, []);

  if (page === "marketplace") return <MarketCatalog />;
  if (page === "market-admin") return <MarketAdmin />;
  return <LegacyApp />;
}
