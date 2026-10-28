import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUIRED, validateFiles, validateRuntime } from './pack-dsha.mjs';

test('拒绝缺失资产的清单', () => {
  assert.throws(() => validateFiles(['package.json']), /缺少/);
});

test('拒绝混入 QQ/NapCat 大包、登录数据、配置或越界路径', () => {
  validateFiles(REQUIRED);
  for (const forbidden of ['vendor/qq-linux-arm64.deb', 'vendor/napcat/napcat.mjs', 'vendor/runtime/.env', '../secret', 'package.json.secret', 'reference/download.zip']) {
    assert.throws(() => validateFiles([...REQUIRED, forbidden]), /拒绝|非法|不应/);
  }
});

test('拒绝未下载齐、错误架构、缺失关键服务或越界的系统依赖', () => {
  const packages = ['xvfb', 'xauth'].map((name) => ({ package: name, file: `debs/${name}_1_arm64.deb`, architecture: 'arm64', size: 10, sha256: 'a'.repeat(64) }));
  const valid = { complete: true, architecture: 'arm64', packages };
  validateRuntime(valid);
  assert.throws(() => validateRuntime({ ...valid, complete: false }), /齐全/);
  assert.throws(() => validateRuntime({ ...valid, architecture: 'x64' }), /arm64/);
  assert.throws(() => validateRuntime({ ...valid, packages: packages.slice(0, 1) }), /xauth/);
  assert.throws(() => validateRuntime({ ...valid, packages: [{ ...packages[0], file: '../host.deb' }, packages[1]] }), /非法/);
  assert.throws(() => validateRuntime({ ...valid, packages: [{ ...packages[0], architecture: 'amd64' }, packages[1]] }), /架构/);
  assert.throws(() => validateRuntime({ ...valid, packages: [...packages, { ...packages[0], package: 'libc6' }] }), /glibc/);
});
