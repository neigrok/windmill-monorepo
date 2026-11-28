#!/usr/bin/env python3
# Declarative story authoring: every expectation below is stated by hand from docs/foundation/journal-talk.md.
# The helpers measure, join and copy; none decides what a take does. No implementation is imported or run.
import argparse
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
WIRE = json.loads((ROOT.parent.parent / 'ai' / 'wire' / 'fixtures.json').read_text())
SPEECH, QUIET = 1000000, 0
DAY, NOON, ACTOR = '2026-10-01', 1790856000000, 'writer:a'
A, B, C, D = ('A' * 22, 'B' * 22, 'C' * 22, 'D' * 22)
# ECMAScript's WhiteSpace and LineTerminator, as the journal corpus trims: U+0085 is content.
WHITESPACE = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def utf8(text):
    return len(text.encode())


def utf16(text):
    return len(text.encode('utf-16-le')) // 2


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def head_of(text):
    return text.rstrip(WHITESPACE)


# The page's text with these parts as its passage (§5.3): untouched while no part holds text.
def placed(before, parts):
    texts = [part for part in parts if part]
    if not texts: return before
    head = head_of(before)
    return (head + '\n\n' if head else '') + ' '.join(texts)


def mark_of(before, parts, heard, calls=(A, B, C, D), stored=None):
    return {'day': DAY, 'bytesBefore': utf8(head_of(before)), 'pageDigest': digest(placed(before, parts) if stored is None else stored),
            'sessions': [{'callId': call, 'bytesSaved': utf8(part), 'heardAt': at} for call, part, at in zip(calls, list(parts) + [''] * len(heard), heard)]}


def pause_cases():
    def energy(name, samples, value):
        return {'name': name, 'input': {'op': 'PauseRule.energy', 'samples': samples}, 'expect': {'energy': value}}

    def commits(name, energies, frames):
        return {'name': name, 'input': {'op': 'PauseRule.commits', 'energies': energies}, 'expect': {'commits': frames}}

    return [
        energy('a frame of silence has no energy', [[0, 2400]], 0),
        energy('a full-scale frame has an energy of 1,073,741,824', [[-32768, 2400]], 1073741824),
        energy('a sum of squares of 2,399 rounds down to nothing', [[1, 2399], 0], 0),
        energy('a sum of squares of 2,400 is an energy of one', [[1, 1200], [-1, 1200]], 1),
        energy('a frame of amplitude 103 stays under SPEECH_MIN', [[103, 1200], [-103, 1200]], 10609),
        energy('a frame of amplitude 104 passes SPEECH_MIN', [[104, 1200], [-104, 1200]], 10816),
        commits('an empty sequence sends nothing', [], []),
        commits('a sequence shorter than a block sends nothing', [[SPEECH, 5]], []),
        commits('seven quiet frames after ten of speech send one commit', [[QUIET, 10], [SPEECH, 10], [QUIET, 7]], [27]),
        commits('six quiet frames send nothing', [[QUIET, 10], [SPEECH, 10], [QUIET, 6]], []),
        commits('nine speech frames and a pause send nothing', [[QUIET, 10], [SPEECH, 9], [QUIET, 7]], []),
        commits('before one whole block the floor is zero', [[20000, 9], 0, 200000, [QUIET, 7]], [18]),
        commits('a frame is judged against the blocks complete before it', [[20000, 10], [QUIET, 7]], [17]),
        commits('an energy of 10,736 is not speech', [[QUIET, 10], [10736, 10], [QUIET, 7]], []),
        commits('an energy of 10,737 is speech', [[QUIET, 10], [10737, 10], [QUIET, 7]], [27]),
        commits('ten times the floor is speech', [[2000, 10], [20000, 10], [QUIET, 7]], [27]),
        commits('one less than ten times the floor is not speech', [[2000, 10], [19999, 10], [QUIET, 7]], []),
        commits('a block\'s energy rounds down', [[2000, 9], 2009, [20000, 10], [QUIET, 7]], [27]),
        commits('the floor is the lowest of the whole blocks', [[5000, 10], [2000, 10], [9000, 10], [20000, 10], [QUIET, 7]], [47]),
        commits('ten blocks back a block still holds the floor', [[1000, 10], [5000, 90], [20000, 10], [QUIET, 7]], [117]),
        commits('an eleventh block pushes the first out of the floor', [[1000, 10], [5000, 100], [20000, 10], [QUIET, 7]], []),
        commits('speech frames need not be in a row', [[QUIET, 10], [SPEECH, 5], [QUIET, 3], [SPEECH, 5], [QUIET, 7]], [30]),
        commits('one speech frame starts a quiet run again', [[QUIET, 10], [SPEECH, 10], [QUIET, 6], SPEECH, [QUIET, 7]], [34]),
        commits('a pause before enough speech is not kept for later', [[QUIET, 10], [SPEECH, 9], [QUIET, 7], SPEECH, [QUIET, 7]], [34]),
        commits('a long silence sends one commit', [[QUIET, 10], [SPEECH, 10], [QUIET, 40]], [27]),
        commits('after a commit nine speech frames send nothing', [[QUIET, 10], [SPEECH, 10], [QUIET, 7], [SPEECH, 9], [QUIET, 7]], [27]),
        commits('after a commit ten speech frames and a pause send the next', [[QUIET, 10], [SPEECH, 10], [QUIET, 7], [SPEECH, 10], [QUIET, 7]], [27, 44]),
        commits('the floor does not start again at a commit', [[2000, 10], [20000, 10], [QUIET, 7], [15000, 10], [QUIET, 7]], [27]),
    ]


def vectors(cases):
    return '[\n' + ',\n'.join('  ' + json.dumps(case, ensure_ascii=False) for case in cases) + '\n]\n'


def save_scenes():
    stamp = '1000:0:r_aaaaaaaaaaaa'

    def page(body, source, mood=None, at=1790812800100, counter=2, actor='srv'):
        return {'t': 'page', 'id': DAY, 'seq': 10,
                'f': {'mood': [mood, stamp], 'energy': [None, stamp], 'source': [source, stamp], 'documentStamp': [{'ms': at, 'counter': counter, 'actor': actor}, stamp]},
                'x': {'body': {'text': body, 'rev': 1, 'merged': False}}}

    def scene(name, body, source, mark, drawn, now, decision, while_page=None, devices=None, day=DAY):
        given = {'action': 'SaveSpoken', 'input': {'day': day, 'body': body, 'source': source, 'mark': mark, 'whilePage': while_page},
                 'records': {'drawn': drawn}, 'ids': [], 'now': now, 'offsetSeconds': 0, 'actor': ACTOR}
        if devices is not None: given['devices'] = devices
        return {'name': name, 'input': given, 'expect': {'decision': decision}}

    def write(changes=(), cmd=None, predict=(), local=(), result=None):
        return {'write': {'gesture': {'changes': list(changes), 'atomic': False, 'hold': False, 'guards': [], 'retire': [], 'cmd': cmd, 'predict': list(predict), 'local': list(local)}, 'result': result}}

    def retired(*fields):
        return [{'op': 'write', 't': 'journalState', 'id': 'journalState', 'f': {field: 'retired' for field in fields}}]

    # A bound save: the command, its prediction and the content clock, then the mark, in the order of their keys.
    def saved(body, source, mood, at, mark, changes, day=DAY):
        clock = {'ms': at, 'counter': 0, 'actor': ACTOR}
        return write(changes=changes,
                     cmd={'name': 'journal.savePage', 'args': {'day': day, 'body': body, 'mood': mood, 'energy': None, 'source': source, 'stamp': clock}},
                     predict=[{'op': 'write', 't': 'page', 'id': day, 'f': {'mood': mood, 'energy': None, 'source': source, 'documentStamp': clock}, 'x': {'body': {'text': body, 'from': None}}}],
                     local=[{'key': 'contentClock', 'value': {'ms': at, 'counter': 0}}, {'key': 'talkTake', 'value': mark}])

    before, first, both = 'Up early.\n', 'Walked to the river.', 'Walked to the river. Cold water.'
    one = placed(before, [first])
    whole = placed(before, [both])
    pressed = mark_of(before, [], [NOON])
    settled = mark_of(before, [first], [NOON + 3900])
    bridged = mark_of(before, [first], [NOON + 4450, NOON + 4500])
    claim = {'day': DAY, 'claimId': 'claim01', 'base': {'body': 'Local', 'mood': None, 'energy': None, 'source': 'typed'},
             'latest': {'body': 'Local', 'mood': None, 'energy': None, 'source': 'typed'}, 'touched': [],
             'retirements': {'placeholder': 'retired', 'privacyLine': 'retired', 'firstPage': 'retired'}, 'claimResult': None, 'refusal': None}
    claimed = placed('Local', [first])
    large = 'a' * 131051 + '\n\n' + first
    return [
        scene('the press writes the mark alone', None, 'spoken', pressed, [page(before, 'typed', 7)], NOON,
              write(local=[{'key': 'talkTake', 'value': pressed}])),
        scene('the first settled turn saves the page as spoken with its mark', one, 'spoken', settled, [page(before, 'typed', 7)], NOON + 3900,
              saved(one, 'spoken', 7, NOON + 3900, settled, retired('placeholder', 'privacyLine', 'firstPage', 'scales'))),
        scene('spoken words on a day with no page create it', first, 'spoken', mark_of('', [first], [NOON + 3900]), [], NOON + 3900,
              saved(first, 'spoken', None, NOON + 3900, mark_of('', [first], [NOON + 3900]), retired('placeholder', 'privacyLine', 'firstPage'))),
        scene('a bridge adds its session to the mark alone', None, 'spoken', bridged, [page(one, 'spoken', 7, NOON + 3900, 0, ACTOR)], NOON + 4500,
              write(local=[{'key': 'talkTake', 'value': bridged}])),
        scene('the last save writes the page and clears the mark', whole, 'spoken', None, [page(one, 'spoken', 7, NOON + 3900, 0, ACTOR)], NOON + 6800,
              saved(whole, 'spoken', 7, NOON + 6800, None, retired('placeholder', 'privacyLine', 'firstPage', 'scales'))),
        scene('the mark is cleared alone', None, 'spoken', None, [page(one, 'spoken', 7, NOON + 3900, 0, ACTOR)], NOON + 6800,
              write(local=[{'key': 'talkTake', 'value': None}])),
        scene('a day that is no longer today is refused and nothing is written', one, 'spoken', settled, [], NOON + 86400000,
              {'refuse': {'invalid': {'rule': 'journal.day', 'path': 'day', 'reason': 'custom', 'custom': 'readOnlyDay'}}}),
        scene('a page over 131,072 bytes is refused and nothing is written', large, 'spoken', mark_of('a' * 131051, [first], [NOON + 3900]), [], NOON + 3900,
              {'refuse': {'invalid': {'rule': 'journal.savePage.body', 'path': 'body', 'reason': 'tooLong', 'max': 131072, 'unit': 'bytes', 'measured': 131073}}}),
        scene('a bound day with a pending claim keeps the words in its claim, with the mark', claimed, 'spoken', mark_of('Local', [first], [NOON + 3900]), [], NOON + 3900,
              write(local=[{'key': 'pendingClaim:claim01', 'value': dict(claim, latest={'body': claimed, 'mood': None, 'energy': None, 'source': 'spoken'}, touched=['body', 'source'])},
                           {'key': 'talkTake', 'value': mark_of('Local', [first], [NOON + 3900])}], result='claim01'),
              devices={'pendingClaim:claim01': claim}),
        scene('a guarded save writes while the page has the digest', whole, 'spoken', None, [page(one, 'spoken', 7, NOON + 3900, 0, ACTOR)], NOON + 60000,
              saved(whole, 'spoken', 7, NOON + 60000, None, retired('placeholder', 'privacyLine', 'firstPage', 'scales')), while_page=digest(one)),
        scene('a guarded save changes nothing once the page has changed', whole, 'spoken', None, [page(one + ' And home.', 'spoken', 7, NOON + 30000, 0, ACTOR)], NOON + 60000,
              {'unchanged': {'result': None}}, while_page=digest(one)),
        scene('Undo saves the page and its source as they were and clears the mark', before, 'typed', None, [page(whole, 'spoken', 7, NOON + 6800, 0, ACTOR)], NOON + 9000,
              saved(before, 'typed', 7, NOON + 9000, None, retired('placeholder', 'privacyLine', 'firstPage', 'scales')), while_page=digest(whole)),
        scene('Undo on a day that had no page removes it', '', 'typed', None, [page(first, 'spoken', None, NOON + 6800, 0, ACTOR)], NOON + 9000,
              saved('', 'typed', None, NOON + 9000, None, []), while_page=digest(first)),
    ]


TAKE_MAX, END_WAIT, BRIDGE_WAIT, BRIDGE_RETRY, RESULT_POLL, RECOVER_FOR = 600000, 15000, 10000, 2000, 5000, 600000
COMMIT, END = {'type': 'commit'}, {'type': 'end'}
MIC_OPEN, MIC_CLOSED = {'microphone': 'open'}, {'microphone': 'closed'}
KEEP = object()
FIRST = 'Walked to the river.'


class U(str):
    """Words shown and not saved."""


def audio(first, last):
    return {'audio': [first, last]}


def door(call):
    return {'open': call}


def shut(call):
    return {'close': call}


def read(call):
    return {'read': call}


def started(call):
    return dict(WIRE['liveEvents'][0], callId=call)


def text(turn, delta):
    return {'type': 'text', 'turn': turn, 'delta': delta}


def turn(number, words):
    return {'type': 'turn', 'turn': number, 'text': words}


# A session's last message: the fixture's, with these words.
def last(key, words):
    return dict(copy.deepcopy(WIRE['liveTerminals'][key]), text=words)


# A first message that refuses. A code the live fixtures do not hold yet takes their shape and the public refusal's allowance.
def refusal(code):
    if code in WIRE['liveFirstFailures']: return copy.deepcopy(WIRE['liveFirstFailures'][code])
    public = next(entry['body'] for entry in WIRE['refusals'] if entry['body']['code'] == code)
    return {'type': 'failed', 'code': code, 'text': '', 'seconds': 0, 'charged': None, 'allowance': copy.deepcopy(public['allowance'])}


def heard(call, message):
    return {'heard': {'callId': call, 'message': message}}


def lost(call):
    return {'lost': {'callId': call}}


def result(call, **answer):
    return {'result': {'callId': call, **answer}}


# One story. Every argument of `step` states what that step's outputs are; what a step does not name stands as the
# step before left it. The methods measure and join: `shown` and `saved` are each session's part, `heard` each
# session's last message, and a step that names `saved`, `heard` or `marked` is a write of the mark.
class Story:
    def __init__(self, name, body=None, source='typed', offset=0, calls=(A,)):
        self.name, self.before, self.calls = name, body or '', list(calls)
        self.given = {'offsetSeconds': offset, 'page': None if body is None else {'body': body, 'source': source}, 'mark': None, 'callIds': list(calls)}
        self.steps, self.end, self.recovered = [], None, None
        self.phase, self.shown, self.parts, self.heard, self.marked, self.mark, self.wake = None, [], [], [], False, None, None
        self.stored, self.source = body, source

    def step(self, at, given, phase=None, do=(), send=(), shown=None, saved=None, source=None, heard=None, marked=None, stored=KEEP, wake=KEEP):
        if phase is not None: self.phase = phase
        if shown is not None: self.shown = shown
        if source is not None: self.source = source
        if saved is not None: self.parts, self.stored = saved, placed(self.before, saved) or None
        if stored is not KEEP: self.stored = stored
        if heard is not None: self.heard = heard
        if marked is not None: self.marked = marked
        if saved is not None or heard is not None or marked is not None:
            self.mark = mark_of(self.before, self.parts, self.heard, self.calls, self.stored or '') if self.marked else None
        if wake is not KEEP: self.wake = wake
        self.steps.append({'at': at, 'in': given, 'out': {
            'phase': self.phase, 'do': list(do), 'send': list(send), 'page': self.steps[-1]['out']['page'] if 'changed' in given else self.page(),
            'saved': None if self.stored is None else {'body': self.stored, 'source': self.source},
            'mark': copy.deepcopy(self.mark), 'wakeAt': self.wake}})

    # What is shown: the stored page once a recovery reads it, and before that the page with every word of the take.
    def page(self):
        if self.phase in ('recovering', 'recovered'): return {'text': self.stored or '', 'unsettled': []}
        runs = [run for part in self.shown for run in part if run]
        if not runs: return {'text': self.before, 'unsettled': []}
        head = head_of(self.before)
        words, ranges = head + '\n\n' if head else '', []
        for index, run in enumerate(runs):
            if index: words += ' '
            if isinstance(run, U): ranges.append([utf16(words), utf16(words) + utf16(run)])
            words += run
        return {'text': words, 'unsettled': ranges}

    def ends(self, cause, code=None, heard=True, turns=0, forced=0, bridges=0):
        self.end = {'cause': cause, 'code': code, 'heard': heard, 'turns': turns, 'forcedTurns': forced, 'bridges': bridges}

    def recovers(self, cause='recovered', answered=0):
        self.recovered = {'cause': cause, 'answered': answered}

    def document(self):
        return {'format': 'journal-take/v1', 'name': self.name, 'given': self.given, 'steps': self.steps, 'end': self.end, 'recovered': self.recovered}


def pressed(name, body='Up early.\n', calls=(A,), at=NOON, **given):
    story = Story(name, body, calls=calls, **given)
    story.step(at, {'press': True}, phase='connecting', do=[door(A)], heard=[at], marked=True, wake=at + TAKE_MAX)
    return story


def opening(name, body='Up early.\n', calls=(A,), at=NOON, **given):
    story = pressed(name, body, calls, at, **given)
    story.step(at + 400, heard(A, started(A)), phase='listening', do=[MIC_OPEN])
    return story


# A quiet second, twelve frames of speech and a pause, then the turn's words and its final text.
def first_turn(story, at=NOON + 500):
    story.step(at, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(1, 29), COMMIT])
    story.step(at + 2900, heard(A, text(1, 'Walked to the river')), shown=[[U('Walked to the river')]])
    story.step(at + 3400, heard(A, turn(1, FIRST)), shown=[[FIRST]], saved=[FIRST], source='spoken', heard=[at + 3400])


# Speech under way and a second turn's first word.
def second_words(story, at=NOON + 4000):
    story.step(at, {'frames': [[SPEECH, 5]]}, send=[audio(30, 34)])
    story.step(at + 450, heard(A, text(2, 'Cold')), shown=[[FIRST, U('Cold')]])


def two_commits(story, at=NOON + 500):
    story.step(at, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7], [SPEECH, 11], [QUIET, 7]]}, send=[audio(1, 29), COMMIT, audio(30, 47), COMMIT])


def open_stories():
    T, out = NOON, []
    s = opening('open-and-end')
    s.step(T + 500, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(1, 29), COMMIT])
    s.step(T + 3400, heard(A, text(1, 'Walked to')), shown=[[U('Walked to')]])
    s.step(T + 3500, heard(A, text(1, ' the river')), shown=[[U('Walked to the river')]])
    s.step(T + 3900, heard(A, turn(1, FIRST)), shown=[[FIRST]], saved=[FIRST], source='spoken', heard=[T + 3900])
    s.step(T + 4000, {'frames': [[SPEECH, 11], [QUIET, 7]]}, send=[audio(30, 47), COMMIT])
    s.step(T + 5800, heard(A, text(2, 'Cold')), shown=[[FIRST, U('Cold')]])
    s.step(T + 6000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 6000 + END_WAIT)
    s.step(T + 6800, heard(A, last('completed', FIRST + ' Cold water.')), phase='ended', shown=[[FIRST + ' Cold water.']], saved=[FIRST + ' Cold water.'], marked=False, wake=None)
    s.ends('person', turns=2); out.append(s)

    s = pressed('open-refused')
    s.step(T + 300, heard(A, refusal('funding_required')), phase='ended', marked=False, wake=None)
    s.ends('refused', 'funding_required', heard=False); out.append(s)

    s = pressed('open-provider-unavailable')
    s.step(T + 10300, heard(A, last('provider_unavailable', '')), phase='ended', marked=False, wake=None)
    s.ends('refused', 'provider_unavailable', heard=False); out.append(s)

    s = pressed('open-unopened')
    s.step(T + 300, {'unopened': {'callId': A, 'code': 'offline'}}, phase='ended', marked=False, wake=None)
    s.ends('refused', 'offline', heard=False); out.append(s)

    s = pressed('open-lost')
    s.step(T + 2300, lost(A), phase='ended', marked=False, wake=None)
    s.ends('refused', heard=False); out.append(s)

    s = Story('open-near-day-end', 'Up early.\n', calls=())
    s.step(T + 43200000 - END_WAIT, {'press': True}, phase='ended')
    s.ends('dayEnd', heard=False); out.append(s)

    s = pressed('end-while-connecting')
    s.step(T + 200, {'end': True}, phase='ended', do=[shut(A)], marked=False, wake=None)
    s.ends('person', heard=False); out.append(s)
    return out


def word_stories():
    T, out = NOON, []
    s = opening('open-empty-page', None)
    s.step(T + 500, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(1, 29), COMMIT])
    s.step(T + 3900, heard(A, turn(1, 'Slept well.')), shown=[['Slept well.']], saved=['Slept well.'], source='spoken', heard=[T + 3900])
    out.append(s)

    s = opening('page-trailing-whitespace', 'Up early.\u0085 \u00a0\n')
    s.step(T + 500, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(1, 29), COMMIT])
    s.step(T + 3900, heard(A, turn(1, FIRST)), shown=[[FIRST]], saved=[FIRST], source='spoken', heard=[T + 3900])
    out.append(s)

    s = opening('turn-out-of-order'); two_commits(s)
    s.step(T + 5300, heard(A, text(1, 'Rain all')), shown=[[U('Rain all')]])
    s.step(T + 5400, heard(A, text(2, 'Tea first')), shown=[[U('Rain all'), U('Tea first')]])
    s.step(T + 5600, heard(A, turn(2, 'Tea first.')), shown=[[U('Rain all'), 'Tea first.']], saved=['Tea first.'], source='spoken', heard=[T + 5600])
    s.step(T + 5900, heard(A, turn(1, 'Rain all morning.')), shown=[['Rain all morning.', 'Tea first.']], saved=['Rain all morning. Tea first.'], heard=[T + 5900])
    out.append(s)

    s = opening('turn-empty')
    s.step(T + 500, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(1, 29), COMMIT])
    s.step(T + 3900, heard(A, turn(1, '')), heard=[T + 3900])
    s.step(T + 4000, {'frames': [[SPEECH, 11], [QUIET, 7]]}, send=[audio(30, 47), COMMIT])
    s.step(T + 5800, heard(A, text(2, 'Tea first')), shown=[[U('Tea first')]])
    s.step(T + 6100, heard(A, turn(2, 'Tea first.')), shown=[['Tea first.']], saved=['Tea first.'], source='spoken', heard=[T + 6100])
    out.append(s)

    long = 'Kept talking without a pause.'
    s = opening('turn-forced')
    s.step(T + 500, {'frames': [[QUIET, 10], [SPEECH, 30]]}, send=[audio(1, 40)])
    s.step(T + 4600, heard(A, text(1, 'Kept talking')), shown=[[U('Kept talking')]])
    s.step(T + 60500, heard(A, turn(1, long)), shown=[[long]], saved=[long], source='spoken', heard=[T + 60500])
    s.step(T + 60600, heard(A, text(2, 'And on')), shown=[[long, U('And on')]])
    s.step(T + 61000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 61000 + END_WAIT)
    s.step(T + 61700, heard(A, last('completed', long + ' And on.')), phase='ended', shown=[[long + ' And on.']], saved=[long + ' And on.'], marked=False, wake=None)
    s.ends('person', turns=2, forced=1); out.append(s)

    s = opening('delta-after-settled'); first_turn(s)
    s.step(T + 4000, heard(A, text(1, ' again')))
    out.append(s)

    s = opening('turn-unseen'); two_commits(s)
    s.step(T + 5300, heard(A, turn(2, 'Tea first.')), shown=[['Tea first.']], saved=['Tea first.'], source='spoken', heard=[T + 5300])
    s.step(T + 5400, heard(A, text(4, 'Later')), shown=[['Tea first.', U('Later')]])
    s.step(T + 5600, heard(A, turn(1, 'Rain all morning.')), shown=[['Rain all morning.', 'Tea first.', U('Later')]], saved=['Rain all morning. Tea first.'], heard=[T + 5600])
    out.append(s)

    whole = 'Walked down to the river. Cold water today.'
    s = opening('ended-text-replaces-part'); first_turn(s)
    s.step(T + 4000, {'frames': [[SPEECH, 11], [QUIET, 7]]}, send=[audio(30, 47), COMMIT])
    s.step(T + 5800, heard(A, text(2, 'Cold')), shown=[[FIRST, U('Cold')]])
    s.step(T + 6000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 6000 + END_WAIT)
    s.step(T + 6800, heard(A, last('completed', whole)), phase='ended', shown=[[whole]], saved=[whole], marked=False, wake=None)
    s.ends('person', turns=2); out.append(s)

    s = opening('multibyte', 'Déjà vu.\n'); two_commits(s)
    s.step(T + 5300, heard(A, text(1, 'Thé 🍵')), shown=[[U('Thé 🍵')]])
    s.step(T + 5600, heard(A, turn(1, 'Thé 🍵 chaud.')), shown=[['Thé 🍵 chaud.']], saved=['Thé 🍵 chaud.'], source='spoken', heard=[T + 5600])
    s.step(T + 5800, heard(A, text(2, 'Ça va')), shown=[['Thé 🍵 chaud.', U('Ça va')]])
    out.append(s)

    s = opening('page-full', 'a' * 131069)
    s.step(T + 3900, heard(A, turn(1, 'b')), shown=[['b']], saved=['b'], source='spoken', heard=[T + 3900])
    s.step(T + 5600, heard(A, turn(2, 'c')), phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 5600 + END_WAIT)
    s.step(T + 6300, heard(A, last('completed', 'b c')), phase='ended', marked=False, wake=None)
    s.ends('pageFull', turns=2, forced=1); out.append(s)

    s = Story('open-page-full', 'a' * 131070, calls=())
    s.step(T, {'press': True}, phase='ended')
    s.ends('pageFull', heard=False); out.append(s)

    laptop = 'Up early.\n\nFrom the laptop.'
    s = opening('other-device-meanwhile'); first_turn(s)
    s.step(T + 4000, {'changed': {'body': laptop, 'source': 'typed'}}, stored=laptop, source='typed')
    s.step(T + 4100, {'frames': [[SPEECH, 11], [QUIET, 7]]}, send=[audio(30, 47), COMMIT])
    s.step(T + 5900, heard(A, turn(2, 'Cold water.')), shown=[[FIRST, 'Cold water.']], saved=[FIRST + ' Cold water.'], source='spoken', heard=[T + 5900])
    out.append(s)
    return out


# A take the person ends whose `ended` never comes: its last words are saved as they arrived and its mark stays.
def unsettled_end(name):
    T = NOON
    s = opening(name); first_turn(s)
    s.step(T + 4000, {'frames': [[SPEECH, 11], [QUIET, 7]]}, send=[audio(30, 47), COMMIT])
    s.step(T + 5800, heard(A, text(2, 'Cold water')), shown=[[FIRST, U('Cold water')]])
    s.step(T + 6000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 6000 + END_WAIT)
    s.step(T + 21000, {'clock': True}, phase='ended', do=[shut(A)], shown=[[FIRST + ' Cold water']], saved=[FIRST + ' Cold water'], heard=[T + 5800], wake=None)
    s.ends('person', heard=False, turns=2)
    return s


# A take the person ends after one settled turn, whose `ended` comes.
def ended_take(name):
    T = NOON
    s = opening(name); first_turn(s)
    s.step(T + 4000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 4000 + END_WAIT)
    s.step(T + 4700, heard(A, last('completed', FIRST)), phase='ended', marked=False, wake=None)
    s.ends('person', turns=1)
    return s


def end_stories():
    T, out = NOON, []
    s = opening('end-at-take-max'); first_turn(s)
    s.step(T + TAKE_MAX, {'clock': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + TAKE_MAX + END_WAIT)
    s.step(T + TAKE_MAX + 700, heard(A, last('completed', FIRST)), phase='ended', marked=False, wake=None)
    s.ends('limit', turns=1); out.append(s)

    # 23:50 where the phone is, two hours behind UTC: the day in the mark is the phone's.
    press = T + 49800000
    midnight = press + 600000
    s = Story('end-before-day-end', 'Up early.\n', offset=-7200)
    s.step(press, {'press': True}, phase='connecting', do=[door(A)], heard=[press], marked=True, wake=midnight - END_WAIT)
    s.step(press + 400, heard(A, started(A)), phase='listening', do=[MIC_OPEN])
    s.step(press + 500, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(1, 29), COMMIT])
    s.step(press + 3400, heard(A, text(1, 'Late walk')), shown=[[U('Late walk')]])
    s.step(midnight - END_WAIT, {'clock': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=midnight - 1)
    s.step(midnight - 1, {'clock': True}, phase='ended', do=[shut(A)], shown=[['Late walk']], saved=['Late walk'], source='spoken', heard=[press + 3400], wake=None)
    s.ends('dayEnd', heard=False, turns=1)
    s.step(midnight + 1000, {'recover': True}, phase='recovered', marked=False)
    s.recovers('dropped'); out.append(s)

    s = opening('end-background'); first_turn(s)
    s.step(T + 4000, {'frames': [[SPEECH, 5]]}, send=[audio(30, 34)])
    s.step(T + 4500, {'background': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 4500 + END_WAIT)
    s.step(T + 4600, {'frames': [[SPEECH, 3]]})
    s.step(T + 5200, heard(A, last('completed', FIRST)), phase='ended', marked=False, wake=None)
    s.ends('background', turns=1); out.append(s)

    for name, given, cause in [('end-microphone-taken', 'microphoneTaken', 'microphone'), ('end-capture-failed', 'captureFailed', 'capture')]:
        s = opening(name); first_turn(s)
        s.step(T + 4000, {given: True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 4000 + END_WAIT)
        s.step(T + 4700, heard(A, last('completed', FIRST)), phase='ended', marked=False, wake=None)
        s.ends(cause, turns=1); out.append(s)

    out.append(unsettled_end('end-no-ended'))

    s = opening('end-lost'); first_turn(s)
    s.step(T + 4000, {'frames': [[SPEECH, 11], [QUIET, 7]]}, send=[audio(30, 47), COMMIT])
    s.step(T + 5800, heard(A, text(2, 'Cold water')), shown=[[FIRST, U('Cold water')]])
    s.step(T + 6000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 6000 + END_WAIT)
    s.step(T + 6500, lost(A), phase='ended', shown=[[FIRST + ' Cold water']], saved=[FIRST + ' Cold water'], heard=[T + 5800], wake=None)
    s.ends('person', heard=False, turns=2); out.append(s)

    s = ended_take('end-undo')
    s.step(T + 9000, {'undo': True}, shown=[[]], saved=[], source='typed')
    s.step(T + 9500, {'undo': True})
    out.append(s)

    s = unsettled_end('end-undo-mark-standing')
    s.step(T + 25000, {'undo': True}, shown=[[]], saved=[], source='typed', marked=False)
    out.append(s)

    typed = placed('Up early.\n', [FIRST]) + ' And home.'
    s = ended_take('end-undo-after-typing')
    s.step(T + 9000, {'changed': {'body': typed, 'source': 'spoken'}}, stored=typed)
    s.step(T + 12000, {'undo': True})
    out.append(s)

    for name, key, at in [('cut-idle', 'idle', T + 184000), ('cut-funding-required', 'funding_required', T + 60000), ('cut-paused', 'paused', T + 9000),
                          ('cut-restarting', 'restarting', T + 9000), ('cut-unnamed', 'session_limit', T + 9000),
                          ('failed-accounting-unavailable', 'accounting_unavailable', T + 60000), ('failed-invalid-request', 'invalid_request', T + 9000)]:
        s = opening(name); first_turn(s)
        s.step(at, heard(A, last(key, FIRST)), phase='ended', do=[MIC_CLOSED], marked=False, wake=None)
        s.ends('service', key, turns=1); out.append(s)

    s = opening('cut-subject-exhausted'); first_turn(s); second_words(s)
    s.step(T + 60000, heard(A, last('subject_exhausted', FIRST + ' Cold water.')), phase='ended', do=[MIC_CLOSED], shown=[[FIRST + ' Cold water.']], saved=[FIRST + ' Cold water.'], marked=False, wake=None)
    s.ends('service', 'subject_exhausted', turns=2); out.append(s)

    s = opening('defect-unreadable'); first_turn(s); second_words(s)
    s.step(T + 4500, {'unreadable': {'callId': A}}, phase='ended', do=[MIC_CLOSED, shut(A)], shown=[[FIRST + ' Cold']], saved=[FIRST + ' Cold'], heard=[T + 4450], wake=None)
    s.ends('defect', heard=False, turns=2); out.append(s)

    s = opening('defect-started-twice')
    s.step(T + 600, heard(A, started(A)), phase='ended', do=[MIC_CLOSED, shut(A)], heard=[T + 600], wake=None)
    s.ends('defect', heard=False); out.append(s)
    return out


# A take with one settled turn and a second begun, whose connection is then lost.
def bridged(name, calls=(A, B)):
    T = NOON
    s = opening(name, calls=calls); first_turn(s); second_words(s)
    s.step(T + 4500, lost(A), phase='bridging', do=[door(B), read(A)], heard=[T + 4450, T + 4500], wake=T + 4500 + BRIDGE_WAIT)
    return s


def bridge_stories():
    T, out = NOON, []
    cold, water = FIRST + ' Cold', FIRST + ' Cold water.'
    s = bridged('bridge-lost')
    s.step(T + 4600, result(A, code='conflict'), wake=T + 9600)
    s.step(T + 4700, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]})
    s.step(T + 7600, heard(B, started(B)), phase='listening', send=[audio(35, 63), COMMIT])
    s.step(T + 7700, heard(A, text(2, ' water')))
    s.step(T + 7800, {'frames': [[SPEECH, 3]]}, send=[audio(64, 66)])
    s.step(T + 8200, heard(B, text(1, 'Tea first')), shown=[[FIRST, U('Cold')], [U('Tea first')]])
    s.step(T + 8500, heard(B, turn(1, 'Tea first.')), shown=[[FIRST, U('Cold')], ['Tea first.']], saved=[FIRST, 'Tea first.'], heard=[T + 4450, T + 8500])
    out.append(s)

    s = opening('bridge-provider-failed', calls=(A, B)); first_turn(s); second_words(s)
    s.step(T + 4500, heard(A, last('provider_failed', cold)), phase='bridging', do=[door(B)], shown=[[cold], []], saved=[cold], heard=[T + 4500, T + 4500], wake=T + 4500 + BRIDGE_WAIT)
    s.step(T + 5200, heard(B, started(B)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 5300, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7]]}, send=[audio(35, 63), COMMIT])
    s.step(T + 8600, heard(B, turn(1, 'Tea first.')), shown=[[cold], ['Tea first.']], saved=[cold, 'Tea first.'], heard=[T + 4500, T + 8600])
    s.step(T + 9000, {'end': True}, phase='ending', do=[MIC_CLOSED], send=[END], wake=T + 9000 + END_WAIT)
    s.step(T + 9600, heard(B, last('completed', 'Tea first.')), phase='ended', marked=False, wake=None)
    s.ends('person', turns=3, bridges=1); out.append(s)

    s = bridged('bridge-pause-in-kept')
    s.step(T + 4550, result(A, code='conflict'), wake=T + 9550)
    s.step(T + 4600, {'frames': [[QUIET, 10], [SPEECH, 12], [QUIET, 7], [SPEECH, 11], [QUIET, 7]]})
    s.step(T + 9300, heard(B, started(B)), phase='listening', send=[audio(35, 63), COMMIT, audio(64, 81), COMMIT])
    out.append(s)

    s = bridged('bridge-concurrency-retry')
    s.step(T + 4600, result(A, code='conflict'), wake=T + 9600)
    s.step(T + 4800, heard(B, refusal('concurrency_exhausted')), wake=T + 4800 + BRIDGE_RETRY)
    s.step(T + 4900, {'frames': [[QUIET, 10]]})
    s.step(T + 6800, {'clock': True}, do=[door(B)], wake=T + 9600)
    s.step(T + 7000, heard(B, refusal('concurrency_exhausted')), wake=T + 7000 + BRIDGE_RETRY)
    s.step(T + 9000, {'clock': True}, do=[door(B)], wake=T + 9600)
    s.step(T + 9400, heard(B, started(B)), phase='listening', send=[audio(35, 44)])
    out.append(s)

    s = bridged('bridge-retry-past-wait')
    s.step(T + 13000, heard(B, refusal('concurrency_exhausted')))
    s.step(T + 14500, {'clock': True}, phase='ended', do=[MIC_CLOSED], shown=[[cold], []], saved=[cold], heard=[T + 4450, T + 13000], wake=None)
    s.ends('bridge', heard=False, turns=2, bridges=1); out.append(s)

    s = bridged('bridge-ended-meanwhile')
    s.step(T + 4600, result(A, code='conflict'), wake=T + 9600)
    s.step(T + 4700, {'frames': [[QUIET, 10], [SPEECH, 12]]})
    s.step(T + 6900, {'end': True}, phase='ending', do=[MIC_CLOSED])
    s.step(T + 7500, heard(B, started(B)), send=[audio(35, 56), END])
    s.step(T + 8300, heard(B, last('completed', 'Tea first.')), phase='ended', shown=[[cold], ['Tea first.']], saved=[cold, 'Tea first.'], heard=[T + 4450, T + 8300], wake=None)
    s.ends('person', turns=2, bridges=1)
    s.step(T + 8400, {'recover': True}, phase='recovering', do=[read(A), read(B)], wake=T + 4450 + RECOVER_FOR)
    s.step(T + 8600, result(B, message=last('completed', 'Tea first.')))
    s.step(T + 8700, result(A, message=last('went_away', water)), phase='recovered', saved=[water, 'Tea first.'], marked=False, wake=None)
    s.recovers(answered=2); out.append(s)

    s = bridged('bridge-no-started')
    s.step(T + 4600, result(A, code='conflict'), wake=T + 9600)
    s.step(T + 4700, {'frames': [[QUIET, 10]]})
    s.step(T + 9600, {'clock': True}, do=[read(A)], wake=T + 14500)
    s.step(T + 9700, result(A, code='conflict'))
    s.step(T + 14500, {'clock': True}, phase='ended', do=[MIC_CLOSED, shut(B)], shown=[[cold], []], saved=[cold], heard=[T + 4450, T + 4500], wake=None)
    s.ends('bridge', heard=False, turns=2, bridges=1); out.append(s)

    s = bridged('bridge-refused')
    s.step(T + 4800, heard(B, refusal('accounting_unavailable')), phase='ended', do=[MIC_CLOSED], shown=[[cold], []], saved=[cold], heard=[T + 4450, T + 4800], wake=None)
    s.ends('bridge', 'accounting_unavailable', heard=False, turns=2, bridges=1); out.append(s)

    s = bridged('bridge-result-replaces')
    s.step(T + 5000, heard(B, started(B)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 5100, result(A, code='conflict'), wake=T + 10100)
    s.step(T + 10100, {'clock': True}, do=[read(A)], wake=T + TAKE_MAX)
    s.step(T + 10200, result(A, message=last('went_away', water)), shown=[[water], []], saved=[water], heard=[T + 4450, T + 5000])
    out.append(s)

    s = bridged('bridge-result-gone')
    s.step(T + 5000, heard(B, started(B)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 5100, result(A, code='result_gone'), wake=T + 10100)
    s.step(T + 10100, {'clock': True}, do=[read(A)], wake=T + TAKE_MAX)
    s.step(T + 10200, result(A, code='result_gone'), shown=[[cold], []], saved=[cold], heard=[T + 4450, T + 5000])
    out.append(s)

    s = bridged('bridge-result-unknown')
    s.step(T + 5000, heard(B, started(B)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 5100, result(A, code='call_unknown'), shown=[[cold], []], saved=[cold], heard=[T + 4450, T + 5000])
    out.append(s)

    s = bridged('bridge-lost-again', calls=(A, B, C))
    s.step(T + 5000, lost(B), do=[door(C), read(B)], heard=[T + 4450, T + 4500, T + 5000])
    s.step(T + 5600, heard(C, started(C)), phase='listening', wake=T + TAKE_MAX)
    out.append(s)

    s = opening('bridge-max', calls=(A, B, C, D)); first_turn(s)
    s.step(T + 4000, lost(A), phase='bridging', do=[door(B), read(A)], heard=[T + 3900, T + 4000], wake=T + 4000 + BRIDGE_WAIT)
    s.step(T + 4300, heard(B, started(B)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 4600, lost(B), phase='bridging', do=[door(C), read(B)], heard=[T + 3900, T + 4300, T + 4600], wake=T + 4600 + BRIDGE_WAIT)
    s.step(T + 4900, heard(C, started(C)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 5200, lost(C), phase='bridging', do=[door(D), read(C)], heard=[T + 3900, T + 4300, T + 4900, T + 5200], wake=T + 5200 + BRIDGE_WAIT)
    s.step(T + 5500, heard(D, started(D)), phase='listening', wake=T + TAKE_MAX)
    s.step(T + 5800, lost(D), phase='ended', do=[MIC_CLOSED], heard=[T + 3900, T + 4300, T + 4900, T + 5500], wake=None)
    s.ends('bridge', heard=False, turns=1, bridges=3); out.append(s)
    return out


def story_text(story):
    line = lambda value: json.dumps(value, ensure_ascii=False)
    lines = ['{', f'  "format": {line(story["format"])},', f'  "name": {line(story["name"])},', f'  "given": {line(story["given"])},', '  "steps": [']
    for index, step in enumerate(story['steps']):
        out = step['out']
        lines += [f'    {{"at": {step["at"]}, "in": {line(step["in"])},',
                  f'     "out": {{"phase": {line(out["phase"])}, "do": {line(out["do"])}, "send": {line(out["send"])},',
                  f'             "page": {line(out["page"])},',
                  f'             "saved": {line(out["saved"])},',
                  f'             "mark": {line(out["mark"])},',
                  f'             "wakeAt": {line(out["wakeAt"])}}}}}' + (',' if index + 1 < len(story['steps']) else '')]
    lines += ['  ],', f'  "end": {line(story["end"])},', f'  "recovered": {line(story["recovered"])}', '}']
    written = '\n'.join(lines) + '\n'
    if json.loads(written) != story: raise ValueError(story['name'] + ': the story does not read back as written')
    return written


def documents():
    stories = [story.document() for story in open_stories() + word_stories() + end_stories() + bridge_stories()]
    if len({story['name'] for story in stories}) != len(stories): raise ValueError('story names repeat')
    return {'pauses.json': vectors(pause_cases()), 'saves.json': vectors(save_scenes()),
            **{'takes/' + story['name'] + '.json': story_text(story) for story in stories}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    written = documents()
    on_disk = {str(path.relative_to(ROOT)) for path in ROOT.rglob('*.json')}
    if args.check:
        if set(written) != on_disk: raise ValueError('story file set differs: ' + ', '.join(sorted(set(written) ^ on_disk)))
        for name, document in written.items():
            if (ROOT / name).read_text() != document: raise ValueError(name + ': stale story')
        print(f'{len(written)} Talk story files match their declarations')
    else:
        for name in on_disk - set(written): (ROOT / name).unlink()
        for name, document in written.items(): (ROOT / name).write_text(document)
