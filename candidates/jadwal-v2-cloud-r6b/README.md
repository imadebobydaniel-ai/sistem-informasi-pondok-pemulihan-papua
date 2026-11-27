# SIPAPUA Jadwal Pelayanan — R6-B local cloud-adapter candidate

**Status:** isolated local preparation only. Not deployed, not production-ready. No cloud resource or schema was created.

This directory starts as a byte-for-byte copy of `candidates/jadwal-v2-cinema-r5`; R5 code/tests remain preserved here as an immutable comparison baseline. R6-B adds `EDGE-ADAPTER/` and documentation only. Historical R5 results are 18 backend and 61 browser passes; those are not R6-B results.

## Candidate layout

- `EDGE-ADAPTER/index.ts`: Deno/Supabase Edge entrypoint.
- `EDGE-ADAPTER/firebase-auth.ts`: Firebase ID token RS256 verifier with fixed Google key origin and fail-closed key refresh.
- `EDGE-ADAPTER/firestore-identity.ts`: exact `admin_users/{uid}`, `users/{uid}`, legacy `users.uid` limit-2 lookup, and narrowly bound activation-audit reader.
- `EDGE-ADAPTER/validation.ts`: request-size, filter, and schedule payload validation.
- `EDGE-ADAPTER/postgres-repository.ts`: allowlisted R5 RPC invocation via pinned `npm:postgres@3.4.7`, one connection, prepared statements disabled, HMAC writer attestation.
- `EDGE-ADAPTER/router.ts`: `/functions/v1/jadwal-pelayanan` prefix mapping to R5 API routes.
- `EDGE-ADAPTER/tests/r6b-offline.test.mjs`: synthetic offline unit tests only.
- Architecture, database, poster, root mapping, security, and test result documents.

## Runtime configuration contract

Server-only variables: `FIREBASE_PROJECT_ID`, `SIPAPUA_MASTER_UID`, `FIRESTORE_API_ORIGIN`, `JADWAL_DATABASE_URL`, `JADWAL_DB_RUNTIME_ROLE`, `SUPABASE_PROJECT_REF`, `JADWAL_HMAC_SECRET`, `JADWAL_CORS_ORIGINS`. No values are supplied. DB URL must authenticate as restricted `schedule_runtime` (or pooler username `schedule_runtime.<project-ref>`, never `postgres`); HMAC secret must match database writer secret. No credential was created, fetched, or placed in source.

For local Firestore Emulator only, `FIRESTORE_API_ORIGIN` must be `http://127.0.0.1:8080` and project `demo-sipapua-jadwal`. Hosted identity reads accept only `https://firestore.googleapis.com`. Supabase gateway JWT defaults expect Supabase Auth tokens; a Firebase-token function may require per-function `verify_jwt=false`, but only with this handler as complete verifier and separate abuse controls. No gateway setting was changed or verified.

## Candidate verification

Offline unit test command: `node --experimental-strip-types --test candidates/jadwal-v2-cloud-r6b/EDGE-ADAPTER/tests/r6b-offline.test.mjs`. Unit tests are not Edge, Firestore, PostgreSQL, Storage, browser, or production E2E. Deno, Supabase CLI, Docker and local Supabase runtime were unavailable; no Edge runtime validation is claimed.

See `TEST-RESULTS.md` for actual execution evidence and remaining gaps. Production remains unchanged; no commit, push, migration, bucket creation, deployment, or billing action occurred.
