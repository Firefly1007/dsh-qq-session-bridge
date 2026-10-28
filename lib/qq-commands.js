import { isQQSessionId } from './qq-root-guard.js';

/** Execute only after the QQ sender and session binding have been admitted. */
export async function executeQQCommand({ ctx, agent, command, signal }) {
  if (!['/new', '/stop'].includes(command)) throw new Error('未知 QQ 指令');
  if (!isQQSessionId(agent?.id) || agent.session?.header?.id !== agent.id || ctx?.agents?.get(agent.id) !== agent) {
    return { status: 'failed', text: 'QQ 会话当前不可用，指令未执行。' };
  }
  try {
    if (command === '/stop') {
      const result = ctx.sessionController.cancel({ sessionId: agent.id });
      return result?.accepted === true
        ? { status: 'accepted', text: '已提交停止请求。' }
        : { status: 'failed', text: '停止请求未被接受。' };
    }
    const compaction = ctx.agentPresets?.serviceFor(agent, 'compaction');
    if (!signal || typeof signal.throwIfAborted !== 'function' || typeof compaction?.compactNow !== 'function') {
      return { status: 'failed', text: '当前无法压缩会话上下文。' };
    }
    const result = await compaction.compactNow(agent, signal);
    return result === null
      ? { status: 'unchanged', text: '当前没有可压缩的上下文。' }
      : result && typeof result === 'object'
        ? { status: 'completed', text: '会话上下文已压缩。' }
        : { status: 'failed', text: '无法确认会话上下文是否已压缩。' };
  } catch (error) {
    return { status: 'failed', text: command === '/stop' ? '停止请求失败。'
      : error?.code === 'busy' ? '会话正在运行，暂时无法压缩上下文。' : '会话上下文压缩失败。' };
  }
}
