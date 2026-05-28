const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // True when running inside Electron — use to conditionally show native recording UI
  isElectron: true,

  // Returns [{ id, name }] — pass id as chromeMediaSourceId for system audio capture
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),

  // Native mic recording (runs in main process via SoX, bypasses web permission sandbox)
  startRecording: () => ipcRenderer.invoke('start-recording'),

  // Stops recording, uploads to backend, resolves with { summary, action_items }
  stopRecording: () => ipcRenderer.invoke('stop-recording'),

  // Opens a native file picker, uploads the selected audio file directly to the backend
  pickAndUploadFile: () => ipcRenderer.invoke('pick-and-upload-file'),

  // Accepts a file as ArrayBuffer from the renderer and posts it straight to the backend.
  // Call this from the Vercel frontend to bypass Vercel's upload size limit.
  //   buffer   — ArrayBuffer of the audio file
  //   filename — e.g. 'recording.webm'
  //   mimeType — e.g. 'audio/webm'
  uploadFileBuffer: (buffer, filename, mimeType) =>
    ipcRenderer.invoke('upload-file-buffer', { buffer, filename, mimeType }),
});
