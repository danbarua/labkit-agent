/**
 * Entry point for the React app. Sets up the root element and renders App.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/outfit/wght.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";

import { App } from "./App.tsx";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
(import.meta.hot.data.root ??= createRoot(elem)).render(app);
