window.__ModuleLoader__.load({
  id: 'dsh-qq-session-bridge',
  factory: (require) => {
    const { createElement: h, useEffect, useState } = require('react');
    const fields = [
      ['准入', 'superUsers', '超级管理员 QQ', 'text', '多个号码用逗号分隔。只有管理员可委派具有本地权限的子 Agent。'],
      ['准入', 'whitelist', '用户允许名单', 'text', '留空不限制用户；管理员不受此名单限制。'],
      ['准入', 'groupWhitelist', '群允许名单', 'text', '留空不限制群；群消息还需满足用户允许名单。'],
      ['准入', 'groupWakeTimeoutSec', '群聊连续对话免 @ 秒数', 'number', '仅当前触发成员可免 @，指令仍需 @ 或回复机器人。'],
      ['语音', 'asrEnabled', '识别收到的 QQ 语音', 'checkbox', '使用豆包录音文件标准版。'],
      ['语音', 'asrDoubaoApiKey', '语音识别 API Key', 'password', '需开通 volc.seedasr.auc。'],
      ['语音', 'asrFailureMessage', '语音识别失败提示', 'text', '语音失败时，同一消息里的文字仍会处理。'],
      ['语音', 'ttsDoubaoApiKey', '语音合成 API Key', 'password', '需要对应资源和音色授权。'],
      ['语音', 'ttsDoubaoResourceId', '语音合成资源 ID', 'text', '需与音色和授权匹配。'],
      ['语音', 'ttsVoice', '固定音色 Speaker ID', 'text', '由模型决定是否调用语音工具。'],
      ['主动发言', 'proactiveEnabled', '私聊主动发言', 'checkbox', '空闲后随机判断；告别时暂停。'],
      ['主动发言', 'proactiveGroups', '允许主动发言的群', 'text', '填写群号，多个号码用逗号分隔；留空表示群聊关闭。'],
      ['主动发言', 'proactiveCooldownSec', '主动发言冷却秒数', 'number', '60 至 1800 秒。'],
      ['高级连接', 'autoStartNapCat', '启用插件时启动 NapCat', 'checkbox', '无需另开 NapCat。'],
      ['高级连接', 'stopNapCatOnDisable', '停用插件时停止 NapCat', 'checkbox', '只停止本插件拥有的进程。'],
      ['高级连接', 'webuiPort', 'WebUI 端口', 'number', '默认 6099。'],
      ['高级连接', 'webuiToken', 'WebUI 管理 Token', 'password', '留空由 NapCat 管理。'],
      ['高级连接', 'qqPath', 'Linux QQ 路径', 'text', '留空自动准备固定版本。'],
      ['高级连接', 'napcatHome', 'NapCat 路径', 'text', '留空自动准备固定版本。'],
      ['高级连接', 'napcatStartTimeout', '启动超时（毫秒）', 'number', '首次下载可能需要更长时间。'],
      ['高级连接', 'napcatHttpUrl', 'OneBot HTTP 地址', 'text', '默认 http://127.0.0.1:3000。'],
      ['高级连接', 'napcatWsUrl', 'OneBot WS 地址', 'text', '默认 ws://127.0.0.1:3001。'],
      ['高级连接', 'napcatToken', 'OneBot access_token', 'password', '留空保存时自动生成；与 WebUI Token 不同。'],
      ['高级连接', 'receiveMode', '消息接收方式', 'select', 'WS 或 webhook。'],
      ['高级连接', 'webhookPath', 'Webhook 路径', 'text', '使用宿主当前监听地址自动配置。'],
      ['高级连接', 'selfQQ', '机器人 QQ 号', 'text', '留空自动获取。'],
      ['高级连接', 'wsRetryInterval', 'WS 初始重连间隔（毫秒）', 'number', ''],
      ['高级连接', 'wsRetryMaxInterval', 'WS 最大重连间隔（毫秒）', 'number', ''],
      ['高级连接', 'wsMaxRetries', 'WS 最大重试次数', 'number', '0 表示持续重试。'],
      ['高级连接', 'wsHeartbeatTimeout', 'WS 心跳超时（毫秒）', 'number', ''],
    ];
    const css = '.qqbridge{max-width:56rem;min-width:0;display:grid;gap:16px;color:inherit}.qqbridge section{border:1px solid #8885;border-radius:12px;padding:16px;display:grid;gap:12px;min-width:0}.qqbridge label{display:grid;gap:6px;min-width:0}.qqbridge small{opacity:.75;line-height:1.45}.qqbridge input:not([type=checkbox]),.qqbridge select{box-sizing:border-box;width:100%;min-width:0;min-height:44px;border:1px solid #8888;border-radius:8px;padding:8px;color:inherit;background:transparent;font:inherit}.qqbridge input[type=checkbox]{width:20px;height:20px}.qqbridge button,.qqbridge a{min-height:44px;padding:8px 14px;border:1px solid #8888;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}.qqbridge .actions{display:flex;flex-wrap:wrap;gap:8px}.qqbridge p,.qqbridge small{overflow-wrap:anywhere}.qqbridge :focus-visible{outline:2px solid #4386ff;outline-offset:2px}';
    const request = (path, options) => fetch('/qq-session-bridge/api' + path, { cache: 'no-store', ...options }).then(async response => {
      const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
    });
    function Panel() {
      const [config, setConfig] = useState(null), [status, setStatus] = useState(null), [webui, setWebui] = useState(null);
      const [providers, setProviders] = useState([]), [message, setMessage] = useState('');
      useEffect(() => {
        let live = true;
        request('/config').then(value => { if (live) setConfig(value); }).catch(error => { if (live) setMessage(error.message); });
        request('/models').then(value => { if (live) setProviders(value.providers || []); }).catch(() => {});
        const refresh = () => Promise.all([request('/status'), request('/webui')]).then(([a, b]) => {
          if (live) { setStatus(a); setWebui(b); }
        }).catch(() => {});
        refresh(); const timer = setInterval(refresh, 5000);
        return () => { live = false; clearInterval(timer); };
      }, []);
      const change = (key, value) => setConfig(previous => ({ ...previous, [key]: value }));
      const save = () => request('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })
        .then(() => setMessage('已保存。连接或启动设置请重新启用插件后生效；名单和语音设置立即生效。'))
        .catch(error => setMessage(error.message));
      const action = name => request('/napcat/' + name, { method: 'POST' }).then(value => {
        setMessage(value.napcat?.reason || '操作已提交。');
        return request('/status').then(setStatus);
      }).catch(error => setMessage(error.message));
      if (!config) return h('div', { className: 'qqbridge' }, message || '正在加载 QQ 桥接设置…');
      const sections = [...new Set(fields.map(field => field[0]))];
      const currentProvider = providers.find(provider => provider.id === config.modelProvider);
      return h('div', { className: 'qqbridge' },
        h('h2', null, 'QQ 原生会话桥接'),
        h('p', null, 'QQ 私聊和群聊分别连接独立的 DSH 会话与工作区。模型、记忆和工具由 DSH 管理。'),
        h('section', null, h('h3', null, '连接与登录'),
          h('p', null, `NapCat：${status?.napcat?.reason || status?.napcat?.state || '正在读取'}；接收：${status?.receiver?.state || '未知'}`),
          h('div', { className: 'actions' }, ['start', 'stop', 'restart'].map((item, index) =>
            h('button', { key: item, type: 'button', onClick: () => action(item) }, ['启动', '停止', '重启'][index])),
            webui?.urlWithToken ? h('a', { href: webui.urlWithToken, target: '_blank', rel: 'noopener noreferrer' }, '在浏览器打开 NapCat 登录') : null),
          h('small', null, '打开浏览器扫码登录。WebUI Token 与 OneBot access_token 分别用于管理和通信。')),
        h('section', null, h('h3', null, '新会话默认模型'),
          h('label', null, '服务商', h('select', { value: config.modelProvider, onChange: event => setConfig(previous => ({ ...previous, modelProvider: event.target.value, modelId: '' })) },
            h('option', { value: '' }, '跟随 DSH 默认'), providers.map(provider => h('option', { key: provider.id, value: provider.id }, provider.name)))),
          config.modelProvider ? h('label', null, '模型', h('select', { value: config.modelId, onChange: event => change('modelId', event.target.value) },
            h('option', { value: '' }, '请选择模型'), (currentProvider?.models || []).map(model => h('option', { key: model.id, value: model.id }, model.name || model.id)))) : null,
          h('small', null, '只应用于新建 QQ 会话；已有会话沿用 DSH 中当前模型。')),
        sections.map(section => h('section', { key: section }, h('h3', null, section), fields.filter(field => field[0] === section).map(([, key, label, type, hint]) =>
          h('label', { key }, h('span', null, label), type === 'select'
            ? h('select', { value: config[key], onChange: event => change(key, event.target.value) }, h('option', { value: 'ws' }, '正向 WebSocket'), h('option', { value: 'webhook' }, 'Webhook'))
            : h('input', { type, value: type === 'checkbox' ? undefined : config[key], checked: type === 'checkbox' ? !!config[key] : undefined,
              onChange: event => change(key, type === 'checkbox' ? event.target.checked : type === 'number' ? Number(event.target.value) : event.target.value) }),
            hint ? h('small', null, hint) : null)))),
        h('div', { className: 'actions' }, h('button', { type: 'button', onClick: save }, '保存设置')),
        message ? h('p', { role: 'status' }, message) : null);
    }
    function apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); });
      ctx.effect(() => ctx.locale.register('qqBridge', { zh: { nav: 'QQ 原生会话桥接' }, en: { nav: 'QQ Session Bridge' } }));
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-qq-session-bridge', order: 17,
        label: () => ctx.locale.bind('qqBridge')('nav'), locale: 'qqBridge' }, Panel));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-qq-session-bridge', locale: 'qqBridge' }, Panel));
    }
    return { name: 'dsh-qq-session-bridge', inject: ['slots', 'locale'], apply };
  },
});
