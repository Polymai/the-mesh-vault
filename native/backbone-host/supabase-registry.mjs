import { existsSync, readFileSync, writeFileSync } from "node:fs";

const iso = (value = Date.now()) => new Date(value).toISOString();

function cleanOrigin(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("Backbone Supabase registration requires HTTPS.");
  return url.origin;
}

export class SupabaseNodeRegistry {
  constructor(config, layout, identity, sessionPath, store = null) {
    this.config = config?.supabase || {};
    this.layout = layout;
    this.identity = identity;
    this.store = store;
    this.sessionPath = sessionPath;
    this.session = null;
    this.timer = null;
    this.running = false;
    this.url = this.config.url ? cleanOrigin(this.config.url) : null;
    this.key = String(this.config.publishableKey || "").trim();
    if (this.url && this.key.length < 20) throw new Error("A frontend-safe Supabase publishable key is required for Backbone registration.");
    try { if (existsSync(sessionPath)) this.session = JSON.parse(readFileSync(sessionPath, "utf8")); } catch {}
  }

  get enabled() { return !!this.url && !!this.key; }
  get remotelyReachable() { return /^wss:\/\//i.test(String(this.layout.publicUrl || "")); }

  async request(path, { method = "GET", body, auth = false, headers = {} } = {}) {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        apikey: this.key,
        ...(auth && this.session?.access_token ? { Authorization: `Bearer ${this.session.access_token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Supabase registry request failed (${response.status}).`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  saveSession(value) {
    this.session = value;
    writeFileSync(this.sessionPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async authenticate() {
    if (!this.enabled) return false;
    const remaining = Number(this.session?.expires_at || 0) * 1000 - Date.now();
    if (this.session?.access_token && remaining > 120000) return true;
    let value = null;
    if (this.session?.refresh_token) {
      try {
        value = await this.request("/auth/v1/token?grant_type=refresh_token", {
          method: "POST", body: { refresh_token: this.session.refresh_token },
        });
      } catch {}
    }
    if (!value) value = await this.request("/auth/v1/signup", { method: "POST", body: {} });
    if (!value?.access_token || !value?.user?.id) throw new Error("Anonymous Backbone registration did not return a session.");
    value.expires_at = Math.floor(Date.now() / 1000) + Math.max(60, Number(value.expires_in || 3600));
    this.saveSession(value);
    return true;
  }

  rows(status = "online") {
    const now = Date.now();
    const publicUrl = String(this.layout.publicUrl || "");
    const aggregate = this.store?.aggregateStatus?.() || {};
    const instanceOnline = status === "online" && Number(aggregate.capacityBytes || 0) > 0;
    return [{
      id: this.layout.physicalHostId,
      supabase_auth_id: this.session.user.id,
      vault_id: null,
      device_public_key: this.identity.publicKey,
      device_label: this.layout.label || "TheMeshVault Backbone",
      status: instanceOnline ? "online" : "offline",
      capacity_bytes: instanceOnline ? Number(aggregate.capacityBytes || 0) : 0,
      used_bytes: instanceOnline ? Math.min(Number(aggregate.capacityBytes || 0), Number(aggregate.usedBytes || 0)) : 0,
      last_seen_at: iso(now),
      country_code: null,
      region_code: null,
      network_domain_hash: null,
      failure_domain_id: aggregate.failureDomainId || `physical-host:${this.layout.physicalHostId}`,
      survival_mode: true,
      lifecycle_state: instanceOnline ? "serving" : "stopped",
      lease_expires_at: iso(now + (instanceOnline ? 15 * 60 * 1000 : 0)),
      session_started_at: iso(this.startedAt || now),
      uptime_seconds: Math.max(0, Math.floor((now - (this.startedAt || now)) / 1000)),
      reliability_score: 1,
      wake_lock_active: false,
      coordination_protocol_version: 3,
      anchor_protocol_version: 3,
      anchor_control_capacity_bytes: Number(this.config.controlCapacityBytes || 268435456),
      anchor_control_used_bytes: 0,
      anchor_connected_nodes: 0,
      coordination_mode: "anchor-primary",
      last_anchor_report_at: iso(now),
      backbone_url: publicUrl,
      backbone_public_key: this.identity.publicKey,
    }];
  }

  async upsert(status = "online") {
    if (!this.enabled || !this.remotelyReachable) return false;
    await this.authenticate();
    await this.request("/rest/v1/nodes?on_conflict=id", {
      method: "POST",
      auth: true,
      body: this.rows(status),
      headers: {
        "Content-Profile": "app717_meshvault",
        "Accept-Profile": "app717_meshvault",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
    });
    return true;
  }

  async syncInstances() { return this.upsert("online"); }

  async start() {
    // A loopback-only process is useful for local testing but cannot receive
    // storage from the public mesh. It must never create a Supabase identity,
    // heartbeat, or advertise capacity merely because the process is alive.
    if (!this.enabled || !this.remotelyReachable || this.running) return false;
    this.running = true;
    this.startedAt = Date.now();
    await this.upsert("online");
    const interval = Math.max(300000, Number(this.config.heartbeatMs || 600000));
    this.timer = setInterval(() => this.upsert("online").catch(() => {}), interval);
    this.timer.unref?.();
    return true;
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.enabled && this.remotelyReachable) await this.upsert("offline").catch(() => {});
  }
}
