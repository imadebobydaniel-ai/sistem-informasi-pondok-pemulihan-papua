// Helpers for the Firebase Auth and Firestore EMULATORS (127.0.0.1 only).
// Synthetic users only; nothing here can reach a Firebase project:
// every URL is built from the local emulator hosts below.
//   firebase emulators:start --only auth,firestore --project boby-apps-project
// Rules are loaded from this repository's firestore.rules before each run.

export const PROJECT_ID = "boby-apps-project";
export const AUTH_HOST = Deno.env.get("LD_AUTH_EMULATOR") || "127.0.0.1:9099";
export const FIRESTORE_HOST = Deno.env.get("LD_FIRESTORE_EMULATOR") || "127.0.0.1:8080";

const LOCAL = /^(127\.0\.0\.1|localhost):\d+$/;
if (!LOCAL.test(AUTH_HOST) || !LOCAL.test(FIRESTORE_HOST)) {
    throw new Error("Firebase emulator hosts must be local (127.0.0.1:<port>)");
}

// Taken at load time, so a test that stubs globalThis.fetch afterwards
// still reaches the emulators directly.
const emulatorFetch = globalThis.fetch.bind(globalThis);

const AUTH = `http://${AUTH_HOST}`;
const FS = `http://${FIRESTORE_HOST}`;
export const DOCUMENTS = `${FS}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;

export async function emulatorsRunning(): Promise<boolean> {
    try {
        const [auth, fs] = await Promise.all([emulatorFetch(`${AUTH}/`), emulatorFetch(`${FS}/`)]);
        await auth.body?.cancel();
        await fs.body?.cancel();
        return true;
    } catch {
        return false;
    }
}

// Loads the repository's firestore.rules into the emulator.
export async function loadRules(): Promise<void> {
    const content = await Deno.readTextFile(new URL("../../firestore.rules", import.meta.url));
    const response = await emulatorFetch(`${FS}/emulator/v1/projects/${PROJECT_ID}:securityRules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }),
    });
    if (!response.ok) throw new Error(`rules not loaded: ${response.status} ${await response.text()}`);
    await response.body?.cancel();
}

export async function clearEmulators(): Promise<void> {
    for (const url of [
        `${FS}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
        `${AUTH}/emulator/v1/projects/${PROJECT_ID}/accounts`,
    ]) {
        const response = await emulatorFetch(url, { method: "DELETE" });
        await response.body?.cancel();
    }
}

// A synthetic Auth Emulator user with a fixed uid and its emulator ID token
// (unsigned, alg "none": only emulators accept it).
export async function createUser(uid: string): Promise<{ uid: string; emulatorToken: string }> {
    const email = `${uid}@example.test`;
    const password = "synthetic-only-" + uid;
    const created = await emulatorFetch(
        `${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
            body: JSON.stringify({ localId: uid, email, password }),
        },
    );
    if (!created.ok) throw new Error(`user not created: ${await created.text()}`);
    await created.body?.cancel();
    const signIn = await emulatorFetch(
        `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
        },
    );
    const data = await signIn.json();
    if (!signIn.ok || data.localId !== uid) throw new Error(`sign-in failed for ${uid}`);
    return { uid, emulatorToken: data.idToken };
}

// --- Firestore REST -------------------------------------------------------

type Plain = string | number | boolean | Date | null;
export type ServerTime = { serverTime: true };
export const SERVER_TIME: ServerTime = { serverTime: true };

export function encode(value: Plain): Record<string, unknown> {
    if (value === null) return { nullValue: null };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") return { doubleValue: value };
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    return { stringValue: value };
}

function auth(token: string | null): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
}

// Writes one document as `token` would through the SDK: fields given as
// SERVER_TIME become request.time, like serverTimestamp().
export async function write(
    path: string,
    fields: Record<string, Plain | ServerTime>,
    token: string | null,
    options: { merge?: boolean } = {},
): Promise<number> {
    const plain: Record<string, unknown> = {};
    const transforms: Array<Record<string, string>> = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value && typeof value === "object" && "serverTime" in value) {
            transforms.push({ fieldPath: key, setToServerValue: "REQUEST_TIME" });
        } else {
            plain[key] = encode(value as Plain);
        }
    }
    const update: Record<string, unknown> = {
        update: { name: `${ROOT}/${path}`, fields: plain },
        updateTransforms: transforms,
    };
    if (options.merge) update.updateMask = { fieldPaths: Object.keys(fields) };
    const response = await emulatorFetch(`${DOCUMENTS}:commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(token) },
        body: JSON.stringify({ writes: [update] }),
    });
    await response.body?.cancel();
    return response.status;
}

// Rules bypassed: test setup only (what an administrator or the console does).
export async function adminWrite(path: string, fields: Record<string, Plain | ServerTime>): Promise<void> {
    const status = await write(path, fields, "owner");
    if (status !== 200) throw new Error(`admin write ${path}: ${status}`);
}

export async function remove(path: string, token: string | null): Promise<number> {
    const response = await emulatorFetch(`${DOCUMENTS}/${path}`, { method: "DELETE", headers: auth(token) });
    await response.body?.cancel();
    return response.status;
}

export async function get(path: string, token: string | null): Promise<{ status: number; data: any }> {
    const response = await emulatorFetch(`${DOCUMENTS}/${path}`, { headers: auth(token) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
}

// Lists a collection (GET on the collection path).
export async function list(path: string, token: string | null): Promise<{ status: number; data: any }> {
    return await get(path, token);
}

// A structured query on one collection with equality filters.
export async function query(
    collection: string,
    equals: Record<string, Plain>,
    token: string | null,
): Promise<{ status: number; data: any }> {
    const filters = Object.entries(equals).map(([field, value]) => ({
        fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encode(value) },
    }));
    const where = filters.length === 0
        ? undefined
        : filters.length === 1
        ? filters[0]
        : { compositeFilter: { op: "AND", filters } };
    const response = await emulatorFetch(`${DOCUMENTS}:runQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(token) },
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], where } }),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
}
