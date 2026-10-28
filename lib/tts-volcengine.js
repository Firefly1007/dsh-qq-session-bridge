import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DOUBAO_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const DOUBAO_RESOURCE_ID = 'seed-tts-2.0';
const TIMEOUT_MS = 30000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const root = fileURLToPath(new URL('../vendor/doubao-tts/', import.meta.url));

/** HTTP 请求/认证复用官方 Python 脚本；这里只管理进程与临时音频。 */
export async function requestVolcengineTts(config, text, voice, signal) {
  const key = String(config.ttsDoubaoApiKey || '').trim();
  if (!key) throw new Error('未配置豆包语音 API Key');
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('豆包语音 API Key 格式无效');
  const resource = String(config.ttsDoubaoResourceId || DOUBAO_RESOURCE_ID).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(resource)) throw new Error('豆包语音资源 ID 格式无效');
  if (signal && signal.aborted) throw new Error('豆包语音合成已取消');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-tts-'));
  const output = path.join(dir, 'speech.mp3');
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('python3', [
          '-B', path.join(root, 'scripts', 'text_to_speech.py'),
          `--text=${text}`, `--speaker=${voice}`, `--output=${output}`, '--timeout=30',
        ], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONPATH: path.join(root, 'python'),
            PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8',
            MODEL_SPEECH_API_KEY: key, MODEL_SPEECH_API_BASE: 'openspeech.bytedance.com',
            MODEL_SPEECH_TTS_RESOURCE_ID: resource,
            // 禁止官方通用助手在缺 key 时复用其他宿主凭据或自动创建 key。
            ARK_SKILL_API_KEY: '', ARK_SKILL_API_BASE: '',
          },
        });
      } catch {
        reject(new Error('无法启动豆包语音 Python 组件'));
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      let processError = null;
      let terminationError = null;
      const finish = (error, audio) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(audio);
      };
      const terminate = (error) => {
        if (done || terminationError) return;
        terminationError = error;
        clearTimeout(timer);
        try {
          if (!child.kill('SIGKILL')) terminationError = new Error(`${error.message}；终止进程失败，等待退出`);
        } catch { terminationError = new Error(`${error.message}；终止进程失败，等待退出`); }
        // close 后才读取结果或清理，避免退出前继续写临时文件。
      };
      const cancel = () => terminate(new Error('豆包语音合成已取消'));
      const timer = setTimeout(() => terminate(new Error('豆包语音合成超时（30秒）')), TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 65536) {
          stdout = stdout.slice(0, 65536);
          terminate(new Error('豆包语音组件返回过多诊断数据'));
        }
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
      child.on('error', (error) => {
        processError = new Error(error.code === 'ENOENT'
          ? '未找到 python3，无法运行豆包语音组件' : '无法启动豆包语音 Python 组件');
      });
      child.on('close', (code) => {
        if (done) return;
        if (terminationError || processError) { finish(terminationError || processError); return; }
        try {
          let result;
          try { result = JSON.parse(stdout); } catch {
            throw new Error(stderr.includes('ModuleNotFoundError')
              ? '豆包语音 Python 依赖缺失，请重新安装完整插件包' : `豆包语音组件退出或响应无效（${code}）`);
          }
          if (code !== 0 || !result || result.status !== 'success') {
            const reason = String((result && result.error) || `组件退出 ${code}`).replaceAll(key, '[redacted]').slice(0, 240);
            throw new Error(`豆包语音合成失败：${reason}`);
          }
          const stat = fs.lstatSync(output);
          if (!stat.isFile() || !stat.size || stat.size > MAX_AUDIO_BYTES) throw new Error('豆包语音返回空音频或超过大小限制');
          finish(null, fs.readFileSync(output).toString('base64'));
        } catch (error) { finish(error); }
      });
      if (signal) {
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }
    });
  } finally {
    try { fs.unlinkSync(output); } catch { /* ignore */ }
    try { fs.rmdirSync(dir); } catch { /* ignore */ }
  }
}
