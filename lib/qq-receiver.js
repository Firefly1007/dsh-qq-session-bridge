import { normalizeQQEvent, createQQAdmission } from './qq-input.js';
import { executeQQCommand } from './qq-commands.js';
import { findQQReference } from './qq-reference.js';

function validMessageId(id) {
  return /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id));
}

/** Wire authenticated OneBot events to their protected native QQ Session. */
export function createQQReceiver({ ctx, config, nap, sessions, bindings, prepareContent, onUser, onStop, signal }) {
  if (!ctx?.agents || typeof ctx.sessionController?.resolveAgent !== 'function'
    || typeof nap?.callAction !== 'function' || typeof nap?.sendAction !== 'function'
    || typeof sessions?.ensure !== 'function' || typeof bindings?.activate !== 'function'
    || typeof bindings?.getPromptBridge !== 'function' || typeof prepareContent !== 'function'
    || !signal || typeof signal.throwIfAborted !== 'function') throw new TypeError('QQ receiver dependencies are unavailable');
  const admission = createQQAdmission({ config });

  async function reference(input, self) {
    if (!input.replyId || !validMessageId(input.replyId)) return null;
    try {
      const message = await findQQReference(nap, input.channel, Number(input.replyId));
      if (!message) return null;
      const sender = String(message.sender?.user_id ?? message.user_id ?? '');
      if (!self || sender !== self || String(message.user_id) !== self) return null;
      const text = nap.extractText(message.message, message.raw_message);
      return { text: typeof text === 'string' && text.trim() ? text : '[引用内容不可用]' };
    } catch { return null; }
  }

  async function feedback(channel, text) {
    return nap.sendAction(channel.type === 'group' ? 'send_group_msg' : 'send_private_msg', {
      [channel.type === 'group' ? 'group_id' : 'user_id']: channel.id,
      message: [{ type: 'text', data: { text } }],
    }, { signal });
  }

  return {
    async handle(event) {
      signal.throwIfAborted();
      const self = String(nap.selfQQ || config.selfQQ || '');
      const input = normalizeQQEvent(event, self);
      if (!input) return { status: 'ignored' };
      const reply = await reference(input, self);
      signal.throwIfAborted();
      const admitted = admission.admit(input, { replyToBot: !!reply, selfQQ: self });
      if (!admitted.allowed) return { status: 'ignored', reason: admitted.reason };
      try {
        const binding = await sessions.ensure(input.key);
        signal.throwIfAborted();
        let agent = ctx.agents.get(binding.sessionId);
        if (!agent) agent = (await ctx.sessionController.resolveAgent(binding.sessionId))?.agent;
        if (!agent || !bindings.activate(agent, binding)) throw new Error('QQ 会话保护不可用');
        if (['/new', '/stop'].includes(admitted.command)) {
          if (admitted.command === '/stop') onStop?.(input.key, agent);
          const result = await executeQQCommand({ ctx, agent, command: admitted.command, signal });
          await feedback(input.channel, result.text);
          return { status: 'command', result };
        }
        const content = await prepareContent({ input, agent, reply, signal, feedback });
        signal.throwIfAborted();
        if (!Array.isArray(content) || !content.length) return { status: 'empty' };
        const prompt = bindings.getPromptBridge(agent);
        if (!prompt) throw new Error('QQ 输入保护不可用');
        const outcome = await prompt.prompt({ senderId: input.uid, mode: agent.status === 'running' ? 'steer' : 'queue', content }, signal);
        if (outcome.status === 'accepted') onUser?.(input, agent);
        else await feedback(input.channel, outcome.message);
        return { status: outcome.status, outcome };
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled' };
        await feedback(input.channel, 'QQ 会话暂时不可用，请稍后再试。');
        return { status: 'failed', error };
      }
    },
  };
}
