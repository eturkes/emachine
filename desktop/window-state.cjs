'use strict';
const { readFileSync, openSync, writeFileSync, closeSync, renameSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const validSize = value => Number.isSafeInteger(value) && value > 0;
function createWindowState({ profile, workArea }) {
  const file = join(profile, 'window-state.json');
  let state = { version: 1, width: 1320, height: 860, maximized: false };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved?.version === 1 && validSize(saved.width) && validSize(saved.height) && typeof saved.maximized === 'boolean') {
      state = { version: 1, width: saved.width, height: saved.height, maximized: saved.maximized };
    }
  } catch { /* Missing or damaged preferences must not block the window. */ }
  const minWidth = Math.min(420, workArea.width), minHeight = Math.min(380, workArea.height);
  state.width = Math.max(minWidth, Math.min(state.width, workArea.width));
  state.height = Math.max(minHeight, Math.min(state.height, workArea.height));

  return {
    options: { width: state.width, height: state.height, minWidth, minHeight },
    manage(window) {
      let timer, restored = false, written, observed;
      function captureSize() {
        if (!restored || window.isDestroyed() || window.isMaximized() || window.isMinimized() || window.isFullScreen()) return;
        // On X11, getNormalBounds can report maximized dimensions after startup.
        // Capture normal resizes immediately, before a following mode transition.
        const { width, height } = window.getNormalBounds();
        // Fractional DPI can round constructor dimensions. Save only changes from
        // the native startup size, so an untouched window cannot grow on relaunch.
        if (validSize(width) && width !== observed.width) state.width = width;
        if (validSize(height) && height !== observed.height) state.height = height;
        observed = { width, height };
      }
      function save() {
        clearTimeout(timer);
        timer = undefined;
        if (!restored || window.isDestroyed()) return;
        captureSize();
        if (!window.isMinimized() && !window.isFullScreen()) state.maximized = window.isMaximized();
        const content = JSON.stringify(state) + '\n';
        if (content === written) return;
        const temporary = file + '.' + randomUUID() + '.tmp';
        let created = false;
        try {
          const descriptor = openSync(temporary, 'wx', 0o600);
          created = true;
          try { writeFileSync(descriptor, content); } finally { closeSync(descriptor); }
          renameSync(temporary, file);
          written = content;
        } catch (error) {
          console.warn('Could not save desktop window state:', error.code || error.message);
        } finally {
          if (created) { try { unlinkSync(temporary); } catch {} }
        }
      }
      function schedule() {
        if (!restored) return;
        captureSize();
        clearTimeout(timer);
        timer = setTimeout(save, 250);
      }
      for (const event of ['resize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) window.on(event, schedule);
      for (const event of ['maximize', 'unmaximize']) window.on(event, () => {
        // Some window managers clear isMaximized() while minimized/fullscreen.
        if (restored && !window.isMinimized() && !window.isFullScreen()) state.maximized = event === 'maximize';
        schedule();
      });
      window.once('ready-to-show', () => {
        observed = window.getNormalBounds();
        window.show();
        // Showing first gives the native maximize operation a normal restore rect.
        if (state.maximized) window.maximize();
        restored = true;
      });
      window.on('close', save);
      window.once('closed', () => clearTimeout(timer));
    },
  };
}

module.exports = { createWindowState };
