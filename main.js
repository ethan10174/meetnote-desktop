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

app.setName('MeetNote');

const NEXT_URL          = 'https://meeting-frontend-ashy.vercel.app';
const BACKEND_URL       = 'https://meeting-backend-production-ca80.up.railway.app/upload';
const SUPABASE_URL      = 'https://dpikisphgxwcysvvvltf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRwaWtpc3BoZ3h3Y3lzdnZ2bHRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0Mjk4NjAsImV4cCI6MjA5MzAwNTg2MH0.doJpmszT7iR96HdmXjfiDLTbPJeBm7NZvJP1YenF_6g';

let oauthServer = null; // loopback HTTP server used during OAuth
let store       = null; // electron-store instance (ESM; initialized in app.whenReady)

// ── Supabase session persistence (electron-store) ─────────────────────────────

ipcMain.on('get-session-sync', (event) => {
  event.returnValue = store ? (store.get('supabase-session') ?? null) : null;
});

ipcMain.handle('save-session', (_event, session) => {
  if (!store) return;
  if (session) {
    store.set('supabase-session', session);
    console.log('[main] Supabase session saved');
  } else {
    store.delete('supabase-session');
    console.log('[main] Supabase session cleared');
  }
});

// ── Chunk upload helper ───────────────────────────────────────────────────────
// Posts a single WAV chunk to the backend with chunk metadata as query params.
// Deletes the local file after a successful upload.
async function uploadChunk(filePath, chunkIndex, meetingId, isFinal, userId) {
  const url = new URL(BACKEND_URL);
  url.searchParams.set('chunk',       'true');
  url.searchParams.set('chunk_index', String(chunkIndex));
  url.searchParams.set('meeting_id',  meetingId);
  if (isFinal) url.searchParams.set('final', 'true');

  const fileBuffer = fs.readFileSync(filePath);
  console.log(`[uploadChunk] starting upload — meeting_id=${meetingId} chunk=${chunkIndex} isFinal=${isFinal} size=${fileBuffer.byteLength} bytes`);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), `chunk-${chunkIndex}.wav`);
  if (userId) formData.append('user_id', userId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  let res;
  try {
    res = await fetch(url.toString(), { method: 'POST', body: formData, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    console.error(`[uploadChunk] upload failed — status=${res.status} meeting_id=${meetingId} chunk=${chunkIndex}`);
    console.error(`[uploadChunk] response body:`, body);
    throw new Error(`Backend returned ${res.status}: ${body}`);
  }

  const result = await res.json();
  fs.unlink(filePath, () => {});
  return result;
}

// Wire up the chunk-ready event once (fires every 10 min during recording).
// nativeBridge is an EventEmitter on mac/win; Linux stub has no .on.
if (typeof nativeBridge.on === 'function') {
  nativeBridge.on('chunk-ready', ({ path: chunkPath, index }) => {
    // Capture meetingId synchronously — stop-recording may clear it later.
    const meetingId = currentMeetingId;
    console.log(`[main] chunk-ready: index=${index} path=${chunkPath}`);
    uploadChunk(chunkPath, index, meetingId, false, null)
      .then(r  => console.log(`[main] chunk ${index} uploaded:`, Object.keys(r)))
      .catch(err => console.error(`[main] chunk ${index} upload failed:`, err.message));
  });
}

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
<p style="color:#6b7280">Authentication complete, you can close this tab.</p>
<script>
fetch('/done', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ hash: location.hash, search: location.search })
}).finally(() => { window.close(); });
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

// ── Supabase token refresh ─────────────────────────────────────────────────────
// Called from did-finish-load to exchange a stored refresh_token for a fresh
// access_token before injecting into the renderer.  Throws on network error or
// a non-2xx response (e.g. 400 "Invalid Refresh Token" when revoked).
async function refreshSupabaseSession(refreshToken) {
  const res = await fetch(
    SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Supabase refresh ' + res.status + ': ' + body);
  }
  return res.json();
}

function createWindow() {
  const isWin = process.platform === 'win32';

  // Use the named persistent partition for this window so cookies, localStorage,
  // and Supabase auth tokens survive across app restarts.
  const ses = session.fromPartition('persist:meetnote');

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'desktopCapture', 'autoplay', 'screen'];
    callback(allowed.includes(permission));
  });

  // Inject Supabase into connect-src so the renderer can reach it without CSP errors.
  ses.webRequest.onHeadersReceived((details, callback) => {
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

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    autoHideMenuBar: true,
    title: 'MeetNote',
    icon: path.join(__dirname, 'icon.icns'),
    backgroundColor: '#ffffff',
    titleBarStyle: isWin ? 'hidden' : 'hiddenInset',
    ...(isWin && {
      titleBarOverlay: { color: '#ffffff', symbolColor: '#000000' },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: false,
      session: ses,
    },
  });

  win.loadURL(NEXT_URL);

  const wc = win.webContents;

  wc.once('did-finish-load', async () => {
    wc.executeJavaScript('Notification.requestPermission()').catch(() => {});

    // Resolve the session to inject: attempt a token refresh first so the
    // renderer always gets a valid (non-expired) access token.
    let sessionToInject = store ? (store.get('supabase-session') ?? null) : null;

    if (sessionToInject && sessionToInject.refresh_token) {
      console.log('[main] refreshing stored Supabase token for user:', sessionToInject.user && sessionToInject.user.email);
      try {
        const refreshed = await refreshSupabaseSession(sessionToInject.refresh_token);
        store.set('supabase-session', refreshed);
        sessionToInject = refreshed;
        console.log('[main] token refreshed — new expiry:', refreshed.expires_at);
      } catch (err) {
        console.warn('[main] token refresh failed:', err.message, '— clearing stored session');
        store.delete('supabase-session');
        sessionToInject = null;
      }
    } else {
      console.log('[main] did-finish-load: no stored session to refresh');
    }

    const accessToken  = sessionToInject?.access_token  ?? null;
    const refreshToken = sessionToInject?.refresh_token ?? null;
    console.log('[main] injecting session:', sessionToInject ? ('user=' + (sessionToInject.user && sessionToInject.user.email)) : 'null');

    wc.executeJavaScript(`
      (async () => {
        const KEY          = 'sb-dpikisphgxwcysvvvltf-auth-token';
        const accessToken  = ${JSON.stringify(accessToken)};
        const refreshToken = ${JSON.stringify(refreshToken)};

        if (accessToken && refreshToken) {
          if (window.__meetnoteSupabase) {
            const { error } = await window.__meetnoteSupabase.auth.setSession({
              access_token:  accessToken,
              refresh_token: refreshToken,
            });
            console.log('[renderer] setSession result:', error ? error.message : 'success');
          } else {
            console.log('[renderer] __meetnoteSupabase not found on window');
          }
        } else {
          console.log('[renderer] no session to inject — user will see login screen');
        }

        // Save whatever is in localStorage now (covers sessions the page set itself).
        const cur = localStorage.getItem(KEY);
        if (cur) { try { window.electronAPI.saveSession(JSON.parse(cur)); } catch {} }
        // Intercept future writes so every auth state change is persisted.
        const _set = Storage.prototype.setItem;
        Storage.prototype.setItem = function(k, v) {
          _set.call(this, k, v);
          if (k === KEY) { try { window.electronAPI.saveSession(JSON.parse(v)); } catch {} }
        };
        // Intercept sign-out / session removal.
        const _remove = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(k) {
          _remove.call(this, k);
          if (k === KEY) window.electronAPI.saveSession(null);
        };
        const _clear = Storage.prototype.clear;
        Storage.prototype.clear = function() {
          _clear.call(this);
          window.electronAPI.saveSession(null);
        };
      })();
    `).catch(() => {});
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

// ── IPC: start recording — chunked native bridge ─────────────────────────────
let currentRecordingDir = null;
let currentMeetingId    = null;

ipcMain.handle('start-recording', async (_event, { meetingId } = {}) => {
  console.log('[main] start-recording received at', Date.now());
  try {
    currentMeetingId    = meetingId || `meeting-${Date.now()}`;
    currentRecordingDir = path.join(os.tmpdir(), currentMeetingId);
    fs.mkdirSync(currentRecordingDir, { recursive: true });
    await nativeBridge.startRecording(currentRecordingDir);
    console.log('[main] start-recording complete — ok, meetingId:', currentMeetingId);
    return { ok: true };
  } catch (err) {
    console.error('[start-recording]', err.message);
    if (currentRecordingDir) {
      fs.rm(currentRecordingDir, { recursive: true, force: true }, () => {});
    }
    currentRecordingDir = null;
    currentMeetingId    = null;
    if (err.code === 'FFMPEG_UNAVAILABLE' || err.code === 'EPIPE') {
      console.log('[main] start-recording complete — fallbackToBrowser');
      return { fallbackToBrowser: true };
    }
    return { error: err.message };
  }
});

// ── IPC: stop recording — finalize last chunk and upload as final ─────────────
ipcMain.handle('stop-recording', async (_event, { userId } = {}) => {
  console.log('[main] stop-recording received at', Date.now());
  const recordingDir = currentRecordingDir;
  const meetingId    = currentMeetingId;
  currentRecordingDir = null;
  currentMeetingId    = null;

  // No native recording active — renderer is using browser MediaRecorder fallback.
  if (!recordingDir) return { fallbackToBrowser: true };

  let finalPath = null;
  try {
    const { path: p, index } = await nativeBridge.stopRecording();
    finalPath = p;
    console.log(`[stop-recording] final chunk ${index}:`, finalPath);

    const result = await uploadChunk(finalPath, index, meetingId, true, userId);
    console.log('[stop-recording] final chunk uploaded, result keys:', Object.keys(result));
    fs.rm(recordingDir, { recursive: true, force: true }, () => {});
    return result;
  } catch (err) {
    console.error('[stop-recording] failed:', err.message);
    return { audioPath: finalPath, uploadError: err.message };
  }
});

// ── IPC: read a local file and return its bytes to the renderer ───────────────
ipcMain.handle('read-file-buffer', async (_event, filePath) => {
  const buf = fs.readFileSync(filePath);
  // Clean up after handing the bytes to the renderer
  fs.unlink(filePath, () => {});
  return buf;
});

// ── IPC: upload a file buffer sent from the renderer directly to backend ─────
// Lets the Vercel frontend bypass its own upload limit by handing the raw bytes
// to the main process, which posts them straight to Railway.
ipcMain.handle('upload-file-buffer', async (_event, { buffer, filename, mimeType, userId, meetingId }) => {
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), filename);
  if (userId) formData.append('user_id', userId);
  if (meetingId) formData.append('meeting_id', meetingId);
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

ipcMain.handle('get-app-version', () => app.getVersion());

// ── Meeting detection ─────────────────────────────────────────────────────────
let meetingActive        = false; // is a meeting currently detected?
let hasNotifiedForMeeting = false; // have we shown the notification for this meeting?
let detectionInterval    = null;

function isMeetingRunning() {
  const apps = ['zoom.us', 'Microsoft Teams'];
  for (const app of apps) {
    try {
      execSync(`pgrep -x "${app}"`, { stdio: 'ignore' });
      console.log('[isMeetingRunning] detected:', app);
      return true;
    } catch {}
  }
  return false;
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

  const { default: Store } = await import('electron-store');
  store = new Store();

  createWindow();

  if (Notification.isSupported()) {
    new Notification({ title: 'MeetNote', body: 'Meeting detection is active.', silent: true }).show();
  }

  detectionInterval = setInterval(checkAndNotify, 30_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Explicitly save the Supabase session token before the process exits.
// This is a safety net: even if the partition clears localStorage on quit,
// electron-store survives and the preload will restore it on next launch.
let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  const win = BrowserWindow.getAllWindows()[0];
  if (!win || !store) { app.quit(); return; }

  win.webContents.executeJavaScript(`
    (() => {
      try {
        const v = localStorage.getItem('sb-dpikisphgxwcysvvvltf-auth-token');
        return v ? JSON.parse(v) : null;
      } catch { return null; }
    })()
  `).then(session => {
    const desc = session ? ('user=' + (session.user && session.user.email) + ' expires=' + session.expires_at) : 'null';
    console.log('[main] before-quit localStorage read:', desc);
    if (session) {
      store.set('supabase-session', session);
      console.log('[main] before-quit electron-store saved: user=%s', session.user?.email);
    } else {
      console.warn('[main] before-quit no session in localStorage — nothing saved');
    }
  }).catch(err => {
    console.error('[main] before-quit session save failed:', err.message);
  }).finally(() => {
    app.quit();
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
