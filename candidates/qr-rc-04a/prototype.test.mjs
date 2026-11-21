import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {admissionSchema, createAdmissionGate, createMockBoundVerifier} from './prototype.mjs';

const start = Date.parse('2026-11-21T23:59:59.999Z');

test('daily reservation cannot over-admit concurrent operations and renews at UTC midnight', async t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(admissionSchema);
  const db = {prepare(sql) {
    const statement = sqlite.prepare(sql);
    return {bind: (...args) => ({first: async () => statement.get(...args)})};
  }};
  const admit = createAdmissionGate(db, {dailyCredits: 64});
  let calls = 0;
  const verify = async () => {
    calls++;
    return {status: 200};
  };
  const results = await Promise.all(Array.from({length: 20}, () => admit(start, verify)));
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(results.filter(result => result.status === 429).length, 18);
  assert.equal(calls, 2);
  assert.equal(sqlite.prepare('SELECT credits FROM qr_admission').get().credits, 64);
  assert.equal((await admit(start + 1, verify)).status, 200);
});

test('storage quota or outage blocks verified operation, unknown downstream failures return 503', async () => {
  const quotaDb = {prepare() {
    return {bind: () => ({first: async () => { throw new Error('quota exhaustion'); }})};
  }};
  let called = false;
  assert.deepEqual(await createAdmissionGate(quotaDb)(start, async () => { called = true; }), {status: 503});
  const missingDb = {prepare() { throw new Error('binding unavailable'); }};
  assert.deepEqual(await createAdmissionGate(missingDb)(start, async () => { called = true; }), {status: 503});
  assert.equal(called, false);
  const admittedDb = {prepare() {
    return {bind: () => ({first: async () => ({credits: 32})})};
  }};
  assert.deepEqual(await createAdmissionGate(admittedDb)(start, async () => {
    throw new Error('private upstream details');
  }), {status: 503});
});

test('mock STS receives runtime assertion only and provider rejects replays', async () => {
  const seen = new Set();
  const verifier = createMockBoundVerifier({
    workloadAssertion: async () => 'test-workload-assertion',
    exchangeSts: async request => {
      assert.deepEqual(request, {subjectToken: 'test-workload-assertion'});
      return {token_type: 'Bearer', access_token: 'test-google-access', expires_in: 300};
    },
    consumeAppCheck: async ({accessToken, appCheckToken}) => {
      assert.equal(accessToken, 'test-google-access');
      if (!appCheckToken) return {status: 403, body: {}};
      if (seen.has(appCheckToken)) return {status: 200, body: {alreadyConsumed: true}};
      seen.add(appCheckToken);
      return {status: 200, body: {}};
    }
  });
  assert.equal(await verifier.consume('test-member-attestation'), true);
  assert.equal(await verifier.consume('test-member-attestation'), false);
  assert.equal(await verifier.consume(null), false);
});

test('missing workload assertion, invalid STS response and unknown consume outcome deny access', async () => {
  const dependencies = {
    workloadAssertion: async () => 'test-workload-assertion',
    exchangeSts: async () => ({token_type: 'Bearer', access_token: 'test-google-access', expires_in: 300}),
    consumeAppCheck: async () => ({status: 200, body: {alreadyConsumed: null}})
  };
  assert.equal(await createMockBoundVerifier(dependencies).consume('attestation'), false);
  let calls = 0;
  dependencies.consumeAppCheck = async () => { calls++; };
  assert.equal(await createMockBoundVerifier({...dependencies, exchangeSts: async () => ({})}).consume('attestation'), false);
  assert.equal(await createMockBoundVerifier({...dependencies, workloadAssertion: async () => null}).consume('attestation'), false);
  assert.equal(calls, 0);
});

