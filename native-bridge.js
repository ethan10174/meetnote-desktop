// native-bridge.js
// Manages the audio-recorder helper process and exposes a simple async API:
//   startRecording(outputPath) → Promise<void>
//   stopRecording()            → Promise<string>  (resolves with WAV file path)
//   shutdown()                 → void

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const fs = require('fs');
const EventEmitter = require('events');

class NativeBridge extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._rl = null;
  }

  _binaryPath() {
    // Defer require('electron') so this module can be loaded before electron init
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'audio-recorder');
    }
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
      try {
        const msg = JSON.parse(line);
        this.emit('_msg', msg);
      } catch {
        console.error('[native-bridge] invalid JSON from helper:', line);
      }
    });

    this._proc.stderr.on('data', (d) => {
      process.stderr.write('[audio-recorder] ' + d);
    });

    this._proc.on('exit', (code, signal) => {
      console.log(`[native-bridge] helper exited (code=${code}, signal=${signal})`);
      this._proc = null;
      this._rl = null;
    });
  }

  // Returns a Promise that resolves with the next message from the helper,
  // or rejects on timeout.
  _nextMessage(timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('_msg', onMsg);
        reject(new Error('Timeout waiting for audio-recorder response'));
      }, timeoutMs);

      const onMsg = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
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
    const pending = this._nextMessage(60_000); // allow up to 60 s for WAV write
    this._proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
    const msg = await pending;
    if (msg.status === 'error') throw new Error(msg.message);
    return msg.path;
  }

  shutdown() {
    if (this._proc) {
      try { this._proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* ignore */ }
      this._proc = null;
    }
  }
}

module.exports = new NativeBridge();
