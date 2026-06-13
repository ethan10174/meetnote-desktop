const { contextBridge, ipcRenderer } = require('electron');

// Audio capture is now handled entirely in the main process via the native
// ScreenCaptureKit bridge (native-bridge.js + resources/audio-recorder).
// The renderer just calls the IPC handlers below.

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  startRecording: () => ipcRenderer.invoke('start-recording'),

  stopRecording: (userId) => ipcRenderer.invoke('stop-recording', { userId }),

  pickAndUploadFile: () => ipcRenderer.invoke('pick-and-upload-file'),

  uploadFileBuffer: (buffer, filename, mimeType, userId) =>
    ipcRenderer.invoke('upload-file-buffer', { buffer, filename, mimeType, userId }),

  // Permission helpers — called by the frontend's onboarding modal
  requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),
  getScreenRecordingStatus: () => ipcRenderer.invoke('get-screen-recording-status'),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
});
