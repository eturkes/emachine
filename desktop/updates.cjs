'use strict';
const { access } = require('node:fs/promises');
const { constants } = require('node:fs');
const { dirname, isAbsolute } = require('node:path');

async function writableAppImage(image) {
  if (!image || !isAbsolute(image)) throw new Error('Not an AppImage');
  await access(image, constants.R_OK | constants.W_OK);
  await access(dirname(image), constants.W_OK);
}

function updateError(error) {
  const detail = `${error?.code || ''} ${error?.message || ''}`;
  if (/EACCES|EPERM|EROFS/.test(detail)) return 'The AppImage location is not writable. Move it to a folder you own and try again.';
  if (/ERR_UPDATER_(CHANNEL_FILE_NOT_FOUND|LATEST_VERSION_NOT_FOUND)|404/.test(detail)) return 'The published release has no update information yet. Try again after the next release.';
  if (/checksum|sha512|ERR_CHECKSUM_MISMATCH/i.test(detail)) return 'The download failed its integrity check. Check for updates and download it again.';
  if (/ENOSPC/.test(detail)) return 'There is not enough disk space for the update. Free some space and try again.';
  return 'The update could not finish. Check your internet connection and try again.';
}

function createUpdateController({ updater, version, supported, writable = async () => {}, notify = () => {} }) {
  let state = { status: supported ? 'idle' : 'unsupported', version,
    message: supported ? 'Updates are checked only when you request them.' : 'In-app updates require the Linux AppImage.' };
  let busy = false;
  const getState = () => ({ ...state });
  const set = change => { state = { version, ...change }; notify(getState()); };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = null;
  updater.on('error', error => set({ status: 'error', message: updateError(error) }));
  updater.on('update-available', info => {
    if (state.status === 'checking') set({ status: 'available', nextVersion: info.version, message: `Version ${info.version} is available.` });
  });
  updater.on('update-not-available', () => {
    if (state.status === 'checking') set({ status: 'current', message: 'You have the latest published version.' });
  });
  updater.on('download-progress', progress => {
    if (state.status === 'downloading') {
      const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;
      set({ ...state, percent, message: `Downloading version ${state.nextVersion}: ${percent}%.` });
    }
  });
  updater.on('update-downloaded', info => {
    if (state.status === 'downloading') set({ status: 'downloaded', nextVersion: info.version,
      message: `Version ${info.version} is ready. Save work in your open views before restarting.` });
  });
  async function run(action) {
    if (!supported || busy || state.status === 'installing') return getState();
    if (action === 'check' && !['idle', 'current', 'available', 'error'].includes(state.status)) return getState();
    if (action === 'download' && state.status !== 'available') return getState();
    if (action === 'install' && state.status !== 'downloaded') return getState();
    if (!['check', 'download', 'install'].includes(action)) throw new Error('Unknown update action');
    busy = true;
    try {
      if (action === 'check') {
        set({ status: 'checking', message: 'Checking GitHub Releases...' });
        const result = await updater.checkForUpdates();
        if (!result) throw new Error('The updater is unavailable');
      } else if (action === 'download') {
        const nextVersion = state.nextVersion;
        set({ status: 'downloading', nextVersion, percent: 0, message: `Downloading version ${nextVersion}...` });
        await writable();
        await updater.downloadUpdate();
      } else {
        await writable();
        set({ status: 'installing', nextVersion: state.nextVersion, message: 'Restarting to install the update...' });
        updater.quitAndInstall(false, true);
      }
    } catch (error) { set({ status: 'error', message: updateError(error) }); }
    finally { busy = false; }
    return getState();
  }
  return { getState, check: () => run('check'), download: () => run('download'), install: () => run('install') };
}

function registerUpdateIpc(ipcMain, window, controller) {
  for (const action of ['getState', 'check', 'download', 'install']) {
    ipcMain.handle(`emachine:update:${action}`, event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== 'emachine://app/index.html') throw new Error('Update access denied');
      return controller[action]();
    });
  }
}
module.exports = { createUpdateController, registerUpdateIpc, writableAppImage };
