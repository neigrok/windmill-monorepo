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
  // The fifth site, and the one where the door earns its place twice: "should I take heavier
  // triples" is a question about where that lift stands, and this is the screen the question is
  // asked on. Nothing is held here, so leaving costs a re-read and nothing else.
  assert.equal(read('Proposals.jsx').includes('<a className="gym-diff-name gym-movement-door" href={recordHref(row.exerciseId)}>'), true);
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

// A TOGGLE THAT MOVES AND DOES NOTHING IS A LIE ON A SETTINGS SCREEN. The two confirmation flags
// record an INTENT that each surface honours as far as it can, and nothing here confirms a set at
// all — so the row says which surface honours it rather than leaving a lifter to discover that the
// switch they moved changed nothing where they moved it. The sentence is in the SPEECH and not in a
// comment, because a comment is not on the screen.
//
// AND THE REASON IT GIVES HAS TO BE THE TRUE ONE. It said "this browser has no Vibration API" —
// the design's own caption, and false: Chrome exposes `navigator.vibrate` on the desktop and honours
// it on Android, which is where this PWA installs. The true limit is that no set is LOGGED at this
// desk (§11), so there is nothing for either switch to answer. A false reason on a settings row is
// believed by the next person deciding whether the desk could buzz after all, which is why the
// browser sentence is banned here rather than only replaced.
test('the set-confirmation row names the true reason nothing here confirms a set', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  assert.equal(said.includes('No set is logged at this desk'), true);
  assert.equal(said.includes('it does not act here'), true);
  assert.equal(said.includes('Vibration API'), false);
  // And the switch is still drawn, because the intent it records is honoured on the phones: the
  // honest answer was to name the limit, not to withhold the setting from the surface it is set on.
  assert.equal(said.includes('label="Haptic"'), true);
});

// THE REST ROW SAYS WHERE THE CLOCK RUNS IN EVERY STATE IT HAS, and OFF is the state a lifter who
// has never opened this screen sees: the sentence naming the phone lived in the other branch, so the
// first-open screen drew a writable "Sound when it ends" with nothing on it saying where — or
// whether — that sound happens.
test('the rest row names the phone as the clock even with the timer off', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  assert.equal(said.includes('your phone runs the clock between sets and sounds it'), true);
  // Off is still the default and still says so, and the two sentences are one paragraph rather than
  // two branches — which is what makes the claim unconditional.
  assert.equal(said.includes('Off, and off is the default'), true);
  assert.equal(/restSeconds == null\s*\n?\s*&&/.test(said), true);
});

// NO ALARM ANY SURFACE WOULD NOT KEEP (W4 §5). Nothing in this wave fires on a clock, and a browser
// tab cannot promise a sound that survives a locked screen — so the rest row names the target and
// says where the clock actually runs. The scan is for the APIs, because copy can be reworded and a
// `new Audio` cannot.
//
// IT SCANS THE SPEECH AND NOT THE WHOLE FILE, which is the same rule every other scan here follows:
// a comment has to stay free to NAME the promise it is refusing to make, and the row above refuses
// `navigator.vibrate` by name. Stripping comments costs the scan nothing — a call survives the
// strip; only prose about it does not.
test('the settings section promises no alarm this surface cannot keep', () => {
  const said = speech('settings/GymSettingsSection.jsx');
  for (const promise of ['navigator.vibrate', 'new Audio', 'new Notification', 'requestPermission', 'setInterval']) {
    assert.equal(said.includes(promise), false, promise);
  }
  assert.equal(speech('settings/GymSettingsSection.jsx').includes('never sounds an alarm of its own'), true);
});

// ONE EXPORT DOOR. It moved INTO the five rows rather than being rebuilt beside them, and the row
// still carries the reason it was gated in the first place: an account that has only ever grown
// skill trees is not offered a file of a training log it never kept.
test('the export is one row of the section, and only for an account with a log', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('{hasLog && ('), true);
  assert.equal(source.includes('href={EXPORT_HREF}'), true);
  assert.equal((source.match(/EXPORT_HREF/g) ?? []).length, 2);
});

// THE GRANT IS NAMED HERE AND OWNED ELSEWHERE. The row says which tools reach the training log and
// walks to the workbench; a revoke drawn here would be a second door onto one decision, which is the
// same rule that keeps the account's close in the shell alone.
test('the connected-log row names the grant state without rebuilding it', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('listGrants'), true);
  assert.equal(source.includes('revokeGrant'), false);
  assert.equal(source.includes("href=\"#/connect\""), true);
});

// THE PICKER'S META IS ASKED FOR ONCE, WHEN THE PICKER OPENS (§B7). The read is per-picker rather
// than per-host — three rooms mount this component and one of them would otherwise forget it — and
// its deps are empty on purpose: typing filters the list already in hand, so a dep on the query
// would fire a request per keystroke to redraw rows that never left the screen. Which array a hook
// is called with is a fact about the source and nothing a pure module can be asked.
test('the picker reads every movement’s last set when it opens, and never on a keystroke', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('const last = useGymRead(() => gymApi.lastSets(), []);'), true);
  assert.equal((picker.match(/useGymRead\(/g) ?? []).length, 1);
  assert.equal(/useGymRead\([^;]*\[[^\]]*query/.test(picker), false);
  // And the three hosts stay out of it: none of them reads this, so none of them can drift.
  for (const host of ['Routines.jsx', 'Backfill.jsx', 'Record.jsx']) {
    assert.equal(read(host).includes('lastSets'), false, host);
  }
});

// THE ABSENCE SENTENCE IS DRAWN FROM AN ABSENCE AND FROM NOTHING ELSE. The wire is sparse — no
// sentinel, no null row, no zero — so a movement missing from the reply is the whole of the fact.
// The danger is the OTHER absence: a read still in the air holds no entries either, and a row that
// spelled the sentence off that would say it about every movement in the catalog while the answer
// was in flight. So the meta is drawn only once the read is ready, and the sentence itself lives in
// the pure module rather than in this file, where a second copy could disagree with it.
//
// AND THE WORD `never` STAYS OFF THIS ROW. The read excludes the open workout and warmups, so a
// missing movement is one with no LAST TIME and not one nobody has trained — the mirror on Today
// can be drawing that movement's sets in the next tab over. A picker that reached for canon's
// `never logged` here would be this surface contradicting itself about a lifter's history.
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

// SCREEN 1, MINUS THE HALF THIS SURFACE MAY NOT DRAW. Its primary is `Start a session`, and a
// session cannot start at the desk (§11) — so what the web draws of that screen is its SECOND verb,
// and the verb has to land somewhere true: paste-to-routine does not exist in gym, and the routine
// editor does. A button onto a screen that is not built would be the room promising a parser it has
// not got.
test('the empty log offers the routine editor, and this surface still starts nothing', () => {
  const today = read('Today.jsx');
  assert.equal(today.includes('{log.summaries.length === 0 && <FirstRun />}'), true);
  assert.equal(
    today.includes('<a className="gym-first-write" href={routineHref(NEW_ROUTINE_ID)}>Type out a routine first</a>'),
    true,
  );
  // AND THE REASON IS ON THE SCREEN, not in the margin explaining the screen. Canon draws it in the
  // frame between the line and the verbs, and it is the only thing an empty room says for itself:
  // without it the absent setup wizard reads as a feature that has not landed. Drawn in the second
  // person, because the design writes it about the lifter rather than to them.
  const why = speech('Today.jsx');
  assert.equal(why.includes('No tour, no sample program, no questions about your goals'), true);
  assert.equal(why.includes('this app is here to catch it, not to write it'), true);
  // The one verb the web has never had since §11, said nowhere on it — in a comment, freely; on a
  // screen, never.
  for (const file of ['Today.jsx', 'Routines.jsx', 'Log.jsx', 'Finish.jsx', 'GymApp.jsx']) {
    assert.equal(speech(file).includes('Start a session'), false, file);
  }
});

// ── Proposals: the agent proposes, and the tap is the only thing that applies ────────────────────

// A walk of every gym source file, used by the two scans below. The marketing tree is excluded the
// same way the decline scan excludes it: it is copy about the product rather than the product.
const gymFiles = () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'marketing' ? [] : walk(at);
    return [at];
  });
  return walk(GYM);
};

// THE ONE PLACE A ROUTINE AN AGENT WROTE TO CAN MOVE, and it is a human's tap on a diff they are
// looking at. Nothing this wave built may grow a second door onto it: not the card, which is a
// notification; not the routines list; and above all not the routine editor, which holds a DRAFT —
// a routine applied under an open draft would be a change the lifter never saw, whole-document PUT
// straight back out by the Done they press next.
//
// Which file calls what is a fact about the source and about nothing a pure module can answer, which
// is why it is pinned here rather than in proposals.test.js.
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
  // Both calls are inside the one function a tap reaches, and it is the only caller of either.
  assert.equal((source.match(/gymApi\.applyProposal/g) ?? []).length, 1);
  assert.equal((source.match(/gymApi\.dismissProposal/g) ?? []).length, 1);
});

// A SETTLEMENT MAY NOT OUTLIVE THE DOCUMENT IT IS OF — the routine editor's rule and the session
// detail's, one room further along. The diff holds the settled proposal the store answered with, and
// a hash move to another proposal with the instance kept would draw one document under another's
// Apply button.
test('the proposal diff is keyed on the proposal it reads', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes('<ProposalDiff key={proposalIdOf(hash)} id={proposalIdOf(hash)} log={log} />'), true);
});

// NO AUTO-APPLY, NOT EVEN HIDDEN (W6 §5). A conditionally false safety claim is the worst artifact
// this house can produce, and the shape that would let one in is an effect: a render that could
// settle a proposal is a proposal settled without a tap. There is no effect in this file at all —
// the read is the shared hook's and every write is under an onClick — so the scan is for the API
// rather than for a policy, because copy can be reworded and a `useEffect` cannot.
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

// THE CARD IS THE NOTIFICATION, and it is in both places canon puts it: on Today, and on the
// routine it touches. Neither draws a verb that changes anything — the card's one button is a LINK
// onto the diff — because the decision is made where the diff is readable and nowhere else.
test('a pending proposal waits on Today and on the routine it touches, as a door', () => {
  assert.equal(read('Today.jsx').includes('<PendingProposals />'), true);
  assert.equal(read('Routines.jsx').includes('{routine.pendingProposal && <ProposalFlag />}'), true);
  const source = read('Proposals.jsx');
  assert.equal(source.includes('<a className="gym-proposal-review" href={proposalHref(head.id)}>{reviewLabel(head)}</a>'), true);
  // The routine editor grows the History section (screen 6) and every row of it is a door too — a
  // routine being written for the first time has no history and is not asked for one.
  assert.equal(read('Routines.jsx').includes('{!fresh && <RoutineHistory routineId={draft.id} />}'), true);
  assert.equal(source.includes('<a className="gym-history-row" href={proposalHref(head.id)}>'), true);
});

// THE SENTENCE THIS WHOLE WAVE EXISTS TO MAKE TRUE has to reach a lifter, on the screen where the
// decision is taken, in the SPEECH rather than in a comment about the speech. It is one line under
// two buttons and it says both halves: apply is atomic, and nothing has happened yet.
test('the diff says out loud that it is all-or-none and that nothing has happened yet', () => {
  const said = speech('proposals.js');
  assert.equal(said.includes('Nothing is applied until you tap.'), true);
  assert.equal(said.includes('or none.'), true);
  assert.equal(speech('Proposals.jsx').includes('{atomicLine(proposal)}'), true);
  // And a settled one stays, with its timestamp, as a dated record — never a toast.
  assert.equal(said.includes('the program’s history, not a toast that disappears'), true);
  assert.equal(speech('Proposals.jsx').includes('{settledLine(proposal)}'), true);
});

// THE DIFF DRAWS THE WHOLE RUN, and this is the JSX half of that rule — `diffRows` yielding a `kept`
// row is worth nothing if the renderer has no branch for it, and no test in this runner can mount
// the screen to find out. The rule itself: a proposal that reorders a routine carries the move only
// in the POSITION of an unmarked row, so a screen drawing the marked rows alone showed a lifter one
// weight change over a Monday whose order had been rewritten under it.
test('the diff draws every line the routine would run, not only the ones that changed', () => {
  const source = speech('Proposals.jsx');
  assert.equal(source.includes("if (row.kind === 'kept') {"), true);
  assert.equal(source.includes('{documentNote && <p className="gym-diff-caption">{documentNote}</p>}'), true);
  // Nothing filters the rows on the way to the list — the whole document, in the order it holds.
  assert.equal(source.includes('{rows.map((row, index) => ('), true);
  assert.equal(/rows\.filter|rows\.slice/.test(source), false);
  // And an unmarked row is drawn as one: the flat rule is in the stylesheet, not in an inline style.
  assert.equal(read('gym.css').includes('.gym-diff-row.is-kept {'), true);
});

// NO SURFACE MAY SAY A CONNECTION REWRITES A ROUTINE OF YOURS, because none of them does any more.
// These sentences were true this morning and were the loudest false copy in the repo the moment the
// ledger landed; they are banned by their own words rather than only replaced, so a revert of the
// copy fails a test instead of quietly shipping. The scan is over the whole file for the landing —
// its retired claim lived in a COMMENT, which is exactly where a false sentence hides longest.
//
// AND THE REPLACEMENT MAY NOT OVERSHOOT EITHER, which is the ban that reads oddly until you check
// the catalog: "it never writes to your program" was the sentence this wave shipped in that slot,
// and it is FALSE. `create_routine` is `gym:write` and lands immediately, by decision — a day that
// did not exist takes nothing away — so a whole day can appear in the program with no tap. The line
// on the page names the write it makes as well as the ones it does not, because a safety promise
// that is nearly true is worth less than none: it is believed.
test('no gym copy claims an agent changes a routine of yours directly, or that it writes nothing', () => {
  const landing = read('marketing/GymLanding.jsx');
  for (const claim of [
    'writes directly',
    'exactly as it would if you had typed it yourself',
    'Write next week’s routine',
    'Add sets, movements and routines',
    'Delete workouts and routines',
    'never writes to your program',
  ]) {
    assert.equal(landing.includes(claim), false, claim);
  }
  // And what stands in their place is the rule itself, on the page rather than in the margin — both
  // halves of it, the direct write included.
  const said = speech('marketing/GymLanding.jsx');
  assert.equal(said.includes('it never rewrites a day you already have'), true);
  assert.equal(said.includes('adds lands right away: it takes nothing away'), true);
  assert.equal(said.includes('Propose next week’s routine — you read the diff and tap Apply.'), true);
  assert.equal(said.includes('Record what happened · add a new day · propose changes to the days you have'), true);
  assert.equal(said.includes('Discard a workout · end a coach link · propose a removal'), true);
  // The three `gym:delete` tools are discard_session, propose_routine_removal AND revoke_share, so
  // the caption under them names three effects rather than two.
  assert.equal(said.includes('end a coach link, or ask to remove a routine.'), true);

  // The MCP workbench's own page says the same thing in its own voice, and no longer says an agent
  // "keeps" a routine of yours.
  const connect = fs.readFileSync(path.join(GYM, '../../../public/connect.html'), 'utf8');
  assert.equal(connect.includes('keep your routines'), false);
  assert.equal(connect.includes('What it cannot do is change a routine you already have'), true);
  assert.equal(connect.includes('nothing moves until you tap Apply'), true);
});

// NOTHING COUNTS HOW MANY TIMES ANYONE DECLINED ANYTHING — §J's own words, and the finish screen is
// where the temptation lives: "Keep this as a routine" is offered after every session, and a tally
// behind it would be the first step toward asking harder the third time. Declining costs nothing,
// the offer comes back next session, and the decline leaves no trace on this device or on the wire.
// The scan is over identifiers rather than prose, because a comment must stay free to say what it
// is refusing to build.
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
  // And the one decline this product does draw stays where it was: local to the screen offering it,
  // forgotten the moment the screen closes.
  assert.equal(read('Finish.jsx').includes('const [offered, setOffered] = useState(true);'), true);
  assert.equal(read('Finish.jsx').includes('onClick={() => setOffered(false)}'), true);
});
