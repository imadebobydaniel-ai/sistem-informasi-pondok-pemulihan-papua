# Guest chat closeout — local implementation, release NO-GO

Only the Owner-authorized guest-chat scope was changed. No production services,
member data, existing emulator, NIJ allocation or ledger were accessed. No commit,
push, merge, deployment, production Anonymous Auth enablement or active Rules
replacement was performed.

## Manifest

| File | Change and impact |
| --- | --- |
| `chat-umkm.html` | Firebase/Auth bootstrap, corrected existing handlers and element references, Auth UID ownership, false seller/read flags, safe text/image rendering and fail-closed shared App Check initialization. Existing page structure and CSS retained. |
| `chat-dashboard-umkm.html` | Seller UID filters retained; safe DOM construction; legacy messages without flags remain visible unless explicitly hidden. Auth/conversation listeners are detached when switching sessions/conversations. New replies use both false flags. Existing hide/read operations retained. |
| `dashboard-umkm.html` | Chat badge ignores explicitly seller-hidden messages; seller and customer-sender query filters retained. |
| `docs/release-gate-005a/firestore.final-proposed.rules` | Only chat match block changed: authenticated ownership, bounded new-message contract, required false flags, seller-only boolean flag updates, no identity/body rewrite or deletion. Anonymous provider accepted only for the exact isolated demo project audience. |
| `tests/release-blocker-closeout/chat.test.cjs` | Scoped syntax, DOM/mock, Auth configuration, ownership and rendering regressions. |
| `tests/release-blocker-closeout/rules.cjs` | New isolated Firestore process and synthetic authenticated Rules contexts; no registration or existing emulator access. |
| `docs/release-blocker-closeout/` | Review, machine evidence and preservation checksums. |

## Results

| Check | Result |
| --- | --- |
| Changed inline JavaScript and Rules runner syntax | PASS |
| Customer handlers, real element IDs, UID payload and flags | PASS (mock) |
| Customer and seller malicious text rendered as text nodes | PASS (DOM mock) |
| Explicit localhost demo Anonymous Auth configuration; other configurations rejected | PASS (mock) |
| Missing App Check fails closed before anonymous sign-in or chat access | PASS (mock using prepare failure) |
| Firestore proposal compiles and enforces guest/seller ownership | PASS (real Rules emulator, synthetic Auth contexts) |
| Forged customer/seller identity and unrelated reads/query | PASS: denied |
| Seller read/hide flags; customer mutations, message rewrites and invalid flags | PASS |
| Legacy seller visibility without identity migration/claim | PASS |
| Anonymous audience outside approved demo project | PASS: denied |
| NIJ sentinel mutation | PASS: denied and unchanged |
| Previous code and two original untracked files | PASS: 28 baseline SHA-256 values identical |
| Active `firestore.rules` and `firebase.json` | PASS: no Git diff |
| Git whitespace validation | PASS |
| Full real browser/Auth/App Check chat flow | BLOCKED / not executed |

Commands executed:

```powershell
node --test tests/release-blocker-closeout/chat.test.cjs
node --check tests/release-blocker-closeout/rules.cjs
node tests/release-blocker-closeout/rules.cjs
git diff --check
```

Final totals: **11 static/mock tests PASS; 12 Rules groups PASS; 0 FAIL**.
Unaffected 001–005A suites were not repeated. Rules contexts supply synthetic
Firebase Auth claims; these tests do not create real Auth accounts or prove real
Anonymous Auth provider configuration, browser execution or App Check attestation.

## Runtime contract and remaining gates

Customer entry URL is `chat-umkm.html?seller_uid=<seller-auth-uid>`; `seller` and
`uid` are routing aliases. Optional `store_name` is rendered as text. URL/customer
local storage IDs never establish ownership. A normal authenticated member uses
the restored Firebase Auth UID. Signed-out production users are asked to log in;
the page never automatically creates a production anonymous identity.

Explicit test configuration, injected by an authorized local harness before page
startup, is `window.SIPAPUA_GUEST_CHAT_TEST` with `projectId` exactly
`demo-sipapua-guest-chat-closeout`, `allowAnonymous:true`, and integer `authPort`
and `firestorePort` from 1 through 65535. The page itself must be served from
`localhost` or `127.0.0.1`. Both emulator targets are hardcoded to loopback. A
configured test project cannot silently fall back to production. This does not
bypass App Check: the unchanged helper must still obtain a legitimate token.

The shared helper still has `siteKey:null`. A legitimate registered key, authorized
hosting/test domain, configured provider and read-only enforcement evidence remain
Owner configuration gates. No fake key, debug provider or enforcement exception
was introduced. Real guest-chat browser acceptance remains blocked until this
configuration exists; then use a fresh authorized demo Auth/Firestore environment,
explicit test configuration and synthetic participants to exercise the actual
pages with valid attestation. Never reuse the candidate emulator.

Legacy customer IDs are not presumed to be Auth UIDs. Sellers retain their own
legacy conversation visibility and flag operations, but historical buyer access
is not claimed or migrated. No independently verified historical ownership mapping
was supplied. Missing timestamp legacy records still follow existing timestamp-
ordered queries; no data rewrite was introduced.

The proposal is ready for Owner review of the scoped chat contract, **not production
adoption**. Wider mandatory release gates from 005A (legitimate App Check, full
positive browser acceptance, provider upload and other outstanding gates) remain
unchanged. Cloudinary was not contacted because this patch does not affect uploads.
Production decision: **NO-GO**.

GUEST CHAT CLOSEOUT — OWNER REVIEW REQUIRED
