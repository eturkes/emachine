'use strict';
const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.href === 'emachine://app/index.html') {
  const documentToken = ipcRenderer.invoke('emachine:interface:documentToken');
  contextBridge.exposeInMainWorld('emachineInterface', {
    getState: () => ipcRenderer.invoke('emachine:interface:getState'),
    setSource: source => ipcRenderer.invoke('emachine:interface:setSource', source),
    check: () => ipcRenderer.invoke('emachine:interface:check'),
    refresh: () => ipcRenderer.invoke('emachine:interface:refresh'),
    restore: () => ipcRenderer.invoke('emachine:interface:restore'),
    ready: () => documentToken.then(token => ipcRenderer.invoke('emachine:interface:ready', token)),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('emachine:interface:state', listener);
      return () => ipcRenderer.removeListener('emachine:interface:state', listener);
    },
  });
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
