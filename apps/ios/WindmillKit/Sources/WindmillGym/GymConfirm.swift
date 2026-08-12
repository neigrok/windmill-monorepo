import AVFoundation
import UIKit

// HOW A SET AND A REST CONFIRM THEMSELVES, and this file is the whole list — there are exactly two
// moments and exactly two sounds. Nothing makes noise on finish, on undo, on a personal record, on an
// error or on a sync: a training log does not congratulate. The two pitches used to be stated twice,
// here and in the web logger's own `sound.js`; the web stopped lifting on 2026-08-09 (§11 — it is the
// mirror and the backfill now) and took that file with it, so this is the only copy left and the
// pointer to the other one is gone with it.
//
// THE LIFTER DECIDES, AND THE DEFAULTS ARE QUIET (§I). Sound on a logged set is off until it is asked
// for, and the rest chime only exists once a rest target does — so somebody who never opens the
// settings screen is never beeped at in a gym. What the account records is the INTENT; what a surface
// can honour is the surface's, and this one has a haptic and uses it.
//
// The haptic is why this file is no longer called GymSound: a phone confirms a logged set in the hand
// rather than in the ear, which is the confirmation that survives a squat rack. Web has no Vibration
// API and confirms visually there — one intent, two honest answers.
//
// The category is `.ambient`, and both halves of that matter: it MIXES, so a lifter's music is never
// interrupted by a log, and it obeys the ring switch, so a silenced phone stays silent. Every call
// is wrapped, because a device that will not make a sound must never break a set.

// Main-actor by construction: one engine and one generator, reached from the one thread that taps
// buttons, so the statics below need no lock and cannot be raced.
@MainActor
enum GymConfirm {
    static func setLogged(under preferences: GymPreferences) {
        if preferences.confirmHaptic { tap.impactOccurred() }
        guard preferences.confirmSound else { return }
        play(hz: 760, seconds: 0.07)
    }

    // Sound only, because sound is the one thing that reaches a phone lying on a bench — and it is the
    // only channel §I's rest row offers. A haptic in a pocket confirms nothing to nobody.
    static func restLanded(under preferences: GymPreferences) {
        guard preferences.restSound else { return }
        play(hz: 680, seconds: 0.13)
        play(hz: 1020, seconds: 0.2, after: 0.15)
    }

    // Medium, not light: the hand it has to reach is holding a bar and has just put it down.
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

    // A sine under an exponential decay — the same envelope the web ramps its gain along, so the two
    // surfaces make the same shape of sound rather than the same frequency with different edges.
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
