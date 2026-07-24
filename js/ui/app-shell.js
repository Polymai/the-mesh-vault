import { shouldShowMeshKeyBanner, renderMeshKeyBanner, bindMeshKeyBanner } from "./mesh-key-banner.js";
import { cancelTask, dismissTask } from "./task-state.js";
import { BRAND_NAME, renderBrandWordmark } from "./brand.js";

const navItems = [
  ["dashboard", "Overview"], ["drive", "My Drive"], ["mesh", "Live Mesh"], ["anchor", "Anchor"], ["recovery", "Mesh Key"], ["settings", "Settings"],
];
let stopPublicHeaderSync = () => {};

function bindPublicHeaderScroll() {
  stopPublicHeaderSync();
  const header = document.querySelector("[data-public-header]");
  if (!header) { stopPublicHeaderSync = () => {}; return; }
  let frame = 0;
  const sync = () => {
    const compact = header.classList.contains("is-compact");
    if (!compact && window.scrollY > 48) header.classList.add("is-compact");
    else if (compact && window.scrollY < 12) header.classList.remove("is-compact");
    frame = 0;
  };
  const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(sync); };
  window.addEventListener("scroll", onScroll, { passive: true });
  sync();
  stopPublicHeaderSync = () => { window.removeEventListener("scroll", onScroll); if (frame) window.cancelAnimationFrame(frame); };
}

let stopPublicMenu = () => {};
function bindPublicMenu() {
  stopPublicMenu();
  const toggle = document.querySelector("[data-public-menu-toggle]");
  const drawer = document.querySelector("[data-public-menu]");
  const backdrop = document.querySelector("[data-public-menu-backdrop]");
  const closeBtn = document.querySelector("[data-public-menu-close]");
  if (!toggle || !drawer) { stopPublicMenu = () => {}; return; }
  const close = () => { drawer.classList.remove("is-open"); drawer.setAttribute("aria-hidden", "true"); backdrop?.classList.remove("is-open"); toggle.setAttribute("aria-expanded", "false"); };
  const onToggleClick = () => {
    const open = !drawer.classList.contains("is-open");
    drawer.classList.toggle("is-open", open); drawer.setAttribute("aria-hidden", String(!open)); backdrop?.classList.toggle("is-open", open); toggle.setAttribute("aria-expanded", String(open));
  };
  const onLinkClick = () => close();
  const onEscape = (event) => { if (event.key === "Escape") close(); };
  toggle.addEventListener("click", onToggleClick);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);
  drawer.querySelectorAll("a").forEach((link) => link.addEventListener("click", onLinkClick));
  document.addEventListener("keydown", onEscape);
  stopPublicMenu = () => { toggle.removeEventListener("click", onToggleClick); document.removeEventListener("keydown", onEscape); };
}

function routeLink(id, label, active) { return `<a class="nav-link${active === id ? " is-active" : ""}" href="#/${id}" data-route-link="${id}" ${active === id ? 'aria-current="page"' : ""}>${label}</a>`; }
function anchorRoleBadge(state, modifier = "") {
  return state.anchor?.enabled ? `<span class="anchor-role-badge${modifier ? ` anchor-role-badge--${modifier}` : ""}" title="This browser is running as an Anchor"><i aria-hidden="true"></i>Anchor</span>` : "";
}
function vaultLabel(state) {
  if (state.identity) return `Vault ${state.identity.ownerPublicKey.slice(0, 10)}…`;
  if (state.storageNodeOnly) return "Storage node";
  return BRAND_NAME;
}
const taskPhaseLabels = { preparing: "Preparing", reading: "Reading segment", compressing: "Compressing", encrypting: "Encrypting", sharding: "Creating shards", sending: "Sending and verifying", publishing: "Publishing manifest", complete: "Stored", failed: "Needs attention" };
const uploadStages = [["compressing", "Compress"], ["encrypting", "Encrypt"], ["sharding", "Shard"], ["sending", "Send"]];
const escapeTaskText = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function renderUploadTask(state) {
  const uploads = Object.values(state.activeTasks).filter((task) => task.kind === "upload");
  if (!uploads.length) return "";
  const task = uploads.at(-1); const percent = Math.round(Number(task.progress || 0) * 100); const currentStage = uploadStages.findIndex(([phase]) => phase === task.phase); const finalizing = ["publishing", "complete"].includes(task.phase);
  const stages = uploadStages.map(([phase, label], index) => `<li class="${task.phase === phase ? "is-active" : (currentStage > index || finalizing ? "is-done" : "")}"><i aria-hidden="true"></i><span>${label}</span></li>`).join("");
  const segment = task.totalSegments ? `Segment ${Math.min(task.segmentIndex || 1, task.totalSegments)} of ${task.totalSegments}` : "Preparing file";
  const actions = task.status === "running" ? `<button type="button" data-cancel-task="${task.id}">Cancel upload</button>` : `<button type="button" data-dismiss-task="${task.id}">Close</button>`;
  return `<aside class="upload-status upload-status--${task.status}" role="status" aria-live="polite" aria-label="Upload progress">
    <div class="upload-status__head"><div><span>${escapeTaskText(taskPhaseLabels[task.phase] || "Securing file")}</span><strong>${escapeTaskText(task.fileName || task.label)}</strong></div><b>${percent}%</b></div>
    <progress max="1" value="${Number(task.progress || 0)}">${percent}%</progress>
    <div class="upload-status__meta"><span>${escapeTaskText(segment)}</span><span>${escapeTaskText(task.message || "Starting secure upload")}</span></div>
    <ol class="upload-stages">${stages}</ol>
    <div class="upload-status__foot"><span>${task.status === "running" ? "Keep this tab open until the upload is complete." : escapeTaskText(task.message)}</span>${actions}</div>
  </aside>`;
}
export function renderShell(state, content) {
  const publicRoute = ["home", "onboarding", "security", "terms", "privacy"].includes(state.route);
  const notice = state.notice ? `<div class="notice notice--${state.notice.tone}" role="status"><span>${state.notice.message}</span><button type="button" data-dismiss-notice aria-label="Dismiss message">Close</button></div>` : "";
  if (publicRoute) {
    const action = state.identity
      ? '<a href="#/dashboard" class="button button--small">Back to vault</a>'
      : state.storageNodeOnly
        ? '<a href="#/settings" class="button button--small">Back to node</a>'
        : state.route === "onboarding"
          ? '<a href="#/home" class="button button--small">Back home</a>'
          : '<a href="#/onboarding" class="button button--small">Create my vault</a>';
    const publicLinks = `<a class="nav-link${state.route === "security" ? " is-active" : ""}" href="#/security">How it works</a><a class="nav-link${state.route === "terms" ? " is-active" : ""}" href="#/terms">Terms</a><a class="nav-link${state.route === "privacy" ? " is-active" : ""}" href="#/privacy">Privacy</a>`;
    return `<div class="site-shell"><header class="public-header" data-public-header><nav class="public-nav" aria-label="Public navigation"><a class="button button--ghost button--small" href="#/security">How it works</a></nav><div class="brand-scoop" aria-hidden="true"></div>${renderBrandWordmark()}<button type="button" class="public-menu-toggle" data-public-menu-toggle aria-label="Open navigation" aria-expanded="false" aria-controls="public-sidebar">Menu</button><div class="public-actions">${action}</div></header><div class="drawer-backdrop" data-public-menu-backdrop></div><aside id="public-sidebar" class="public-sidebar" data-public-menu aria-hidden="true"><div class="sidebar-head">${renderBrandWordmark()}<button type="button" class="drawer-close" data-public-menu-close aria-label="Close navigation">Close</button></div><nav class="side-nav" aria-label="Public navigation">${publicLinks}</nav><div class="public-sidebar-foot">${action}</div></aside>${notice}<main id="route-view">${content}</main><footer class="public-footer"><span>${BRAND_NAME}</span><nav aria-label="Legal and technical information"><a href="#/security">Security & Architecture</a><a href="#/terms">Terms</a><a href="#/privacy">Privacy</a></nav><span>No account required. Your Mesh Key controls access.</span></footer></div>`;
  }
  if (state.route === "night-node") return `<main id="route-view">${notice}${content}</main>`;
  const items = state.identity ? navItems : navItems.filter(([id]) => ["anchor", "settings"].includes(id));
  const banner = shouldShowMeshKeyBanner(state) ? renderMeshKeyBanner() : "";
  const roleBadge = anchorRoleBadge(state);
  return `<div class="app-shell${state.mobileNavOpen ? " nav-open" : ""}"><header class="mobile-topbar"><button class="menu-toggle" type="button" aria-label="Open navigation" aria-expanded="${state.mobileNavOpen}" aria-controls="app-sidebar" data-toggle-nav>Menu</button>${renderBrandWordmark({ href: "#/dashboard" })}<div class="mobile-node-state">${anchorRoleBadge(state, "mobile")}<span class="node-dot node-dot--${state.node.status}" title="Node ${state.node.status}"></span></div></header><div class="drawer-backdrop" data-close-nav></div><aside id="app-sidebar" class="sidebar"><div class="sidebar-head">${renderBrandWordmark({ href: "#/dashboard" })}<button type="button" class="drawer-close" data-close-nav aria-label="Close navigation">Close</button></div><div class="node-summary"><span class="node-dot node-dot--${state.node.status}"></span><div><strong>This device ${anchorRoleBadge(state, "dark")}</strong><span>${state.anchor?.enabled ? "Anchor · helping the mesh" : state.node.status === "online" ? "Helping the mesh" : state.node.status}</span></div></div><nav class="side-nav" aria-label="Main navigation">${items.map(([id, label]) => routeLink(id, label, state.route)).join("")}</nav><div class="sidebar-foot"><span class="account-email">${vaultLabel(state)}</span>${state.identity ? `<span class="mesh-key-indicator">${state.identity.meshKeySaved ? "Mesh Key saved" : "Mesh Key not saved"}</span>` : ""}<nav class="sidebar-legal" aria-label="Legal and security"><a href="#/security">Security</a><a href="#/terms">Terms</a><a href="#/privacy">Privacy</a></nav></div></aside><main class="app-main"><div class="app-topline"><div><span class="eyebrow">Private workspace</span><strong>${navItems.find(([id]) => id === state.route)?.[1] || BRAND_NAME}</strong></div><div class="app-topline-status">${roleBadge}<span class="key-state">${state.identity ? "No-account vault" : "Storage node only"}</span></div></div>${notice}${banner}<div id="route-view" class="route-view">${content}</div></main>${renderUploadTask(state)}</div>`;
}
export function bindShell({ onToggleNav, onCloseNav, onDismiss, onScrollTarget }) {
  bindPublicHeaderScroll();
  bindPublicMenu();
  bindMeshKeyBanner();
  document.querySelector("[data-toggle-nav]")?.addEventListener("click", onToggleNav);
  document.querySelectorAll("[data-close-nav], [data-route-link]").forEach((el) => el.addEventListener("click", onCloseNav));
  document.querySelector("[data-dismiss-notice]")?.addEventListener("click", onDismiss);
  document.querySelector("[data-dismiss-task]")?.addEventListener("click", (event) => dismissTask(event.currentTarget.dataset.dismissTask));
  document.querySelector("[data-cancel-task]")?.addEventListener("click", (event) => { if (window.confirm("Cancel this upload? The incomplete encrypted data will be cleaned up.")) cancelTask(event.currentTarget.dataset.cancelTask); });
  document.querySelectorAll("[data-scroll-target]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); onScrollTarget(link.dataset.scrollTarget); }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") onCloseNav(); }, { once: true });
}
