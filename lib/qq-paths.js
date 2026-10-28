import os from 'node:os';
import path from 'node:path';

export function qqDataDirectory() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'qq-session-bridge');
}
