# Database compatibility — R5 contract

R5 candidate `schema.sql` contains `sipapua_schedule.occurrences`, `member_projection`, `audit`, `reservations`, `resources`, and private `writer_secret`. Its fixed functions are `api_save_draft`, `api_publish`, `api_cancel`, `api_admin_list`, `api_audit_list`, and `api_member_list`. R6-B proposes no schema change.

The R5 SQL uses transactional lifecycle writes, row locks/revision checks, reservation constraints, public projection updates and immutable audit writes in the same operations. It preserves the first publication timestamp on revisions/cancellation and the member projection selects an allowlist of fields and published/cancelled states. These are inspected candidate properties and historical R5 test evidence, not new R6 verification.

Runtime database role in the R5 candidate is `schedule_runtime`: login, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS. Direct table privileges are revoked; narrow API-function execute grants are used. Recheck function owner, search_path and grants in an isolated local PostgreSQL run before adoption.

The adapter invokes the fixed schema-qualified functions only. HMAC matches R5's `uid\nrole\nlower(operationId)\naction` message and Base64 SHA-256 contract. A disposable local DB secret and Edge environment parity test are still required; none was created here.

Direct PG avoids exposing the private schema through PostgREST, but adds pooler/connection/TLS/credential responsibilities. Hosted use needs a supported transaction-pooler URL and runtime role; the adapter accepts only `schedule_runtime` or its exact project-ref pooler username. No production connection metadata was read. `schema.sql` is a candidate, not proof that production has the schema. Do not run it in production.
