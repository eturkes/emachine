'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const channel = process.argv.find(arg => arg.startsWith('emachine-auth-'));
contextBridge.exposeInMainWorld('gatewayLogin', {
  submit: (username, password) => { if (channel) ipcRenderer.send(channel, { username, password }); },
  cancel: () => { if (channel) ipcRenderer.send(channel, null); },
});
