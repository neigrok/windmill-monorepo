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


def documents():
    return {'pauses.json': vectors(pause_cases()), 'saves.json': vectors(save_scenes())}


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
