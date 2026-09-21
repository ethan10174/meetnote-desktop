const { contextBridge, ipcRenderer, shell } = require('electron');

// Audio capture is now handled entirely in the main process via the native
// ScreenCaptureKit bridge (native-bridge.js + resources/audio-recorder).
// The renderer just calls the IPC handlers below.

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  startRecording: (meetingId) => ipcRenderer.invoke('start-recording', { meetingId }),

  stopRecording: (userId) => ipcRenderer.invoke('stop-recording', { userId }),

  pickAndUploadFile: () => ipcRenderer.invoke('pick-and-upload-file'),

  uploadFileBuffer: (buffer, filename, mimeType, userId, meetingId) =>
    ipcRenderer.invoke('upload-file-buffer', { buffer, filename, mimeType, userId, meetingId }),

  // Persist Supabase session to main process (electron-store)
  saveSession: (session) => ipcRenderer.invoke('save-session', session),

  // Permission helpers — called by the frontend's onboarding modal
  requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings'),
  getScreenRecordingStatus: () => ipcRenderer.invoke('get-screen-recording-status'),

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  openExternal: (url) => shell.openExternal(url),

  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),

  // Fires when a background chunk upload fails during an active recording,
  // so the UI can surface it instead of the recording silently losing audio.
  onChunkUploadError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('chunk-upload-error', listener);
    return () => ipcRenderer.removeListener('chunk-upload-error', listener);
  },
});
