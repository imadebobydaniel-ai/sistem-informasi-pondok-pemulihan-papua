# App Check without DevTools Console — PASS

Completed on 2026-11-14T05:44:19.121Z on the official SIPAPUA Pages index URL,
using installed local Chrome and a new temporary profile (not the Owner's browser
profile). No additional Owner action is needed for this completed check.

```json
{"status":"PASS","enterpriseToken":true,"clientServerRead":true,"productionDataWrites":0,"tokensExported":false,"isolatedBrowserProfile":true,"category":"PASS","temporaryProfileRemoved":true}
```

Evidence: APP-CHECK-LOCAL-BROWSER-RESULT.json.

The runner executes the SHA-pinned existing enterprise-browser-readonly.js via
Chrome's official DevTools protocol on an ephemeral localhost debugging port.
The only script adaptation returns its already sanitized result instead of
printing it in Console. The SDK handles the Enterprise token internally; the
runner never requests cookies, network payloads, token strings, Auth account
details or member data. It does not enable Network/Runtime event capture, sign
in, click forms, modify Firebase, disable web security, use an App Check debug
provider or change enforcement. The sole Firestore request is a permitted server
GET of public registration_control/state. It then closes its own browser and
deletes only the checked, owned temporary profile. Existing browser windows and
profiles remain untouched.

Four new synthetic runner-safety checks passed (pinned script, result allowlist,
loopback target boundary, temporary-directory cleanup boundary). Existing
registration, activation and release suites were not repeated.

For a future separately needed recheck, one PowerShell command from the workspace
is sufficient; it never requires Console typing or pasting:

```powershell
node scripts/check-appcheck-local-browser.cjs
```

Desktop/browser execution can require the environment's normal approval. The
completed run already received that approval. No repeated approval/action is
requested here. The runner does not bypass any environment or browser security
prompt. This result proves token acquisition and the permitted client server read
on the correct origin/Web App, not publication of the candidate or enforcement.

The production Firestore enforcement setting remains UNENFORCED; no setting,
registry field, NIJ, counter, member record, Git commit, deployment or website
publication was changed. App Check token exchange and ordinary browser cache
activity are intrinsic to this check; the token never leaves SDK-managed browser
memory/cache for the report, and the temporary profile was removed.

Official Chrome isolated-profile debugging guidance:
https://developer.chrome.com/blog/remote-debugging-port
