'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const { sha, expected } = require('../../scripts/build-wilayah-national.cjs');
const assets = path.join(root, 'assets/wilayah/v2');
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json')));
const html = fs.readFileSync(path.join(root, 'registrasi.html'), 'utf8');
const appCheck = require('../../sipapua-app-check.js');
const loader = html.slice(html.indexOf('    // --- FUNGSI API WILAYAH (ALAMAT & KELAHIRAN) ---'),
    html.indexOf('    // --- FUNGSI UPDATE JABATAN & PELAYANAN ---'));
const base = html.match(/const BASE_URL_WILAYAH = '([^']+)'/)[1];

test('all 7,838 JSON routes: checksums, projection, counts and complete parent/child graph', () => {
    assert.deepEqual(manifest.summary, expected);
    assert.equal(Object.keys(manifest.entries).length, expected.endpoint_files);
    const ids = new Map(), totals = { provinces: 0, regencies: 0, districts: 0, villages: 0 };
    for (const [endpoint, entry] of Object.entries(manifest.entries)) {
        assert.match(endpoint, /^(provinces\.json|(regencies|districts|villages)\/[0-9.]+\.json)$/);
        const bytes = fs.readFileSync(path.join(assets, endpoint));
        assert.equal(sha(bytes), entry.sha256, endpoint);
        assert.equal(bytes.length, entry.bytes);
        for (const prefix of ['', '/sistem-informasi-pondok-pemulihan-papua']) {
            const route = new URL(base + '/' + endpoint, 'https://static.invalid' + prefix + '/registrasi.html');
            assert.equal(route.pathname, prefix + '/assets/wilayah/v2/' + endpoint);
        }
        assert.match(entry.source_sha256, /^[0-9a-f]{64}$/);
        const payload = JSON.parse(bytes);
        assert.deepEqual(Object.keys(payload), ['data']);
        assert.equal(payload.data.length, entry.count);
        const kind = endpoint.split(/[/.]/)[0];
        totals[kind] += payload.data.length;
        for (const row of payload.data) {
            assert.deepEqual(Object.keys(row), ['id', 'name']);
            assert.equal(typeof row.id, 'string');
            assert.ok(row.name.trim());
            assert.ok(!ids.has(row.id));
            ids.set(row.id, entry.parent);
            assert.equal(row.id.includes('.') ? row.id.slice(0, row.id.lastIndexOf('.')) : null, entry.parent);
        }
    }
    for (const [kind, count] of Object.entries(totals)) assert.equal(count, expected[kind]);
    for (const [id, parent] of ids) {
        if (parent) assert.ok(ids.has(parent), id);
        const depth = id.split('.').length;
        if (depth < 4) assert.ok(manifest.entries[['regencies', 'districts', 'villages'][depth - 1] + '/' + id + '.json']);
    }
    const files = fs.readdirSync(assets, { recursive: true, withFileTypes: true }).filter(x => x.isFile());
    assert.equal(files.length, expected.endpoint_files + 1);
    assert.ok(files.every(x => x.name.endsWith('.json')));
});

test('all inline scripts parse and region path is repository-relative', () => {
    for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(source);
    assert.equal(base, './assets/wilayah/v2');
    assert.ok(html.includes('<script src="sipapua-app-check.js"></script>'));
    assert.ok(!html.includes('useEmulator('));
});

for (const suffix of ['', 'lahir']) {
    test('national dropdown, all 38 provinces with full child chain: ' + (suffix || 'address'), async () => {
        const f = fixture(); await f.run('loadProvinsi()');
        const id = name => name + (suffix ? '_' + suffix : '');
        const provinces = f.elements.get(id('provinsi')).options.slice(1);
        assert.equal(provinces.length, 38);
        for (const province of provinces) {
            f.elements.get(id('provinsi')).value = province.value;
            await f.run('loadKota(' + JSON.stringify(suffix) + ')');
            const regency = f.elements.get(id('kota')).options[1];
            assert.ok(regency);
            f.elements.get(id('kota')).value = regency.value;
            await f.run('loadKecamatan(' + JSON.stringify(suffix) + ')');
            const district = f.elements.get(id('kecamatan')).options[1];
            assert.ok(district);
            f.elements.get(id('kecamatan')).value = district.value;
            await f.run('loadDesa(' + JSON.stringify(suffix) + ')');
            assert.ok(f.elements.get(id('desa')).options[1]);
        }
    });
}

function fixture() {
    const elements = new Map(), requests = [];
    for (const suffix of ['', '_lahir']) for (const name of ['provinsi', 'kota', 'kecamatan', 'desa']) {
        elements.set(name + suffix, { value: '', options: [], replaceChildren(...options) { this.options = options; this.value = ''; } });
    }
    const context = vm.createContext({ document: { getElementById: id => elements.get(id) },
        Option: function (text, value) { this.text = text; this.value = value; }, AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => {
            assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
            assert.ok(url.startsWith(base + '/'));
            const endpoint = url.slice(base.length + 1); requests.push(endpoint);
            return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(assets, endpoint))) };
        } });
    vm.runInContext('const BASE_URL_WILAYAH=' + JSON.stringify(base) + ';\n' + loader, context);
    return { context, elements, requests, run: code => vm.runInContext(code, context) };
}

test('A-B-A race ignores stale success/failure and resets descendants', async () => {
    const f = fixture(); await f.run('loadProvinsi()'); const pending = [];
    f.context.fetch = url => new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
    f.elements.get('provinsi').value = '94'; const a = f.run('loadKota()');
    f.elements.get('provinsi').value = '18'; const b = f.run('loadKota()');
    f.elements.get('provinsi').value = '94'; const a2 = f.run('loadKota()');
    assert.equal(pending.length, 2);
    pending[0].resolve({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(assets, 'regencies/94.json'))) });
    await Promise.all([a, a2]); pending[1].reject(Error('stale')); await b;
    assert.equal(f.elements.get('kota').options[1].text, 'Kabupaten Nabire');
    assert.equal(f.elements.get('kecamatan').options.length, 1);
    assert.equal(f.elements.get('desa').options.length, 1);
});

test('invalid parent, HTTP failure and malformed payload fail closed; retry remains available', async () => {
    const f = fixture(); f.elements.get('provinsi').value = '../other'; await f.run('loadKota()');
    assert.equal(f.requests.length, 0);
    f.elements.get('provinsi').value = '94';
    for (const response of [{ ok: false }, { ok: true, json: async () => ({ data: [{}] }) }]) {
        f.context.fetch = async () => response; await f.run('loadKota()');
        assert.equal(f.elements.get('kota').options.length, 1);
        assert.match(f.elements.get('kota').options[0].text, /Gagal/);
    }
});

test('App Check configuration and missing SDK fail closed', () => {
    assert.equal(appCheck.configuration.provider, 'recaptcha-enterprise');
    assert.ok(appCheck.configuration.siteKey.trim());
    assert.throws(() => appCheck.prepare({}, {provider:'recaptcha-enterprise',siteKey:''}), /belum dikonfigurasi/);
    assert.throws(() => appCheck.prepare({}), /SDK/);
    assert.throws(() => appCheck.prepare({}, { provider: 'recaptcha-enterprise', siteKey: 'mock-only' }), /SDK/);
    assert.throws(() => appCheck.prepare({}, { provider: 'other', siteKey: 'mock-only' }));
});
test('App Check activation is idempotent, refresh enabled, token required; no key changes', async () => {
    const calls = [], provider = { activate: (...args) => calls.push(args), getToken: async () => ({ token: 'mock-only' }) };
    const firebase = { appCheck: () => provider };
    firebase.appCheck.ReCaptchaEnterpriseProvider = class { constructor(key) { this.key = key; } };
    const config = { provider: 'recaptcha-enterprise', siteKey: 'mock-only' };
    await appCheck.prepare(firebase, config)(); await appCheck.prepare(firebase, config)();
    assert.equal(calls.length, 1); assert.equal(calls[0][0].key, 'mock-only'); assert.equal(calls[0][1], true);
    assert.throws(() => appCheck.prepare(firebase, { ...config, siteKey: 'changed' }));
    for (const token of [null, '', ' ', 42]) {
        provider.getToken = async () => ({ token }); await assert.rejects(appCheck.prepare(firebase, config));
    }
    provider.getToken = async () => { throw Error('offline'); };
    await assert.rejects(appCheck.prepare(firebase, config), /offline/);
});
test('actual registration gate blocks callable when helper is absent or unconfigured', async () => {
    const source = html.slice(html.indexOf('    // Site key is configured'), html.indexOf('    const db = firebase.firestore()'));
    for (const helper of [undefined, appCheck]) {
        let calls = 0;
        const context = vm.createContext({ firebase: { app: () => ({ functions: () => ({ httpsCallable: () => async () => { calls++; } }) }) }, SIPAPUA_APP_CHECK: helper });
        context.window = context; vm.runInContext(source, context);
        await assert.rejects(() => vm.runInContext('registrationFunctions.httpsCallable("registrationReadiness")({code:"ABE"})', context));
        assert.equal(calls, 0);
    }
});
test('actual registration gate requires token before forwarding callable', async () => {
    const source = html.slice(html.indexOf('    // Site key is configured'), html.indexOf('    const db = firebase.firestore()'));
    const calls = [], provider = { activate: () => calls.push('activate'), getToken: async () => { calls.push('token'); return { token: 'mock-only' }; } };
    const firebase = { appCheck: () => provider, app: () => ({ functions: region => {
        assert.equal(region, 'asia-southeast2');
        return { httpsCallable: name => async data => { calls.push([name, data.code]); return { data: { ready: true } }; } };
    } }) };
    firebase.appCheck.ReCaptchaEnterpriseProvider = class { constructor(key) { this.key = key; } };
    const context = vm.createContext({ firebase, SIPAPUA_APP_CHECK: {
        prepare: sdk => appCheck.prepare(sdk, { provider: 'recaptcha-enterprise', siteKey: 'mock-only' })
    } }); context.window = context; vm.runInContext(source, context);
    await vm.runInContext('registrationFunctions.httpsCallable("registrationReadiness")({code:"ABE"})', context);
    assert.deepEqual(calls, ['activate', 'token', ['registrationReadiness', 'ABE']]);
    provider.getToken = async () => { throw Error('offline'); };
    await assert.rejects(() => vm.runInContext('registrationFunctions.httpsCallable("registerSIPAPUAProfile")({code:"ABE"})', context));
    assert.equal(calls.length, 3);
});

test('HTTP static routes/checksums work at root and project subpath', async () => {
    const prefixes = ['', '/sistem-informasi-pondok-pemulihan-papua'];
    const server = http.createServer((req, res) => {
        const match = prefixes.map(prefix => prefix + '/assets/wilayah/v2/').find(prefix => req.url.startsWith(prefix));
        const endpoint = match && req.url.slice(match.length);
        if (!endpoint || !manifest.entries[endpoint]) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(fs.readFileSync(path.join(assets, endpoint)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const origin = 'http://127.0.0.1:' + server.address().port;
        for (const prefix of prefixes) {
            const page = origin + prefix + '/registrasi.html';
            for (const endpoint of ['provinces.json', 'regencies/94.json', 'districts/94.01.json', 'villages/94.01.01.json']) {
                const url = new URL(base + '/' + endpoint, page);
                assert.equal(url.pathname, prefix + '/assets/wilayah/v2/' + endpoint);
                const response = await fetch(url, { redirect: 'error' }); assert.equal(response.status, 200);
                assert.equal(sha(Buffer.from(await response.arrayBuffer())), manifest.entries[endpoint].sha256);
            }
            assert.equal((await fetch(origin + prefix + '/assets/wilayah/v2/villages/00.json')).status, 404);
        }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
