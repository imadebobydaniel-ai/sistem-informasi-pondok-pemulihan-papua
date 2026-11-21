# Staging deployment, acceptance and rollback

## Deployment after separate approval

1. Record the exact staging Firebase project and app, Worker, gateway, D1, HTTPS origins, IAM scope and previous staging revisions. Require isolated synthetic data and verify the deployed Firebase web configuration and Auth provider match that project.
2. Implement the approved private gateway hop. Validate the service binding invocation identity, independent deadlines, request allowlists and credential-free logs. Give the verifier only approved staging permissions and confirm requests from outside the trusted gateway are denied.
3. Check the Rules hash, apply the candidate only to the approved staging prep tree, then validate owner get, anonymous and cross-UID denial, list/write denial, plus reporting and chat compatibility before approved staging publication.
4. Create the isolated D1 schema and configure schedule and limits with approved identifiers. Validate the filled Wrangler config offline first. Stage the Worker with an approved route. Keep the live application maintenance flag unchanged.
5. Assemble a separately access-controlled synthetic staging browser test page using the RC-02 candidate adapter and App Check bootstrap. Give that fixture only the approved fixed HTTPS endpoint. Use it for QR operations while the normal application stays in maintenance. Never put App Check debug tokens in the fixture.

## Browser and physical QR acceptance

- Confirm the normal application shows maintenance and sends no QR request. Confirm the restricted test page obtains a fresh `getLimitedUseToken()` token per operation. Check request paths and header names without exporting HAR, cookies, or credential values.
- In the fixture, issue and scan with two synthetic authenticated identities. Confirm expected profile fields only. Use a controlled in-memory test harness to reuse the same attestation, then verify rejection. Verify expired App Check and ID tokens, a disabled session, revoked owner/scanner, different app ID, invalid origin, redirects and timeout. Change sessions mid-operation and verify that no prior-session QR result is rendered.
- On two Owner-approved devices, exercise screen scan, supported camera permissions, weak connectivity, expiration and simultaneous scanning. Expect exactly one successful redemption and deny self-scan. Verify no friendship data is written. Capture only redacted outcomes, timestamps and platform versions.
- Verify D1 cleanup and write limits through staging counters. Run registration-HOLD, Rapor, Big Data and chat compatibility against the approved Rules and staging app before any go-live discussion.

## Rollback

1. Remove staging test access or the staging Worker route. Verify the normal application remains in maintenance, registrations stay on HOLD, and friendship remains disabled.
2. Roll back to the recorded staging Worker and browser asset versions, or leave the QR origin unset. Withdraw the gateway's invoke access and verify outstanding QR tokens cannot be used on retired routes.
3. Restore the preceding staging Rules revision if this candidate was applied there. Recheck denials and affected application flows.
4. Preserve authorized non-sensitive evidence. Handle D1 rows, backups and the retired staging database according to the approved retention policy. Confirm production configuration stayed unchanged.

