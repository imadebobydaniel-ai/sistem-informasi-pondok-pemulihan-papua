// Node/Deno shared guard. Import validates configuration only; it starts nothing.
// Required: GCLOUD_PROJECT=demo-sipapua-stage4 and the three *_EMULATOR_HOST
// variables below. No fallback project/endpoints, credential files or .firebaserc reads.
const EXPECTED_PROJECT = "demo-sipapua-stage4";
const PORTS = Object.freeze({ auth: 9099, firestore: 8080, functions: 5001, hub: 4400 });

function fail(message) {
  throw new Error("Emulator safety check failed: " + message);
}

function envValue(name) {
  try {
    return typeof Deno !== "undefined" ? Deno.env.get(name) : process.env[name];
  } catch {
    fail("cannot inspect required environment setting " + name);
  }
}

// Presence only: never read or print credential values or open credential files.
function envPresent(name) {
  try {
    return typeof Deno !== "undefined"
      ? Deno.env.has(name)
      : Object.prototype.hasOwnProperty.call(process.env, name);
  } catch {
    fail("cannot inspect environment setting presence");
  }
}

function localHost(value, port, label) {
  if (value !== "127.0.0.1:" + port && value !== "localhost:" + port) {
    fail(label + " must explicitly use localhost or 127.0.0.1 on port " + port);
  }
  // Use the loopback IP for requests, even when the approved alias is supplied.
  return "127.0.0.1:" + port;
}

export function requireEmulatorEnvironment() {
  for (const name of [
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GOOGLE_CREDENTIALS", "GOOGLE_PRIVATE_KEY", "GOOGLE_CLIENT_EMAIL",
    "GCLOUD_SERVICE_KEY", "FIREBASE_ADMIN_CREDENTIALS", "FIREBASE_SERVICE_ACCOUNT",
    "FIREBASE_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "FIREBASE_CONFIG",
  ]) {
    if (envPresent(name)) fail("credential or external Firebase configuration is not allowed");
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "grpc_proxy", "GRPC_PROXY", "NODE_USE_ENV_PROXY"]) {
    if (envPresent(name)) fail("proxy configuration is not allowed for local Emulator tests");
  }
  if (envValue("GCLOUD_PROJECT") !== EXPECTED_PROJECT) {
    fail("GCLOUD_PROJECT must explicitly equal " + EXPECTED_PROJECT);
  }
  for (const name of ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "FIREBASE_PROJECT_ID", "FIREBASE_PROJECT"]) {
    if (envPresent(name) && envValue(name) !== EXPECTED_PROJECT) {
      fail("conflicting project identity in " + name);
    }
  }
  const authHost = localHost(envValue("FIREBASE_AUTH_EMULATOR_HOST"), PORTS.auth, "Auth endpoint");
  const firestoreHost = localHost(envValue("FIRESTORE_EMULATOR_HOST"), PORTS.firestore, "Firestore endpoint");
  const functionsHost = localHost(envValue("FUNCTIONS_EMULATOR_HOST"), PORTS.functions, "Functions endpoint");
  // Preserve the old Deno aliases only when they agree with the required settings.
  for (const [name, port] of [["LD_AUTH_EMULATOR", PORTS.auth], ["LD_FIRESTORE_EMULATOR", PORTS.firestore]]) {
    if (envPresent(name)) localHost(envValue(name), port, name);
  }
  const hubHost = "127.0.0.1:" + PORTS.hub;
  if (envPresent("FIREBASE_EMULATOR_HUB")) {
    localHost(envValue("FIREBASE_EMULATOR_HUB"), PORTS.hub, "Emulator Hub endpoint");
  }
  for (const name of ["FIREBASE_DATABASE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST", "STORAGE_EMULATOR_HOST"]) {
    if (envPresent(name)) fail("an unapproved Emulator service is configured");
  }
  return Object.freeze({ projectId: EXPECTED_PROJECT, authHost, firestoreHost, functionsHost, hubHost });
}

// An uncaught safety error terminates either test entry point with a failure.
export const emulatorEnvironment = requireEmulatorEnvironment();
const localFetch = globalThis.fetch.bind(globalThis);

export function assertEmulatorUrl(input) {
  let url;
  try { url = new URL(input); } catch { fail("malformed Emulator URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
      || !Object.values(PORTS).includes(Number(url.port)) || url.username || url.password) {
    fail("request destination is not an approved local Emulator");
  }
  // Reject project substitution, including a project inserted through a path argument.
  const projects = [...url.pathname.matchAll(/\/projects\/([^/:]+)/g)];
  if (projects.some(match => match[1] !== EXPECTED_PROJECT)) fail("request project does not match the demo project");
  const projectPath = "/projects/" + EXPECTED_PROJECT;
  const documentsPath = "/v1" + projectPath + "/databases/(default)/documents";
  const approvedPath = url.pathname === "/" || (
    Number(url.port) === PORTS.hub ? url.pathname === "/emulators"
    : Number(url.port) === PORTS.functions ? url.pathname.startsWith("/" + EXPECTED_PROJECT + "/")
    : Number(url.port) === PORTS.auth ? (
      url.pathname.startsWith("/identitytoolkit.googleapis.com/v1" + projectPath + "/")
      || url.pathname === "/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
      || url.pathname.startsWith("/emulator/v1" + projectPath + "/")
    ) : (
      url.pathname === documentsPath || url.pathname.startsWith(documentsPath + "/")
      || url.pathname === documentsPath + ":commit" || url.pathname === documentsPath + ":runQuery"
      || url.pathname === "/emulator/v1" + projectPath + ":securityRules"
      || url.pathname === "/emulator/v1" + projectPath + "/databases/(default)/documents"
    )
  );
  if (!approvedPath) fail("request path is outside the approved demo Emulator routes");
  url.hostname = "127.0.0.1";
  return url;
}

// The environment guard performs GET probes only, never fixture/data mutations.
async function readEmulator(input) {
  const url = assertEmulatorUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Never follow a local redirect to a remote service. No raw errors/URLs logged.
    return await localFetch(url, { method: "GET", redirect: "error", signal: controller.signal });
  } catch {
    fail("local Emulator request failed or timed out");
  } finally {
    clearTimeout(timer);
  }
}

export async function assertEmulatorsAvailable() {
  // Read-only discovery plus local GET probes. No function invocation or data writes.
  const hub = await readEmulator("http://" + emulatorEnvironment.hubHost + "/emulators");
  if (!hub.ok) { await hub.body?.cancel(); fail("Emulator Hub is unavailable"); }
  let services;
  try { services = await hub.json(); } catch { fail("invalid Emulator Hub response"); }
  for (const service of ["auth", "firestore", "functions"]) {
    const entry = services?.[service];
    if (!entry || entry.port !== PORTS[service] || !["127.0.0.1", "localhost"].includes(entry.host)) {
      fail("required " + service + " Emulator is missing or has an unexpected endpoint");
    }
    const response = await readEmulator("http://127.0.0.1:" + PORTS[service] + "/");
    const status = response.status;
    await response.body?.cancel();
    // Firestore/Functions may return 404 at their root; redirects/errors fail closed.
    if (status !== 200 && status !== 404) fail("required " + service + " Emulator is unavailable");
  }
}
