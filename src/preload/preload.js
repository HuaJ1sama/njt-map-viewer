'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('njt', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  loadAnnotations: () => ipcRenderer.invoke('annotations:load'),
  saveAnnotations: (data) => ipcRenderer.invoke('annotations:save', data),
  loadHotspots: () => ipcRenderer.invoke('hotspots:load'),
  saveHotspots: (data) => ipcRenderer.invoke('hotspots:save', data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  captureView: () => ipcRenderer.invoke('view:capture'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  toggleFullscreen: () => ipcRenderer.invoke('win:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('win:is-fullscreen'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
