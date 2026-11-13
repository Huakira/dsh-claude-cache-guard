import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';
import * as plugin from '../index.js';

// This suite starts no network listener and never uses the running DSH profile.
const sdk = createRequire(process.env.DSH_SDK_PACKAGE ?? import.meta.url);
const { Context } = await import(sdk.resolve('@deepseek-ai/cordis'));
const storage = await import(sdk.resolve('@deepseek-ai/dsh-storage'));
const storageJson = await import(sdk.resolve('@deepseek-ai/dsh-storage-json'));
const storageDomain = await import(sdk.resolve('@deepseek-ai/dsh-storage-domain'));

test('actual Cordis config validation, JSON domain persistence, command registration and disposal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-guard-sdk-'));
  const profile = join(dir, 'profile');
  await mkdir(profile);
  await writeFile(join(profile, 'package.json'), '{}');
  await writeFile(join(profile, 'cordis.patch.yml'), '[]');
  const root = new Context();
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  async function load(module, config) {
    const fiber = root.plugin(module, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  }
  await load(storage.default);
  await load(storageJson, { root: join(dir, 'storage') });
  await load(storageDomain, { backend: 'json' });
  const commands = new Map();
  const selection = { provider: 'relay', model: 'claude-opus-5-5' };
  const schemas = [{ name: 'read', parameters: { type: 'object' } }];
  let actualTools = schemas;
  let inspections = 0, nextCalls = 0, disposeCount = 0;
  const queued = [];
  const agent = {
    id: 'sdk-session', model: { current: () => selection },
    session: {
      id: 'sdk-session', requestHeader: () => ({ config: selection, tools: schemas }),
      deriveMessages: () => [{ role: 'system', content: 'fixed' }],
    },
    inbox: { splice(target, offset, count, messages) { assert.equal(target, 'next-step'); queued.splice(offset, count, ...messages); } },
  };
  await load({ name: 'cache-guard-sdk-stubs', apply(ctx) {
    ctx.provide('agents', { list: () => [agent] });
    ctx.provide('sessions', { list: () => [agent.session], get: () => agent.session });
    ctx.provide('profileContext', { name: 'sdk', home: dir, dir: profile, patchPath: join(profile, 'cordis.patch.yml') });
    ctx.provide('commands', { register(command) { commands.set(command.name, command); return () => commands.delete(command.name); } });
    ctx.provide('tools', { resolve: async () => ({ dispose() { disposeCount++; } }) });
    ctx.provide('systemPrompt', { assemble: async context => {
      assert.equal(context.scope, agent);
      assert.equal(context.agent, agent);
      assert.deepEqual(context.modelSelection, selection);
      assert.ok(context.toolSet);
      inspections++;
      return { sections: [{ name: 'fixed', text: 'fixed' }], contexts: [], variables: {}, tools: actualTools };
    } });
  } });
  const live = await load(plugin, { debounceMs: 50, providers: ['relay'] });
  await tick();
  assert.deepEqual([...commands.keys()].sort(), ['cacheaccept', 'cacheguard']);
  const domain = root.storageDomain.get('claude_cache_guard');
  assert.ok(domain, 'real domain facility accepted the declared schemas and name');
  const signal = new AbortController().signal;
  const step = messages => root.waterfall('agent/pre-step', { agent, messages, modelSelection: selection, signal, turn: 1, step: 1 }, async () => {
    nextCalls++;
    return { kind: 'enter', messages };
  });
  assert.equal((await step([])).kind, 'enter');
  const inspectedBefore = inspections;
  for (let n = 0; n < 20; n++) await step([]);
  assert.equal(inspections, inspectedBefore, 'actual event dispatch keeps clean requests free of inspection');
  actualTools = [];
  root.emit('tools/change');
  const message = { id: 'retained', content: [{ type: 'text', text: 'do not lose me' }] };
  assert.equal((await step([message])).kind, 'reject');
  assert.equal(queued[0], message);
  const state = domain.table('sessions').get('sdk-session');
  assert.equal(state.pending.diff.removed[0], 'read');
  const beforeCommand = nextCalls;
  const accepted = await commands.get('cacheaccept').handler({ agent, signal, rawInput: '' });
  assert.equal(accepted.kind, 'success');
  assert.equal(nextCalls, beforeCommand, 'accept does not call the model dispatcher');
  assert.equal((await step([])).kind, 'enter');
  assert.equal(inspections, disposeCount, 'all SDK inspection tool sets were released');
  await live.dispose();
  assert.equal(root.storageDomain.get('claude_cache_guard'), undefined, 'plugin disposal closes the storage domain');
});
