# SIPAPUA P0 candidate

Source checkpoint 36a402024f5c040d4cc07caa5416922c4d55ec45 on test/sipapua-emulator-guard-20261110.

The Rules and member-lifecycle callable are isolated review copies. The matrix starts a fresh loopback demo Firestore process on an ephemeral port. The callable test uses in-memory Firebase stubs and synthetic accounts.

Run locally with Node and an existing Firestore emulator JAR.

    node matrix.cjs
    node --test backend-candidate.test.cjs

source-path.txt points to the local checkpoint workspace so the harnesses can load its SDK dependencies and unchanged activation callable. The matrix uses the locally cached Firestore emulator v1.22.0 JAR.

## Compatibility gates

- The current member-session facade handles activation, login status, profile edits and deletion with Spark client transactions. Route manual activation to the existing audited backend callable, and route member login/status and contact/family edits through narrow authenticated operations. Use the existing own-profile callable for UID-less legacy accounts after legacy compatibility review. Preserve verified Firebase Auth state and historical NIJ allocations. Registration remains on HOLD.
- Firestore returns whole configuration documents. Publish only approved scalar fields to the named public documents or use a narrow projection if live document shapes differ. Keep operational metadata private.
- Admin member lists, family reads and report reads were tested as synthetic Rules requests. Regional filters, report output and moderator browser workflows require end-to-end validation. Feedback, attendance and logging consumers that relied on public writes need a narrow validated writer or a confirmed retirement decision.
- The candidate closes the public UMKM chats collection. A separately tested participant policy must be integrated before enabling this candidate with UMKM chat. Personal and group chat still require their separate reviewed policy.
- The legacy binding suite's previously observed unindexed-UID failure is open. No binding or migration was attempted.
