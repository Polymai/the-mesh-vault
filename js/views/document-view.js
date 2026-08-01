import { PUBLIC_DOCUMENTS, getPublicDocument } from "../content/public-documents.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function documentLink(document, activeId) {
  return `<a class="document-nav__link${document.id === activeId ? " is-active" : ""}" href="#/${document.id}" ${document.id === activeId ? 'aria-current="page"' : ""}><span>${escapeHtml(document.kind)}</span><strong>${escapeHtml(document.title)}</strong></a>`;
}

export function renderDocumentView(documentId) {
  const document = getPublicDocument(documentId);
  if (!document) return "";
  const sectionNav = document.sections.map((section) => `<a href="#/${document.id}?section=${encodeURIComponent(section.id)}" data-document-section="${escapeHtml(section.id)}">${escapeHtml(section.title)}</a>`).join("");
  const sections = document.sections.map((section) => `<section class="document-section" id="document-${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>${section.body}</section>`).join("");
  return `<section class="document-room">
    <header class="document-hero">
      <span class="eyebrow">${escapeHtml(document.kind)}</span>
      <h1>${escapeHtml(document.title)}</h1>
      <p>${escapeHtml(document.summary)}</p>
      <dl class="document-meta"><div><dt>Version</dt><dd>${escapeHtml(document.version)}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(document.updated)}</dd></div><div><dt>Status</dt><dd>${escapeHtml(document.status)}</dd></div></dl>
    </header>
    ${document.notice ? `<aside class="document-notice" role="note">${document.notice}</aside>` : ""}
    <div class="document-layout">
      <aside class="document-sidebar" aria-label="Document navigation">
        <nav class="document-nav">${Object.values(PUBLIC_DOCUMENTS).map((entry) => documentLink(entry, document.id)).join("")}</nav>
        <nav class="document-toc" aria-label="On this page"><span>On this page</span>${sectionNav}</nav>
        <div class="document-tools"><button class="text-button" type="button" data-print-document>Print / save PDF</button><button class="text-button" type="button" data-copy-document-link>Copy page link</button><span class="document-copy-status" role="status"></span></div>
      </aside>
      <article class="document-paper" data-document-id="${escapeHtml(document.id)}">${sections}</article>
    </div>
  </section>`;
}

export function bindDocumentView() {
  document.querySelector("[data-print-document]")?.addEventListener("click", () => window.print());
  document.querySelector("[data-copy-document-link]")?.addEventListener("click", async () => {
    const status = document.querySelector(".document-copy-status");
    try {
      await navigator.clipboard.writeText(location.href);
      if (status) status.textContent = "Link copied";
    } catch {
      if (status) status.textContent = "Copy the address from your browser";
    }
  });
  document.querySelectorAll("[data-document-section]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    const section = document.getElementById(`document-${link.dataset.documentSection}`);
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", link.href);
  }));
  const sectionId = new URLSearchParams(location.hash.split("?")[1] || "").get("section");
  if (sectionId) window.requestAnimationFrame(() => document.getElementById(`document-${sectionId}`)?.scrollIntoView({ block: "start" }));
}
