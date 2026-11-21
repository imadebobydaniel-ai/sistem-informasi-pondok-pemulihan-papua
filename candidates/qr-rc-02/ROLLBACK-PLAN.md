# Rollback plan

1. Keep or restore member-card maintenance before changing any QR routing. Keep registration HOLD and friendship disabled.
2. Remove the approved staging Worker origin from the staged client configuration. Restore previously verified staging assets and Worker bindings if applicable.
3. Restore the previously captured staging Rules revision if an approved staging Rules change was published. Verify anonymous and cross-member denials and rerun maintenance tests.
4. Restrict staging verifier access and disable synthetic issuance as appropriate. Preserve restricted diagnostic evidence, then apply the approved D1 retention policy. Confirm that outstanding tokens cannot be redeemed through the retired route.
5. Record rollback hashes, verification evidence and approval before considering reopening staged testing.
