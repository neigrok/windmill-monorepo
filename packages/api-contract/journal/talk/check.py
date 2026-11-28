#!/usr/bin/env python3
# Holds Talk's stories to the specification by a second derivation, reference.py, which generate.py never reads.
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re
import time

ROOT = Path(__file__).parent
CONTRACT = ROOT.parent.parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


wire = module('ai_wire', CONTRACT / 'ai' / 'check.py')
reference = module('talk_reference', ROOT / 'reference.py')
digest, utf8, WHITESPACE, PAGE_MAX = reference.digest, reference.utf8, reference.WHITESPACE, reference.PAGE_MAX
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

# First failures §4 and §5.5 name that ai/wire/fixtures.json `liveFirstFailures` does not hold yet. They wait on the
# node `widen-live-first-failures` of the AI service's tree. Until it lands such a message is held to that list's
# shape and its code to the fixtures' `refusals`; once the fixtures hold a code, the check refuses it here.
WAITING_FIRST_FAILURES = {'concurrency_exhausted'}
# What `unopened` carries when no door of the AI wire answered.
DOOR_CODES = {'offline'}
# Last messages of the fixtures no story plays, and why.
NOT_PLAYED = {'null_charged': '`provider_failed` before its charge is known: a take reads no money (P-6)'}
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
                                                         'a guarded save changes nothing once the page has changed',
                                                         'the mark is cleared on a page that has changed'],
        'domain kit Appendix C, pending edits': ['a bound day with a pending claim keeps the words in its claim, with the mark'],
    },
    'takes': {
        '§5.1 steps 2 and 3, open': ['open-and-end', 'open-refused', 'open-provider-unavailable', 'open-unopened', 'open-no-started'],
        '§5.1 step 2, a press over a standing mark': ['press-with-mark-standing', 'press-during-recovery', 'press-refused-with-mark-standing'],
        '§5.1 step 5, the day\'s end': ['open-near-day-end', 'open-near-day-end-full-page'],
        '§5.3 words, a turn and its number': ['delta-after-settled', 'turn-unseen', 'multibyte', 'turn-combining'],
        '§5.3 a part in turn order': ['turn-out-of-order'],
        '§5.3 a turn that holds no text': ['turn-empty', 'turn-whitespace-alone'],
        '§5.3 the last text, whole': ['ended-text-replaces-part'],
        '§5.3 the passage and the page before it': ['open-empty-page', 'page-trailing-whitespace', 'page-crlf', 'page-astral',
                                                   'page-whitespace-alone', 'passage-empties'],
        '§5.3 the page\'s size limit': ['page-full', 'open-page-full'],
        '§5.2 the service commits a turn itself': ['turn-forced'],
        '§5.4 an end before the first `started`': ['end-while-connecting'],
        '§5.4 the causes of an end': ['end-at-take-max', 'end-before-day-end', 'end-background', 'end-microphone-taken', 'end-capture-failed',
                                     'end-limit-inside-frames', 'end-day-end-and-limit-together'],
        '§5.4 step 3, no `ended`': ['end-no-ended', 'end-lost', 'end-ended-at-deadline'],
        '§5.4 step 4, Undo': ['end-undo', 'end-undo-mark-standing', 'end-undo-after-typing', 'undo-after-recovery', 'undo-during-recovery',
                              'undo-after-press-over-recovery'],
        '§5.4 table, `cut` with `idle`': ['cut-idle'],
        '§5.4 table, `cut` with a refusal of the next slice': ['cut-subject-exhausted', 'cut-funding-required'],
        '§5.4 table, `cut` with `paused` or `restarting`': ['cut-paused', 'cut-restarting'],
        '§5.4 table, `failed` `provider_failed`': ['bridge-provider-failed', 'end-provider-failed'],
        '§5.4 table, any other `failed`': ['failed-accounting-unavailable', 'failed-invalid-request'],
        '§5.4 an `ended` the table does not name': ['cut-unnamed', 'cut-completed-unasked'],
        '§4 a defect': ['defect-unreadable', 'defect-started-twice'],
        '§5.5 a first session lost before `started`': ['open-lost'],
        '§5.5 steps 1 and 3, a bridge': ['bridge-lost', 'bridge-lost-again'],
        '§5.2 the counts start again at a new session': ['bridge-pause-in-kept'],
        '§5.5 step 2, `concurrency_exhausted`': ['bridge-concurrency-retry', 'bridge-retry-past-wait', 'bridge-retry-unanswered'],
        '§5.5 step 3, ended meanwhile': ['bridge-ended-meanwhile', 'bridge-ended-then-lost', 'bridge-microphone-taken'],
        'INV-3 the foreground, during a bridge': ['bridge-background'],
        '§5.5 step 4, no `started` or a refusal': ['bridge-no-started', 'bridge-refused'],
        '§5.5 step 5, the lost session\'s result': ['bridge-result-replaces', 'bridge-result-gone', 'bridge-result-unknown'],
        '§5.5 MAX_BRIDGES': ['bridge-max'],
        '§5.6 a mark that is none to recover': ['recover-day-passed', 'recover-no-session', 'recover-no-mark', 'recover-result-after-midnight'],
        '§5.6 a result replaces its part': ['recover-result-replaces', 'recover-nothing-saved', 'recover-two-sessions',
                                           'recover-after-unsettled-end', 'recover-result-empty'],
        '§5.6 a result gone or unknown': ['recover-gone-keeps', 'recover-unknown-keeps'],
        '§5.6 writes only while the page has the digest': ['recover-page-changed', 'recover-same-length-edit', 'recover-changed-meanwhile'],
        '§5.6 reads repeat, and RECOVER_FOR': ['recover-still-open', 'recover-expired'],
        'INV-2 another device meanwhile': ['other-device-meanwhile'],
    },
}
ACTS = {'press', 'end', 'undo', 'background', 'microphoneTaken', 'captureFailed', 'clock', 'recover'}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def expand(items):
    whole = lambda value: type(value) is int
    require(isinstance(items, list) and all(whole(item) or (isinstance(item, list) and len(item) == 2 and whole(item[0]) and whole(item[1]) and item[1] > 0)
                                            for item in items), 'a sequence holds whole numbers, each alone or as [value, count]')
    return reference.expand(items)


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
            require(len(samples) == reference.SAMPLES and all(-32768 <= sample <= 32767 for sample in samples), 'a frame is 2,400 16-bit samples')
            require(case['expect'] == {'energy': reference.energy(samples)}, case['name'] + ': the energy differs from §5.2')
        else:
            require(given.get('op') == 'PauseRule.commits', 'unknown pause operation')
            wire.fields(given, 'op energies')
            energies = expand(given['energies'])
            require(all(0 <= value <= 32768 * 32768 for value in energies), 'an energy is a frame\'s')
            require(case['expect'] == {'commits': reference.commits(energies)}, case['name'] + ': the commits differ from §5.2')
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


# A session's last message, held to the fixtures: the key of the `liveTerminals` entry it equals but for its words,
# or null for a first message that refuses.
def last_message(message, first, fixtures):
    for key, fixture in fixtures['liveTerminals'].items():
        if dict(fixture, text=message.get('text')) == message:
            return key
    require(first and message.get('text') == '', 'a last message the live fixtures do not hold')
    code = message.get('code')
    if code in fixtures['liveFirstFailures']:
        require(message == fixtures['liveFirstFailures'][code], 'a first failure differs from its fixture')
        return None
    require(code in WAITING_FIRST_FAILURES, 'a first failure the live fixtures do not hold')
    wire.fields(message, 'type code text seconds charged allowance')
    require(message['type'] == 'failed' and message['seconds'] == 0 and message['charged'] is None, 'a first failure is uncharged')
    require(code in {entry['body']['code'] for entry in fixtures['refusals']}, 'a first failure is a public refusal')
    wire.allowance(message['allowance'], nullable=True)
    return None


# One story: its script is held to the wire, each mark it writes to the registry and to its page, and every output
# it states to the reference.
def check_take(story, shape, fixtures, played):
    wire.fields(story, 'format name given steps end recovered')
    require(story['format'] == 'journal-take/v1', 'unknown story format')
    given, steps = story['given'], story['steps']
    wire.fields(given, 'offsetSeconds page mark callIds')
    require(all(re.fullmatch(r'([A-Z])\1{21}', call) for call in given['callIds']), 'a made-up callId is one letter 22 times')
    require(steps and next(iter(steps[0]['in'])) in {'press', 'recover'}, 'a story begins with a press or a recovery')
    refusals = {entry['body']['code'] for entry in fixtures['refusals']}
    require({'conflict', 'result_gone', 'call_unknown'} <= refusals, 'the wire no longer refuses a result so')
    started, clock, mark = set(), steps[0]['at'], given['mark']
    for step in steps:
        wire.fields(step, 'at in out')
        wire.fields(step['out'], 'phase do send page saved mark wakeAt')
        require(type(step['at']) is int and step['at'] >= clock and isinstance(step['in'], dict) and len(step['in']) == 1, 'a step is one input, no earlier than the last')
        (name, value), = step['in'].items()
        clock = step['at']
        if name in ACTS:
            require(value is True, 'an act is true')
        elif name == 'frames':
            levels = expand(value)
            require(all(0 <= level <= 32768 * 32768 for level in levels), 'an energy is a frame\'s')
            clock += reference.FRAME * max(0, len(levels) - 1)
        elif name == 'heard':
            wire.fields(value, 'callId message')
            call, message = value['callId'], value['message']
            if message['type'] in {'started', 'text', 'turn'}:
                wire.live_event(message)
                require(message['type'] != 'started' or message == dict(fixtures['liveEvents'][0], callId=call), 'a `started` differs from its fixture')
            else:
                played.add(last_message(message, call not in started, fixtures))
            started |= {call} if message['type'] == 'started' else set()
        elif name in {'lost', 'unreadable'}:
            wire.fields(value, 'callId')
        elif name == 'unopened':
            wire.fields(value, 'callId code')
            require(value['code'] in refusals | DOOR_CODES, 'a door\'s code is the wire\'s or `offline`')
        elif name == 'result' and set(value) == {'callId', 'message'}:
            played.add(last_message(value['message'], False, fixtures))
        elif name == 'result':
            require(value in ({'callId': value['callId'], 'unread': True}, {'callId': value['callId'], 'code': value.get('code')})
                    and value.get('code') in {None, 'conflict', 'result_gone', 'call_unknown'}, 'an answer the result door does not give')
        else:
            require(name == 'changed' and (value is None or (set(value) == {'body', 'source'} and value['source'] in {'typed', 'spoken'})), 'unknown input')
        written, mark = step['out']['mark'] not in (None, mark), step['out']['mark']
        if written:
            located(step['out']['saved']['body'] if step['out']['saved'] else '', mark, shape)
    outs, end, recovered = reference.play(copy.deepcopy(story))
    for index, (step, out) in enumerate(zip(steps, outs)):
        differing = [key for key in out if step['out'][key] != out[key]]
        require(not differing, f'step {index}: {", ".join(differing)} differ from the reference')
    require(story['end'] == end and story['recovered'] == recovered, 'the end or the recovery\'s differs from the reference')
    return len(steps)


def check_takes(documents, shape):
    fixtures = json.loads((CONTRACT / 'ai' / 'wire' / 'fixtures.json').read_text())
    require(not WAITING_FIRST_FAILURES & set(fixtures['liveFirstFailures']), 'the live fixtures hold a waiting first failure now: take it off WAITING_FIRST_FAILURES')
    pinned = [name for clause in PINS['takes'].values() for name in clause]
    require(all(PINS['takes'].values()) and len(set(pinned)) == len(pinned), 'a clause has no story, or a story two clauses')
    require({f'takes/{name}.json' for name in pinned} == set(documents), 'clauses and stories differ: ' + ', '.join(sorted({f'takes/{name}.json' for name in pinned} ^ set(documents))))
    played, steps = set(), 0
    for path, story in documents.items():
        try:
            require(path == f'takes/{story.get("name")}.json', 'a story is named for its file')
            steps += check_take(story, shape, fixtures, played)
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError(path + ': malformed story') from error
        except ValueError as error:
            raise ValueError(path + ': ' + str(error)) from error
    played.discard(None)
    require(played | set(NOT_PLAYED) == set(fixtures['liveTerminals']) and not played & set(NOT_PLAYED), 'last messages played and the live fixtures differ: ' + ', '.join(sorted((played | set(NOT_PLAYED)) ^ set(fixtures['liveTerminals']))))
    return len(documents), steps


def check(documents):
    takes = {path: story for path, story in documents.items() if path.startswith('takes/')}
    require(set(documents) - set(takes) == {'pauses.json', 'saves.json'}, 'story files differ: ' + ', '.join(sorted(set(documents) - set(takes))))
    shape, source = mark_shape()
    stories, steps = check_takes(takes, shape)
    return {'pause cases': check_pauses(documents['pauses.json']), 'save scenes': check_saves(documents['saves.json'], shape),
            'take stories': stories, 'steps': steps}, source


def negative_probes(documents, reasons=None):
    def story(docs, name):
        return docs[f'takes/{name}.json']

    def out(docs, name, index):
        return story(docs, name)['steps'][index]['out']

    def scene(docs, name):
        return next(case for case in docs['saves.json'] if case['name'] == name)

    def rewritten(output, body, saved=None):
        output['saved']['body'] = body
        output['mark'].update(pageDigest=digest(body))
        if saved is not None:
            output['mark']['sessions'][0].update(bytesSaved=saved)

    def each(docs, name, change):
        for step in story(docs, name)['steps']:
            change(step['out'])

    first, bridge = 'the first settled turn saves the page as spoken with its mark', 'a bridge adds its session to the mark alone'
    river, water, rivet = 'Up early.\n\nWalked to the river.', 'Up early.\n\nWalked to the river. Cold water.', 'Up early.\n\nWalked to the rivet. Cold water.'
    probes = {
        'a commit one frame late': lambda docs: next(case for case in docs['pauses.json'] if case['expect'] == {'commits': [27]})['expect'].update(commits=[28]),
        'an energy rounded up': lambda docs: docs['pauses.json'][2]['expect'].update(energy=1),
        'a frame one sample short': lambda docs: docs['pauses.json'][0]['input'].update(samples=[[0, 2399]]),
        'an unknown pause operation': lambda docs: docs['pauses.json'][0]['input'].update(op='PauseRule.floor'),
        'a pause case no clause names': lambda docs: docs['pauses.json'].append(dict(copy.deepcopy(docs['pauses.json'][0]), name='unpinned')),
        'a repeated pause case': lambda docs: docs['pauses.json'].append(copy.deepcopy(docs['pauses.json'][0])),
        'a scene\'s mark with another page\'s digest': lambda docs: scene(docs, first)['input']['input']['mark'].update(pageDigest='0' * 16),
        'a scene\'s mark one byte long': lambda docs: scene(docs, first)['input']['input']['mark']['sessions'][0].update(bytesSaved=21),
        'a scene\'s mark with a fifth session': lambda docs: scene(docs, bridge)['input']['input']['mark']['sessions'].extend([scene(docs, bridge)['input']['input']['mark']['sessions'][1]] * 3),
        'a scene\'s mark with a field the row does not hold': lambda docs: scene(docs, 'the press writes the mark alone')['input']['input']['mark'].update(seat='bound'),
        'a save that drops the mark': lambda docs: scene(docs, 'the last save writes the page and clears the mark')['expect']['decision']['write']['gesture']['local'].pop(),
        'a guarded save that writes over a changed page': lambda docs: scene(docs, 'a guarded save changes nothing once the page has changed')['expect'].update(
            decision=scene(docs, 'a guarded save writes while the page has the digest')['expect']['decision']),
        'a clear of the mark that a changed page stops': lambda docs: scene(docs, 'the mark is cleared on a page that has changed')['expect'].update(decision={'unchanged': {'result': None}}),
        'a save into another day': lambda docs: scene(docs, 'a day that is no longer today is refused and nothing is written')['expect'].update(decision={'unchanged': {'result': None}}),
        'a mark written with no session': lambda docs: out(docs, 'open-and-end', 0)['mark'].update(sessions=[]),
        'a mark written for a text delta': lambda docs: out(docs, 'open-and-end', 3)['mark']['sessions'][0].update(heardAt=story(docs, 'open-and-end')['steps'][3]['at']),
        'a heardAt that is not the session\'s last message': lambda docs: out(docs, 'bridge-lost', -1)['mark']['sessions'][0].update(heardAt=story(docs, 'bridge-lost')['steps'][-4]['at']),
        'a commit one frame early': lambda docs: out(docs, 'open-and-end', 2).update(send=[{'audio': [1, 28]}, {'type': 'commit'}, {'audio': [29, 29]}]),
        'a context frame': lambda docs: out(docs, 'open-and-end', 2)['send'].insert(0, {'type': 'context', 'keywords': ['river']}),
        'audio after `end`': lambda docs: out(docs, 'end-background', -2).update(send=[{'audio': [35, 37]}]),
        'a last message the fixtures do not hold': lambda docs: story(docs, 'cut-idle')['steps'][-1]['in']['heard']['message'].update(code='tired'),
        'a first failure with a charge': lambda docs: story(docs, 'bridge-concurrency-retry')['steps'][9]['in']['heard']['message'].update(charged='0'),
        'a clause left with no story': lambda docs: docs.pop('takes/cut-idle.json'),
        'a recovery that closes a connection': lambda docs: out(docs, 'recover-result-replaces', 0)['do'].insert(0, {'close': 'A' * 22}),
        'a recovery that reads a session past RECOVER_FOR': lambda docs: out(docs, 'recover-expired', 0)['do'].insert(0, {'read': 'A' * 22}),
        'an end with another cause': lambda docs: story(docs, 'end-background')['end'].update(cause='person'),
        'an end that counts a bridge it did not make': lambda docs: story(docs, 'open-and-end')['end'].update(bridges=1),
        'an end that counts a commit it did not send': lambda docs: story(docs, 'turn-forced')['end'].update(commits=1),
        'a save past the page\'s limit': lambda docs: out(docs, 'page-full', 3)['saved'].update(body=out(docs, 'page-full', 3)['saved']['body'] + ' c'),
        'a page changed by another hand that moves the mark': lambda docs: out(docs, 'other-device-meanwhile', 5).update(mark=None),
        'a session opened twice': lambda docs: out(docs, 'bridge-lost', 7)['do'].insert(0, {'open': 'A' * 22}),
        'a callId that is not made up': lambda docs: story(docs, 'open-and-end')['given'].update(callIds=['abcdefghijklmnopqrstuv']),
        'Undo that leaves the page spoken': lambda docs: out(docs, 'end-undo', 7)['saved'].update(source='spoken'),
        'a mark that outlives a finished recovery': lambda docs: out(docs, 'recover-unknown-keeps', -1).update(mark=out(docs, 'recover-unknown-keeps', 0)['mark']),
        'a press that leaves the standing mark': lambda docs: out(docs, 'press-with-mark-standing', 0).update(mark=story(docs, 'press-with-mark-standing')['given']['mark']),
        'a recovery that writes after a press': lambda docs: out(docs, 'press-during-recovery', -1)['saved'].update(body=water),
        'a door left open past OPEN_WAIT': lambda docs: out(docs, 'open-no-started', -1).update(phase='connecting'),
        'kept audio sent from the background': lambda docs: out(docs, 'bridge-background', -1).update(send=[{'audio': [35, 44]}, {'type': 'end'}]),
        'a refused press that ends a recovery': lambda docs: out(docs, 'press-refused-with-mark-standing', 1).update(phase='ended', mark=None, wakeAt=None),
        'Undo guarded by a recovery from before the take': lambda docs: out(docs, 'undo-after-press-over-recovery', -1).update(
            saved=copy.deepcopy(out(docs, 'undo-after-press-over-recovery', -2)['saved']), page=copy.deepcopy(out(docs, 'undo-after-press-over-recovery', -2)['page'])),
        'a turn of whitespace that leaves two spaces': lambda docs: rewritten(out(docs, 'turn-whitespace-alone', -1), 'Up early.\n\n  Tea first.', 12),
        'an `ended` placed at the end wait\'s deadline': lambda docs: out(docs, 'end-ended-at-deadline', 8).update(mark=None),
        'Undo that leaves a recovery reading': lambda docs: out(docs, 'undo-during-recovery', -2).update(phase='recovering'),
        # The reviewer's mutations of 2026-11-28, under the names its run gave them.
        'bridge_frames_resent': lambda docs: out(docs, 'bridge-lost', 10).update(send=[{'audio': [30, 63]}, {'type': 'commit'}]),
        'bridge_lost_result_ignored': lambda docs: out(docs, 'bridge-result-replaces', -1).update(
            {key: copy.deepcopy(out(docs, 'bridge-result-replaces', -2)[key]) for key in ('saved', 'mark', 'page')}),
        'close_missing_at_deadline': lambda docs: out(docs, 'end-no-ended', -1).update(do=[]),
        'digest_of_press_page_kept': lambda docs: each(docs, 'open-and-end', lambda output: output['mark'] and output['mark'].update(pageDigest=out(docs, 'open-and-end', 0)['mark']['pageDigest'])),
        'digest_of_trimmed_page': lambda docs: each(docs, 'open-and-end', lambda output: output['mark'] and output['mark']['sessions'][0]['bytesSaved'] == 0 and output['mark'].update(pageDigest=digest('Up early.'))),
        'end_code_dropped': lambda docs: story(docs, 'cut-idle')['end'].update(code=None),
        'frame_sent_twice': lambda docs: out(docs, 'open-and-end', 6)['send'][0].update(audio=[29, 47]),
        'heard_wrong': lambda docs: story(docs, 'end-no-ended')['end'].update(heard=True),
        'kept_frames_dropped': lambda docs: out(docs, 'bridge-lost', 10).update(send=[]),
        'len_off_by_one': lambda docs: out(docs, 'open-and-end', 5)['mark']['sessions'][0].update(bytesSaved=21),
        'mark_cleared_while_unanswered': lambda docs: out(docs, 'end-no-ended', -1).update(mark=None),
        'mark_not_cleared_consistent': lambda docs: out(docs, 'open-and-end', -1).update(mark={
            'day': '2026-10-01', 'bytesBefore': 9, 'pageDigest': digest(out(docs, 'open-and-end', -1)['saved']['body']),
            'sessions': [{'callId': 'A' * 22, 'bytesSaved': utf8(out(docs, 'open-and-end', -1)['saved']['body']) - 11, 'heardAt': story(docs, 'open-and-end')['steps'][-1]['at']}]}),
        'mic_closed_late': lambda docs: (out(docs, 'end-background', 6).update(do=[]), out(docs, 'end-background', 8).update(do=[{'microphone': 'closed'}])),
        'nel_trimmed': lambda docs: (rewritten(out(docs, 'page-trailing-whitespace', -1), river), out(docs, 'page-trailing-whitespace', -1)['page'].update(text=river),
                                     out(docs, 'page-trailing-whitespace', -1)['mark'].update(bytesBefore=9)),
        'other_device_kept_out': lambda docs: out(docs, 'other-device-meanwhile', -1).update(
            {key: copy.deepcopy(out(docs, 'other-device-meanwhile', -2)[key]) for key in ('saved', 'mark')}),
        'page_carried_next_day': lambda docs: out(docs, 'end-before-day-end', -1).update(mark=out(docs, 'end-before-day-end', -2)['mark']),
        'phase_ending_forever': lambda docs: out(docs, 'end-no-ended', -1).update(phase='ending'),
        'read_missing_at_loss': lambda docs: out(docs, 'bridge-lost', 7).update(do=[order for order in out(docs, 'bridge-lost', 7)['do'] if 'read' not in order]),
        'recovered_answered_off': lambda docs: story(docs, 'recover-two-sessions')['recovered'].update(answered=2),
        'recovery_reads_answered_session_skipped': lambda docs: out(docs, 'bridge-ended-meanwhile', 13).update(do=[{'read': 'A' * 22}]),
        'recovery_writes_without_digest': lambda docs: out(docs, 'recover-page-changed', -1).update(saved={'body': water, 'source': 'spoken'}),
        'recovery_writes_without_digest_consistent': lambda docs: out(docs, 'recover-page-changed', -1).update(
            saved={'body': water, 'source': 'spoken'}, page={'text': water, 'unsettled': []}),
        'retry_at_wait_end': lambda docs: out(docs, 'bridge-retry-past-wait', -1).update(do=[{'microphone': 'closed'}, {'open': 'B' * 22}]),
        'same_length_edit_overwritten': lambda docs: out(docs, 'recover-same-length-edit', -1).update(
            saved={'body': rivet, 'source': 'spoken'}, page={'text': rivet, 'unsettled': []}),
        'save_while_passage_empty': lambda docs: (out(docs, 'turn-empty', 3).update(saved={'body': 'Up early.', 'source': 'spoken'}),
                                                  out(docs, 'turn-empty', 3)['mark'].update(pageDigest=digest('Up early.'))),
        'save_while_passage_empty_consistent': lambda docs: [(out(docs, 'turn-empty', index).update(saved={'body': 'Up early.', 'source': 'spoken'}),
                                                              out(docs, 'turn-empty', index)['mark'].update(pageDigest=digest('Up early.'))) for index in (3, 4, 5)],
        'saved_source_typed': lambda docs: out(docs, 'open-and-end', 5)['saved'].update(source='typed'),
        'shown_after_end_unsettled': lambda docs: out(docs, 'end-no-ended', -1)['page'].update(unsettled=[[32, 42]]),
        'shown_one_line_feed': lambda docs: out(docs, 'open-and-end', 3).update(page={'text': 'Up early.\nWalked to', 'unsettled': [[10, 19]]}),
        'trailing_ws_kept': lambda docs: (rewritten(out(docs, 'page-trailing-whitespace', -1), story(docs, 'page-trailing-whitespace')['given']['page']['body'] + '\n\nWalked to the river.'),
                                          out(docs, 'page-trailing-whitespace', -1)['page'].update(text=out(docs, 'page-trailing-whitespace', -1)['saved']['body']),
                                          out(docs, 'page-trailing-whitespace', -1)['mark'].update(bytesBefore=utf8(story(docs, 'page-trailing-whitespace')['given']['page']['body']))),
        'turn_dropped': lambda docs: rewritten(out(docs, 'turn-unseen', -1), 'Up early.\n\nTea first.', 10),
        'turns_in_arrival_order': lambda docs: rewritten(out(docs, 'turn-out-of-order', -1), 'Up early.\n\nTea first. Rain all morning.'),
        'undo_after_typing_writes': lambda docs: out(docs, 'end-undo-after-typing', -1).update(
            saved=copy.deepcopy(story(docs, 'end-undo-after-typing')['given']['page']), page={'text': story(docs, 'end-undo-after-typing')['given']['page']['body'], 'unsettled': []}),
        'unsettled_astral_counted_once': lambda docs: out(docs, 'multibyte', 3)['page']['unsettled'][0].__setitem__(1, out(docs, 'multibyte', 3)['page']['unsettled'][0][1] - 1),
        'unsettled_lost_at_end': lambda docs: (rewritten(out(docs, 'end-no-ended', -1), river, 20), out(docs, 'end-no-ended', -1)['page'].update(text=river)),
        'unsettled_missing': lambda docs: out(docs, 'open-and-end', 7)['page'].update(unsettled=[]),
        'unsettled_off_by_one': lambda docs: out(docs, 'multibyte', 5)['page']['unsettled'][0].__setitem__(1, out(docs, 'multibyte', 5)['page']['unsettled'][0][1] - 1),
        'wake_end_wait_ignores_midnight': lambda docs: each(docs, 'end-before-day-end', lambda output: output['wakeAt'] == 1790906399999 and output.update(wakeAt=1790906400000)),
        'wake_second_late': lambda docs: out(docs, 'open-and-end', 8).update(wakeAt=out(docs, 'open-and-end', 8)['wakeAt'] + 1000),
    }
    for name, mutate in probes.items():
        invalid = copy.deepcopy(documents)
        mutate(invalid)
        try:
            check(invalid)
        except ValueError as refusal:
            if reasons is not None:
                reasons.append(f'{name}: {refusal}')
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
