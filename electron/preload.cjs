'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Resolved synchronously in the main process: system language + whether a session file exists.
const bootstrap = ipcRenderer.sendSync('locale-bootstrap') || {};

ipcRenderer.on('native-port', (event) => {
  window.postMessage('aio-port', '*', event.ports);
});

contextBridge.exposeInMainWorld('aio', {
  initialLocale: bootstrap.locale === 'zh' || bootstrap.locale === 'en' ? bootstrap.locale : undefined,
  hasSession: Boolean(bootstrap.hasSession),
  setTitle(title) {
    ipcRenderer.send('set-title', title);
  },
  openFile() {
    return ipcRenderer.invoke('open-file');
  },
  saveFile(name, text) {
    return ipcRenderer.invoke('save-file', name, text);
  },
  readSession(name) {
    return ipcRenderer.invoke('read-session', name);
  },
  writeSession(name, text) {
    return ipcRenderer.invoke('write-session', name, text);
  },
  exportSession(data) {
    return ipcRenderer.invoke('export-session', data);
  },
  onSessionExport(handler) {
    ipcRenderer.on('session-export', () => handler());
  },
  onSessionImport(handler) {
    ipcRenderer.on('session-import', (_event, text) => handler(String(text ?? '')));
  },
  onShowAbout(handler) {
    ipcRenderer.on('show-about', () => handler());
  },
});
