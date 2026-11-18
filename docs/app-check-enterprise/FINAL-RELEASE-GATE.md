# Final App Check attestation and release gate — NO-GO

The Enterprise patch baseline is preserved: every recorded patch SHA-256 still
matches. The previous 33 static/mock tests and five scoped Chrome checks were
not rerun. No SDK audit or application patch was repeated.

## Current evidence

| Gate | Result and evidence |
| --- | --- |
| Official cloud access | BLOCKED: the fresh elevated read-only check found 0 Firebase CLI accounts and no unexpired cached access token. No login or refresh was attempted. No configured application-default credential path or credential override was present. |
| Web App / Enterprise key / Pages domain binding | BLOCKED: local Web App/key configuration is retained, but official cloud metadata could not be retrieved. Prior public Auth config confirmed the Pages hostname; that does not prove Enterprise domain binding. |
| Real App Check token | NOT OBTAINED. No authorized test-environment configuration was present or supplied. Production hosting was not silently treated as a synthetic-test target. No debug provider/token was used. |
| Callable rejection without attestation | Prior PASS retained: mocks assert rejection/invalid-token handling; scoped real Chrome proves no backend forwarding when external attestation is blocked. This is not deployed production enforcement evidence. |
| Registry readiness | BLOCKED / UNKNOWN: neither `registration_control/state` nor counter readiness was read from production without official authorization credentials. Unknown does not mean disabled or corrupt. |
| Functions local deployment input | Six registration exports, three lifecycle exports, four registry-preparation exports and the additional family-search export are present. Source is unchanged from tested baseline. |
| Functions deployed state | BLOCKED / UNKNOWN: existence, ACTIVE state, entrypoints, deployed versions, IAM and production App Check rejection could not be verified through official access. Local exports do not prove deployment. |
| Rules proposal | The private proposal hash is identical to the guest-closeout tested proposal. Prior 005A role/module tests and subsequent scoped guest tests remain historical evidence; no unaffected suites were rerun. |
| Rules deployment selection | `firebase.json` still selects unchanged baseline `firestore.rules`, not the private proposal. Do not deploy that selection as the final privacy fix. Active cloud Rules were not retrieved. |
| All legacy interactive compatibility | Still BLOCKED per 005A; scoped role/module tests do not prove full interactive coverage of every module. |
| Positive full browser E2E | NOT RUN: an authorized real-attestation test environment and official configuration are not available. No synthetic registrations or NIJ allocations were attempted. |

## Read-only check added for official access

`tests/app-check-enterprise/gate-readonly.cjs` has a local syntax PASS. Its executed
no-account branch records the blocker in `FINAL-GATE.json` and stops before any
cloud request. With an existing unexpired official CLI account, it is designed to
perform only allowlisted HTTPS GETs for Web App metadata, Enterprise App Check
configuration, existing reCAPTCHA key configuration, regional Functions metadata,
the three readiness state fields, and deployed Rules source. It never logs tokens,
refreshes credentials, calls preparation/mutation endpoints or reads member profiles.
The credentialed HTTP branch was not exercised in this run.

Registry readiness must ultimately verify `enabled:true`, `maintenance:false`,
version `original-spark-v1`, and valid counters for the required locations. Reading
the state alone would not certify counters or ledger consistency. This report
does not initialize a missing field or infer any production value.

## Concrete unblock steps

1. Provide normal official account access with the permissions needed to read the
   existing Firebase Web App, App Check Enterprise config, reCAPTCHA key, Functions,
   Rules and bounded registry readiness metadata. Do not paste secrets or tokens
   into the repository. Alternatively provide verified official Console evidence.
2. Confirm that Web App `1:125984859692:web:09f75df5d2e4b6e3bcd389` in
   `boby-apps-project` is bound to the already approved Enterprise key, with
   score-based integration and `imadebobydaniel-ai.github.io` allowed. Do not make
   a new provider/key or change enforcement to bypass this gate.
3. Identify the existing authorized test Web App/project and hosting origin where
   genuine attestation and synthetic E2E are permitted. Preserve separation from
   production member data, Auth accounts, NIJ allocation and registry state. A
   demo-only offline harness cannot prove real Enterprise token issuance.
4. Verify deployed Functions and actual Rules; reconcile registry prerequisites
   read-only before any separately authorized production action. Complete positive
   attestation/E2E and required affected legacy acceptance before adopting Rules.

Official read-only API references:
[Enterprise App Check config GET](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.recaptchaEnterpriseConfig/get),
[existing Enterprise key GET](https://cloud.google.com/recaptcha/docs/reference/rest/v1/projects.keys/get),
[Functions metadata list](https://cloud.google.com/functions/docs/reference/rest/v2/projects.locations.functions/list).

Only a diagnostic script and this report/receipt were added locally. All prior
changes and original untracked files are retained. No production metadata/data
request was attempted by the official checker because no account was available.
No Firebase production mutation, enforcement change, account creation, commit,
push, merge or deployment occurred.

Decision: **NO-GO**. Missing official access/configuration evidence and genuine
positive attestation are release blockers, not reasons to bypass protections.
