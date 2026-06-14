// native-bridge.js
// Platform-aware audio recorder bridge.
//
// macOS  → spawns the Swift audio-recorder helper (ScreenCaptureKit + AVAudioEngine)
// Windows → spawns ffmpeg with DirectShow inputs:
//             • Stereo Mix present: system audio + mic, mixed via amix
//             • No Stereo Mix:      mic only via dshow
//             • ffmpeg not found:   throws err.code = 'FFMPEG_UNAVAILABLE'
//               so main.js can signal the renderer to use browser MediaRecorder
//
// Both bridges expose the same three methods:
//   startRecording(outputPath) → Promise<void>
//   stopRecording()            → Promise<string>   (resolves with output file path)
//   shutdown()                 → void

const { spawn }    = require('child_process');
const path         = require('path');
const readline     = require('readline');
const fs           = require('fs');
const EventEmitter = require('events');

// ── macOS bridge (Swift binary via stdin/stdout JSON protocol) ────────────────

class MacBridge extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._rl   = null;
  }

  _binaryPath() {
    const { app } = require('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'audio-recorder');
    return path.join(__dirname, 'resources', 'audio-recorder');
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

  async startRecording(outputPath) {
    this._ensureProcess();
    const pending = this._nextMessage();
    this._proc.stdin.write(JSON.stringify({ cmd: 'start', output: outputPath }) + '\n');
    const msg = await pending;
    if (msg.status === 'error') throw new Error(msg.message);
  }

  async stopRecording() {
    if (!this._proc) throw new Error('No active recording process');
    const pending = this._nextMessage(60_000);
    this._proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
    const msg = await pending;
    if (msg.status === 'error') throw new Error(msg.message);
    return msg.path;
  }

  shutdown() {
    if (this._proc) {
      try { this._proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch {}
      this._proc = null;
    }
  }
}

// ── Windows bridge (ffmpeg + DirectShow) ─────────────────────────────────────

class WinBridge {
  constructor() {
    this._proc       = null;
    this._outputPath = null;
  }

  // Locate ffmpeg: resources folder first (packaged), then node_modules (dev), then PATH.
  _ffmpegBin() {
    // 1. Packaged app: electron-builder copies ffmpeg.exe into the resources folder.
    if (process.resourcesPath) {
      const resourcesBin = path.join(process.resourcesPath, 'ffmpeg.exe');
      if (fs.existsSync(resourcesBin)) return resourcesBin;
    }
    // 2. Dev mode: use the binary that ffmpeg-static installed into node_modules.
    try {
      const bundled = require('ffmpeg-static');
      if (bundled && fs.existsSync(bundled)) return bundled;
    } catch {}
    // 3. User-installed ffmpeg on PATH or well-known locations.
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

  // List available DirectShow audio device names.
  _listDShowDevices(bin) {
    return new Promise(resolve => {
      const p = spawn(bin, ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let out = '';
      p.stderr.on('data', d => { out += d.toString(); });
      p.on('close', () => {
        const devices = [];
        // ffmpeg prints: "Device Name" (audio)
        const re = /"([^"]+)"\s*\(audio\)/g;
        let m;
        while ((m = re.exec(out)) !== null) devices.push(m[1]);
        resolve(devices);
      });
    });
  }

  async startRecording(outputPath) {
    const bin = this._ffmpegBin();
    if (!bin) {
      const e = new Error(
        'ffmpeg not found. Install ffmpeg and add it to PATH to enable system audio capture on Windows.'
      );
      e.code = 'FFMPEG_UNAVAILABLE';
      throw e;
    }

    const devices = await this._listDShowDevices(bin);
    if (!devices.length) {
      const e = new Error('No DirectShow audio devices found.');
      e.code = 'FFMPEG_UNAVAILABLE';
      throw e;
    }

    // Identify Stereo Mix (system audio loopback) and a microphone device.
    const stereoMix = devices.find(d => /stereo mix|wave out mix|what u hear/i.test(d));
    const mic       = devices.find(d => !/stereo mix|wave out mix|what u hear/i.test(d));

    let args;
    if (stereoMix && mic) {
      console.log(`[win-bridge] system audio (${stereoMix}) + mic (${mic})`);
      args = [
        '-f', 'dshow', '-i', `audio=${stereoMix}`,
        '-f', 'dshow', '-i', `audio=${mic}`,
        '-filter_complex', 'amix=inputs=2:duration=longest',
        '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
        '-y', outputPath,
      ];
    } else {
      const dev = mic || devices[0];
      console.log(`[win-bridge] mic only (${dev}) — Stereo Mix not found`);
      args = [
        '-f', 'dshow', '-i', `audio=${dev}`,
        '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
        '-y', outputPath,
      ];
    }

    this._outputPath = outputPath;
    console.log(`[win-bridge] spawning: ${bin} ${args.join(' ')}`);
    this._proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    return new Promise((resolve, reject) => {
      let resolved = false;

      this._proc.stderr.on('data', d => {
        const text = d.toString();
        process.stderr.write('[ffmpeg] ' + text);
        // ffmpeg prints "Press [q] to stop" once it's actively recording
        if (!resolved && /Press \[q\]|size=\s*\d+kB/i.test(text)) {
          resolved = true; resolve();
        }
      });

      this._proc.on('error', err => {
        if (!resolved) { resolved = true; reject(err); }
      });

      this._proc.on('exit', (code, sig) => {
        this._proc = null;
        if (!resolved) {
          resolved = true;
          reject(new Error(`ffmpeg exited before recording started (code=${code}, signal=${sig})`));
        }
      });

      // Resolve after 8 s regardless — some ffmpeg builds don't print the ready line
      setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 8_000);
    });
  }

  async stopRecording() {
    if (!this._proc) throw new Error('No active ffmpeg process');
    const outputPath = this._outputPath;

    await new Promise(resolve => {
      this._proc.once('exit', resolve);

      // Graceful stop: send 'q' to stdin (same as pressing Q in the terminal)
      try { this._proc.stdin.write('q\n'); this._proc.stdin.end(); } catch {}

      // Hard-kill fallback after 10 s
      setTimeout(() => { try { this._proc?.kill(); } catch {} resolve(); }, 10_000);
    });

    // Validate the output file before returning the path.
    let fileSize = 0;
    try { fileSize = fs.statSync(outputPath).size; } catch {}
    console.log(`[win-bridge] recording stopped — output: ${outputPath} (${fileSize} bytes)`);
    if (fileSize === 0) {
      throw new Error(`ffmpeg produced an empty file (0 bytes) at ${outputPath}. Check ffmpeg stderr above for the cause.`);
    }

    return outputPath;
  }

  shutdown() {
    try { this._proc?.kill(); } catch {}
    this._proc = null;
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
