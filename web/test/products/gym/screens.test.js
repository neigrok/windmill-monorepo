// TWO REACT-IDENTITY RULES, READ OFF THE SOURCE — because that is the only place this runner can
// read them. `node --test` has no JSX transform, so nothing under test/ can mount a gym screen; the
// rules below are about which component instance React keeps and which list rows it can tell apart,
// and both are decided by one attribute in the tree rather than by anything a pure module returns.
// The behaviour behind them is driven for real against the rendered components in the wave's
// server-render smoke; what is pinned here is the attribute, so removing it fails a test rather
// than only a screenshot nobody takes again.
//
// The same file (test/shell-boundaries.test.mjs) walks every import in src/ the same way, for the
// same reason: some invariants live in the shape of the source and nowhere else.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');
const read = (file) => fs.readFileSync(path.join(GYM, file), 'utf8');

// The source with its commentary stripped — roughly, what could end up in front of a lifter, as
// against what a file says ABOUT what it puts there. A scan for banned copy runs over this: a
// comment has to stay free to name the promise it is refusing to make.
const speech = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// A DRAFT MAY NOT OUTLIVE THE DOCUMENT IT IS OF. The editor holds one routine under the lifter's
// hand and nothing reaches the store until Done, so the instance is scoped to the routine id: the
// key is what makes React drop it when the hash moves to another routine. Without it, the editor's
// own Duplicate button — which moves the hash to the copy — left the ORIGINAL's unsaved draft on
// screen under the copy's URL, and Done then whole-document PUT it back onto the original. A
// routine renamed and reprogrammed into another one, with no undo.
test('the routine editor is keyed on the routine it edits, so a hash move remounts it', () => {
  const app = read('GymApp.jsx');
  // The seam, not an effect copying the prop into state: a draft synced out of props still has a
  // frame where the screen holds one routine's edits under another routine's URL.
  assert.equal(app.includes('<RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />'), true);
});

// A ROUTINE MAY NAME ONE LIFT TWICE — the heavy line and the back-off line — which is the case
// `(routine_id, position)` exists to make representable. Two rows sharing a React key is a list
// React reconciles however it likes: the rows can swap or one can be dropped. The editor is the
// one screen left that lists a routine's entries — Today's due card went with the web Start (§11).
test('every list of a routine’s entries is keyed on the position as well as the movement', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('key={`${entry.exerciseId}-${index}`}'), true);
  assert.equal(source.includes('key={entry.exerciseId}'), false);
});

// THE TAB COUNT LIVES IN TWO PLACES and neither of them can see the other: the anchors are JSX and
// the columns are a CSS grid. A fourth anchor over a three-column grid wraps the tab bar onto two
// rows over the content it is fixed above — which no test that mounts a component would catch,
// because it is a layout fact and not a render one.
//
// THREE, AND THE COUNT ITSELF IS THE DECISION. §B cuts the fourth tab in as many words — *there is
// no dashboard in this product* — and the statistics room stood in that column until §H replaced it
// with one movement's page, which is reached by tapping a name and is not a room to visit.
test('the tab bar draws the same number of tabs the grid has columns for', () => {
  const tabs = read('GymApp.jsx').match(/className=\{screen === '[a-z]+' \? 'gym-tab is-on' : 'gym-tab'\}/g) ?? [];
  const grid = /\.gym-tabs \{[^}]*grid-template-columns: repeat\((\d+), 1fr\)/.exec(read('gym.css'));
  assert.equal(tabs.length, 3);
  assert.equal(grid?.[1], String(tabs.length));
  // And every one of them is a screen the frame will actually draw a tab bar over.
  assert.equal(read('GymApp.jsx').includes("const TAB_SCREENS = ['today', 'log', 'routines'];"), true);
});

// A MOVEMENT'S NAME IS A DOOR (§H), and which text carries the link is a fact about the JSX — no
// pure module can be asked whether the session's exercise header and the routine's row are links.
// The premise is "anywhere it appears", so all four sites are pinned: one left as plain text is a
// record a lifter can reach from the log and not from the program they wrote, or from the workout
// they just finished and not the one they are in, and the page would be findable by accident
// rather than by rule.
//
// THREE NAMES ARE DELIBERATELY NOT DOORS, and each is the same rule from a different side. The
// picker's rows inside the routine editor and the backfill form mean "add this movement" — the
// meaning of a pick belongs to the host, and a tap that navigated out of a form holding unsaved
// sets would destroy them. The finish screen's keep-as-routine list is that form's own preview of
// what it will create. And the coach's shared page has no account behind it, so there is no record
// for its reader to open.
test('every exercise name a lifter can see is a link to that movement’s record', () => {
  assert.equal(read('Log.jsx').includes('<a className="gym-movement-door" href={recordHref(exerciseId)}>'), true);
  assert.equal(read('Routines.jsx').includes('<a className="gym-entry-name gym-movement-door" href={recordHref(entry.exerciseId)}>'), true);
  assert.equal(read('Finish.jsx').includes('<a className="gym-against-movement gym-movement-door" href={recordHref(row.exerciseId)}>'), true);
  assert.equal(read('Today.jsx').includes('<a className="gym-movement-door" href={recordHref(newest.exerciseId)}>'), true);
  // And the ink is one rule in one place: a door that had to be styled per site would be styled
  // differently per site the first time one of them moved.
  assert.equal(read('gym.css').includes('.gym-movement-door {'), true);
  // The one place that rule is extended is the routine's row, where the door takes the row's full
  // height — and it must not become a flex box doing it: `text-overflow: ellipsis` needs a block's
  // own inline content, and a name hard-clipped mid-word reads as a complete name.
  assert.equal(/\.gym-entry \.gym-movement-door \{[^}]*display:/.test(read('gym.css')), false);
});

// ONE CLASS, ONE MEANING. `.gym-record-title` is the FINISH screen's gold heading over a session's
// personal record — the only loud thing on that page — and the record page took the same name for
// its own faint block heads. Equal specificity, so the later rule won everywhere and turned the
// gold heading grey inside its own gold box. Nothing that mounts a component can catch it: both
// pages render exactly the markup they meant to, and the collision is only in the stylesheet.
test('the record page’s block heads do not take the finish screen’s gold class', () => {
  const blocks = [...read('gym.css').matchAll(/\.gym-record-title \{([^}]*)\}/g)];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0][1].includes('color: var(--pr-ink);'), true);
  assert.equal(read('Finish.jsx').includes('className="gym-record-title"'), true);
  assert.equal(read('Record.jsx').includes('gym-record-title'), false);
});

// THE CHAT IS NEVER OFFERED MID-SESSION — §L (the Ask section), and ARCHITECTURE §12 cuts "any chat
// not attached to one finished workout". A session detail is reachable for the OPEN session too —
// the log lists it and the mirror is polling it — and a panel mounted there would be asking a model
// about a workout that is still changing: the answer is out of date before it is read, and every
// tool call behind it names a read of a session that has since moved. The gate is on the session
// being finished, which is the same condition the review door beside it is drawn under.
//
// A mounted-component test cannot see this: the panel renders its locked face for a signed-in
// non-subscriber either way, and the difference is whether it is in the tree at all.
test('the coach panel is mounted only on a session that is over', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('{isFinished(session) && <CoachPanel sessionId={id} />}'), true);
  assert.equal((source.match(/<CoachPanel/g) ?? []).length, 1);
});

// `ADDED TODAY` IS SAID ONCE, ON THE FIRST WORKING SET — and which set that is, is decided in the
// JSX and nowhere a pure module can be asked. A movement warmed up before it was worked spends the
// note on the warmup slot if the rule is "the first set": `setNoteOf` answers a non-working set
// with its own kind and nothing else, so the note is computed, discarded, and the movement never
// says it was added at all. Position in the group, not `index === 0`.
test('the “added today” note is offered to the first working set of a movement', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes("const opener = group.find((set) => set.kind === 'working');"), true);
  assert.equal(source.includes('setNoteOf(set, reading, set === opener)'), true);
  assert.equal(source.includes('index === 0'), false);
});

// THE COACH'S PAGE IS ANSWERED BEFORE THE ACCOUNT IS. The token in the URL is the whole credential,
// so a visitor with no account must not resolve through 'loading' into the sign-in pitch — and the
// branch must sit ABOVE the auth switch rather than inside it, which is a fact about where one line
// is in a file. Every hook still runs first: the early return is under them, never between them.
test('the shared workout is answered above the auth switch, and wears none of the app’s chrome', () => {
  const app = read('GymApp.jsx');
  const shared = app.indexOf('if (sharedToken) {');
  const authSwitch = app.indexOf("status === 'loading'");
  assert.ok(shared > 0, 'GymApp has no shared branch');
  assert.ok(shared < authSwitch, 'the shared branch resolves after the auth switch');
  // The hooks are above the return, so the branch cannot change how many run.
  assert.ok(app.indexOf('const sharedToken = sharedTokenOf(hash);') < shared);
  assert.ok(app.indexOf('useSignInDoorHost()') < shared);

  // No chrome, no tabs, no door: the branch renders one component inside the bare root. It ends
  // where the auth switch begins, which is the first line that is not this branch's.
  const branch = app.slice(shared, authSwitch);
  for (const chrome of ['<Chrome', '<TabBar', 'SignInPitch', 'AccountSeat', 'ProductSwitcher']) {
    assert.equal(branch.includes(chrome), false, chrome);
  }
  assert.equal(branch.includes('<SharedSession token={sharedToken} />'), true);
});

// ONE ACCOUNT SEAT ON A SCREEN, EVER — and which one it is depends on the frame, which is a fact
// about where a component is mounted and therefore invisible to a module test. Outside the shell,
// #/gym is the whole page: nothing above GymApp paints anything, so the room floats its own seat and
// switcher. Inside /app the shell has already drawn a seat (the rail's foot on a desk, the top bar's
// on a phone) and a rail that IS the switcher, so a room drawing its own would put a second seat on
// the screen beside the first.
//
// The rule is ONE guard at the top of ONE component rather than a condition at each of its call
// sites: a third caller of Chrome cannot forget it, and a second <AccountSeat> in this file would
// be a seat outside the guard. Both halves are pinned, because either one alone lets the bug back.
test('the account seat and the switcher are drawn in one place, and only outside the shell', () => {
  const app = read('GymApp.jsx');

  assert.equal(app.includes('function Chrome({ inShell, user, status, onSignIn, onSignOut }) {\n  if (inShell) return null;'), true);
  assert.equal((app.match(/<AccountSeat/g) ?? []).length, 1);
  assert.equal((app.match(/<ProductSwitcher/g) ?? []).length, 1);
  assert.ok(app.indexOf('if (inShell) return null;') < app.indexOf('<AccountSeat'));

  // Every mount of Chrome is handed the answer. A mount that forgot the prop would default to the
  // bare surface and draw the second seat — the exact failure the guard exists to stop.
  const mounts = app.split('<Chrome').slice(1);
  assert.equal(mounts.length, 2);
  for (const mount of mounts) assert.equal(mount.slice(0, 40).includes('inShell={inShell}'), true, mount.slice(0, 40));

  // The root says which frame it is in, so the stylesheet can drop the space the floating furniture
  // was being cleared from (gym.css) without naming the /app chrome, which products may not touch.
  assert.equal((app.match(/data-chrome=\{inShell \? 'shell' : 'own'\}/g) ?? []).length, 2);
  assert.equal(read('gym.css').includes(".gym-root[data-chrome='shell'] .gym-column {"), true);
});

// TAP TO FIX (§G17), true at last. W1b drew the row and deliberately did NOT draw the annotation,
// because the path did not exist; §G18 built it, so the affordance lands on the same rows. Which
// text carries a press is a fact about the JSX, and a pure module cannot be asked whether a set is
// a door — the row is a button or the sheet is unreachable and the design's own note is a lie.
test('every set in a session read whole is a door onto the fix, and says so', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('onClick={() => setFixing(set)}'), true);
  assert.equal(source.includes('<span className="gym-set-fix">tap to fix</span>'), true);
  // Not aria-hidden: it is the only text on the row that says what pressing it does.
  assert.equal(source.includes('className="gym-set-fix" aria-hidden'), false);
  // The label lands under the pointer, and on a device that has none it is simply always on —
  // both halves in the stylesheet, because neither is expressible in the markup.
  const css = read('gym.css');
  assert.equal(css.includes('button.gym-set:hover .gym-set-fix,'), true);
  assert.equal(/@media \(hover: none\) \{\s*\.gym-set-fix \{\s*opacity: 1;/.test(css), true);
});

// A DRAFT MAY NOT OUTLIVE THE DOCUMENT IT IS OF — the routine editor's rule, one room down. The
// session detail now holds corrections it has made and a delete withheld under a running timer,
// and a hash move to another workout with the instance kept would carry both across: the wrong
// session drawn with another's corrections folded in, and a DELETE fired at a set id that is not
// in the workout on screen.
test('the session detail is keyed on the session it reads, and is handed the one voice', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes('<SessionDetail key={sessionIdOf(hash)} id={sessionIdOf(hash)} log={log} />'), true);
});

// THE LADDER IS THE ONE THAT EXISTS. Lift had the same rule pasted into three targets and let them
// drift; the sheet calls `bump` and `ladderLabels` and states no step of its own, so at 47.5 kg the
// row reads −5 · −2.5 · +2.5 · +5 because the golden says so and not because this screen agrees.
test('the fix sheet steps a weight on the logger’s ladder and states no step size of its own', () => {
  assert.equal(read('fix.js').includes("import { bump, bumpReps, round } from './logger/ladder.js';"), true);
  assert.equal(read('FixSheet.jsx').includes("import { LADDER_KEYS, ladderLabels } from './logger/ladder.js';"), true);
  assert.equal(read('fix.js').includes('weightKg: bump(draft.weightKg, direction, big)'), true);
  // A step in this product is 1, 2.5, 5 or 10 kg, and the fractional ones are unmistakable: neither
  // file writes a number with a decimal point in it at all, so there is nothing here to drift.
  for (const file of ['fix.js', 'FixSheet.jsx']) {
    assert.equal(/\d\.\d/.test(speech(file)), false, `${file} states a weight of its own`);
  }
});

// NOTHING PROMISES RECOVERY. The G3 canon draws a delete whose toast offers "Trash — recoverable
// for 30 days in Settings > Trash"; §G18 is the newer decision and it draws no trash, so no copy on
// this path may imply one. What is deleted leaves the live table — the store keeps what it took
// where nothing reads it, and a screen that said so would be offering a door that does not exist.
//
// The scan is over the SPEECH and not the source, because a comment must stay free to name the
// promise it is refusing to make. What is banned is the promise reaching a lifter.
test('no surface of the fix promises a set back', () => {
  for (const file of ['fix.js', 'FixSheet.jsx', 'Log.jsx', 'gymApi.js', 'gym.css']) {
    const source = speech(file).toLowerCase();
    for (const promise of ['30 days', 'thirty days', 'recoverable', 'restore', 'undelete', 'trash']) {
      assert.equal(source.includes(promise), false, `${file} promises "${promise}"`);
    }
  }
});

// THE TAKE-BACK IS A WITHHELD WRITE, not an undo of one that happened. The DELETE goes over the
// wire only when the window closes, so Undo is exact — and it has to be this shape: a re-posted set
// is a NEW row minted at max+1, which would come back at the bottom of its movement instead of
// where the lifter left it, and a store that answered the re-post late could hold both.
test('a deleted set is withheld for the window, never sent and re-posted', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('setTimeout(() => sendDelete(set.id), UNDO_MS)'), true);
  // The one call that could resurrect a set. It is not on this screen and must never be.
  assert.equal(source.includes('appendSet'), false);
  // And leaving the room sends what is still held rather than dropping it on the floor.
  assert.equal(source.includes('useEffect(() => () => { withheld.current.forEach((held) => sendDelete(held.set.id)); }, [sendDelete]);'), true);
});

// A RE-READ IS THE NEWER ANSWER AND THIS SCREEN MAY NOT PAINT OVER IT. The session is read again for
// exactly one reason — the log moved underneath — and the corrections in hand are the older answer
// to the very question that moved: another device's write lands, and the row this screen still holds
// an entry for is drawn from that entry instead. The rule itself is pure and pinned in fix.test.js;
// what can only be read here is that BOTH doors into the read go through it, rather than one of them
// calling `retry` raw and quietly keeping the moves.
test('every re-read of the session lets go of the corrections this screen was holding', () => {
  const source = read('Log.jsx');
  assert.equal(source.includes('const reread = () => {\n    setMoves(movesAfterRead);\n    view.retry();\n  };'), true);
  assert.equal(source.includes('if (error.setNotFound) reread();'), true);
  assert.equal(source.includes('className="gym-retry" onClick={reread}'), true);
  // One call to the read itself, and it is inside that function.
  assert.equal((source.match(/view\.retry/g) ?? []).length, 1);
});

// THE OFFER AND THE WINDOW IT IS TRUE IN ARE THE SAME FIVE SECONDS. The toast is where Undo lives,
// so a window longer than the toast is a take-back nobody can see and a toast longer than the
// window is a button that has quietly stopped working. Neither module can read the other's constant
// — fix.js is pure and useTrainingLog.js is a hook — so the equality is pinned here.
test('the undo window is exactly as long as the toast that offers it', () => {
  const undo = /export const UNDO_MS = (\d+);/.exec(read('fix.js'));
  const toast = /const TOAST_MS = (\d+);/.exec(read('useTrainingLog.js'));
  assert.equal(undo?.[1], '5000');
  assert.equal(toast?.[1], undo?.[1]);
});

// A CLOCK CLEARS THE TOAST IT WAS SET FOR AND NEVER WHATEVER IS THERE WHEN IT FIRES. The two
// constants above are the same five seconds by design, so the delete that closes a window speaks in
// the same instant the toast holding its Undo runs out: React lands both updates in one batch, the
// older clock last, and an unconditional clear takes the sentence with it — the row comes back and
// nothing on the screen says why. Offline is exactly that shape, and it was caught in a browser
// driving this screen rather than by reading it.
//
// The test runner cannot drive it: no DOM here, and the hook harness renders synchronously, which
// cancels the old clock before it can fire (useTrainingLog.test.js says so where it stops). So what
// is pinned is the shape that is correct in every order the two updates can arrive in — the clear
// names the toast it belongs to.
test('the toast’s own clock clears only that toast, never the one said after it', () => {
  const source = read('useTrainingLog.js');
  assert.equal(
    source.includes('setTimeout(() => setToast((current) => (current === toast ? null : current)), TOAST_MS)'),
    true,
  );
  // The unconditional clear is a deliberate move and belongs to the reader dismissing one, not to a
  // timer: a press on × means "I have read this", and there is nothing newer for it to swallow.
  assert.equal((source.match(/setToast\(null\)/g) ?? []).length, 1);
  assert.equal(source.includes('dismissToast: () => setToast(null)'), true);
});

// A FINISHED SESSION IS CORRECTABLE, and the client must not invent a refusal the store does not
// make: a lifter reads the log after the workout, which is exactly when they see the typo. There is
// no `session-finished` and no 409 on either route, so no branch on this path may test for one.
test('nothing on the fix path refuses a set because its workout is over', () => {
  for (const file of ['fix.js', 'FixSheet.jsx']) {
    const source = read(file);
    assert.equal(source.includes('sessionFinished'), false, file);
    assert.equal(source.includes('isFinished'), false, file);
  }
  // The sheet is mounted on any set of the session, not on a condition about the session — unlike
  // the coach panel three lines above it, which is gated on the workout being over.
  assert.equal(read('Log.jsx').includes('{fixing && (\n        <FixSheet'), true);
});
