"use strict";

// Local trusted-writer harness. It is deliberately not a production adapter.
const http = require("node:http");
const crypto = require("node:crypto");
const { authorizeSchedule } = require("./schedule-auth.cjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREAS = new Set(["abepura", "sentani", "doyo", "arso-1", "arso-2"]);
const CATEGORIES = new Set(["sunday-worship", "other-ministry"]);

function response(status, code, data) {
  return { status, body: data === undefined ? { ok: false, code, error: "Permintaan tidak dapat diproses." } : { ok: true, data } };
}

function hmac(secretHex, uid, role, operationId, action) {
  return crypto.createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(`${uid}\n${role}\n${operationId.toLowerCase()}\n${action}`, "utf8").digest("base64");
}

function createScheduleServer({ verifyFirebaseIdToken, readAdminRecord, readMemberAccount, executeSql, hmacSecret, staticAssets = {} }) {
  if ([verifyFirebaseIdToken, readAdminRecord, readMemberAccount, executeSql].some(fn => typeof fn !== "function") ||
      !/^[0-9a-f]{64}$/i.test(hmacSecret || "")) throw new Error("Local server dependencies are incomplete.");

  async function authenticate(request) {
    const header = request.headers.authorization || "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return { denial: response(401, "missing_token") };
    try {
      const identity = await verifyFirebaseIdToken(match[1]);
      if (!identity || typeof identity.uid !== "string" || !identity.uid || identity.uid.trim() !== identity.uid) return { denial: response(401, "invalid_token") };
      return { token: match[1], uid: identity.uid };
    } catch (_) { return { denial: response(401, "invalid_token") }; }
  }

  async function adminActor(request) {
    const auth = await authorizeSchedule({ headers: request.headers }, {
      verifyFirebaseIdToken,
      readAdminRecord: (uid, token) => readAdminRecord(uid, token)
    });
    return auth.ok ? { actor: auth.actor } : { denial: response(auth.status, auth.code) };
  }

  async function memberActor(request) {
    const auth = await authenticate(request);
    if (auth.denial) return auth;
    let account;
    try { account = await readMemberAccount(auth.uid, auth.token); }
    catch (_) { return { denial: response(503, "identity_lookup_unavailable") }; }
    if (!account || account.found !== true || account.status !== "active" || account.role !== "member") return { denial: response(403, "member_access_denied") };
    return { actor: { uid: auth.uid, role: "member" } };
  }

  function makeRequest(actor, action, payload) {
    const operationId = payload.operationId || crypto.randomUUID();
    return {
      actorUid: actor.uid,
      actorRole: actor.role,
      operationId,
      actorMac: hmac(hmacSecret, actor.uid, actor.role, operationId, action),
      action,
      ...payload
    };
  }

  async function bodyJson(req) {
    if (req.headers["content-type"] !== "application/json") throw Object.assign(new Error(), { status: 415, code: "content_type" });
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw Object.assign(new Error(), { status: 413, code: "payload_too_large" });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch (_) { throw Object.assign(new Error(), { status: 400, code: "invalid_json" }); }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const host = req.headers.host || "";
    const origin = req.headers.origin;
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") return send(403, "loopback_only");
    if (!/^127\.0\.0\.1:\d+$/.test(host)) return send(403, "loopback_host_only");
    if (origin) {
      try { const parsed = new URL(origin); if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.host !== host) return send(403, "origin_denied"); }
      catch (_) { return send(403, "origin_denied"); }
    }
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch (_) { return send(400, "invalid_url"); }
    if (url.origin !== `http://${host}`) return send(403, "target_denied");

    function send(status, code, data) {
      const result = response(status, code, data);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    }
    async function runDb(name, request) {
      try { send(200, "ok", await executeSql(name, request)); }
      catch (error) {
        const code = error?.sqlState === "23P01" || error?.sqlState === "23505" ? "schedule_conflict" :
          error?.sqlState === "P0001" ? "revision_or_state_conflict" :
          error?.sqlState === "22023" || error?.sqlState === "22P02" ? "invalid_schedule" :
          error?.sqlState === "42501" ? "writer_denied" : "schedule_store_unavailable";
        send(error?.sqlState === "23P01" || error?.sqlState === "23505" || error?.sqlState === "P0001" ? 409 :
          error?.sqlState === "22023" || error?.sqlState === "22P02" ? 400 :
          error?.sqlState === "42501" ? 403 : 503, code);
      }
    }

    try {
      if (req.method === "GET" && url.pathname === "/api/member/schedules") {
        const member = await memberActor(req); if (member.denial) return send(member.denial.status, member.denial.body.code);
        const area = url.searchParams.get("area") || "";
        const category = url.searchParams.get("category") || "";
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        if ((area && !AREAS.has(area)) || (category && !CATEGORIES.has(category)) || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return send(400, "invalid_filter");
        return await runDb("api_member_list", { area, category, from, to });
      }
      if (req.method === "GET" && url.pathname === "/api/admin/session") {
        const result = await adminActor(req); if (result.denial) return send(result.denial.status, result.denial.body.code);
        return send(200, "ok", result.actor);
      }
      if (req.method === "GET" && url.pathname === "/api/member/session") {
        const result = await memberActor(req); if (result.denial) return send(result.denial.status, result.denial.body.code);
        return send(200, "ok", result.actor);
      }
      if (req.method === "GET" && url.pathname === "/api/admin/schedules") {
        const result = await adminActor(req); if (result.denial) return send(result.denial.status, result.denial.body.code);
        return await runDb("api_admin_list", makeRequest(result.actor, "admin_read", {}));
      }
      if (req.method === "GET" && url.pathname === "/api/admin/audit") {
        const result = await adminActor(req); if (result.denial) return send(result.denial.status, result.denial.body.code);
        const scheduleId = url.searchParams.get("scheduleId") || "";
        if (!UUID.test(scheduleId)) return send(400, "invalid_schedule_id");
        return await runDb("api_audit_list", makeRequest(result.actor, "audit_read", { scheduleId }));
      }
      if (req.method === "POST" && ["/api/admin/drafts","/api/admin/publish","/api/admin/cancel"].includes(url.pathname)) {
        const result = await adminActor(req); if (result.denial) return send(result.denial.status, result.denial.body.code);
        const body = await bodyJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body,"actorUid") || Object.hasOwn(body,"actorRole")) return send(400,"invalid_request");
        if (url.pathname === "/api/admin/drafts") {
          const keys = Object.keys(body);
          if (keys.some(k => !["schedule","expectedRevision","operationId"].includes(k)) || !body.schedule || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || !UUID.test(body.operationId || "")) return send(400,"invalid_request");
          return await runDb("api_save_draft", makeRequest(result.actor,"save",body));
        }
        const keys = Object.keys(body);
        if (keys.some(k => !["scheduleId","expectedRevision","operationId"].includes(k)) || !UUID.test(body.scheduleId || "") || !UUID.test(body.operationId || "") || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) return send(400,"invalid_request");
        const action = url.pathname.endsWith("/publish") ? "publish" : "cancel";
        return await runDb(action === "publish" ? "api_publish" : "api_cancel", makeRequest(result.actor,action,body));
      }
      if (req.method === "GET" && Object.hasOwn(staticAssets, url.pathname)) {
        const asset = staticAssets[url.pathname];
        if (!asset || !(Buffer.isBuffer(asset.body) || typeof asset.body === "string") || typeof asset.contentType !== "string") return send(404,"not_found");
        res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:9199; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'" });
        return res.end(asset.body);
      }
      return send(404,"not_found");
    } catch (error) {
      send(Number.isInteger(error?.status) ? error.status : 400, error?.code || "request_failed");
    }
  });

  return server;
}

function createPsqlExecutor({ binary, port, database = "sipapua_schedule_local", user = "schedule_runtime" }) {
  const allowed = new Set(["api_save_draft","api_publish","api_cancel","api_admin_list","api_audit_list","api_member_list"]);
  return (name, payload) => {
    if (!allowed.has(name) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local database target.");
    const base64 = Buffer.from(JSON.stringify(payload),"utf8").toString("base64");
    const input = `\\set payload_b64 ${base64}\nSELECT sipapua_schedule.${name}(convert_from(decode(:'payload_b64','base64'),'UTF8')::jsonb)::text;\n`;
    const env = {};
    for (const key of ["PATH","SystemRoot","WINDIR","TEMP","TMP"]) if (process.env[key]) env[key] = process.env[key];
    const { execFileSync } = require("node:child_process");
    try {
      const output = execFileSync(binary,["-X","-qAt","--set=ON_ERROR_STOP=1","--set=VERBOSITY=verbose","-h","127.0.0.1","-p",String(port),"-U",user,"-d",database],{input,encoding:"utf8",timeout:6000,windowsHide:true,env});
      return JSON.parse(output.trim());
    } catch (error) {
      const stderr = String(error.stderr || "");
      const match = stderr.match(/ERROR:\s+(23P01|23505|P0001|22023|22P02|42501):/);
      const safe = new Error("Local schedule database operation failed.");
      safe.sqlState = match?.[1] || null;
      throw safe;
    }
  };
}

module.exports = { createScheduleServer, createPsqlExecutor, hmac };
