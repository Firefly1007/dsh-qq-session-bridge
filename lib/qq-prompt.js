import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

function matchesContent(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((part, index) => {
    const admitted = actual[index];
    if (admitted?.type !== part.type) return false;
    if (part.type === 'text') return admitted.text === part.text;
    if (part.type === 'file') return isDeepStrictEqual(admitted.attachment, part.attachment);
    return admitted.attachment && typeof admitted.attachment.attachmentId === 'string' && admitted.attachment.attachmentId.length > 0;
  });
}

export function createQQPromptBridge({ ctx, agent, authorization }) {
  if (typeof ctx?.sessionController?.prompt !== 'function' || typeof agent?.ctx?.on !== 'function'
    || typeof authorization?.admit !== 'function' || typeof authorization.admitProactive !== 'function'
    || typeof authorization.invalidate !== 'function') {
    throw new TypeError('QQ native prompt dependencies are unavailable');
  }
  const tickets = new Map();
  const inflight = new Set();
  let disposed = false;
  function invalidate(ticket) {
    if (!ticket.messageId) return;
    try { authorization.invalidate(ticket.messageId); ticket.authorized = false; }
    catch { ticket.authorizationError = '已观察到入队，但 QQ 来源权限撤销失败，状态未知。'; }
  }
  const stopInserted = agent.ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
    if (subject !== agent || disposed) return;
    const ticket = tickets.get(message?.source?.rpcId);
    if (!ticket || ticket.cancelled || ticket.signal.aborted) return;
    tickets.delete(ticket.requestId);
    ticket.inserted = true;
    if (typeof message?.id === 'string' && message.id) ticket.messageId = message.id;
    if (message?.role !== 'user' || message.source.kind !== 'user' || !ticket.messageId
      || !matchesContent(message.content, ticket.expected)) {
      ticket.authorizationError = '入队消息的文本或来源不匹配，未授予 QQ 来源权限。';
      return;
    }
    if (ticket.origin === 'proactive' && (agent.status !== 'idle'
      || agent.inbox.nextStep.length !== 0 || agent.inbox.nextTurn.length !== 1
      || agent.inbox.nextTurn[0]?.id !== message.id)) {
      ticket.skipped = agent.inbox.remove(message.id) === true;
      if (!ticket.skipped) ticket.authorizationError = '主动发言入队时会话已繁忙，无法确认已撤销。';
      return;
    }
    try {
      if (ticket.origin === 'qq') authorization.admit(message, ticket.senderId, { allowDelegation: ticket.textOnly });
      else if (ticket.origin === 'proactive') authorization.admitProactive(message);
      else authorization.admitReminder(message);
      ticket.authorized = true;
      if (ticket.cancelled || ticket.signal.aborted || disposed) invalidate(ticket);
    } catch {
      ticket.authorizationError = '已观察到原生入队，但 QQ 来源登记失败。';
      invalidate(ticket);
    }
  });

  async function submit(origin, request, signal = new AbortController().signal) {
    const requestId = randomUUID();
    const ticket = { requestId, origin, signal, inserted: false, authorized: false, cancelled: false };
    const outcome = (status, code, message) => ({
      status, requestId, inserted: ticket.inserted, authorized: ticket.authorized,
      ...(ticket.messageId ? { messageId: ticket.messageId } : {}),
      ...(code ? { code } : {}), message,
    });
    if (disposed) return outcome('failed', 'PROMPT_DISPOSED', 'QQ 输入桥已停止。');
    if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function' || typeof signal.throwIfAborted !== 'function') {
      return outcome('failed', 'INVALID_SIGNAL', '原生输入需要有效的取消信号。');
    }
    if (signal.aborted) return outcome('failed', 'PROMPT_CANCELLED', 'QQ 输入已在提交前取消。');
    if (origin === 'reminder' && typeof authorization.admitReminder !== 'function') {
      return outcome('failed', 'REMINDER_UNAVAILABLE', 'QQ 提醒授权不可用。');
    }
    if (origin === 'proactive' && (agent.status !== 'idle' || !Array.isArray(agent.inbox?.nextTurn)
      || !Array.isArray(agent.inbox?.nextStep) || typeof agent.inbox?.remove !== 'function'
      || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)) {
      return outcome('skipped', 'QQ_AGENT_BUSY', '会话忙碌，跳过本次主动发言。');
    }
    if (!request || !['queue', 'steer'].includes(request.mode) || !Array.isArray(request.content)
      || !request.content.length || request.content.some(part => !part || !['text', 'image', 'file'].includes(part.type)
        || (part.type === 'text' && typeof part.text !== 'string'))) {
      return outcome('failed', 'INVALID_PROMPT', '需要有效的原生 prompt 内容和 queue/steer 模式。');
    }
    if (origin === 'qq' && (typeof request.senderId !== 'string' || !/^[1-9]\d*$/.test(request.senderId))) {
      return outcome('failed', 'INVALID_SENDER', '需要来自可信 QQ 事件的发送者号码。');
    }
    try { ticket.content = structuredClone(request.content); }
    catch { return outcome('failed', 'INVALID_PROMPT', '无法固定待提交的原生 prompt 内容。'); }
    try {
      ticket.expected = ticket.content.map(part => {
        if (part.type === 'text') return { type: part.type, text: part.text };
        if (part.type === 'file') {
          const attachment = ctx.fileUploads?.resolve(agent, part.receiptId);
          if (!attachment || typeof attachment.attachmentId !== 'string' || !attachment.attachmentId) throw new Error();
          return { type: 'file', attachment: structuredClone(attachment) };
        }
        return { type: part.type };
      });
    } catch { return outcome('failed', 'FILE_RECEIPT_UNAVAILABLE', '无法核实 QQ 文件归属，未提交原生输入。'); }
    // shortcut: normalized attachments cannot yet be matched to the submitted bytes, upgrade when their provenance is verifiable.
    ticket.textOnly = ticket.content.every(part => part.type === 'text');
    ticket.senderId = request.senderId;
    const abort = () => { ticket.cancelled = true; tickets.delete(requestId); invalidate(ticket); };
    ticket.abort = abort;
    tickets.set(requestId, ticket);
    inflight.add(ticket);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await ctx.sessionController.prompt({
        sessionId: agent.id, requestId, mode: request.mode, content: ticket.content,
      }, signal);
      if (ticket.inserted) {
        if (ticket.skipped) return outcome('skipped', 'QQ_AGENT_BUSY', '会话在入队时变忙，已撤销本次主动发言。');
        if (ticket.authorizationError) return outcome('unknown', 'PROMPT_AUTHORIZATION_FAILED', ticket.authorizationError);
        if (ticket.cancelled || signal.aborted || disposed || response?.accepted !== true) {
          return outcome('unknown', 'PROMPT_RESULT_UNKNOWN', '已观察到原生入队，但最终提交状态未知；未自动重发。');
        }
        return outcome('accepted', undefined, 'QQ 输入已通过原生会话入队并登记可信来源。');
      }
      if (ticket.cancelled || signal.aborted || disposed) return outcome('unknown', 'PROMPT_CANCELLED', '原生调用开始后已取消，实际入队状态未知；迟到入队不会获得 QQ 来源权限，未自动重发。');
      return outcome('unknown', 'PROMPT_ADMISSION_UNCONFIRMED', '未观察到匹配的原生入队，未授予 QQ 来源权限；未自动重发。');
    } catch {
      if (ticket.inserted) return outcome('unknown', 'PROMPT_RESULT_UNKNOWN', '原生调用在入队后失败，提交状态未知；未自动重发。');
      return outcome('unknown', ticket.cancelled || signal.aborted || disposed ? 'PROMPT_CANCELLED' : 'PROMPT_RESULT_UNKNOWN',
        '原生输入调用未能确认入队结果；未授予 QQ 来源权限，未自动重发。');
    } finally {
      tickets.delete(requestId);
      inflight.delete(ticket);
      signal.removeEventListener('abort', abort);
    }
  }

  return {
    prompt(request, signal) { return submit('qq', request, signal); },
    proactive(request, signal) { return submit('proactive', request, signal); },
    remind(request, signal) { return submit('reminder', request, signal); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const ticket of inflight) {
        ticket.cancelled = true;
        invalidate(ticket);
        ticket.signal.removeEventListener('abort', ticket.abort);
      }
      tickets.clear();
      stopInserted();
    },
  };
}
