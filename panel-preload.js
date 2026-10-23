const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('fern', {
  onLine: listen('panel:line'),
  onBusy: listen('panel:busy'),
  onFocus: listen('panel:focus'),
  onTab: listen('panel:tab'),
  onSelect: listen('panel:select'),
  onResumeList: listen('panel:resume-list'),
  onHistory: listen('panel:history'),
  resume: (id) => ipcRenderer.send('panel:resume', id),
  onApproval: listen('panel:approval'),
  onApprovalDone: listen('panel:approval-done'),
  answerApproval: (id, isAllowed) => ipcRenderer.send('approval:answer', { id, isAllowed }),
  send: (text) => ipcRenderer.send('panel:input', text),
  hide: () => ipcRenderer.send('panel:hide'),
});
