import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');
const read = (file) => fs.readFileSync(path.join(GYM, file), 'utf8');

const spoken = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const speech = (file) => spoken(read(file));

test('the routine editor is keyed on the routine it edits, so a hash move remounts it', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes('<RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />'), true);
});

test('the editor’s Duplicate copies the routine as stored, and a fresh routine offers none', () => {
  const source = spoken(read('Routines.jsx'));
  assert.equal(source.includes("duplicateRoutine(view.data, { id: mintId('rt_') })"), true);
  assert.equal(source.includes("duplicateRoutine(draft,"), false);
  const foot = source.indexOf('className="gym-editor-duplicate"');
  assert.notEqual(foot, -1);
  assert.equal(source.lastIndexOf('{!fresh && (', foot) > source.lastIndexOf('<RoutineHistory', foot), true);
});

test('the routine row’s proposal flag counts nothing', () => {
  const source = spoken(read('Proposals.jsx'));
  const flag = source.slice(source.indexOf('export function ProposalFlag'), source.indexOf('export function ProposalDiff'));
  assert.equal(flag.includes('proposal pending'), true);
  assert.equal(/\d proposal/.test(flag), false);
});

test('every list of a routine’s entries is keyed on the position as well as the movement', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('key={`${entry.exerciseId}-${index}`}'), true);
  assert.equal(source.includes('key={entry.exerciseId}'), false);
});

test('the tab bar draws the same number of tabs the grid has columns for', () => {
  const tabs = read('GymApp.jsx').match(/className=\{screen === '[a-z]+' \? 'gym-tab is-on' : 'gym-tab'\}/g) ?? [];
  const grid = /\.gym-tabs \{[^}]*grid-template-columns: repeat\((\d+), 1fr\)/.exec(read('gym.css'));
  assert.equal(tabs.length, 3);
  assert.equal(grid?.[1], String(tabs.length));
  assert.equal(read('GymApp.jsx').includes("const TAB_SCREENS = ['routines', 'log', 'coach'];"), true);
});

test('the tabs are Routines · The log · Coach, in that order, and #/gym is the first of them', () => {
  const app = read('GymApp.jsx');
  const bar = app.slice(app.indexOf('function TabBar'));
  assert.equal(bar.includes("href={ROUTINES_HREF}>Routines</a>"), true);
  assert.equal(bar.includes('href="#/gym/log">The log</a>'), true);
  assert.equal(bar.includes('href={COACH_HREF}>Coach</a>'), true);
  assert.ok(bar.indexOf('Routines</a>') < bar.indexOf('The log</a>'));
  assert.ok(bar.indexOf('The log</a>') < bar.indexOf('Coach</a>'));
  assert.equal(fs.existsSync(path.join(GYM, 'Today.jsx')), false, 'Today is deleted as a screen');
  assert.equal(app.includes("'today'"), false);
  assert.equal(app.includes("{screen === 'routines' && <RoutinesList log={log} onSignIn={onSignIn} />}"), true);
  assert.equal(read('log.js').includes("export const ROUTINES_HREF = '#/gym';"), true);
});

test('the live mirror heads the routines home and keeps its charter: no Finish, no countdown, the words when idle', () => {
  const routines = read('Routines.jsx');
  assert.equal(routines.includes('<LiveMirror log={log} onSignIn={onSignIn} />'), true);
  assert.ok(routines.indexOf('<LiveMirror') < routines.indexOf('<PendingProposals'));
  assert.ok(routines.indexOf('<PendingProposals') < routines.indexOf('<ul className="gym-routines">'));
  assert.equal(routines.includes("import { LiveMirror } from './Mirror.jsx';"), true);
  const mirror = speech('Mirror.jsx');
  assert.equal(mirror.includes('Not training now.'), true);
  assert.equal(mirror.includes('Workouts start on your phone.'), true);
  assert.equal(/[Ff]inish/.test(mirror), false, 'the mirror never offers a Finish');
  assert.equal(mirror.includes('clockOf(now - session.startedAt)'), true, 'the clock counts up from the start');
  assert.equal(mirror.includes('const [, setBeat] = useState(0);'), true, 'the beat is the mirror’s own state');
  for (const file of gymFiles()) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    assert.equal(/\bresting\b/i.test(spoken(fs.readFileSync(file, 'utf8'))), false, file);
  }
});

test('every exercise name a lifter can see is a link to that movement’s record', () => {
  assert.equal(read('Log.jsx').includes('<a className="gym-movement-door" href={recordHref(exerciseId)}>'), true);
  assert.equal(read('Routines.jsx').includes('<a className="gym-entry-name gym-movement-door" href={recordHref(entry.exerciseId)}>'), true);
  assert.equal(read('Finish.jsx').includes('<a className="gym-against-movement gym-movement-door" href={recordHref(row.exerciseId)}>'), true);
  assert.equal(read('Mirror.jsx').includes('<a className="gym-movement-door" href={recordHref(newest.exerciseId)}>'), true);
  assert.equal(read('Proposals.jsx').includes('<a className="gym-diff-name gym-movement-door" href={recordHref(row.exerciseId)}>'), true);
  assert.equal(read('gym.css').includes('.gym-movement-door {'), true);
  assert.equal(/\.gym-entry \.gym-movement-door \{[^}]*display:/.test(read('gym.css')), false);
});

test('the record page’s block heads do not take the finish screen’s gold class', () => {
  const blocks = [...read('gym.css').matchAll(/\.gym-record-title \{([^}]*)\}/g)];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0][1].includes('color: var(--pr-ink);'), true);
  assert.equal(read('Finish.jsx').includes('className="gym-record-title"'), true);
  assert.equal(read('Record.jsx').includes('gym-record-title'), false);
});

test('the chat is one room in the frame, and no session screen carries one', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'coach' && <CoachRoom log={log} />}"), true);
  for (const file of gymFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const mine = path.basename(file) === 'GymApp.jsx';
    assert.equal(source.includes('<CoachRoom') && !mine, false, file);
    assert.equal(source.includes('CoachPanel'), false, file);
  }
  for (const screen of ['Log.jsx', 'Finish.jsx']) {
    assert.equal(read(screen).includes('askCoach'), false, screen);
  }
});

test('Coach is a tab root: a column in the rail, no back link, its threads and notes pushed under it', () => {
  const app = read('GymApp.jsx');
  const rooms = /const TAB_SCREENS = \[([^\]]*)\];/.exec(app);
  assert.equal(rooms?.[1], "'routines', 'log', 'coach'");
  assert.equal(/\.gym-tabs \{[^}]*grid-template-columns: repeat\(3, 1fr\)/.test(read('gym.css')), true);
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('gym-back'), false, 'a tab root keeps no back link');
  assert.equal(room.includes('<a className="gym-coach-threads-door" href={THREADS_HREF}>{THREADS_TITLE} ›</a>'), true);
  assert.equal(room.includes('<a className="gym-coach-notes-door" href={NOTES_HREF}>'), true);
  assert.equal(room.includes('if (log.session) {'), true);
  const threads = read('coach/Threads.jsx');
  assert.equal(threads.includes('<Back href={COACH_HREF}>{COACH_TITLE}</Back>'), true);
  assert.equal(threads.includes('<Back href={THREADS_HREF}>{THREADS_TITLE}</Back>'), true);
  assert.equal(read('Proposals.jsx').includes('{!log.session && <a className="gym-coach-aside" href={COACH_HREF}>'), true);
});

test('the allowance is the line above the composer, and the spent allowance replaces the composer with the door', () => {
  const room = read('coach/CoachRoom.jsx');
  const allowance = room.indexOf('<p className="gym-coach-allowance">{ALLOWANCE_LINE}</p>');
  const composer = room.indexOf('<div className="gym-coach-compose">');
  assert.ok(allowance > 0 && allowance < composer, 'the promise sits immediately above the composer');
  assert.equal(room.includes('{!closed && !full && capped && <CapReached onStartAgain={onStartAgain} />}'), true);
  assert.equal(room.includes('{!closed && !full && !capped && ('), true);
  const moment = room.slice(room.indexOf('function CapReached'), room.indexOf('function Answer'));
  assert.equal(moment.includes('{CAP_REACHED_NOTE}'), true);
  assert.equal(moment.includes('href={CONNECT_HREF}'), true);
  // There is no clock: the way back is a new conversation, which returns the composer.
  assert.equal(moment.includes('<button type="button" className="gym-coach-again" onClick={onStartAgain}>{NEW_THREAD_VERB}</button>'), true);
  assert.equal(room.includes("setRefusedFull(false); setCapped(false); setThreadId(mintId(THREAD_PREFIX));"), true);
  assert.equal(room.includes('else if (failure.capped) setCapped(true);'), true);
  // The server stored nothing of a refused question, so it is not a turn of the conversation.
  assert.equal(room.includes('if (failure.refused) { setTurns((held) => held.slice(0, -1)); setDraft(question); }'), true);
  const css = read('gym.css');
  const allowanceRule = /\.gym-coach-allowance \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.equal(allowanceRule.includes('font-family'), false, 'a sentence is set in the body face, never mono');
  assert.equal(allowanceRule.includes('color: var(--gym-ink-dim)'), true);
  assert.equal(/\beight\b/.test(speech('coach/coach.js')), false, 'nothing a lifter reads says eight');
});

test('nothing on this surface computes the number an answer is checked against', () => {
  assert.equal(speech('coach/coach.js').includes('read: reply.read,'), true);
  for (const file of ['coach/coach.js', 'coach/CoachRoom.jsx']) {
    assert.equal(/read:\s*\{/.test(read(file)), false, file);
  }
  const rules = speech('coach/coach.js');
  for (const arithmetic of ['reduce(', '+=', 'Math.', 'sum']) {
    assert.equal(rules.includes(arithmetic), false, arithmetic);
  }
});

test('the room makes no answer of its own, so prose with no receipt never reaches the screen', () => {
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('const answer = answerTurn(reply);'), true);
  assert.equal(room.includes('if (answer) setTurns((held) => [...held, answer]);'), true);
  assert.equal(room.includes('else setNote(NO_ANSWER_NOTE);'), true);
  assert.equal(room.includes("from: 'ask',"), false);
  assert.equal(speech('coach/coach.js').includes("from: 'ask',"), true);
});

test('the receipt is always visible and the step list collapses behind it', () => {
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('<summary className="gym-coach-read">{readLine(turn.read)}</summary>'), true);
  assert.equal(room.includes('<p className="gym-coach-read">{readLine(turn.read)}</p>'), true, 'a list of nothing readable still draws the receipt');
  assert.equal(room.includes('<details className="gym-coach-trace">'), true);
  assert.equal(room.includes('<p className="gym-coach-steps">{steps}</p>'), true);
  assert.equal(room.includes('<details open'), false, 'the trace opens on a tap, never by default');
});

test('the word coach names exactly one thing — the room — and the share never carries it', () => {
  for (const file of ['share/share.js', 'share/ShareWorkout.jsx', 'share/SharedSession.jsx', 'marketing/landingHead.js']) {
    assert.equal(speech(file).toLowerCase().includes('coach'), false, file);
  }
  assert.equal(read('share/share.js').includes("SHARE_OFFER = 'Share this workout'"), true);
  assert.equal(fs.existsSync(path.join(GYM, 'share', 'CoachShare.jsx')), false);
  for (const file of gymFiles()) {
    const said = spoken(fs.readFileSync(file, 'utf8'));
    assert.equal(/Share with a coach|coach link|to your coach|to a coach/i.test(said), false, file);
    assert.equal(/\bAsk\b(?! (about|something|again))/.test(said), false, `${file} still names the room Ask`);
  }
  assert.equal(fs.existsSync(path.join(GYM, 'ask')), false, 'the directory follows the room’s name');
  assert.equal(/\.gym-ask|is-ask\b/.test(read('gym.css')), false);
});

test('Coach offers nothing to buy, and reads no entitlement to decide whether to answer', () => {
  for (const file of ['coach/coach.js', 'coach/CoachRoom.jsx']) {
    const said = speech(file);
    for (const door of ['useEntitlements', 'paidPlansOpen', 'beginUpgrade', 'windmillOne', 'checkout']) {
      assert.equal(said.includes(door), false, `${file} reaches for ${door}`);
    }
    assert.equal(/[Uu]pgrade|Windmill One|[Ss]ubscri|\$\d|£\d|€\d/.test(said), false, file);
  }
  const rules = speech('coach/coach.js');
  assert.equal(rules.includes('Ten questions a day, three back to back.'), true);
  assert.equal(rules.includes('AI ceiling for the last 30 days'), true);
});

test('the landing sells no panel, no plan behind Coach, and names the cap Coach really has', () => {
  const said = speech('marketing/GymLanding.jsx');
  for (const gone of ['coach panel', 'A panel under any finished workout', 'Windmill One', 'It only reads']) {
    assert.equal(said.includes(gone), false, gone);
  }
  assert.equal(said.includes('ten questions a day'), true);
  assert.equal(said.includes('nothing in Gym is on sale'), true);
  assert.equal(said.includes('your whole log and it proposes'), true);
  assert.equal(said.includes('how many of your rows they served'), true);
  assert.equal(said.includes('log a set, correct one you lifted, or delete anything'), true);
  assert.equal(said.includes('Coach is a room in the app'), true);
  assert.equal(said.includes('coach link'), false);
  assert.equal(said.includes('end a share link'), true);
});

test('an empty Coach contrasts the free door on scope, and walks to it', () => {
  const said = speech('coach/coach.js');
  assert.equal(said.includes('If you already use Claude or ChatGPT, connect them instead'), true);
  assert.equal(said.includes('it knows the rest of your life'), true);
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('{turns.length === 0 && <FreeDoor />}'), true);
  assert.equal(room.includes('<a className="gym-coach-free-door" href={CONNECT_HREF}>{FREE_DOOR_VERB}</a>'), true);
});

test('the threads list and one conversation are rooms in the frame, and the detail is keyed', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'threads' && <ThreadsList />}"), true);
  assert.equal(app.includes("{screen === 'thread' && <ThreadDetail key={threadIdOf(hash)} id={threadIdOf(hash)} />}"), true);
  const rooms = /const TAB_SCREENS = \[([^\]]*)\];/.exec(app);
  assert.equal(rooms?.[1], "'routines', 'log', 'coach'");
});

test('a thread row draws the question as it was asked, and nothing edits it', () => {
  const threads = read('coach/Threads.jsx');
  assert.equal(threads.includes('<span className="gym-thread-title">{thread.title}</span>'), true);
  assert.equal(threads.includes('<h1 className="gym-thread-name">{thread.title}</h1>'), true);
  const said = speech('coach/Threads.jsx');
  for (const edit of ['.slice(', '.substring(', '.toUpperCase(', '.trim()', 'summar', '…\'']) {
    assert.equal(said.includes(edit), false, edit);
  }
});

test('nothing about the threads screens is an unread count, a badge or a notification', () => {
  for (const file of ['coach/Threads.jsx', 'coach/CoachRoom.jsx', 'coach/threads.js']) {
    const said = speech(file).toLowerCase();
    for (const inbox of ['unread', 'badge', 'notif', 'is-new']) {
      assert.equal(said.includes(inbox), false, `${file} — ${inbox}`);
    }
  }
  assert.equal(speech('coach/Threads.jsx').includes('Dot'), false);
  assert.equal(read('coach/CoachRoom.jsx').includes('<a className="gym-coach-threads-door" href={THREADS_HREF}>{THREADS_TITLE} ›</a>'), true);
});

test('Coach writes into a thread it minted, and starting again opens a new one', () => {
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('const [threadId, setThreadId] = useState(() => mintId(THREAD_PREFIX));'), true);
  assert.equal(room.includes('const reply = await gymApi.ask(threadId, question);'), true);
  assert.equal(room.includes("setRefusedFull(false); setCapped(false); setThreadId(mintId(THREAD_PREFIX));"), true);
  for (const file of gymFiles()) {
    assert.equal(spoken(fs.readFileSync(file, 'utf8')).includes('threadFor'), false, file);
  }
});

test('the delete says what it does before it is armed, and takes two taps', () => {
  const threads = read('coach/Threads.jsx');
  assert.equal(threads.includes('<p className="gym-thread-delete-note">{DELETE_NOTE}</p>'), true);
  assert.equal(threads.includes('if (!confirming) {'), true);
  assert.equal(threads.includes('await gymApi.deleteThread(id);'), true);
});

test('a change that came from a conversation offers it, and one with none offers nothing', () => {
  const routines = read('Routines.jsx');
  assert.equal(routines.includes('{row.thread && ('), true);
  assert.equal(routines.includes('<a className="gym-history-thread" href={threadHref(row.thread)}>{CONVERSATION_VERB} ›</a>'), true);
  const proposals = read('Proposals.jsx');
  assert.equal(proposals.includes('{conversationOf(proposal.source) && ('), true);
  assert.equal(proposals.includes('href={threadHref(conversationOf(proposal.source))}'), true);
});

test('the “added today” note is offered to the first working set of a movement', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes("const opener = group.find((set) => set.kind === 'working');"), true);
  assert.equal(source.includes('setNoteOf(set, reading, set === opener)'), true);
  assert.equal(source.includes('index === 0'), false);
});

test('the shared workout is answered above the auth switch, and wears none of the app’s chrome', () => {
  const app = read('GymApp.jsx');
  const shared = app.indexOf('if (sharedToken) {');
  const authSwitch = app.indexOf("status === 'loading'");
  assert.ok(shared > 0, 'GymApp has no shared branch');
  assert.ok(shared < authSwitch, 'the shared branch resolves after the auth switch');
  assert.ok(app.indexOf('const sharedToken = sharedTokenOf(hash);') < shared);
  assert.ok(app.indexOf('useSignInDoorHost()') < shared);

  const branch = app.slice(shared, authSwitch);
  for (const chrome of ['<Chrome', '<TabBar', 'SignInPitch', 'AccountSeat', 'ProductSwitcher']) {
    assert.equal(branch.includes(chrome), false, chrome);
  }
  assert.equal(branch.includes('<SharedSession token={sharedToken} />'), true);
});

test('the account seat and the switcher are drawn in one place, and only outside the shell', () => {
  const app = read('GymApp.jsx');

  assert.equal(app.includes('function Chrome({ inShell, user, status, onSignIn, onSignOut }) {\n  if (inShell) return null;'), true);
  assert.equal((app.match(/<AccountSeat/g) ?? []).length, 1);
  assert.equal((app.match(/<ProductSwitcher/g) ?? []).length, 1);
  assert.ok(app.indexOf('if (inShell) return null;') < app.indexOf('<AccountSeat'));

  const mounts = app.split('<Chrome').slice(1);
  assert.equal(mounts.length, 2);
  for (const mount of mounts) assert.equal(mount.slice(0, 40).includes('inShell={inShell}'), true, mount.slice(0, 40));

  assert.equal((app.match(/data-chrome=\{inShell \? 'shell' : 'own'\}/g) ?? []).length, 2);
  assert.equal(read('gym.css').includes(".gym-root[data-chrome='shell'] .gym-column {"), true);
});

test('every set in a session read whole is a door onto the fix, and says so', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('onClick={() => setFixing(set)}'), true);
  assert.equal(source.includes('<span className="gym-set-fix">tap to fix</span>'), true);
  assert.equal(source.includes('className="gym-set-fix" aria-hidden'), false);
  const css = read('gym.css');
  assert.equal(css.includes('button.gym-set:hover .gym-set-fix,'), true);
  assert.equal(/@media \(hover: none\) \{\s*\.gym-set-fix \{\s*opacity: 1;/.test(css), true);
});

test('the session detail is keyed on the session it reads, and is handed the one voice', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes('<SessionDetail key={sessionIdOf(hash)} id={sessionIdOf(hash)} log={log} />'), true);
});

test('the fix sheet steps a weight on the logger’s ladder and states no step size of its own', () => {
  assert.equal(read('fix.js').includes("import { bump, bumpReps, round } from './logger/ladder.js';"), true);
  assert.equal(read('FixSheet.jsx').includes("import { LADDER_KEYS, ladderLabels } from './logger/ladder.js';"), true);
  assert.equal(read('fix.js').includes('weightKg: bump(draft.weightKg, direction, big)'), true);
  for (const file of ['fix.js', 'FixSheet.jsx']) {
    assert.equal(/\d\.\d/.test(speech(file)), false, `${file} states a weight of its own`);
  }
});

test('no surface of the fix promises a set back', () => {
  for (const file of ['fix.js', 'FixSheet.jsx', 'Log.jsx', 'gymApi.js', 'gym.css']) {
    const source = speech(file).toLowerCase();
    for (const promise of ['30 days', 'thirty days', 'recoverable', 'restore', 'undelete', 'trash']) {
      assert.equal(source.includes(promise), false, `${file} promises "${promise}"`);
    }
  }
});

test('a deleted set is withheld for the window, never sent and re-posted', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('setTimeout(() => sendDelete(set.id), UNDO_MS)'), true);
  assert.equal(source.includes('appendSet'), false);
  assert.equal(source.includes('withheld.current.forEach((held) => {\n      sendDelete(held.set.id);\n      say(deletedLine(held.set));\n    });'), true);
});

test('every re-read of the session lets go of the corrections this screen was holding', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('const reread = () => {\n    setMoves(movesAfterRead);\n    view.retry();\n  };'), true);
  assert.equal(source.includes('if (error.setNotFound) reread();'), true);
  assert.equal(source.includes('className="gym-retry" onClick={reread}'), true);
  assert.equal((source.match(/view\.retry/g) ?? []).length, 1);
});

test('the undo window is exactly as long as the toast that offers it', () => {
  const undo = /export const UNDO_MS = (\d+);/.exec(read('fix.js'));
  const toast = /const TOAST_MS = (\d+);/.exec(read('useTrainingLog.js'));
  assert.equal(undo?.[1], '9000');
  assert.equal(toast?.[1], undo?.[1]);
});

test('the toast’s own clock clears only that toast, never the one said after it', () => {
  const source = read('useTrainingLog.js');
  assert.equal(
    source.includes('setTimeout(() => setToast((current) => (current === toast ? null : current)), TOAST_MS)'),
    true,
  );
  assert.equal((source.match(/setToast\(null\)/g) ?? []).length, 1);
  assert.equal(source.includes('dismissToast: () => setToast(null)'), true);
});

test('nothing on the fix path refuses a set because its workout is over', () => {
  for (const file of ['fix.js', 'FixSheet.jsx']) {
    const source = read(file);
    assert.equal(source.includes('sessionFinished'), false, file);
    assert.equal(source.includes('isFinished'), false, file);
  }
  assert.equal(read('Log.jsx').includes('{fixing && (\n        <FixSheet'), true);
});

test('the set-confirmation row names the true reason nothing here confirms a set', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  assert.equal(said.includes('No set is logged at this desk'), true);
  assert.equal(said.includes('it does not act here'), true);
  assert.equal(said.includes('Vibration API'), false);
  assert.equal(said.includes('label="Haptic"'), true);
});

test('the rest row names the phone as the clock even with the timer off', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  assert.equal(said.includes('your phone runs the clock between sets and sounds it'), true);
  assert.equal(said.includes('Off, and off is the default'), true);
  assert.equal(/restSeconds == null\s*\n?\s*&&/.test(said), true);
});

test('the settings section promises no alarm this surface cannot keep', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  for (const promise of ['navigator.vibrate', 'new Audio', 'new Notification', 'requestPermission', 'setInterval']) {
    assert.equal(said.includes(promise), false, promise);
  }
  assert.equal(speech('settings/GymSettingsSection.jsx').includes('never sounds an alarm of its own'), true);
});

test('the exports are rows of the section: the sets for an account with a log, the notes beside it for one with notes', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('{hasLog && ('), true);
  assert.equal(source.includes('href={EXPORT_HREF}'), true);
  assert.equal((source.match(/EXPORT_HREF/g) ?? []).length, 2);
  assert.equal(source.includes('{hasNotes && ('), true);
  assert.equal(source.includes('href={EXPORT_NOTES_HREF}'), true);
  assert.equal(source.includes('{EXPORT_NOTES_VERB}'), true);
  assert.equal(source.includes('{EXPORT_NOTES_LINE}'), true);
  assert.ok(source.indexOf('href={EXPORT_HREF}') < source.indexOf('href={EXPORT_NOTES_HREF}'));
  assert.ok(source.indexOf('href={EXPORT_NOTES_HREF}') < source.indexOf('<ConnectedLog />'));
});

test('the connected-log row names the grant state without rebuilding it', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('listGrants'), true);
  assert.equal(source.includes('revokeGrant'), false);
  assert.equal(source.includes('href={CONNECT_HREF}'), true);
  assert.equal(source.includes('"#/connect"'), false);
  assert.equal(source.includes('connectionsToTheLog(grants, keys)'), true);
  assert.equal(source.includes('readScope'), false);
  assert.equal(source.includes('Promise.all([listGrants(), listMcpKeys()])'), true);
  assert.equal(source.includes('${connectedLabel(row)}'), true);
});

test('the picker reads every movement’s last set when it opens, and never on a keystroke', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('const last = useGymRead(() => gymApi.lastSets(), []);'), true);
  assert.equal((picker.match(/useGymRead\(/g) ?? []).length, 1);
  assert.equal(/useGymRead\([^;]*\[[^\]]*query/.test(picker), false);
  for (const host of ['Routines.jsx', 'Backfill.jsx', 'Record.jsx']) {
    assert.equal(read(host).includes('lastSets'), false, host);
  }
});

test('a picker row says it has no last time, only once the read behind it has answered', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes("const meta = last.phase === 'ready' ? lastSetsById(last.data) : null;"), true);
  assert.equal(
    picker.includes('{meta && <span className="gym-picker-meta">{lastSetLabel(meta.get(each.id))}</span>}'),
    true,
  );
  assert.equal(speech('logger/MovementPicker.jsx').includes('never logged'), false);
  assert.equal(speech('logger/movements.js').includes('never logged'), false);
  assert.equal(speech('logger/movements.js').includes("NO_LAST_TIME_META = 'no last time'"), true);
});

test('the empty routines home offers to build one, and this surface still starts nothing', () => {
  const source = read('Routines.jsx');
  assert.equal(
    source.includes('<a className="gym-routines-build" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</a>'),
    true,
  );
  assert.equal(source.includes("view.phase === 'ready' && view.data.length === 0"), true);
  for (const file of gymFiles()) {
    if (!/\.(jsx?)$/.test(file)) continue;
    const said = spoken(fs.readFileSync(file, 'utf8'));
    assert.equal(said.includes('Start a session'), false, file);
    assert.equal(said.includes('Just start logging'), false, file);
  }
});

test('the routine editor names the revision it read and re-reads on routine-stale', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes("routineWrite({ ...draft, name: draft.name.trim() }, fresh ? null : view.data.revision)"), true);
  assert.equal(source.includes("if (error?.code === 'routine-stale') {"), true);
  assert.equal(source.includes("log.say('That routine changed since you opened it — here is what it says now. Your edits were not saved.');"), true);
  assert.equal(source.includes('setEdits(null);\n        view.retry();'), true);
});

const gymFiles = () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'marketing' ? [] : walk(at);
    return [at];
  });
  return walk(GYM);
};

test('no gym screen argues for its own design — the swept prose stays swept', () => {
  const swept = [
    'No tour',
    'sample program',
    'catch it, not to write it',
    'Declining costs nothing',
    'behind their back',
    'left empty on purpose',
    'implies the session was wasted',
    'usually a phone left running',
    'nothing honest to say',
    'Dim is what the plan said',
    'no scolding',
    'never the stored value',
    'does not get rewritten',
    'actually owns',
    'Vibration API',
    'does not restate them',
    'theme switch of its own',
    'no taxonomy screen',
    'behaves identically',
    'Sorted by last trained',
    'words gym puts around it',
    'not parchment',
  ];
  for (const file of gymFiles()) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    const said = spoken(fs.readFileSync(file, 'utf8'));
    for (const fragment of swept) {
      assert.equal(said.includes(fragment), false, `${path.relative(GYM, file)} — “${fragment}”`);
    }
  }
});

test('applying and dismissing live in one file, and only on the diff', () => {
  for (const file of gymFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const mine = path.basename(file) === 'Proposals.jsx' || path.basename(file) === 'gymApi.js';
    assert.equal(source.includes('applyProposal') && !mine, false, file);
    assert.equal(source.includes('dismissProposal') && !mine, false, file);
  }
  const source = read('Proposals.jsx');
  assert.equal(source.includes("onClick={() => settle('apply')}"), true);
  assert.equal(source.includes("onClick={() => settle('dismiss')}"), true);
  assert.equal((source.match(/gymApi\.applyProposal/g) ?? []).length, 1);
  assert.equal((source.match(/gymApi\.dismissProposal/g) ?? []).length, 1);
});

test('the proposal diff is keyed on the proposal it reads', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes('<ProposalDiff key={proposalIdOf(hash)} id={proposalIdOf(hash)} log={log} />'), true);
});

test('nothing settles a proposal on a render, and no toggle offers to', () => {
  const source = read('Proposals.jsx');
  assert.equal(source.includes('useEffect'), false);
  assert.equal(source.includes('setInterval'), false);
  assert.equal(source.includes('setTimeout'), false);
  for (const file of gymFiles()) {
    const said = fs.readFileSync(file, 'utf8');
    assert.equal(/autoApply|auto_apply|alwaysApply|trustedConnection/i.test(said), false, file);
  }
});

test('a pending proposal waits at the head of the routines home and on the routine it touches, as a door', () => {
  assert.equal(read('Routines.jsx').includes('<PendingProposals routines={view.data} />'), true);
  assert.equal(read('Proposals.jsx').includes('export function PendingProposals({ routines }) {'), true);
  assert.equal(read('Proposals.jsx').includes('useGymRead(() => gymApi.routines()'), false, 'the home reads its routines once');
  assert.equal(read('Routines.jsx').includes('{routine.pendingProposal && <ProposalFlag />}'), true);
  const source = read('Proposals.jsx');
  assert.equal(source.includes('<a className="gym-proposal-review" href={proposalHref(head.id)}>{reviewLabel(head)}</a>'), true);
  const routines = read('Routines.jsx');
  assert.equal(routines.includes('<RoutineHistory routine={view.data} />'), true);
  assert.equal(routines.includes('const rows = historyRows(routine);'), true);
  assert.equal(routines.includes('gymApi.proposals'), false);
  assert.equal(routines.includes('<a className="gym-history-row" href={row.href}>'), true);
  assert.equal(source.includes('export function ProposalDot()'), true);
  assert.equal(routines.includes('{row.pending && <ProposalDot />}'), true);
});

test('the diff says out loud that it is all-or-none and that nothing has happened yet', () => {
  const said = speech('proposals.js');
  assert.equal(said.includes('Nothing is applied until you tap.'), true);
  assert.equal(said.includes('or none.'), true);
  assert.equal(speech('Proposals.jsx').includes('{atomicLine(proposal)}'), true);
  assert.equal(said.includes('the program’s history, not a toast that disappears'), true);
  assert.equal(speech('Proposals.jsx').includes('{settledLine(proposal)}'), true);
});

test('the diff draws every line the routine would run, not only the ones that changed', () => {
  const source = speech('Proposals.jsx');
  assert.equal(source.includes("if (row.kind === 'kept') {"), true);
  assert.equal(source.includes('{documentNote && <p className="gym-diff-caption">{documentNote}</p>}'), true);
  assert.equal(source.includes('{rows.map((row, index) => ('), true);
  assert.equal(/rows\.filter|rows\.slice/.test(source), false);
  assert.equal(read('gym.css').includes('.gym-diff-row.is-kept {'), true);
});

test('no gym copy claims an agent changes a routine of yours directly, or that it writes nothing', () => {
  const landing = read('marketing/GymLanding.jsx');
  for (const claim of [
    'writes directly',
    'exactly as it would if you had typed it yourself',
    'Write next week’s routine',
    'Add sets, movements and routines',
    'Delete workouts and routines',
    'never writes to your program',
    'delete it yourself',
  ]) {
    assert.equal(landing.includes(claim), false, claim);
  }
  assert.equal(speech('marketing/GymLanding.jsx').includes('the day is yours to edit in Routines'), true);
  const said = speech('marketing/GymLanding.jsx');
  assert.equal(said.includes('it never rewrites a day you already have'), true);
  assert.equal(said.includes('adds lands right away: it takes nothing away'), true);
  assert.equal(said.includes('Propose next week’s routine — you read the diff and tap Apply.'), true);
  const levels = fs.readFileSync(path.join(GYM, 'connect', 'connect.js'), 'utf8');
  assert.equal(levels.includes('Record what happened · add a new day or a new movement · propose changes to the days you have'), true);
  assert.equal(levels.includes('Discard a workout · end a share link · propose a removal'), true);
  assert.equal(said.includes('LEVEL_LINES.write'), true);
  assert.equal(said.includes('LEVEL_LINES.delete'), true);
  assert.equal(said.includes('end a share link, or ask to remove a routine.'), true);

  const connect = fs.readFileSync(path.join(GYM, '../../../public/connect.html'), 'utf8');
  assert.equal(connect.includes('keep your routines'), false);
  assert.equal(connect.includes('What it cannot do is change a routine you already have'), true);
  assert.equal(connect.includes('nothing moves until you tap Apply'), true);
});

test('the connect pitch keeps two homes — the settings row and the page — and the invitation card is gone', () => {
  for (const file of gymFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(/ConnectInvitation|InvitationCard|gym-connect-invite|INVITATION_/.test(source), false, file);
  }
  assert.equal(read('settings/GymSettingsSection.jsx').includes('href={CONNECT_HREF}'), true);
  assert.equal(read('connect/ConnectLog.jsx').includes('export function ConnectLog()'), true);
  assert.equal(read('connect/ConnectLog.jsx').includes('<Back href={COACH_HREF}>{COACH_TITLE}</Back>'), true);
});

test('the connected log is a room off one hash, and never a tab', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'connect' && <ConnectLog />}"), true);
  assert.equal(app.includes("const TAB_SCREENS = ['routines', 'log', 'coach'];"), true);
  for (const file of ['settings/GymSettingsSection.jsx', 'coach/CoachRoom.jsx']) {
    assert.equal(read(file).includes('CONNECT_HREF'), true, file);
  }
});

test('every pushed screen draws its back link through one component, and none points at Today', () => {
  for (const file of gymFiles()) {
    if (!/\.jsx$/.test(file) || path.basename(file) === 'Back.jsx') continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes('className="gym-back" href='), false, `${file} hand-writes a back link`);
    assert.equal(source.includes('<ArrowLeft'), false, file);
    assert.equal(/>\s*Today\s*</.test(source), false, file);
  }
  assert.equal(read('Back.jsx').includes('export function Back({ href, onClick, children })'), true);
  assert.equal(read('Record.jsx').includes('const BACK = ROUTINES_HREF;'), true);
  assert.equal(read('Finish.jsx').includes('<Back href="#/gym/log">The log</Back>'), true);
});

test('discarding a session is confirmed, and the confirmation says what goes and that it stays gone', () => {
  const finish = read('Finish.jsx');
  assert.equal(finish.includes("onClick={() => setConfirming(true)}"), true);
  assert.equal(finish.includes('<button type="button" className="gym-confirm-do" onClick={discard} aria-busy={dropping}>{DISCARD_CONFIRM.confirm}</button>'), true);
  assert.equal(finish.includes('{DISCARD_CONFIRM.keep}'), true);
  assert.equal((finish.match(/gymApi\.discardSession/g) ?? []).length, 1);
  assert.ok(finish.indexOf('const discard = async () => {') < finish.indexOf('gymApi.discardSession'));
  const { DISCARD_CONFIRM } = JSON.parse(JSON.stringify({ DISCARD_CONFIRM: {
    title: 'Discard this session?',
    body: 'Discarding deletes the session and its sets. There is no undoing it.',
    confirm: 'Discard',
    keep: 'Keep it',
  } }));
  const review = read('review.js');
  for (const [key, value] of Object.entries(DISCARD_CONFIRM)) {
    assert.equal(review.includes(`${key}: '${value}'`), true, key);
  }
});

test('a proposal is turned down, not dismissed, behind a confirmation, and the settled line promises no way back', () => {
  const proposals = read('Proposals.jsx');
  assert.equal(proposals.includes('Turn this down'), true);
  assert.equal(proposals.includes('onClick={() => setTurningDown(true)}'), true);
  assert.equal(proposals.includes('{TURN_DOWN_CONFIRM.confirm}'), true);
  assert.equal(proposals.includes('{TURN_DOWN_CONFIRM.keep}'), true);
  assert.equal(/>\s*Dismiss\s*</.test(proposals), false);
  const rules = speech('proposals.js');
  assert.equal(rules.includes('stays in the routine’s history as a record.'), true);
  assert.equal(rules.includes('want it back'), false);
  assert.equal(rules.includes('Turned down ${when}. Nothing changed, and it stays in the routine’s history as a record.'), true);
});

test('the settings section carries the Notes door with the line naming what Coach does not read', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('href={NOTES_HREF}'), true);
  assert.equal(source.includes('{SETTINGS_LINE}'), true);
  assert.equal(speech('notes/notes.js').includes("SETTINGS_LINE = 'Coach reads your notes, not your settings.'"), true);
  assert.ok(source.indexOf('href={NOTES_HREF}') > source.indexOf('Set confirmation'));
  assert.ok(source.indexOf('href={NOTES_HREF}') < source.indexOf('href={EXPORT_HREF}'));
});

test('the Notes screen is its own room off #/gym/notes, headed by the honesty line, seeded with placeholders and nothing stored', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'notes' && <Notes log={log} />}"), true);
  const notes = read('notes/Notes.jsx');
  assert.equal(notes.includes('<Back href={COACH_HREF}>{COACH_TITLE}</Back>'), true);
  assert.equal(notes.includes('<h1 className="gym-title">{HONESTY_LINE}</h1>'), true);
  assert.equal(notes.includes('<p className="gym-notes-sub">{HEAD_LINE}</p>'), true);
  assert.equal(notes.includes('{PLACEHOLDER_TITLES.map((title) => ('), true);
  assert.equal(notes.includes("onClick={() => fresh(title)}"), true);
  assert.equal(notes.includes('{notes.length > 1 && <p className="gym-notes-caption">{PRECEDENCE_CAPTION}</p>}'), true);
  assert.equal((notes.match(/gym-notes-caption/g) ?? []).length, 1, 'one caption on the screen');
  assert.equal(notes.includes('<p className="gym-notes-full">{FULL_LINE}</p>'), true);
  assert.equal(notes.includes('{showsByteCount(body) && ('), true);
  // A sixty-first character is taken and counted, then refused by the store in its own words.
  assert.equal(notes.includes('{showsTitleCount(title) && ('), true);
  assert.equal(notes.includes('{titleCountLabel(title)}'), true);
  assert.equal(/className="gym-note-title-input"[^/]*maxLength/.test(notes), false, 'no silent maxLength on the title');
  assert.equal(notes.includes('<Back href={NOTES_HREF} onClick={(event) => { event.preventDefault(); onClose(); }}>Notes</Back>'), true, 'the editor draws its back through Back.jsx');
  assert.equal(notes.includes("if (error?.code === 'notes-full') onStale();"), true, 'a full account re-reads the list behind the editor');
  assert.equal(notes.includes('onStale={() => settle(null)}'), true);
  assert.equal(notes.includes('{!note.fresh && !confirming && ('), true, 'delete is offered only on a stored note');
  assert.equal(/savePreferences|preferences\(/.test(notes), false, 'notes never ride the preferences document');
  assert.equal(/gym-sheet|Keypad/.test(notes), false);
  for (const gone of ['Drag to reorder', 'Ten notes', '500 bytes each']) {
    assert.equal(speech('notes/Notes.jsx').includes(gone), false, gone);
    assert.equal(speech('notes/notes.js').includes(gone), false, gone);
  }
});

test('the name counter is gated on the last fifth wherever a name is typed, off one threshold', () => {
  for (const file of ['Routines.jsx', 'Record.jsx', 'logger/MovementPicker.jsx']) {
    assert.equal(read(file).includes('showsNameCount('), true, file);
    assert.equal(/const NAME_COUNT_FROM = \d+/.test(read(file)), false, file);
  }
  assert.equal(read('Routines.jsx').includes('{showsNameCount(draft.name) && <span className="gym-name-count">{nameCountLabel(draft.name)}</span>}'), true);
  assert.equal(/export const NAME_COUNT_FROM = 48;/.test(read('log.js')), true);
});

test('Daylight carries no glow token and no black shadow tuned for basalt', () => {
  const css = read('gym.css');
  const light = css.slice(css.indexOf('.gym-root[data-theme="light"] {'), css.indexOf('/* Everything below paints'));
  assert.equal(light.includes('--set-done-glow'), false);
  assert.equal(css.includes('.gym-root[data-theme="light"] .gym-live-dot {\n  box-shadow: none;\n}'), true);
  const painted = css.slice(css.indexOf('/* Everything below paints'));
  assert.equal(/rgba\(0, 0, 0/.test(painted), false);
  assert.equal(/\.gym-toast \{[^}]*box-shadow: var\(--shadow-lg\)/.test(css), true);
  assert.equal(/\.gym-entry\.is-dragging \{[^}]*box-shadow: var\(--shadow-md\)/.test(css), true);
});

test('the connected-log room reads the grant and rebuilds none of it', () => {
  const room = read('connect/ConnectLog.jsx');
  assert.equal(room.includes('listGrants'), true);
  assert.equal(room.includes('listMcpKeys'), true);
  for (const machinery of [
    'revokeGrant', 'postDecision', 'fetchConsentClient', 'McpKeyPanel', 'mintKey', 'createMcpKey',
    'revokeMcpKey',
  ]) {
    assert.equal(room.includes(machinery), false, machinery);
  }
  assert.equal(read('connect/connect.js').includes("export const WORKBENCH_HREF = '#/connect';"), true);
});

test('the connected log reads no entitlement and offers nothing to buy', () => {
  for (const file of ['connect/connect.js', 'connect/ConnectLog.jsx']) {
    const said = speech(file);
    for (const door of ['useEntitlements', 'paidPlansOpen', 'beginUpgrade', 'windmillOne', 'checkout', 'Paddle']) {
      assert.equal(said.includes(door), false, `${file} reaches for ${door}`);
    }
    assert.equal(/[Uu]pgrade|Windmill One|[Ss]ubscri|\$\d|£\d|€\d|[Ll]ocked|free for now/.test(said), false, file);
  }
  assert.equal(/\.gym-connect[a-z-]*\.is-locked/.test(read('gym.css')), false);
});

test('nothing on the connected-log surface reads a last-used stamp, or spells a read time', () => {
  for (const file of ['connect/connect.js', 'connect/ConnectLog.jsx', 'settings/GymSettingsSection.jsx']) {
    const said = speech(file);
    assert.equal(said.includes('lastUsedMs'), false, file);
    assert.equal(/read \d+h ago|hours ago|minutes ago/.test(said), false, file);
  }
});

test('the exchange and the precondition are on the landing and on the crawlable workbench', () => {
  const landing = speech('marketing/GymLanding.jsx');
  assert.equal(landing.includes('<Exchange />'), true);
  assert.equal(landing.includes('{PRECONDITION}'), true);
  assert.equal(landing.includes('{EXCHANGE.asked}'), true);
  assert.equal(landing.includes('{EXCHANGE.landed}'), true);

  const connect = fs.readFileSync(path.join(GYM, '../../../public/connect.html'), 'utf8');
  assert.equal(connect.includes('Write me a four-week block'), true);
  assert.equal(connect.includes('an AI tool of your own that speaks MCP'), true);
  assert.equal(connect.includes('connecting your log costs nothing'), true);
  assert.equal(connect.includes('There is no SSE transport'), true);
});

test('no gym landing copy sells a subscription, on the page or in the crawlable shell', () => {
  const landing = speech('marketing/GymLanding.jsx');
  const head = fs.readFileSync(path.join(GYM, 'marketing', 'landingHead.js'), 'utf8');
  for (const source of [landing, head]) {
    assert.equal(/one subscription|One subscription/.test(source), false);
  }
  assert.equal(landing.includes('one account across Roadmap, Journal and Gym'), true);
});

test('no gym surface counts a decline, on the device or on the wire', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'marketing' ? [] : walk(at);
    return [at];
  });
  const counters = /timesDeclined|declineCount|declinedCount|declineTally|timesOffered|offerCount|dismissCount/i;
  for (const file of walk(GYM)) {
    assert.equal(counters.test(fs.readFileSync(file, 'utf8')), false, file);
  }
  assert.equal(read('Finish.jsx').includes('const [offered, setOffered] = useState(true);'), true);
  assert.equal(read('Finish.jsx').includes('onClick={() => setOffered(false)}'), true);
});

test('a routine written from scratch is named before it is filled in, and only then', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('const [naming, setNaming] = useState(fresh);'), true);
  assert.equal(source.includes('if (naming) {'), true);
  assert.equal(source.includes('Next · add movements'), true);
  assert.equal(source.includes('onClick={() => onName(suggestion)}'), true);
  assert.equal(/suggestion === |selectedSuggestion|chosenName/.test(source), false);
  const step = source.slice(source.indexOf('function NameTheRoutine'), source.indexOf('function RoutineHistory'));
  assert.equal(/createRoutine|replaceRoutine/.test(step), false);
});

test('the target sheet steps a weight on the logger’s ladder and states no step size of its own', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes("import { LADDER_KEYS, ladderLabels, bump } from './logger/ladder.js';"), true);
  assert.equal(source.includes('const rungs = ladderLabels(draft.targetWeightKg ?? EMPTY_BAR_KG);'), true);
  assert.equal(source.includes('bump(held.targetWeightKg, rung.direction, rung.big)'), true);
  assert.equal(/\d\.\d/.test(speech('Routines.jsx').replace(/strokeWidth=\{[\d.]+\}/g, '')), false);
});

test('the target sheet says there is nothing to prefill from, and prefills nothing', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('neverLogged={saysNeverLogged(view.data, draft.entries[target])}'), true);
  assert.equal(
    source.includes('{neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}'),
    true,
  );
  assert.equal(source.includes('untested={'), false);
  for (const file of gymFiles()) {
    if (path.basename(file) === 'gymApi.js') continue;
    assert.equal(fs.readFileSync(file, 'utf8').includes('lastTime('), false, file);
  }
});

test('a line can be left open from the sheet, and the screen says which lines will ask', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('Leave it open'), true);
  assert.equal(source.includes('decide at the rack'), true);
  assert.equal(source.includes('const openTargets = openTargetsLine(draft.entries, log.catalog);'), true);
  assert.equal(source.includes('{openTargets && <p className="gym-editor-open">{openTargets}</p>}'), true);
  assert.equal(/\.gym-editor-untested \{[^}]*var\(--alarm-ink\)/.test(read('gym.css')), false);
});

test('the create door asks how a movement is loaded, and mints nothing before it is answered', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('onClick={() => setMinting({ name: query.trim(), equipment: DEFAULT_EQUIPMENT })}'), true);
  assert.equal(picker.includes('function NewMovement({ draft, onChange, onCancel, onCreate }) {'), true);
  assert.equal(picker.includes('Create and add'), true);
  assert.equal(picker.includes('How is it loaded?'), true);
  assert.equal(picker.includes('{EQUIPMENT_CHOICES.map((choice) => ('), true);
  assert.equal(/'(cable|kettlebell)'/.test(picker), false);
  assert.equal(picker.includes('onCreate({ name: draft.name.trim(), equipment: draft.equipment })'), true);
  assert.equal(read('useTrainingLog.js').includes('id: mintId(\'ex_\'), name: name.trim(), equipment, pattern: CREATED_PATTERN,'), true);
  assert.equal(picker.includes('<button type="button" className="gym-sheet-cancel" onClick={onCancel}>Cancel</button>'), true);
  const sheet = picker.slice(picker.indexOf('function NewMovement'));
  assert.equal(sheet.includes('gym-sheet-close'), false);
});

test('a movement this account minted is tagged `yours`, in the picker and in a routine', () => {
  assert.equal(read('logger/MovementPicker.jsx').includes('<span className="gym-picker-tag">yours</span>'), true);
  assert.equal(read('Routines.jsx').includes('<span className="gym-entry-yours">yours</span>'), true);
  assert.equal(read('Routines.jsx').includes('>mine</span>'), false);
});

test('the rename sheet’s proof is the page’s own read, and no number on it is typed in', () => {
  const source = read('Record.jsx');
  assert.equal(source.includes('record={view.data}'), true);
  assert.equal(source.includes('const proof = renameProofOf(record);'), true);
  assert.equal((source.match(/useGymRead\(/g) ?? []).length, 1);
  assert.equal(source.includes('gymApi.record'), true);
  const sheet = source.slice(source.indexOf('function RenameSheet'));
  assert.equal(/\d+ sessions|\d+ PRs|unchanged|kept/.test(spoken(sheet)), false);
  assert.equal(sheet.includes('<button type="button" className="gym-name-cancel" onClick={onClose}>Cancel</button>'), true);
  assert.equal(sheet.indexOf('gym-name-save') < sheet.indexOf('gym-name-cancel'), true);
  assert.equal(sheet.includes('gym-sheet-close'), false);
});

test('every name a lifter types is capped once, and the counter counts the same field', () => {
  for (const file of ['Routines.jsx', 'Record.jsx', 'logger/MovementPicker.jsx']) {
    const source = read(file);
    assert.equal(source.includes('maxLength={NAME_MAX}'), true, file);
    assert.equal(/const NAME_MAX = \d+/.test(source), false, file);
  }
  for (const file of ['Record.jsx', 'logger/MovementPicker.jsx']) {
    assert.equal(read(file).includes('nameCountLabel('), true, file);
    assert.equal(read(file).includes('isNameOverCap('), true, file);
  }
  assert.equal(read('Routines.jsx').includes('nameCountLabel('), true);
  assert.equal(/export const NAME_MAX = 60;/.test(read('log.js')), true);
});

test('a routine’s name moves with its own document, and claims nothing about what follows it', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('renameRoutine'), false);
  assert.equal(source.includes('gymApi.replaceRoutine(draft.id, write)'), true);
  assert.equal(source.includes('renameProofOf'), false);
  assert.equal(speech('Routines.jsx').includes('unchanged'), false);
});
