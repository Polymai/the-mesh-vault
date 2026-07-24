import { getState, setState } from "./state/store.js";
import { renderShell, bindShell } from "./ui/app-shell.js";
import { BRAND_NAME, renderBrandWordmark } from "./ui/brand.js";
import { renderLanding } from "./views/auth-view.js";
import { renderOnboardingView, bindOnboardingView } from "./views/onboarding-view.js";
import { renderDashboardView } from "./views/dashboard-view.js";
import { renderDriveView, bindDriveView } from "./views/drive-view.js";
import { renderMeshView, bindMeshView } from "./views/mesh-view.js";
import { renderRecoveryView, bindRecoveryView } from "./views/recovery-view.js";
import { renderSettingsView, bindSettingsView } from "./views/settings-view.js";
import { renderAnchorView, bindAnchorView } from "./views/anchor-view.js";
import { renderTrustedDevicesView, bindTrustedDevicesView } from "./views/trusted-devices-view.js";
import { renderAccountLinkView, bindAccountLinkView } from "./views/account-link-view.js";
import { renderShareView, bindShareView } from "./views/share-view.js";
import { renderNightNodeView, bindNightNodeView } from "./views/night-node-view.js";
import { renderDocumentView, bindDocumentView } from "./views/document-view.js";
import { parseShareFragment } from "./security/capability.js";

const allowed = new Set(["home", "onboarding", "security", "terms", "privacy", "dashboard", "drive", "mesh", "anchor", "recovery", "settings", "trusted-devices", "account", "night-node"]);
const DOCUMENT_ROUTES = new Set(["security", "terms", "privacy"]);
const PUBLIC_ROUTES = new Set(["home", "onboarding", ...DOCUMENT_ROUTES]);
const VAULT_ONLY_ROUTES = new Set(["dashboard", "drive", "mesh", "recovery", "trusted-devices", "account"]);
let appActions = null; let rendering = false; let lastRenderKey = null;
function routeFromHash() { const route = location.hash.replace(/^#\//, "").split(/[?#]/)[0] || "home"; return allowed.has(route) ? route : "home"; }
function parseShareHash() {
  const match = /^#\/share\/([^/]+)\/([^/?#]+)/.exec(location.hash);
  if (!match) return null;
  try { return { capabilityId: decodeURIComponent(match[1]), fragmentPayload: parseShareFragment(match[2]) }; } catch { return null; }
}
function guardedRoute(state) {
  if (state.identity) return ["home", "onboarding"].includes(state.route) ? "dashboard" : state.route;
  if (state.storageNodeOnly) return state.route === "onboarding" ? "onboarding" : (VAULT_ONLY_ROUTES.has(state.route) ? "settings" : state.route);
  return PUBLIC_ROUTES.has(state.route) ? state.route : "onboarding";
}
function scrollToLandingSection(id) {
  const scroll = () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (guardedRoute(getState()) === "home") { scroll(); return; }
  location.hash = "#/home";
  window.requestAnimationFrame(() => window.requestAnimationFrame(scroll));
}
function bootMarkup(state) { return `<main class="boot-screen" role="status" aria-busy="true">${renderBrandWordmark()}<div class="loader-ring"></div><h1>${state.error ? `${BRAND_NAME} needs attention` : `Opening ${BRAND_NAME}`}</h1><p>${state.error || "Setting up your local cryptographic identity…"}</p>${state.error ? `<button class="button" type="button" data-retry-boot>Try again</button>` : ""}</main>`; }
function renderKey(state) {
  const route = guardedRoute(state);
  const common = {
    boot: state.boot, error: state.error, route, storageNodeOnly: state.storageNodeOnly,
    identity: state.identity ? { vaultId: state.identity.vaultId, meshKeySaved: state.identity.meshKeySaved } : null,
    mobileNavOpen: state.mobileNavOpen, notice: state.notice, nodeStatus: state.node.status,
    anchorRole: { enabled: !!state.anchor?.enabled, status: state.anchor?.status || "off" },
    activeTasks: state.activeTasks,
  };
  if (route === "dashboard") return JSON.stringify({ ...common, files: state.files, pendingDeletions: state.pendingDeletions, vaultStorage: state.vaultStorage, network: state.network, node: state.node });
  if (route === "drive") return JSON.stringify({ ...common, files: state.files, pendingDeletions: state.pendingDeletions, folders: state.folders, transfers: state.transfers });
  if (route === "mesh") return JSON.stringify({ ...common, files: state.files, nodes: state.nodes, network: state.network, transfers: state.transfers, myStorageNodeIds: state.myStorageNodeIds, anchor: state.anchor });
  if (route === "settings") return JSON.stringify({ ...common, node: state.node, vaultProfile: state.vaultProfile });
  if (route === "anchor") return JSON.stringify({ ...common, anchor: state.anchor });
  if (route === "night-node") return JSON.stringify({ ...common, node: state.node, anchor: state.anchor, survival: state.survival });
  if (route === "trusted-devices") return JSON.stringify({ ...common, trustedDevices: state.trustedDevices });
  if (route === "account") return JSON.stringify({ ...common, accountLink: state.accountLink });
  return JSON.stringify(common);
}
function captureActiveForm() {
  const active = document.activeElement;
  const form = active?.closest?.("form");
  if (!form) return null;
  const marker = form.getAttributeNames().find((name) => name.startsWith("data-"));
  if (!marker) return null;
  const fields = Array.from(form.elements).filter((field) => field.name).map((field) => ({
    name: field.name, value: field.value, checked: field.checked, checkable: ["checkbox", "radio"].includes(field.type),
  }));
  return { marker, fields, activeName: active.name || null };
}
function restoreActiveForm(snapshot) {
  if (!snapshot) return;
  const form = document.querySelector(`form[${snapshot.marker}]`);
  if (!form) return;
  for (const saved of snapshot.fields) {
    const field = Array.from(form.elements).find((candidate) => candidate.name === saved.name);
    if (!field) continue;
    if (saved.checkable) field.checked = saved.checked;
    else field.value = saved.value;
  }
  if (snapshot.activeName) Array.from(form.elements).find((field) => field.name === snapshot.activeName)?.focus();
}
export function renderApp(force = false) {
  if (rendering) return; rendering = true;
  try {
    const state = getState(); const share = parseShareHash();
    const nextRenderKey = share
      ? JSON.stringify({ boot: state.boot, error: state.error, capabilityId: share.capabilityId, notice: state.notice })
      : renderKey(state);
    if (!force && nextRenderKey === lastRenderKey) return;
    lastRenderKey = nextRenderKey;
    const activeForm = captureActiveForm();
    if (state.boot === "loading" || state.boot === "error") { document.querySelector("#app").innerHTML = bootMarkup(state); document.querySelector("[data-retry-boot]")?.addEventListener("click", appActions.initialize); return; }
    if (share) {
      document.querySelector("#app").innerHTML = renderShell({ ...state, route: "home" }, renderShareView());
      bindShell({ onToggleNav: () => setState((s) => ({ mobileNavOpen: !s.mobileNavOpen })), onCloseNav: () => setState({ mobileNavOpen: false }), onDismiss: () => setState({ notice: null }), onScrollTarget: scrollToLandingSection });
      bindShareView(share.capabilityId, share.fragmentPayload);
      return;
    }
    const route = guardedRoute(state); let view;
    if (route === "home") view = renderLanding();
    else if (route === "onboarding") view = renderOnboardingView();
    else if (DOCUMENT_ROUTES.has(route)) view = renderDocumentView(route);
    else if (route === "dashboard") view = renderDashboardView(state);
    else if (route === "drive") view = renderDriveView(state);
    else if (route === "mesh") view = renderMeshView(state);
    else if (route === "recovery") view = renderRecoveryView(state);
    else if (route === "trusted-devices") view = renderTrustedDevicesView(state);
    else if (route === "account") view = renderAccountLinkView(state);
    else if (route === "anchor") view = renderAnchorView(state);
    else if (route === "night-node") view = renderNightNodeView(state);
    else view = renderSettingsView(state);
    document.querySelector("#app").innerHTML = renderShell({ ...state, route }, view);
    bindShell({ onToggleNav: () => setState((s) => ({ mobileNavOpen: !s.mobileNavOpen })), onCloseNav: () => setState({ mobileNavOpen: false }), onDismiss: () => setState({ notice: null }), onScrollTarget: scrollToLandingSection });
    if (route === "onboarding") bindOnboardingView(appActions.onboarding);
    if (DOCUMENT_ROUTES.has(route)) bindDocumentView();
    if (route === "drive") bindDriveView(appActions.drive, state);
    if (route === "mesh") bindMeshView(appActions.mesh);
    if (route === "recovery") bindRecoveryView(appActions.meshKey);
    if (route === "trusted-devices") bindTrustedDevicesView(appActions.devices);
    if (route === "account") bindAccountLinkView(appActions.account);
    if (route === "anchor") bindAnchorView(appActions.settings);
    if (route === "settings") bindSettingsView(appActions.settings);
    if (route === "night-node") bindNightNodeView(appActions.nightNode);
    restoreActiveForm(activeForm);
  } finally { rendering = false; }
}
export function startRouter(actions) {
  appActions = actions; const sync = () => { const next = routeFromHash(); setState({ route: next, mobileNavOpen: false }); };
  window.addEventListener("hashchange", sync); window.addEventListener("resize", () => { if (innerWidth > 900 && getState().mobileNavOpen) setState({ mobileNavOpen: false }); }); sync();
}
