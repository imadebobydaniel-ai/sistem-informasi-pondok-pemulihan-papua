// Browser stand-in for the Firebase v8 SDK calls lacak-domba.html makes,
// backed by fake-firebase.ts. E2E test only: the test serves this file in
// place of the three gstatic firebase-*.js scripts. The signed-in synthetic
// user is localStorage["ld-e2e-uid"] (set by the test).
(function () {
    const BASE = "http://127.0.0.1:54340";
    const uid = localStorage.getItem("ld-e2e-uid");
    let tokenCache = "";

    async function getIdToken(force) {
        if (tokenCache && !force) return tokenCache;
        const response = await fetch(BASE + "/mint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uid })
        });
        tokenCache = (await response.json()).token;
        return tokenCache;
    }

    const user = uid ? { uid, displayName: "Sintetis " + uid, photoURL: "", getIdToken } : null;

    async function fs(body) {
        const response = await fetch(BASE + "/fs", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + await getIdToken(false) },
            body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error("firestore " + (data.error || response.status));
            error.code = data.error || "unavailable";
            throw error;
        }
        return data;
    }

    function encode(value) {
        if (value && value.__serverTimestamp) return { __ts: true };
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const out = {};
            for (const key of Object.keys(value)) out[key] = encode(value[key]);
            return out;
        }
        return value;
    }

    function snapshot(id, exists, data) {
        return { id, exists, data: () => (data || undefined) };
    }

    function docRef(path) {
        return {
            id: path.split("/").pop(),
            path,
            async get() {
                const result = await fs({ op: "get", path });
                return snapshot(path.split("/").pop(), result.exists, result.data);
            },
            set(data, options) {
                return fs({ op: "set", path, data: encode(data), merge: !!(options && options.merge) }).then(() => undefined);
            },
            update(data) { return fs({ op: "update", path, data: encode(data) }).then(() => undefined); },
            delete() { return fs({ op: "delete", path }).then(() => undefined); },
            collection(name) { return collectionRef(path + "/" + name); }
        };
    }

    function collectionRef(path, where) {
        const filters = where || [];
        return {
            doc(id) { return docRef(path + "/" + id); },
            where(field, operator, value) { return collectionRef(path, filters.concat([[field, operator, value]])); },
            async get() {
                const result = await fs({ op: filters.length ? "query" : "list", path, where: filters });
                const docs = result.docs.map((item) => snapshot(item.id, true, item.data));
                return { empty: docs.length === 0, docs, size: docs.length };
            }
        };
    }

    const db = {
        collection: (name) => collectionRef(name),
        batch() {
            const ops = [];
            return {
                set(ref, data, options) { ops.push({ op: "set", path: ref.path, data: encode(data), merge: !!(options && options.merge) }); },
                update(ref, data) { ops.push({ op: "update", path: ref.path, data: encode(data) }); },
                delete(ref) { ops.push({ op: "delete", path: ref.path }); },
                commit() { return fs({ op: "batch", ops }).then(() => undefined); }
            };
        }
    };

    const auth = {
        currentUser: user,
        onAuthStateChanged(callback) { setTimeout(() => callback(user), 0); return () => {}; },
        // Signed out until the test sets ld-e2e-uid again (a new login).
        signOut() {
            localStorage.removeItem("ld-e2e-uid");
            tokenCache = "";
            auth.currentUser = null;
            return Promise.resolve();
        }
    };

    const firestore = () => db;
    firestore.FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true }) };

    window.firebase = {
        apps: [],
        initializeApp() { this.apps.push({}); return {}; },
        auth: () => auth,
        firestore
    };
})();
