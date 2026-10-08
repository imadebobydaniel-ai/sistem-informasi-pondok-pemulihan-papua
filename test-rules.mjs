import fs from "node:fs";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";

const projectId = "boby-apps-project";
const rules = fs.readFileSync("./firestore.rules", "utf8");

const env = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules,
  },
});

const userUid = "test-user-status";
const adminUid = "test-admin-status";
const newUserUid = "test-new-user-status";

try {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await db.doc(`users/${userUid}`).set({
      uid: userUid,
      nama: "Test User",
      email: "test@example.com",
      status_akun: "Pending",
    });

    await db.doc(`admin_users/${adminUid}`).set({
      role: "admin",
      status: "active",
    });
  });

  const userDb = env.authenticatedContext(userUid).firestore();
  const adminDb = env.authenticatedContext(adminUid).firestore();
  const newUserDb = env.authenticatedContext(newUserUid).firestore();

  // 1. User biasa TIDAK boleh mengubah status_akun menjadi Aktif.
  await assertFails(
    userDb.doc(`users/${userUid}`).update({
      status_akun: "Aktif",
    })
  );

  // 2. User biasa tetap boleh mengubah profil
  //    selama tidak menyentuh status_akun.
  await assertSucceeds(
    userDb.doc(`users/${userUid}`).update({
      nama: "Nama Diperbarui",
    })
  );

  // 3. Admin aktif BOLEH mengubah status_akun.
  await assertSucceeds(
    adminDb.doc(`users/${userUid}`).update({
      status_akun: "Aktif",
    })
  );

  // 4. User baru TIDAK boleh membuat akun dengan status Aktif.
  await assertFails(
    newUserDb.doc(`users/${newUserUid}`).set({
      uid: newUserUid,
      nama: "User Baru",
      email: "new@example.com",
      status_akun: "Aktif",
    })
  );

  // 5. User baru BOLEH membuat akun dengan status awal
  //    Menunggu Verifikasi.
  await assertSucceeds(
    newUserDb.doc(`users/${newUserUid}`).set({
      uid: newUserUid,
      nama: "User Baru",
      email: "new@example.com",
      status_akun: "Menunggu Verifikasi",
    })
  );

  console.log("");
  console.log("========================================");
  console.log(" FIRESTORE RULES TEST: ALL PASS");
  console.log("========================================");
  console.log("PASS 1: User tidak boleh self-activate");
  console.log("PASS 2: User boleh update profil");
  console.log("PASS 3: Admin aktif boleh activate user");
  console.log("PASS 4: User baru tidak boleh create Aktif");
  console.log("PASS 5: User baru boleh create Menunggu Verifikasi");
  console.log("========================================");
} finally {
  await env.cleanup();
}