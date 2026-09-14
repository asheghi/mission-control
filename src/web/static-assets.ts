import type { StaticAsset } from "../api/app";
import { webJavaScript, webStylesheet } from "../../.generated/web-assets";
import indexHtml from "./index.html" with { type: "text" };

export const STATIC_ASSETS: Readonly<Record<string, StaticAsset>> = {
  "/": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "/assets/app.js": { body: webJavaScript, contentType: "text/javascript; charset=utf-8" },
  "/assets/styles.css": { body: webStylesheet, contentType: "text/css; charset=utf-8" },
};
