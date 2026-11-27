# Root application integration map (read-only)

No root file was changed.

| Root source | Current function | R5 candidate | Later narrow integration / rollback |
|---|---|---|---|
| `jadwal-pelayanan.html` | Member schedule UI; approved adapter currently returns empty while feature is under development | `browser/jadwal-pelayanan.html`, `browser/local-schedule-adapter.js` | Swap only data adapter after API approval; retain UI/session. Rollback to empty adapter/page snapshot. |
| `admin-jadwal-pelayanan.html` | Dashboard schedule editor prototype | `browser/admin-jadwal-pelayanan.html` | Preserve existing session gate; use Firebase ID token; rollback only approved page snapshot. |
| `sipapua-admin-jadwal.js` | Current prototype reads `admin_users/{uid}` and uses local prototype behavior | `browser/sipapua-admin-jadwal.js` | Replace persistence adapter only when trusted function exists. UI gate is not authorization. |
| `admin.html` | Dashboard navigation and Firebase admin check; active `master`/`super_admin`; canonical Master requires `protected=true` | `browser/admin-preview.html` | No change proposed. Existing modules remain. |
| `menu.html` | Member navigation contains schedule route | None | No change required. Preserve current profile loading. |
| `sipapua-member-session.js` | Existing member session / own profile wrapper, protects against changed sessions | Synthetic R5 browser auth adapters are test-only | Continue existing Auth session; fetch current Firebase ID token. Do not add auth system. |
| `sipapua-spark-member.js` | Reads `users/{uid}`; if absent exact `uid` query limit 2; active status; verified email or exact admin-override activation audit | `EDGE-ADAPTER/firestore-identity.ts` candidate counterpart | Check deployed Rules allow only these reads; do not widen Rules. Fail closed on denial. |
| `firestore.rules` | Existing application rules and role helpers; local file does not prove deployed state | No R6 rule fragment | No change proposed; production permission review separate. |

## Hosting and function path

Root Pages is static GitHub Pages `main` root based on prior verified release; this was not re-fetched for R6-B. Future Supabase route is `/functions/v1/jadwal-pelayanan/api/...`. Static hosting cannot store privileged DB secrets. No local R5 harness or R6 candidate is imported by root pages.

## Conflicts and security

Root admin prototype still has client UI behavior and local state; do not treat it as server authorization. Member page currently uses empty/read-only contract; do not expose drafts or synthetic schedules. Edge role checks must be authoritative. Firestore lookup may be blocked by current Rules; do not add broader reads without separate authorization.

## Rollback

R6-B only adds an isolated candidate directory. Exclude/remove that directory to roll back this preparation; no app or cloud state changed. Future release needs separate backup of exact root files and Edge version rollback plan.
