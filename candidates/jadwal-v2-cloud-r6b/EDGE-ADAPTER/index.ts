import { createHandler } from "./router.ts";
import { createFirebaseVerifier } from "./firebase-auth.ts";
import { createFirestoreIdentityReader, createIdentityReader } from "./firestore-identity.ts";
import { createScheduleRepository } from "./postgres-repository.ts";

// Supabase Edge Function entrypoint. Configure verify_jwt=false only for this
// function if the gateway cannot accept Firebase JWTs; this handler then
// verifies every request itself and fails closed.
const required = ["FIREBASE_PROJECT_ID", "JADWAL_DATABASE_URL", "JADWAL_DB_RUNTIME_ROLE", "SUPABASE_PROJECT_REF", "JADWAL_HMAC_SECRET", "FIRESTORE_API_ORIGIN", "SIPAPUA_MASTER_UID"];
for (const key of required) if (!Deno.env.get(key)) throw new Error(`Missing server configuration: ${key}`);
const firebaseProjectId = Deno.env.get("FIREBASE_PROJECT_ID")!;
const firestoreOrigin = Deno.env.get("FIRESTORE_API_ORIGIN")!;
if (!/^[A-Za-z0-9_-]{1,128}$/.test(Deno.env.get("SIPAPUA_MASTER_UID")!)) throw new Error("Invalid Master identity configuration.");
const verifier = createFirebaseVerifier(firebaseProjectId);
const firestore = createFirestoreIdentityReader({ projectId: firebaseProjectId, apiOrigin: firestoreOrigin });
const identityReader = createIdentityReader(firestore);
const repository = await createScheduleRepository({
  databaseUrl: Deno.env.get("JADWAL_DATABASE_URL")!,
  runtimeRole: Deno.env.get("JADWAL_DB_RUNTIME_ROLE")!,
  projectRef: Deno.env.get("SUPABASE_PROJECT_REF")!,
  hmacSecret: Deno.env.get("JADWAL_HMAC_SECRET")!,
});

Deno.serve(createHandler({ verifier, identityReader, repository, masterUid: Deno.env.get("SIPAPUA_MASTER_UID")!, corsOrigins: (Deno.env.get("JADWAL_CORS_ORIGINS") || "").split(",").map((origin) => origin.trim()).filter(Boolean) }));
