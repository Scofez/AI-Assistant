const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('avatar', {
  onSetup: listen('setup'),
  onState: listen('state'),
  onBubble: listen('bubble'),
  onSpeaking: listen('speaking'),
  onListen: listen('listen'),
  onCrowd: listen('crowd'),
  onDeliver: listen('crowd:deliver'),
  clickMini: (key) => ipcRenderer.send('crowd:click', key),
  setInteractive: (isInteractive) => ipcRenderer.send('mouse:interactive', isInteractive),
  onApproval: listen('approval'),
  onApprovalDone: listen('approval:done'),
  answerApproval: (id, isAllowed) => ipcRenderer.send('approval:answer', { id, isAllowed }),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag:move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag:end'),
  click: () => ipcRenderer.send('avatar:click'),
  askMic: () => ipcRenderer.invoke('voice:mic'),
  onToggles: listen('toggles'),
  toggle: (name) => ipcRenderer.send('toggle', name),
  sendHeard: (wav, seconds) => ipcRenderer.send('voice:heard', { wav, seconds }),
});
