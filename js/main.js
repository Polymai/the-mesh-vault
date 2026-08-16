import { bootstrap } from "./bootstrap.js";
import { BRAND_NAME, renderBrandWordmark } from "./ui/brand.js";
import { ensureAppServiceWorker } from "./platform/service-worker.js";

ensureAppServiceWorker().catch(() => {});
bootstrap().catch((error) => {
  const app = document.querySelector("#app");
  if (app) app.innerHTML = `<main class="boot-screen">${renderBrandWordmark()}<h1>${BRAND_NAME} could not start</h1><p>${String(error.message || "Unexpected startup error").replace(/[<>]/g, "")}</p><button class="button" type="button" onclick="location.reload()">Try again</button></main>`;
});
