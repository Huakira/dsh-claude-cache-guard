import { watch } from 'node:fs';
import { dirname, basename } from 'node:path';
import { CacheGuard, baselineFromSession, protectedModel, canonical } from './guard.js';

// Isolated from SDK imports so the same host wiring can be integration tested.
export async function install(ctx, config, { openStore, inspect, watchFiles = watchPaths }) {
  const providers = config.providers ?? [];
  const store = await openStore();
  const records = structuredClone(Object.fromEntries(store.entries()));
  let writes = Promise.resolve();
  let storageError;
  const persisted = new Map(Object.entries(records).map(([id, value]) => [id, JSON.stringify(canonical(value))]));
  const guard = new CacheGuard({ records, providers, inspect, save(all) {
    const snapshot = canonical(all);
    writes = writes.then(async () => {
      for (const [id, value] of Object.entries(snapshot)) {
        const encoded = JSON.stringify(value);
        if (persisted.get(id) === encoded) continue;
        await store.put(id, value);
        persisted.set(id, encoded);
      }
      storageError = undefined;
    }).catch(error => { storageError = error; ctx.logger?.warn('缓存保护状态未能持久化：%s', error.message); });
  } });
  const flush = async () => { await writes; if (storageError) throw storageError; };
  let disposed = false;
  const lifetime = new AbortController();
  let timer;
  let inspecting = Promise.resolve();
  const agents = () => ctx.agents.list();
  const notice = reason => {
    if (disposed) return;
    guard.dirty(reason);
    clearTimeout(timer);
    timer = setTimeout(() => {
      inspecting = Promise.all(agents().map(agent => guard.check(agent.session.id, agent, lifetime.signal)))
        .catch(error => ctx.logger?.warn('缓存保护核对失败：%s', error.message));
    }, config.debounceMs ?? 300);
    timer.unref?.();
  };
  const attach = agent => {
    const id = agent.session.id;
    if (!guard.records[id]) guard.remember(id, baselineFromSession(agent.session));
    // An unloaded session may have missed any number of changes.
    if (guard.records[id]) {
      guard.records[id].dirty = true;
      void guard.check(id, agent, lifetime.signal).catch(error => ctx.logger?.warn('缓存保护恢复失败：%s', error.message));
    }
  };
  // Reconcile saved hashes once on startup, never assume restarting accepted a change.
  guard.dirty('启动后的定义核对');
  ctx.on('tools/change', () => notice('工具注册或限制变化'));
  ctx.on('system-prompt/change', () => notice('系统指令注册变化'));
  ctx.on('plugin-manager/changed', () => notice('插件管理操作完成'));
  ctx.on('hmr/reload', () => notice('插件热重载'));
  ctx.on('hmr/change', () => notice('受监控配置文件变化'));
  ctx.on('agent/created', ({ agent }) => attach(agent));
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'request/header' && event.type !== 'system/message') return;
    guard.remember(session.id, baselineFromSession(session));
  });
  for (const agent of agents()) attach(agent);
  const stopWatching = watchFiles(config.watchFiles ?? [], () => notice('相关配置文件变化'),
    error => ctx.logger?.warn('缓存保护文件监听失败：%s', error.message));
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, signal, messages, modelSelection } = payload;
    if (!protectedModel(modelSelection, providers)) return next();
    const id = agent.session.id;
    // Only event-dirtied or newly resumed sessions invoke inspection.
    if (guard.records[id]?.dirty) await guard.check(id, agent, signal);
    signal.throwIfAborted();
    if (!guard.blocked(id, modelSelection) && !storageError) return next();
    // Claimed input is not restored by a rejected pre-step. Park durably, do not wake.
    if (messages.length) agent.inbox.splice('next-step', 0, 0, messages);
    await flush();
    return { kind: 'reject' };
  });
  ctx.commands.register({ name: 'cacheguard', description: '查看当前会话 Claude 缓存保护状态', handler: async ({ agent, signal }) => {
    await guard.check(agent.session.id, agent, signal);
    return { kind: 'success', text: guard.status(agent.session.id) };
  } });
  ctx.commands.register({ name: 'cacheaccept', description: '接受当前定义变更可能带来的缓存重建，不自动发送模型请求', handler: async ({ agent, signal }) => {
    const id = agent.session.id;
    await guard.check(id, agent, signal);
    signal.throwIfAborted();
    const previous = structuredClone(guard.records[id]);
    if (!guard.accept(id)) return { kind: 'error', text: guard.status(id) };
    try { await flush(); }
    catch (error) {
      guard.records[id] = previous;
      return { kind: 'error', text: '接受记录保存失败，保护仍保留。请重试 /cacheaccept。' };
    }
    return { kind: 'success', text: '已接受当前定义变更。尚未发送模型请求；发送“继续”即可处理保留的待处理消息，无需重发原文。' };
  } });
  ctx.effect(() => async () => {
    disposed = true;
    lifetime.abort();
    clearTimeout(timer);
    stopWatching();
    await inspecting;
    await Promise.allSettled([...guard.jobs.values()]);
    await writes;
    await store.close();
  });
  return { guard, flush };
}

// Parent-directory watches survive atomic rename and recreation. No recursion, polling,
// source-tree scans, package lock files, or writes into the watched configuration.
export function watchPaths(paths, onChange, onError) {
  const groups = new Map();
  for (const path of paths) {
    const dir = dirname(path);
    if (!groups.has(dir)) groups.set(dir, new Set());
    groups.get(dir).add(basename(path));
  }
  const handles = [];
  for (const [dir, files] of groups) {
    try {
      const handle = watch(dir, (event, filename) => {
        if (!filename || files.has(String(filename))) onChange();
      });
      handle.on('error', onError);
      handles.push(handle);
    } catch (error) { onError(error); }
  }
  return () => handles.forEach(handle => handle.close());
}
