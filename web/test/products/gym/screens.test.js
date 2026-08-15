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
const spoken = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const speech = (file) => spoken(read(file));

// A DRAFT MAY NOT OUTLIVE THE DOCUMENT IT IS OF. The editor holds one routine under the lifter's
// hand and nothing reaches the store until Save, so the instance is scoped to the routine id: the
// key is what makes React drop it when the hash moves to another routine. Without it, the editor's
// own Duplicate button — which moves the hash to the copy — left the ORIGINAL's unsaved draft on
// screen under the copy's URL, and Save then whole-document PUT it back onto the original. A
// routine renamed and reprogrammed into another one, with no undo.
test('the routine editor is keyed on the routine it edits, so a hash move remounts it', () => {
  const app = read('GymApp.jsx');
  // The seam, not an effect copying the prop into state: a draft synced out of props still has a
  // frame where the screen holds one routine's edits under another routine's URL.
  assert.equal(app.includes('<RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />'), true);
});

// DUPLICATE COPIES THE STORED ROUTINE, NOT THE DRAFT. The hash moves to the copy the moment it
// lands, so a copy of unsaved edits carried them off this editor and left the original without
// them — and on a routine never saved it minted "X copy" of a document the store did not hold. The
// copy is of the read, and a fresh routine offers no button.
test('the editor’s Duplicate copies the routine as stored, and a fresh routine offers none', () => {
  const source = spoken(read('Routines.jsx'));
  assert.equal(source.includes("duplicateRoutine(view.data, { id: mintId('rt_') })"), true);
  assert.equal(source.includes("duplicateRoutine(draft,"), false);
  const foot = source.indexOf('className="gym-editor-duplicate"');
  assert.notEqual(foot, -1);
  assert.equal(source.lastIndexOf('{!fresh && (', foot) > source.lastIndexOf('<RoutineHistory', foot), true);
});

// THE FLAG ON A ROUTINE ROW IS A WORD, NOT A COUNT. The routines read carries one pending head — the
// newest — over what may be several (one pending per routine, door and connection), so a number on
// the row is a number the wire never sent.
test('the routine row’s proposal flag counts nothing', () => {
  const source = spoken(read('Proposals.jsx'));
  const flag = source.slice(source.indexOf('export function ProposalFlag'), source.indexOf('export function ProposalDiff'));
  assert.equal(flag.includes('proposal pending'), true);
  assert.equal(/\d proposal/.test(flag), false);
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

// ASK IS A ROOM AND THERE IS ONLY ONE OF IT (§L). It replaced the composer that used to sit under
// one finished workout rather than landing beside it: two chat-shaped things is the two-systems
// failure arriving early, and the panel's whole virtue was that it was not a second system. So the
// session screens carry no chat at all now, and the room is mounted in exactly one place — the
// frame, off one hash. A second `<AskRoom` anywhere would be the panel growing back.
test('the chat is one room in the frame, and no session screen carries one', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'ask' && <AskRoom log={log} />}"), true);
  for (const file of gymFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const mine = path.basename(file) === 'GymApp.jsx';
    assert.equal(source.includes('<AskRoom') && !mine, false, file);
    // And the thing it replaced is gone, name and all — not kept beside it for a wave.
    assert.equal(source.includes('CoachPanel'), false, file);
  }
  for (const screen of ['Log.jsx', 'Finish.jsx']) {
    assert.equal(read(screen).includes('askCoach'), false, screen);
  }
});

// AND IT IS NOT A FOURTH TAB — canon says so in as many words: the bar is the app's three rooms, and
// a chat is not a place you live. The tab bar is drawn over TAB_SCREENS and 'ask' is deliberately
// not one of them, which is also what keeps a fixed rail off the composer at the bottom of it.
test('Ask is a room the tab bar does not draw a column for', () => {
  const app = read('GymApp.jsx');
  const rooms = /const TAB_SCREENS = \[([^\]]*)\];/.exec(app);
  assert.equal(rooms?.[1], "'today', 'log', 'routines'");
  // Which is also the count the grid has columns for — the rule three tests above, from the other
  // side: a fourth column would be the room becoming a place you live.
  assert.equal(/\.gym-tabs \{[^}]*grid-template-columns: repeat\(3, 1fr\)/.test(read('gym.css')), true);
});

// NEVER OFFERED MID-SESSION (§L), and the door is where that rule is kept on this surface: an answer
// about a workout that is still moving is out of date before it is read. Both doors ask the same
// component the same question rather than each writing the condition out — a second copy of a gate
// is the one that gets forgotten — and the server is the floor under both (409 ask-session-open).
//
// A mounted-component test cannot see this: the difference is whether the door is in the tree at
// all, and both hosts render perfectly well without it.
test('the Ask door is drawn from Today and from a proposal, and never while a workout is running', () => {
  assert.equal(read('Today.jsx').includes('<AskDoor training={log.session != null} />'), true);
  assert.equal(read('Proposals.jsx').includes('{!log.session && <a className="gym-ask-aside" href={ASK_HREF}>'), true);
  // The guard is a top-of-component early return, so a third caller cannot forget it.
  assert.equal(read('ask/AskRoom.jsx').includes('function AskDoor({ training }) {\n  if (training) return null;'), true);
  // And the room itself says it before anything is typed rather than letting the send fail.
  assert.equal(read('ask/AskRoom.jsx').includes('if (log.session) {'), true);
});

// THE RECEIPT IS THE SERVER'S OR IT IS A LAUNDERED HALLUCINATION. `read` is counted over the rows
// the server actually served this connection, deduped by id, and printed as it arrives — a count
// this surface summed would be an audit the model could have written itself. So no arithmetic
// touches it anywhere: `readLine` reads three fields and the room passes `reply.read` through whole.
test('nothing on this surface computes the number an answer is checked against', () => {
  // The reply's own object, passed through whole by the one function allowed to make a turn out of
  // a reply. Nothing composes a `read` here and nothing carries one forward from a previous turn:
  // each answer is checked against what THAT exchange read.
  assert.equal(speech('ask/ask.js').includes('read: reply.read,'), true);
  for (const file of ['ask/ask.js', 'ask/AskRoom.jsx']) {
    assert.equal(/read:\s*\{/.test(read(file)), false, file);
  }
  // And the line that prints it does no arithmetic at all — it reads three fields and decides one
  // plural. A sum, a running total or a fold here would be the audit writing itself.
  const rules = speech('ask/ask.js');
  for (const arithmetic of ['reduce(', '+=', 'Math.', 'sum']) {
    assert.equal(rules.includes(arithmetic), false, arithmetic);
  }
});

// AND AN ANSWER WITH NO RECEIPT IS NOT DRAWN AT ALL. §L's rule is that EVERY answer states what it
// read, so the receipt cannot be a thing the room prints when the server remembered to send one:
// `answerTurn` is the only door onto a turn, and a body it refuses is said as the model not having
// answered. Both phones fail closed on the same body, so a web room that drew it would be the one
// door where unverifiable model prose reaches a lifter.
//
// The wiring is the fact under test — that the room builds no answer turn of its own — and no pure
// module can be asked where a component put an object literal.
test('the room makes no answer of its own, so prose with no receipt never reaches the screen', () => {
  const room = read('ask/AskRoom.jsx');
  assert.equal(room.includes('const answer = answerTurn(reply);'), true);
  assert.equal(room.includes('if (answer) setTurns((held) => [...held, answer]);'), true);
  assert.equal(room.includes('else setNote(NO_ANSWER_NOTE);'), true);
  // The turn's own shape is minted in exactly one place, and it is not this file.
  assert.equal(room.includes("from: 'ask',"), false);
  assert.equal(speech('ask/ask.js').includes("from: 'ask',"), true);
  // Which is also why the receipt is drawn unconditionally: there is no turn without one, so a
  // guard here would be a branch for a state that cannot exist — and a reader would take it for
  // proof that one can.
  assert.equal(room.includes('<p className="gym-ask-read">{readLine(turn.read)}</p>'), true);
});

// NOTHING A LIFTER READS SAYS COACH. The brief that owns gym's vocabulary bans it — there is no
// coach, there is your agent — and the word was on screen until this wave. The COACH SHARE is a
// different object and keeps the word honestly: it is a link you send to a person who coaches you,
// and that person is what it names.
//
// The scan is over the SPEECH, because a comment has to stay free to name the thing it replaced.
test('the word coach is off every gym surface but the share, which is about a person', () => {
  for (const file of gymFiles()) {
    if (path.dirname(file).endsWith('/share')) continue;
    // `CoachShare` is the share COMPONENT's name where two screens mount it — an identifier and not
    // a sentence, and the object it names keeps the word honestly. It is exempted by name so that a
    // sentence sneaking the word back in still fails.
    const said = spoken(fs.readFileSync(file, 'utf8')).replaceAll('CoachShare', '').toLowerCase();
    assert.equal(said.includes('coach'), false, file);
  }
  // And the share still says it, because that sentence is about a human being.
  assert.equal(read('share/share.js').includes('Share with a coach'), true);
});

// NO UPGRADE, NO PRICE, NO LOCKED FACE (W7 §4). Ask ships open to everyone with a plainly-worded
// cap, because Windmill One cannot be bought — `paidPlansOpen()` is a hardcoded false and BillingApi
// 503s — so a locked chat offering a purchase would advertise a checkout that returns 503, which is
// a dark pattern by accident and exactly the trade this brand's mission forecloses. The gate arms in
// the wave that opens checkout and not before, and it is one predicate on the server.
//
// The scan is for the APIs as well as the words: copy can be reworded, an import cannot.
test('Ask offers nothing to buy, and reads no entitlement to decide whether to answer', () => {
  for (const file of ['ask/ask.js', 'ask/AskRoom.jsx']) {
    // The SPEECH, so that a comment stays free to name the door it is refusing to open — an import
    // survives the strip and a sentence about one does not.
    const said = speech(file);
    for (const door of ['useEntitlements', 'paidPlansOpen', 'beginUpgrade', 'windmillOne', 'checkout']) {
      assert.equal(said.includes(door), false, `${file} reaches for ${door}`);
    }
    // A price is a currency mark with a number after it — `${` is a template, not a fee.
    assert.equal(/[Uu]pgrade|Windmill One|[Ss]ubscri|\$\d|£\d|€\d/.test(said), false, file);
  }
  // The two caps say what they are — pace, and a rolling 30-day ceiling — and neither points at a
  // purchase, because there is no door behind one to point at.
  const rules = speech('ask/ask.js');
  assert.equal(rules.includes('about ten questions a day, three back to back'), true);
  assert.equal(rules.includes('AI ceiling for the last 30 days'), true);
});

// AND THE PAGE THAT PRICES THE PRODUCT SAYS THE SAME THING. The landing is the one gym file the
// blanket coach scan above skips — it may say the word, because the coach SHARE is a link you send
// to a person — and that exemption is exactly where the deleted panel survived: "The coach panel is
// part of Windmill One, which isn't on sale yet" priced a feature this wave deleted, and the
// paragraph under it described a read-only composer bolted under one finished workout. Both went
// false the moment CoachPanel.jsx did, and a false line about MONEY is the worst one on any page.
test('the landing sells no panel, no plan behind Ask, and names the cap Ask really has', () => {
  const said = speech('marketing/GymLanding.jsx');
  for (const gone of ['coach panel', 'A panel under any finished workout', 'Windmill One', 'It only reads']) {
    assert.equal(said.includes(gone), false, gone);
  }
  // What stands in their place is the room that does exist, priced the way it is actually priced:
  // open to everyone, with the server's own pace cap said in words (backend AskService.h,
  // kAskPerDay = 10) rather than a plan nobody can buy.
  assert.equal(said.includes('about ten questions a day'), true);
  assert.equal(said.includes('nothing in Gym is on sale'), true);
  // ASK PROPOSES AS WELL AS READS — its grant is the seven reads plus the two tools that mint a
  // proposal — so the page may not sell it as read-only, and it names the receipt an answer carries.
  assert.equal(said.includes('your whole log and it proposes'), true);
  assert.equal(said.includes('how many of your rows they served'), true);
  assert.equal(said.includes('log a set, correct one you lifted, or delete anything'), true);
  // And the word that is left on this page is only ever the link sent to a human being.
  assert.equal(said.replaceAll('coach link', '').includes('coach'), false);
});

// THE EMPTY STATE POINTS AT THE FREE DOOR (W7 §5). An in-app chat that tells you how to stop paying
// us costs one paragraph and is the strongest available proof the MCP thesis is real — shipping Ask
// without that line is the retreat. It is on the SCREEN, in the speech, with a door under it.
test('an empty Ask says the free door is better, and walks to it', () => {
  const said = speech('ask/ask.js');
  assert.equal(said.includes('If you already use Claude or ChatGPT, connect them instead'), true);
  assert.equal(said.includes('it knows the rest of your life'), true);
  const room = read('ask/AskRoom.jsx');
  assert.equal(room.includes('{turns.length === 0 && <FreeDoor />}'), true);
  // W8 MOVED WHERE IT LANDS, and not what it says. It used to open the account's /connect workbench,
  // which hands out a URL and per-client steps for planting skill trees; what somebody standing in
  // Ask is asking is what the OTHER door actually gets them, and that is gym's own room (§D12/13),
  // which answers it and walks on to the workbench.
  assert.equal(room.includes('<a className="gym-ask-free-door" href={CONNECT_HREF}>{FREE_DOOR_VERB}</a>'), true);
});

// ── Ask has a past (§O) ────────────────────────────────────────────────────────────────────────

// THE LIST IS A ROOM UNDER ASK AND NOT A TAB EITHER. Both screens hang off the frame's one hash
// switch, exactly as the room they are the past of does, and the detail is KEYED on the
// conversation: it holds an armed delete, and an armed delete may not cross from one conversation to
// another when the hash moves. That is a fact about which instance React keeps and nothing a pure
// module can be asked.
test('the threads list and one conversation are rooms in the frame, and the detail is keyed', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'threads' && <ThreadsList />}"), true);
  assert.equal(app.includes("{screen === 'thread' && <ThreadDetail key={threadIdOf(hash)} id={threadIdOf(hash)} />}"), true);
  // Still three tabs: the past of a chat is even less a place you live than the chat is.
  const rooms = /const TAB_SCREENS = \[([^\]]*)\];/.exec(app);
  assert.equal(rooms?.[1], "'today', 'log', 'routines'");
});

// THE TITLE IS THE LIFTER'S FIRST MESSAGE, VERBATIM (§O), which on this surface means the row draws
// the wire's own string and nothing else: no slice, no ellipsis, no case change, no titling helper.
// A pure module cannot be asked whether a component improved somebody's sentence on its way to the
// screen, so the JSX is where this is pinned.
test('a thread row draws the question as it was asked, and nothing edits it', () => {
  const threads = read('ask/Threads.jsx');
  assert.equal(threads.includes('<span className="gym-thread-title">{thread.title}</span>'), true);
  assert.equal(threads.includes('<h1 className="gym-thread-name">{thread.title}</h1>'), true);
  // The scan is over the SPEECH, so a comment stays free to name the thing it is refusing to do.
  const said = speech('ask/Threads.jsx');
  for (const edit of ['.slice(', '.substring(', '.toUpperCase(', '.trim()', 'summar', '…\'']) {
    assert.equal(said.includes(edit), false, edit);
  }
});

// NOT AN INBOX (§O), and this screen is the most natural place in the whole product to grow one. The
// scan is over both files that make it — the list and the door onto it — because a count on the
// door is the same failure as a badge on a row.
test('nothing about the threads screens is an unread count, a badge or a notification', () => {
  for (const file of ['ask/Threads.jsx', 'ask/AskRoom.jsx', 'ask/threads.js']) {
    const said = speech(file).toLowerCase();
    for (const inbox of ['unread', 'badge', 'notif', 'is-new']) {
      assert.equal(said.includes(inbox), false, `${file} — ${inbox}`);
    }
  }
  // And no mark on a row: the dot in this product means "something is waiting" (Proposals.jsx), and
  // nothing on this list ever is.
  assert.equal(speech('ask/Threads.jsx').includes('Dot'), false);
  // The door onto the past carries the word and nothing else — no count is passed to it at all.
  assert.equal(read('ask/AskRoom.jsx').includes('<a className="gym-ask-threads-door" href={THREADS_HREF}>{THREADS_TITLE} ›</a>'), true);
});

// THE ROOM SENDS ONE QUESTION INTO ONE THREAD, and the id is minted here rather than asked for: a
// fresh one IS how a conversation is opened. Starting again mints another, because the conversation
// on screen is stored under its own id and a fifth question into it is a refusal.
test('Ask writes into a thread it minted, and starting again opens a new one', () => {
  const room = read('ask/AskRoom.jsx');
  assert.equal(room.includes('const [threadId, setThreadId] = useState(() => mintId(THREAD_PREFIX));'), true);
  assert.equal(room.includes('const reply = await gymApi.ask(threadId, question);'), true);
  assert.equal(room.includes("setRefusedFull(false); setThreadId(mintId(THREAD_PREFIX));"), true);
  // And the thing §O retired is gone rather than left beside its replacement: nothing on this
  // surface assembles a body out of the turns on screen any more.
  for (const file of gymFiles()) {
    // The SPEECH again: ask.js's comment records the retirement, which is the note the next reader
    // needs, and an assembler surviving in code is what this is looking for.
    assert.equal(spoken(fs.readFileSync(file, 'utf8')).includes('threadFor'), false, file);
  }
});

// DELETE DELETES THE CONVERSATION, NOT THE CONSEQUENCE (§O) — and the sentence that says so is on
// screen BEFORE the tap rather than in a toast after. Two taps, because it cannot be undone.
test('the delete says what it does before it is armed, and takes two taps', () => {
  const threads = read('ask/Threads.jsx');
  assert.equal(threads.includes('<p className="gym-thread-delete-note">{DELETE_NOTE}</p>'), true);
  assert.equal(threads.includes('if (!confirming) {'), true);
  assert.equal(threads.includes('await gymApi.deleteThread(id);'), true);
});

// THE TRAIL RUNS BOTH WAYS (§O), and only where the wire carried a thread: the routine's history row
// and the diff each offer the conversation a change was asked for in, and neither invents one. The
// history's door is a SIBLING of the row rather than a link inside it — one anchor may not sit
// inside another, and a nested one is a link a browser renders however it likes.
test('a change that came from a conversation offers it, and one with none offers nothing', () => {
  const routines = read('Routines.jsx');
  assert.equal(routines.includes('{row.thread && ('), true);
  assert.equal(routines.includes('<a className="gym-history-thread" href={threadHref(row.thread)}>{CONVERSATION_VERB} ›</a>'), true);
  const proposals = read('Proposals.jsx');
  assert.equal(proposals.includes('{conversationOf(proposal.source) && ('), true);
  assert.equal(proposals.includes('href={threadHref(conversationOf(proposal.source))}'), true);
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
  // And leaving the room sends what is still held rather than dropping it on the floor — and says
  // so with no Undo on it, since the delete has gone (Log.test.js drives it).
  assert.equal(source.includes('withheld.current.forEach((held) => {\n      sendDelete(held.set.id);\n      say(deletedLine(held.set));\n    });'), true);
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
  // the review door in the header above it, which is drawn only once the workout is over.
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
// walks to the room that explains what they may do to it; a revoke drawn here would be a second door
// onto one decision, which is the same rule that keeps the account's close in the shell alone.
//
// WHERE IT WALKS CHANGED IN W8. It opened the account's /connect workbench directly — a page whose
// five capability chips are all about planting roadmaps — so a lifter who tapped "Connected log" in
// their TRAINING settings was answered about skill trees. #/gym/connect is gym's own words around
// the same account-level grant, and the workbench is one tap on from there.
test('the connected-log row names the grant state without rebuilding it', () => {
  const source = read('settings/GymSettingsSection.jsx');
  assert.equal(source.includes('listGrants'), true);
  assert.equal(source.includes('revokeGrant'), false);
  assert.equal(source.includes('href={CONNECT_HREF}'), true);
  // The old destination, gone rather than kept beside the new one: two doors onto one decision is
  // how they drift.
  assert.equal(source.includes('"#/connect"'), false);
  // AND WHAT REACHES THE LOG IS ONE RULE, not one per surface. This row wrote the predicate out for
  // itself — read the scope, keep the legacy account-wide grant, keep anything naming gym — and the
  // room it walks to needs the same answer; a second copy is a second thing that can start calling a
  // live connection absent.
  assert.equal(source.includes('connectionsToTheLog(grants, keys)'), true);
  assert.equal(source.includes('readScope'), false);
  // AND IT TAKES BOTH DOORS OR NEITHER. A static personal key is minted account-wide and never
  // appears in a grant row, so a row that read grants alone told an account whose key can discard a
  // workout that nothing reads their log. Promise.all is what makes half an answer no answer.
  assert.equal(source.includes('Promise.all([listGrants(), listMcpKeys()])'), true);
  // One vocabulary for one object: the state line is the room's, so a key cannot be "minted" in one
  // place and "connected" in the other.
  assert.equal(source.includes('${connectedLabel(row)}'), true);
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

// SCREEN 1, AND SINCE 13 AUG THE HALF THIS SURFACE CAN DRAW IS THE PRIMARY. The board's screen 1
// leads with `Build a routine` (routine-first — home is the plan, nothing starts by itself), and
// building a routine is a desk activity that exists today, so the primary lands here whole. The
// half the desk may not draw is `Just start logging`: a session cannot start at the desk (§11), so
// the free-form path is named as the phone's and never offered as a button.
test('the empty log offers the routine editor, and this surface still starts nothing', () => {
  const today = read('Today.jsx');
  assert.equal(today.includes('{log.summaries.length === 0 && <FirstRun />}'), true);
  assert.equal(
    today.includes('<a className="gym-first-write" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</a>'),
    true,
  );
  // AND THE ARGUMENT FOR IT IS NOT (W9). A dashed box under the verb used to make the design's case
  // — "no tour, no sample program, no questions about your goals" — which is a sentence about US,
  // read by somebody who came here to train. It is the difference the sweep turns on: the line above
  // says what will HAPPEN to a session they start, and stays; the box argued for the setup wizard we
  // refuse to build, and belongs beside the screen rather than on it. Asserted absent rather than
  // merely deleted, because nothing about this room fails when it grows back.
  const said = speech('Today.jsx');
  assert.equal(said.includes('No tour'), false);
  assert.equal(said.includes('sample program'), false);
  assert.equal(said.includes('catch it, not to write it'), false);
  assert.equal(read('Today.jsx').includes('gym-first-why'), false);
  // What DOES stay is the kept path — second since 13 Aug: the phone's free-form session still
  // names itself at the end, and the desk says so without offering it.
  assert.equal(said.includes('name what you did at the end'), true);
  // The one verb the web has never had since §11, said nowhere on it — in a comment, freely; on a
  // screen, never.
  for (const file of ['Today.jsx', 'Routines.jsx', 'Log.jsx', 'Finish.jsx', 'GymApp.jsx']) {
    assert.equal(speech(file).includes('Start a session'), false, file);
  }
});

// SCREEN 1's CTA, ON THE DESK. An empty routines list carries the door to writing one out — the
// board's `Build a routine`, verbatim, in the empty state itself and not only in the header — and
// it is the same door the header's New opens: the editor, never a session. Screen 1's second path,
// `Just start logging`, is the phone's (§11), so no web screen utters it.
test('the empty routines list offers to build one, and still starts nothing', () => {
  const source = read('Routines.jsx');
  assert.equal(
    source.includes('<a className="gym-routines-build" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</a>'),
    true,
  );
  assert.equal(source.includes("view.phase === 'ready' && view.data.length === 0"), true);
  for (const file of ['Today.jsx', 'Routines.jsx', 'Log.jsx', 'Finish.jsx', 'GymApp.jsx']) {
    assert.equal(speech(file).includes('Just start logging'), false, file);
  }
});

// ── Proposals: the agent proposes, and the tap is the only thing that applies ────────────────────

// A walk of every gym source file UNDER THE APP — `marketing/` is excluded, the same way the decline
// scan excludes it: it is copy about the product rather than the product. Every scan in this file
// that walks the tree walks it through here, and the exclusion is load-bearing for the prose sweep,
// so it is named again there rather than left to be inferred forty lines away.
const gymFiles = () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'marketing' ? [] : walk(at);
    return [at];
  });
  return walk(GYM);
};

// THE PROSE SWEEP, PINNED (W9). Twenty explainer blocks came off the design board in one edit, and
// several of them had already been typed into this surface verbatim — a paragraph is cheapest to
// draw on the web, which is exactly why the web accumulated the most of them. Every one is deleted
// now, and NOTHING BREAKS WHEN ONE COMES BACK: no screen fails, no read is wrong, no number moves.
// That is the whole reason this test exists. A retraction with no test is a retraction that lasts
// until the next person finds the gap and helpfully fills it in.
//
// The scan is over the SPEECH, on the rule every other scan in this file follows: a comment must
// stay free to say what it is refusing to put on a screen, and each deletion below left its reason
// behind in one. The fragments are the shortest text that identifies a sentence, so a reworded
// version of the same argument is caught with it.
//
// WHAT IT DOES NOT COVER, said here rather than inferred: `gymFiles()` walks the app and stops at
// `marketing/`. That is deliberate and not an oversight — the swept blocks came off the app board,
// and a landing page making the product's case is a landing page doing its job, so a positioning
// line there is not the defect this test is about. The landing has its own copy tests in this file.
// If a swept sentence is ever wanted as marketing copy, that is the marketing board's call to make,
// and this test is not the place it gets refused.
test('no gym screen argues for its own design — the swept prose stays swept', () => {
  const swept = [
    // Screen 1 · the dashed box under the empty room's verbs.
    'No tour',
    'sample program',
    'catch it, not to write it',
    // Screen 3 · what declining costs, said to somebody who has not declined anything.
    'Declining costs nothing',
    'behind their back',
    // Screen 10 · the empty slot, explaining that it is empty on purpose.
    'left empty on purpose',
    'implies the session was wasted',
    // Screen 11 · our generalisation about short sessions, over their own eleven minutes.
    'usually a phone left running',
    'nothing honest to say',
    // Screen 17 · the thesis of the screen, printed on the screen.
    'Dim is what the plan said',
    'no scolding',
    // Screen 20 · four captions that described the settings rather than the setting.
    'never the stored value',
    'does not get rewritten',
    'actually owns',
    'Vibration API',
    'does not restate them',
    'theme switch of its own',
    // Screen 7 · the picker explaining its own taxonomy, or its absence of one.
    'no taxonomy screen',
    'behaves identically',
    // Screen 5 · the list explaining its own sort order.
    'Sorted by last trained',
    // Screen 13 · the copy commenting on which team wrote it.
    'words gym puts around it',
    // Screen 25 · the palette, described to the person looking at it.
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

// THE ONE PLACE A ROUTINE AN AGENT WROTE TO CAN MOVE, and it is a human's tap on a diff they are
// looking at. Nothing this wave built may grow a second door onto it: not the card, which is a
// notification; not the routines list; and above all not the routine editor, which holds a DRAFT —
// a routine applied under an open draft would be a change the lifter never saw, whole-document PUT
// straight back out by the Save they press next.
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
  // The routine screen carries the History section (screens 6 and 30) and every proposal row of it
  // is a door too. It reads NOTHING of its own: the rows ride the routine's own read, which is also
  // the only read that carries the day the routine was created — so the section costs that screen no
  // second request, and a routine nobody has saved has nothing to draw.
  const routines = read('Routines.jsx');
  assert.equal(routines.includes('<RoutineHistory routine={view.data} />'), true);
  assert.equal(routines.includes('const rows = historyRows(routine);'), true);
  assert.equal(routines.includes('gymApi.proposals'), false);
  assert.equal(routines.includes('<a className="gym-history-row" href={row.href}>'), true);
  // And the mark on a waiting row is the one every other surface wears — one dot, drawn in one
  // place, whoever is drawing it.
  assert.equal(source.includes('export function ProposalDot()'), true);
  assert.equal(routines.includes('{row.pending && <ProposalDot />}'), true);
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
    // AND THE JUSTIFICATION FOR LANDING A NEW DAY UNASKED, which is only half true. The lifter can
    // edit it — the routine editor is a real screen — and cannot delete it: `gymApi.deleteRoutine`
    // has no caller in this app, and neither do its iOS and Android twins. The catalog says the same
    // sentence to the agent; that one is the backend's to fix.
    'delete it yourself',
  ]) {
    assert.equal(landing.includes(claim), false, claim);
  }
  assert.equal(speech('marketing/GymLanding.jsx').includes('the day is yours to edit in Routines'), true);
  // And what stands in their place is the rule itself, on the page rather than in the margin — both
  // halves of it, the direct write included.
  const said = speech('marketing/GymLanding.jsx');
  assert.equal(said.includes('it never rewrites a day you already have'), true);
  assert.equal(said.includes('adds lands right away: it takes nothing away'), true);
  assert.equal(said.includes('Propose next week’s routine — you read the diff and tap Apply.'), true);
  // THE THREE LEVEL LINES MOVED INTO THE PRODUCT in W8 and the landing imports them, so what
  // `gym:write` buys cannot read one way in a pitch and another in the room a visitor lands in.
  // They are pinned where they now live; connect.test.js holds them against the catalog.
  const levels = fs.readFileSync(path.join(GYM, 'connect', 'connect.js'), 'utf8');
  assert.equal(levels.includes('Record what happened · add a new day or a new movement · propose changes to the days you have'), true);
  assert.equal(levels.includes('Discard a workout · end a share link · propose a removal'), true);
  assert.equal(said.includes('LEVEL_LINES.write'), true);
  assert.equal(said.includes('LEVEL_LINES.delete'), true);
  // The three `gym:delete` tools are discard_session, propose_routine_removal AND revoke_share, so
  // the caption under them names three effects rather than two. It keeps the word coach, because the
  // link it names is one a lifter hands to a person who coaches them.
  assert.equal(said.includes('end a coach link, or ask to remove a routine.'), true);

  // The MCP workbench's own page says the same thing in its own voice, and no longer says an agent
  // "keeps" a routine of yours.
  const connect = fs.readFileSync(path.join(GYM, '../../../public/connect.html'), 'utf8');
  assert.equal(connect.includes('keep your routines'), false);
  assert.equal(connect.includes('What it cannot do is change a routine you already have'), true);
  assert.equal(connect.includes('nothing moves until you tap Apply'), true);
});

// ── The connected log (§D12/13) ─────────────────────────────────────────────────────────────────

// THE INVITATION IS DRAWN UNDER TWO CONDITIONS AND BOTH LIVE INSIDE IT, which is the same rule
// AskDoor keeps: a guard written at each call site is the one a third host forgets. Never
// mid-session — a lifter with a bar in their hands is not deciding about MCP — and never to somebody
// already connected, because an invitation to do what you have already done is what turns an
// invitation into a nag. A mounted-component test cannot see this: the difference is whether the
// card is in the tree at all, and both hosts render perfectly well without it.
test('the connected-log invitation is drawn from two rooms, and neither decides when', () => {
  assert.equal(read('Routines.jsx').includes('<ConnectInvitation training={log.session != null} />'), true);
  assert.equal(read('Proposals.jsx').includes('<ConnectInvitation training={log.session != null} />'), true);
  const card = read('connect/ConnectLog.jsx');
  // The session guard is answered ABOVE the read, in a component that calls no hook, so a lifter
  // mid-workout is not spending two credentialed requests per Routines mount on a card that has
  // already decided to draw nothing.
  assert.equal(card.includes('if (training) return null;\n  return <InvitationCard />;'), true);
  // The second guard is the read, and an unanswered one draws NOTHING: silence is an omission, while
  // a card drawn off a half-read asserts that no tool reads this log — the one thing it could be
  // wrong about.
  assert.equal(
    card.includes("if (reach.phase !== 'ready' || reach.data.length > 0) return null;"),
    true,
  );
  // And nothing counts how often it was walked past (§D3). The blanket decline scan below covers
  // every gym file; this is the same rule stated where the temptation is newest.
  assert.equal(/timesShown|shownCount|nagged|dismissedAt/i.test(card), false);
});

// THE ROOM IS ONE HASH AND ONE MOUNT. It is not a fourth tab — the bar is the app's three rooms —
// and it is reached from settings, from Ask's empty state and from the invitation, all of which name
// the same constant rather than spelling the hash out.
test('the connected log is a room off one hash, and never a tab', () => {
  const app = read('GymApp.jsx');
  assert.equal(app.includes("{screen === 'connect' && <ConnectLog />}"), true);
  assert.equal(app.includes("const TAB_SCREENS = ['today', 'log', 'routines'];"), true);
  for (const file of ['settings/GymSettingsSection.jsx', 'ask/AskRoom.jsx', 'connect/ConnectLog.jsx']) {
    assert.equal(read(file).includes('CONNECT_HREF'), true, file);
  }
});

// GYM CONTRIBUTES WORDS AND A LINK, AND NOT A SECOND CONSENT FLOW (§D13). The OAuth grant screen and
// the revoke belong to the account; this room READS the grants it can see and walks to the workbench
// that holds the URL. A revoke drawn here would be a second door onto one decision — the same rule
// that keeps the account's close in the shell alone — and a consent post here would be a second
// implementation of the thing the whole safety model rests on.
test('the connected-log room reads the grant and rebuilds none of it', () => {
  const room = read('connect/ConnectLog.jsx');
  assert.equal(room.includes('listGrants'), true);
  // It reads the personal keys too — that is the second door onto this log and the grant list cannot
  // see it — but reading a list is not owning the credential: minting and revoking stay the
  // account's, in the panel and the section that already hold them.
  assert.equal(room.includes('listMcpKeys'), true);
  for (const machinery of [
    'revokeGrant', 'postDecision', 'fetchConsentClient', 'McpKeyPanel', 'mintKey', 'createMcpKey',
    'revokeMcpKey',
  ]) {
    assert.equal(room.includes(machinery), false, machinery);
  }
  // The one door out is the account's workbench, named once, in the words module.
  assert.equal(read('connect/connect.js').includes("export const WORKBENCH_HREF = '#/connect';"), true);
});

// NO PRICE, NO LOCK, NO TIER, AND NO CHECKOUT — W8's whole ruling, and this surface is where it would
// be undone first, because §D's own headline for it was "The log is free. The connected log is
// Windmill One." That tier gates nothing in gym (the MCP tools read no entitlement and never did),
// nobody can buy it (`paidPlansOpen()` is a hardcoded false), and its button would land on a
// BillingApi that 503s. The scan is for the APIs as well as the words: copy can be reworded, an
// import cannot.
test('the connected log reads no entitlement and offers nothing to buy', () => {
  for (const file of ['connect/connect.js', 'connect/ConnectLog.jsx']) {
    const said = speech(file);
    for (const door of ['useEntitlements', 'paidPlansOpen', 'beginUpgrade', 'windmillOne', 'checkout', 'Paddle']) {
      assert.equal(said.includes(door), false, `${file} reaches for ${door}`);
    }
    assert.equal(/[Uu]pgrade|Windmill One|[Ss]ubscri|\$\d|£\d|€\d|[Ll]ocked|free for now/.test(said), false, file);
  }
  // And the stylesheet paints no locked face for one to inherit.
  assert.equal(/\.gym-connect[a-z-]*\.is-locked/.test(read('gym.css')), false);
});

// THE CARD DOES NOT INVENT A FRESHNESS IT CANNOT OBSERVE. §D draws `connected · read 2h ago`, and
// nothing in this system records a per-connection last READ of the training log: `lastUsedMs` on the
// account's grant row is touched by any token use, counts writes, is throttled, and is account-wide,
// so a connection that also reaches roadmap advances it by planting a node in a skill tree. A card
// that spelled an hour count off that would be the same defect as a receipt counting rows it never
// served, which this programme has already had once — so the field is not read here at all.
//
// The scan is over the SPEECH, which is the same rule every other scan in this file follows: a field
// read survives the comment strip and prose about one does not, so a comment stays free to name the
// stamp it is refusing to draw.
test('nothing on the connected-log surface reads a last-used stamp, or spells a read time', () => {
  for (const file of ['connect/connect.js', 'connect/ConnectLog.jsx', 'settings/GymSettingsSection.jsx']) {
    const said = speech(file);
    assert.equal(said.includes('lastUsedMs'), false, file);
    assert.equal(/read \d+h ago|hours ago|minutes ago/.test(said), false, file);
  }
});

// THE PITCH IS ONE CONCRETE EXCHANGE, and it reaches the two surfaces a lifter meets it on: the
// landing, and the crawlable workbench a search engine reads. §D12 is a card about a trade — one
// sentence typed on Sunday in a tool that is not ours, one proposal waiting on Monday — and the
// precondition under it is the most honest line on the board, so both are checked as copy that
// actually shipped rather than as constants nobody rendered.
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
  // And it still says the one thing about this transport that is true: there is no SSE endpoint in
  // the backend at all (McpHttpEndpoint answers GET with a 405).
  assert.equal(connect.includes('There is no SSE transport'), true);
});

// A SUBSCRIPTION IS A THING NOBODY CAN HAVE, so gym's own pages stopped describing one. The line
// read "one account and one subscription across Roadmap, Journal and Gym" — a shape rather than a
// purchase, which is exactly how a false sentence survives a review — and it sat on the same page as
// a section saying in as many words that there is nothing in Gym to buy.
test('no gym landing copy sells a subscription, on the page or in the crawlable shell', () => {
  const landing = speech('marketing/GymLanding.jsx');
  const head = fs.readFileSync(path.join(GYM, 'marketing', 'landingHead.js'), 'utf8');
  for (const source of [landing, head]) {
    assert.equal(/one subscription|One subscription/.test(source), false);
  }
  assert.equal(landing.includes('one account across Roadmap, Journal and Gym'), true);
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

// ── §M · a program typed in at the desk, and §N · the names are the user's ──────────────────────

// NAME FIRST, AND IT IS A REAL QUESTION ASKED ONCE (screen 28). A routine built on purpose deserves
// the word you already call it, and `Workout 3` is what a program gets called when nobody asked. The
// step exists only on the way IN — a routine already saved opens straight onto its own list — which
// is a fact about which branch a component takes and nothing a pure module can be asked.
test('a routine written from scratch is named before it is filled in, and only then', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('const [naming, setNaming] = useState(fresh);'), true);
  assert.equal(source.includes('if (naming) {'), true);
  assert.equal(source.includes('Next · add movements'), true);
  // The suggestions FILL THE FIELD and are never a set to choose from: one tap writes the name and
  // typing over it is the expected case, so nothing here records which one was tapped.
  assert.equal(source.includes('onClick={() => onName(suggestion)}'), true);
  assert.equal(/suggestion === |selectedSuggestion|chosenName/.test(source), false);
  // NOTHING IS CREATED BY NAMING IT. The step carries the name into the editor and Save is still the
  // only thing on this screen that writes — a create fired here would leave a routine with no
  // movements in the program of anybody who changed their mind.
  const step = source.slice(source.indexOf('function NameTheRoutine'), source.indexOf('function RoutineHistory'));
  assert.equal(/createRoutine|replaceRoutine/.test(step), false);
});

// THE SAME LADDER AS THE RACK (screen 29), and it is the one that exists: the sheet calls `bump` and
// `ladderLabels`, so at 140 kg the row reads −10 · −2.5 · +2.5 · +10 because the golden says so and
// not because this screen agrees. Lift had this rule pasted into three targets and let them drift.
test('the target sheet steps a weight on the logger’s ladder and states no step size of its own', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes("import { LADDER_KEYS, ladderLabels, bump } from './logger/ladder.js';"), true);
  assert.equal(source.includes('const rungs = ladderLabels(draft.targetWeightKg ?? EMPTY_BAR_KG);'), true);
  assert.equal(source.includes('bump(held.targetWeightKg, rung.direction, rung.big)'), true);
  // The sheet writes no step of its own: a step in this product is 1, 2.5, 5 or 10 kg, and the
  // fractional ones are unmistakable — so no number with a decimal point survives in this file's
  // speech. The icon stroke is the one exception and is not a weight, so it comes out first.
  assert.equal(/\d\.\d/.test(speech('Routines.jsx').replace(/strokeWidth=\{[\d.]+\}/g, '')), false);
});

// A ROUTINE BUILT AT HOME HAS NO HISTORY, SO THE SHEET SAYS SO (§M) — rather than prefilling a guess,
// which is the lie this line exists to prevent. The claim is the STORE's about the routine and the
// DRAFT's about the row (routines.js), and nothing on this path reaches for a last time, because
// there is none to reach for. The screen decides none of it: a condition written here is a condition
// no test without a browser can read.
test('the target sheet says there is nothing to prefill from, and prefills nothing', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('neverLogged={saysNeverLogged(view.data, draft.entries[target])}'), true);
  assert.equal(
    source.includes('{neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}'),
    true,
  );
  // And the sentence is nowhere near `isUntested` alone: the routine's own flag draws the `untested`
  // chip on screen 30 and never this line, which was it over a movement with years behind it.
  assert.equal(source.includes('untested={'), false);
  // The one read that could answer "what did you lift last time" is not called from this screen, and
  // is not called from anywhere on this surface at all — capture lives on the phones (§11).
  for (const file of gymFiles()) {
    if (path.basename(file) === 'gymApi.js') continue;
    assert.equal(fs.readFileSync(file, 'utf8').includes('lastTime('), false, file);
  }
});

// A ROUTINE IS SAVABLE WHILE INCOMPLETE (§M): the row with no target is `open` and asks at the rack,
// and the sentence naming those rows is a fact about the DAY — the lifter's own training — which is
// why it is on the glass rather than on the board.
test('a line can be left open from the sheet, and the screen says which lines will ask', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('Leave it open'), true);
  assert.equal(source.includes('decide at the rack'), true);
  assert.equal(source.includes('const openTargets = openTargetsLine(draft.entries, log.catalog);'), true);
  assert.equal(source.includes('{openTargets && <p className="gym-editor-open">{openTargets}</p>}'), true);
  // `untested` is not an alarm and is not painted like one: it says the first session is allowed to
  // disagree with the routine, which is the point of writing one out before you have trained it.
  assert.equal(/\.gym-editor-untested \{[^}]*var\(--alarm-ink\)/.test(read('gym.css')), false);
});

// CREATING A MOVEMENT IS THE TWO QUESTIONS AND NOT A SECOND DOOR BESIDE THEM (§N screen 31). The
// picker's `Create "…"` used to mint straight from the search box with a silent `barbell` on it —
// so how it is loaded, the one answer that changes what the ladder does, was
// ours to guess. Now the button opens the sheet and nothing is written until `Create and add`.
test('the create door asks how a movement is loaded, and mints nothing before it is answered', () => {
  const picker = read('logger/MovementPicker.jsx');
  assert.equal(picker.includes('onClick={() => setMinting({ name: query.trim(), equipment: DEFAULT_EQUIPMENT })}'), true);
  assert.equal(picker.includes('function NewMovement({ draft, onChange, onCancel, onCreate }) {'), true);
  assert.equal(picker.includes('Create and add'), true);
  assert.equal(picker.includes('How is it loaded?'), true);
  // The four are the module's, in one place, so the screen cannot offer a fifth or a different four.
  assert.equal(picker.includes('{EQUIPMENT_CHOICES.map((choice) => ('), true);
  assert.equal(/'(cable|kettlebell)'/.test(picker), false);
  // And the mint carries both answers to the one place that writes them (useTrainingLog.js).
  assert.equal(picker.includes('onCreate({ name: draft.name.trim(), equipment: draft.equipment })'), true);
  assert.equal(read('useTrainingLog.js').includes('id: mintId(\'ex_\'), name: name.trim(), equipment, pattern: CREATED_PATTERN,'), true);
  // THE WAY OUT IS NAMED (screen 31's head). A sheet that only shows something closes on a glyph; a
  // sheet that asks two questions says the word — one aimed exit, and it is the board's own.
  assert.equal(picker.includes('<button type="button" className="gym-sheet-cancel" onClick={onCancel}>Cancel</button>'), true);
  const sheet = picker.slice(picker.indexOf('function NewMovement'));
  assert.equal(sheet.includes('gym-sheet-close'), false);
});

// ONE WORD FOR THE ONE `custom` FLAG. The boards drew two — the picker's `yours` (screen 7) and a
// routine row's `· mine` (§M screen 30) — and the 2026-08-13 adjudication picked the picker's:
// `yours`, on every surface, for every screen that marks a movement this account minted.
test('a movement this account minted is tagged `yours`, in the picker and in a routine', () => {
  assert.equal(read('logger/MovementPicker.jsx').includes('<span className="gym-picker-tag">yours</span>'), true);
  assert.equal(read('Routines.jsx').includes('<span className="gym-entry-yours">yours</span>'), true);
  // The retired word, asserted gone rather than merely replaced: nothing may grow it back.
  assert.equal(read('Routines.jsx').includes('>mine</span>'), false);
});

// THE RENAME SHEET PROVES WHAT IT CLAIMS (§N screen 32). The counts on it come from real reads — the
// record page's own, made before the sheet was opened — and a constant on that block would be the
// product asserting something it did not check, on the one screen whose whole job is proof.
test('the rename sheet’s proof is the page’s own read, and no number on it is typed in', () => {
  const source = read('Record.jsx');
  assert.equal(source.includes('record={view.data}'), true);
  assert.equal(source.includes('const proof = renameProofOf(record);'), true);
  // No second call behind the sheet: the read the page already made answers all four lines.
  assert.equal((source.match(/useGymRead\(/g) ?? []).length, 1);
  assert.equal(source.includes('gymApi.record'), true);
  // Nothing on this screen spells a count of its own — every number arrives from record.js, which is
  // where the sentences are written and where the tests can read them.
  const sheet = source.slice(source.indexOf('function RenameSheet'));
  assert.equal(/\d+ sessions|\d+ PRs|unchanged|kept/.test(spoken(sheet)), false);
  // `Rename` / `Cancel`, in that order and in those words (screen 32) — the way out is under the
  // commit rather than a glyph in the head, because leaving a name alone is one of the two answers
  // this sheet asks for. One aimed exit, like every other sheet here.
  assert.equal(sheet.includes('<button type="button" className="gym-name-cancel" onClick={onClose}>Cancel</button>'), true);
  assert.equal(sheet.indexOf('gym-name-save') < sheet.indexOf('gym-name-cancel'), true);
  assert.equal(sheet.includes('gym-sheet-close'), false);
});

// THE CAP THE COUNTER SAYS IS THE CAP THE FIELD KEEPS, on all three surfaces that ask for a name —
// and it is one number for the product, under the store's own eighty bytes on purpose (log.js).
// A field bound to one number over a counter drawn from another is a stop nobody can see coming.
test('every name a lifter types is capped once, and the counter counts the same field', () => {
  for (const file of ['Routines.jsx', 'Record.jsx', 'logger/MovementPicker.jsx']) {
    const source = read(file);
    assert.equal(source.includes('maxLength={NAME_MAX}'), true, file);
    assert.equal(/const NAME_MAX = \d+/.test(source), false, file);
  }
  for (const file of ['Record.jsx', 'logger/MovementPicker.jsx']) {
    assert.equal(read(file).includes('nameCountLabel('), true, file);
    // Both of these fields OPEN ON A NAME they did not type — the store's, which keeps eighty, and
    // the search box's, which caps nothing — so both can open already over the cap and both say so.
    // The routine's own field cannot: it opens empty and is only ever typed into.
    assert.equal(read(file).includes('isNameOverCap('), true, file);
  }
  assert.equal(/export const NAME_MAX = 60;/.test(read('log.js')), true);
});

// A ROUTINE RENAMES THROUGH THE DOCUMENT IT ALREADY HOLDS (§N's Follows note, and the wire's). There
// is no rename route for a routine: the name is one field of the whole-document PUT, which is what
// moves `revision` and supersedes a pending proposal — and a second door onto that write would be a
// second place that rule could drift. Nor is there a proof block on it: the board draws counts for a
// MOVEMENT, and inventing "12 sessions · unchanged" for a routine is exactly the constant this wave
// exists to refuse.
test('a routine’s name moves with its own document, and claims nothing about what follows it', () => {
  const source = read('Routines.jsx');
  assert.equal(source.includes('renameRoutine'), false);
  assert.equal(source.includes('gymApi.replaceRoutine(draft.id, write)'), true);
  assert.equal(source.includes('renameProofOf'), false);
  assert.equal(speech('Routines.jsx').includes('unchanged'), false);
});
