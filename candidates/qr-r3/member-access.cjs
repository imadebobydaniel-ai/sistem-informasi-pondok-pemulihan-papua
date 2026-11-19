"use strict";

const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const dependency = createRequire(resolve(__dirname, "../../functions/package.json"));
const { onCall, HttpsError } = dependency("firebase-functions/v2/https");
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Isolated candidate. The existing profile rules and the existing Admin SDK
// registration functions are reused. This module is never exported by index.js.
function createMemberAccess(db, auth) {
    return onCall({ region: "asia-southeast2", enforceAppCheck: true }, async request => {
        const uid = request.auth?.uid;
        if (!validId(uid) || !request.app || request.auth.token?.firebase?.sign_in_provider === "anonymous") {
            throw new HttpsError("unauthenticated", "Auth and App Check required.");
        }
        if (request.data != null && (typeof request.data !== "object" ||
            Array.isArray(request.data) || Object.keys(request.data).length !== 0)) {
            throw new HttpsError("invalid-argument", "Profile selectors are not accepted.");
        }
        const user = await auth.getUser(uid).catch(error => {
            if (error.code === "auth/user-not-found") throw new HttpsError("permission-denied", "Account unavailable.");
            throw error;
        });
        if (user.disabled) throw new HttpsError("permission-denied", "Account unavailable.");
        return db.runTransaction(async tx => {
            let profile = await tx.get(db.collection("users").doc(uid));
            const legacy = !profile.exists;
            if (legacy) {
                const binding = await tx.get(db.collection("member_identity").doc(uid));
                const profileId = binding.get("profileId");
                if (binding.get("uid") !== uid || !validId(profileId)) {
                    throw new HttpsError("permission-denied", "Profile unavailable.");
                }
                profile = await tx.get(db.collection("users").doc(profileId));
            }
            const declaredUid = profile.get("uid");
            if (!profile.exists || (declaredUid != null && declaredUid !== "" && declaredUid !== uid)) {
                throw new HttpsError("permission-denied", "Profile unavailable.");
            }
            return {
                profileId: profile.id,
                active: user.emailVerified && profile.get("status_akun") === "Aktif",
                emailVerified: user.emailVerified,
                legacy
            };
        });
    });
}

module.exports = { createMemberAccess };
