import { requestVolcengineTts } from './tts-volcengine.js';

export const QQ_VOICE_TOOL = 'qq_send_voice';

function result(status, code, message, messageId) {
  return { status, ...(code ? { code } : {}), message,
    ...(Number.isSafeInteger(messageId) ? { messageId } : {}) };
}

function textTooLong(error) {
  return error?.code === 40402003 || error?.code === '40402003'
    || (typeof error?.message === 'string' && /\bAPI error code=40402003\b/.test(error.message));
}

export function registerQQVoiceTool({ agent, sendQueue, nap, channel, config = {}, synthesize = requestVolcengineTts }) {
  if (!agent?.ctx?.tools || typeof agent.ctx.tools.register !== 'function'
    || typeof sendQueue?.enqueue !== 'function' || typeof nap?.sendAction !== 'function'
    || !config || typeof config !== 'object' || typeof synthesize !== 'function') {
    throw new TypeError('QQ voice tool dependencies are unavailable');
  }
  if (!channel || !['private', 'group'].includes(channel.type)
    || typeof channel.id !== 'string' || !/^[1-9]\d*$/.test(channel.id)) throw new TypeError('A fixed QQ channel is required');
  const target = { type: channel.type, id: channel.id };
  const action = target.type === 'group' ? 'send_group_msg' : 'send_private_msg';
  const targetKey = target.type === 'group' ? 'group_id' : 'user_id';
  const active = new Set();
  let disposed = false;
  const unregister = agent.ctx.tools.register({
    name: QQ_VOICE_TOOL,
    description: '将 text 用设置中的固定豆包音色合成语音并发送当前 QQ 会话。只提供 text，不能选择音色或目标。状态未知时可能已送达，不会自动补发或重试。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1 } }, required: ['text'],
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
      if (execution?.agent !== agent) return Promise.resolve(result('failed', 'WRONG_AGENT', '只有绑定的 QQ 主 Agent 可以发送语音。'));
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1
        || !Object.hasOwn(args, 'text') || typeof args.text !== 'string' || !args.text.trim()) {
        return Promise.resolve(result('failed', 'INVALID_TEXT', '仅接受非空文字 text，不能指定音色或发送目标。'));
      }
      const text = args.text;
      return sendQueue.enqueue(execution, async canDispatch => {
        const controller = new AbortController();
        const signal = execution.signal ? AbortSignal.any([execution.signal, controller.signal]) : controller.signal;
        active.add(controller);
        const available = () => !disposed && !signal.aborted && canDispatch();
        const unavailable = () => result('failed', disposed || signal.aborted ? 'SEND_CANCELLED' : 'NOT_AUTHORIZED',
          'QQ 发送授权或步骤已结束，语音未发送。');
        const send = message => nap.sendAction(action, { [targetKey]: target.id, message }, { signal });
        const fail = async (code, message) => {
          if (available()) {
            // The model sees only the voice failure; transport observers may count the text result.
            try { await send([{ type: 'text', data: { text } }]); } catch { /* The voice result remains failed. */ }
          }
          return result('failed', code, message);
        };
        try {
          if (!available()) return unavailable();
          const key = typeof config.ttsDoubaoApiKey === 'string' ? config.ttsDoubaoApiKey.trim() : '';
          const voice = typeof config.ttsVoice === 'string' ? config.ttsVoice.trim() : '';
          if (!key) return await fail('VOICE_NOT_CONFIGURED', '未配置豆包语音 API Key，语音未发送。');
          if (!voice) return await fail('VOICE_NOT_CONFIGURED', '未配置固定豆包音色 ttsVoice，语音未发送。');
          let audio;
          try {
            audio = await synthesize({ ttsDoubaoApiKey: key, ttsDoubaoResourceId: config.ttsDoubaoResourceId }, text, voice, signal);
          } catch (error) {
            if (!available()) return unavailable();
            if (textTooLong(error)) return result('failed', 'VOICE_TEXT_TOO_LONG', '豆包语音拒绝文本过长（40402003），请缩短 text 后再调用。');
            return await fail('VOICE_SYNTHESIS_FAILED', '豆包语音合成失败，语音未发送。');
          }
          if (!available()) return unavailable();
          if (typeof audio !== 'string' || !audio) return await fail('VOICE_SYNTHESIS_FAILED', '豆包语音返回空音频，语音未发送。');
          let response;
          try { response = await send([{ type: 'record', data: { file: `base64://${audio}` } }]); }
          catch { return result('unknown', 'VOICE_SEND_UNKNOWN', 'QQ 语音发送状态未知，可能已送达；未自动补发文字或重试。'); }
          if (response?.status === 'sent') return result('sent', undefined, 'QQ 语音已发送。', response.messageId);
          if (response?.status === 'failed') return await fail('VOICE_SEND_FAILED', 'QQ 语音发送被明确拒绝。');
          return result('unknown', 'VOICE_SEND_UNKNOWN', 'QQ 语音发送状态未知，可能已送达；未自动补发文字或重试。');
        } finally { active.delete(controller); }
      });
    },
  });
  return () => {
    if (disposed) return;
    disposed = true;
    for (const controller of active) controller.abort();
    unregister();
  };
}
