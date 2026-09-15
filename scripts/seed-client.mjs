import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function clientSeed({ mode = process.env.EMACHINE_CLIENT_SEED || 'local', home = homedir(),
  configPath = process.env.EMACHINE_CONFIG || join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'emachine/config.json') } = {}) {
  // Release builds must not inspect the build machine's configuration, even when it exists.
  if (mode === 'empty') return { servers: [] };
  if (mode !== 'local') throw new Error('Unknown client seed mode. Use local or empty.');
  const servers = [];
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const stateRoot = (config.stateRoot || join(home, '.local/state/emachine')).replace(/^~(?=\/)/, home);
    const machine = JSON.parse(await readFile(join(stateRoot, 'machine.json'), 'utf8'));
    servers.push({ id: machine.id, name: config.machineName || 'My machine', direct: config.directUrl, gateway: config.gatewayUrl || undefined });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { servers };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const seed = await clientSeed();
  await writeFile(new URL('../web/dist/bootstrap.json', import.meta.url), JSON.stringify(seed, null, 2) + '\n');
  console.log(`Client seed: ${seed.servers.length} machine(s); no credentials included.`);
}
