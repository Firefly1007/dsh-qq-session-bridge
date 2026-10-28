import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const QQ_VERSION = '3.2.34-53644';
const NAPCAT_VERSION = '4.18.41';
const NAPCAT_SHA256 = '6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b';
const QQ_SHA256 = '181b895cb573548e396e54bb0548cca92ffdc1b1a4b018fa4551bb062385fdca';

async function downloadVerified(url, archive, expected, signal, headers) {
  const timeout = AbortSignal.timeout(1200000);
  const response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const hash = createHash('sha256');
  const digest = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), digest, fs.createWriteStream(archive, { flags: 'wx' }));
  if (hash.digest('hex') !== expected) throw new Error('下载文件的 SHA-256 不匹配');
}

export function napcatDirectory(dataDir) {
  return path.join(dataDir, 'runtime', `napcat-${NAPCAT_VERSION}`);
}

export async function prepareNapcat(dataDir, signal) {
  const target = napcatDirectory(dataDir);
  if (fs.existsSync(path.join(target, 'napcat.mjs'))) return target;
  if (fs.existsSync(target)) throw new Error(`NapCat 运行目录不完整：${target}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.napcat-install-'));
  try {
    const url = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/assets/661878437';
    const archive = path.join(stage, 'napcat.zip');
    await downloadVerified(url, archive, NAPCAT_SHA256, signal, { Accept: 'application/octet-stream', 'User-Agent': 'dsh-qq-session-bridge' });
    const extracted = path.join(stage, 'content');
    fs.mkdirSync(extracted);
    await run('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, extracted], signal);
    if (!fs.existsSync(path.join(extracted, 'napcat.mjs'))) throw new Error('NapCat 下载包缺少主文件');
    fs.renameSync(extracted, target);
    return target;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function qqExecutable(dataDir) {
  return path.join(dataDir, 'runtime', `qq-${QQ_VERSION}`, 'opt', 'QQ', 'qq');
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let error = '';
    let spawnError;
    child.stderr.on('data', (chunk) => { error += chunk.toString().slice(0, 4096); });
    child.once('error', (err) => { spawnError = err; });
    child.once('close', (code) => spawnError ? reject(spawnError) : code === 0 ? resolve() : reject(new Error(`${command} 退出 ${code}: ${error}`)));
  });
}

export async function prepareQQ(dataDir, archive, explicitPath, signal) {
  const qq = explicitPath || qqExecutable(dataDir);
  if (!explicitPath && !fs.existsSync(qq)) {
    const parent = path.dirname(path.dirname(path.dirname(path.dirname(qq))));
    fs.mkdirSync(parent, { recursive: true });
    const target = path.join(parent, `qq-${QQ_VERSION}`);
    if (fs.existsSync(target)) throw new Error(`QQ 运行目录不完整：${target}`);
    const stage = fs.mkdtempSync(path.join(parent, '.qq-install-'));
    try {
      let packageFile = archive;
      if (!packageFile || !fs.existsSync(packageFile)) {
        packageFile = path.join(stage, 'linuxqq.deb');
        await downloadVerified('https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_arm64.deb', packageFile, QQ_SHA256, signal);
      }
      const extracted = path.join(stage, 'content');
      fs.mkdirSync(extracted);
      await run('dpkg-deb', ['-x', packageFile, extracted], signal);
      if (!fs.existsSync(path.join(extracted, 'opt', 'QQ', 'qq'))) throw new Error('QQ 安装包缺少可执行文件');
      fs.renameSync(extracted, target);
    } finally {
      if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(qq)) throw new Error(`未找到 Linux QQ：${qq}`);
  fs.accessSync(qq, fs.constants.X_OK);
  return qq;
}

export async function prepareSystem(dataDir, debDir, signal) {
  const parent = path.join(dataDir, 'runtime');
  const manifestBytes = fs.readFileSync(path.join(path.dirname(debDir), 'packages.json'));
  const manifest = JSON.parse(manifestBytes);
  if (!manifest.complete || manifest.architecture !== 'arm64' || !Array.isArray(manifest.packages)) throw new Error('Linux 运行依赖清单不完整');
  const packages = manifest.packages.map((entry) => {
    const name = String(entry.file || '');
    if (!name.startsWith('debs/') || path.basename(name) !== name.slice(5) || !name.endsWith('.deb')) throw new Error('Linux 运行依赖清单含无效路径');
    return name.slice(5);
  });
  if (!packages.length || new Set(packages).size !== packages.length) throw new Error('Linux 运行依赖清单无效');
  const version = createHash('sha256').update(manifestBytes).digest('hex').slice(0, 16);
  const target = path.join(parent, `system2-${version}`);
  if (fs.existsSync(path.join(target, '.complete'))) return target;
  if (fs.existsSync(target)) throw new Error(`Linux 依赖目录不完整：${target}`);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.system-install-'));
  try {
    for (const pkg of packages) await run('dpkg-deb', ['-x', path.join(debDir, pkg), stage], signal);
    for (const bin of ['usr/bin/xvfb-run', 'usr/bin/Xvfb', 'usr/bin/xauth']) {
      fs.accessSync(path.join(stage, bin), fs.constants.X_OK);
    }
    relocateXvfb(path.join(stage, 'usr/bin/Xvfb'));
    fs.writeFileSync(path.join(stage, '.complete'), '1\n');
    fs.renameSync(stage, target);
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
  return target;
}

export function relocateXvfb(file) {
  const binary = fs.readFileSync(file);
  const compiledPath = Buffer.from('/usr/bin\0');
  const offset = binary.indexOf(compiledPath);
  if (offset < 0 || binary.indexOf(compiledPath, offset + 1) >= 0) throw new Error('Xvfb 的 xkbcomp 路径不符合预期');
  // Xvfb 写死 /usr/bin；改成相对路径，让它在私有运行目录中寻找 xkbcomp。
  binary.fill(0, offset, offset + compiledPath.length);
  binary[offset] = '.'.charCodeAt(0);
  fs.writeFileSync(file, binary);
}

export function installLoader(qq) {
  const app = path.join(path.dirname(qq), 'resources', 'app');
  const packageFile = path.join(app, 'package.json');
  const originalFile = path.join(app, 'package.dsh-original.json');
  const loaderFile = path.join(app, 'loadDshNapcat.cjs');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (pkg.main === './loadDshNapcat.cjs') {
    if (!fs.existsSync(originalFile) || !fs.existsSync(loaderFile)) throw new Error('QQ 加载器安装不完整');
    return;
  }
  if (fs.existsSync(originalFile) || fs.existsSync(loaderFile)) throw new Error('QQ 加载器与已有文件冲突，请检查原始入口');
  fs.copyFileSync(packageFile, originalFile, fs.constants.COPYFILE_EXCL);
  const loader = "const { pathToFileURL } = require('node:url');\nimport(pathToFileURL(process.env.DSH_NAPCAT_MAIN).href);\n";
  fs.writeFileSync(loaderFile, loader, { flag: 'wx' });
  pkg.main = './loadDshNapcat.cjs';
  fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2));
}

export function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), group: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}

export function identityMatches(identity) {
  if (!identity || !identity.pid || identity.group !== identity.pid || !identity.start) return false;
  const now = processIdentity(identity.pid);
  return !!now && now.group === identity.group && now.start === identity.start;
}

export function stopOwned(identity) {
  if (!identityMatches(identity)) return false;
  try { process.kill(-identity.group, 'SIGTERM'); return true; } catch { return false; }
}
