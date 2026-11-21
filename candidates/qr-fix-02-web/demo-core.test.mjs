import test from 'node:test';
import assert from 'node:assert/strict';
import {issue,read,lifetime,profile} from './public/demo-core.mjs';

const now=1_795_000_000_000;

test('web demo emits a five-minute namespaced payload for a fixed synthetic profile',()=>{
  const {payload,expires}=issue(now);
  assert.equal(expires,now+lifetime);
  assert.match(payload,/^SIPAPUA-STATIC-DEMO-V1:sample-001:/);
  assert.deepEqual(read(payload,expires-1),{status:'accepted',profile});
});

test('web demo rejects at the exact expiry boundary',()=>{
  const {payload,expires}=issue(now);
  assert.deepEqual(read(payload,expires),{status:'expired'});
});

test('web demo rejects real-card namespace, arbitrary data and modified strings',()=>{
  const {payload}=issue(now);
  for (const input of ['SIPAPUA-CARD '+'A'.repeat(43),'https://example.invalid','',null,payload+'\n',
    payload.replace('sample-001','sample-002'),issue(now+60_000).payload]) {
    assert.deepEqual(read(input,now),{status:'invalid'});
  }
});
