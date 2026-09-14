import { access, mkdir, writeFile, readFile, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const image = join(root, `desktop/release/emachine-${version}-x86_64.AppImage`);
await access(image);
const home = homedir();
const binaryDir = join(home, '.local/bin');
const applications = join(process.env.XDG_DATA_HOME || join(home, '.local/share'), 'applications');
await mkdir(binaryDir, { recursive: true }); await mkdir(applications, { recursive: true });
const launcher = join(binaryDir, 'emachine-app');
const entry = join(applications, 'emachine.desktop');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function owned(path, contents, mode) {
  try { if (!(await readFile(path, 'utf8')).includes('# emachine managed')) throw new Error(`Refusing to replace an unrelated file: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = path + '.pending-' + randomUUID();
  await writeFile(pending, contents, { mode }); await rename(pending, path); await chmod(path, mode);
}
await owned(launcher, `#!/bin/sh\n# emachine managed desktop launcher\n# Extraction also supports systems without a FUSE mount helper.\nexport APPIMAGE_EXTRACT_AND_RUN=1\nexec ${quote(image)} "$@"\n`, 0o755);
const desktopQuote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%') + '"';
await owned(entry, `# emachine managed desktop entry
[Desktop Entry]
Type=Application
Name=emachine
Comment=Personal project command center
Exec=${desktopQuote(launcher)}
Icon=${join(root, 'web/public/icons/512.png')}
Terminal=false
Categories=Development;Utility;
StartupWMClass=emachine
`, 0o644);
console.log(`Desktop entry: ${entry}\nLauncher: ${launcher}\nAppImage: ${image}`);
