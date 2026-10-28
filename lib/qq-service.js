import path from 'node:path';
import { getQQHostGuard } from './qq-root-guard.js';
import { createQQAgentBindings } from './qq-agent-bindings.js';
import { createQQFileSnapshotStore } from './qq-file-tool.js';
import { createQQSessionMap } from './qq-sessions.js';
import { resolveQQWorkspace } from './qq-workspaces.js';
import { createQQReceiver } from './qq-receiver.js';
import { prepareQQContent } from './qq-content.js';
import { createQQProactive } from './qq-proactive.js';
import { createQQMediaLoader } from './qq-media.js';

/** Assemble the native Session bridge before accepting OneBot traffic. */
export async function createQQService({ ctx, config, directory, nap, loadMedia, log, onUser, onStop }) {
  if (!ctx?.root || typeof ctx.agentPresets?.register !== 'function' || typeof ctx.get !== 'function'
    || !config || !path.isAbsolute(directory)) throw new TypeError('QQ bridge dependencies are unavailable');
  if (ctx.get('qqBotBridge')) throw new Error('QQ 桥接服务已经启动');
  const abort = new AbortController();
  const guard = getQQHostGuard(ctx.root);
  let bindings, unregister, sessions, proactive;
  try {
    unregister = await ctx.agentPresets.register({ id: 'bot', name: 'bot模式',
      plugins: [{ name: new URL('./bot-mode.js', import.meta.url).href },
        { name: 'cordis:group', group: true, isolate: { compaction: true },
          config: [{ name: '@deepseek-ai/dsh-compaction-basic' }] }] });
    const snapshotStore = createQQFileSnapshotStore({ directory: path.join(directory, 'file-snapshots') });
    bindings = createQQAgentBindings({ ctx, rootGuard: guard, snapshotStore, nap, log,
      lookupBySessionId: id => sessions?.lookupBySessionId(id) || null, getConfig: () => config,
      onTurnFinished: event => proactive?.onTurnFinished(event) });
    sessions = await createQQSessionMap({ ctx, file: path.join(directory, 'session-map.json'), agentPreset: 'bot',
      resolveWorkspace: key => resolveQQWorkspace(ctx, key), setupAgent: bindings.setupAgent,
      getDefaultModel: () => config.modelProvider && config.modelId
        ? { provider: config.modelProvider, model: config.modelId } : null });
    bindings.refresh();
    proactive = createQQProactive({ config, bindings, log });
    const media = loadMedia || createQQMediaLoader({ ctx, nap, qqHome: path.join(directory, 'qq-home') });
    const receiver = createQQReceiver({ ctx, config, nap, sessions, bindings, signal: abort.signal,
      onUser(input, agent) { proactive.noteUser(input, agent); onUser?.(input, agent); }, onStop,
      prepareContent: input => prepareQQContent({ ...input, nap, config, loadMedia: media }) });
    let stopped = false;
    return {
      handle: event => receiver.handle(event),
      sessions, bindings, proactive,
      async dispose() {
        if (stopped) return;
        stopped = true;
        abort.abort();
        proactive.stopAll();
        bindings.dispose();
        guard.clear();
        await unregister();
      },
    };
  } catch (error) {
    abort.abort();
    proactive?.stopAll();
    bindings?.dispose();
    guard.clear();
    if (unregister) await unregister();
    throw error;
  }
}
