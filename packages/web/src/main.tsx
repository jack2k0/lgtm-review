import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveToken, sessionStore } from "./token";
import "./styles.css";

const { token, stripHash } = resolveToken(window.location.hash, sessionStore());
if (stripHash) {
  // Remove the token from the address bar and history entry; it now lives in sessionStorage / memory only.
  history.replaceState(null, "", window.location.pathname + window.location.search);
}
createRoot(document.getElementById("root")!).render(<App token={token} />);
