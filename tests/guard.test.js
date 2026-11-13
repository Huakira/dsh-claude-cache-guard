import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheGuard, baselineFromSession, fingerprint, difference, changed, protectedModel, digest, encodingMismatch } from '../guard.js';

const selection = { provider: 'relay', model: 'claude-opus-5-5' };
const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { name: 'library', parameters: { type: 'object' } }];
const base = () => fingerprint(tools, 'fixed instructions');
function make(inspect = async () => base(), records = {}) {
  const guard = new CacheGuard({ inspect, records });
  if (!records.s) guard.remember('s', { selection, fingerprint: base() });
  return guard;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test('object key order is irrelevant; tool order and schema text are material', () => {
  const a = fingerprint([{ name: 'r', parameters: { type: 'object', required: ['path'] } }], 'system');
  const b = fingerprint([{ parameters: { required: ['path'], type: 'object' }, name: 'r' }], 'system');
  assert.deepEqual(a, b);
  assert.equal(changed(difference(base(), fingerprint([...tools].reverse(), 'fixed instructions'))), true);
});

for (const [label, current, key] of [
  ['removed tool', () => fingerprint(tools.slice(0, 1), 'fixed instructions'), 'removed'],
  ['changed tool schema', () => fingerprint([{ ...tools[0], parameters: { type: 'string' } }, tools[1]], 'fixed instructions'), 'changed'],
  ['changed system instructions', () => fingerprint(tools, 'new fixed instructions'), 'system'],
]) {
  test(`${label} is blocked until specifically accepted`, async () => {
    const guard = make(async () => current());
    guard.dirty(label);
    await guard.check('s', {});
    assert.equal(guard.blocked('s', selection), true);
    const diff = guard.records.s.pending.diff;
    assert.ok(Array.isArray(diff[key]) ? diff[key].length : diff[key]);
    assert.equal(guard.accept('s'), true);
    assert.equal(guard.blocked('s', selection), false);
  });
}

test('UI-only event with identical definitions does not block', async () => {
  const guard = make();
  guard.dirty('CSS updated');
  await guard.check('s', {});
  assert.equal(guard.blocked('s', selection), false);
  assert.equal(guard.records.s.pending, undefined);
});

test('repeated dirty signals before a check coalesce; concurrent checks share work', async () => {
  const d = deferred();
  let calls = 0;
  const guard = make(() => { calls++; return d.promise; });
  for (let n = 0; n < 30; n++) guard.dirty('one plugin operation');
  const a = guard.check('s', {});
  const b = guard.check('s', {});
  d.resolve(base());
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(guard.records.s.dirty, false);
});

test('a new generation during inspection is checked again rather than cleared', async () => {
  const first = deferred();
  let calls = 0;
  const newFingerprint = fingerprint([], 'changed');
  const guard = make(async () => ++calls === 1 ? first.promise : newFingerprint);
  guard.dirty('first');
  const job = guard.check('s', {});
  guard.dirty('second');
  first.resolve(base());
  await job;
  assert.equal(calls, 2);
  assert.equal(guard.records.s.dirty, false);
  assert.deepEqual(guard.records.s.pending.fingerprint, newFingerprint);
  assert.equal(guard.blocked('s', selection), true);
});

test('reverting actual definitions removes an earlier pending difference', async () => {
  let current = fingerprint([], 'changed');
  const guard = make(async () => current);
  guard.dirty('remove');
  await guard.check('s', {});
  assert.equal(guard.blocked('s', selection), true);
  current = base();
  guard.dirty('rollback');
  await guard.check('s', {});
  assert.equal(guard.blocked('s', selection), false);
});

test('acceptance covers only that definition generation, not later changes', async () => {
  let current = fingerprint([], 'one');
  let calls = 0;
  const guard = make(async () => { calls++; return current; });
  guard.dirty('one');
  await guard.check('s', {});
  assert.equal(guard.accept('s'), true);
  assert.equal(calls, 1, 'accept itself must not request inspection or a model');
  current = fingerprint([], 'two');
  guard.dirty('two');
  assert.equal(guard.accept('s'), false, 'unchecked new changes cannot be accepted implicitly');
  await guard.check('s', {});
  assert.equal(guard.blocked('s', selection), true);
});

test('dirty or pending records survive serialization and are not replaced by a new header', async () => {
  const guard = make(async () => fingerprint([], 'changed'));
  guard.dirty('operation');
  const dirtyCopy = JSON.parse(JSON.stringify(guard.records));
  assert.equal(make(async () => base(), dirtyCopy).blocked('s', selection), true);
  await guard.check('s', {});
  const resumed = make(async () => base(), JSON.parse(JSON.stringify(guard.records)));
  resumed.remember('s', { selection, fingerprint: fingerprint([], 'changed') });
  assert.equal(resumed.blocked('s', selection), true);
  assert.deepEqual(resumed.records.s.fingerprint, base());
});

test('inspection failure retains dirty protection and prevents acceptance', async () => {
  const guard = make(async () => { throw new Error('unloaded provider'); });
  guard.dirty('unload');
  await guard.check('s', {});
  assert.equal(guard.records.s.dirty, true);
  assert.equal(guard.blocked('s', selection), true);
  assert.equal(guard.accept('s'), false);
});

test('cancellation rejection leaves prior fingerprint and pending state intact', async () => {
  const abort = new AbortController();
  const guard = make(async () => { abort.abort(); throw new Error('aborted'); });
  guard.dirty('operation');
  await guard.check('s', {}, abort.signal);
  assert.equal(guard.records.s.dirty, true);
  assert.deepEqual(guard.records.s.fingerprint, base());
  assert.equal(guard.accept('s'), false);
});

test('an inspector that resolves after cancellation must not approve or clear dirty state', async () => {
  const abort = new AbortController();
  const guard = make(async () => { abort.abort(); return base(); });
  guard.dirty('operation');
  await guard.check('s', {}, abort.signal);
  assert.equal(guard.records.s.dirty, true);
  assert.equal(guard.accept('s'), false);
});

test('other models and unselected providers do not block', async () => {
  const guard = make();
  guard.dirty('operation');
  assert.equal(guard.blocked('s', { provider: 'relay', model: 'gpt-6' }), false);
  assert.equal(protectedModel(selection, ['other-relay']), false);
});

test('tool-less Claude session still protects fixed system instructions', () => {
  const session = {
    requestHeader: () => ({ config: selection }),
    deriveMessages: () => [{ role: 'system', content: 'fixed instructions' }],
  };
  assert.deepEqual(baselineFromSession(session)?.fingerprint, fingerprint([], 'fixed instructions'));
});

test('baseline follows derived system history, ignoring normal runtime user context', () => {
  const session = {
    requestHeader: () => ({ config: selection, tools }),
    deriveMessages: () => [
      { role: 'system', content: 'old' },
      { role: 'user', content: 'Runtime time changed' },
      { role: 'system', content: 'fixed instructions' },
      { role: 'user', content: 'ordinary new user content' },
    ],
  };
  assert.deepEqual(baselineFromSession(session).fingerprint, base());
});

test('content-block system messages fingerprint as their text', () => {
  const blocks = [{ type: 'text', text: 'fixed instructions' }];
  assert.deepEqual(fingerprint(tools, blocks), base());
  assert.equal(encodingMismatch(digest(blocks), blocks, base().system), true);
  assert.equal(encodingMismatch(base().system, 'fixed instructions', base().system), false);
});

test('legacy array hashes are healed when live system text is unchanged', async () => {
  const blocks = [{ type: 'text', text: 'fixed instructions' }];
  const records = { s: { selection, fingerprint: { tools: base().tools, system: digest(blocks) }, dirty: true } };
  const guard = make(async () => base(), records);
  await guard.check('s', { session: {
    requestHeader: () => ({ config: selection, tools }),
    deriveMessages: () => [{ role: 'system', content: blocks }],
  } });
  assert.equal(guard.blocked('s', selection), false);
  assert.equal(guard.records.s.fingerprint.system, base().system);
});

test('a real system text change is not treated as an encoding mismatch', async () => {
  const blocks = [{ type: 'text', text: 'fixed instructions' }];
  const guard = make(async () => fingerprint(tools, 'new fixed instructions'));
  guard.dirty('prompt plugin');
  await guard.check('s', { session: {
    requestHeader: () => ({ config: selection, tools }),
    deriveMessages: () => [{ role: 'system', content: blocks }],
  } });
  assert.equal(guard.blocked('s', selection), true);
  assert.equal(guard.records.s.pending.diff.system, true);
});
