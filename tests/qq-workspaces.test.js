import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveQQWorkspace } from '../lib/qq-workspaces.js';

test('uses the existing default workspace without creating a new DSH default', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-workspaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const defaultPath = path.join(await fs.realpath(root), 'default-workspace');
  await fs.mkdir(defaultPath);
  const ctx = { workspaceRegistry: { async initializeDefault() { return { path: defaultPath }; } } };
  assert.equal(await resolveQQWorkspace(ctx, 'private:123'), path.join(root, 'QQ', '私聊_123'));
  assert.equal(await resolveQQWorkspace(ctx, 'group:456'), path.join(root, 'QQ', '群聊_456'));
  await assert.rejects(resolveQQWorkspace(ctx, 'private:../outside'), /服务不可用/);
});

test('fails when the default workspace is missing or the QQ directory is a link', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-workspaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ctx = { workspaceRegistry: { async initializeDefault(resolve) { return resolve(); } } };
  await assert.rejects(resolveQQWorkspace(ctx, 'private:123'), /默认工作区尚未建立/);
  const defaultPath = path.join(await fs.realpath(root), 'default-workspace');
  await fs.mkdir(defaultPath);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'QQ'), process.platform === 'win32' ? 'junction' : 'dir');
  ctx.workspaceRegistry.initializeDefault = async () => ({ path: defaultPath });
  await assert.rejects(resolveQQWorkspace(ctx, 'private:123'), /符号链接/);
  ctx.workspaceRegistry.initializeDefault = async () => ({ path: path.join(root, 'QQ') });
  await assert.rejects(resolveQQWorkspace(ctx, 'private:123'), /重合/);
});
