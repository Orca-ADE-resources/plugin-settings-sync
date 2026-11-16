// The per-item decision table of src/engine/merge.cjs. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, stampLocalChanges } = require('../src/engine/merge.cjs');

const m = (obj) => new Map(Object.entries(obj).map(([id, h]) => [id, { h }]));
const one = (o) => decide({ lastLocal: {}, lastRemote: {}, localStamps: {}, remoteStamps: {}, firstSync: false, now: 100, ...o })[0];

test('equal on both sides: same', () => {
  assert.equal(one({ local: m({ a: 'x' }), remote: m({ a: 'x' }) }).action, 'same');
});

test('only the repo changed: apply', () => {
  assert.equal(one({ local: m({ a: 'x' }), remote: m({ a: 'y' }), lastLocal: { a: 'x' }, lastRemote: { a: 'x' } }).action, 'apply');
});

test('only this machine changed: push', () => {
  assert.equal(one({ local: m({ a: 'y' }), remote: m({ a: 'x' }), lastLocal: { a: 'x' }, lastRemote: { a: 'x' } }).action, 'push');
});

test('new item on one side, absent on the other', () => {
  assert.equal(one({ local: m({ a: 'x' }), remote: m({}) }).action, 'push');
  assert.equal(one({ local: m({}), remote: m({ a: 'x' }) }).action, 'apply');
});

test('deleted here, unchanged in the repo: push the deletion', () => {
  assert.equal(one({ local: m({}), remote: m({ a: 'x' }), lastLocal: { a: 'x' }, lastRemote: { a: 'x' } }).action, 'push');
});

test('deleted in the repo, unchanged here: apply the deletion', () => {
  assert.equal(one({ local: m({ a: 'x' }), remote: m({}), lastLocal: { a: 'x' }, lastRemote: { a: 'x' } }).action, 'apply');
});

test('both changed: newer wins, tie goes to the repo', () => {
  const base = { local: m({ a: 'L' }), remote: m({ a: 'R' }), lastLocal: { a: 'x' }, lastRemote: { a: 'x' } };
  assert.equal(one({ ...base, localStamps: { a: { t: 50 } }, remoteStamps: { a: { t: 40 } } }).action, 'push');
  assert.equal(one({ ...base, localStamps: { a: { t: 30 } }, remoteStamps: { a: { t: 40, m: 'work' } } }).action, 'apply');
  assert.equal(one({ ...base, localStamps: { a: { t: 40 } }, remoteStamps: { a: { t: 40 } } }).action, 'apply');
  const d = one({ ...base, localStamps: { a: { t: 30 } }, remoteStamps: { a: { t: 40, m: 'work' } } });
  assert.deepEqual(d.conflict, { winner: 'remote', localAt: 30, remoteAt: 40, remoteMachine: 'work', firstSync: false });
});

test('first sync: the repo wins every conflict', () => {
  const d = one({ local: m({ a: 'L' }), remote: m({ a: 'R' }), localStamps: { a: { t: 999 } }, firstSync: true });
  assert.equal(d.action, 'apply');
  assert.equal(d.conflict.firstSync, true);
});

test('known difference (normalised value, own plugin folder): keep, unless marked for retry', () => {
  const o = { local: m({ a: 'L' }), remote: m({ a: 'R' }), lastLocal: { a: 'L' }, lastRemote: { a: 'R' } };
  assert.equal(one(o).action, 'keep');
  assert.equal(one({ ...o, retry: new Set(['a']) }).action, 'apply');
});

test('stamps: first sighting of a pending change is kept until it syncs', () => {
  const stamps = {};
  stampLocalChanges(m({ a: 'v1' }), { a: 'v0' }, stamps, 10);
  stampLocalChanges(m({ a: 'v1' }), { a: 'v0' }, stamps, 20);
  assert.equal(stamps.a.t, 10);
  stampLocalChanges(m({ a: 'v2' }), { a: 'v0' }, stamps, 30);
  assert.equal(stamps.a.t, 30, 'a newer pending value gets a newer stamp');
  stampLocalChanges(m({ a: 'v0' }), { a: 'v0' }, stamps, 40);
  assert.equal(stamps.a, undefined, 'changed back: nothing pending');
});
