const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");

initializeApp();

setGlobalOptions({maxInstances: 10});

const MASTER_UID = "hXo6v5OKhkMVtRAAuUqcYcASplo2";

exports.setMasterRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
        "unauthenticated",
        "Authentication required.",
    );
  }

  if (request.auth.uid !== MASTER_UID) {
    throw new HttpsError(
        "permission-denied",
        "Only the protected master account may initialize this role.",
    );
  }

  await getAuth().setCustomUserClaims(MASTER_UID, {
    role: "master",
  });

  return {
    success: true,
    role: "master",
    uid: MASTER_UID,
  };
});
