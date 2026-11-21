# Conditional deployment plan

1. Obtain separate Owner approval for a synthetic-only Firebase staging project and isolated Worker, D1 and private verifier. Record project IDs, origin, app IDs and account ownership. Keep registration HOLD, member-card maintenance and friendship restrictions in force.
2. Reconcile the owner-only allocation change against the exact staging Rules baseline. Run Rules coverage and capture before/after hashes before any approved staging publish.
3. Provision a private verifier with approved workload identity and minimum permissions for Firebase Auth status, App Check consumption and the documented owner checks. Restrict invocations to the intended Worker. Keep token values out of logging and telemetry.
4. Provision an isolated D1 schema and configure ingress limits, cleanup schedule, usage alerts and staging CORS allowlist. Verify limits and retention under a controlled synthetic load.
5. Add the candidate bootstrap as a module on the QR pages in the staging overlay, alongside the adapter and limited-use module. Approve the pinned Firebase SDK and provider CSP and set only the approved staging Worker origin. Exercise Auth, App Check, rejection paths and physical QR tests under an Owner-approved staging procedure.
6. Record hosted evidence in the checklist and submit it for separate production consideration.
