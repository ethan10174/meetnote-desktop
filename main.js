process.env.PATH = '/opt/homebrew/bin:' + process.env.PATH;

const {
  app, BrowserWindow, ipcMain,
  session, systemPreferences, dialog, Notification, shell,
} = require('electron');
const nativeBridge = require('./native-bridge');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const { execSync }   = require('child_process');
const http           = require('http');

const NEXT_URL    = 'https://meeting-frontend-ashy.vercel.app';
const BACKEND_URL = 'https://meeting-backend-production-ca80.up.railway.app/upload';

let oauthServer = null; // loopback HTTP server used during OAuth

// Starts a temporary HTTP server on a random port.
// Returns { port, server, tokenPromise } where tokenPromise resolves with
// { hash, search } once the browser posts back the OAuth callback fragment.
function startOAuthServer() {
  return new Promise((resolve, reject) => {
    let resolveToken, rejectToken;
    const tokenPromise = new Promise((res, rej) => { resolveToken = res; rejectToken = rej; });

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');

      if (reqUrl.pathname === '/callback') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MeetNote Sign In</title></head>
<body style="font-family:system-ui;max-width:400px;margin:80px auto;text-align:center">
<h2>Completing sign in...</h2>
<script>
fetch('/done', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hash: location.hash, search: location.search })
}).then(() => {
  document.body.innerHTML = '<h2 style="color:#22c55e">&#10003; Authentication complete</h2><p>You can close this tab and return to MeetNote.</p>';
}).catch(() => {
  document.body.innerHTML = '<h2 style="color:#ef4444">Something went wrong</h2><p>Please try signing in again.</p>';
});
</script>
</body></html>`);
        return;
      }

      if (reqUrl.pathname === '/done' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          try { resolveToken(JSON.parse(body)); } catch { resolveToken({}); }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    // Abort if the user never completes the OAuth flow
    const timeout = setTimeout(() => {
      rejectToken(new Error('OAuth timeout after 5 minutes'));
      server.close();
    }, 5 * 60 * 1000);
    tokenPromise.finally(() => clearTimeout(timeout));

    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, server, tokenPromise });
    });
    server.on('error', reject);
  });
}

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

  wc.once('did-finish-load', () => {
    wc.executeJavaScript('Notification.requestPermission()').catch(() => {});
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (url.includes('calendar.google.com') || url.includes('outlook.')) {
      shell.openExternal(url);
    } else {
      win.loadURL(url);
    }
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    // Intercept Supabase OAuth — redirect_to is rewritten to our loopback server
    // so the token comes back to us instead of a remote URL.
    if (url.includes('supabase.co/auth/v1/authorize')) {
      event.preventDefault();
      (async () => {
        try {
          if (oauthServer) { oauthServer.close(); oauthServer = null; }

          const { port, server, tokenPromise } = await startOAuthServer();
          oauthServer = server;

          const parsed = new URL(url);
          parsed.searchParams.set('redirect_to', `http://127.0.0.1:${port}/callback`);
          shell.openExternal(parsed.toString());

          const { hash, search } = await tokenPromise;
          const fragment = hash || search || '';
          win.loadURL(`https://app.trymeetnote.com/dashboard${fragment}`);

          oauthServer.close();
          oauthServer = null;
        } catch (err) {
          console.error('[oauth]', err.message);
        }
      })();
      return;
    }

    // Fallback: if Google somehow ends up in Electron, push it to the browser
    if (url.includes('accounts.google.com')) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }

    const allowed =
      url.includes('dpikisphgxwcysvvvltf.supabase.co') ||
      url.includes(NEXT_URL) ||
      url.includes('app.trymeetnote.com') ||
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

// ── IPC: permissions (called by the frontend's onboarding modal) ──────────────
ipcMain.handle('request-mic-permission', async () => {
  if (process.platform !== 'darwin') return 'granted';
  const ok = await systemPreferences.askForMediaAccess('microphone');
  return ok ? 'granted' : 'denied';
});

ipcMain.handle('open-screen-recording-settings', () => {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  );
});

ipcMain.handle('get-screen-recording-status', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
});

// ── IPC: start recording — native ScreenCaptureKit bridge ────────────────────
let currentRecordingPath = null;

ipcMain.handle('start-recording', async (_event) => {
  try {
    currentRecordingPath = path.join(os.tmpdir(), `meetnote-${Date.now()}.wav`);
    await nativeBridge.startRecording(currentRecordingPath);
    return { ok: true };
  } catch (err) {
    console.error('[start-recording]', err.message);
    return { error: err.message };
  }
});

// ── IPC: stop recording, read WAV from disk, upload to backend ────────────────
ipcMain.handle('stop-recording', async (_event, { userId } = {}) => {
  const wavPath = currentRecordingPath;
  currentRecordingPath = null;
  try {
    const finishedPath = await nativeBridge.stopRecording();
    const fileBuffer   = fs.readFileSync(finishedPath);
    const formData     = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), 'recording.wav');
    if (userId) formData.append('user_id', userId);

    const res = await fetch(BACKEND_URL, { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[stop-recording]', err.message);
    return { error: err.message };
  } finally {
    const p = wavPath || currentRecordingPath;
    if (p) fs.unlink(p, () => {});
  }
});

// ── IPC: upload a file buffer sent from the renderer directly to backend ─────
// Lets the Vercel frontend bypass its own upload limit by handing the raw bytes
// to the main process, which posts them straight to Railway.
ipcMain.handle('upload-file-buffer', async (_event, { buffer, filename, mimeType, userId }) => {
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), filename);
  if (userId) formData.append('user_id', userId);
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

ipcMain.handle('open-notification-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
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
      console.log('[isMeetingRunning] Zoom detected');
      return true;
    } catch {
      console.log('[isMeetingRunning] Zoom not running');
    }

    // Google Meet in Chrome
    try {
      const out = execSync(`osascript "${MEET_SCRIPT_PATH}"`, { encoding: 'utf8' }).trim();
      console.log('[isMeetingRunning] AppleScript result:', out);
      if (out === 'found') return true;
    } catch (err) {
      console.log('[isMeetingRunning] AppleScript error:', err.message);
    }

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
    console.log('[checkAndNotify] checking... meetingActive=%s hasNotified=%s', meetingActive, hasNotifiedForMeeting);
    const running = isMeetingRunning();
    console.log('[checkAndNotify] isMeetingRunning returned:', running);

    if (running && !meetingActive) {
      // Meeting just started
      console.log('[checkAndNotify] meeting started');
      meetingActive         = true;
      hasNotifiedForMeeting = false;
    } else if (!running && meetingActive) {
      // Meeting just ended — reset so the next meeting triggers a new notification
      console.log('[checkAndNotify] meeting ended — resetting state');
      meetingActive         = false;
      hasNotifiedForMeeting = false;
      return;
    }

    if (meetingActive && !hasNotifiedForMeeting) {
      console.log('[checkAndNotify] sending notification');
      hasNotifiedForMeeting = true;
      if (process.platform === 'darwin') app.dock.bounce('critical');
      const n = new Notification({
        title:    'Meeting detected',
        subtitle: 'Tap to start recording',
        body:     'A meeting is in progress. Start recording?',
        sound:    'default',
        urgency:  'critical',
        actions:  [{ type: 'button', text: 'Open MeetNote' }],
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
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  createWindow();

  if (Notification.isSupported()) {
    new Notification({ title: 'MeetNote', body: 'Meeting detection is active.', silent: true }).show();
  }

  detectionInterval = setInterval(checkAndNotify, 30_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearInterval(detectionInterval);
  nativeBridge.shutdown();
  if (oauthServer) {
    oauthServer.close();
    oauthServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
