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

test('the routine row’s overflow is Duplicate and Delete, and it is the only home either has', () => {
  const source = spoken(read('Routines.jsx'));
  // The survivor: a re-entrancy guard, and a position past the end of the list rather than the
  // original's own.
  assert.equal(source.includes("duplicateRoutine(routine, { id: mintId('rt_'), position: view.data.length })"), true);
  assert.equal(source.includes('if (copying) return;'), true);
  assert.equal(source.includes("duplicateRoutine(view.data,"), false);
  assert.equal(source.includes("duplicateRoutine(draft,"), false);
  assert.equal(source.includes("items={[\n                  { label: 'Duplicate', run: () => duplicate(routine) },\n                  { label: 'Delete', run: () => remove(routine) },\n                ]}"), true);
  // The editor's head keeps no menu of its own. Its Duplicate copied the SAVED routine, took the
  // draft's unsaved edits with it, collided on the original's position and had no re-entrancy guard;
  // the row's — with `copying` and a position past the end of the list — is the one that survives.
  assert.equal((source.match(/<Overflow/g) ?? []).length, 1, 'one overflow, on the row');
  assert.equal(source.includes('More for this routine'), false);
  assert.equal(source.includes('const copy = async ()'), false);
  assert.equal(spoken(read('Overflow.jsx')).includes("editor's head"), false);
  assert.equal(/gym-routine-copy|gym-editor-duplicate|gym-editor-foot/.test(source), false, 'the two drawn buttons are gone');
  assert.equal(/gym-routine-copy|gym-editor-duplicate|gym-editor-foot/.test(read('gym.css')), false);
  // The gate 13-gestures.md put in front of Delete is met: it is withheld, and the room's window is
  // the only thing that ever sends it.
  assert.equal((source.match(/gymApi\.deleteRoutine/g) ?? []).length, 1);
  assert.equal(source.includes("log.withhold({\n    kind: 'routine',"), true);
  assert.ok(source.indexOf('const remove = (routine) => log.withhold(') < source.indexOf('gymApi.deleteRoutine'));
  const overflow = spoken(read('Overflow.jsx'));
  assert.equal(overflow.includes("aria-haspopup=\"menu\""), true);
  assert.equal(overflow.includes("role=\"menuitem\""), true);
  assert.equal(overflow.includes("if (event.key === 'Escape') setOpen(false);"), true);
});

test('every list of a routine’s entries is keyed on the position as well as the movement', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('key={`${entry.exerciseId}-${index}`}'), true);
  assert.equal(source.includes('key={entry.exerciseId}'), false);
});

test('the rail is the design system’s, it reserves its own height, and the room count is stated once', () => {
  const app = read('GymApp.jsx');
  const items = app.match(/\{ label: '[^']+', href: [^,]+, active: screen === '[a-z]+' \}/g) ?? [];
  assert.equal(items.length, 3);
  assert.equal(app.includes("const TAB_SCREENS = ['routines', 'log', 'coach'];"), true);
  assert.equal(app.includes("import { Button, TabRail, Toast } from '../../design-system/index.js';"), true);
  assert.equal(/\.gym-tabs|\.gym-tab\b/.test(read('gym.css')), false, 'the twin is gone with the adoption');
  const rail = fs.readFileSync(path.join(GYM, '../../design-system/navigation/TabRail.jsx'), 'utf8');
  assert.equal(rail.includes('gridTemplateColumns: `repeat(${items.length}, 1fr)`'), true, 'the grid counts the items it was given');
  assert.equal(rail.includes("aria-current={item.active ? 'page' : undefined}"), true);
  assert.equal(rail.includes("<div aria-hidden=\"true\" style={{ height: RAIL_HEIGHT, flex: 'none' }} />"), true);
  // The rail reserves its height, so the column no longer clears furniture it cannot see.
  assert.equal(/\.gym-column \{[^}]*padding: 76px 16px 24px;/.test(read('gym.css')), true);
});

test('the tabs are Routines · The log · Coach, in that order, and #/gym is the first of them', () => {
  const app = read('GymApp.jsx');
  const bar = app.slice(app.indexOf('function TabBar'));
  assert.equal(bar.includes("{ label: 'Routines', href: ROUTINES_HREF, active: screen === 'routines' },"), true);
  assert.equal(bar.includes("{ label: 'The log', href: '#/gym/log', active: screen === 'log' },"), true);
  assert.equal(bar.includes("{ label: 'Coach', href: COACH_HREF, active: screen === 'coach' },"), true);
  assert.ok(bar.indexOf("'Routines'") < bar.indexOf("'The log'"));
  assert.ok(bar.indexOf("'The log'") < bar.indexOf("'Coach'"));
  assert.equal(fs.existsSync(path.join(GYM, 'Today.jsx')), false, 'Today is deleted as a screen');
  assert.equal(app.includes("'today'"), false);
  assert.equal(app.includes("{tabOf(screen) === 'routines' && <RoutinesList log={log} onSignIn={onSignIn} reviewing={screen === 'proposal' ? proposalIdOf(hash) : null} />}"), true);
  assert.equal(app.includes("return screen === 'proposal' ? 'routines' : screen;"), true, 'a routable proposal opens over the routines home');
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

test('every exercise name a lifter can see is a link to that movement’s record — except on a screen holding an unsaved draft, where the movements door on the home reaches it instead', () => {
  assert.equal(read('Log.jsx').includes('<a className="gym-movement-door" href={recordHref(exerciseId)}>'), true);
  assert.equal(read('Finish.jsx').includes('<a className="gym-against-movement gym-movement-door" href={recordHref(row.exerciseId)}>'), true);
  assert.equal(read('Mirror.jsx').includes('<a className="gym-movement-door" href={recordHref(newest.exerciseId)}>'), true);
  assert.equal(read('Proposals.jsx').includes('<a className="gym-diff-name gym-movement-door" href={recordHref(row.exerciseId)}>'), true);
  assert.equal(read('gym.css').includes('.gym-movement-door {'), true);

  // The routine editor is the exception, and it is the draft that makes it one: an anchor out of an
  // unsaved routine eats the draft with no question. The row's name is folded into the control that
  // opens the target sheet, so the name is still a focusable control carrying the movement's
  // identity — and `gym-entry-target`'s accessible name was the numbers alone before it.
  const editor = read('Routines.jsx');
  assert.equal(editor.includes('recordHref'), false);
  assert.equal(editor.includes('<button type="button" className="gym-entry-body" onClick={() => onTarget(index)}>'), true);
  assert.equal(editor.includes('<span className="gym-entry-name">'), true);
  assert.equal(editor.includes('<span className="gym-entry-target">{entryLabel(entry)}</span>'), true);
  assert.equal(/onClick=\{[^}]*\}\s*>\s*\{nameOfMovement/.test(editor), false, 'never a span with onClick');

  // The record page and Rename keep a drawn door: `MOVEMENTS_HREF` beside `New` on the routines
  // home. It is the only route to the record of a movement that sits in a routine and has never
  // been logged, and before this it was reachable by typing a URL.
  assert.equal(editor.includes('<a className="gym-door-past" href={MOVEMENTS_HREF}>Movements</a>'), true);
  assert.equal(read('Record.jsx').includes('return <MovementChooser log={log} />;'), true);

  // The name still ellipsises: the box the deleted door scoped that rule onto is now the name's own.
  assert.equal(/\.gym-entry \.gym-movement-door/.test(read('gym.css')), false);
  assert.equal(/\.gym-entry-name \{[^}]*text-overflow: ellipsis;/.test(read('gym.css')), true);
  assert.equal(/\.gym-entry-name \{[^}]*display: flex/.test(read('gym.css')), false);
  // The target reads as a pill beside it, and a span in a flex row has no button's built-in centring
  // to borrow, so it states its own.
  assert.equal(/\.gym-entry-target \{[^}]*align-items: center;/.test(read('gym.css')), true);
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
  assert.equal((app.match(/active: screen === '[a-z]+'/g) ?? []).length, 3);
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('gym-back'), false, 'a tab root keeps no back link');
  assert.equal(room.includes('<a className="gym-coach-threads-door" href={THREADS_HREF}>{THREADS_TITLE} ›</a>'), true);
  assert.equal(room.includes('<a className="gym-coach-notes-door" href={NOTES_HREF}>'), true);
  assert.equal(room.includes('if (log.session) {'), true);
  const threads = read('coach/Threads.jsx');
  assert.equal(threads.includes('<Back href={COACH_HREF}>{COACH_TITLE}</Back>'), true);
  assert.equal(threads.includes('<Back href={THREADS_HREF}>{THREADS_TITLE}</Back>'), true);
  assert.equal(read('Proposals.jsx').includes('gym-coach-aside'), false, 'the review is a dialog over the room, with no door to another');
});

test('the allowance is the line above the composer, and the spent allowance replaces the composer with the door', () => {
  const room = read('coach/CoachRoom.jsx');
  const allowance = room.indexOf('<p className="gym-coach-allowance">{ALLOWANCE_LINE}</p>');
  const composer = room.indexOf('<div className="gym-coach-compose">');
  assert.ok(allowance > 0 && allowance < composer, 'the promise sits immediately above the composer');
  // Except under the 30-day ceiling, where ten a day is not the rule that stopped the question.
  assert.equal(room.includes("{!closed && !capped?.ceiling && <p className=\"gym-coach-allowance\">{ALLOWANCE_LINE}</p>}"), true);
  assert.equal(room.includes('{!closed && !full && capped && <CapReached capped={capped} onStartAgain={onStartAgain} />}'), true);
  assert.equal(room.includes('{!closed && !full && !capped && ('), true);
  const moment = room.slice(room.indexOf('function CapReached'), room.indexOf('function Answer'));
  // The state says the sentence it was GIVEN — both 429s land here and they do not say the same
  // thing, so a constant of this room's own would be a lie under one of them.
  assert.equal(moment.includes('{capped.note}'), true);
  assert.equal(moment.includes('CAP_REACHED_NOTE'), false);
  assert.equal(read('coach/CoachRoom.jsx').includes('CAP_REACHED_NOTE'), false, 'no constant left over the state');
  assert.equal(moment.includes('href={CONNECT_HREF}'), true);
  // Which door leads is the ceiling's to decide and is decided on the code, never on the sentence.
  // Both orders are held against a rendered room in CoachRoom.test.js; this is the branch itself.
  assert.equal(moment.includes('{capped.ceiling ? <>{door}{again}</> : <>{again}{door}</>}'), true);
  assert.equal(moment.includes("capped.ceiling ? 'gym-coach-capped is-ceiling' : 'gym-coach-capped'"), true);
  // And the ink on top of the order: the unrationed door is filled under the ceiling and the way out
  // of the conversation goes quiet, so an empty rule would leave the two reading alike.
  const css = read('gym.css');
  assert.match(css, /\.gym-coach-capped\.is-ceiling \.gym-coach-free-door \{[^}]*background: var\(--color-brand\);/);
  assert.match(css, /\.gym-coach-capped\.is-ceiling \.gym-coach-again \{[^}]*color: var\(--gym-ink-dim\);/);
  // A quiet control still answers a pointer: the three-class rules above outrank `:hover`, so the
  // ceiling variant states its own or both tap targets go inert.
  assert.match(css, /\.gym-coach-capped\.is-ceiling \.gym-coach-free-door:hover \{/);
  assert.match(css, /\.gym-coach-capped\.is-ceiling \.gym-coach-again:hover \{/);
  // There is no clock: the way back is a new conversation, which returns the composer.
  assert.equal(moment.includes('<button type="button" className="gym-coach-again" onClick={onStartAgain}>{NEW_THREAD_VERB}</button>'), true);
  assert.equal(room.includes("setRefusedFull(false); setCapped(null); setThreadId(mintId(THREAD_PREFIX));"), true);
  assert.equal(room.includes('else if (failure.capped) setCapped({ note: failure.note, ceiling: Boolean(failure.ceiling) });'), true);
  // The server stored nothing of a refused question, so it is not a turn of the conversation.
  assert.equal(room.includes('if (failure.refused) { setTurns((held) => held.slice(0, -1)); setDraft(question); }'), true);
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
  assert.equal(app.includes("{screen === 'threads' && <ThreadsList log={log} />}"), true);
  assert.equal(app.includes("{screen === 'thread' && <ThreadDetail key={threadIdOf(hash)} id={threadIdOf(hash)} log={log} />}"), true);
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
  assert.equal(room.includes("setRefusedFull(false); setCapped(null); setThreadId(mintId(THREAD_PREFIX));"), true);
  for (const file of gymFiles()) {
    assert.equal(spoken(fs.readFileSync(file, 'utf8')).includes('threadFor'), false, file);
  }
});

test('deleting a conversation says what it leaves behind on the act, is withheld, and is neither armed nor confirmed', () => {
  const threads = read('coach/Threads.jsx');
  // The conversation screen states nothing about the delete standing still: what the act leaves
  // behind rides the window as its `detail` and is read at the moment of the act.
  assert.equal(threads.includes('gym-thread-delete-note'), false);
  assert.equal(threads.includes('detail: THREAD_DELETE_DETAIL,'), true);
  assert.equal(read('gym.css').includes('gym-thread-delete-note'), false);
  // A SIBLING FIELD and never a fold: `Toast` puts its children in one bare span, where a newline
  // collapses to a space and runs the two sentences together. `Toast` is the shell's and grows no
  // gym-shaped prop for this.
  const app = read('GymApp.jsx');
  assert.equal(app.includes('<span className="gym-transient-detail">{transient.detail}</span>'), true);
  assert.equal(/\\n/.test(app.slice(app.indexOf('{transient.text}'), app.indexOf('</Toast>'))), false);
  const toast = fs.readFileSync(path.join(GYM, '../../design-system/feedback/Toast.jsx'), 'utf8');
  assert.equal(/detail|gym-/.test(toast), false, 'the shared transient knows nothing about gym');
  assert.equal(read('gym.css').includes('.gym-transient-detail {'), true);
  // It wraps rather than clamps: a truncated disclosure is worse than a taller transient.
  assert.equal(/\.gym-transient-detail \{[^}]*(line-clamp|white-space: nowrap|text-overflow)/.test(read('gym.css')), false);
  // Law 2: a gesture that destroys takes an undo, not a confirmation — so both halves of the old
  // two-tap arm go, and the word that promised no way back with them.
  assert.equal(threads.includes('confirming'), false);
  assert.equal(threads.includes('is-armed'), false);
  assert.equal(threads.includes('DELETE_CONFIRM'), false);
  assert.equal(read('coach/threads.js').includes('DELETE_CONFIRM'), false);
  assert.equal(speech('coach/threads.js').includes('cannot be undone'), false);
  assert.equal(read('gym.css').includes('gym-thread-delete-verb.is-armed'), false);
  assert.equal(
    threads.includes('<button type="button" className="gym-thread-delete-verb" onClick={remove}>{DELETE_VERB}</button>'),
    true,
  );
  // Withheld means NOT SENT: the one call the file makes sits inside the window's `send`.
  assert.equal((threads.match(/gymApi\.deleteThread/g) ?? []).length, 1);
  assert.equal(threads.includes("kind: 'thread',"), true);
  assert.ok(threads.indexOf('log.withhold({') < threads.indexOf('gymApi.deleteThread'));
  assert.equal(read('coach/threads.js').includes("export const THREAD_DELETED = 'Conversation deleted.';"), true);
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

test('the transient is the room’s, and the window’s own carries the Undo, no dismiss, and does not close on it', () => {
  const app = read('GymApp.jsx');
  // The slot is mounted whether or not there is a sentence in it: a live region that arrives with
  // its content is a region a reader may never announce, and these deletes close the surface they
  // were taken on, so this is the only place their way back is drawn.
  assert.equal(app.includes('<Transient transient={log.transient} />'), true);
  assert.equal(app.includes('{log.transient &&'), false);
  assert.equal(app.includes('<div className="gym-toast-slot" role="status">\n      {transient && ('), true);
  assert.equal(app.includes('onClose={transient.dismiss ?? undefined}'), true, 'a window retires itself');
  assert.equal(app.includes('onClick: transient.action.run,'), true, 'Undo re-reads for the rest, it does not dismiss');
  assert.equal(app.includes('log.dismissToast'), false, 'the hook composes the transient; the room only draws it');
  // One Toast in the room, hosted above every screen, so a withheld delete's Undo follows the lifter.
  const hosts = gymFiles().filter((file) => /\.jsx$/.test(file) && fs.readFileSync(file, 'utf8').includes('<Toast'));
  assert.deepEqual(hosts.map((file) => path.basename(file)), ['GymApp.jsx']);
  const room = read('useTrainingLog.js');
  assert.equal(room.includes('action: spoken.undoable ? { label: UNDO_LABEL, run: undoWithheld } : null,'), true);
  assert.equal(room.includes('dismiss: spoken.undoable ? null : dismissToast,'), true);
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

test('a deleted set is withheld for the window, never sent and re-posted, and the SCREEN owns no clock', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('appendSet'), false);
  // The window is the room's: a screen that armed its own clock would settle a delete the moment the
  // lifter walked to another screen, which is the defect 13-gestures.md names by name.
  assert.equal(source.includes('setTimeout'), false, 'the screen arms no clock of its own');
  assert.equal(source.includes('UNDO_MS'), false);
  assert.equal(source.includes("kind: 'set',"), true);
  assert.ok(source.indexOf('withhold({') < source.indexOf('gymApi.deleteSet'));
  const room = read('useTrainingLog.js');
  assert.equal(room.includes('clocks.current.set(key, setTimeout(() => close(key), UNDO_MS));'), true);
  assert.equal(room.includes("import { UNDO_MS } from './fix.js';"), true);
});

test('the window lives only while the room is on screen: leaving it commits nothing', () => {
  const room = read('useTrainingLog.js');
  // The room's one unmount cleanup. A send here would settle a delete past every way back, reached
  // by an ordinary pair of acts — swipe, then leave — which is the hazard the window exists to close.
  const teardown = /useEffect\(\(\) => \(\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(room);
  assert.notEqual(teardown, null, 'the room lost its unmount cleanup');
  assert.equal(/send/.test(teardown[1]), false, 'the room commits a held delete on the way out');
  assert.equal(teardown[1].includes('clocks.current.clear();'), true, 'a clock outlives the room');
  assert.equal(teardown[1].includes('withheld.current = [];'), true, 'what was held is abandoned');
  // An unload handler cannot make it safe either: a request sent during teardown has no promise of
  // arriving, so a "committed" delete might or might not have happened — worse than either answer.
  for (const file of gymFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const exit of ['beforeunload', 'pagehide', 'sendBeacon']) {
      assert.equal(source.includes(exit), false, `${path.basename(file)} flushes the window on ${exit}`);
    }
  }
});

test('every re-read of the session lets go of the corrections this screen was holding', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('const reread = () => {\n    setMoves(new Map());\n    view.retry();\n  };'), true);
  assert.equal(source.includes('if (error.setNotFound) reread();'), true);
  assert.equal(source.includes('<Button variant="secondary" size="sm" onClick={reread}>Retry</Button>'), true);
  assert.equal((source.match(/view\.retry/g) ?? []).length, 1);
});

test('a said sentence stands exactly as long as a withheld delete is held', () => {
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
  assert.equal(source.includes('const dismissToast = useCallback(() => setToast(null), []);'), true);
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

test('the desk’s silence is said once for the whole section, and no row claims a difference the phones do not have', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  // `text-budget.md`: a section caption is at most one per screen. It sits above the rows, so the
  // rest row states the clock and nothing restates the silence under it.
  assert.equal((said.match(/never sounds an alarm of its own/g) ?? []).length, 1);
  assert.ok(said.indexOf('never sounds an alarm of its own') < said.indexOf('<Row title="Units"'));
  // Both phones have a haptic AND a sound, and honour each switch on its own — `GymConfirm.swift`
  // and `GymConfirm.kt` read `confirmHaptic` and `confirmSound` independently — so a clause telling
  // the platforms apart was false on both.
  assert.equal(said.includes('a haptic where the platform has one'), false);
  assert.equal(said.includes('a sound where it does not'), false);
  assert.equal(said.includes('Sets are logged on your phone, and that is where these are honoured.'), true);
  // The lb clause enumerates because the enumeration is the disclosure: the three fields typed here
  // stay in kilograms, and the weigh-in — the one field typed in the display unit — is not among them.
  assert.equal(said.includes('a backfill, a correction, a routine target'), true);
  assert.equal(said.includes('preferences.units === LB &&'), true);
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
  assert.equal(source.includes('<Button full href={routineHref(NEW_ROUTINE_ID)}>Build a routine</Button>'), true);
  assert.equal(source.includes("view.phase === 'ready' && routines.length === 0"), true);
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

test('every byte counter in this room goes alarm past its bound, in one shared state', () => {
  // One shape, one rule: a counter that has stopped accepting keys says so in alarm ink wherever it
  // is drawn. Each of these opens from the STORE, whose ceilings are wider than the field's, so
  // `76/60` and `4001 of 4000 bytes` are states a lifter reaches without typing a key. The class is
  // shared with the note editor's `.gym-note-count.is-over` — the room mints no second rule.
  const drawn = [];
  for (const file of gymFiles()) {
    if (!/\.jsx$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      if (line.includes('gym-name-count')) drawn.push([path.basename(file), line.trim()]);
    }
  }
  assert.deepEqual(drawn.map(([where]) => where).sort(), [
    'FixSheet.jsx', 'MovementPicker.jsx', 'Record.jsx', 'Routines.jsx',
  ]);
  for (const [where, line] of drawn) {
    assert.equal(
      line.includes("? 'gym-name-count is-over' : 'gym-name-count'"),
      true,
      `${where} draws a byte counter that cannot go alarm: ${line}`,
    );
  }
  // And the ink is the token, never a literal: one value moves all four.
  const css = read('gym.css');
  assert.equal(css.includes('.gym-name-count.is-over {\n  color: var(--alarm-ink);\n}'), true);
  assert.equal(css.includes('.gym-note-count.is-over {\n  color: var(--alarm-ink);\n}'), true);
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
  // Apply keeps its place in the tab order, so the handler is what refuses an unseen diff.
  assert.equal(source.includes("onClick={() => { if (!seen || deciding) return; settle('apply'); }}"), true);
  assert.equal(source.includes("onClick={() => settle('dismiss')}"), true);
  assert.equal((source.match(/gymApi\.applyProposal/g) ?? []).length, 1);
  assert.equal((source.match(/gymApi\.dismissProposal/g) ?? []).length, 1);
});

test('the routable proposal is the home’s to open: keyed on its id, settling into the home’s own read, closing to it', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("<RoutinesList log={log} onSignIn={onSignIn} reviewing={screen === 'proposal' ? proposalIdOf(hash) : null} />"), true);
  assert.equal(app.includes('<ProposalReview'), false, 'a dialog beside the list would settle without the list hearing of it');
  const routines = read('Routines.jsx');
  const routable = routines.slice(routines.indexOf('{reviewing && ('), routines.indexOf("{view.phase === 'loading'"));
  assert.equal(routable.includes('<ProposalReview'), true);
  assert.equal(routable.includes('key={reviewing}'), true);
  assert.equal(routable.includes('id={reviewing}'), true);
  assert.equal(routable.includes('onChanged={view.refresh}'), true);
  assert.equal(routable.includes('onClose={() => { window.location.hash = ROUTINES_HREF; }}'), true);
  assert.equal(routable.includes('log.say(receiptLine(receipt)); view.refresh(); window.location.hash = ROUTINES_HREF;'), true);
  assert.equal(fs.existsSync(path.join(GYM, 'Proposals.jsx')), true);
  assert.equal(read('Proposals.jsx').includes('export function ProposalDiff'), false, 'the pushed screen is gone');
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

test('the proposal eyebrow holds one line: the routine name truncates and the stamp keeps its room', () => {
  // The eyebrow carries a name a lifter typed, up to `NAME_MAX` code points, on both cards.
  assert.equal(read('Proposals.jsx').includes('<span className="gym-proposal-name">{`Proposal · ${routine.name}`}</span>'), true);
  assert.equal(read('coach/CoachRoom.jsx').includes('<span className="gym-proposal-name">{`Proposal · ${proposal.baseName}`}</span>'), true);
  assert.equal(/export const NAME_MAX = 60;/.test(read('log.js')), true);
  const css = read('gym.css');
  const name = /\.gym-proposal-name \{([^}]*)\}/.exec(css)[1];
  for (const rule of ['min-width: 0;', 'overflow: hidden;', 'white-space: nowrap;', 'text-overflow: ellipsis;']) {
    assert.equal(name.includes(rule), true, rule);
  }
  // The stamp is the shorter half and never the half that gives way, so it neither shrinks nor wraps.
  const when = /\.gym-proposal-when \{([^}]*)\}/.exec(css)[1];
  assert.equal(when.includes('flex: none;'), true);
  assert.equal(when.includes('white-space: nowrap;'), true);
  // Rendered against this stylesheet in headless Chrome at 320px with a 60-character name: the
  // eyebrow is 13px — one line — the name ellipsises, and the stamp holds its full 145.7px.
  assert.equal(/\.gym-proposal-kicker \{[^}]*display: flex;/.test(css), true);
});

test('the reserved slot is what keeps Apply still, and its height is a declaration, not its text', () => {
  const css = read('gym.css');
  // Measured against this stylesheet in headless Chrome at 390px across unseen → seen →
  // unseen-return: the slot is 16.80px in all three and Apply's top never moves. Without the
  // declaration the slot collapses to 0 on the seen frame and Apply travels 16.8px each way, which
  // no render assertion can see.
  assert.match(css, /\.gym-proposal-gate \{[^}]*min-height: 1\.4em;/);
  // Nothing else in the band reserves a line, so this one declaration is the whole reservation.
  assert.equal(/\.gym-proposal-atomic \{[^}]*min-height/.test(css), false);
  assert.equal(/\.gym-proposal-band \{[^}]*min-height/.test(css), false);
});

test('a pending proposal is drawn ONCE on the routines home — one card, named for the routine it touches', () => {
  assert.equal(read('Routines.jsx').includes('<PendingProposals routines={routines} log={log} onChanged={view.refresh} />'), true);
  assert.equal(read('Proposals.jsx').includes('export function PendingProposals({ routines, log, onChanged }) {'), true);
  assert.equal(read('Proposals.jsx').includes('useGymRead(() => gymApi.routines()'), false, 'the home reads its routines once');
  // The home already draws one card per waiting routine, so a mark on the row is the same fact
  // twice. The card's kicker names the routine, which is what the mark was for.
  assert.equal(read('Proposals.jsx').includes('<span className="gym-proposal-name">{`Proposal · ${routine.name}`}</span>'), true);
  for (const gone of ['ProposalFlag', 'gym-routine-flag', 'gym-routine-line', 'proposal pending']) {
    assert.equal(read('Routines.jsx').includes(gone), false, gone);
    assert.equal(read('Proposals.jsx').includes(gone), false, gone);
  }
  // The wrapper that laid the name beside the mark goes with it: the name is the row's own line now.
  assert.equal(read('gym.css').includes('gym-routine-flag'), false);
  assert.equal(read('gym.css').includes('gym-routine-line'), false);
  assert.equal(read('Routines.jsx').includes('<span className="gym-routine-name">{routine.name}</span>'), true);
  // The agent that wrote it keeps two permanent homes: the sheet header and the routine's own
  // history row.
  assert.equal(read('Proposals.jsx').includes('{`from ${sourceLabel(proposal.source)}  ·  ${arrivedLabel(proposal.createdAt)}`}'), true);
  assert.equal(speech('proposals.js').includes('${countedLabel(head)} from ${sourceLabel(head.source)}'), true);
  const source = read('Proposals.jsx');
  // One affordance, a link that keeps its routable address and opens the dialog in place on a tap.
  assert.equal(source.includes('href={proposalHref(head.id)}'), true);
  assert.equal(source.includes('onClick={(event) => { event.preventDefault(); onReview(head.id); }}'), true);
  assert.equal(source.includes('{REVIEW_VERB}'), true);
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

test('the finish screen has one way out, at the head of the ready state and of the failed read, and its offer says why Save is inert', () => {
  const source = read('Finish.jsx');
  // The foot that held a second door to the session and a Done that finished nothing is gone: the
  // way back is the room's own, through the component, above the title. Its POSITION is the pin —
  // the failed read carried these same bytes before this screen had a head back at all, so the
  // substring alone proves nothing about the state that lost its foot.
  const back = '<Back href={sessionHref(id)}>Session detail</Back>';
  assert.equal((source.match(new RegExp(back.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 2);
  const ready = source.slice(source.indexOf('<section className="gym-finish-screen">'));
  assert.equal(ready.startsWith(`<section className="gym-finish-screen">\n      ${back}\n      <h1`), true, 'the ready state');
  const failed = source.slice(source.indexOf("if (view.phase === 'failed')"));
  assert.equal(failed.includes(`<>\n        ${back}\n        <p className="gym-read-failed">`), true, 'the failed read');
  assert.equal((source.match(/gym-finish-foot/g) ?? []).length, 2, 'the slight pair and the keep card, and no third');
  for (const gone of ['gym-finish-detail', 'gym-finish-done', 'tap to rename', 'gym-keep-hint', 'gym-keep-name']) {
    assert.equal(source.includes(gone), false, gone);
    assert.equal(read('gym.css').includes(gone), false, gone);
  }
  // The field is named by its label, and says it is a field with its border, ground and focus edge.
  assert.equal(source.includes('aria-label="Routine name"'), true);
  // One source for the sentence, read by the editor's gate and by the offer, and drawn on the empty
  // name alone — Save is inert while the write is in flight too, where the sentence would be a lie.
  assert.equal(speech('routines.js').includes("export const NAME_IT_TO_SAVE_IT = 'Name it to save it.';"), true);
  assert.equal(source.includes('{name.trim() === \'\' && <p className="gym-keep-missing">{NAME_IT_TO_SAVE_IT}</p>}'), true);
  for (const file of ['Finish.jsx', 'Routines.jsx']) {
    assert.equal(read(file).includes("'Name it to save it.'"), false, `${file} keeps a copy of the sentence`);
  }
});

test('discarding a session is withheld and undoable, so it is not confirmed and promises no permanence', () => {
  const finish = read('Finish.jsx');
  // Law 2: a dialog in front of an act that has an undo is ceremony. Both halves of the old one go.
  assert.equal(finish.includes('setConfirming'), false);
  assert.equal(finish.includes('gym-confirm'), false);
  assert.equal(finish.includes('DISCARD_CONFIRM'), false);
  assert.equal((finish.match(/gymApi\.discardSession/g) ?? []).length, 1);
  assert.equal(finish.includes("kind: 'session',"), true);
  assert.ok(finish.indexOf('log.withhold({') < finish.indexOf('gymApi.discardSession'));
  assert.equal(finish.includes('<button type="button" className="gym-short-discard" onClick={discard}>'), true);
  assert.equal(read('review.js').includes("export const SESSION_DELETED = 'Session deleted.';"), true);
  // The sentence became false the day the delete gained a way back, so it is nowhere in the room.
  for (const file of gymFiles()) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    assert.equal(fs.readFileSync(file, 'utf8').includes('There is no undoing it'), false, file);
  }
});

test('a proposal is turned down, not dismissed, behind a confirmation, and the settled line promises no way back', () => {
  const proposals = read('Proposals.jsx');
  assert.equal(speech('proposals.js').includes("TURN_DOWN_VERB = 'Turn this down'"), true);
  assert.equal(proposals.includes('{TURN_DOWN_VERB}'), true);
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
  assert.equal(notes.includes('{shown.length > 1 && <p className="gym-notes-caption">{PRECEDENCE_CAPTION}</p>}'), true);
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
  assert.equal(notes.includes('{!note.fresh && ('), true, 'delete is offered only on a stored note');
  // The cap is the STORE's count and the rows are the drawn list: a note held for deletion is off
  // the screen and still counted, so the cap line stands and `Add a note` never opens a refusal.
  assert.equal(notes.includes('{isFull(notes)'), true);
  assert.equal(notes.includes("const gone = log.hidden('note');"), true);
  assert.equal(notes.includes('const shown = notes.filter((note) => !gone.has(note.id));'), true);
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
  // The gate that DRAWS the counter and the state that colours it are two rules over one field: it
  // appears in the last fifth, and turns alarm only past the bound.
  assert.equal(read('Routines.jsx').includes('trailing={showsNameCount(draft.name) && ('), true);
  assert.equal(
    read('Routines.jsx').includes("<span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>"),
    true,
  );
  assert.equal(read('Routines.jsx').includes('{nameCountLabel(draft.name)}'), true);
  assert.equal(/export const NAME_COUNT_FROM = 48;/.test(read('log.js')), true);
});

test('the token bridge: one block per skin, and no shared role pointed back at gym’s alias of it', () => {
  const css = read('gym.css');
  const start = css.indexOf('/* ── The bridge —');
  assert.notEqual(start, -1, 'the bridge is a named block, not a scatter of overrides');
  const bridge = css.slice(start, css.indexOf('/* Everything below paints'));
  const blocks = bridge.match(/\.gym-root\[data-theme="(dark|light)"\] \{/g) ?? [];
  assert.deepEqual(blocks, ['.gym-root[data-theme="dark"] {', '.gym-root[data-theme="light"] {']);
  for (const role of ['--text-on-accent: var(--gym-on-accent);', '--color-danger: var(--alarm-ink);', '--focus-ring:']) {
    assert.equal((bridge.match(new RegExp(role.replace(/[-()*+?.\\^$|[\]]/g, '\\$&'), 'g')) ?? []).length, 2, role);
  }
  // A cycle is the trap: --gym-surface IS var(--surface-card), so the bridge may never restate one.
  for (const alias of ['--surface-card', '--surface-canvas', '--surface-hover', '--surface-sunken',
    '--text-primary', '--text-secondary', '--text-tertiary', '--color-brand', '--border-subtle',
    '--border-default', '--color-success', '--color-danger-bg']) {
    assert.equal(bridge.includes(`${alias}:`), false, `${alias} is re-declared inside .gym-root`);
  }
  // And the one gym token the bridge reads must not read back through it.
  assert.equal(/--alarm-ink: var\(--color-danger\)/.test(css), false);
  assert.equal(/--gym-on-accent: var\(/.test(css), false);
  // Nothing outside the bridge overrides a design-system role for one component.
  const painted = css.slice(css.indexOf('/* Everything below paints'));
  assert.equal(/--focus-ring:|--text-on-accent:|--color-danger:/.test(painted), false);
});

test('the picker opens on the six it counted, then the catalogue, and says which is which', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('const { featured, matches, empty, create } = movementOptions({ catalog, order, query, sessions: opened });'), true);
  // Read once, at the first read that ANSWERS: an empty window is re-seeded until the log lands, and
  // from then on the poll behind the picker keeps landing sessions and the six may not reshuffle
  // under a finger already reaching for one of them.
  assert.equal(picker.includes('  const held = useRef([]);\n'), true);
  assert.equal(picker.includes('  if (held.current.length === 0) held.current = sessions.slice(0, TRAINED_WINDOW);\n'), true);
  assert.equal(picker.includes('  const opened = held.current;\n'), true);
  assert.equal(picker.includes('useState(() => sessions'), false, 'the window is not frozen at the first render');
  assert.equal(picker.includes('<p className="gym-picker-group">{FEATURED_HEAD}</p>'), true);
  assert.equal((picker.match(/<ul className="gym-picker-list">/g) ?? []).length, 2);
  // The count comes off the log the page already holds — no read of its own, and no invented rank.
  const rules = speech('logger/movements.js');
  assert.equal(rules.includes('for (const name of session.exercises ?? []) counted.set(name, (counted.get(name) ?? 0) + 1);'), true);
  assert.equal(/gymApi|fetch\(/.test(rules), false, 'the six cost no read');
  for (const host of ['Routines.jsx', 'Backfill.jsx', 'Record.jsx']) {
    assert.equal(read(host).includes('sessions={log.summaries}'), true, host);
  }
  // The head names the shortcut in the bytes both phones draw, and asserts no ranking over a log
  // this page has not read.
  assert.equal(rules.includes("export const FEATURED_HEAD = 'The six';"), true);
  // The count is over a fixed depth, so tapping Older on the Log tab cannot reshuffle the six.
  assert.equal(rules.includes('export const TRAINED_WINDOW = 50;'), true);
  assert.equal(rules.includes('for (const session of sessions.slice(0, TRAINED_WINDOW))'), true);
  // And the section is never gated: an empty query shows six on the first session as on the five
  // hundredth, because what the log cannot fill comes off the opener list every surface draws.
  assert.equal(rules.includes("const featured = term === '' ? mostTrained(available, sessions) : [];"), true);
  assert.equal(/firstSession|isFirstSession|sessions\.length === 0/.test(rules), false);
  // The catalogue's boundary is wider than the eyebrow's own offset, or the head reads as the head
  // of every row under it.
  assert.equal(/\.gym-picker-list \+ \.gym-picker-list \{\n  margin-top: 22px;\n\}/.test(read('gym.css')), true);
  assert.equal(/\.gym-picker-group \{[^}]*margin: 14px 0 0;/.test(read('gym.css')), true);
});

test('Daylight carries no glow token and no black shadow tuned for basalt', () => {
  const css = read('gym.css');
  const light = css.slice(css.indexOf('.gym-root[data-theme="light"] {'), css.indexOf('/* Everything below paints'));
  assert.equal(light.includes('--set-done-glow'), false);
  assert.equal(css.includes('.gym-root[data-theme="light"] .gym-live-dot {\n  box-shadow: none;\n}'), true);
  const painted = css.slice(css.indexOf('/* Everything below paints'));
  assert.equal(/rgba\(0, 0, 0/.test(painted), false);
  const toast = fs.readFileSync(path.join(GYM, '../../design-system/feedback/Toast.jsx'), 'utf8');
  assert.equal(toast.includes("boxShadow: 'var(--shadow-lg)'"), true, 'the transient’s depth is the token’s');
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

test('the naming interstitial is gone: the name is the editor’s first field, and Save waits for it', () => {
  const source = read('Routines.jsx');
  for (const gone of ['NameTheRoutine', 'naming', 'Next · add movements', 'NAME_SUGGESTIONS', 'gym-name-opener']) {
    assert.equal(source.includes(gone), false, gone);
  }
  assert.equal(read('routines.js').includes('NAME_SUGGESTIONS'), false, 'the suggestions go with the screen');
  assert.equal(/gym-name-sub|gym-name-openers|gym-name-opener/.test(read('gym.css')), false);
  // The field the interstitial existed to collect, focused, on the screen that always had it.
  assert.equal(source.includes('autoFocus={fresh}'), true);
  assert.equal(source.includes('placeholder="Name this routine"'), true);
  // The Save gate survives the screen, and prints one refusal at a time.
  assert.equal(source.includes("const missing = draft.name.trim() === '' ? NAME_IT_TO_SAVE_IT : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);"), true);
  assert.equal(source.includes('disabled={Boolean(missing) || saving}'), true);
  assert.equal(source.includes('{missing && <p className="gym-editor-missing">{missing}</p>}'), true);
});

test('the ladder and the keypad are rack controls: off the target sheet, kept on the fix sheet', () => {
  const source = read('Routines.jsx');
  for (const rack of ['Keypad', 'LADDER_KEYS', 'ladderLabels', 'gym-rungs', 'gym-target-step', 'gym-target-clear']) {
    assert.equal(source.includes(rack), false, `the target sheet still draws ${rack}`);
  }
  assert.equal(/gym-target-row|gym-target-step|gym-target-value|gym-target-weight|gym-target-clear|gym-target-open/.test(read('gym.css')), false);
  // The fix sheet is at the rack (16-the-workout.md) and keeps both.
  const fix = read('FixSheet.jsx');
  assert.equal(fix.includes("import { Keypad } from './logger/Keypad.jsx';"), true);
  assert.equal(fix.includes("import { LADDER_KEYS, ladderLabels } from './logger/ladder.js';"), true);
  assert.equal(fs.existsSync(path.join(GYM, 'logger', 'Keypad.jsx')), true);
  // The digits and the decimal separator read as themselves; the pad's two glyphs are named through
  // one lookup, and ± takes the target sheet's own bytes.
  const keypad = read('logger/Keypad.jsx');
  assert.equal(keypad.includes("const SPOKEN = { '±': 'Flip the sign', [DELETE]: 'Delete' };"), true);
  assert.equal(keypad.includes('aria-label={SPOKEN[key]}'), true);
  assert.equal(keypad.includes('aria-label={SPOKEN[DELETE]}'), true);
  assert.equal((keypad.match(/aria-label="Flip the sign"/g) ?? []).length, 0, 'one key, not twelve');
  assert.equal(source.includes('aria-label="Flip the sign"'), true, 'the sheet names it in the same bytes');
  assert.equal(/\d\.\d/.test(speech('Routines.jsx').replace(/strokeWidth=\{[\d.]+\}/g, '')), false);
});

test('the target sheet is three typed fields, each saying what empty means, and one refusal at a time', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('placeholder={OPEN_PLACEHOLDER}'), true);
  assert.equal(source.includes('placeholder={MAX_PLACEHOLDER}'), true);
  assert.equal(source.includes('placeholder={LAST_TIME_PLACEHOLDER}'), true);
  assert.equal(source.includes("inputMode=\"decimal\""), true);
  assert.equal((source.match(/<Input/g) ?? []).length, 4, 'the name field and the sheet’s three');
  assert.equal(source.includes("const refusalFor = (field) => (refusal?.field === field ? refusal.message : undefined);"), true);
  assert.equal(source.includes('{DECIMAL_NOTE}'), true);
  assert.equal((source.match(/DECIMAL_NOTE/g) ?? []).length, 2, 'said once on the sheet: the import and the one use');
  // The escape hatches came off with the ladder: clearing a field IS the escape.
  for (const gone of ['take it to max', 'use last time', 'Leave it open', 'decide at the rack']) {
    assert.equal(source.includes(gone), false, gone);
  }
  assert.equal(source.includes('onOpen'), false, 'there is no second verb to leave a line open');
  // The refused clear keeps the field's value and its SELECTION, or backspace-then-retype — the way a
  // one-digit number is changed on a phone — would append to the digit that never left.
  assert.equal(source.includes('input.value = next.sets;'), true);
  assert.equal(source.includes('input.setSelectionRange(0, next.sets.length);'), true);
  // The sheet's Save-side twin: the head's commit is a reach-band-sized control like the field beside it.
  assert.equal(/<Button\n\s+size="md"\n\s+disabled=\{Boolean\(missing\) \|\| saving\}/.test(source), true);
});

test('the two ways into an open line are opposite acts, so they take opposite sentences', () => {
  const rules = read('routines.js');
  assert.equal(rules.includes("export const CLEAR_REPS_AND_WEIGHT = 'Clear reps and weight first — an open line names neither.';"), true);
  assert.equal(rules.includes("export const NAME_SETS_FIRST = 'Name the sets first — an open line names neither.';"), true);
  // The pinned sentence belongs to the clear and to nothing else; the mirror state names the way out
  // the lifter actually wants, which is to name the sets they just typed reps for.
  assert.equal(rules.includes("  if (fields.clearRefused) return { field: 'sets', message: CLEAR_REPS_AND_WEIGHT };"), true);
  assert.equal(rules.includes("  if (open && named) return { field: 'sets', message: NAME_SETS_FIRST };"), true);
  // And the sheet opens on what the row holds: no target is invented for the lifter to delete.
  assert.equal(rules.includes('targetDraftOf'), false);
  assert.equal(/NEW_ENTRY_SETS|NEW_ENTRY_REPS/.test(rules), false);
  assert.equal(rules.includes("    sets: entry.targetSets == null ? '' : String(entry.targetSets),"), true);
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

test('the open line is one sentence, drawn once beneath the list and once on the sheet', () => {
  const source = read('Routines.jsx');
  // Once under the whole list, when at least one row is open — never one copy per open row — and
  // never while a target sheet stands over the list: up there the sheet owns the sentence, so the
  // list's copy is not left lit behind the scrim beside the sheet's own refusal.
  assert.equal(
    source.includes('{target == null && hasOpenEntry(draft.entries) && <p className="gym-open-line">{OPEN_LINE}</p>}'),
    true,
  );
  // And once on the target sheet, while the line it is holding is the open one AND nothing on the
  // sheet is being refused: a refusal and a blessing of the same state are never drawn together.
  assert.equal(source.includes('{!refusal && isOpenFields(fields) && <p className="gym-open-line">{OPEN_LINE}</p>}'), true);
  assert.equal((source.match(/OPEN_LINE/g) ?? []).length, 3, 'the import and the two placements');
  assert.equal(source.includes('gym-entry-open'), false, 'the per-row copy is gone');
  assert.equal(/\.gym-entry-open\b/.test(read('gym.css')), false);
  assert.equal(read('routines.js').includes('export function hasOpenEntry(entries) {'), true);
  assert.equal(source.includes('openTargetsLine'), false);
  assert.equal(read('routines.js').includes('openTargetsLine'), false);
  assert.equal(read('routines.js').includes("export const OPEN_LINE = 'You decide the numbers at the rack.';"), true);
  assert.equal(/gym-editor-open\b/.test(read('gym.css')), false);
  // The row still names itself open in its own target button, so nothing above the list has to.
  assert.equal(read('log.js').includes("export const OPEN_TARGET = 'open';"), true);
  assert.equal(/\.gym-editor-untested/.test(read('gym.css')), false, 'the pill is the design system’s Tag');
  assert.equal(source.includes('<Tag size="sm">{UNTESTED}</Tag>'), true);
});

test('the create door asks how a movement is loaded, and mints nothing before it is answered', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('onClick={() => setMinting({ name: query.trim(), equipment: DEFAULT_EQUIPMENT })}'), true);
  assert.equal(picker.includes('function NewMovement({ draft, onChange, onCancel, onCreate }) {'), true);
  assert.equal(picker.includes('Create and add'), true);
  assert.equal(picker.includes('How is it loaded?'), true);
  // One sheet draws one kind of label: the caption over the chooser is the design system's field
  // label, the same treatment the Input above it draws for `Name`.
  const label = read('gym.css').match(/\.gym-name-label \{([^}]*)\}/)[1];
  assert.equal(label.includes('font-size: var(--text-sm);'), true);
  assert.equal(label.includes('font-weight: 700;'), true);
  assert.equal(label.includes('color: var(--text-primary);'), true);
  assert.equal(label.includes('letter-spacing: normal;'), true);
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

test('every name a lifter types is capped once, in code points, and the counter counts the same field', () => {
  // The finish card is in this list because it is a field a lifter types a routine name into. It
  // was the one that was not, which is how it kept a bound of its own in a unit of its own.
  for (const file of ['Routines.jsx', 'Record.jsx', 'logger/MovementPicker.jsx', 'Finish.jsx']) {
    const source = read(file);
    assert.equal(source.includes('cappedName(event.target.value)'), true, file);
    assert.equal(source.includes('maxLength'), false, `${file}: maxLength counts UTF-16 units, not characters`);
    assert.equal(/const NAME_MAX = \d+/.test(source), false, file);
  }
  // The counter is the editor's, not the receipt's: the finish card takes the cap and its unit and
  // leaves the chrome behind, which is a decision rather than an oversight.
  assert.equal(read('Finish.jsx').includes('nameCountLabel('), false);
  assert.equal(read('Finish.jsx').includes('showsNameCount('), false);
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

test('bodyweight: the reading heads the log, the chip is the one door in the reach band, and the chart is the design system’s', () => {
  const log = read('Log.jsx');
  assert.equal(log.includes('<BodyweightReading latest={weights.latest} />'), true);
  assert.ok(log.indexOf('<BodyweightReading') < log.indexOf('Add a past workout'), 'the reading sits in the head');
  assert.equal(log.includes('<WeighInChip onOpen={() => setWeighing(true)} />'), true);
  assert.equal((log.match(/<WeighInSheet/g) ?? []).length, 1);
  const screen = read('bodyweight/Bodyweight.jsx');
  assert.equal(screen.includes("import { Button, DotChart, Tabs } from '../../../design-system/index.js';"), true);
  assert.equal(fs.existsSync(path.join(GYM, '../../design-system/charts/DotChart.jsx')), true, 'a new primitive, authored in the design system');
  assert.equal(/Keypad|LADDER|ladder|gym-rungs|record-bar/.test(screen), false, 'no ladder, no keypad, no bar chart');
  assert.equal(screen.includes('<WeighInChip'), false, 'no second door on the chart screen');
  assert.equal(screen.includes('inputMode="decimal"'), true);
  assert.equal(screen.includes('type="date"'), true);
  assert.equal(read('GymApp.jsx').includes("{screen === 'bodyweight' && <BodyweightScreen log={log} />}"), true);
  // Both answers off the ROOM's registers, once each: the log's head holds the second instance of
  // this hook, and a day recorded per instance would leave the two disagreeing about the account.
  assert.equal(screen.includes("const gone = log.gone('bodyweight');"), true);
  assert.equal(screen.includes("const hidden = log.hidden('bodyweight');"), true);
  assert.equal((screen.match(/hidden\('bodyweight'\)/g) ?? []).length, 1);
  assert.equal((screen.match(/log\.gone\('bodyweight'\)/g) ?? []).length, 1);
  // The stance reads the account, the rows read the window, and the delete's send is the store call
  // and nothing else — a screen's own record of what the store took is the thing this replaced.
  assert.equal(screen.includes('send: () => gymApi.deleteBodyweight(dateLocal),'), true);
  assert.equal(screen.includes('const rows = entries.filter((entry) => !hidden.has(entry.dateLocal));'), true);
  assert.equal(screen.includes('weights.entries.length === 0'), true);
  assert.equal(screen.includes('windowOf(weights.rows, windowId, now)'), true);
  assert.equal(log.includes('useBodyweight(log)'), true);
  assert.equal(read('GymApp.jsx').includes("const TAB_SCREENS = ['routines', 'log', 'coach'];"), true, 'not a fourth tab');
  for (const file of gymFiles()) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    const said = spoken(fs.readFileSync(file, 'utf8')).toLowerCase();
    assert.equal(said.includes('tracker'), false, file);
  }
  for (const file of ['bodyweight/bodyweight.js', 'bodyweight/Bodyweight.jsx']) {
    const said = speech(file).toLowerCase();
    for (const banned of ['goal', 'projection', 'bmi', 'body fat', 'trend', 'streak', 'congrat', 'well done', 'scrub']) {
      assert.equal(said.includes(banned), false, `${file} — ${banned}`);
    }
  }
  const settings = read('settings/GymSettingsSection.jsx');
  assert.equal(settings.includes('{hasWeighIns && ('), true);
  assert.ok(settings.indexOf('href={EXPORT_NOTES_HREF}') < settings.indexOf('href={EXPORT_BODYWEIGHT_HREF}'));
  assert.ok(settings.indexOf('href={EXPORT_BODYWEIGHT_HREF}') < settings.indexOf('<ConnectedLog />'));
  assert.equal(speech('coach/coach.js').includes("list_bodyweight: 'read your bodyweight'"), true);
});

test('the review sheet: one Apply in a scroll-gated dialog, kept rows folded in place, the card reads still waiting', () => {
  const proposals = read('Proposals.jsx');
  assert.equal(proposals.includes("import { Button, Dialog } from '../../design-system/index.js';"), true);
  assert.equal(proposals.includes('gate="scrolled"'), true);
  assert.equal(proposals.includes('disabled={!seen || deciding}'), true);
  assert.equal(proposals.includes('className="gym-proposal-turn-down"'), true);
  assert.equal(/gym-proposal-dismiss|gym-proposal-verbs/.test(proposals), false, 'the pair is gone');
  assert.equal(/gym-proposal-dismiss|gym-proposal-verbs|gym-proposal-decide/.test(read('gym.css')), false);
  assert.equal(proposals.includes("row.kind === 'kept-run' ? ("), true);
  assert.equal(proposals.includes('{keptRunLabel(row.rows.length)}'), true);
  assert.equal(proposals.includes('{wroteKicker(proposal.source)}'), true);
  assert.equal(/\.gym-proposal-wrote-kicker \{[^}]*text-transform/.test(read('gym.css')), false, 'the kicker is drawn as written, never uppercased');
  assert.equal(/\.gym-proposal-wrote-kicker \{[^}]*font-size: 10\.5px/.test(read('gym.css')), true);
  assert.equal(proposals.includes('{`${STILL_WAITING} · ${arrivedLabel(head.createdAt)}`}'), true);
  assert.equal(read('coach/CoachRoom.jsx').includes('{pending ? STILL_WAITING : stateChip(proposal)?.toLowerCase()}'), true);
  assert.equal(read('coach/CoachRoom.jsx').includes('<ReviewDoor head={proposal} onReview={() => setReviewing(true)} />'), true);
  const dialog = fs.readFileSync(path.join(GYM, '../../design-system/feedback/Dialog.jsx'), 'utf8');
  assert.equal(dialog.includes("const gated = gate === 'scrolled';"), true);
});
