import fs from 'node:fs/promises';
import path from 'node:path';

/** Resolve an isolated QQ directory beside the existing DSH default workspace. */
export async function resolveQQWorkspace(ctx, key) {
  const match = /^(private|group):([1-9]\d*)$/.exec(key);
  if (!match || typeof ctx?.workspaceRegistry?.initializeDefault !== 'function') throw new Error('QQ 工作区服务不可用');
  const existing = await ctx.workspaceRegistry.initializeDefault(async () => { throw new Error('默认工作区尚未建立'); });
  if (!existing || typeof existing.path !== 'string' || !path.isAbsolute(existing.path)) throw new Error('无法确认 DSH 默认工作区');
  const parent = path.join(path.dirname(existing.path), 'QQ');
  if (path.relative(existing.path, parent) === '') throw new Error('QQ 目录与 DSH 默认工作区重合');
  const directory = path.join(parent, `${match[1] === 'private' ? '私聊' : '群聊'}_${match[2]}`);
  for (const item of [parent, directory]) {
    try { await fs.mkdir(item); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(item) !== item) {
      throw new Error('QQ 工作区路径无效或包含符号链接');
    }
  }
  return directory;
}
