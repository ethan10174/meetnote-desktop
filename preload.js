const { contextBridge, ipcRenderer } = require('electron');

// Restore persisted Supabase session into localStorage before page JS runs.
// sendSync blocks only until main returns the stored value (near-instant).
const SUPABASE_KEY = 'sb-dpikisphgxwcysvvvltf-auth-token';
try {
  const stored = ipcRenderer.sendSync('get-session-sync');
  if (stored) {
    localStorage.setItem(SUPABASE_KEY, JSON.stringify(stored));
  }
} catch {}

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

  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
});
