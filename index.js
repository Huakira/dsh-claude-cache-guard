import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { assembleContextFor } from '@deepseek-ai/dsh-agent';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { join } from 'node:path';
import { install } from './runtime.js';
import { fingerprint } from './guard.js';

export const name = 'claude-cache-guard';
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'commands', 'storageDomain', 'profileContext'];
export const Config = Schema.object({
  providers: Schema.array(Schema.string()).default([]).description('保护的 provider ID；空列表保护所有名称含 Claude 的模型，不代表确认其上游为 Magpie'),
  watchFiles: Schema.array(Schema.string()).default([]).description('额外监听的配置文件绝对路径；默认已监听当前 profile 的 manifest 与 patch'),
  debounceMs: Schema.number().min(50).max(3000).default(300).description('合并连续变更的等待毫秒数'),
});
const fp = z.object({ tools: z.array(z.object({ name: z.string(), hash: z.string() })), system: z.string() });
const diff = z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()), reordered: z.boolean(), system: z.boolean() });
const spec = defineDomain({ name: 'claude_cache_guard', version: 1, tables: {
  sessions: domainTable(z.object({
    selection: z.object({ provider: z.string(), model: z.string() }), fingerprint: fp,
    dirty: z.boolean(), reason: z.string().optional(), error: z.string().optional(),
    pending: z.object({ fingerprint: fp, diff, epoch: z.number() }).optional(),
  })),
} });
const field = (config, key) => typeof config?.[key]?.get === 'function' ? config[key].get() : config?.[key];
export async function apply(ctx, config = {}) {
  const paths = [join(ctx.profileContext.dir, 'package.json'), ctx.profileContext.patchPath,
    ...(field(config, 'watchFiles') ?? [])].filter(Boolean);
  const ready = install(ctx, {
    providers: field(config, 'providers') ?? [],
    debounceMs: field(config, 'debounceMs') ?? 300,
    watchFiles: [...new Set(paths)],
  }, {
    openStore: async () => {
      const domain = await ctx.storageDomain.open(spec);
      const table = domain.table('sessions');
      return { entries: () => table.entries(), put: (id, value) => table.put(id, value), close: () => domain.close() };
    },
    inspect: async (agent, requestedSignal) => {
      const signal = requestedSignal ?? new AbortController().signal;
      const modelSelection = agent.model.current();
      const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal });
      try {
        const assembly = await ctx.systemPrompt.assemble({ ...assembleContextFor(agent, signal), modelSelection, toolSet });
        signal.throwIfAborted();
        return fingerprint(assembly.tools, renderPrompt(assembly));
      } finally { toolSet.dispose(); }
    },
  });
  // Close the initialization race without pretending a not-yet-loaded guard is ready.
  ctx.on('agent/pre-step', async (_payload, next) => { await ready; return next(); });
  await ready;
}
