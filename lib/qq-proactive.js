import { createProactive } from './proactive.js';

export const QQ_PROACTIVE_PROMPT = '[QQ主动发言] 现在可以根据当前会话上下文主动说一句话；如果没有合适内容，可以保持沉默。';

/** Reuse the existing idle scheduler while native Sessions own generation and sending. */
export function createQQProactive({ config, bindings, log }) {
  const agents = new Map();
  const pending = new Map();
  let stopped = false;
  const proactive = createProactive({ config, log,
    getRule(meta) {
      if (meta.channel?.type !== 'group') return null;
      const groups = String(config.proactiveGroups || '').split(/[\s,，]+/).filter(Boolean);
      return { proactiveEnabled: groups.includes(meta.channel.id) };
    },
    isBusy(key) {
      const agent = agents.get(key);
      return !agent || agent.status !== 'idle' || pending.has(key);
    },
    async onFire(meta) {
      if (stopped) return false;
      const agent = agents.get(meta.sessionKey);
      const bridge = agent && bindings.getPromptBridge(agent);
      if (!agent || agent.status !== 'idle' || !bridge || pending.has(meta.sessionKey)) return false;
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      const item = { agent, finish, messageId: '', completed: [] };
      pending.set(meta.sessionKey, item);
      try {
        const result = await bridge.proactive({ mode: 'queue', content: [{ type: 'text', text: QQ_PROACTIVE_PROMPT }] });
        if (result.status !== 'accepted') {
          if (result.status === 'unknown') {
            proactive.cancel(meta.sessionKey, '主动消息入队状态未知，等待新的用户消息');
            try { log?.warn?.('[napcat] 主动发言入队状态未知，未自动重试'); } catch { /* ignore */ }
          }
          return false;
        }
        item.messageId = result.messageId;
        const alreadyFinished = item.completed.find(event => event.messageIds?.has(item.messageId));
        if (alreadyFinished) item.finish(!!alreadyFinished.sent);
        return await completed;
      } finally { if (pending.get(meta.sessionKey) === item) pending.delete(meta.sessionKey); }
    },
  });
  return {
    noteUser(input, agent) {
      if (stopped) return;
      agents.set(input.key, agent);
      proactive.noteUser({ sessionKey: input.key, channel: input.channel, text: input.text });
    },
    onTurnFinished(event) {
      if (stopped) return;
      const { key, agent, sent } = event;
      if (sent) proactive.noteBot(key);
      const item = pending.get(key);
      if (item?.agent === agent) {
        if (item.messageId && event.messageIds?.has(item.messageId)) item.finish(!!sent);
        else if (!item.messageId) item.completed.push(event);
      }
    },
    stopAll() {
      stopped = true;
      for (const item of pending.values()) item.finish(false);
      pending.clear(); agents.clear(); proactive.stopAll();
    },
    status: proactive.status,
    check: proactive.check,
    setRng: proactive.setRng,
    setNow: proactive.setNow,
  };
}
