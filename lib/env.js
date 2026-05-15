import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function getEnvPath() {
  if (process.env.CZGS_ENV_PATH) {
    return isAbsolute(process.env.CZGS_ENV_PATH)
      ? process.env.CZGS_ENV_PATH
      : resolve(projectRoot, process.env.CZGS_ENV_PATH);
  }

  return join(projectRoot, '.env');
}
