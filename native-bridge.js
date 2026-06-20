// native-bridge.js
// Platform-aware audio recorder bridge.
//
// macOS  → spawns the Swift audio-recorder helper (ScreenCaptureKit + AVAudioEngine)
// Windows → spawns audio_capture.exe (WASAPI loopback) piped into ffmpeg:
//             • Mic found via DirectShow: system audio + mic mixed via amix
//             • No mic found:             system audio (WASAPI loopback) only
//             • audio_capture.exe missing or ffmpeg missing: throws err.code = 'FFMPEG_UNAVAILABLE'
//               so main.js can signal the renderer to use browser MediaRecorder
//
// Both bridges expose the same interface:
//   startRecording(chunkDir)  → Promise<void>   starts recording; emits 'chunk-ready' every 10 min
//   stopRecording()           → Promise<{path, index}>   finalizes the last partial chunk
//   shutdown()                → void
//   Event 'chunk-ready'       → { path: string, index: number }

const { spawn }    = require('child_process');
const path         = require('path');
const readline     = require('readline');
const fs           = require('fs');
const EventEmitter = require('events');

const CHUNK_DURATION_MS = 10 * 60 * 1000;

// ── macOS bridge (Swift binary via stdin/stdout JSON protocol) ────────────────

class MacBridge extends EventEmitter {
  constructor() {
    super();
    this._proc        = null;
    this._rl          = null;
    this._chunkDir    = null;
    this._chunkIndex  = 0;
    this._chunkTimer  = null;
    this._activeRoll  = null; // Promise<void> while a roll is in progress
  }

  _binaryPath() {
    const { app } = require('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'audio-recorder');
    return path.join(__dirname, 'resources', 'audio-recorder');
  }

  _chunkPath(n) {
    return path.join(this._chunkDir, `chunk-${n}.wav`);
  }

  _ensureProcess() {
    if (this._proc && this._proc.exitCode === null) return;

    const bin = this._binaryPath();
    if (!fs.existsSync(bin)) {
      throw new Error(
        `Native audio recorder not found at ${bin}.\n` +
        'Run "npm run build-native" (or "bash build-native.sh") first.'
      );
    }

    this._proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    this._rl = readline.createInterface({ input: this._proc.stdout, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      try { this.emit('_msg', JSON.parse(line)); }
      catch { console.error('[native-bridge] invalid JSON from helper:', line); }
    });

    this._proc.stderr.on('data', (d) => process.stderr.write('[audio-recorder] ' + d));
    this._proc.on('exit', (code, signal) => {
      console.log(`[native-bridge] helper exited (code=${code}, signal=${signal})`);
      this._proc = null;
      this._rl   = null;
    });
  }

  _nextMessage(timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('_msg', onMsg);
        reject(new Error('Timeout waiting for audio-recorder response'));
      }, timeoutMs);
      const onMsg = (msg) => { clearTimeout(timer); resolve(msg); };
      this.once('_msg', onMsg);
    });
  }

  // Send the start command for the current chunk index.
  async _startChunk() {
    const pending = this._nextMessage(30_000);
    this._proc.stdin.write(JSON.stringify({ cmd: 'start', output: this._chunkPath(this._chunkIndex) }) + '\n');
    const msg = await pending;
    if (msg.status === 'error') throw new Error(msg.message);
  }

  // Stop the current chunk, return its finalized path.
  async _stopCurrentChunk() {
    const pending = this._nextMessage(60_000);
    this._proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
    const msg = await pending;
    if (msg.status === 'error') throw new Error(msg.message);
    return msg.path;
  }

  // Called by the 10-minute timer. Finalizes the current chunk, starts the next one.
  _rollChunk() {
    if (this._activeRoll) return; // re-entry guard
    this._activeRoll = this._doRoll().finally(() => { this._activeRoll = null; });
  }

  async _doRoll() {
    const finishedIndex = this._chunkIndex;
    let   finishedPath;
    try {
      finishedPath = await this._stopCurrentChunk();
    } catch (err) {
      console.error('[mac-bridge] error stopping chunk for roll:', err.message);
      return;
    }

    this._chunkIndex++;

    // Emit before starting next chunk so the upload can proceed in parallel.
    this.emit('chunk-ready', { path: finishedPath, index: finishedIndex });

    try {
      await this._startChunk();
    } catch (err) {
      console.error('[mac-bridge] error starting next chunk:', err.message);
      return;
    }

    this._chunkTimer = setTimeout(() => this._rollChunk(), CHUNK_DURATION_MS);
  }

  async startRecording(chunkDir) {
    this._chunkDir   = chunkDir;
    this._chunkIndex = 1;
    this._ensureProcess();
    await this._startChunk();
    this._chunkTimer = setTimeout(() => this._rollChunk(), CHUNK_DURATION_MS);
  }

  async stopRecording() {
    clearTimeout(this._chunkTimer);
    this._chunkTimer = null;
    if (this._activeRoll) await this._activeRoll;

    if (!this._proc) throw new Error('No active recording process');

    const finalIndex = this._chunkIndex;
    const finalPath  = await this._stopCurrentChunk();

    this._chunkDir   = null;
    this._chunkIndex = 0;

    return { path: finalPath, index: finalIndex };
  }

  shutdown() {
    clearTimeout(this._chunkTimer);
    if (this._proc) {
      try { this._proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch {}
      this._proc = null;
    }
  }
}

// ── Windows bridge (audio_capture.exe WASAPI loopback + ffmpeg WAV mux) ──────
//
// audio_capture.exe (WASAPI loopback) → raw PCM stdout
//   → piped into ffmpeg stdin as s16le 44100 2ch (system audio)
//   + ffmpeg DirectShow mic input (best-effort; omitted if no mic found)
//   → WAV chunk file on disk
//
// Rolling: kill audio_capture → its stdout EOF propagates to ffmpeg stdin →
// ffmpeg finalises the WAV header and exits cleanly. Then spawn fresh pair.

class WinBridge extends EventEmitter {
  constructor() {
    super();
    this._captureProc    = null;
    this._ffmpegProc     = null;
    this._chunkDir       = null;
    this._chunkIndex     = 0;
    this._chunkTimer     = null;
    this._activeRoll     = null;
    // Cached on first startRecording so rolls don't re-enumerate.
    this._captureBinPath = null;
    this._ffmpegBinPath  = null;
    this._micDevice      = null;
  }

  // Locate audio_capture.exe: resources folder (packaged) or native/ subdir (dev).
  _captureBin() {
    const { app } = require('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'audio_capture.exe');
    return path.join(__dirname, 'native', 'audio_capture.exe');
  }

  // Locate ffmpeg: resources folder first (packaged), then ffmpeg-static (dev), then PATH.
  _ffmpegBin() {
    if (process.resourcesPath) {
      const p = path.join(process.resourcesPath, 'ffmpeg.exe');
      if (fs.existsSync(p)) return p;
    }
    try {
      const bundled = require('ffmpeg-static');
      if (bundled && fs.existsSync(bundled)) return bundled;
    } catch {}
    const { execSync } = require('child_process');
    try {
      return execSync('where ffmpeg', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)[0].trim();
    } catch {}
    for (const loc of ['C:\\ffmpeg\\bin\\ffmpeg.exe', path.join(__dirname, 'ffmpeg.exe')]) {
      if (fs.existsSync(loc)) return loc;
    }
    return null;
  }

  // Return the name of the first real microphone found via DirectShow, or null.
  _findDefaultMic(ffmpegBin) {
    return new Promise(resolve => {
      const p = spawn(ffmpegBin, ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let out = '';
      p.stderr.on('data', d => { out += d.toString(); });
      p.on('close', () => {
        const devices = [];
        const re = /"([^"]+)"\s*\(audio\)/g;
        let m;
        while ((m = re.exec(out)) !== null) devices.push(m[1]);
        const mic = devices.find(d => !/stereo mix|wave out mix|what u hear/i.test(d)) ?? null;
        console.log('[win-bridge] DirectShow audio devices:', devices, '→ mic:', mic ?? '(none)');
        resolve(mic);
      });
    });
  }

  _chunkPath(n) {
    return path.join(this._chunkDir, `chunk-${n}.wav`);
  }

  // Spawn audio_capture.exe + ffmpeg for a single chunk output file.
  // Resolves when ffmpeg signals it is actively recording.
  _spawnChunk(outputPath) {
    const captureBin = this._captureBinPath;
    const ffmpegBin  = this._ffmpegBinPath;
    const mic        = this._micDevice;

    this._captureProc = spawn(captureBin, [
      '--sample-rate', '44100', '--channels', '2', '--bit-depth', '16',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this._captureProc.stderr.on('data', d => process.stderr.write('[audio_capture] ' + d));

    const ffmpegArgs = mic ? [
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-f', 'dshow', '-i', `audio=${mic}`,
      '-filter_complex', 'amix=inputs=2:duration=first',
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
      '-y', outputPath,
    ] : [
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
      '-y', outputPath,
    ];

    console.log(`[win-bridge] spawning chunk → ${outputPath}${mic ? ' (+ mic)' : ''}`);
    this._ffmpegProc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    this._captureProc.stdout.pipe(this._ffmpegProc.stdin);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const done = (err) => { if (!resolved) { resolved = true; err ? reject(err) : resolve(); } };

      this._ffmpegProc.stderr.on('data', d => {
        const text = d.toString();
        process.stderr.write('[ffmpeg] ' + text);
        if (/Press \[q\]|size=\s*\d+kB/i.test(text)) done();
      });
      this._captureProc.on('error', done);
      this._ffmpegProc.on('error', done);
      this._ffmpegProc.on('exit', (code, sig) => {
        this._ffmpegProc = null;
        done(new Error(`ffmpeg exited before recording started (code=${code}, signal=${sig})`));
      });
      // Resolve after 8 s regardless — some builds don't print the ready line.
      setTimeout(() => done(), 8_000);
    });
  }

  // Gracefully stop the current chunk: kill audio_capture → EOF → ffmpeg writes WAV trailer.
  _stopCurrentChunk() {
    return new Promise(resolve => {
      if (this._ffmpegProc) {
        this._ffmpegProc.once('exit', () => { this._ffmpegProc = null; resolve(); });
      } else {
        resolve();
      }
      try { this._captureProc?.kill(); } catch {}
      this._captureProc = null;
      try { this._ffmpegProc?.stdin?.end(); } catch {}
      // Hard-kill fallback after 10 s.
      setTimeout(() => { try { this._ffmpegProc?.kill(); } catch {} resolve(); }, 10_000);
    });
  }

  _rollChunk() {
    if (this._activeRoll) return; // re-entry guard
    this._activeRoll = this._doRoll().finally(() => { this._activeRoll = null; });
  }

  async _doRoll() {
    const finishedPath  = this._chunkPath(this._chunkIndex);
    const finishedIndex = this._chunkIndex;

    await this._stopCurrentChunk();

    let fileSize = 0;
    try { fileSize = fs.statSync(finishedPath).size; } catch {}
    console.log(`[win-bridge] chunk ${finishedIndex} finalized — ${fileSize} bytes`);

    this._chunkIndex++;

    // Emit before spawning next chunk so upload starts in parallel with next chunk startup.
    this.emit('chunk-ready', { path: finishedPath, index: finishedIndex });

    try {
      await this._spawnChunk(this._chunkPath(this._chunkIndex));
    } catch (err) {
      console.error('[win-bridge] error starting next chunk:', err.message);
      return;
    }

    this._chunkTimer = setTimeout(() => this._rollChunk(), CHUNK_DURATION_MS);
  }

  async startRecording(chunkDir) {
    const captureBin = this._captureBin();
    if (!fs.existsSync(captureBin)) {
      const e = new Error(`audio_capture.exe not found at ${captureBin}`);
      e.code = 'FFMPEG_UNAVAILABLE';
      throw e;
    }

    const ffmpegBin = this._ffmpegBin();
    if (!ffmpegBin) {
      const e = new Error('ffmpeg not found. Install ffmpeg and add it to PATH.');
      e.code = 'FFMPEG_UNAVAILABLE';
      throw e;
    }

    this._chunkDir       = chunkDir;
    this._chunkIndex     = 1;
    this._captureBinPath = captureBin;
    this._ffmpegBinPath  = ffmpegBin;
    this._micDevice      = await this._findDefaultMic(ffmpegBin);

    await this._spawnChunk(this._chunkPath(1));
    this._chunkTimer = setTimeout(() => this._rollChunk(), CHUNK_DURATION_MS);
  }

  async stopRecording() {
    if (!this._captureProc && !this._ffmpegProc) throw new Error('No active recording');

    clearTimeout(this._chunkTimer);
    this._chunkTimer = null;
    if (this._activeRoll) await this._activeRoll;

    const finalPath  = this._chunkPath(this._chunkIndex);
    const finalIndex = this._chunkIndex;

    await this._stopCurrentChunk();

    let fileSize = 0;
    try { fileSize = fs.statSync(finalPath).size; } catch {}
    console.log(`[win-bridge] final chunk ${finalIndex} — ${finalPath} (${fileSize} bytes)`);
    if (fileSize === 0) {
      throw new Error(`Recording chunk ${finalIndex} is empty at ${finalPath}. Check stderr above.`);
    }

    this._chunkDir   = null;
    this._chunkIndex = 0;

    return { path: finalPath, index: finalIndex };
  }

  shutdown() {
    clearTimeout(this._chunkTimer);
    try { this._captureProc?.kill(); } catch {}
    try { this._ffmpegProc?.kill(); } catch {}
    this._captureProc = null;
    this._ffmpegProc  = null;
  }
}

// ── Export the right bridge for the current platform ─────────────────────────

if (process.platform === 'darwin') {
  module.exports = new MacBridge();
} else if (process.platform === 'win32') {
  module.exports = new WinBridge();
} else {
  // Linux / other: surface a clear error rather than crashing
  module.exports = {
    startRecording() { throw Object.assign(new Error('Audio capture not supported on this platform.'), { code: 'FFMPEG_UNAVAILABLE' }); },
    stopRecording()  { throw new Error('No active recording'); },
    shutdown()       {},
  };
}
