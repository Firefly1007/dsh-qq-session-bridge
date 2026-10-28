// lib/tts.js
// 语音（TTS）决策 / 合成 / 缓存（零外部依赖）。
//
// 三种模式（面板三选一，规则可按会话覆盖）：
//   all      全部消息转语音
//   keyword  关键词触发（用户或回复里出现关键词才出声）
//   random   性格随机模式（想发就发）—— 每轮掷一次骰子，命中才出声
//
// 设计要点：
//   1. 概率不是死的：可开「人设智能权重」——短句、活泼的内容更容易出声；
//      长段解释、安静 emo 的内容自动降低概率，贴合「大肥鱼」这种懒得开口的性格。
//   2. 音色可随机：从预设软萌音色池里随机挑，每轮都可能不一样；
//      也可以关掉随机音色，固定用面板里的音色。
//   3. 兜底：接口异常 / 合成失败 / 发送失败一律降级为「只发文字」，写日志，绝不抛给上层。
//   4. 音频走 NapCat base64 直接发，不落盘（没有残留文件要清理）；
//      内存里做 TTL + 容量上限的缓存，自动淘汰。

import { requestVolcengineTts, DOUBAO_TTS_URL, DOUBAO_RESOURCE_ID } from './tts-volcengine.js';

const DEFAULT_POOL = [
  'zh_female_vv_uranus_bigtts', 'zh_female_meilinvyou_uranus_bigtts',
  'zh_female_roumeinvyou_uranus_bigtts', 'zh_female_wenrouxiaoya_uranus_bigtts',
];
const DEFAULT_KEYWORDS = ['语音', '发语音', '说给我听', '念一下', '用说的', '听你声音', '朗读'];

/**
 * 强制语音指令（内置，无需用户配置）。命中后**跳过一切概率**，直接出语音。
 * 覆盖需求里的：发语音 / 发句语音 / 说出来 / 语音说xxx
 */
const FORCE_KEYWORDS = [
  '发语音', '发句语音', '发条语音', '发个语音', '发一段语音', '来句语音', '来条语音', '来段语音',
  '语音说', '用语音', '语音回复', '语音回答', '语音念', '语音读',
  '说出来', '念出来', '读出来', '说出来听听', '念一下', '读一下', '说给我听', '念给我听', '唱一个', '唱一个听听',
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 60;
const MAX_TEXT = 300;
const MODES = ['off', 'all', 'keyword', 'random'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 逗号/换行分隔的列表；空则用默认值。 */
export function parseList(raw, fallback) {
  const arr = String(raw == null ? '' : raw)
    .split(/[\n,，、;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return arr.length ? arr : (fallback || []).slice();
}

/**
 * 是否命中「强制语音」指令。
 * @param {string} text 用户这一轮说的话
 * @returns {{force:boolean, keyword:string}}
 */
export function detectForceVoice(text) {
  const s = String(text || '');
  if (!s) return { force: false, keyword: '' };
  const hit = FORCE_KEYWORDS.find((k) => s.includes(k));
  return { force: !!hit, keyword: hit || '' };
}

/**
 * 从「发个语音说你好」这类指令里，把要念的内容抠出来。
 * 抠到了就**完全绕过 LLM**直接合成语音，从根上杜绝模型推脱。
 * @returns {{hit:boolean, keyword:string, say:string}}
 */
export function extractForceSay(text) {
  const s = String(text || '').trim();
  const hit = detectForceVoice(s);
  if (!hit.force) return { hit: false, keyword: '', say: '' };
  const idx = s.indexOf(hit.keyword);
  let rest = idx >= 0 ? s.slice(idx + hit.keyword.length) : '';
  rest = rest.replace(/^[\s：:，,、。.!！?？~～]+/, '');
  // 去掉“说 / 讲 / 念 / 一句 / 一段 / 一下 …”这些连接词
  rest = rest.replace(/^(?:(?:一句|一段|句|段|个|声|下|一下|一遍|说|讲|念|读|唱|来|给我|给我说|给我们))+/, '');
  rest = rest.replace(/^[\s：:，,、。.!！?？~～]+/, '').trim();
  rest = rest.replace(/[\s。.!！,，~～]*(?:吧|哦|咯|啦|嘛|呗)$/u, '').trim();
  const core = rest.replace(/[\s\p{P}\p{S}]/gu, '');
  if (core.length < 2) rest = '';
  return { hit: true, keyword: hit.keyword, say: rest };
}

/** 从音色池里随机挑一个（rng 可注入，便于测试）。 */
export function pickVoice(pool, rng) {
  const arr = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!arr.length) return '';
  const r = typeof rng === 'function' ? rng() : Math.random();
  return arr[Math.floor(clamp(r, 0, 0.999999) * arr.length)] || arr[0];
}

/**
 * 人设智能权重：内容越「愿意开口」，权重越高。
 * @returns {number} 0.45 ~ 1.7
 */
export function smartWeight(text, persona) {
  const s = String(text || '');
  const len = s.length;
  let f = 1;
  if (len <= 12) f *= 1.3;
  else if (len <= 30) f *= 1.18;
  else if (len <= 60) f *= 1.05;
  else if (len <= 120) f *= 0.92;
  else f *= 0.72;

  const lively = (s.match(/哈|嘿|耶|呜|哇|呀|啦|哦|太棒|好耶|开心|好玩|可爱|喜欢|冲|笑/g) || []).length;
  const emo = (s.match(/难过|累|emo|哭|孤独|丧|唉|失眠|难受|焦虑|烦|安静|沉默|算了/g) || []).length;
  f *= 1 + Math.min(lively, 4) * 0.07;
  f *= 1 - Math.min(emo, 3) * 0.12;

  // 人设本身就懒/佛系 → 整体再压一点：能不出声就不出声
  if (/懒|瘫|不想动|佛系|慢悠悠|不想说话/.test(String(persona || ''))) f *= 0.9;
  return clamp(f, 0.45, 1.7);
}

/**
 * 计算本轮实际生效的语音概率（0~100）。
 * 未开智能权重时原样返回（0 就永不发，100 就次次发）。
 */
export function effectiveProbability(base, smart, text, persona) {
  const p = clamp(Number(base) || 0, 0, 100);
  if (!smart) return p;
  if (p <= 0) return 0;
  if (p >= 100) return 100;
  return clamp(Math.round(p * smartWeight(text, persona)), 1, 99);
}

/**
 * 掷骰子决策（纯函数，便于验收）。
 * @param {{mode:string, probability:number, smart:boolean, keywords:string[], replaceText:boolean}} s
 * @param {{text:string, userText?:string, persona?:string, rng?:Function}} input
 * @returns {{send:boolean, mode:string, probability:number, roll:number, reason:string}}
 */
export function decideVoice(s, input) {
  const set = s || {};
  const mode = MODES.includes(set.mode) ? set.mode : 'off';
  const text = String((input && input.text) || '');
  const userText = String((input && input.userText) || '');
  const persona = String((input && input.persona) || '');
  const rng = (input && typeof input.rng === 'function') ? input.rng : Math.random;
  const roll = rng();

  if (mode === 'off') return { send: false, mode, probability: 0, roll, reason: 'off' };
  if (!text.trim()) return { send: false, mode, probability: 0, roll, reason: 'empty-reply' };

  if (mode === 'all') return { send: true, mode, probability: 100, roll, reason: 'all' };

  if (mode === 'keyword') {
    const kws = Array.isArray(set.keywords) && set.keywords.length ? set.keywords : DEFAULT_KEYWORDS;
    const hay = `${userText}\n${text}`.toLowerCase();
    const hit = kws.find((k) => k && hay.includes(String(k).toLowerCase()));
    return { send: !!hit, mode, probability: 100, roll, reason: hit ? 'keyword:' + hit : 'no-keyword' };
  }

  // random：性格随机模式
  const probability = effectiveProbability(set.probability, set.smart !== false, text, persona);
  const hit = roll * 100 < probability;
  return {
    send: hit,
    mode,
    probability,
    roll,
    reason: hit ? 'random-hit' : 'random-miss',
  };
}

export function createTts(config, log, nap) {
  const cache = new Map(); // key -> { at, b64 }
  const active = new Set();
  let disposed = false;
  let voiceSent = 0;
  let voiceSkip = 0;
  let voiceFail = 0;
  let lastAt = 0;
  let lastVoice = '';
  let lastDegraded = false;
  let lastError = '';

  function prune() {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (!v || now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function cfg() {
    return config || {};
  }

  /** 解析某个会话（规则）真正生效的语音设置。 */
  function settings(rule) {
    const r = rule || {};
    const c = cfg();
    let mode = MODES.includes(String(r.ttsMode || '')) ? String(r.ttsMode) : '';
    if (!mode) {
      // 兼容旧版规则里的布尔开关（true 等价于「全部转语音」）
      if (r.ttsEnabled === true) mode = 'all';
    }
    if (!mode) {
      const m = String(c.ttsMode || '').trim();
      if (MODES.includes(m)) mode = m;
      else if (c.ttsEnabled) mode = 'all';
      else mode = 'off';
    }

    const ruleProb = Number(r.ttsProbability);
    const rawProb = r.ttsProbability != null && r.ttsProbability !== '' && Number.isFinite(ruleProb) && ruleProb >= 0
      ? ruleProb
      : Number(c.ttsProbability);
    const probability = clamp(Number.isFinite(rawProb) ? rawProb : 40, 0, 100);

    const voiceRandom = r.ttsVoiceRandom == null || r.ttsVoiceRandom === ''
      ? (c.ttsVoiceRandom !== false)
      : !!r.ttsVoiceRandom;

    const pool = parseList(c.ttsVoicePool === '软萌少女,甜妹,奶音,软糯小助手'
      ? '' : c.ttsVoicePool, DEFAULT_POOL);
    const fixed = String(c.ttsVoice || '').trim() || pool[0] || '';

    const configured = !!String(c.ttsDoubaoApiKey || '').trim();
    const engine = !disposed && configured ? 'doubao' : 'none';
    const voice = voiceRandom ? pickVoice(pool) : fixed;

    return {
      mode,
      engine,
      probability,
      voiceRandom,
      voice,
      fixedVoice: fixed,
      pool,
      keywords: parseList(c.ttsKeywords, DEFAULT_KEYWORDS),
      smart: c.ttsSmartWeight !== false,
      replaceText: c.ttsReplaceText !== false,
      maxChars: Math.max(30, Number(c.ttsMaxChars) || MAX_TEXT),
      url: DOUBAO_TTS_URL,
      configured,
      resourceId: String(c.ttsDoubaoResourceId || DOUBAO_RESOURCE_ID).trim(),
      configurationError: configured ? '' : '未配置豆包语音 API Key',
    };
  }

  /** 纯决策：这一轮到底发不发语音、用哪个音色。 */
  function plan(rule, input) {
    const s = settings(rule);
    const forceHit = detectForceVoice((input && (input.userText || input.text)) || '');
    // 强制语音指令优先级最高：不看模式、不掷骰子、不受概率影响
    const d = forceHit.force
      ? { send: true, mode: 'force', probability: 100, roll: 0, reason: 'force:' + forceHit.keyword }
      : decideVoice(s, input || {});
    const send = !!d.send && s.engine !== 'none';
    return {
      ...d,
      force: forceHit.force,
      keyword: forceHit.keyword,
      send,
      voice: s.voice,
      replaceText: s.replaceText,
      maxChars: s.maxChars,
      engine: s.engine,
      reason: d.send && s.engine === 'none' ? (disposed ? 'disposed' : 'no-doubao-api-key') : d.reason,
    };
  }

  async function request(text, voice) {
    const controller = new AbortController();
    active.add(controller);
    try {
      return await requestVolcengineTts(cfg(), String(text).slice(0, MAX_TEXT), voice, controller.signal);
    } finally { active.delete(controller); }
  }

  /**
   * 合成语音（带内存缓存）。任何失败都返回 ''，只记日志，不抛。
   */
  async function synth(text, voice) {
    if (disposed) return '';
    const t = String(text || '').trim();
    if (!t) return '';
    const s = settings();
    const selectedVoice = String(voice || s.fixedVoice || DEFAULT_POOL[0]);
    const key = `${s.resourceId}|${selectedVoice}|${t.slice(0, MAX_TEXT)}`;
    prune();
    const hit = cache.get(key);
    if (s.configured && hit && Date.now() - hit.at <= CACHE_TTL_MS) {
      hit.at = Date.now();
      lastError = '';
      lastDegraded = false;
      return hit.b64;
    }
    try {
      const b64 = await request(t, selectedVoice);
      if (!b64) throw new Error('空音频');
      cache.set(key, { at: Date.now(), b64 });
      prune();
      lastAt = Date.now();
      lastError = '';
      lastDegraded = false;
      return b64;
    } catch (e) {
      voiceFail += 1;
      lastDegraded = true;
      lastAt = Date.now();
      lastError = String((e && e.message) || e).slice(0, 300);
      try { log && log.warn && log.warn(`[napcat] TTS 合成失败（已降级为纯文字）: ${lastError}`); } catch { /* ignore */ }
      return '';
    }
  }

  /** 发送语音。失败返回 false，不抛。 */
  async function send(channel, base64, voice) {
    if (!base64 || !channel) return false;
    try {
      const message = [{ type: 'record', data: { file: `base64://${base64}` } }];
      if (channel.type === 'group') await nap.sendGroup(channel.id, message);
      else await nap.sendPrivate(channel.id, message);
      voiceSent += 1;
      lastAt = Date.now();
      lastVoice = voice || '';
      lastDegraded = false;
      return true;
    } catch (e) {
      voiceFail += 1;
      lastDegraded = true;
      lastAt = Date.now();
      try { log && log.warn && log.warn(`[napcat] 语音发送失败（已降级为纯文字）: ${(e && e.message) || e}`); } catch { /* ignore */ }
      return false;
    }
  }

  function noteSkip() { voiceSkip += 1; }

  function stats() {
    return {
      mode: settings().mode,
      engine: settings().engine,
      local: null,
      url: DOUBAO_TTS_URL,
      configured: settings().configured,
      resourceId: settings().resourceId,
      configurationError: settings().configurationError,
      lastError,
      probability: settings().probability,
      voiceRandom: settings().voiceRandom,
      pool: settings().pool,
      cache: cache.size,
      sent: voiceSent,
      skipped: voiceSkip,
      failed: voiceFail,
      lastAt,
      lastVoice,
      degraded: lastDegraded,
    };
  }

  function dispose() {
    disposed = true;
    cache.clear();
    for (const controller of active) controller.abort();
    active.clear();
  }

  return { settings, plan, synth, send, noteSkip, stats, dispose, decideVoice, effectiveProbability, smartWeight };
}

export { DEFAULT_POOL, DEFAULT_KEYWORDS, FORCE_KEYWORDS, MODES, MAX_TEXT };
