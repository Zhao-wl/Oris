import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { startAppearance } from "./appearance";
import "./styles.css";

// 挂载前同步套用上次保存的配色首屏变量，避免先显示默认配色再切换（B21）。
startAppearance();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
