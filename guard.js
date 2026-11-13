import { createHash } from 'node:crypto';

// Object key order is irrelevant; array order (including tool order) is not.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]),
  );
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function protectedModel(selection, providers = []) {
  return /claude/i.test(selection?.model ?? '') &&
    (!providers.length || providers.includes(selection.provider));
}
export function fingerprint(tools, system) {
  return {
    tools: tools.map(t => ({ name: t.name, hash: hash(t) })),
    system: hash(system),
  };
}
export function difference(before, after) {
  const oldTools = new Map(before.tools.map(t => [t.name, t.hash]));
  const newTools = new Map(after.tools.map(t => [t.name, t.hash]));
  return {
    added: after.tools.filter(t => !oldTools.has(t.name)).map(t => t.name),
    removed: before.tools.filter(t => !newTools.has(t.name)).map(t => t.name),
    changed: after.tools.filter(t => oldTools.has(t.name) && oldTools.get(t.name) !== t.hash).map(t => t.name),
    reordered: hash(before.tools.map(t => t.name)) !== hash(after.tools.map(t => t.name)),
    system: before.system !== after.system,
  };
}
export function changed(diff) {
  return !!(diff.added.length || diff.removed.length || diff.changed.length || diff.reordered || diff.system);
}
export function describe(diff) {
  const parts = [];
  for (const [key, label] of [['removed', '移除工具'], ['added', '新增工具'], ['changed', '工具定义变更']]) {
    if (diff[key].length) parts.push(`${label} ${diff[key].length} 个：${diff[key].slice(0, 8).join('、')}${diff[key].length > 8 ? '…' : ''}`);
  }
  if (diff.reordered && !diff.added.length && !diff.removed.length) parts.push('工具顺序变化');
  if (diff.system) parts.push('固定系统指令变化');
  return parts.join('；');
}
export function baselineFromSession(session) {
  const header = session.requestHeader();
  if (!header || !protectedModel(header.config)) return undefined;
  const message = session.deriveMessages().findLast(m => m.role === 'system');
  if (message === undefined) return undefined;
  return {
    selection: { provider: header.config.provider, model: header.config.model },
    fingerprint: fingerprint(header.tools ?? [], message.content),
  };
}

// No per-request hash or history scan. Checks are scheduled by changes or resume.
export class CacheGuard {
  constructor({ inspect, save = () => {}, records = {}, providers = [] }) {
    this.inspect = inspect;
    this.save = save;
    this.records = records;
    this.providers = providers;
    this.epoch = 0;
    this.jobs = new Map();
    this.checks = 0;
  }
  remember(id, baseline) {
    if (!baseline || !protectedModel(baseline.selection, this.providers)) return;
    const old = this.records[id];
    // A changed request header is not user consent to consume the new prefix.
    if (old?.dirty || old?.pending) return;
    this.records[id] = { ...old, ...baseline, dirty: false };
    this.save(this.records);
  }
  dirty(reason) {
    this.epoch++;
    for (const entry of Object.values(this.records)) {
      entry.dirty = true;
      entry.reason = reason;
    }
    this.save(this.records);
  }
  async check(id, agent, signal, attempt = 0) {
    const record = this.records[id];
    if (!record?.dirty) return record;
    const existing = this.jobs.get(id);
    if (existing) { await existing; if (record.dirty) return this.check(id, agent, signal); return record; }
    const epoch = this.epoch;
    const job = (async () => {
      try {
        this.checks++;
        const current = await this.inspect(agent, signal);
        if (signal?.aborted || epoch !== this.epoch) return; // never approve cancelled work or clear a newer change
        const diff = difference(record.fingerprint, current);
        record.pending = changed(diff) ? { fingerprint: current, diff, epoch } : undefined;
        record.error = undefined;
        record.dirty = false;
      } catch (error) {
        // Cancellation must never become an approval or suppress a pending check.
        if (signal?.aborted) return;
        record.error = '变更后的工具或系统指令暂时无法读取';
      }
      this.save(this.records);
    })();
    this.jobs.set(id, job);
    try { await job; } finally { this.jobs.delete(id); }
    if (record.dirty && !record.error && !signal?.aborted) {
      if (attempt >= 2) {
        record.error = '定义仍在连续变化，请稍后重试核对';
        this.save(this.records);
      } else return this.check(id, agent, signal, attempt + 1);
    }
    return record;
  }
  blocked(id, selection) {
    if (!protectedModel(selection, this.providers)) return false;
    const record = this.records[id];
    return !!(record && (record.dirty || record.pending || record.error));
  }
  accept(id) {
    const record = this.records[id];
    if (!record || record.dirty || record.error) return false;
    if (record.pending) record.fingerprint = record.pending.fingerprint;
    delete record.pending;
    delete record.reason;
    this.save(this.records);
    return true;
  }
  status(id) {
    const r = this.records[id];
    if (!r) return '当前会话尚无需要保护的 Claude 请求基准。';
    if (r.error) return `${r.error}，暂未放行 Claude 请求。`;
    if (r.dirty) return '检测到配置变更，正在核对当前会话的工具和固定系统指令。';
    if (!r.pending) return 'Claude 缓存保护正常，无待处理的定义变更。';
    return `Claude 缓存保护已暂停：${describe(r.pending.diff)}。继续可能重新建立历史缓存。确认接受本次变更后执行 /cacheaccept；再发送“继续”恢复待处理内容。不会自动重放已完成的工具。`;
  }
}
