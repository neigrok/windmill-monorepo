// A journal with a couple of years in it, so every echo state can be seen without a backend.
//
// The corpus is one person circling the same idea across two and a half years, because that is what
// an echo is for: you may have forgotten you ever planned it. Days are computed from today, so the
// distances read the way the design writes them ("five months ago", "one year, two months") whenever
// you open this, not only on the day it was written.
//
// Every quote here is a real substring of the page body it points at — the surface re-locates each
// one in the live body at render, so a fixture that lied about its own corpus would render nothing.

import { localDay } from '../hlc.js';

function monthsBack(months, dayOfMonth) {
  const [year, month] = localDay().split('-').map(Number);
  const date = new Date(year, month - 1 - months, dayOfMonth);
  return localDay(date);
}

function daysBack(days) {
  const [year, month, day] = localDay().split('-').map(Number);
  return localDay(new Date(year, month - 1, day - days));
}

// Keep the opening words, count what the cut held back. The count is computed, never asserted — a
// withheld number that disagreed with the passage would be exactly the lie this feature must not tell.
function cut(text, keepWords) {
  const words = text.split(/\s+/);
  return { text: words.slice(0, keepWords).join(' '), withheldWords: words.length - keepWords };
}

// One page of the corpus: a passage with a little life around it, so re-location has something to do.
const CORPUS = [
  {
    back: 5, on: 14, keep: 12,
    before: 'Rain all day. Cleared out the desk drawer and found the old notebooks.',
    passage: 'If I’m honest, the best part of the last project was the fortnight I spent writing the parser by hand — no framework, no generator, just me and a notebook full of grammars — and everything that came after it felt like paperwork somebody else had already decided the shape of.',
    after: 'Marta says I say this every spring.',
  },
  {
    back: 6, on: 22, keep: 10,
    before: 'Long walk after work.',
    passage: 'I want to be the kind of person who finishes the small thing rather than the kind who plans the enormous one, and I have been the second kind for about eleven years now.',
    after: '',
  },
  {
    back: 9, on: 2, keep: 11, source: 'spoken',
    before: '',
    passage: 'I keep coming back to C++, and I think it is because it is the only place where I feel like I am building the thing itself instead of arranging other people’s boxes into the shape of a thing.',
    after: 'Recorded this walking home, so it is probably nonsense.',
  },
  {
    back: 13, on: 1, keep: 4,
    before: 'First day of the year. Nothing much to report.',
    passage: 'I want to learn C++ this year, properly, from the bottom.',
    after: '',
  },
  {
    back: 14, on: 8, keep: 9,
    before: 'Slept badly.',
    passage: 'The plan for this year was to learn C++ properly and I have written maybe four hundred lines, all of them in a scratch file I have not opened since February.',
    after: 'Tomorrow: groceries, and the tax thing.',
  },
  {
    back: 17, on: 21, keep: 8,
    before: '',
    passage: 'Talked to Marek about the compiler course tonight — he said start with the book and not the videos, because the videos let you feel like you are learning without ever making you write anything.',
    after: 'He is right and I resent it.',
  },
  {
    back: 18, on: 9, keep: 9,
    before: 'Quiet Sunday.',
    passage: 'I would rather understand one thing all the way down than fifty things at the depth of a tutorial, and I say that as somebody with fifty tutorials in his history.',
    after: '',
  },
  {
    back: 20, on: 3, keep: 10,
    before: '',
    passage: 'I want to be the person who understands what is happening under the runtime rather than the person who searches for it every single time and forgets it again by Thursday.',
    after: 'Cold out. Good soup.',
  },
  {
    back: 24, on: 11, keep: 9, isSelf: false,
    before: 'Copied this out of the linker essay because I want to keep it.',
    passage: 'The linker is the part everyone skips, and it is also the part that explains why the program you wrote is not the program that runs.',
    after: '',
  },
  {
    back: 27, on: 6, keep: 7,
    before: '',
    passage: 'Bought the book today. It is enormous and slightly absurd and I am going to read it anyway, ten pages a night, starting tomorrow.',
    after: 'Ten pages a night.',
  },
  {
    back: 29, on: 19, keep: 8,
    before: 'Woke up early for no reason.',
    passage: 'What I actually miss is making something small and finished, something with an end to it, instead of another thing that is eighty percent done and waiting for a weekend.',
    after: '',
  },
  {
    back: 31, on: 1, keep: 5,
    before: 'New year. The flat is cold.',
    passage: 'I want to learn C++. That is the whole resolution, and I am not adding anything else to it.',
    after: '',
  },
];

const BY_BACK = new Map(CORPUS.map((entry) => [entry.back, entry]));

function dayOf(back) {
  return monthsBack(back, BY_BACK.get(back).on);
}

function bodyOf(entry) {
  return [entry.before, entry.passage, entry.after].filter(Boolean).join('\n');
}

function match(back, entitled) {
  const entry = BY_BACK.get(back);
  const held = entitled ? { text: entry.passage, withheldWords: 0 } : cut(entry.passage, entry.keep);
  return {
    day: dayOf(back),
    text: held.text,
    withheldWords: held.withheldWords,
    isSelf: entry.isSelf !== false,
    source: entry.source || 'typed',
  };
}

const TONIGHT_BODY = 'Read about compilers again this evening instead of doing the thing I said I would do.\n'
  + 'I keep circling the same idea: build something with my own hands, in a language that does not hide the machine from me.';

const YESTERDAY_BODY = 'Worked late. Bought bread on the way home and ate half of it standing up.\n'
  + 'Still thinking about the small-and-finished thing.';

// The pages the canvas draws, newest last — today, yesterday, and every page an echo points at.
function corpusPages() {
  return [
    { day: localDay(), body: TONIGHT_BODY, mood: 3, energy: 2 },
    { day: daysBack(1), body: YESTERDAY_BODY, mood: 4, energy: 2 },
    { day: daysBack(3), body: 'Nothing much. Long meeting about the migration, then nothing.', mood: 2, energy: 1 },
    ...CORPUS.map((entry) => ({ day: dayOf(entry.back), body: bodyOf(entry), mood: 3, energy: 2 })),
  ];
}

// Tonight reaches back nine times; yesterday twice; and the page five months back has its own four,
// so a walk keeps finding pages that were already reaching further back than the one you came from.
function corpusEchoes(entitled) {
  return [
    {
      day: localDay(),
      entitled,
      matches: [5, 9, 14, 17, 20, 24, 27, 29, 31].map((back) => match(back, entitled)),
    },
    {
      day: daysBack(1),
      entitled,
      matches: [6, 18].map((back) => match(back, entitled)),
    },
    {
      day: dayOf(5),
      entitled,
      matches: [13, 14, 17, 20].map((back) => match(back, entitled)),
    },
  ];
}

export const SCENARIOS = [
  {
    id: 'free',
    label: 'Without One — the honest cut',
    note: 'Nine echoes on tonight’s page, cut mid-clause with the withheld words counted.',
    entitled: false,
    pagesWritten: 214,
    firstEchoEver: false,
    pages: corpusPages(),
    echoes: corpusEchoes(false),
  },
  {
    id: 'one',
    label: 'With One — the whole passage',
    note: 'The same nine, uncut, with the panel of all matches and the walk back through them.',
    entitled: true,
    pagesWritten: 214,
    firstEchoEver: false,
    pages: corpusPages(),
    echoes: corpusEchoes(true),
  },
  {
    id: 'first',
    label: 'The first echo ever',
    note: 'One match, and the card that says what an echo is — said once, never again.',
    entitled: true,
    pagesWritten: 22,
    firstEchoEver: true,
    pages: corpusPages(),
    echoes: [{ day: localDay(), entitled: true, matches: [match(14, true)] }],
  },
  {
    id: 'sparse',
    label: 'Under the page floor',
    note: 'Eleven pages written. No marks, no offer — there is nothing true to say yet.',
    entitled: false,
    pagesWritten: 11,
    firstEchoEver: false,
    pages: corpusPages(),
    echoes: corpusEchoes(false),
  },
];

export function scenarioById(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) || null;
}
