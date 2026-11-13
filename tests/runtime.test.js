import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, watchPaths } from '../runtime.js';
import { fingerprint } from '../guard.js';

const selection = { provider: 'relay', model: 'claude-opus-5-5' };
const tools = [{ name: 'read', parameters: { type: 'object' } }, { name: 'library', parameters: { type: 'object' } }];
const base = () => fingerprint(tools, 'fixed');
async function harness(t, options = {}) {
  const handlers = new Map(), commands = new Map(), effects = [];
  const rows = new Map(Object.entries(structuredClone(options.records ?? {})));
  let current = base(), inspectCalls = 0, nextCalls = 0, sends = 0;
  const queue = [];
  const agent = {
    session: { id: 's', requestHeader: () => ({ config: selection, tools }), deriveMessages: () => [{ role: 'system', content: 'fixed' }] },
    inbox: { splice(target, start, removed, messages) { assert.equal(target, 'next-step'); assert.equal(start, 0); assert.equal(removed, 0); queue.splice(start, removed, ...messages); } },
    send() { sends++; }, followup() { sends++; }, steer() { sends++; },
    model: { current: () => selection },
  };
  const ctx = {
    agents: { list: () => [agent] },
    logger: { warn() {} },
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return () => {}; },
    commands: { register(command) { commands.set(command.name, command); return () => {}; } },
    effect(fn) { effects.push(fn()); },
  };
  let watcherNotice;
  const installed = await install(ctx, { debounceMs: 10, providers: options.providers ?? [], watchFiles: [] }, {
    openStore: async () => ({ entries: () => rows.entries(), put: async (id, value) => {
      if (options.failWrite?.()) throw new Error('disk unavailable');
      rows.set(id, structuredClone(value));
    }, close: async () => {} }),
    inspect: async (a, signal) => { inspectCalls++; return options.inspect ? options.inspect(a, signal) : current; },
    watchFiles: (_paths, changed) => { watcherNotice = changed; return () => {}; },
  });
  t.after(async () => { for (const disposer of effects.reverse()) await disposer?.(); });
  const settle = async () => {
    await tick();
    await Promise.all([...installed.guard.jobs.values()]);
    await installed.flush();
  };
  await settle();
  const h = {
    ...installed, agent, queue, rows, commands,
    set current(value) { current = value; },
    get inspectCalls() { return inspectCalls; }, get sends() { return sends; }, get nextCalls() { return nextCalls; },
    notify() { watcherNotice(); },
    emit(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
    settle,
    async step(messages = [], selected = selection, signal = new AbortController().signal) {
      return handlers.get('agent/pre-step')[0]({ agent, signal, messages, modelSelection: selected }, async () => { nextCalls++; return { kind: 'enter', messages }; });
    },
    async command(name) { return commands.get(name).handler({ agent, signal: new AbortController().signal, rawInput: '' }); },
  };
  return h;
}

test('100 clean steps perform no inspection or model work beyond next()', async t => {
  const h = await harness(t);
  const before = h.inspectCalls;
  for (let n = 0; n < 100; n++) assert.equal((await h.step()).kind, 'enter');
  assert.equal(h.inspectCalls, before);
  assert.equal(h.nextCalls, 100);
  assert.equal(h.sends, 0);
});

test('blocked messages retain exact identities, order, and attachments without waking', async t => {
  const h = await harness(t);
  h.current = fingerprint(tools.slice(0, 1), 'fixed');
  h.emit('tools/change');
  const attachment = { type: 'image', source: 'saved-receipt' };
  const a = { id: 'a', content: [{ type: 'text', text: 'first' }, attachment] };
  const b = { id: 'b', content: [{ type: 'text', text: 'second' }] };
  assert.equal((await h.step([a, b])).kind, 'reject');
  assert.equal(h.nextCalls, 0);
  assert.equal(h.sends, 0);
  assert.equal(h.queue[0], a);
  assert.equal(h.queue[1], b);
  assert.equal(h.queue[0].content[1], attachment);
});

test('accept command does not send input; allows once, then a new change blocks again', async t => {
  const h = await harness(t);
  h.current = fingerprint([], 'changed');
  h.emit('tools/change');
  assert.equal((await h.step()).kind, 'reject');
  assert.equal((await h.command('cacheaccept')).kind, 'success');
  assert.equal(h.sends, 0);
  assert.equal(h.nextCalls, 0);
  assert.equal((await h.step()).kind, 'enter');
  h.current = fingerprint([], 'another definition');
  h.emit('system-prompt/change');
  assert.equal((await h.step()).kind, 'reject');
  assert.equal(h.sends, 0);
});

test('UI-only change stays transparent and event bursts are debounced', async t => {
  const h = await harness(t);
  const count = h.inspectCalls;
  for (let n = 0; n < 20; n++) h.emit('plugin-manager/changed');
  await delay(35);
  await h.settle();
  assert.equal(h.inspectCalls - count, 1);
  assert.equal((await h.step()).kind, 'enter');
});

test('saved pending state is not forgotten during installation or session resume', async t => {
  const initial = base(), next = fingerprint([], 'changed');
  const records = { s: { selection, fingerprint: initial, dirty: false, pending: { fingerprint: next, diff: { removed: ['library'], added: [], changed: [], reordered: true, system: true }, epoch: 1 } } };
  const h = await harness(t, { records, inspect: async () => next });
  assert.equal((await h.step()).kind, 'reject');
  assert.deepEqual(h.guard.records.s.fingerprint, initial);
  h.emit('agent/created', { agent: h.agent });
  await h.settle();
  assert.equal(h.guard.blocked('s', selection), true);
});

test('non-Claude requests bypass dirty checks and blocking', async t => {
  const h = await harness(t);
  h.emit('tools/change');
  const count = h.inspectCalls;
  const decision = await h.step([], { provider: 'relay', model: 'gpt-6' });
  assert.equal(decision.kind, 'enter');
  assert.equal(h.inspectCalls, count);
});

test('inspection error preserves input and cannot be accepted', async t => {
  let broken = false;
  const h = await harness(t, { inspect: async () => { if (broken) throw new Error('provider unavailable'); return base(); } });
  broken = true;
  h.emit('tools/change');
  const message = { id: 'pending', content: [] };
  assert.equal((await h.step([message])).kind, 'reject');
  assert.equal(h.queue[0], message);
  assert.equal((await h.command('cacheaccept')).kind, 'error');
  assert.equal(h.guard.blocked('s', selection), true);
});

test('canceled pre-step never calls next or accepts a dirty change', async t => {
  const h = await harness(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(h.step([], selection, abort.signal));
  assert.equal(h.nextCalls, 0);
  assert.equal(h.sends, 0);
});

test('failed durable acceptance leaves the prior pending protection active', async t => {
  let fail = false;
  const h = await harness(t, { failWrite: () => fail });
  h.current = fingerprint([], 'changed');
  h.emit('tools/change');
  assert.equal((await h.step()).kind, 'reject');
  fail = true;
  assert.equal((await h.command('cacheaccept')).kind, 'error');
  assert.equal(h.guard.blocked('s', selection), true);
  assert.equal(h.sends, 0);
});

test('failed acceptance can be retried after storage recovers without sending a model request', async t => {
  let fail = false;
  const h = await harness(t, { failWrite: () => fail });
  const next = fingerprint([], 'changed');
  h.current = next;
  h.emit('tools/change');
  assert.equal((await h.step()).kind, 'reject');
  fail = true;
  assert.equal((await h.command('cacheaccept')).kind, 'error');
  assert.equal(h.guard.blocked('s', selection), true);
  fail = false;
  assert.equal((await h.command('cacheaccept')).kind, 'success');
  assert.equal(h.guard.blocked('s', selection), false);
  assert.deepEqual(h.rows.get('s').fingerprint, next);
  assert.equal(h.sends, 0);
  assert.equal((await h.step()).kind, 'enter');
});

test('dirty header and system events cannot silently replace the accepted baseline', async t => {
  const h = await harness(t);
  const old = structuredClone(h.guard.records.s.fingerprint);
  h.current = fingerprint([], 'replacement system');
  h.emit('tools/change');
  h.agent.session.deriveMessages = () => [{ role: 'system', content: 'replacement system' }];
  h.emit('session/event', h.agent.session, { type: 'system/message' });
  h.agent.session.requestHeader = () => ({ config: selection, tools: [] });
  h.emit('session/event', h.agent.session, { type: 'request/header' });
  assert.deepEqual(h.guard.records.s.fingerprint, old);
  assert.equal((await h.step()).kind, 'reject');
  assert.deepEqual(h.guard.records.s.fingerprint, old);
  assert.equal(h.guard.records.s.pending.diff.system, true);
  assert.deepEqual(h.guard.records.s.pending.diff.removed, ['read', 'library']);
});

test('directory watcher detects atomic file replacement and survives later writes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-guard-watch-'));
  const path = join(dir, 'profile.json');
  await writeFile(path, '{}');
  let events = 0;
  const errors = [];
  const stop = watchPaths([path], () => { events++; }, error => errors.push(error));
  t.after(async () => { stop(); await rm(dir, { recursive: true, force: true }); });
  async function until(predicate) {
    for (let n = 0; n < 50; n++) { if (predicate()) return; await delay(10); }
    assert.fail('timed out waiting for watched file event');
  }
  await writeFile(join(dir, 'replacement.json'), '{"new":true}');
  await rename(join(dir, 'replacement.json'), path);
  await until(() => events > 0);
  await delay(20);
  const previous = events;
  await writeFile(path, '{"again":true}');
  await until(() => events > previous);
  assert.deepEqual(errors, []);
});
