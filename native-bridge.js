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
//   → raw PCM on ffmpeg stdout → split into chunk-N.wav files by this class
//
// Rolling: audio_capture and ffmpeg run once for the whole recording. Every
// minute we close the current WAV file (patching its header) and open the
// next one between two PCM writes, so capture never stops and no audio is
// lost at chunk boundaries. The old kill/respawn rotation dropped ~2.4 s per
// minute on Windows (Oct 2026 test: 50:15 meeting → 48:23 of audio).
//
// NOTE: an ffmpeg `-f segment` version was tried earlier and broke chunk
// uploads (detecting finished segments was unreliable), which is why the
// file splitting is done here instead: chunk-ready only fires after we've
// closed the file ourselves.
class WinBridge extends EventEmitter {
  constructor() {
    super();
    this._captureProc    = null;
    this._ffmpegProc     = null;
    this._chunkDir       = null;
    this._chunkIndex     = 0;
    this._chunkTimer     = null;
    this._chunkFd        = null;
    this._chunkBytes     = 0;
    this._pcmCarry       = Buffer.alloc(0);
    this._ffmpegDone     = null;
    // Cached on first startRecording (or warmMicCache()) so rolls — and
    // later recordings — don't re-enumerate. _micDeviceResolved is a
    // separate flag rather than checking `_micDevice !== null`, because
    // null is itself a legitimate resolved value (no mic present) — using
    // it as the "not cached yet" sentinel would make every machine with no
    // mic re-enumerate on every single recording, defeating the cache.
    this._captureBinPath  = null;
    this._ffmpegBinPath   = null;
    this._micDevice       = null;
    this._micDeviceResolved = false;
  }

  // Pre-resolves the default mic outside the recording-start critical path
  // — _findDefaultMic() spawns a full ffmpeg subprocess to walk DirectShow
  // devices, which is the ~3s Windows pays at the start of every recording
  // otherwise. Call this once at app startup; startRecording() below then
  // finds the cache already warm and skips enumeration entirely. Safe to
  // call multiple times (a no-op once resolved) and swallows its own
  // errors since this runs in the background, unprompted by the user —
  // worst case on failure is startRecording() enumerating fresh like today.
  async warmMicCache() {
    if (this._micDeviceResolved) return;
    const ffmpegBin = this._ffmpegBin();
    if (!ffmpegBin) return; // startRecording() will surface the real error later
    try {
      this._micDevice = await this._findDefaultMic(ffmpegBin);
      this._micDeviceResolved = true;
      console.log('[win-bridge] mic cache warmed at startup — mic:', this._micDevice ?? '(none)');
    } catch (err) {
      console.error('[win-bridge] mic cache warm-up failed (will enumerate on first recording instead):', err.message);
    }
  }

  // Called when the renderer reports navigator.mediaDevices.ondevicechange
  // (relayed over IPC — see main.js's 'audio-devices-changed' handler).
  // Clears the cache so the next startRecording() re-enumerates instead of
  // handing back a mic that was just plugged in or unplugged.
  invalidateMicCache() {
    console.log('[win-bridge] audio devices changed — invalidating cached mic');
    this._micDevice = null;
    this._micDeviceResolved = false;
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

  // Spawn audio_capture.exe + ffmpeg ONCE for the whole recording. ffmpeg
  // mixes system audio (+ mic) and writes raw PCM to stdout; we split that
  // stream into chunk WAV files ourselves (see _onPcm/_rollChunk), so a
  // rotation never stops capture. Resolves when ffmpeg signals it is
  // actively recording.
  _spawnCapture() {
    const captureBin = this._captureBinPath;
    const ffmpegBin  = this._ffmpegBinPath;
    const mic        = this._micDevice;

    this._captureProc = spawn(captureBin, [
      '--sample-rate', '44100', '--channels', '2', '--bit-depth', '16',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this._captureProc.stderr.on('data', d => process.stderr.write('[audio_capture] ' + d));

    // With a mic present, the dshow input is a live device with no EOF of
    // its own — only pipe:0 (system audio) gets one when we kill
    // audio_capture at stop. `duration=first` ends the amix output once
    // pipe:0 ends, and `-shortest` makes the ffmpeg process itself exit
    // instead of hanging on the still-live mic input.
    const ffmpegArgs = mic ? [
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-f', 'dshow', '-i', `audio=${mic}`,
      '-filter_complex', 'amix=inputs=2:duration=first',
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
      '-shortest',
      '-f', 's16le', 'pipe:1',
    ] : [
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
      '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
      '-f', 's16le', 'pipe:1',
    ];

    console.log(`[win-bridge] spawning continuous capture${mic ? ' (+ mic)' : ''}`);
    const spawnedAt = Date.now();
    const proc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    this._ffmpegProc = proc;
    proc.stdin.on('error', (err) => {
      console.error('[win-bridge] ffmpeg stdin error (EPIPE suppressed):', err.message);
    });
    this._captureProc.stdout.pipe(proc.stdin);
    proc.stdout.on('data', (buf) => this._onPcm(buf));
    this._ffmpegDone = new Promise(res => proc.stdout.once('close', res));

    return new Promise((resolve, reject) => {
      let resolved = false;
      const done = (err) => {
        if (resolved) return;
        resolved = true;
        console.log(`[win-bridge] capture start resolved in ${Date.now() - spawnedAt}ms${err ? ' (error: ' + err.message + ')' : ''}`);
        err ? reject(err) : resolve();
      };

      proc.stderr.on('data', d => {
        const text = d.toString();
        process.stderr.write('[ffmpeg] ' + text);
        if (/Press \[q\]|size=\s*\d+kB/i.test(text)) done();
      });
      this._captureProc.on('error', done);
      proc.on('error', done);
      proc.on('exit', (code, sig) => {
        if (this._ffmpegProc === proc) this._ffmpegProc = null;
        if (resolved && this._chunkDir) {
          console.error(`[win-bridge] ffmpeg exited mid-recording (code=${code}, signal=${sig})`);
        }
        done(new Error(`ffmpeg exited before recording started (code=${code}, signal=${sig})`));
      });
      // Resolve after 2 s regardless — some builds don't print the ready line.
      setTimeout(() => done(), 2_000);
    });
  }

  // Open chunk N for writing with a placeholder WAV header; sizes are
  // patched in by _closeChunk once the chunk's length is known.
  _openChunk(n) {
    const p = this._chunkPath(n);
    this._chunkFd    = fs.openSync(p, 'w');
    this._chunkBytes = 0;
    fs.writeSync(this._chunkFd, wavHeader(0));
    return p;
  }

  // Patch the WAV header with the real data size and close the file.
  // Returns the number of PCM bytes in the chunk.
  _closeChunk() {
    if (this._chunkFd === null) return 0;
    const bytes = this._chunkBytes;
    fs.writeSync(this._chunkFd, wavHeader(bytes), 0, WAV_HEADER_BYTES, 0);
    fs.closeSync(this._chunkFd);
    this._chunkFd = null;
    return bytes;
  }

  // Append PCM from ffmpeg to the current chunk. Only whole sample frames
  // are written so every chunk starts on a frame boundary; any partial
  // frame is carried over to the next write (or the next chunk).
  _onPcm(buf) {
    if (this._chunkFd === null) return;
    const data = this._pcmCarry.length ? Buffer.concat([this._pcmCarry, buf]) : buf;
    const whole = data.length - (data.length % WAV_BLOCK_ALIGN);
    this._pcmCarry = data.subarray(whole);
    if (whole === 0) return;
    fs.writeSync(this._chunkFd, data, 0, whole);
    this._chunkBytes += whole;
  }

  // Called by the 1-minute timer. Closes the current chunk and opens the
  // next one synchronously between two PCM writes, so no audio is dropped
  // at the boundary — capture never stops.
  _rollChunk() {
    if (this._chunkFd === null) return;
    const finishedIndex = this._chunkIndex;
    const finishedPath  = this._chunkPath(finishedIndex);
    const bytes = this._closeChunk();
    console.log(`[win-bridge] chunk ${finishedIndex} finalized — ${bytes + WAV_HEADER_BYTES} bytes`);

    this._chunkIndex++;
    this._openChunk(this._chunkIndex);
    this.emit('chunk-ready', { path: finishedPath, index: finishedIndex });

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
    this._chunkIndex     = 0;
    this._pcmCarry       = Buffer.alloc(0);
    this._captureBinPath = captureBin;
    this._ffmpegBinPath  = ffmpegBin;
    if (!this._micDeviceResolved) {
      this._micDevice = await this._findDefaultMic(ffmpegBin);
      this._micDeviceResolved = true;
    }

    // Open chunk 0 before spawning so the first PCM bytes have somewhere to go.
    this._openChunk(0);
    try {
      await this._spawnCapture();
    } catch (err) {
      console.error('[win-bridge] startRecording failed:', err.message);
      this.shutdown();
      this._closeChunk();
      this._chunkDir = null;
      const e = new Error(err.message);
      e.code = 'FFMPEG_UNAVAILABLE';
      throw e;
    }
    this._chunkTimer = setTimeout(() => this._rollChunk(), CHUNK_DURATION_MS);
  }

  async stopRecording() {
    if (!this._captureProc && !this._ffmpegProc) throw new Error('No active recording');

    clearTimeout(this._chunkTimer);
    this._chunkTimer = null;

    const finalPath  = this._chunkPath(this._chunkIndex);
    const finalIndex = this._chunkIndex;

    // Kill audio_capture → its stdout EOF propagates to ffmpeg stdin →
    // ffmpeg flushes the remaining PCM to stdout and exits. Hard-kill after
    // 3 s if it hangs; everything already received is in the chunk file
    // and the header is patched by us, not ffmpeg, so nothing is lost.
    const proc = this._ffmpegProc;
    try { this._captureProc?.kill(); } catch {}
    this._captureProc = null;
    if (proc) {
      const hardKill = setTimeout(() => {
        console.log('[win-bridge] ffmpeg did not exit after stop (hard-kill fallback)');
        try { proc.kill(); } catch {}
      }, 3_000);
      await this._ffmpegDone;
      clearTimeout(hardKill);
    }
    this._ffmpegProc = null;

    const bytes = this._closeChunk();
    console.log(`[win-bridge] final chunk ${finalIndex} — ${finalPath} (${bytes + WAV_HEADER_BYTES} bytes)`);

    this._chunkDir   = null;
    this._chunkIndex = 0;
    this._pcmCarry   = Buffer.alloc(0);

    if (bytes === 0) {
      throw new Error(`Recording chunk ${finalIndex} is empty at ${finalPath}. Check stderr above.`);
    }

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

// 44-byte canonical WAV header for 16-bit stereo 44.1 kHz PCM, matching
// what audio_capture.exe produces.
const WAV_SAMPLE_RATE = 44100;
const WAV_CHANNELS    = 2;
const WAV_BLOCK_ALIGN = WAV_CHANNELS * 2;
const WAV_HEADER_BYTES = 44;

function wavHeader(dataBytes) {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(WAV_CHANNELS, 22);
  h.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  h.writeUInt32LE(WAV_SAMPLE_RATE * WAV_BLOCK_ALIGN, 28);
  h.writeUInt16LE(WAV_BLOCK_ALIGN, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
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
