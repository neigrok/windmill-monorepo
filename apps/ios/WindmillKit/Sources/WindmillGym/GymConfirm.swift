import AVFoundation
import UIKit

// Confirmation sound and haptic.
@MainActor
enum GymConfirm {
    static func setLogged(under preferences: GymPreferences) {
        if preferences.confirmHaptic { tap.impactOccurred() }
        guard preferences.confirmSound else { return }
        play(hz: 760, seconds: 0.07)
    }

    static func restLanded(under preferences: GymPreferences) {
        guard preferences.restSound else { return }
        play(hz: 680, seconds: 0.13)
        play(hz: 1020, seconds: 0.2, after: 0.15)
    }

    private static let tap = UIImpactFeedbackGenerator(style: .medium)

    private static let engine = AVAudioEngine()
    private static let voice = AVAudioPlayerNode()
    private static let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)

    private static func play(hz: Double, seconds: Double, after delay: Double = 0) {
        guard let format, let buffer = tone(hz: hz, seconds: seconds, format: format) else { return }
        guard (try? start(format)) != nil else { return }
        voice.scheduleBuffer(buffer, at: at(delay, format), options: [])
        voice.play()
    }

    private static func start(_ format: AVAudioFormat) throws {
        guard !engine.isRunning else { return }
        try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default)
        try AVAudioSession.sharedInstance().setActive(true)
        if voice.engine == nil {
            engine.attach(voice)
            engine.connect(voice, to: engine.mainMixerNode, format: format)
        }
        try engine.start()
    }

    private static func tone(hz: Double, seconds: Double, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(format.sampleRate * seconds)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let samples = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = frames
        for frame in 0..<Int(frames) {
            let progress = Double(frame) / Double(frames)
            let decay = pow(0.0001, progress)
            samples[frame] = Float(sin(2 * .pi * hz * Double(frame) / format.sampleRate) * 0.35 * decay)
        }
        return buffer
    }

    private static func at(_ delay: Double, _ format: AVAudioFormat) -> AVAudioTime? {
        guard delay > 0, let rendered = voice.lastRenderTime,
              let played = voice.playerTime(forNodeTime: rendered) else { return nil }
        return AVAudioTime(sampleTime: played.sampleTime + AVAudioFramePosition(delay * format.sampleRate),
                           atRate: format.sampleRate)
    }
}
