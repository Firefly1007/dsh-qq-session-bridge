import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const QQ_DEFAULTS = Object.freeze({
  autoStartNapCat: true, stopNapCatOnDisable: true, webuiPort: 6099, webuiToken: '', qqPath: '', napcatHome: '',
  napcatStartTimeout: 60000, napcatHttpUrl: 'http://127.0.0.1:3000', napcatWsUrl: 'ws://127.0.0.1:3001',
  napcatToken: '', napcatConsoleUrl: 'http://127.0.0.1:6099/webui', receiveMode: 'ws', webhookPath: '/qq-session-bridge/onebot',
  selfQQ: '', wsRetryInterval: 2000, wsRetryMaxInterval: 15000, wsMaxRetries: 0, wsHeartbeatTimeout: 100000,
  superUsers: '', whitelist: '', groupWhitelist: '', groupWakeTimeoutSec: 120,
  modelProvider: '', modelId: '', ttsDoubaoApiKey: '', ttsDoubaoResourceId: 'seed-tts-2.0', ttsVoice: '',
  asrEnabled: false, asrDoubaoApiKey: '', asrFailureMessage: '语音识别失败，请发送文字。',
  proactiveEnabled: true, proactiveCooldownSec: 180, proactiveGroups: '',
});

function validate(config) {
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(QQ_DEFAULTS, key) || typeof value !== typeof QQ_DEFAULTS[key]
      || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error(`设置项无效：${key}`);
  }
  for (const key of ['superUsers', 'whitelist', 'groupWhitelist', 'proactiveGroups']) {
    if (config[key].split(/[\s,，]+/).filter(Boolean).some(id => !/^[1-9]\d*$/.test(id))) throw new Error(`${key} 只能填写 QQ 号码`);
  }
  if (config.selfQQ && !/^[1-9]\d*$/.test(config.selfQQ)) throw new Error('机器人 QQ 号码无效');
  if (!['ws', 'webhook'].includes(config.receiveMode) || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(config.webhookPath)) {
    throw new Error('接收方式或 webhook 路径无效');
  }
  for (const [key, protocols] of [['napcatHttpUrl', ['http:', 'https:']], ['napcatWsUrl', ['ws:', 'wss:']],
    ['napcatConsoleUrl', ['http:', 'https:']]]) {
    let url;
    try { url = new URL(config[key]); } catch { throw new Error(`${key} 地址无效`); }
    if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error(`${key} 地址无效`);
  }
  if (config.webuiPort < 1 || config.webuiPort > 65535 || config.napcatStartTimeout < 1
    || config.wsRetryInterval < 1 || config.wsRetryMaxInterval < config.wsRetryInterval || config.wsMaxRetries < 0
    || config.wsHeartbeatTimeout < 1 || config.groupWakeTimeoutSec < 5
    || config.proactiveCooldownSec < 60 || config.proactiveCooldownSec > 1800) throw new Error('数值设置超出允许范围');
  if (!!config.modelProvider !== !!config.modelId) throw new Error('默认模型需要同时选择服务商和模型');
  return config;
}

/** Store only this bridge's settings, independently of other plugin data. */
export function createQQSettings({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('需要绝对设置目录');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 QQ 桥接设置', { cause: error }); }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('QQ 桥接设置格式无效');
  const config = validate({ ...QQ_DEFAULTS, ...saved });
  if (!config.napcatToken) config.napcatToken = randomBytes(32).toString('hex');

  function update(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('设置内容无效');
    const next = validate({ ...config, ...changes });
    if (!next.napcatToken) next.napcatToken = randomBytes(32).toString('hex');
    const temp = path.join(directory, `.settings-${randomBytes(8).toString('hex')}.tmp`);
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
    catch (error) { try { fs.unlinkSync(temp); } catch { /* Nothing to remove. */ } throw error; }
    Object.assign(config, next);
    return config;
  }
  if (!fs.existsSync(file) || !saved.napcatToken) update({});
  return { config, update };
}
