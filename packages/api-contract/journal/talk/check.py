#!/usr/bin/env python3
# Holds Talk's stories to the specification by a second derivation: nothing here reads generate.py.
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time

ROOT = Path(__file__).parent
CONTRACT = ROOT.parent.parent
spec = importlib.util.spec_from_file_location('ai_wire', CONTRACT / 'ai' / 'check.py')
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)

SAMPLES, PAUSE, MIN_TURN, SPEECH_MIN = 2400, 7, 10, 10737
PAGE_MAX = 131072
# ECMAScript's WhiteSpace and LineTerminator, as the journal corpus trims: U+0085 is content.
WHITESPACE = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
# The mark's value as the Talk contract's §2 gives it. It stands in for the registry's `talkTake` row only until
# sync/journal.registry.json holds that row; then the row is what a mark is held to, and this goes.
CONTRACT_MARK = {
    'type': 'object', 'required': ['day', 'bytesBefore', 'pageDigest', 'sessions'],
    'properties': {
        'day': {'type': 'string', 'pattern': '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'},
        'bytesBefore': {'type': 'number', 'integer': True, 'min': 0, 'max': 131072},
        'pageDigest': {'type': 'string', 'pattern': '^[0-9a-f]{16}$'},
        'sessions': {'type': 'array', 'maxItems': 4, 'items': {
            'type': 'object', 'required': ['callId', 'bytesSaved', 'heardAt'],
            'properties': {
                'callId': {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{22}$'},
                'bytesSaved': {'type': 'number', 'integer': True, 'min': 0, 'max': 131072},
                'heardAt': {'type': 'number', 'integer': True, 'min': 0, 'max': 9007199254740991},
            }}},
    },
}

# Each clause of docs/foundation/journal-talk.md and the stories that pin it. A clause with no story, a story no
# clause names and a name that is not a story each fail the check.
PINS = {
    'pauses.json': {
        '§5.2 energy': ['a frame of silence has no energy', 'a full-scale frame has an energy of 1,073,741,824',
                        'a sum of squares of 2,399 rounds down to nothing', 'a sum of squares of 2,400 is an energy of one'],
        '§11 SPEECH_MIN': ['a frame of amplitude 103 stays under SPEECH_MIN', 'a frame of amplitude 104 passes SPEECH_MIN',
                           'an energy of 10,736 is not speech', 'an energy of 10,737 is speech'],
        '§5.2 block': ['a block\'s energy rounds down', 'the floor does not start again at a commit'],
        '§5.2 floor': ['before one whole block the floor is zero', 'a frame is judged against the blocks complete before it',
                       'the floor is the lowest of the whole blocks', 'ten blocks back a block still holds the floor',
                       'an eleventh block pushes the first out of the floor'],
        '§5.2 speech': ['ten times the floor is speech', 'one less than ten times the floor is not speech'],
        '§5.2 commit, PAUSE': ['seven quiet frames after ten of speech send one commit', 'six quiet frames send nothing',
                               'one speech frame starts a quiet run again'],
        '§5.2 commit, MIN_TURN': ['nine speech frames and a pause send nothing', 'speech frames need not be in a row',
                                  'a pause before enough speech is not kept for later'],
        '§5.2 commit, the counts start again': ['a long silence sends one commit', 'after a commit nine speech frames send nothing',
                                                'after a commit ten speech frames and a pause send the next'],
        '§5.2 a sequence too short to decide': ['an empty sequence sends nothing', 'a sequence shorter than a block sends nothing'],
    },
    'saves.json': {
        '§5.1 step 2, the mark at the press': ['the press writes the mark alone'],
        '§5.3 saving': ['the first settled turn saves the page as spoken with its mark', 'spoken words on a day with no page create it'],
        '§5.3 never into another day': ['a day that is no longer today is refused and nothing is written'],
        '§5.3 the page\'s size limit': ['a page over 131,072 bytes is refused and nothing is written'],
        '§5.4 step 2, the mark cleared': ['the last save writes the page and clears the mark', 'the mark is cleared alone'],
        '§5.4 step 4, Undo': ['Undo saves the page and its source as they were and clears the mark', 'Undo on a day that had no page removes it'],
        '§5.5 step 1, the mark at a bridge': ['a bridge adds its session to the mark alone'],
        '§5.6 writes only while the page has the digest': ['a guarded save writes while the page has the digest',
                                                         'a guarded save changes nothing once the page has changed'],
        'domain kit Appendix C, pending edits': ['a bound day with a pending claim keeps the words in its claim, with the mark'],
    },
}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def expand(items):
    require(isinstance(items, list), 'a sequence is a list')
    values = []
    for item in items:
        if isinstance(item, list):
            require(len(item) == 2 and type(item[1]) is int and item[1] > 0, 'a run is [value, count]')
            values += [item[0]] * item[1]
        else:
            values.append(item)
    require(all(type(value) is int for value in values), 'a sequence holds whole numbers')
    return values


# §5.2, in whole numbers.
def energy(samples):
    return sum(sample * sample for sample in samples) // SAMPLES


def commits(energies):
    sent, blocks, quiet, speech = [], [], 0, 0
    for number, value in enumerate(energies, 1):
        floor = min(blocks[-10:], default=0)
        if value >= 10 * floor and value >= SPEECH_MIN:
            speech, quiet = speech + 1, 0
        else:
            quiet += 1
        if quiet == PAUSE and speech >= MIN_TURN:
            sent.append(number)
            quiet = speech = 0
        if number % 10 == 0:
            blocks.append(sum(energies[number - 10:number]) // 10)
    return sent


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def conforms(value, shape, where):
    kind = shape['type']
    if kind == 'object':
        require(isinstance(value, dict) and set(value) == set(shape['properties']) and set(shape['required']) <= set(value), where + ': fields differ')
        for name, inner in shape['properties'].items():
            conforms(value[name], inner, where + '.' + name)
    elif kind == 'array':
        require(isinstance(value, list) and len(value) <= shape['maxItems'], where + ': not a list within its length')
        for item in value:
            conforms(item, shape['items'], where + '[]')
    elif kind == 'number':
        require(type(value) is int and shape['integer'] and shape['min'] <= value <= shape['max'], where + ': not a whole number within its bounds')
    else:
        require(kind == 'string' and isinstance(value, str) and re.fullmatch(shape['pattern'].removeprefix('^').removesuffix('$'), value), where + ': not text of its pattern')


# What a mark is held to, and where that came from.
def mark_shape():
    registry = json.loads((CONTRACT / 'sync' / 'journal.registry.json').read_text())
    row = registry['products']['journal']['device'].get('talkTake')
    if row is None:
        return CONTRACT_MARK, 'the contract\'s shape in check.py, the registry holding no talkTake row yet'
    return row['value'], 'the registry\'s talkTake row'


# D-5 and §5.6: a page with the mark's digest, read by the mark's lengths. Answers each session's part.
def located(body, mark, shape):
    conforms(mark, shape, 'mark')
    require(mark['sessions'], 'a mark names a session')
    require(mark['pageDigest'] == digest(body), 'the mark\'s digest is not the page\'s')
    data, before = body.encode(), mark['bytesBefore']
    lengths = [session['bytesSaved'] for session in mark['sessions']]
    try:
        head, tail = data[:before].decode(), data[before:]
        require(len(data) >= before and head == head.rstrip(WHITESPACE), 'bytesBefore is not the page before the passage, trimmed')
        if not any(lengths):
            require(tail.decode().strip(WHITESPACE) == '', 'a page with no part saved holds more than its text before the take')
            return [''] * len(lengths)
        parts, cursor = [], 2 if before else 0
        require(tail[:cursor] == b'\n\n'[:cursor], 'no blank line before the passage')
        for length in lengths:
            if length and any(parts):
                require(tail[cursor:cursor + 1] == b' ', 'parts are not one space apart')
                cursor += 1
            parts.append(tail[cursor:cursor + length].decode())
            cursor += length
        require(cursor == len(tail) and all(utf8(part) == length for part, length in zip(parts, lengths)), 'the lengths do not cover the passage')
        return parts
    except UnicodeDecodeError:
        raise ValueError('a length cuts a character')


def utf8(text):
    return len(text.encode())


def vectors(document, pins):
    require(isinstance(document, list), 'a vector file is an array')
    names = [case.get('name') for case in document]
    require(len(set(names)) == len(names), 'vector names repeat')
    pinned = [name for clause in pins.values() for name in clause]
    require(all(pins.values()), 'a clause has no story')
    require(set(pinned) == set(names), 'clauses and stories differ: ' + ', '.join(sorted(set(pinned) ^ set(names))))
    for case in document:
        wire.fields(case, 'name input expect')
    return document


def check_pauses(document):
    for case in vectors(document, PINS['pauses.json']):
        given = case['input']
        if given.get('op') == 'PauseRule.energy':
            wire.fields(given, 'op samples')
            samples = expand(given['samples'])
            require(len(samples) == SAMPLES and all(-32768 <= sample <= 32767 for sample in samples), 'a frame is 2,400 16-bit samples')
            require(case['expect'] == {'energy': energy(samples)}, case['name'] + ': the energy differs from §5.2')
        else:
            require(given.get('op') == 'PauseRule.commits', 'unknown pause operation')
            wire.fields(given, 'op energies')
            energies = expand(given['energies'])
            require(all(0 <= value <= 32768 * 32768 for value in energies), 'an energy is a frame\'s')
            require(case['expect'] == {'commits': commits(energies)}, case['name'] + ': the commits differ from §5.2')
    return len(document)


def check_saves(document, shape):
    for case in vectors(document, PINS['saves.json']):
        try:
            scene = case['input']
            wire.fields({key: value for key, value in scene.items() if key != 'devices'}, 'action input records ids now offsetSeconds actor')
            require(scene['action'] == 'SaveSpoken', 'unknown save action')
            given = scene['input']
            wire.fields(given, 'day body source mark whilePage')
            require(given['source'] in {'typed', 'spoken'} and (given['body'] is None or isinstance(given['body'], str)), 'a save holds a body or null, and a source')
            row = next((record for record in scene['records']['drawn'] if record['t'] == 'page' and record['id'] == given['day']), None)
            drawn = row['x']['body']['text'] if row else ''
            if given['mark'] is not None:
                located(drawn if given['body'] is None else given['body'], given['mark'], shape)
            wire.fields(case['expect'], 'decision')
            decision = case['expect']['decision']
            today = time.strftime('%Y-%m-%d', time.gmtime((scene['now'] + scene['offsetSeconds'] * 1000) // 1000))
            if given['whilePage'] is not None and given['whilePage'] != digest(drawn):
                require(decision == {'unchanged': {'result': None}}, 'a guarded save wrote over a page that changed')
            elif given['body'] is not None and given['day'] != today:
                require(decision == {'refuse': {'invalid': {'rule': 'journal.day', 'path': 'day', 'reason': 'custom', 'custom': 'readOnlyDay'}}}, 'a save into another day')
            elif given['body'] is not None and utf8(given['body']) > PAGE_MAX:
                require(decision == {'refuse': {'invalid': {'rule': 'journal.savePage.body', 'path': 'body', 'reason': 'tooLong', 'max': PAGE_MAX, 'unit': 'bytes', 'measured': utf8(given['body'])}}}, 'a page over the limit')
            else:
                wire.fields(decision, 'write')
                wire.fields(decision['write'], 'gesture result')
                gesture = decision['write']['gesture']
                wire.fields(gesture, 'changes atomic hold guards retire cmd predict local')
                keys = [write['key'] for write in gesture['local']]
                require(keys == sorted(keys, key=str.encode) and gesture['local'][-1] == {'key': 'talkTake', 'value': given['mark']}, 'the mark is not written with the save')
                if given['body'] is None:
                    require(gesture['cmd'] is None and gesture['predict'] == [] and keys == ['talkTake'], 'the mark alone wrote more than the mark')
                elif gesture['cmd'] is not None:
                    args, hasText = gesture['cmd']['args'], given['body'].strip(WHITESPACE) != ''
                    require(gesture['cmd']['name'] == 'journal.savePage' and args['day'] == given['day'] and args['body'] == given['body'], 'the command saves another page')
                    require(args['source'] == (given['source'] if hasText else 'typed'), 'the command saves another source')
                    require(gesture['predict'][0]['x']['body']['text'] == given['body'] and 'contentClock' in keys, 'the prediction or the clock differs')
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError(case['name'] + ': malformed scene') from error
        except ValueError as error:
            raise ValueError(case['name'] + ': ' + str(error)) from error
    return len(document)


def check(documents):
    require(set(documents) == set(PINS), 'story files differ: ' + ', '.join(sorted(set(documents) ^ set(PINS))))
    shape, source = mark_shape()
    return {'pause cases': check_pauses(documents['pauses.json']), 'save scenes': check_saves(documents['saves.json'], shape)}, source


def negative_probes(documents):
    def pauses(change):
        return lambda docs: change(docs['pauses.json'])

    def save(name, change):
        return lambda docs: change(next(case for case in docs['saves.json'] if case['name'] == name))

    probes = [
        ('a commit one frame late', pauses(lambda cases: next(case for case in cases if case['expect'] == {'commits': [27]})['expect'].update(commits=[28]))),
        ('an energy rounded up', pauses(lambda cases: cases[2]['expect'].update(energy=1))),
        ('a frame one sample short', pauses(lambda cases: cases[0]['input'].update(samples=[[0, 2399]]))),
        ('an unknown pause operation', pauses(lambda cases: cases[0]['input'].update(op='PauseRule.floor'))),
        ('a story no clause names', pauses(lambda cases: cases.append(copy.deepcopy(dict(cases[0], name='unpinned'))))),
        ('a repeated name', pauses(lambda cases: cases.append(copy.deepcopy(cases[0])))),
        ('a mark whose digest is not the page\'s', save('the first settled turn saves the page as spoken with its mark', lambda case: case['input']['input']['mark'].update(pageDigest='0' * 16))),
        ('a mark one byte long', save('the first settled turn saves the page as spoken with its mark', lambda case: case['input']['input']['mark']['sessions'][0].update(bytesSaved=21))),
        ('a mark with a fifth session', save('a bridge adds its session to the mark alone', lambda case: case['input']['input']['mark']['sessions'].extend([case['input']['input']['mark']['sessions'][1]] * 3))),
        ('a mark with a field the row does not hold', save('the press writes the mark alone', lambda case: case['input']['input']['mark'].update(seat='bound'))),
        ('a save that drops the mark', save('the last save writes the page and clears the mark', lambda case: case['expect']['decision']['write']['gesture']['local'].pop())),
        ('a guarded save that writes over a changed page', save('a guarded save changes nothing once the page has changed', lambda case: case['input']['input'].update(whilePage=None))),
        ('a save into another day', save('a day that is no longer today is refused and nothing is written', lambda case: case['expect'].update(decision={'unchanged': {'result': None}}))),
    ]
    for name, mutate in probes:
        invalid = copy.deepcopy(documents)
        mutate(invalid)
        try:
            check(invalid)
        except ValueError:
            continue
        raise ValueError(f'checker accepted {name}')
    return len(probes)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.parse_args()
    documents = {str(path.relative_to(ROOT)): json.loads(path.read_text()) for path in sorted(ROOT.rglob('*.json'))}
    counts, source = check(documents)
    probes = negative_probes(documents)
    print('Talk stories verified: ' + ', '.join(f'{count} {kind}' for kind, count in counts.items()) + f'; {probes} negative probes rejected; marks held to {source}')


if __name__ == '__main__':
    main()
