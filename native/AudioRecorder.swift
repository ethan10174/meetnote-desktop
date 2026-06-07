// AudioRecorder.swift
// Captures system audio (ScreenCaptureKit) + microphone (AVAudioEngine),
// mixes them, and writes a WAV file when recording stops.
//
// IPC protocol (stdin → stdout, one JSON object per line):
//   Input:  {"cmd":"start","output":"/tmp/recording.wav"}
//   Input:  {"cmd":"stop"}
//   Input:  {"cmd":"quit"}
//   Output: {"status":"started"}
//   Output: {"status":"stopped","path":"/tmp/recording.wav"}
//   Output: {"status":"error","message":"..."}
//
// Requires macOS 13.0+ (ScreenCaptureKit audio APIs).
// Screen Recording permission must be granted to this binary.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

// MARK: - Constants

let SAMPLE_RATE: Double = 48000
let CHANNELS: Int = 2

// MARK: - I/O helpers

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func log(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

// MARK: - Recorder

@available(macOS 13.0, *)
final class Recorder: NSObject {

    private var scStream: SCStream?
    private var engine: AVAudioEngine?

    private var sysHandle: FileHandle?
    private var micHandle: FileHandle?
    private let sysLock = NSLock()
    private let micLock = NSLock()

    private var sysPath = ""
    private var micPath = ""
    private var outputPath = ""

    // MARK: Public

    func start(output: String) async {
        outputPath = output

        let tmp = NSTemporaryDirectory()
        sysPath = tmp + "mn-sys-\(UInt64.random(in: 0..<UInt64.max)).raw"
        micPath = tmp + "mn-mic-\(UInt64.random(in: 0..<UInt64.max)).raw"

        guard FileManager.default.createFile(atPath: sysPath, contents: nil),
              FileManager.default.createFile(atPath: micPath, contents: nil) else {
            emit(["status": "error", "message": "Cannot create temp audio files"])
            return
        }

        do {
            sysHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: sysPath))
            micHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: micPath))
        } catch {
            emit(["status": "error", "message": "Cannot open temp files: \(error.localizedDescription)"])
            return
        }

        do {
            try await startSCStream()
        } catch {
            emit(["status": "error", "message": "ScreenCaptureKit: \(error.localizedDescription)"])
            cleanup()
            return
        }

        do {
            try startMic()
        } catch {
            // Non-fatal — continue with system audio only
            log("[recorder] Mic unavailable: \(error.localizedDescription)")
        }

        emit(["status": "started"])
    }

    func stop() async {
        // Stop synchronous resources before the async stopCapture call
        stopMicSync()
        let streamToStop = scStream
        scStream = nil

        if let s = streamToStop {
            try? await s.stopCapture()
        }
        closeSysHandleSync()

        // Mix and write WAV
        do {
            try mix(to: outputPath)
            emit(["status": "stopped", "path": outputPath])
        } catch {
            emit(["status": "error", "message": "WAV write failed: \(error.localizedDescription)"])
        }

        cleanup()
    }

    // MARK: Private — sync teardown helpers (avoids NSLock-in-async warnings)

    private func stopMicSync() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        micLock.lock(); micHandle?.closeFile(); micHandle = nil; micLock.unlock()
    }

    private func closeSysHandleSync() {
        sysLock.lock(); sysHandle?.closeFile(); sysHandle = nil; sysLock.unlock()
    }

    // MARK: Private — capture setup

    private func startSCStream() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw NSError(domain: "Recorder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let filter = SCContentFilter(display: display,
                                     excludingApplications: [],
                                     exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.sampleRate = Int(SAMPLE_RATE)
        cfg.channelCount = CHANNELS
        cfg.excludesCurrentProcessAudio = false
        // Minimal video capture — we only need audio
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .audio,
                                   sampleHandlerQueue: DispatchQueue(label: "mn.sysaudio"))
        try await stream.startCapture()
        scStream = stream
    }

    private func startMic() throws {
        engine = AVAudioEngine()
        let input = engine!.inputNode
        let hwFmt = input.outputFormat(forBus: 0)

        // Target: float32, SAMPLE_RATE Hz, CHANNELS ch, non-interleaved
        let targetFmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: SAMPLE_RATE,
            channels: AVAudioChannelCount(CHANNELS),
            interleaved: false
        )!

        let needsConversion = hwFmt.sampleRate != SAMPLE_RATE
            || hwFmt.channelCount != AVAudioChannelCount(CHANNELS)
            || hwFmt.isInterleaved
        let converter = needsConversion ? AVAudioConverter(from: hwFmt, to: targetFmt) : nil

        input.installTap(onBus: 0, bufferSize: 4096, format: hwFmt) { [weak self] buf, _ in
            guard let self = self else { return }
            let outBuf: AVAudioPCMBuffer

            if let conv = converter {
                let ratio = SAMPLE_RATE / hwFmt.sampleRate
                let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio + 1)
                guard let dest = AVAudioPCMBuffer(pcmFormat: targetFmt, frameCapacity: cap) else { return }
                var convError: NSError?
                var inputConsumed = false
                conv.convert(to: dest, error: &convError) { _, outStatus in
                    if inputConsumed { outStatus.pointee = .noDataNow; return nil }
                    inputConsumed = true; outStatus.pointee = .haveData; return buf
                }
                guard convError == nil else { return }
                outBuf = dest
            } else {
                outBuf = buf
            }

            self.writeMicBuffer(outBuf)
        }

        try engine!.start()
    }

    // MARK: Private — audio writing

    private func writeMicBuffer(_ buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData else { return }
        let frames = Int(buf.frameLength)
        let nch = min(Int(buf.format.channelCount), CHANNELS)
        var interleaved = [Float](repeating: 0, count: frames * CHANNELS)
        for f in 0..<frames {
            for c in 0..<CHANNELS {
                interleaved[f * CHANNELS + c] = ch[c < nch ? c : 0][f]
            }
        }
        let bytes = interleaved.withUnsafeBytes { Data($0) }
        micLock.lock(); micHandle?.write(bytes); micLock.unlock()
    }

    private func writeSysBuffer(_ buf: AVAudioPCMBuffer, format: AVAudioFormat) {
        guard let ch = buf.floatChannelData else { return }
        let frames = Int(buf.frameLength)
        let nch = min(Int(format.channelCount), CHANNELS)
        var interleaved = [Float](repeating: 0, count: frames * CHANNELS)
        for f in 0..<frames {
            for c in 0..<CHANNELS {
                interleaved[f * CHANNELS + c] = ch[c < nch ? c : 0][f]
            }
        }
        let bytes = interleaved.withUnsafeBytes { Data($0) }
        sysLock.lock(); sysHandle?.write(bytes); sysLock.unlock()
    }

    // MARK: Private — WAV mixing

    private func mix(to path: String) throws {
        let sysData = (try? Data(contentsOf: URL(fileURLWithPath: sysPath))) ?? Data()
        let micData = (try? Data(contentsOf: URL(fileURLWithPath: micPath))) ?? Data()

        let ns = sysData.count / MemoryLayout<Float>.size
        let nm = micData.count / MemoryLayout<Float>.size
        let total = max(ns, nm)

        guard total > 0 else {
            throw NSError(domain: "Recorder", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "No audio data captured"])
        }

        let sf: [Float] = sysData.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        let mf: [Float] = micData.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }

        var pcm16 = [Int16](repeating: 0, count: total)
        for i in 0..<total {
            let s = i < ns ? sf[i] : 0.0
            let m = i < nm ? mf[i] : 0.0
            let mixed = max(-1.0, min(1.0, s * 0.7 + m * 0.9))
            pcm16[i] = Int16(mixed * 32767.0)
        }

        let sr = Int(SAMPLE_RATE)
        let dataBytes = total * MemoryLayout<Int16>.size

        var hdr = Data()
        func le<T: FixedWidthInteger>(_ v: T) {
            var x = v.littleEndian
            withUnsafeBytes(of: &x) { hdr.append(contentsOf: $0) }
        }
        hdr.append(contentsOf: "RIFF".utf8); le(UInt32(36 + dataBytes))
        hdr.append(contentsOf: "WAVE".utf8)
        hdr.append(contentsOf: "fmt ".utf8)
        le(UInt32(16))          // chunk size
        le(UInt16(1))           // PCM
        le(UInt16(CHANNELS))
        le(UInt32(sr))
        le(UInt32(sr * CHANNELS * 2))   // byte rate
        le(UInt16(CHANNELS * 2))        // block align
        le(UInt16(16))          // bits per sample
        hdr.append(contentsOf: "data".utf8); le(UInt32(dataBytes))

        var wav = hdr
        pcm16.withUnsafeBytes { wav.append(contentsOf: $0) }
        try wav.write(to: URL(fileURLWithPath: path))
    }

    private func cleanup() {
        try? FileManager.default.removeItem(atPath: sysPath)
        try? FileManager.default.removeItem(atPath: micPath)
    }
}

// MARK: - SCStreamDelegate

@available(macOS 13.0, *)
extension Recorder: SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("[recorder] SCStream stopped: \(error.localizedDescription)")
    }
}

// MARK: - SCStreamOutput

@available(macOS 13.0, *)
extension Recorder: SCStreamOutput {
    func stream(_ stream: SCStream,
                didOutputSampleBuffer sb: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, let fmtDesc = sb.formatDescription else { return }

        let avFmt = AVAudioFormat(cmAudioFormatDescription: fmtDesc)
        let fc = AVAudioFrameCount(sb.numSamples)
        guard fc > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: avFmt, frameCapacity: fc) else { return }
        buf.frameLength = fc

        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sb, at: 0, frameCount: Int32(fc), into: buf.mutableAudioBufferList
        ) == noErr else { return }

        writeSysBuffer(buf, format: avFmt)
    }
}

// MARK: - Entry point

if #available(macOS 13.0, *) {
    let recorder = Recorder()

    // Probe screen recording permission immediately at startup.
    //
    // macOS TCC grants permissions per binary path, not per app — so Electron
    // having Screen Recording access does NOT cover this helper binary.
    // Calling SCShareableContent here causes macOS to:
    //   1. Check TCC for *this* binary.
    //   2. If not yet authorized, open System Settings → Privacy & Security →
    //      Screen Recording so the user can add it.
    //
    // The probe runs fire-and-forget alongside the command loop. On first run the
    // user will see the System Settings sheet; on subsequent runs the call
    // returns instantly because permission is already cached.
    Task {
        do {
            _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            log("[recorder] Screen Recording permission confirmed.")
        } catch {
            // macOS has already opened System Settings for the user.
            // The start command will return a clear error if they try before granting.
            log("[recorder] Screen Recording not yet authorized: \(error.localizedDescription)")
        }
    }

    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { continue }
            let cmd = json["cmd"] ?? ""
            let output = json["output"] ?? ""
            Task {
                switch cmd {
                case "start": await recorder.start(output: output)
                case "stop":  await recorder.stop()
                case "quit":  exit(0)
                default:      emit(["status": "error", "message": "Unknown command: \(cmd)"])
                }
            }
        }
        exit(0)
    }

    RunLoop.main.run()

} else {
    let msg = "{\"status\":\"error\",\"message\":\"Requires macOS 13.0 or later\"}\n"
    FileHandle.standardOutput.write(Data(msg.utf8))
    exit(1)
}
