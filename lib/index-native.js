import fs from 'node:fs';
import { qqDataDirectory } from './qq-paths.js';
import { createQQSettings } from './qq-settings.js';
import { createQQService } from './qq-service.js';
import { createNapCat } from './napcat.js';
import { createEmbeddedNapcat } from './napcat-embedded.js';
import { authenticatedHandler } from './api-auth.js';

export const name = 'dsh-qq-session-bridge';
export const inject = ['agents', 'agentPresets', 'tools', 'systemPrompt', 'workspaceRegistry', 'sessions', 'sessionPersistence',
  'sessionController', 'agentDefaultModel', 'permissionPresets', 'llm', 'attachments', 'fileUploads',
  'subagents', 'webServer', 'connection'];

function portOf(value, fallback) {
  try { return Number(new URL(value).port) || fallback; } catch { return fallback; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function apply(ctx) {
  const rawLogger = typeof ctx.logger === 'function' ? ctx.logger('dsh-qq-session-bridge') : ctx.logger;
  const log = rawLogger || console;
  const directory = qqDataDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const settings = createQQSettings({ directory });
  const runtime = { ...settings.config, napcatHttpPort: portOf(settings.config.napcatHttpUrl, 3000),
    napcatWsPort: portOf(settings.config.napcatWsUrl, 3001), webhookUrl: '' };
  const nap = createNapCat(runtime, ctx, log);
  const manager = createEmbeddedNapcat(runtime, log);
  let service, receiver, timer, unregister, stopped = false, manuallyStopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    receiver?.dispose();
    if (unregister) unregister();
    await service?.dispose();
    await manager.shutdown({ kill: settings.config.stopNapCatOnDisable !== false });
  };
  ctx.effect(() => stop, 'QQ bridge cleanup');
  try {
    service = await createQQService({ ctx, config: settings.config, directory, nap, log });
    if (stopped) { await service.dispose(); return; }
    const onEvent = event => { service.handle(event).catch(() => log.warn('[napcat] QQ 消息处理失败')); };
    async function startReceiver() {
      if (stopped || receiver) return;
      receiver = runtime.receiveMode === 'webhook' ? await nap.startWebhook(onEvent) : nap.connectWs(onEvent);
      if (stopped || manuallyStopped) { receiver.dispose(); receiver = undefined; }
    }
    function stopReceiver() { receiver?.dispose(); receiver = undefined; }
    const json = (res, status, value) => {
      res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
    };
    let syncing = false, lastTry = 0, webhookApplied = false;
    unregister = ctx.webServer.register({ kind: 'prefix', path: '/qq-session-bridge/api', handler: authenticatedHandler(ctx, async (req, res) => {
      try {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (req.method === 'GET' && pathname === '/qq-session-bridge/api/config') return json(res, 200, settings.config);
        if (req.method === 'POST' && pathname === '/qq-session-bridge/api/config') {
          const body = await readBody(req);
          settings.update(body);
          return json(res, 200, { ok: true, restartRequired: true });
        }
        if (req.method === 'GET' && pathname === '/qq-session-bridge/api/models') {
          const providers = ctx.llm.listProviders();
          const models = await Promise.all(providers.map(async provider => ({ id: provider.id, name: provider.name || provider.id,
            models: await ctx.llm.listModels(provider.id).catch(() => []) })));
          return json(res, 200, { providers: models });
        }
        if (req.method === 'GET' && pathname === '/qq-session-bridge/api/status') {
          return json(res, 200, { napcat: manager.status(), onebot: nap.getStatus(),
            receiver: receiver?.state?.() || { state: 'idle' }, proactive: service.proactive.status() });
        }
        if (req.method === 'GET' && pathname === '/qq-session-bridge/api/webui') {
          const state = manager.status();
          return json(res, 200, { url: state.webui, urlWithToken: state.webuiUrl, token: state.token, state: state.state });
        }
        if (req.method === 'POST' && ['/qq-session-bridge/api/napcat/start', '/qq-session-bridge/api/napcat/stop', '/qq-session-bridge/api/napcat/restart'].includes(pathname)) {
          const action = pathname.split('/').at(-1);
          webhookApplied = false;
          if (action === 'stop') { manuallyStopped = true; stopReceiver(); await manager.stop(); }
          else { manuallyStopped = false; stopReceiver(); await startReceiver(); await manager[action](); }
          return json(res, 200, { ok: true, napcat: manager.status() });
        }
        return json(res, 404, { error: 'Not found' });
      } catch (error) { return json(res, 400, { error: error?.message || '请求失败' }); }
    }) });
    await startReceiver();
    manager.watch();
    timer = setInterval(async () => {
      if (stopped || manuallyStopped || syncing) return;
      syncing = true;
      try {
        if (runtime.receiveMode === 'webhook') {
          try {
            const origin = new URL(ctx.webServer.getOrigin());
            if (origin.hostname === '0.0.0.0') origin.hostname = '127.0.0.1';
            if (origin.hostname === '[::]') origin.hostname = '[::1]';
            runtime.webhookUrl = new URL(runtime.webhookPath, origin).href;
          } catch { runtime.webhookUrl = ''; }
          if (!runtime.webhookUrl) return;
        }
        const state = manager.status();
        if (!state.alive && !['webui', 'starting'].includes(state.state)) { webhookApplied = false; return; }
        const info = await nap.getLoginInfo();
        if (stopped || manuallyStopped) return;
        if (info?.user_id) manager.rememberUin(String(info.user_id));
        const needsConfig = runtime.receiveMode === 'webhook' ? !webhookApplied : !await manager.onebotWsListening();
        if (stopped || manuallyStopped) return;
        if (needsConfig && Date.now() - lastTry >= 15000) {
          lastTry = Date.now();
          const result = await manager.ensureOneBotNetwork({ force: true });
          if (runtime.receiveMode === 'webhook') webhookApplied = result.ok === true;
        }
      } catch { /* Retry transient connection failures on the next tick. */ }
      finally { syncing = false; }
    }, 4000);
    timer.unref?.();
    if (runtime.autoStartNapCat !== false) manager.start().catch(() => log.warn('[napcat] 自动启动失败'));
  } catch (error) {
    await stop();
    throw error;
  }
}
