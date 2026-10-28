import { findQQReference } from './qq-reference.js';

export const QQ_TEXT_TOOL = 'qq_send_text';
const REPLY_FAILURE = '引用失败，请勿反复尝试引用，可选择不引用发送。';

function result(status, code, message, messageId) {
  return { status, ...(code ? { code } : {}), message, ...(Number.isSafeInteger(messageId) ? { messageId } : {}) };
}

export function createQQSendQueue({ agent, authorization }) {
  if (!agent || typeof authorization?.captureSendPermit !== 'function' || typeof authorization.canSend !== 'function') {
    throw new TypeError('QQ send queue authorization is unavailable');
  }
  let queue = Promise.resolve();
  let stopped = false;
  return {
    enqueue(execution, dispatch) {
      if (execution?.agent !== agent) return Promise.resolve(result('failed', 'WRONG_AGENT', '只有绑定的 QQ 主 Agent 可以发送。'));
      let permit;
      try { permit = authorization.captureSendPermit(); }
      catch { return Promise.resolve(result('failed', 'NOT_AUTHORIZED', '当前轮次的 QQ 发送授权不可用。')); }
      const canDispatch = () => {
        if (stopped || execution.signal?.aborted || permit === null || permit === undefined) return false;
        try { return authorization.canSend(permit); } catch { return false; }
      };
      const send = queue.then(async () => {
        if (stopped || execution.signal?.aborted) return result('failed', 'SEND_CANCELLED', 'QQ 发送已在派发前取消。');
        if (!canDispatch()) return result('failed', 'NOT_AUTHORIZED', '当前 QQ 轮次或步骤已结束，未发送。');
        try { return await dispatch(canDispatch); }
        catch { return result('unknown', 'SEND_RESULT_UNKNOWN', 'QQ 发送状态未知，可能已送达；未自动重发。'); }
      });
      queue = send.catch(() => {});
      return send;
    },
    stop() { stopped = true; },
  };
}

export function registerQQTextTool({ agent, sendQueue, nap, channel }) {
  if (!agent?.ctx?.tools || typeof agent.ctx.tools.register !== 'function'
    || typeof sendQueue?.enqueue !== 'function' || typeof nap?.sendAction !== 'function') {
    throw new TypeError('QQ text tool dependencies are unavailable');
  }
  if (!channel || !['private', 'group'].includes(channel.type)
    || typeof channel.id !== 'string' || !/^[1-9]\d*$/.test(channel.id)) throw new TypeError('A fixed QQ channel is required');
  const target = { type: channel.type, id: channel.id };
  let disposed = false;
  const unregister = agent.ctx.tools.register({
    name: QQ_TEXT_TOOL,
    description: '向当前 QQ 会话发送文字，目标固定。可选 replyMessageId 引用当前会话的一条消息；不提供时普通发送。引用失败时请勿反复尝试，可选择不引用发送。状态未知时可能已送达，不会自动重发。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1 },
        replyMessageId: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['sent', 'failed', 'unknown'] },
          code: { type: 'string' }, message: { type: 'string' }, messageId: { type: 'integer' },
        },
        required: ['status', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, execution) {
      if (execution?.agent !== agent) return Promise.resolve(result('failed', 'WRONG_AGENT', '只有绑定的 QQ 主 Agent 可以发送。'));
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['text', 'replyMessageId'].includes(key))
        || !Object.hasOwn(args, 'text') || typeof args.text !== 'string' || !args.text.trim()) {
        return Promise.resolve(result('failed', 'INVALID_TEXT', '仅接受非空文字 text 和可选 replyMessageId，不能指定或修改发送目标。'));
      }
      const text = args.text;
      const hasReply = Object.hasOwn(args, 'replyMessageId');
      const replyMessageId = args.replyMessageId;
      if (hasReply && !Number.isSafeInteger(replyMessageId)) {
        return Promise.resolve(result('failed', 'INVALID_REPLY', `引用消息 ID 必须是安全整数。${REPLY_FAILURE}`));
      }
      return sendQueue.enqueue(execution, async canDispatch => {
        if (disposed || execution.signal?.aborted) return result('failed', 'SEND_CANCELLED', '文字发送已在派发前取消。');
        const message = [{ type: 'text', data: { text } }];
        if (hasReply) {
          let reference;
          try { reference = await findQQReference(nap, target, replyMessageId); }
          catch { return result('failed', 'REPLY_LOOKUP_FAILED', `未能查询并核实该消息。${REPLY_FAILURE}`); }
          if (!reference) {
            return result('failed', 'REPLY_NOT_IN_CHANNEL', `无法确认被引用消息属于当前 QQ 会话。${REPLY_FAILURE}`);
          }
          message.unshift({ type: 'reply', data: { id: String(replyMessageId) } });
        }
        if (disposed || execution.signal?.aborted) return result('failed', 'SEND_CANCELLED', '文字发送已在派发前取消。');
        if (!canDispatch()) return result('failed', 'NOT_AUTHORIZED', '当前 QQ 轮次或步骤已结束，未发送文字。');
        const response = await nap.sendAction(target.type === 'group' ? 'send_group_msg' : 'send_private_msg', {
          [target.type === 'group' ? 'group_id' : 'user_id']: target.id,
          message,
        }, { signal: execution.signal });
        if (response?.status === 'sent') return result('sent', undefined, 'QQ 文字已发送。', response.messageId);
        if (response?.status === 'failed') return result('failed', response.code || 'SEND_FAILED', `QQ 文字发送失败：${response.message || '具体原因未确认。'}${hasReply ? ` ${REPLY_FAILURE}` : ''}`);
        return result('unknown', response?.code || 'SEND_RESULT_UNKNOWN', `QQ 文字发送状态未知，可能已送达；未自动重发。${response?.message || ''}`);
      });
    },
  });
  return () => { disposed = true; unregister(); };
}

