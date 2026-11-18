'use strict';
// Offline, explicit build. No downloads, Firebase, emulator or member data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = { provinces: 38, regencies: 514, districts: 7285, villages: 83762, endpoint_files: 7838 };

function validate(source) {
    const manifestBytes = fs.readFileSync(path.join(source, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.complete, true);
    assert.deepEqual(manifest.summary, expected);
    assert.equal(Object.keys(manifest.entries).length, expected.endpoint_files);
    const seen = new Map(), payloads = new Map(), totals = { provinces: 0, regencies: 0, districts: 0, villages: 0 };
    for (const [endpoint, entry] of Object.entries(manifest.entries).sort()) {
        const match = /^(provinces)\.json$|^(regencies|districts|villages)\/([1-9][0-9](?:\.[0-9]{2}){0,2})\.json$/.exec(endpoint);
        assert.ok(match, endpoint);
        const kind = match[1] || match[2], parent = match[3] || null;
        const level = ['provinces', 'regencies', 'districts', 'villages'].indexOf(kind) + 1;
        assert.equal(parent ? parent.split('.').length : 0, level - 1);
        assert.equal(entry.level, level);
        assert.equal(entry.parent, parent);
        assert.equal(entry.endpoint, endpoint);
        assert.equal(entry.source, manifest.source_base + endpoint);
        assert.match(entry.file, /^[a-z0-9.-]+\.json$/);
        const bytes = fs.readFileSync(path.join(source, 'files', entry.file));
        assert.equal(bytes.length, entry.bytes, endpoint);
        assert.equal(sha(bytes), entry.sha256, endpoint);
        const payload = JSON.parse(bytes);
        assert.ok(Array.isArray(payload.data));
        assert.equal(payload.data.length, entry.count);
        const rows = payload.data.map(row => {
            assert.equal(typeof row.id, 'string');
            assert.equal(typeof row.name, 'string');
            assert.ok(row.name.trim());
            assert.match(row.id, level === 4
                ? /^[1-9][0-9]\.[0-9]{2}\.[0-9]{2}\.[0-9]{4}$/
                : /^[1-9][0-9](?:\.[0-9]{2}){0,2}$/);
            assert.equal(row.id.split('.').length, level);
            assert.equal(row.id.includes('.') ? row.id.slice(0, row.id.lastIndexOf('.')) : null, parent);
            assert.ok(!seen.has(row.id), row.id);
            seen.set(row.id, { level, parent });
            return { id: row.id, name: row.name };
        });
        totals[kind] += rows.length;
        payloads.set(endpoint, { bytes: Buffer.from(JSON.stringify({ data: rows }) + '\n'), sourceSha256: entry.sha256, parent, count: rows.length });
    }
    for (const [key, value] of Object.entries(totals)) assert.equal(value, expected[key]);
    for (const [id, row] of seen) {
        if (row.parent) assert.equal(seen.get(row.parent)?.level, row.level - 1, id);
        if (row.level < 4) {
            const kind = ['regencies', 'districts', 'villages'][row.level - 1];
            assert.ok(payloads.has(kind + '/' + id + '.json'), id);
        }
    }
    return { manifest, manifestSha256: sha(manifestBytes), payloads };
}

function build(source) {
    const validated = validate(path.resolve(source)); // Validate everything before writing.
    const destination = path.join(root, 'assets', 'wilayah', 'v2');
    const entries = {};
    for (const [endpoint, item] of validated.payloads) {
        const target = path.join(destination, endpoint);
        assert.ok(target.startsWith(destination + path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, item.bytes);
        entries[endpoint] = { sha256: sha(item.bytes), bytes: item.bytes.length, count: item.count, parent: item.parent, source_sha256: item.sourceSha256 };
    }
    const manifest = { schema_version: 1, source_base: validated.manifest.source_base,
        source_validated_at_utc: validated.manifest.validated_at_utc,
        source_manifest_sha256: validated.manifestSha256, projection: 'data: [{id, name}]',
        summary: expected, entries };
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ destination, summary: expected, source_manifest_sha256: validated.manifestSha256 }));
}
module.exports = { validate, build, sha, expected };
if (require.main === module) {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/build-wilayah-national.cjs <validated-dataset-directory>');
    build(process.argv[2]);
}
