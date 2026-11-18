"use strict";

const assert = require("node:assert/strict");

module.exports = async ({ check, db, administratorRapor, authDirectory }) => {
    const call = (uid, data) => administratorRapor({ ...(uid ? { auth: { uid } } : {}), data });
    const declared = { uid: "rapor-fixture", nij: "SYN-RAPOR-001", nij_number: 1 };
    const selector = { nij: declared.nij };
    const put = (path, fields) => db.doc(path).set(fields);
    await authDirectory.createUser({ uid: declared.uid, email: "rapor-fixture@example.test", emailVerified: true });
    await put("users/" + declared.uid, {
        ...declared, nama: "Synthetic reporting member", email: "rapor-fixture@example.test", alamat_detail: "Synthetic private address"
    });
    await put("nij_allocations/" + declared.uid, declared);
    await put("laporan_bacaan/rapor-bound", { uid: declared.uid,
        timestamp: new Date("2026-11-19T02:00:00Z"), email: "rapor-fixture@example.test", hikmat: "Synthetic private note" });
    await put("laporan_bacaan/rapor-unrelated", { uid: "other", tanggal: "2026-11-19" });

    await check("Administrator Rapor roles, trusted allocated NIJ, and minimal response fields", async () => {
        for (const uid of ["master", "super", "admin", "viewer"]) {
            const result = JSON.parse(JSON.stringify(await call(uid, selector)));
            assert.deepEqual(result, {
                profile: { nama: "Synthetic reporting member", nij: declared.nij },
                records: [{ collection: "laporan_bacaan", id: "rapor-bound", data: { timestamp: "2026-11-19T02:00:00.000Z" } }]
            });
        }
        await assert.rejects(call(null, selector), { code: "unauthenticated" });
        for (const uid of ["inactive", "other"]) await assert.rejects(call(uid, selector), { code: "permission-denied" });
        await assert.rejects(call("viewer", { ...selector, uid: "other" }), { code: "invalid-argument" });
    });
    await check("Administrator Rapor rejects ambiguous and unbound NIJ identities", async () => {
        await put("users/rapor-unbound", { nij: "SYN-UNBOUND", email: "other@example.test" });
        await assert.rejects(call("viewer", { nij: "SYN-UNBOUND" }), { code: "failed-precondition" });
        await put("users/rapor-duplicate", { nij: declared.nij, uid: "other" });
        await assert.rejects(call("viewer", selector), { code: "failed-precondition" });
    });
};
