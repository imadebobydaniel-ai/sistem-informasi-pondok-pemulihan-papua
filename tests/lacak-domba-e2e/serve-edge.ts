// Serves supabase/functions/lacak-domba-nearby/index.ts over real HTTP on
// 127.0.0.1 for the browser E2E test. The function code is unchanged: only
// its calls to Google (JWKS and Firestore REST) are sent to the local
// fake-firebase.ts instead, and Deno.serve gets a local port. Its PostgREST
// calls go to the local PostgREST given in SUPABASE_URL.
// Needs SUPABASE_URL (local) and SUPABASE_SERVICE_ROLE_KEY (local test key).
const FIREBASE = `http://127.0.0.1:${Deno.env.get("LD_E2E_FIREBASE_PORT") || 54340}`;
const PORT = Number(Deno.env.get("LD_E2E_EDGE_PORT") || 54341);
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const FIRESTORE = "https://firestore.googleapis.com/";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(supabaseUrl)) {
    throw new Error("serve-edge.ts runs only against a LOCAL SUPABASE_URL");
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === JWKS_URL) return realFetch(`${FIREBASE}/jwks`);
    if (request.url.startsWith(FIRESTORE)) {
        return realFetch(new Request(FIREBASE + "/" + request.url.slice(FIRESTORE.length), request));
    }
    if (request.url.startsWith(supabaseUrl)) return realFetch(request);
    return Promise.resolve(new Response("blocked by serve-edge.ts", { status: 599 }));
};

const serve = Deno.serve.bind(Deno);
Object.defineProperty(Deno, "serve", {
    configurable: true,
    writable: true,
    value: (handler: (request: Request) => Response | Promise<Response>) =>
        serve({ hostname: "127.0.0.1", port: PORT, onListen: () => console.log(`edge on ${PORT}`) }, handler),
});
await import("../../supabase/functions/lacak-domba-nearby/index.ts");
