import React from "react";
import ReactDOM from "react-dom/client";
import App, { MiniPlayerApp } from "./App";

const isMini = new URLSearchParams(window.location.search).get("mini") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMini ? <MiniPlayerApp /> : <App />}
  </React.StrictMode>,
);
