import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { setNonce } from "get-nonce";
import App from "./App";
import "./index.css";

const rawNonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
const nonce = rawNonce && rawNonce !== "__CSP_NONCE__" ? rawNonce : undefined;
if (nonce) setNonce(nonce);

createRoot(document.getElementById("root")!).render(
  <StrictMode><MotionConfig reducedMotion="user" nonce={nonce}><App /></MotionConfig></StrictMode>
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").then((registration) => {
      const notify = () => window.dispatchEvent(new CustomEvent("clipbridge-update", { detail: registration }));
      if (registration.waiting) notify();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", () => {
          if (registration.waiting && navigator.serviceWorker.controller) notify();
        });
      });
    }).catch(() => {});
  });
}
