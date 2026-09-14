import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const home = homedir();
const configPath = process.env.EMACHINE_CONFIG || join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'emachine/config.json');
const servers = [];
try {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const stateRoot = (config.stateRoot || join(home, '.local/state/emachine')).replace(/^~(?=\/)/, home);
  const machine = JSON.parse(await readFile(join(stateRoot, 'machine.json'), 'utf8'));
  servers.push({ id: machine.id, name: config.machineName || 'My machine', direct: config.directUrl, gateway: config.gatewayUrl || undefined });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(new URL('../web/dist/bootstrap.json', import.meta.url), JSON.stringify({ servers }, null, 2) + '\n');
console.log(`Client seed: ${servers.length} machine(s); no credentials included.`);
