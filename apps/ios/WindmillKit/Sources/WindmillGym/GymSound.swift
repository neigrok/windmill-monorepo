import AVFoundation

// THERE ARE EXACTLY TWO SOUNDS IN WINDMILL GYM, EVER, AND THIS FILE IS THE WHOLE LIST. Nothing makes
// noise on finish, on undo, on a personal record, on an error or on a sync — a training log does not
// congratulate. The Swift statement of web/src/products/gym/logger/sound.js, at the same two pitches.
//
// Sound carries the one confirmation the screen cannot: the rest landing while the phone is in a
// pocket. There are no haptics in this design's world, so everything else the product confirms it
// confirms visually — the set row appearing, the button saying the weight back at 64pt.
//
// The category is `.ambient`, and both halves of that matter: it MIXES, so a lifter's music is never
// interrupted by a log, and it obeys the ring switch, so a silenced phone stays silent. Every call
// is wrapped, because a device that will not make a sound must never break a set.

// Main-actor by construction: one engine, reached from the one thread that taps buttons, so the two
// statics below need no lock and cannot be raced.
@MainActor
enum GymSound {
    static func setLogged() {
        play(hz: 760, seconds: 0.07)
    }

    static func restLanded() {
        play(hz: 680, seconds: 0.13)
        play(hz: 1020, seconds: 0.2, after: 0.15)
    }

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
