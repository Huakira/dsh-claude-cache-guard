import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const normal = 'Claude 缓存保护正常，无待处理的定义变更。';
const pending = 'Claude 缓存保护已暂停：移除工具 1 个：library。继续可能重新建立历史缓存。';
const result = text => ({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text } } });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness(execute = async () => result(normal)) {
  const states = [], refs = [], effects = [], dependencies = [];
  let cursor = 0, needsRender = false, tree, renderSlot, module;
  let id = 's1', boundary = { openTurnStartSeq: 10, lastTurn: 1 };
  const calls = [], notices = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [states[i], value => {
        const next = typeof value === 'function' ? value(states[i]) : value;
        if (!Object.is(states[i], next)) { states[i] = next; needsRender = true; }
      }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const before = dependencies[i];
      if (!before || deps.some((value, index) => !Object.is(value, before[index]))) {
        dependencies[i] = deps;
        effects.push(fn);
      }
    },
  };
  const ctx = {
    slots: {
      inject(_slot, fn) { fn(); },
      register(_descriptor, renderer) { renderSlot = renderer; return () => {}; },
    },
    remote: { commands: { execute: async (...args) => { calls.push(args); return execute(...args); } } },
    get(name) {
      if (name !== 'sessions') return undefined;
      return { scope: sessionId => ({ get: key => key === 'conversation' ? { input: { for: () => ({ notify: (level, text) => notices.push({ id: sessionId, level, text }) }) } } : undefined }) };
    },
  };
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(entry) { module = entry.factory(name => {
    assert.equal(name, 'react');
    return React;
  }); } } } });
  module.apply(ctx);
  function render() {
    needsRender = false;
    cursor = 0;
    const snapshot = { sessionId: id, running: boundary.openTurnStartSeq !== null };
    Object.defineProperty(snapshot, 'events', { get() { assert.fail('SessionSnapshot has no events field'); } });
    const element = renderSlot({
      useSession: selector => selector(snapshot),
      useProjection: key => { assert.equal(key, 'turnBoundary'); return boundary; },
    });
    tree = element.type(element.props);
    for (const effect of effects.splice(0)) effect();
  }
  async function flush() {
    for (let n = 0; n < 5; n++) {
      if (needsRender) render();
      await tick();
    }
    if (needsRender) render();
  }
  function buttons(node = tree) {
    if (!node || typeof node !== 'object') return [];
    const own = node.type === 'button' ? [node] : [];
    return own.concat((node.props?.children ?? []).flatMap(child => Array.isArray(child) ? child.flatMap(item => buttons(item)) : buttons(child)));
  }
  render();
  return {
    calls, notices, flush, buttons,
    update(nextId, nextBoundary) { id = nextId; boundary = nextBoundary; render(); },
    close(turn = 1) { boundary = { openTurnStartSeq: null, lastTurn: turn }; render(); },
  };
}

test('public projection closure triggers one status read without reading snapshot.events', async () => {
  const h = harness();
  await h.flush();
  assert.equal(h.calls.length, 0, 'an open turn is not a completion');
  h.close();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 's1');
  assert.equal(h.calls[0][1], '/cacheguard');
  assert.equal(h.calls[0][2].length, 0);
  h.close();
  await h.flush();
  assert.equal(h.calls.length, 1, 'rerenders at the same boundary must not query again');
  assert.deepEqual(h.notices, [], 'normal automatic checks stay silent');
});

test('ok/value/result envelope produces pending notice and an accept control', async () => {
  const h = harness(async (_id, command) => result(command === '/cacheaccept' ? '已接受当前定义变更。尚未发送模型请求。' : pending));
  h.close();
  await h.flush();
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].level, 'error');
  assert.equal(h.notices[0].text, pending);
  const buttons = h.buttons();
  assert.equal(buttons[0].props.children[0], '缓存变更待处理');
  const accept = buttons.find(button => button.props.children.includes('接受本次变更'));
  assert.ok(accept, 'pending business result renders an explicit accept button');
  accept.props.onClick();
  await h.flush();
  assert.equal(h.calls.at(-1)[1], '/cacheaccept');
  assert.equal(h.buttons().length, 1, 'acceptance clears the pending control');
  assert.equal(h.calls.filter(call => call[1] !== '/cacheguard' && call[1] !== '/cacheaccept').length, 0);
});

test('remote failure envelope surfaces an actionable notice instead of silently empty text', async () => {
  const h = harness(async () => ({ ok: false, error: { message: 'service unavailable' } }));
  h.close();
  await h.flush();
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].text, /service unavailable/);
});

test('a late response for the old session cannot change or notify the newly selected session', async () => {
  const old = deferred();
  const h = harness(async sessionId => sessionId === 's1' ? old.promise : result(normal));
  h.close();
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.update('s2', { openTurnStartSeq: 20, lastTurn: 2 });
  await h.flush();
  old.resolve(result(pending));
  await h.flush();
  assert.deepEqual(h.notices, []);
  assert.equal(h.buttons()[0].props.children[0], '缓存保护');
  assert.equal(h.buttons().length, 1);
  h.close(2);
  await h.flush();
  assert.equal(h.calls.at(-1)[0], 's2');
  assert.equal(h.calls.at(-1)[1], '/cacheguard');
  assert.deepEqual(h.notices, []);
});

test('a second completed turn while a status read is in flight is queued, not dropped', async () => {
  const first = deferred();
  let n = 0;
  const h = harness(async () => {
    n += 1;
    return n === 1 ? first.promise : result(pending);
  });
  h.close(1);
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.close(2);
  await h.flush();
  assert.equal(h.calls.length, 1, 'in-flight read is not started twice');
  first.resolve(result(normal));
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1][1], '/cacheguard');
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].level, 'error');
});
