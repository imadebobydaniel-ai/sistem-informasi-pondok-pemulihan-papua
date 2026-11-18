# SIPAPUA development checkpoint

This branch is a development checkpoint. Production release and deployment are outside its scope.

- Digital Member Card QR and QR-to-friendship integration are complete locally. The combined isolated QR suite passed 7/7 and the UMKM chat suite passed 11/11. R2, R3, and R4 candidate evidence remains available.
- Member-card maintenance remains enabled and registration remains on HOLD. Production QR activation still requires an approved recipient opt-in process, receipt retention and cleanup, and live App Check, physical scanning, and Node 22 verification.
- The Spark login path conflicts with the active Firestore Rules. Verified pending members cannot write `status_akun` or create `registration_audit` from the client. Administrative override login also depends on an audit read denied by the active rules. The registration hold does not gate login.
- The active profile rules still expose full `users` documents. The private-profile candidate requires a compatible registration and legacy login path. Canonical QR identity also leaves noncanonical legacy members without QR access pending an approved binding plan.
- The active rules deny personal chat at `mutual_chats` and group chat at `sipapua_group_rooms`. Positive authorization was verified under isolated candidate rules. The UMKM regression covers a separate chat flow.

See the [QR local closeout](qr-local-closeout.md) for the emulator command, implementation scope, and audit handoff.
