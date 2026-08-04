# POLYMAI PROVISIONING REPAIR TASK

You are repairing a Polymai-generated app after provisioning failed or stopped.

## Goal
Fix the generated app files so Polymai provisioning can complete.

## Provisioning Summary
Status: failed
Run ID: msfawiq3-ddbz4xz
Started: 2026-08-04T23:40:13.103Z
Finished: 2026-08-04T23:40:21.579Z
Source: manual
App: app717
Workspace: c:\Users\svens\PolymaiProjects\app717

## Errors And Blockers
### 1. Provisioning automation failed: Supabase schema provisioning failed: record variable cannot be part of multiple-item INT

Raw message:
```text
Provisioning automation failed: Supabase schema provisioning failed: record variable cannot be part of multiple-item INTO list
```

## Important Context
Some errors may be downstream from earlier errors. Fix root causes in the app output files first, then return to Polymai and run provisioning again.

Do not remove product features just to make provisioning pass. Keep the app contract intact unless the provisioning error proves that the contract is wrong.

## You May Change
- Generated app source files.
- `registry.json` when files, capabilities, routes, mounts, or load order changed.
- `supabase/schema.sql`, `supabase/policies.sql`, `supabase/seed.sql`, and `data/schema.json`.
- App-scoped Edge Functions under `supabase/functions/<app-prefixed-name>/`.
- App runtime config files under `data/` when they reference generated app capabilities.

## Do Not Change Unless The Error Explicitly Requires It
- Polymai extension source code.
- Global/shared infrastructure outside this generated app.
- `polymai-stripe-webhook-router` routing infrastructure.
- Provider secrets, API keys, tokens, or frontend-exposed secret values.

## Start By Inspecting
- `registry.json`
- `POLYMAI_RULES.md`
- `POLYMAI_PLAYBOOK.md`
- `POLYMAI_CHECKS.cjs`
- `data/schema.json`
- `supabase/schema.sql`
- `supabase/policies.sql`
- `supabase/functions`
- `data/supabaseConfig.js`

## Current Provisioning Checks
```json
{
  "supabase": {
    "checked": true,
    "hasArtifacts": true,
    "hasDbArtifacts": true,
    "hasSchemaPlan": true,
    "hasStorageArtifacts": false,
    "hasSeedArtifacts": false,
    "edgeFunctions": [
      "app717-meshvault-api",
      "polymai-stripe-webhook-router"
    ],
    "sourceEdgeFunctions": [
      "app717-meshvault-api",
      "polymai-stripe-webhook-router"
    ],
    "missingEdgeFunctions": [],
    "edgeFunctionsNeedingDeploy": [
      "app717-meshvault-api"
    ],
    "runtimeRpcNames": [
      "begin_file_deletion",
      "claim_repair_job",
      "claim_segment_profile_upgrade",
      "commit_segment_profile_upgrade",
      "discover_node_candidates",
      "get_node_signal_topic",
      "link_version_segment",
      "network_totals",
      "publish_vault_index",
      "record_audit",
      "redeem_capability_link",
      "release_segment_profile_upgrade_claim",
      "renew_segment_profile_upgrade_claim",
      "send_mesh_signal"
    ],
    "missingRuntimeRpcs": [],
    "edgeSecretsRequired": "[REDACTED]",
    "missingEdgeSecrets": "[REDACTED]",
    "edgeSecretsNeedingApply": "[REDACTED]",
    "authTemplatesRequired": true,
    "authTemplatesNeedingApply": false,
    "applied": false,
    "needsProvision": true,
    "dbConfigured": true,
    "managementConfigured": true,
    "message": "Supabase provisioning needed (DB schema/policies; schema plan; Edge Functions: app717-meshvault-api, polymai-stripe-webhook-router; RPCs: begin_file_deletion, claim_repair_job, claim_segment_profile_upgrade, commit_segment_profile_upgrade, discover_node_candidates, get_node_signal_topic, link_version_segment, network_totals, publish_vault_index, record_audit, redeem_capability_link, release_segment_profile_upgrade_claim, renew_segment_profile_upgrade_claim, send_mesh_signal; Auth email templates; Edge secrets: STRIPE_CONNECT_CLIENT_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET; Edge Functions need deploy: app717-meshvault-api)."
  },
  "payments": {
    "checked": true,
    "hasPaymentIntent": true,
    "steps": [
      {
        "id": "stripe-config",
        "label": "Stripe config",
        "status": "ok",
        "detail": "test keys ready"
      },
      {
        "id": "stripe-price",
        "label": "Fixed Price ID",
        "status": "skip",
        "detail": "optional advanced default"
      },
      {
        "id": "edge-function",
        "label": "Webhook Edge Function",
        "status": "pending",
        "detail": "app717-meshvault-api needs Provision Supabase deploy"
      },
      {
        "id": "stripe-webhook",
        "label": "Stripe webhook router",
        "status": "ok",
        "detail": "we_1TcmMDRndyGeYiPNllMj56D0 -> app717-meshvault-api"
      },
      {
        "id": "supabase-stripe-secrets",
        "label": "Supabase Stripe secrets",
        "status": "ok",
        "detail": "applied STRIPE_CONNECT_CLIENT_ID, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET"
      },
      {
        "id": "payments-smoke",
        "label": "Payments smoke test",
        "status": "skip",
        "detail": "manual test not run"
      }
    ],
    "message": "Payment provisioning pending: Webhook Edge Function."
  },
  "github": {
    "checked": true,
    "hasAutomation": false,
    "files": [],
    "sourceHash": "",
    "applied": false,
    "needsProvision": false,
    "missingConfig": [],
    "repo": "Polymai/the-mesh-vault",
    "branch": "",
    "status": "skip",
    "message": "No GitHub automation files detected."
  }
}
```

## Provisioning Log
- [2026-08-04T23:40:13.105Z] Provisioning info: Provisioning scan started.
- [2026-08-04T23:40:14.789Z] Provisioning info: Running Supabase provisioning...
- [2026-08-04T23:40:18.484Z] Provisioning warn: Supabase schema provisioning failed: record variable cannot be part of multiple-item INTO list

## Repair Rules
- Fix source files, not generated symptoms.
- Keep DB schema, RLS policies, frontend calls, and Edge Functions aligned.
- Keep Stripe checkout, webhook, and billing tables aligned when the app has payments.
- Never expose secrets in frontend files.
- If a provider key is missing, keep the app resilient with a clear setup-needed state instead of crashing.

## Verification
Run:
```bash
node POLYMAI_CHECKS.cjs
```

Then return to Polymai and run Provision app again.
