import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function manualSelector(f) {
  const control = join(f.home, 'selector-frame');
  await writeFile(control, '0');
  await writeFile(join(f.home, 'selector.py'), String.raw`import os, select, sys, termios, tty
previous = termios.tcgetattr(0)
tty.setraw(0)
active = None
size = None
try:
    while True:
        with open("selector-frame") as control:
            next_active = int(control.read())
        next_size = os.get_terminal_size(1)
        if next_active != active or next_size != size:
            prefix = "\x1b[?1049h\x1b[2J\x1b[HShared question\r\n" if active is None else "\x1b[3F\x1b[J"
            labels = ["First option", "Second option", "Third option"]
            lines = [(("> " if i == next_active else "  ") + label).ljust(next_size.columns - 1, ".") for i, label in enumerate(labels)]
            sys.stdout.write(prefix + "\r\n".join(lines + ["Use up/down"]))
            sys.stdout.flush()
            active, size = next_active, next_size
        if select.select([0], [], [], 0.025)[0]:
            if b"q" in os.read(0, 1024):
                break
finally:
    sys.stdout.write("\x1b[?1049l")
    sys.stdout.flush()
    termios.tcsetattr(0, termios.TCSANOW, previous)
`);
  const child = spawn('script', ['--quiet', '--return', '--command',
    'stty cols 100 rows 30; exec zmx attach alpha /bin/bash --noprofile --norc', '/dev/null'], {
    cwd: f.home, env: { ...f.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let text = '';
  const ended = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  child.stdout.on('data', data => {
    text = (text + data.toString('utf8')).slice(-65536);
    if (data.includes(Buffer.from('\x1b[c'))) child.stdin.write('\x1b[?1;2c');
    if (data.includes(Buffer.from('\x1b[6n'))) child.stdin.write('\x1b[1;1R');
  });
  child.stderr.on('data', data => { text = (text + data).slice(-65536); });
  child.stdin.write('python3 selector.py\r');
  return {
    get text() { return text; },
    async render(active) {
      await writeFile(control + '.next', String(active));
      await rename(control + '.next', control);
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end('\x1c');
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
      try { await ended; } finally { clearTimeout(timer); }
    },
  };
}
