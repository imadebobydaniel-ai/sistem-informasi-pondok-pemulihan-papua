# R6-B test results

## R6-B tests

Command: `node --experimental-strip-types --test candidates/jadwal-v2-cloud-r6b/EDGE-ADAPTER/tests/r6b-offline.test.mjs`

The tests use synthetic RSA keys, injected fake key responses, injected memory identity reads, and validators. They make no network calls and do not import the Edge entrypoint/PostgreSQL driver.

| Test | Result |
|---|---|
| Synthetic Firebase signature and claims accepted | PASS |
| Wrong audience, expiry, tampered signature denied | PASS |
| Key endpoint unavailable fails closed | PASS |
| Admin/member exact record mapping | PASS |
| Active member and status mismatch denied | PASS |
| Manual activation audit binding | PASS |
| Filter, required theme, spoofed identity, invalid area | PASS |
| Poster signature/type/2 MiB/random-key unit checks | PASS |
| HTTP router: missing/invalid token, viewer, inactive admin, forged role denied | PASS |
| HTTP method allowlist and approved-origin CORS | PASS |
| HTTP mock path maps authorized draft to fixed RPC; member route uses public projection only | PASS |

## Not executed / blocked

- Deno compile/Supabase Edge: **BLOCKED** — Deno executable unavailable (only broken npm shim); Supabase CLI and Docker unavailable.
- Auth/Firestore Emulator identity integration: **NOT RUN** for R6-B; R5 historical result is not counted.
- R5 PostgreSQL suite (18 historical passes): **NOT RUN** in R6-B; avoids rerunning completed suite.
- R5 browser suite (61 historical passes): **NOT RUN** in R6-B.
- Edge → PostgreSQL RPC/HMAC/transaction integration: **BLOCKED** — no Deno runtime/R6 isolated execution.
- Storage policy/upload/quota: **BLOCKED** — no bucket provisioned or local Storage runtime.
- Production Firebase/Supabase/hosting: **NOT ACCESSED**.

Actual output: **7 tests PASS / 0 FAIL**. Static runtime availability probe found no Deno binary (the deno.ps1 shim points to a missing executable); Supabase CLI, Docker and TypeScript compiler were not found. Node emits a module-type warning because adding a root package setting would violate scope; tests still execute cleanly.

The entrypoint and Postgres module could not be compiled in Deno. Node strip-types tests parse/import the verifier, Firestore, validator, poster validation, and router modules. This does not type-check the Supabase entrypoint or Postgres driver integration.
