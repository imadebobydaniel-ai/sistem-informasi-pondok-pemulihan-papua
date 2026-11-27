# R6-B security review

## Candidate controls

- Firebase RS256 JWT verification with trusted `kid`, exact issuer/audience/project, UID from signed `sub`, expiry/issued/auth times, fixed Google JWK endpoint, redirect rejection, bounded response/timeout/cache and fail-closed key refresh.
- Admin lookup restricted to `admin_users/{verified UID}`; active `master`/`super_admin`; canonical Master additionally requires protected flag. Member uses `users/{uid}` then exact legacy `uid` query limit 2, `Aktif`, verified email or bound manual activation audit.
- Caller UID/role fields rejected; API route and RPC names allowlisted; schedule request bounded/validated; no-store responses; CORS origin allowlist; Firestore origin restricted to Google or exact demo emulator address.
- Server-only env for DB URL/HMAC; DB URL rejects `postgres` account, remote TLS required; one connection; no direct table mutation intended; HMAC action attestation to existing R5 SQL.

## Unverified or risky

1. Deno compile/runtime and `npm:postgres@3.4.7` behavior are not verified.
2. Google JWK fetch is an outbound dependency; outage fails closed. Production token validation is not tested. The verifier does not query Firebase Auth for disabled/revoked-token status; Firebase documentation notes ordinary ID token verification does not check revocation. Decide on a safe revocation/disabled-account check before release.
3. Existing deployed Rules were not read; user-bearer reads may be denied.
4. This candidate does not validate Firebase App Check tokens. If the approved schedule flow requires App Check, publication must remain blocked until App Check is verified server-side or an Owner-approved backend contract defines that requirement. Do not disable App Check in the web app or assume CORS replaces it.
5. Supabase gateway default JWT expects Supabase JWT. Any per-function bypass of gateway verification needs explicit security review and abuse controls; none configured.
6. Master UID/record semantics and role model were read locally, not validated against authoritative production records.
7. DB candidate schema presence, grants, TLS/pooler support and writer-secret parity are unverified.
8. Poster public-read exposes images by URL; storage quotas may change and do not ensure zero cost.
10. Supabase/Firebase free plans cannot guarantee Rp0 under arbitrary usage/quota exhaustion.

## Decision

R6-B is a candidate only. No security or production readiness claim. Required before release: Deno type-check, emulator-backed identity tests, isolated PostgreSQL/HMAC/RPC integration, grants/RLS review, actual gateway/CORS behavior, key rotation, poster-policy tests, backup/restore, cost/quota and abuse-control decision.
