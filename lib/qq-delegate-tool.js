export const QQ_DELEGATE_TOOL = 'qq_delegate';

/** Delegate only from the authorized QQ root, using the current DSH default preset. */
export function registerQQDelegateTool({ agent, authorization, ctx }) {
  if (!agent?.ctx?.tools || typeof authorization?.canDelegate !== 'function'
    || typeof ctx?.subagents?.startActivation !== 'function' || !ctx.agentPresets) {
    throw new TypeError('QQ delegation dependencies are unavailable');
  }
  return agent.ctx.tools.register({
    name: QQ_DELEGATE_TOOL,
    description: '将任务委派给子 Agent；使用 DSH 当前默认模式，默认是 bot模式时使用标准模式。只有经验证的 QQ 超级管理员轮次可调用。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { prompt: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 } },
      required: ['prompt', 'description'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', const: 'activation' }, subagentId: { type: 'string' } },
        required: ['kind', 'subagentId'] },
      render: (_args, value) => [{ type: 'text', text: `已启动子 Agent ${value.subagentId}` }],
    },
    async execute(args, execution) {
      if (execution?.agent !== agent || !authorization.canDelegate()) throw new Error('当前轮次没有 QQ 超级管理员委派权限。');
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some(key => !['prompt', 'description'].includes(key))
        || typeof args.prompt !== 'string' || !args.prompt.trim()
        || typeof args.description !== 'string' || !args.description.trim()) {
        throw new Error('仅接受非空 prompt 和 description，不能指定子 Agent 模式。');
      }
      execution.signal.throwIfAborted();
      const defaultPreset = ctx.agentPresets.defaultId;
      if (typeof defaultPreset !== 'string' || !defaultPreset.trim()) throw new Error('DSH 默认工作模式不可用。');
      const preset = defaultPreset === 'bot' ? 'standard' : defaultPreset;
      const maxDepth = ctx.subagents.resolveMaxDepth();
      const started = await ctx.subagents.startActivation({
        provider: 'spawn', label: args.description,
        request: { parent: agent, prompt: [{ type: 'text', text: args.prompt }], agentPreset: preset,
          ...(maxDepth === undefined ? {} : { maxDepth }) },
        signal: execution.signal, delivery: 'parent',
      });
      return { kind: 'activation', subagentId: started.childId };
    },
  });
}
