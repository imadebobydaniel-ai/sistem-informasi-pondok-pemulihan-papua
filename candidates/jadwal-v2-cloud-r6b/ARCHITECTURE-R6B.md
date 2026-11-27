# Architecture R6-B

## Decision

Prepare Supabase Edge as a thin trusted HTTP adapter over the existing R5 PostgreSQL contract. Preserve the occurrence, reservation, audit, projection, revision and conflict implementation. Do not copy the R5 Node server: it starts `psql` via `child_process`, which Deno Edge cannot use.

```text
Firebase browser session -> Edge (verify Firebase JWT, derive UID)
 -> exact Firestore identity reads with that Firebase bearer
 -> fixed R5 RPC over restricted PostgreSQL role
 -> atomic occurrence/reservation/projection/audit transaction
```

The deployed function path would be `/functions/v1/jadwal-pelayanan`; after removing that prefix the unchanged routes are `GET /api/admin/session`, `GET /api/member/session`, `GET /api/admin/schedules`, `GET /api/member/schedules`, `GET /api/admin/audit`, `POST /api/admin/drafts`, `POST /api/admin/publish`, and `POST /api/admin/cancel`.

## Authentication options

**A. Supabase native Firebase third-party auth:** Current Supabase docs support this, but it requires hosted project auth configuration and Firebase custom-claim compatibility (`role: authenticated`). Third-party MAU beyond plan allowance may incur charges. It is not selected for this Rp0 candidate and no such setting was accessed or changed.

**B. Firebase token verification in Edge:** Selected for the candidate. `firebase-auth.ts` requires RS256, trusted `kid`, signature verification, exact Firebase `iss`/`aud`/project, `sub`, `exp`, `iat`, `auth_time`, and bounded clock skew. Keys come only from Google's Secure Token JWK endpoint; redirects are rejected and response/time are bounded; unavailable keys fail closed.

This is synthetic offline tested only. It has not been compiled/run in Deno, Edge, or against a real Firebase token. Production cryptographic verification is unverified. It also does not check Firebase Auth token revocation/disabled-user state or verify App Check; both require an explicit backend policy before release.

## Authorization

Admin lookup is only `admin_users/{verified UID}` using the same Firebase bearer; require active `master` or `super_admin`. Canonical Master UID also requires `role=master` and `protected=true`, matching `admin.html`. No administrator list query.

Member lookup follows the current helper: read `users/{uid}`, then if absent query `users` by exact `uid` with limit 2, requiring exactly one match. Require `status_akun == Aktif`, matching UID and either verified Firebase email claim or a valid admin-override activation audit bound to profile, UID and timestamps. No collection scan. Firestore Rules denial fails closed.

## PostgreSQL operations

Pinned `npm:postgres@3.4.7` is candidate-only. One connection, prepared statements disabled, TLS required off-loopback, restricted `schedule_runtime`, fixed RPC allowlist and parameterized JSON. HMAC binds verified UID, trusted role, operation ID and action to R5 writer secret. No secrets are embedded.

The RPC functions live in a non-public schema, so direct PostgreSQL is proposed instead of exposing that schema via PostgREST. This requires correct pooler, TLS, least privilege and secret parity. These have not been runtime tested.

## Deployment/cost blockers

No local Supabase runtime/CLI is available, no hosted Jadwal function or DB schema was confirmed. Firebase key retrieval is an outbound server dependency; key-fetch failure denies requests. Supabase Edge default gateway JWT validation expects Supabase tokens. Per-function `verify_jwt=false` may be required for Firebase tokens, which must be paired with this strict verifier and abuse controls. Free plans do not guarantee Rp0 under all quotas/usage. No resources were provisioned.

## Documentation reviewed

- [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens): signature, `aud`, `iss`, `sub`, `exp`, `iat`, `auth_time`, and signing-key handling.
- [Supabase Firebase third-party auth](https://supabase.com/docs/guides/auth/third-party/firebase-auth): requires compatible `role: authenticated` custom claims and project setup.
- [Supabase third-party auth overview/pricing](https://supabase.com/docs/guides/auth/third-party/overview): charges beyond plan quota are possible for third-party MAU.
- [Securing Supabase Edge Functions](https://supabase.com/docs/guides/functions/auth): gateway and function authentication are separate decisions.
- [Supabase Edge to PostgreSQL](https://supabase.com/docs/guides/functions/connect-to-postgres): server-side DB connections and pooling guidance.
