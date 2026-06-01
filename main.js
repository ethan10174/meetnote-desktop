process.env.PATH = '/opt/homebrew/bin:' + process.env.PATH;

const {
  app, BrowserWindow, ipcMain, desktopCapturer,
  session, systemPreferences, dialog, Notification, shell,
} = require('electron');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const { execSync }   = require('child_process');
const recorder       = require('node-record-lpcm16');

const NEXT_URL    = 'https://meeting-frontend-ashy.vercel.app';
const BACKEND_URL = 'https://meeting-backend-production-ca80.up.railway.app/upload';

let activeRecording  = null; // { process, fileStream, filePath }
let recorderInstance = null; // the node-record-lpcm16 Recording object

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    autoHideMenuBar: true,
    title: 'MeetNote',
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
    },
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'desktopCapture', 'autoplay', 'screen'];
    callback(allowed.includes(permission));
  });

  // Inject Supabase into connect-src so the renderer can reach it without CSP errors.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const cspKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-security-policy');
    if (cspKey) {
      let csp = headers[cspKey][0];
      if (!csp.includes('dpikisphgxwcysvvvltf.supabase.co')) {
        if (/connect-src/i.test(csp)) {
          csp = csp.replace(/connect-src\s/i, 'connect-src https://dpikisphgxwcysvvvltf.supabase.co ');
        } else {
          csp += '; connect-src https://dpikisphgxwcysvvvltf.supabase.co';
        }
        headers[cspKey] = [csp];
      }
    }
    callback({ responseHeaders: headers });
  });

  win.loadURL(NEXT_URL);

  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (url.includes('calendar.google.com') || url.includes('outlook.')) {
      shell.openExternal(url);
    } else {
      win.loadURL(url);
    }
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (url.includes('accounts.google.com')) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }
    const allowed =
      url.includes('dpikisphgxwcysvvvltf.supabase.co') ||
      url.includes(NEXT_URL) ||
      (url.startsWith('file://') && url.includes('frontend-build'));
    if (!allowed && url.startsWith('file://')) {
      event.preventDefault();
      win.loadFile(path.join(__dirname, 'frontend-build', 'index.html'));
    }
  });

  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && validatedURL.includes('/dashboard/record')) {
      setTimeout(() => win.loadURL(validatedURL), 1000);
    }
  });

  session.defaultSession.on('certificate-error', (event, wcUrl, error, certificate, callback) => {
    callback(false);
  });
}

// ── IPC: system audio sources (for renderer-side desktopCapturer use) ────────
ipcMain.handle('get-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: false,
  });
  return sources.map(({ id, name }) => ({ id, name }));
});

// ── IPC: start native mic recording ──────────────────────────────────────────
ipcMain.handle('start-recording', async () => {
  if (process.platform === 'win32') return { error: 'USE_BROWSER_RECORDER' };

  if (recorderInstance) {
    recorderInstance.stop();
    recorderInstance = null;
    await new Promise(r => setTimeout(r, 500));
  }

  const filePath   = path.join(os.tmpdir(), `meetnote-${Date.now()}.wav`);
  const fileStream = fs.createWriteStream(filePath);

  const rec = recorder.record({
    sampleRate: 16000,
    channels:   1,
    audioType:  'wav',
    recorder:   path.join(__dirname, 'sox-recorder'), // full path: /opt/homebrew/bin/sox
  });

  const audioStream = rec.stream();
  audioStream.on('error', err => console.error('[recording] stream error:', err));
  audioStream.pipe(fileStream);

  recorderInstance = rec;
  activeRecording = { process: rec, fileStream, filePath };
  return { ok: true };
});

// ── IPC: stop recording, upload to backend, return result ─────────────────────
ipcMain.handle('stop-recording', async (_event) => {
  if (!activeRecording) return { error: 'No active recording' };

  const { process: rec, fileStream, filePath } = activeRecording;
  activeRecording = null;

  recorderInstance = null;
  rec.stop();

  // Wait for the file stream to finish flushing before reading
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  let result;
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const formData   = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), 'recording.wav');

    const res = await fetch(BACKEND_URL, { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    result = await res.json();
  } finally {
    fs.unlink(filePath, () => {}); // clean up temp file regardless of upload outcome
  }

  return result;
});

// ── IPC: upload a file buffer sent from the renderer directly to backend ─────
// Lets the Vercel frontend bypass its own upload limit by handing the raw bytes
// to the main process, which posts them straight to Railway.
ipcMain.handle('upload-file-buffer', async (_event, { buffer, filename, mimeType }) => {
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(BACKEND_URL, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);
  return await res.json();
});

// ── IPC: pick an audio file and upload directly to backend ───────────────────
ipcMain.handle('pick-and-upload-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select audio file',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac', 'aac'] }],
  });

  if (canceled || filePaths.length === 0) return { canceled: true };

  const filePath = filePaths[0];
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeMap = {
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    m4a: 'audio/mp4', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  const fileBuffer = fs.readFileSync(filePath);
  const formData   = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), path.basename(filePath));

  const res = await fetch(BACKEND_URL, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Backend returned ${res.status}`);
  return await res.json();
});

// ── Meeting detection ─────────────────────────────────────────────────────────
// AppleScript to check whether any Chrome tab has meet.google.com open.
// Written once to a stable tmp path so it isn't recreated on every check.
const MEET_SCRIPT_PATH = path.join(os.tmpdir(), 'mn-meet-check.applescript');
try {
  fs.writeFileSync(MEET_SCRIPT_PATH, `\
tell application "System Events"
  if (name of processes) contains "Google Chrome" then
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if URL of t contains "meet.google.com" then
            return "found"
          end if
        end repeat
      end repeat
    end tell
  end if
end tell
return "not found"
`);
} catch {};

let meetingActive        = false; // is a meeting currently detected?
let hasNotifiedForMeeting = false; // have we shown the notification for this meeting?
let detectionInterval    = null;

function isMeetingRunning() {
  try {
    // Zoom — pgrep exits 0 if the process is found, throws otherwise
    try {
      execSync('pgrep -x "zoom.us"', { stdio: 'ignore' });
      return true;
    } catch {}

    // Google Meet in Chrome
    try {
      const out = execSync(`osascript "${MEET_SCRIPT_PATH}"`, { encoding: 'utf8' }).trim();
      if (out === 'found') return true;
    } catch {}

    return false;
  } catch {
    return false;
  }
}

function focusMainWindow() {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const win = wins[0];
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function checkAndNotify() {
  try {
    // const running = isMeetingRunning(); // disabled until permissions are properly handled

    if (running && !meetingActive) {
      // Meeting just started
      meetingActive         = true;
      hasNotifiedForMeeting = false;
    } else if (!running && meetingActive) {
      // Meeting just ended — reset so the next meeting triggers a new notification
      meetingActive         = false;
      hasNotifiedForMeeting = false;
      return;
    }

    if (meetingActive && !hasNotifiedForMeeting) {
      hasNotifiedForMeeting = true;
      const n = new Notification({
        title:   'Meeting detected',
        body:    'Meeting detected. Start recording in MeetNote?',
        actions: [{ type: 'button', text: 'Open MeetNote' }],
      });
      n.on('click',  focusMainWindow);
      n.on('action', focusMainWindow);
      n.show();
    }
  } catch (err) {
    console.error('[checkAndNotify] error:', err);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  // Trigger macOS system permission dialog for microphone before first use
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  createWindow();
  detectionInterval = setInterval(checkAndNotify, 30_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearInterval(detectionInterval);
  if (recorderInstance) {
    recorderInstance.stop();
    recorderInstance = null;
  }
  if (activeRecording) {
    activeRecording = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
