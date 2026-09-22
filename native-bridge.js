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
//   startRecording(chunkDir)  → Promise<void>   starts recording; emits 'chunk-ready' every 1 min
//   stopRecording()           → Promise<{path, index}>   finalizes the last partial chunk
//   shutdown()                → void
//   Event 'chunk-ready'       → { path: string, index: number }

const { spawn }    = require('child_process');
const path         = require('path');
const readline     = require('readline');
const fs           = require('fs');
const EventEmitter = require('events');

// Shorter roll interval bounds how much unprocessed audio "stop" can land on
// — the segment still recording when the user stops is uploaded as the final
// chunk and has to be transcribed before the summary can be generated, so
// keeping it short (rather than the previous 10 min) is what makes summaries
// ready within seconds of stopping instead of minutes.
const CHUNK_DURATION_MS = 60 * 1000;

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

  // Stop the current chunk, return its finalized path. `final` tells the
  // helper whether to tear down the capture stream/mic engine (true, real
  // end of recording) or leave them running for the next chunk to reuse
  // (false, mid-recording rotation) — see AudioRecorder.swift.
  async _stopCurrentChunk(final = false) {
    const pending = this._nextMessage(60_000);
    this._proc.stdin.write(JSON.stringify({ cmd: 'stop', final }) + '\n');
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
    this._chunkIndex = 0;
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
    const finalPath  = await this._stopCurrentChunk(true);

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
//   → rotating WAV chunk files on disk
//
// Rolling: audio_capture.exe and ffmpeg are both spawned ONCE per recording
// and stay alive the whole time — we never kill/respawn either mid-recording.
// ffmpeg's own `-f segment` muxer splits the single continuous PCM stream
// into chunk-N.wav files internally, so there's no capture gap at chunk
// boundaries (matching the Mac bridge, which keeps its ScreenCaptureKit/
// AVAudioEngine stream alive across rotation and only swaps the output
// file — see AudioRecorder.swift). We detect each finalized segment via
// `-segment_list` (+ `live` flag): ffmpeg appends a line to that file the
// moment a segment's WAV header is fully written and closed — not stderr
// log scraping, which would depend on log verbosity we don't control.
class WinBridge extends EventEmitter {
  constructor() {
    super();
    this._captureProc     = null;
    this._ffmpegProc      = null;
    this._chunkDir        = null;
    this._segmentListPath = null;
    this._listWatcher     = null;
    this._processedLines  = 0;  // list lines already claimed by _readNewSegments
    this._emittedIndex    = 0;  // next index to assign to a regular chunk-ready
    this._pendingFinal    = []; // segment(s) that closed after stopRecording began
    this._stopping        = false;
    this._captureBinPath  = null;
    this._ffmpegBinPath   = null;
    this._micDevice       = null;
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

  // Read any segment-list lines we haven't claimed yet. Synchronous (no
  // await between the read and the counter bump) so this is safe to call
  // from both the directory watcher and stopRecording() without a race —
  // whichever call runs first atomically claims the new line(s).
  _readNewSegments() {
    let lines = [];
    try {
      lines = fs.readFileSync(this._segmentListPath, 'utf8')
        .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
    const newLines = lines.slice(this._processedLines);
    this._processedLines = lines.length;
    return newLines;
  }

  // Fired on every directory change and once explicitly after stopRecording
  // kills capture. Before stopRecording begins, newly-closed segments are
  // regular chunk-ready events. Once it's begun, any segment that closes as
  // a *result* of that stop is the final chunk, which stopRecording()
  // returns directly instead — buffer it there rather than emitting it.
  _onListUpdated() {
    for (const line of this._readNewSegments()) {
      if (this._stopping) {
        this._pendingFinal.push(line);
        continue;
      }
      const idx = this._emittedIndex++;
      let fileSize = 0;
      try { fileSize = fs.statSync(line).size; } catch {}
      console.log(`[win-bridge] chunk ${idx} finalized — ${fileSize} bytes`);
      this.emit('chunk-ready', { path: line, index: idx });
    }
  }

  // Spawn audio_capture.exe + ffmpeg once for the whole recording. ffmpeg's
  // segment muxer handles chunk rotation internally — no process restarts.
  // Resolves once ffmpeg's progress stats confirm it's actively recording
  // (or after a timeout fallback).
  _spawnPersistent() {
    const captureBin = this._captureBinPath;
    const ffmpegBin  = this._ffmpegBinPath;
    const mic        = this._micDevice;
    const segmentPattern = path.join(this._chunkDir, 'chunk-%d.wav');
    this._segmentListPath = path.join(this._chunkDir, 'segments.list');

    this._captureProc = spawn(captureBin, [
      '--sample-rate', '44100', '--channels', '2', '--bit-depth', '16',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this._captureProc.stderr.on('data', d => process.stderr.write('[audio_capture] ' + d));

    const segmentArgs = [
      '-f', 'segment',
      '-segment_time', String(CHUNK_DURATION_MS / 1000),
      '-segment_start_number', '0',
      '-reset_timestamps', '1',
      '-strftime', '0',
      '-segment_list', this._segmentListPath,
      '-segment_list_type', 'flat',
      '-segment_list_flags', 'live',
      '-y', segmentPattern,
    ];
    const ffmpegArgs = mic ? [
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-f', 'dshow', '-i', `audio=${mic}`,
      '-filter_complex', 'amix=inputs=2:duration=first',
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
      ...segmentArgs,
    ] : [
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
      ...segmentArgs,
    ];

    console.log(`[win-bridge] starting persistent capture → ${segmentPattern}${mic ? ' (+ mic)' : ''}`);
    this._ffmpegProc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    this._ffmpegProc.stdin.on('error', (err) => {
      console.error('[win-bridge] ffmpeg stdin error (EPIPE suppressed):', err.message);
    });
    this._captureProc.stdout.pipe(this._ffmpegProc.stdin);

    this._ffmpegProc.on('exit', (code, sig) => {
      this._ffmpegProc = null;
      if (!this._stopping) {
        console.error(`[win-bridge] ffmpeg exited unexpectedly (code=${code}, signal=${sig})`);
      }
    });

    // Watch the chunk directory (rather than the list file directly) so we
    // don't race ffmpeg creating segments.list for the first time.
    try {
      this._listWatcher = fs.watch(this._chunkDir, (_eventType, filename) => {
        if (filename && filename !== path.basename(this._segmentListPath)) return;
        this._onListUpdated();
      });
    } catch (err) {
      console.error('[win-bridge] failed to watch chunk dir:', err.message);
    }

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
      this._ffmpegProc.once('exit', (code, sig) => {
        done(new Error(`ffmpeg exited before recording started (code=${code}, signal=${sig})`));
      });
      // Resolve after 8 s regardless — some builds don't print the ready line.
      setTimeout(() => done(), 8_000);
    });
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

    this._chunkDir        = chunkDir;
    this._processedLines  = 0;
    this._emittedIndex    = 0;
    this._pendingFinal    = [];
    this._stopping        = false;
    this._captureBinPath  = captureBin;
    this._ffmpegBinPath   = ffmpegBin;
    this._micDevice       = await this._findDefaultMic(ffmpegBin);

    try {
      await this._spawnPersistent();
    } catch (err) {
      console.error('[win-bridge] startRecording failed:', err.message);
      const e = new Error(err.message);
      e.code = 'FFMPEG_UNAVAILABLE';
      throw e;
    }
  }

  async stopRecording() {
    if (!this._captureProc && !this._ffmpegProc) throw new Error('No active recording');

    this._stopping = true;

    // Kill audio_capture → its stdout EOF propagates to ffmpeg's stdin →
    // the segment muxer finalizes the current (last) segment's WAV header,
    // appends it to segments.list, and ffmpeg exits on its own.
    const ffmpegProc = this._ffmpegProc;
    await new Promise(resolve => {
      let hardKill;
      const finish = () => { clearTimeout(hardKill); resolve(); };
      if (ffmpegProc) {
        ffmpegProc.once('exit', finish);
      } else {
        finish();
      }
      try { this._captureProc?.kill(); } catch {}
      this._captureProc = null;
      try { ffmpegProc?.stdin?.end(); } catch {}
      hardKill = setTimeout(() => { try { ffmpegProc?.kill(); } catch {} finish(); }, 10_000);
    });

    try { this._listWatcher?.close(); } catch {}
    this._listWatcher = null;

    // ffmpeg has fully exited, so segments.list is guaranteed flushed —
    // pick up the just-closed final segment regardless of whether the
    // watcher already caught it.
    this._onListUpdated();

    if (this._pendingFinal.length === 0) {
      // ffmpeg didn't exit gracefully (hard-kill fallback fired), so
      // write_trailer() never ran and segments.list never got the last
      // entry appended. The file may still be on disk — fall back to the
      // expected path by naming convention rather than failing outright.
      const fallbackPath = path.join(this._chunkDir, `chunk-${this._emittedIndex}.wav`);
      if (!fs.existsSync(fallbackPath)) {
        throw new Error('No final chunk was written — segments.list has no new entries after stop.');
      }
      this._pendingFinal.push(fallbackPath);
    }
    const finalPath  = this._pendingFinal[this._pendingFinal.length - 1];
    const finalIndex = this._emittedIndex;

    let fileSize = 0;
    try { fileSize = fs.statSync(finalPath).size; } catch {}
    console.log(`[win-bridge] final chunk ${finalIndex} — ${finalPath} (${fileSize} bytes)`);
    if (fileSize === 0) {
      throw new Error(`Recording chunk ${finalIndex} is empty at ${finalPath}. Check stderr above.`);
    }

    this._chunkDir     = null;
    this._pendingFinal = [];

    return { path: finalPath, index: finalIndex };
  }

  shutdown() {
    this._stopping = true;
    try { this._listWatcher?.close(); } catch {}
    this._listWatcher = null;
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
