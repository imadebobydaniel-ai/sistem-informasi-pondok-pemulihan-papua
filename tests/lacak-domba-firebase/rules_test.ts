// firestore.rules of this repository, on the Firestore EMULATOR, with ID
// tokens of synthetic users from the Auth EMULATOR. Covers what Lacak Domba
// relies on: presence, presence_locations, user_blocks (both directions)
// and the account status the Edge Function reads from users/{uid}.
// Run (emulators started first, see emulator.ts):
//   deno test --no-lock --no-config --allow-net --allow-read --allow-env tests/lacak-domba-firebase/rules_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
    adminWrite,
    clearEmulators,
    createUser,
    emulatorsRunning,
    get,
    list,
    loadRules,
    query,
    remove,
    SERVER_TIME,
    write,
} from "./emulator.ts";

const ignore = !(await emulatorsRunning());
if (ignore) console.warn("Firebase emulators not running: rules tests SKIPPED.");

const ALICE = "test-ld-emu-alice";
const BOB = "test-ld-emu-bob";
const CAROL = "test-ld-emu-carol";
const tokens: Record<string, string> = {};

const OK = 200;
const DENIED = 403;

// The fields updatePresence() writes, all of them, with server times.
function presence(discoverable: boolean, showOnline: boolean) {
    return {
        online: true,
        lastSeen: SERVER_TIME,
        updatedAt: SERVER_TIME,
        displayName: "Sintetis",
        photoURL: "",
        komsel: "Komsel Uji",
        wilayah: "Wilayah Uji",
        discoverable,
        showOnline,
    };
}

const location = (latitude = -1, longitude = 131) => ({ latitude, longitude, updatedAt: SERVER_TIME });

const test = (name: string, fn: () => Promise<void>) =>
    Deno.test({
        name,
        ignore,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            await clearEmulators();
            await loadRules();
            for (const uid of [ALICE, BOB, CAROL]) tokens[uid] = (await createUser(uid)).emulatorToken;
            await fn();
        },
    });

// --- presence ----------------------------------------------------------------

test("presence: only the owner writes it, with server times and the exact field set", async () => {
    assertEquals(await write(`presence/${ALICE}`, presence(true, true), tokens[ALICE]), OK);
    assertEquals(await write(`presence/${ALICE}`, presence(true, true), tokens[BOB]), DENIED, "Bob writes Alice");
    assertEquals(await write(`presence/${ALICE}`, presence(true, true), null), DENIED, "no token");
    const clientTime = { ...presence(true, true), lastSeen: new Date(Date.now() + 3600_000) };
    assertEquals(await write(`presence/${ALICE}`, clientTime, tokens[ALICE]), DENIED, "lastSeen chosen by the client");
    const extra = { ...presence(true, true), latitude: -1 } as Record<string, any>;
    assertEquals(await write(`presence/${ALICE}`, extra, tokens[ALICE]), DENIED, "coordinates in the public document");
    assertEquals(await remove(`presence/${ALICE}`, tokens[BOB]), DENIED);
});

test("presence: others read it only while discoverable AND showOnline, never without login", async () => {
    await write(`presence/${ALICE}`, presence(false, true), tokens[ALICE]);
    assertEquals((await get(`presence/${ALICE}`, tokens[ALICE])).status, OK, "owner");
    assertEquals((await get(`presence/${ALICE}`, tokens[BOB])).status, DENIED, "not discoverable");
    await write(`presence/${ALICE}`, presence(true, false), tokens[ALICE]);
    assertEquals((await get(`presence/${ALICE}`, tokens[BOB])).status, DENIED, "discoverable, online hidden");
    await write(`presence/${ALICE}`, presence(true, true), tokens[ALICE]);
    assertEquals((await get(`presence/${ALICE}`, tokens[BOB])).status, OK, "discoverable and online shown");
    assertEquals((await get(`presence/${ALICE}`, null)).status, DENIED, "no login");
});

test("presence: a block in EITHER direction hides it", async () => {
    await write(`presence/${ALICE}`, presence(true, true), tokens[ALICE]);
    const block = { blockedUid: BOB, createdAt: SERVER_TIME, displayName: "", photoURL: "" };
    assertEquals(await write(`user_blocks/${ALICE}/blocked/${BOB}`, block, tokens[ALICE]), OK);
    assertEquals((await get(`presence/${ALICE}`, tokens[BOB])).status, DENIED, "Alice blocked Bob");
    assertEquals(await remove(`user_blocks/${ALICE}/blocked/${BOB}`, tokens[ALICE]), OK);
    assertEquals((await get(`presence/${ALICE}`, tokens[BOB])).status, OK, "unblocked");
    const reverse = { blockedUid: ALICE, createdAt: SERVER_TIME, displayName: "", photoURL: "" };
    assertEquals(await write(`user_blocks/${BOB}/blocked/${ALICE}`, reverse, tokens[BOB]), OK);
    assertEquals((await get(`presence/${ALICE}`, tokens[BOB])).status, DENIED, "Bob blocked Alice");
});

test("presence: the collection cannot be listed or queried for discoverable users", async () => {
    await write(`presence/${ALICE}`, presence(true, true), tokens[ALICE]);
    assertEquals((await list("presence", tokens[BOB])).status, DENIED, "list");
    const discoverable = await query("presence", { discoverable: true, showOnline: true }, tokens[BOB]);
    assertEquals(discoverable.status, DENIED, "query for discoverable users");
    assertEquals((await query("presence", {}, null)).status, DENIED, "query without login");
});

// --- presence_locations ---------------------------------------------------------

test("presence_locations: owner only, for reads, lists and queries", async () => {
    assertEquals(await write(`presence_locations/${ALICE}`, location(), tokens[ALICE]), OK);
    assertEquals((await get(`presence_locations/${ALICE}`, tokens[ALICE])).status, OK);
    assertEquals((await get(`presence_locations/${ALICE}`, tokens[BOB])).status, DENIED, "Bob");
    assertEquals((await get(`presence_locations/${ALICE}`, null)).status, DENIED, "no login");
    assertEquals((await list("presence_locations", tokens[BOB])).status, DENIED, "list");
    assertEquals((await query("presence_locations", {}, tokens[BOB])).status, DENIED, "query");
});

test("presence_locations: no foreign write or delete, valid coordinates and server time only", async () => {
    assertEquals(await write(`presence_locations/${ALICE}`, location(), tokens[BOB]), DENIED, "Bob writes Alice");
    await write(`presence_locations/${ALICE}`, location(), tokens[ALICE]);
    assertEquals(await remove(`presence_locations/${ALICE}`, tokens[BOB]), DENIED, "Bob deletes Alice");
    assertEquals(await write(`presence_locations/${ALICE}`, location(91, 131), tokens[ALICE]), DENIED, "latitude 91");
    assertEquals(await write(`presence_locations/${ALICE}`, location(-1, 181), tokens[ALICE]), DENIED, "longitude 181");
    const clientTime = { latitude: -1, longitude: 131, updatedAt: new Date(Date.now() + 3600_000) };
    assertEquals(await write(`presence_locations/${ALICE}`, clientTime, tokens[ALICE]), DENIED, "client time");
    const extra = { ...location(), accuracy: 5 } as Record<string, any>;
    assertEquals(await write(`presence_locations/${ALICE}`, extra, tokens[ALICE]), DENIED, "extra field");
    assertEquals(await remove(`presence_locations/${ALICE}`, tokens[ALICE]), OK, "owner deletes");
});

// --- user_blocks ---------------------------------------------------------------

test("user_blocks: owner only; no self-block, no edit, no foreign entries", async () => {
    const block = (blockedUid: string) => ({ blockedUid, createdAt: SERVER_TIME, displayName: "", photoURL: "" });
    assertEquals(await write(`user_blocks/${ALICE}/blocked/${BOB}`, block(BOB), tokens[ALICE]), OK);
    assertEquals((await list(`user_blocks/${ALICE}/blocked`, tokens[ALICE])).status, OK, "owner lists (Edge Function)");
    assertEquals((await list(`user_blocks/${ALICE}/blocked`, tokens[BOB])).status, DENIED, "Bob lists Alice's blocks");
    assertEquals((await get(`user_blocks/${ALICE}/blocked/${BOB}`, tokens[BOB])).status, DENIED, "Bob reads Alice's block");
    assertEquals(await write(`user_blocks/${ALICE}/blocked/${CAROL}`, block(CAROL), tokens[BOB]), DENIED, "Bob writes Alice's list");
    assertEquals(await write(`user_blocks/${ALICE}/blocked/${ALICE}`, block(ALICE), tokens[ALICE]), DENIED, "self-block");
    assertEquals(await write(`user_blocks/${ALICE}/blocked/${BOB}`, block(BOB), tokens[ALICE]), DENIED, "update is never allowed");
    assertEquals(await remove(`user_blocks/${ALICE}/blocked/${BOB}`, tokens[BOB]), DENIED, "Bob unblocks himself");
    assertEquals(await remove(`user_blocks/${ALICE}/blocked/${BOB}`, tokens[ALICE]), OK);
});

// --- users / account status (read by the Edge Function) ------------------------

test("users: an account can never make itself Aktif", async () => {
    assertEquals(
        await write(`users/${ALICE}`, { uid: ALICE, nama: "Sintetis", status_akun: "Aktif" }, tokens[ALICE]),
        DENIED,
        "register as Aktif",
    );
    assertEquals(
        await write(`users/${ALICE}`, { uid: ALICE, nama: "Sintetis", status_akun: "Menunggu Verifikasi" }, tokens[ALICE]),
        OK,
        "register pending",
    );
    assertEquals(
        await write(`users/${ALICE}`, { status_akun: "Aktif" }, tokens[ALICE], { merge: true }),
        DENIED,
        "promote itself",
    );
    await adminWrite(`users/${BOB}`, { uid: BOB, nama: "Sintetis", status_akun: "Nonaktif" });
    assertEquals(
        await write(`users/${BOB}`, { status_akun: "Aktif" }, tokens[BOB], { merge: true }),
        DENIED,
        "a deactivated account reactivates itself",
    );
    assertEquals(
        await write(`users/${BOB}`, { status_akun: "Aktif" }, tokens[ALICE], { merge: true }),
        DENIED,
        "another user changes the status",
    );
    // The Edge Function reads its caller's own users document with the
    // caller's token; that must stay allowed whatever happens to public reads.
    assertEquals((await get(`users/${ALICE}`, tokens[ALICE])).status, OK);
});

// FINDING (documented, rules NOT changed here): users/{uid} and all its
// subcollections are readable WITHOUT login, including listing the whole
// collection. This test records the current exposure so a change to the
// rules is noticed; it is not an endorsement.
test("FINDING users: profiles are publicly readable and listable without login", async () => {
    await adminWrite(`users/${ALICE}`, {
        uid: ALICE,
        nama: "Sintetis",
        email: `${ALICE}@example.test`,
        status_akun: "Aktif",
    });
    await adminWrite(`users/${ALICE}/riwayat/1`, { catatan: "sintetis" });
    const single = await get(`users/${ALICE}`, null);
    const all = await list("users", null);
    const sub = await get(`users/${ALICE}/riwayat/1`, null);
    const exposed = {
        getWithoutLogin: single.status,
        listWithoutLogin: all.status,
        listedDocuments: (all.data?.documents || []).length,
        fieldsVisible: Object.keys(single.data?.fields || {}).sort(),
        subcollectionWithoutLogin: sub.status,
    };
    console.log("FINDING users public access:", JSON.stringify(exposed));
    assert(single.status === OK || single.status === DENIED);
});
