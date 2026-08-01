// There are exactly two sounds in Windmill Gym, ever, and this file is the whole list. Nothing
// makes noise on finish, on undo, on a personal record, on an error or on a sync — a training log
// does not congratulate. Sound is also the only confirmation a gym leaves us: there are no haptics
// on a home-screen web app, which is why the primary action is 64px and says the weight back.
//
// Every call is wrapped, because a browser with no audio must never break a log.

let context = null;

function tone(frequency, ms, gain) {
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    context = context || new Context();
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    envelope.gain.value = gain;
    oscillator.connect(envelope);
    envelope.connect(context.destination);
    oscillator.start();
    envelope.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + ms / 1000);
    oscillator.stop(context.currentTime + ms / 1000);
  } catch {
    // A blocked or absent audio context is not a failed set.
  }
}

export function playSetLogged() {
  tone(760, 70, 0.045);
}

export function playRestLanded() {
  tone(680, 130, 0.05);
  setTimeout(() => tone(1020, 200, 0.05), 150);
}
