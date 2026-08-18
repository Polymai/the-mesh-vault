export const BRAND_NAME = "TheMeshVault";

const glyph = `<span class="brand-glyph" aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false"><path class="brand-glyph__frame" d="M16 2.8 27.4 9.4v13.2L16 29.2 4.6 22.6V9.4Z"/><path class="brand-glyph__mesh" d="m4.9 9.6 11.1 6.5 11.1-6.5M16 16.1v12.6"/><circle class="brand-glyph__node" cx="16" cy="16.1" r="2.15"/></svg></span>`;
const lockup = `<span class="brand-lockup"><span class="brand-the">The</span><span class="brand-name">MeshVault</span></span>`;

export function renderBrandWordmark({ href = "#/home", label = `${BRAND_NAME} home`, className = "" } = {}) {
  const extraClass = String(className || "").trim();
  return `<a class="brand-wordmark${extraClass ? ` ${extraClass}` : ""}" href="${href}" aria-label="${label}">${glyph}${lockup}</a>`;
}
