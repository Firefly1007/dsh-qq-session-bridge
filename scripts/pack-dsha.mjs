import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REQUIRED = [
  'package.json', 'cordis.patch.yml', 'lib/index-native.js', 'lib/client-native.js', 'LICENSE', 'vendor/runtime/packages.json',
  'vendor/doubao-tts/scripts/text_to_speech.py', 'vendor/doubao-tts/scripts/api_key.py',
  'vendor/doubao-tts/python/httpx/__init__.py', 'vendor/doubao-tts/python/httpcore/__init__.py',
  'vendor/doubao-tts/python/certifi/cacert.pem', 'vendor/doubao-tts/LICENSE', 'vendor/doubao-tts/UPSTREAM.json',
];

export function validateFiles(files) {
  const names = new Set(files.map((f) => typeof f === 'string' ? f : f.path));
  for (const name of REQUIRED) assert(names.has(name), `安装包缺少 ${name}`);
  for (const name of names) {
    assert(!name.includes('\\') && !name.split('/').includes('..') && !name.startsWith('/'), `非法归档路径：${name}`);
    assert(/^(?:package\.json|cordis\.patch\.yml|README\.md|LICENSE|lib\/[^/]+\.js|vendor\/(?:runtime|doubao-tts)\/.+)$/.test(name), `不应打包的文件：${name}`);
    assert(!/(?:^|\/)(?:\.env(?:\.|$)|config\.local\.json$|onebot11[^/]*\.json$|webui\.json$|state\.json$|sessions\.json$|client-report\.json$)|\.log$/i.test(name), `拒绝打包运行数据或密钥配置：${name}`);
  }
}

export function validateRuntime(manifest) {
  assert.equal(manifest.complete, true, '系统依赖尚未下载齐全');
  assert.equal(manifest.architecture, 'arm64', '系统依赖必须面向 arm64');
  assert(Array.isArray(manifest.packages) && manifest.packages.length, '系统依赖清单为空');
  for (const item of manifest.packages) {
    assert.notEqual(item.package, 'libc6', '必须使用 DSHA 自身 glibc，不能随包覆盖');
    assert(/^debs\/[^/\\]+\.deb$/.test(item.file) && !item.file.includes('..'), '系统依赖路径非法');
    assert(['arm64', 'all'].includes(item.architecture), `系统依赖架构错误：${item.file}`);
    assert(/^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.size) && item.size > 0, `系统依赖元数据错误：${item.file}`);
  }
  for (const dependency of ['xvfb', 'xauth']) assert(manifest.packages.some((item) => item.package === dependency), `缺少 ${dependency} 资产`);
}

function command(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} 执行失败：${result.stderr || result.stdout}`);
  return result.stdout;
}

async function pack() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-qq-session-bridge');
  assert.equal(manifest.main, 'lib/index-native.js');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  for (const name of REQUIRED) assert((await stat(path.join(ROOT, name))).size > 0, `资产为空：${name}`);
  const runtime = JSON.parse(await readFile(path.join(ROOT, 'vendor/runtime/packages.json'), 'utf8'));
  validateRuntime(runtime);
  for (const item of runtime.packages) {
    const asset = path.join(ROOT, 'vendor/runtime', item.file);
    assert.equal((await stat(asset)).size, item.size, `系统依赖大小错误：${item.file}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(asset)) hash.update(chunk);
    assert.equal(hash.digest('hex'), item.sha256, `系统依赖校验失败：${item.file}`);
  }
  const destination = path.join(ROOT, 'dist');
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(path.join(destination, '.dsha-napcat-pack-'));
  try {
    // 使用 Node 调用 npm CLI，兼容 Windows 路径空格且无需 shell 转义。
    assert(process.env.npm_execpath, '请通过 npm run pack:dsha 运行此脚本');
    const [packed] = JSON.parse(command(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
    validateFiles(packed.files);
    const archive = path.join(temporary, packed.filename);
    const members = command('tar', ['-tzf', archive]).trim().split(/\r?\n/);
    assert(members.every((name) => name.startsWith('package/')), '归档必须使用 package/ 前缀');
    const actual = members.map((name) => name.slice(8));
    validateFiles(actual);
    assert.deepEqual(actual.filter((name) => name.endsWith('.deb')).sort(), runtime.packages.map((item) => 'vendor/runtime/' + item.file).sort(), '归档系统依赖与核验清单不一致');
    assert.deepEqual([...actual].sort(), packed.files.map((f) => f.path).sort(), '归档实际成员与 npm 清单不一致');
    assert((await stat(archive)).size <= 256 * 1024 * 1024, '归档超过 DSHA 本地导入的 256 MiB 上限');
    const output = path.join(destination, `${manifest.name}-${manifest.version}-dsha-linux-arm64.tgz`);
    await rename(archive, output);
    console.log(JSON.stringify({ file: output, bytes: (await stat(output)).size, files: actual.length, systemPackages: runtime.packages.length }, null, 2));
  } finally {
    assert(path.dirname(temporary) === destination && path.basename(temporary).startsWith('.dsha-napcat-pack-'), '临时目录超出清理范围');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  pack().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
