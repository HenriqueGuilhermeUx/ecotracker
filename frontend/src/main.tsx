import React from "react";
import { createRoot } from "react-dom/client";
import MarketApp from "./MarketApp";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><MarketApp/></React.StrictMode>);
