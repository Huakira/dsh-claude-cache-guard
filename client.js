window.__ModuleLoader__.load({
  id: 'dsh-claude-cache-guard',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    function Dock({ ctx, useSession, useProjection }) {
      const session = useSession ? useSession(s => s) : null;
      const id = session?.sessionId;
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const active = React.useRef(id);
      const queued = React.useRef(false);
      const inflight = React.useRef(false);
      active.current = id;
      const boundary = useProjection ? useProjection('turnBoundary') : null;
      const key = boundary?.openTurnStartSeq === null && boundary.lastTurn > 0 ? boundary.lastTurn : null;
      function notify(level, text) {
        const actx = ctx.get('sessions')?.scope?.(id);
        actx?.get('conversation')?.input?.for?.(actx)?.notify?.(level, text);
      }
      function paused(text) {
        return text.includes('缓存保护已暂停') || text.includes('暂未放行');
      }
      async function run(command, showNotice = true) {
        if (!id) return;
        if (inflight.current) { queued.current = true; return; }
        inflight.current = id;
        setBusy(true);
        try {
          const result = await ctx.remote.commands.execute(id, command, []);
          if (active.current !== id) return;
          if (!result?.ok) throw new Error(result?.error?.message ?? '服务端未能执行缓存保护命令');
          const text = result.value?.result?.text ?? '';
          setMessage(text);
          if (text && (showNotice || paused(text))) notify(paused(text) ? 'error' : 'info', text);
        } catch (error) {
          if (active.current === id) notify('error', `缓存保护命令未完成：${error.message}`);
        } finally {
          if (inflight.current === id) inflight.current = false;
          if (active.current === id) setBusy(false);
          if (queued.current && active.current === id) {
            queued.current = false;
            void run('/cacheguard', false);
          }
        }
      }
      React.useEffect(() => {
        setMessage('');
        setBusy(false);
        queued.current = false;
        inflight.current = false;
      }, [id]);
      // Status on session open and at each completed turn. Queue if a read is already in flight.
      React.useEffect(() => {
        if (key != null) void run('/cacheguard', false);
      }, [id, key]);
      const pending = paused(message);
      return h('span', {
        style: { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12, maxWidth: 560, flexWrap: 'wrap' },
      },
        pending && h('span', { style: { color: '#b42318', fontWeight: 600, lineHeight: 1.4 } }, message),
        h('button', {
          type: 'button', disabled: busy || !id,
          title: '查看 Claude 缓存保护状态', onClick: () => run('/cacheguard'),
          style: { border: 'none', background: 'transparent', color: pending ? '#b42318' : 'inherit', cursor: 'pointer', fontWeight: pending ? 600 : 400 },
        }, pending ? '缓存变更待处理' : '缓存保护'),
        pending && h('button', {
          type: 'button', disabled: busy,
          title: '接受当前变更可能导致的缓存重建，不自动发送请求',
          onClick: () => run('/cacheaccept'),
          style: { font: 'inherit', cursor: 'pointer' },
        }, '接受本次变更'),
      );
    }
    return { inject: ['slots', 'locale', 'sessions', 'remote', 'remote.commands'], apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id: 'claude-cache-guard', order: 25,
      }, props => h(Dock, { ...props, ctx })));
    } };
  },
});
