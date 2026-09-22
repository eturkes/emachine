import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
export function webkitOptions() {
  const bundled = join(root, '.tools/playwright', basename(dirname(webkit.executablePath())));
  const dependencies = join(root, '.tools/webkit-deps-noble-v1/usr/lib/x86_64-linux-gnu');
  if (!existsSync(join(bundled, 'pw_run.sh'))) {
    if (existsSync(webkit.executablePath())) return {};
    throw new Error('Run node scripts/setup-webkit.mjs before the phone browser tests.');
  }
  if (!existsSync(dependencies)) return { executablePath: join(bundled, 'pw_run.sh') };
  // The Ubuntu WPE launcher replaces LD_LIBRARY_PATH; bypass only that wrapper for Arch-local libraries.
  const wpe = join(bundled, 'minibrowser-wpe');
  return { executablePath: join(wpe, 'bin/MiniBrowser'), env: {
    ...process.env, WEBKIT_EXEC_PATH: join(wpe, 'bin'), WEBKIT_INJECTED_BUNDLE_PATH: join(wpe, 'lib'),
    WEBKIT_INSPECTOR_RESOURCES_PATH: join(wpe, 'share'),
    LD_LIBRARY_PATH: [join(wpe, 'lib'), join(wpe, 'sys/lib'), dependencies].join(':'),
  } };
}
