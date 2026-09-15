'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.href === 'emachine://app/index.html') {
  contextBridge.exposeInMainWorld('emachineUpdates', {
    getState: () => ipcRenderer.invoke('emachine:update:getState'),
    check: () => ipcRenderer.invoke('emachine:update:check'),
    download: () => ipcRenderer.invoke('emachine:update:download'),
    install: () => ipcRenderer.invoke('emachine:update:install'),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('emachine:update:state', listener);
      return () => ipcRenderer.removeListener('emachine:update:state', listener);
    },
  });
}
