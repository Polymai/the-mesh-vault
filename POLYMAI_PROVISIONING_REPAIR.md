# POLYMAI PROVISIONING REPAIR TASK

You are repairing a Polymai-generated app after provisioning failed or stopped.

## Goal
Fix the generated app files so Polymai provisioning can complete.

## Provisioning Summary
Status: failed
Run ID: mrvs9yu4-v5utryf
Started: 2026-07-22T07:51:11.653Z
Finished: 2026-07-22T07:51:18.939Z
Source: manual
App: app717
Workspace: c:\Users\svens\PolymaiProjects\app717

## Errors And Blockers
### 1. Provisioning automation failed: Supabase schema provisioning failed: must be owner of table messages

Raw message:
```text
Provisioning automation failed: Supabase schema provisioning failed: must be owner of table messages
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
      "app717-meshvault-webrtc-room"
    ],
    "sourceEdgeFunctions": [
      "app717-meshvault-api",
      "app717-meshvault-webrtc-room"
    ],
    "missingEdgeFunctions": [],
    "edgeFunctionsNeedingDeploy": [
      "app717-meshvault-api",
      "app717-meshvault-webrtc-room"
    ],
    "runtimeRpcNames": [
      "claim_repair_job",
      "record_audit"
    ],
    "missingRuntimeRpcs": [],
    "edgeSecretsRequired": false,
    "missingEdgeSecrets": "[REDACTED]",
    "edgeSecretsNeedingApply": "[REDACTED]",
    "authTemplatesRequired": true,
    "authTemplatesNeedingApply": true,
    "applied": false,
    "needsProvision": true,
    "dbConfigured": true,
    "managementConfigured": true,
    "message": "Supabase provisioning needed (DB schema/policies; schema plan; Edge Functions: app717-meshvault-api, app717-meshvault-webrtc-room; RPCs: claim_repair_job, record_audit; Auth email templates; Auth email templates need apply)."
  },
  "payments": {
    "checked": true,
    "hasPaymentIntent": false,
    "steps": [
      {
        "id": "app-payment-flow",
        "label": "App payment flow",
        "status": "skip",
        "detail": "No payment capability or Stripe backend artifacts detected."
      }
    ],
    "message": "No payment flow detected for this app."
  },
  "github": {
    "checked": true,
    "hasAutomation": false,
    "files": [],
    "sourceHash": "",
    "applied": false,
    "needsProvision": false,
    "missingConfig": [],
    "repo": "Polymai/meshvault",
    "branch": "",
    "status": "skip",
    "message": "No GitHub automation files detected."
  }
}
```

## Provisioning Log
- [2026-07-22T07:51:11.654Z] Provisioning info: Provisioning scan started.
- [2026-07-22T07:51:12.304Z] Provisioning info: Running Supabase provisioning...
- [2026-07-22T07:51:16.424Z] Provisioning warn: Supabase schema provisioning failed: must be owner of table messages

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
