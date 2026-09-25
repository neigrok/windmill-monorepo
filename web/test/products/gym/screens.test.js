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

test('the routine row’s overflow is Log past above Delete, and no surface offers a copy of a routine', () => {
  const source = spoken(read('Routines.jsx'));
  assert.equal(source.includes(`items={[
                  { label: 'Log past', run: () => { window.location.hash = backfillHref(routine.id, FROM_ROUTINE_MENU); } },
                  { label: 'Delete', run: () => remove(routine) },
                ]}`), true);
  assert.equal(/duplicat/i.test(source), false, 'the room has no duplicate act');
  assert.equal(/duplicat/i.test(spoken(read('routines.js'))), false);
  // The editor's head keeps no menu of its own: the row's is the one menu in the room.
  assert.equal((source.match(/<Menu/g) ?? []).length, 1, 'one menu, on the row');
  assert.equal(source.includes("import { Button, Icon, Menu, Tag } from '../../design-system/index.js';"), true, 'the menu is the design system’s');
  assert.equal(fs.existsSync(path.join(GYM, 'Overflow.jsx')), false, 'the gym-local twin is gone');
  assert.equal(/gym-overflow/.test(read('gym.css')), false);
  assert.equal(read('gym.css').includes('.gym-routine .wm-menu-open {'), true, 'the row alone shapes its opener');
  assert.equal(source.includes('More for this routine'), false);
  assert.equal(/gym-routine-copy|gym-editor-duplicate|gym-editor-foot/.test(source), false);
  assert.equal(/gym-routine-copy|gym-editor-duplicate|gym-editor-foot/.test(read('gym.css')), false);
  // The gate 13-gestures.md put in front of Delete is met: it is withheld, and the room's window is
  // the only thing that ever sends it.
  assert.equal((source.match(/gymApi\.deleteRoutine/g) ?? []).length, 1);
  assert.equal(source.includes("log.withhold({\n    kind: 'routine',"), true);
  assert.ok(source.indexOf('const remove = (routine) => log.withhold(') < source.indexOf('gymApi.deleteRoutine'));
});

test('every list of a routine’s entries is keyed on the position as well as the movement', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('key={`${entry.exerciseId}-${index}`}'), true);
  assert.equal(source.includes('key={entry.exerciseId}'), false);
});

test('gym navigation stays below the scrollable content on pushed pages', () => {
  const app = read('GymApp.jsx');
  const content = app.search(/<main[^>]*className=\{`gym-column/);
  assert.ok(content >= 0 && app.indexOf('<TabBar screen={tabOf(screen)} />') > app.indexOf('</main>', content));
  assert.equal(app.includes('<div ref={content} className="gym-scroll">'), true);
  assert.equal(app.includes('<nav className="gym-tabs" aria-label="Gym">'), true);
  assert.equal(app.includes("aria-current={screen === tab.screen ? 'page' : undefined}"), true);
  assert.equal(app.includes('TabRail'), false);
  assert.equal(/\.gym-tabs \{[^}]*height: var\(--gym-bottom-panel-height\);[^}]*justify-content: center;/.test(read('gym.css')), true);
});

test('the three tabs preserve their order and every pushed destination maps to a room', () => {
  const app = read('GymApp.jsx');
  const bar = app.slice(app.indexOf('function TabBar'));
  assert.deepEqual([...bar.matchAll(/label: '([^']+)'/g)].map((match) => match[1]), ['Routines', 'The log', 'Coach']);
  assert.equal(app.includes("['coach', 'thread', 'threads', 'notes'].includes(screen)"), true);
  assert.equal(app.includes("['log', 'session', 'finish', 'backfill', 'bodyweight', 'record', 'share-log'].includes(screen)"), true);
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
  assert.equal(mirror.includes('workoutClocks(session, sets, Date.now())'), true, 'the clock counts up from the start');
  assert.equal(mirror.includes('const [, setBeat] = useState(0);'), true, 'the beat is the mirror’s own state');
  for (const file of gymFiles()) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    assert.equal(/\bresting\b/i.test(spoken(fs.readFileSync(file, 'utf8'))), false, file);
  }
});

test('every exercise name a lifter can see is a link to that movement’s record — except on a screen holding an unsaved draft, where the movements door on the home reaches it instead', () => {
  // A name inside a workout opens the record FROM that workout, so the record's back link returns
  // to it; the live mirror and a proposal sit on the Routines home and open it from there.
  assert.equal(read('Log.jsx').includes('href={recordHref(exerciseId, fromSession(id,'), true);
  assert.equal(read('Finish.jsx').includes('<a className="gym-against-movement gym-movement-door" href={recordHref(row.exerciseId, fromSession(id))}>'), true);
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
  assert.equal(app.includes("{screen === 'coach' && <CoachRoom key={account?.id} log={log} accountId={account?.id} />}"), true);
  for (const file of gymFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const mine = ['GymApp.jsx', 'Threads.jsx'].includes(path.basename(file));
    assert.equal(source.includes('<CoachRoom') && !mine, false, file);
    assert.equal(source.includes('CoachPanel'), false, file);
  }
  for (const screen of ['Log.jsx', 'Finish.jsx']) {
    assert.equal(read(screen).includes('askCoach'), false, screen);
  }
});

test('Coach is a tab root: a column in the rail, no back link, its threads and notes pushed under it', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("['coach', 'thread', 'threads', 'notes'].includes(screen)"), true);
  assert.equal((app.match(/label: '[^']+', href: [^,]+, screen:/g) ?? []).length, 3);
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('gym-back'), false, 'a tab root keeps no back link');
  assert.equal(room.includes('<a className="gym-coach-threads-door" href={THREADS_HREF}>History</a>'), true);
  // History is visible; secondary destinations stay in More.
  const head = room.slice(room.indexOf('<header className="gym-coach-head">'), room.indexOf('</header>'));
  assert.equal(head.includes("label: 'Notes'"), true);
  assert.equal(head.includes('<a className="gym-coach-threads-door" href={THREADS_HREF}>History</a>'), true);
  assert.equal((head.match(/label: 'Notes'/g) ?? []).length, 1);
  assert.equal(/gym-coach-notes-verb|gym-coach-notes-go/.test(read('gym.css')), false);
  assert.equal(room.includes('Your workout is on your phone. This room is here when it is over.'), true);
  const threads = read('coach/Threads.jsx');
  assert.equal(threads.includes('<Back href={COACH_HREF}>{COACH_TITLE}</Back>'), true);
  assert.equal(threads.includes('<Back href={THREADS_HREF}>{THREADS_TITLE}</Back>'), true);
  assert.equal(read('Proposals.jsx').includes('gym-coach-aside'), false, 'proposal review remains inline');
});

test('Coach answer receipts come from the server, separately from the live workout mirror', () => {
  assert.equal(speech('coach/coach.js').includes('read: reply.read,'), true);
  for (const file of ['coach/coach.js', 'coach/CoachRoom.jsx']) {
    assert.equal(/read:\s*\{/.test(read(file)), false, file);
  }
  assert.equal(read('coach/CoachRoom.jsx').includes('const read = readLine(receipt.read);'), true);
});

test('the receipt is always visible and the step list collapses behind it', () => {
  const room = read('coach/CoachRoom.jsx');
  assert.equal(room.includes('<summary className="gym-coach-read">{read}</summary>'), true);
  assert.equal(room.includes('<p className="gym-coach-read">{read}</p>'), true, 'a list of nothing readable still draws the receipt');
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

test('the threads list and one conversation are rooms in the frame, and the detail is keyed', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'threads' && <ThreadsList log={log} accountId={account?.id} />}"), true);
  assert.equal(app.includes("{screen === 'thread' && <ThreadDetail key={`${account?.id}-${threadIdOf(hash)}`} id={threadIdOf(hash)} log={log} accountId={account?.id} />}"), true);
  assert.equal(app.includes("['coach', 'thread', 'threads', 'notes'].includes(screen)"), true);
});

test('a thread row draws the question as it was asked, and nothing edits it', () => {
  const threads = read('coach/Threads.jsx');
  assert.equal(threads.includes('<span className="gym-thread-title">{thread.title}</span>'), true);
  assert.equal(threads.includes('<h2 className="gym-thread-name gym-visually-hidden">{thread.title}</h2>'), true);
  const said = speech('coach/Threads.jsx');
  for (const edit of ['.slice(', '.substring(', '.toUpperCase(', '.trim()', 'summar']) {
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
  assert.equal(read('coach/CoachRoom.jsx').includes('<a className="gym-coach-threads-door" href={THREADS_HREF}>History</a>'), true);
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
    threads.includes('initialThread={thread} onDelete={remove}'),
    true,
  );
  // Withheld means NOT SENT: the one call the file makes sits inside the window's `send`.
  assert.equal((threads.match(/gymApi\.deleteThread/g) ?? []).length, 1);
  assert.equal(threads.includes("kind: 'thread',"), true);
  assert.ok(threads.indexOf('log.withhold({') < threads.indexOf('gymApi.deleteThread'));
  assert.equal(read('coach/threads.js').includes("export const THREAD_DELETED = 'Conversation deleted.';"), true);
});

test('changes stay in Coach, and proposal cards link back only outside their conversation', () => {
  assert.equal(read('Routines.jsx').includes('RoutineHistory'), false);
  const proposals = read('Proposals.jsx');
  assert.equal(proposals.includes('{!inConversation && conversationOf(proposal.source) && <a'), true);
  assert.equal(proposals.includes('href={threadHref(conversationOf(proposal.source))}'), true);
});

test('workout rows read actual facts and collapse only an honest common scheme', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('const scheme = collapsedScheme(group);'), true);
  assert.equal(source.includes('setLoadLabel(set)'), true);
  assert.equal(source.includes('workoutTotals(sets)'), true);
  assert.equal(source.includes('setNoteOf('), false);
  assert.equal(source.includes('planFrozenLabel(session)'), true);
});

test('the shared workout is answered above the auth switch, and wears none of the app’s chrome', () => {
  const app = read('GymApp.jsx');
  const shared = app.indexOf('if (sharedToken || sharedLogToken) {');
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
  assert.equal(read('gym.css').includes('.gym-own-header {'), true);
});

test('every set in a session read whole is a door onto the fix, and says so', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('window.location.hash = fixSetHref(id, set.id, from)'), true);
  assert.equal(source.includes('<span className="gym-set-fix">Fix set</span>'), true);
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
  assert.equal(room.includes('action: spoken.undoable ? { label: UNDO_LABEL, run: undoWithheld } : spoken.action ?? null,'), true);
  assert.equal(room.includes('dismiss: spoken.undoable ? null : dismissToast,'), true);
});

test('the history reader changes session identity without replacing the history index', () => {
  assert.equal(read('GymApp.jsx').includes("(screen === 'log' || screen === 'session') && <LogList"), true);
  assert.equal(read('Log.jsx').includes('<SessionDetail key={selected} id={selected} log={log} embedded from={from} />'), true);
});

test('web correction uses plain numeric fields and validates their raw values', () => {
  const fix = read('FixSheet.jsx');
  assert.equal(fix.includes('inputMode="decimal"'), true);
  assert.equal(fix.includes('inputMode="numeric"'), true);
  assert.equal(fix.includes('readSetFields(draft)'), true);
  assert.equal(/Keypad|LADDER_KEYS|ladderLabels/.test(fix), false);
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
  assert.equal(source.includes('if (error.setNotFound) { closeFix(); reread();'), true);
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
  assert.equal(read('Log.jsx').includes('if (focusedSet) return <FixSheet'), true);
});

test('the CSV export is out of the product: no door, no string, no href, and no read that gated one', () => {
  for (const file of gymFiles()) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    const said = fs.readFileSync(file, 'utf8');
    assert.equal(/EXPORT_|\/export\b|\bCSV\b|gym-threads-export/.test(said), false, file);
  }
  const settings = read('settings/GymSettingsSection.jsx');
  assert.equal(/hasLog|hasNotes|hasWeighIns|api\.sessions|api\.notes|api\.bodyweight/.test(settings), false);
  assert.equal(read('coach/Threads.jsx').includes('Export conversations'), false);
  const pricing = fs.readFileSync(path.join(GYM, '../../../public/pricing.html'), 'utf8');
  assert.equal(pricing.includes('CSV out'), false);
  assert.equal(pricing.includes('<b>The gym log — all of it</b>Sets, sessions, routines, e1RM.'), true);
});

test('the picker reads every movement’s last set when it opens, and never on a keystroke', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('const last = useGymRead(() => gymApi.lastSets(), []);'), true);
  assert.equal((picker.match(/useGymRead\(/g) ?? []).length, 1);
  assert.equal(/useGymRead\([^;]*\[[^\]]*query/.test(picker), false);
  for (const host of ['Routines.jsx', 'backfill/Backfill.jsx', 'Record.jsx']) {
    assert.equal(read(host).includes('lastSets'), false, host);
  }
});

test('a picker row says it has no last time, only once the read behind it has answered', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes("const meta = last.phase === 'ready' ? lastSetsById(last.data) : null;"), true);
  assert.equal(
    picker.includes('{!pane && meta && <span className="gym-picker-meta">{lastSetLabel(meta.get(each.id))}</span>}'),
    true,
  );
  assert.equal(speech('logger/MovementPicker.jsx').includes('never logged'), false);
  assert.equal(speech('logger/movements.js').includes('never logged'), false);
  assert.equal(speech('logger/movements.js').includes("NO_LAST_TIME_META = 'no last time'"), true);
});

test('the empty routines home offers to build one, and this surface still starts nothing', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('<Button href={routineHref(NEW_ROUTINE_ID)}>New routine</Button>'), true);
  // Over the ACCOUNT's program and never the drawn rows: the offer is an act, and an act may not be
  // offered over a store the window has only taken a routine off the screen of (13-gestures.md).
  assert.equal(source.includes("view.phase === 'ready' && program.length === 0"), true);
  for (const file of gymFiles()) {
    if (!/\.(jsx?)$/.test(file)) continue;
    const said = spoken(fs.readFileSync(file, 'utf8'));
    assert.equal(said.includes('Start a session'), false, file);
    assert.equal(said.includes('Just start logging'), false, file);
  }
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
  const levels = read('marketing/GymLanding.jsx');
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

test('every pushed screen draws its back link through one component, and none points at Today', () => {
  for (const file of gymFiles()) {
    if (!/\.jsx$/.test(file) || path.basename(file) === 'Back.jsx') continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes('className="gym-back" href='), false, `${file} hand-writes a back link`);
    assert.equal(source.includes('<ArrowLeft'), false, file);
    assert.equal(/>\s*Today\s*</.test(source), false, file);
  }
  assert.equal(read('Back.jsx').includes('export function Back({ href, onClick, children })'), true);
  // The record's back link is the one that varies: it names where the record was opened.
  assert.equal(read('Record.jsx').includes('const back = backOf(from, session);'), true);
  assert.equal(read('Record.jsx').includes('<Back href={back.href}>{back.label}</Back>'), true);
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

test('the settings section carries the Notes door under the line the Notes screen heads itself with', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('href={NOTES_HREF}'), true);
  assert.equal(source.includes('{HEAD_LINE}'), true);
  assert.equal(speech('notes/notes.js').includes('SETTINGS_LINE'), false);
  assert.equal(source.includes('SETTINGS_LINE'), false);
});

test('the Notes screen is its own room off #/gym/notes, titled as a room with the honesty line under it, seeded with placeholders and nothing stored', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'notes' && <Notes log={log} />}"), true);
  const notes = read('notes/Notes.jsx');
  assert.equal(notes.includes('<Back href={COACH_HREF}>{COACH_TITLE}</Back>'), true);
  assert.equal(notes.includes(`<h1 className="gym-title">{NOTES_TITLE}</h1>
        <p className="gym-notes-sub">{HEAD_LINE}</p>
      </header>
      <p className="gym-notes-disclosure">{HONESTY_LINE}</p>`), true);
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
  assert.equal(notes.includes('<Back href={NOTES_HREF} onClick={(event) => { event.preventDefault(); onClose(); }}>{NOTES_TITLE}</Back>'), true, 'the editor draws its back through Back.jsx');
  assert.equal(notes.includes("if (error?.code === 'notes-full') onStale();"), true, 'a full account re-reads the list behind the editor');
  assert.equal(notes.includes('onStale={() => settle(null)}'), true);
  assert.equal(notes.includes('{!note.fresh && ('), true, 'delete is offered only on a stored note');
  // The cap is the STORE's count and the rows are the drawn list: a note held for deletion is off
  // the screen and still counted, so the cap line stands and `Add a note` never opens a refusal.
  assert.equal(notes.includes('{isFull(notes)'), true);
  assert.equal(notes.includes("const hidden = log.hidden('note');"), true);
  assert.equal(notes.includes('const shown = notes.filter((note) => !hidden.has(note.id));'), true);
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
  assert.equal(read('Routines.jsx').includes('{showsNameCount(draft.name) && <span'), true);
  assert.equal(
    read('Routines.jsx').includes("<span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>"),
    true,
  );
  assert.equal(read('Routines.jsx').includes('{nameCountLabel(draft.name)}'), true);
  assert.equal(/export const NAME_COUNT_FROM = 48;/.test(read('log.js')), true);
});

test('the token bridge: one block per skin, and no shared role pointed back at gym’s alias of it', () => {
  const css = read('gym.css');
  const tokens = read('gymTokens.css');
  const start = tokens.indexOf('/* ── The bridge —');
  assert.notEqual(start, -1, 'the bridge is a named block, not a scatter of overrides');
  const bridge = tokens.slice(start);
  // Each skin block is keyed twice: on a stamped .gym-skin, and on an unstamped one standing in a gym
  // ground — the brand root's scenes — which takes the theme of that ground.
  const skin = (theme) => `.gym-skin[data-theme="${theme}"],\n[data-theme="${theme}"][data-brand="gym"] .gym-skin:not([data-theme]) {`;
  const blocks = bridge.match(/\.gym-skin\[data-theme="(dark|light)"\],\n[^\n]*\{/g) ?? [];
  assert.deepEqual(blocks, [skin('dark'), skin('light')]);
  for (const role of ['--text-on-accent: var(--gym-on-accent);', '--color-danger: var(--alarm-ink);', '--focus-ring:']) {
    assert.equal((bridge.match(new RegExp(role.replace(/[-()*+?.\\^$|[\]]/g, '\\$&'), 'g')) ?? []).length, 2, role);
  }
  // A cycle is the trap: --gym-surface IS var(--surface-card), so the bridge may never restate one.
  for (const alias of ['--surface-card', '--surface-canvas', '--surface-hover', '--surface-sunken',
    '--text-primary', '--text-secondary', '--text-tertiary', '--color-brand', '--border-subtle',
    '--border-default', '--color-success', '--color-danger-bg']) {
    assert.equal(bridge.includes(`${alias}:`), false, `${alias} is re-declared inside .gym-skin`);
  }
  // And the one gym token the bridge reads must not read back through it.
  assert.equal(/--alarm-ink: var\(--color-danger\)/.test(tokens), false);
  assert.equal(/--gym-on-accent: var\(/.test(tokens), false);
  // Nothing outside the bridge overrides a design-system role for one component. The landing takes
  // the same tokens through the same file, not a copy.
  assert.equal(/--focus-ring:|--text-on-accent:|--color-danger:/.test(css), false);
  assert.equal(css.startsWith("@import './gymTokens.css';"), true);
  assert.equal(read('marketing/gymLanding.css').startsWith("@import '../gymTokens.css';"), true);
  assert.equal(/--gym-canvas:|--gym-ink:/.test(read('marketing/gymLanding.css')), false, 'the landing copies no token');
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
  assert.equal(picker.includes("(!pane || query.trim() !== '')"), true);
  assert.equal(picker.includes('className="gym-picker-new"'), true);
  // The count comes off the log the page already holds — no read of its own, and no invented rank.
  const rules = speech('logger/movements.js');
  assert.equal(rules.includes('for (const name of session.exercises ?? []) counted.set(name, (counted.get(name) ?? 0) + 1);'), true);
  assert.equal(/gymApi|fetch\(/.test(rules), false, 'the six cost no read');
  for (const host of ['Routines.jsx', 'backfill/Backfill.jsx', 'Record.jsx']) {
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

test('Daylight carries no glow token and no black shadow tuned for the night', () => {
  const css = read('gym.css');
  const tokens = read('gymTokens.css');
  const light = tokens.slice(tokens.indexOf('.gym-skin[data-theme="light"],'), tokens.indexOf('/* ── The bridge'));
  assert.ok(light.length > 0, 'the daylight block is gone from gymTokens.css');
  assert.equal(light.includes('--set-done-glow'), false);
  assert.equal(css.includes('.gym-root[data-theme="light"] .gym-live-dot {\n  box-shadow: none;\n}'), true);
  const painted = css.slice(css.indexOf('/* Everything below paints'));
  assert.equal(/rgba\(0, 0, 0/.test(painted), false);
  const toast = fs.readFileSync(path.join(GYM, '../../design-system/feedback/Toast.jsx'), 'utf8');
  assert.equal(toast.includes("boxShadow: 'var(--shadow-lg)'"), true, 'the transient’s depth is the token’s');
  assert.equal(/\.gym-entry\.is-dragging \{[^}]*box-shadow: var\(--shadow-md\)/.test(css), true);
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

test('rack controls stay outside web planning and correction fields', () => {
  for (const file of ['planning/TargetEditor.jsx', 'FixSheet.jsx', 'correction/WorkoutEditor.jsx']) {
    assert.equal(/Keypad|LADDER_KEYS|gym-rungs/.test(read(file)), false, file);
  }
  const keypad = read('logger/Keypad.jsx');
  assert.equal(keypad.includes("const SPOKEN = { '±': 'Flip the sign — band-assisted', [DELETE]: 'Delete' };"), true);
});

test('the two shape refusals are struck on this surface: an open line disables, it never refuses', () => {
  const rules = read('routines.js');
  for (const file of gymFiles()) {
    const said = fs.readFileSync(file, 'utf8');
    assert.equal(/CLEAR_REPS_AND_WEIGHT|NAME_SETS_FIRST|clearRefused|an open line names neither/.test(said), false, file);
  }
  // And the sheet opens on what the row holds: no target is invented for the lifter to delete.
  assert.equal(rules.includes('targetDraftOf'), false);
  assert.equal(/NEW_ENTRY_SETS|NEW_ENTRY_REPS|targetSets|targetReps|targetWeightKg/.test(rules), false, 'the triple is gone from the rules');
  assert.equal(rules.includes("weight: set.weightKg == null ? '' : String(set.weightKg),"), true);
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
  assert.equal(source.includes('record={view.data.record}'), true);
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
  assert.ok(log.indexOf('gym-log-options') < log.indexOf('<BodyweightReading'), 'the reading is in log options');
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
  assert.equal(read('GymApp.jsx').includes("'backfill', 'bodyweight', 'record'"), true, 'not a fourth tab');
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
  assert.equal(speech('coach/coach.js').includes("list_bodyweight: 'read your bodyweight'"), true);
});

test('the finished session’s detail has the discard door, through the same window as every other delete; the live mirror has none', () => {
  const log = read('Log.jsx');
  assert.equal(log.includes('{isFinished(session) && <div className="gym-detail-discard">'), true);
  assert.equal(log.includes('<button type="button" className="gym-short-discard" onClick={discard}>Discard session</button>'), true);
  assert.equal((log.match(/gymApi\.discardSession/g) ?? []).length, 1);
  assert.ok(log.indexOf("kind: 'session',") < log.indexOf('gymApi.discardSession'));
  assert.equal(log.includes('line: SESSION_DELETED,'), true, 'the same sentence as the review’s discard');
  assert.equal(log.includes("window.location.hash = '#/gym/log';"), true);
  assert.equal(/gym-confirm|confirming/.test(log), false, 'no confirmation in front of an undoable act');
  assert.equal(/[Dd]iscard/.test(speech('Mirror.jsx')), false, 'the phone owns the open session');
  assert.equal(read('Finish.jsx').includes('function ShortSession'), true, 'the review keeps its own');
});

test('the past workout takes its day in one tap, keeps the native field for any other day, and has one door back', () => {
  const screen = read('backfill/Backfill.jsx');
  assert.equal(screen.includes('type="date"'), true);
  assert.equal(screen.includes('max={todayOf(now)}'), true);
  assert.equal(screen.includes('const [day, setDay] = useState(() => todayOf(now));'), true);
  assert.equal(/gym-save-cancel|>Cancel</.test(screen), false, 'the bottom door is gone; Back is the one');
  assert.equal(read('gym.css').includes('gym-save-cancel'), false);
});

test('a room’s title and a record’s name wear the family’s display title, one step smaller at the shell’s narrow width', () => {
  const css = read('gym.css');
  assert.equal(css.includes(`.gym-title,
.gym-record-name {
  margin: 0;
  font-family: var(--font-display);
  font-size: 32px;
  font-weight: 700;
  line-height: 40px;
  letter-spacing: 0;
  color: var(--gym-ink);
}
@media (max-width: 480px) {
  .gym-title,
  .gym-record-name {
    font-size: 28px;
    line-height: 36px;
  }
}`), true);
  assert.equal((css.match(/^\.gym-(title|record-name)[ ,]/gm) ?? []).length, 2, 'the shared rule is the only one either has');
});

test('every radius is a token, save the speech bubble’s tail', () => {
  const radii = [...read('gym.css').matchAll(/border-radius: ([^;]+);/g)].map((match) => match[1]);
  const raw = [...new Set(radii.filter((value) => /\d+px/.test(value.replace(/calc\(var\(--radius-\w+\) - 1px\)/g, ''))))];
  assert.deepEqual(raw, ['var(--radius-lg) var(--radius-lg) 5px var(--radius-lg)']);
});

test('at the narrow width the past workout’s Save band pins to the bottom on the page’s own ground', () => {
  assert.equal(read('gym.css').includes(`@media (max-width: 480px) {
  .gym-save {
    position: sticky;
    bottom: 0;
    z-index: 1;
    padding: 12px 0 calc(12px + var(--content-safe-area-bottom, env(safe-area-inset-bottom)));
    background: var(--gym-canvas);
  }
}`), true);
  assert.equal(read('backfill/Backfill.jsx').includes('<div className="gym-save">'), true);
});

test('the routine editor and the note editor carry their back link on its own line, above the head', () => {
  const routine = read('Routines.jsx');
  assert.equal(routine.indexOf('<Back href={ROUTINES_HREF}>Routines</Back>', routine.indexOf('className="gym-plan-editor"')) < routine.indexOf('<header className={`gym-editor-head'), true);
  assert.equal(read('notes/Notes.jsx').includes(`      <Back href={NOTES_HREF} onClick={(event) => { event.preventDefault(); onClose(); }}>{NOTES_TITLE}</Back>
      <header className="gym-editor-head">`), true);
});
