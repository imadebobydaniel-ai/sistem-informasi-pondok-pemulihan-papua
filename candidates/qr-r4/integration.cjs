"use strict";

const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const dependency = createRequire(resolve(__dirname, "../../functions/package.json"));
const { onCall, HttpsError } = dependency("firebase-functions/v2/https");
const { lookupMemberCard } = require("../../functions/member-card");
const { createQrFriendReceiptCandidate } = require("../qr-r2/qr-friend-receipts.cjs");
const { createMemberAccess } = require("../qr-r3/member-access.cjs");

// Test-only composition. No production Functions entry point imports this file.
function createQrFriendshipIntegration(db, auth) {
    const memberAccess = createMemberAccess(db, auth);
    const { mint, redeem } = createQrFriendReceiptCandidate(db, auth);
    const scanQrIntroduction = onCall({ region: "asia-southeast2", enforceAppCheck: true }, async request => {
        const scanner = await memberAccess.run({ ...request, data: {} });
        if (scanner.legacy || scanner.profileId !== request.auth.uid) {
            throw new HttpsError("permission-denied", "QR introduction unavailable.");
        }
        // R1 and R2 enforce the current QR membership policy after resolution.
        const card = await lookupMemberCard.run(request);
        if (!card.found) throw new HttpsError("permission-denied", "QR introduction unavailable.");
        const proof = await mint.run(request);
        return { ...proof, member: { nama: card.nama, nij: card.nij } };
    });
    return { scanQrIntroduction, requestQrIntroduction: redeem };
}

module.exports = { createQrFriendshipIntegration };
