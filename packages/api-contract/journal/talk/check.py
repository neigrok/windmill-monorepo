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
TAKE_MAX, END_WAIT, BRIDGE_WAIT, BRIDGE_RETRY, RESULT_POLL, RECOVER_FOR, KEPT_MAX = 600000, 15000, 10000, 2000, 5000, 600000, 100
# First failures §4 and §5.5 name that ai/wire/fixtures.json `liveFirstFailures` does not hold yet. They wait on the
# node `widen-live-first-failures` of the AI service's tree. Until it lands such a message is held to that list's
# shape and its code to the fixtures' `refusals`; once the fixtures hold a code, the check refuses it here.
WAITING_FIRST_FAILURES = {'concurrency_exhausted'}
# What `unopened` carries when no door of the AI wire answered.
DOOR_CODES = {'offline'}
# Last messages of the fixtures no story plays, and why.
NOT_PLAYED = {'null_charged': '`provider_failed` before its charge is known: a take reads no money (P-6)'}
ORDERS = ['microphone', 'close', 'open', 'read']
PHASES = {
    None: {'connecting', 'ended', 'recovering', 'recovered'}, 'connecting': {'connecting', 'listening', 'ended'},
    'listening': {'listening', 'bridging', 'ending', 'ended'}, 'bridging': {'bridging', 'listening', 'ending', 'ended'},
    'ending': {'ending', 'ended'}, 'ended': {'ended', 'recovering', 'recovered'},
    'recovering': {'recovering', 'recovered'}, 'recovered': {'recovered'},
}
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
    'takes': {
        '§5.1 steps 2 and 3, open': ['open-and-end', 'open-refused', 'open-provider-unavailable', 'open-unopened'],
        '§5.1 step 5, the day\'s end': ['open-near-day-end'],
        '§5.3 words, a turn and its number': ['delta-after-settled', 'turn-unseen', 'multibyte'],
        '§5.3 a part in turn order': ['turn-out-of-order'],
        '§5.3 a turn that holds no text': ['turn-empty'],
        '§5.3 the last text, whole': ['ended-text-replaces-part'],
        '§5.3 the passage and the page before it': ['open-empty-page', 'page-trailing-whitespace'],
        '§5.3 the page\'s size limit': ['page-full', 'open-page-full'],
        '§5.2 the service commits a turn itself': ['turn-forced'],
        '§5.4 an end before the first `started`': ['end-while-connecting'],
        '§5.4 the causes of an end': ['end-at-take-max', 'end-before-day-end', 'end-background', 'end-microphone-taken', 'end-capture-failed'],
        '§5.4 step 3, no `ended`': ['end-no-ended', 'end-lost'],
        '§5.4 step 4, Undo': ['end-undo', 'end-undo-mark-standing', 'end-undo-after-typing'],
        '§5.4 table, `cut` with `idle`': ['cut-idle'],
        '§5.4 table, `cut` with a refusal of the next slice': ['cut-subject-exhausted', 'cut-funding-required'],
        '§5.4 table, `cut` with `paused` or `restarting`': ['cut-paused', 'cut-restarting'],
        '§5.4 table, `failed` `provider_failed`': ['bridge-provider-failed'],
        '§5.4 table, any other `failed`': ['failed-accounting-unavailable', 'failed-invalid-request'],
        '§5.4 a cut the table does not name': ['cut-unnamed'],
        '§4 a defect': ['defect-unreadable', 'defect-started-twice'],
        '§5.5 a first session lost before `started`': ['open-lost'],
        '§5.5 steps 1 and 3, a bridge': ['bridge-lost', 'bridge-lost-again'],
        '§5.2 the counts start again at a new session': ['bridge-pause-in-kept'],
        '§5.5 step 2, `concurrency_exhausted`': ['bridge-concurrency-retry', 'bridge-retry-past-wait'],
        '§5.5 step 3, ended meanwhile': ['bridge-ended-meanwhile'],
        '§5.5 step 4, no `started` or a refusal': ['bridge-no-started', 'bridge-refused'],
        '§5.5 step 5, the lost session\'s result': ['bridge-result-replaces', 'bridge-result-gone', 'bridge-result-unknown'],
        '§5.5 MAX_BRIDGES': ['bridge-max'],
        '§5.6 a mark that is none to recover': ['recover-day-passed', 'recover-no-session'],
        '§5.6 a result replaces its part': ['recover-result-replaces', 'recover-nothing-saved', 'recover-two-sessions',
                                           'recover-after-unsettled-end'],
        '§5.6 a result gone or unknown': ['recover-gone-keeps', 'recover-unknown-keeps'],
        '§5.6 writes only while the page has the digest': ['recover-page-changed', 'recover-same-length-edit', 'recover-changed-meanwhile'],
        '§5.6 reads repeat, and RECOVER_FOR': ['recover-still-open', 'recover-expired'],
        'INV-2 another device meanwhile': ['other-device-meanwhile'],
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


def utf16(text):
    return len(text.encode('utf-16-le')) // 2


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


# One story, step by step. What it derives here it derives from the script alone: where commits fall, what each
# session's `heardAt` is, which deadline `wakeAt` names, why the take ended and what it counted.
def check_take(story, shape, fixtures, played):
    wire.fields(story, 'format name given steps end recovered')
    require(story['format'] == 'journal-take/v1', 'unknown story format')
    given, steps = story['given'], story['steps']
    wire.fields(given, 'offsetSeconds page mark callIds')
    require(all(re.fullmatch(r'([A-Z])\1{21}', call) for call in given['callIds']), 'a made-up callId is one letter 22 times')
    require(steps and next(iter(steps[0]['in'])) in {'press', 'recover'}, 'a story begins with a press or a recovery')
    took = 'press' in steps[0]['in']
    require(took == (given['mark'] is None), 'a take begins with no mark, a recovery with one')
    offset, start = given['offsetSeconds'] * 1000, steps[0]['at']
    day_of = lambda at: time.strftime('%Y-%m-%d', time.gmtime((at + offset) // 1000))
    day_end = start - (start + offset) % 86400000 + 86400000
    before = given['page']['body'] if given['page'] else ''
    refusals = {entry['body']['code'] for entry in fixtures['refusals']}
    saved, mark, phase, previous, clock = given['page'], given['mark'], None, None, start
    another_hand = mark is not None and digest(before) != mark['pageDigest']
    order, sessions, current, captured, sent, microphone = [], {}, None, [], 0, False
    limit = bridge = retry = end_wait = None
    polls, gone, reading, answered, cause, code, dropped = {}, set(), {}, set(), None, None, False

    for step in steps:
        wire.fields(step, 'at in out')
        at, out = step['at'], step['out']
        require(type(at) is int and at >= clock and isinstance(step['in'], dict) and len(step['in']) == 1, 'a step is one input, no earlier than the last')
        wire.fields(out, 'phase do send page saved mark wakeAt')
        (name, value), = step['in'].items()
        require(out['phase'] in PHASES[phase], f'no step leads from {phase} to {out["phase"]}')
        ends = out['phase'] in {'ending', 'ended'} and phase in {None, 'connecting', 'listening', 'bridging'}
        recovery = out['phase'] in {'recovering', 'recovered'}
        message = None

        if name in {'press', 'end', 'undo', 'background', 'microphoneTaken', 'captureFailed', 'clock', 'recover'}:
            require(value is True and (name != 'press' or phase is None) and (name != 'undo' or phase == 'ended'), 'an act out of place')
            require(name != 'recover' or (phase in {None, 'ended'} and mark is not None), 'a recovery needs a mark and no take running')
        elif name == 'frames':
            energies = expand(value)
            require(all(0 <= level <= 32768 * 32768 for level in energies), 'an energy is a frame\'s')
            if microphone:
                captured += energies
            at += 100 * max(0, len(energies) - 1)
        elif name == 'heard':
            wire.fields(value, 'callId message')
            session, message = sessions[value['callId']], value['message']
            if message['type'] in {'started', 'text', 'turn'}:
                wire.live_event(message)
            if not session['closed']:
                session['heard'] = at
                if message['type'] == 'started':
                    require(message == dict(fixtures['liveEvents'][0], callId=value['callId']), 'a `started` differs from its fixture')
                    require(not session['started'] or out['phase'] == 'ended', 'a second `started` ends the take')
                    session['started'], current, bridge, retry = True, value['callId'], None, None
                elif message['type'] in {'text', 'turn'}:
                    require(session['started'], 'words before `started`')
                    session['turns'].add(message['turn'])
                else:
                    key = last_message(message, not session['started'], fixtures)
                    played.add(key)
                    session['last'], session['closed'] = message, message['code'] != 'concurrency_exhausted'
                    session['refused'] = message['code']
                    if message['code'] == 'concurrency_exhausted' and bridge is not None and at + BRIDGE_RETRY < bridge:
                        retry = at + BRIDGE_RETRY
        elif name in {'lost', 'unreadable'}:
            wire.fields(value, 'callId')
            sessions[value['callId']]['closed'] = True
        elif name == 'unopened':
            wire.fields(value, 'callId code')
            require(value['callId'] in sessions and value['code'] in refusals | DOOR_CODES, 'a door\'s code is the wire\'s or `offline`')
            sessions[value['callId']]['closed'] = True
        elif name == 'result':
            call = value['callId']
            require(mark is not None and call in [session['callId'] for session in mark['sessions']], 'a result of a session the mark does not name')
            if set(value) == {'callId', 'message'}:
                played.add(last_message(value['message'], False, fixtures))
                answered.add(call)
            elif value == {'callId': call, 'unread': True} or value == {'callId': call, 'code': 'conflict'}:
                polls[call] = at + RESULT_POLL
            elif value == {'callId': call, 'code': 'result_gone'} and call not in gone:
                gone.add(call)
                polls[call] = at + RESULT_POLL
            else:
                require(value in ({'callId': call, 'code': 'result_gone'}, {'callId': call, 'code': 'call_unknown'}), 'an answer the result door does not give')
            require({'conflict', 'result_gone', 'call_unknown'} <= refusals, 'the wire no longer refuses a result so')
            if call in answered or value.get('code') == 'call_unknown' or (value.get('code') == 'result_gone' and call not in polls):
                reading.pop(call, None)
                polls.pop(call, None)
        else:
            require(name == 'changed' and (value is None or (set(value) == {'body', 'source'} and value['source'] in {'typed', 'spoken'})), 'unknown input')

        kinds = [next(iter(item)) for item in out['do']]
        require(all(len(item) == 1 for item in out['do']) and kinds == sorted(kinds, key=ORDERS.index), 'orders are the microphone\'s, then close, open and read')
        require(not recovery or set(kinds) <= {'read'}, 'a recovery opens nothing and records nothing')
        for item in out['do']:
            (kind, target), = item.items()
            if kind == 'microphone':
                require(target in {'open', 'closed'} and (target == 'open') != microphone, 'the microphone is opened once and closed once')
                microphone = target == 'open'
            elif kind == 'open' and target in sessions:
                require(not sessions[target]['started'] and sessions[target]['refused'] == 'concurrency_exhausted', 'a session is opened again only after `concurrency_exhausted`')
                sessions[target]['refused'], retry = None, None
            elif kind == 'open':
                require(len(order) < len(given['callIds']) and target == given['callIds'][len(order)], 'callIds are used in order')
                order.append(target)
                sessions[target] = {'opened': at, 'heard': None, 'started': False, 'closed': False, 'last': None, 'refused': None,
                                    'audio': [], 'commits': [], 'turns': set(), 'end': False}
            elif kind == 'close':
                require(target in sessions, 'a connection that was never opened')
            else:
                require(mark is not None and target in [session['callId'] for session in mark['sessions']] + order, 'a read of a session the mark does not name')
                polls.pop(target, None)

        for item in out['send']:
            require(current is not None and sessions[current]['started'] and not sessions[current]['end'], 'a frame with no session to take it')
            if set(item) == {'audio'}:
                first, final = item['audio']
                require(first == sent + 1 and first <= final <= len(captured), 'audio is sent once, in the order captured')
                sessions[current]['audio'] += captured[first - 1:final]
                sent = final
            elif item == {'type': 'commit'}:
                sessions[current]['commits'].append(len(sessions[current]['audio']))
            else:
                require(item == {'type': 'end'} and name != 'frames', 'a frame the caller does not send')
                sessions[current]['end'], end_wait = True, min(at + END_WAIT, day_end - 1)
            require(set(item) == {'audio'} or item in fixtures['liveFrames'], 'a control frame differs from its fixture')
        require(len(captured) - sent <= KEPT_MAX, 'more than BRIDGE_WAIT of audio is kept')
        require(out['phase'] != 'listening' or sent == len(captured), 'a frame captured while listening is not sent')
        require(not recovery or out['send'] == [], 'a recovery sends nothing')

        if ends:
            last = message is not None and message['type'] in {'ended', 'failed'}
            first_session = len(order) < 2
            if name in {'end', 'background', 'microphoneTaken', 'captureFailed'}:
                cause = {'end': 'person', 'background': 'background', 'microphoneTaken': 'microphone', 'captureFailed': 'capture'}[name]
            elif name == 'clock':
                cause = 'bridge' if at == bridge else 'dayEnd' if at == day_end - END_WAIT else 'limit'
                require(at in {bridge, limit}, 'no deadline fell at this instant')
            elif name == 'press':
                cause = 'dayEnd' if at >= day_end - END_WAIT else 'pageFull'
                room = utf8(before.rstrip(WHITESPACE))
                require(cause == 'dayEnd' or (room > 0 and room + 3 > PAGE_MAX), 'a press that should have opened a take')
            elif name == 'heard' and not last:
                cause = 'defect' if message['type'] == 'started' else 'pageFull'
            elif last and sessions[value['callId']]['started']:
                cause, code = 'service', message['code']
            elif name in {'heard', 'unopened'}:
                cause, code = 'refused' if first_session else 'bridge', value['code'] if name == 'unopened' else message['code']
            else:
                cause = 'defect' if name == 'unreadable' else 'refused' if first_session and not sessions[order[0]]['started'] else 'bridge'
        if name == 'press' and out['phase'] == 'connecting':
            limit = min(at + TAKE_MAX, day_end - END_WAIT)
        if out['phase'] == 'bridging' and phase != 'bridging':
            bridge = at + BRIDGE_WAIT
        if out['phase'] == 'ended':
            bridge = retry = end_wait = None
            polls = {}
            require(not microphone, 'an ended take leaves the microphone open')
            for session in sessions.values():
                session['closed'] = True
        if name == 'recover':
            dropped = day_of(at) != mark['day'] or not mark['sessions']
            reading = {} if dropped else {session['callId']: session['heardAt'] + RECOVER_FOR for session in mark['sessions'] if at < session['heardAt'] + RECOVER_FOR}
            polls, gone, answered = {}, set(), set()
            require(out['do'] == [{'read': call} for call in reading], 'a recovery reads each session heard from within RECOVER_FOR, on the mark\'s day')
            require(out['phase'] == ('recovering' if reading else 'recovered'), 'a recovery with nothing to read is over')
            require(not dropped or (out['mark'] is None and out['saved'] == saved), 'a mark whose day has passed, or that names no session, is cleared and nothing is written')
        reading = {call: expiry for call, expiry in reading.items() if expiry > at} if out['phase'] == 'recovering' else {}
        if out['phase'] == 'recovered':
            polls = {}
        deadlines = list(polls.values()) + list(reading.values())
        deadlines += [limit] if out['phase'] in {'connecting', 'listening', 'bridging'} else []
        deadlines += [bridge] if bridge is not None and out['phase'] in {'bridging', 'ending'} else []
        deadlines += [retry] if retry is not None else []
        deadlines += [end_wait] if end_wait is not None and out['phase'] == 'ending' else []
        require(out['wakeAt'] == min(deadlines, default=None), f'wakeAt is not the earliest deadline standing at {at}')
        require(out['wakeAt'] is None or out['wakeAt'] > at, 'a deadline already due')

        silent = name == 'frames' or (message is not None and (message['type'] == 'text' or (message['type'] == 'started' and out['phase'] != 'ended')))
        require(not silent or (out['saved'] == saved and out['mark'] == mark), 'a frame, a `started` and a `text` delta write nothing')
        body = out['saved']['body'] if out['saved'] else ''
        require(out['saved'] is None or (set(out['saved']) == {'body', 'source'} and out['saved']['source'] in {'typed', 'spoken'}), 'a saved page is its body and source')
        require(utf8(body) <= PAGE_MAX and (out['saved'] is None or body.strip(WHITESPACE)), 'a saved page holds text, within the limit')
        if name == 'changed':
            require(out == dict(previous, saved=value, do=[], send=[]), 'a page changed by another hand changes nothing else')
            another_hand = True
        else:
            if out['saved'] != saved:
                another_hand = False
                require(out['saved'] == given['page'] if name == 'undo' else out['saved']['source'] == 'spoken', 'a take saves as spoken, and Undo as the page was')
            if out['mark'] is not None and not another_hand:
                located(body, out['mark'], shape)
            if out['mark'] is not None and out['mark'] != mark:
                calls = [session['callId'] for session in out['mark']['sessions']]
                heard = [session['heardAt'] for session in out['mark']['sessions']]
                if recovery or not took:
                    kept = [mark['day'], mark['bytesBefore'], [session['callId'] for session in mark['sessions']], [session['heardAt'] for session in mark['sessions']]]
                    require([out['mark']['day'], out['mark']['bytesBefore'], calls, heard] == kept, 'a recovery changes a mark\'s lengths and digest alone')
                else:
                    require(out['mark']['day'] == day_of(start) and out['mark']['bytesBefore'] == utf8(before.rstrip(WHITESPACE)), 'the mark\'s day or first length differs')
                    require(calls == order, 'the mark names the sessions opened, in order')
                    require(heard == [sessions[call]['heard'] or sessions[call]['opened'] for call in order], 'heardAt is not the session\'s last message')
            wire.fields(out['page'], 'text unsettled')
            edge = -1
            for low, high in out['page']['unsettled']:
                require(edge < low < high <= utf16(out['page']['text']), 'unsettled ranges lie in the text, in order and apart')
                edge = high
            if out['phase'] in {'ended', 'recovering', 'recovered'}:
                require(out['page']['unsettled'] == [], 'nothing is unsettled once a take has ended')
                require(another_hand and not recovery or out['page']['text'] == body, 'what is shown after a take is the page as stored')
        saved, mark, phase, previous, clock = out['saved'], out['mark'], out['phase'], out, at

    for session in sessions.values():
        require(commits(session['audio']) == session['commits'], 'a commit is not where §5.2 puts it')
    require(order == given['callIds'], 'a callId given and never used')
    ended = any(step['out']['phase'] in {'ended', 'recovering', 'recovered'} for step in steps) and took
    require((story['end'] is not None) == ended, 'a take that ended says how')
    if ended:
        final = sessions[order[-1]] if order else None
        counted = {
            'cause': cause, 'code': code, 'heard': bool(final and final['started'] and final['last']),
            'turns': sum(len(session['turns']) for session in sessions.values()),
            'forcedTurns': sum(max(0, max(session['turns'], default=1) - 1 - len(session['commits'])) for session in sessions.values()),
            'bridges': max(0, len(order) - 1)}
        require(story['end'] == counted, 'the end differs from the script: ' + json.dumps(counted))
    require((story['recovered'] is not None) == (phase == 'recovered'), 'a recovery that finished says how')
    if phase == 'recovered':
        require(mark is None, 'a finished recovery leaves no mark')
        require(story['recovered'] == {'cause': 'dropped' if dropped else 'recovered', 'answered': len(answered)}, 'the recovery\'s end differs from the script')
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
    def pauses(change):
        return lambda docs: change(docs['pauses.json'])

    def save(name, change):
        return lambda docs: change(next(case for case in docs['saves.json'] if case['name'] == name))

    def take(name, change):
        return lambda docs: change(docs[f'takes/{name}.json'])

    def step(story, given):
        return next(step for step in story['steps'] if given in step['in'] or step['in'].get('heard', {}).get('message', {}).get('type') == given)

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
        ('a guarded save that writes over a changed page', lambda docs: docs['saves.json'][10]['expect'].update(decision=docs['saves.json'][9]['expect']['decision'])),
        ('a save into another day', save('a day that is no longer today is refused and nothing is written', lambda case: case['expect'].update(decision={'unchanged': {'result': None}}))),
        ('a part one byte longer than the mark says', take('open-and-end', lambda story: step(story, 'turn')['out']['mark']['sessions'][0].update(bytesSaved=21))),
        ('a mark with the digest of another page', take('open-and-end', lambda story: step(story, 'turn')['out']['mark'].update(pageDigest='0' * 16))),
        ('a mark written with no session', take('open-and-end', lambda story: step(story, 'press')['out']['mark'].update(sessions=[]))),
        ('a mark written for a text delta', take('open-and-end', lambda story: step(story, 'text')['out']['mark']['sessions'][0].update(heardAt=step(story, 'text')['at']))),
        ('a heardAt that is not the session\'s last message', take('bridge-lost', lambda story: story['steps'][-1]['out']['mark']['sessions'][0].update(heardAt=story['steps'][-4]['at']))),
        ('an audio frame sent twice', take('open-and-end', lambda story: story['steps'][6]['out']['send'][0].update(audio=[29, 47]))),
        ('a commit one frame early', take('open-and-end', lambda story: step(story, 'frames')['out'].update(send=[{'audio': [1, 28]}, {'type': 'commit'}, {'audio': [29, 29]}]))),
        ('a context frame', take('open-and-end', lambda story: step(story, 'frames')['out']['send'].insert(0, {'type': 'context', 'keywords': ['river']}))),
        ('audio after `end`', take('end-background', lambda story: story['steps'][-2]['out'].update(send=[{'audio': [35, 37]}]))),
        ('more than BRIDGE_WAIT of audio kept', take('bridge-no-started', lambda story: story['steps'][9]['in'].update(frames=[[0, 49], [0, 52]]))),
        ('a last message the fixtures do not hold', take('cut-idle', lambda story: story['steps'][-1]['in']['heard']['message'].update(code='tired'))),
        ('a first failure with a charge', take('bridge-concurrency-retry', lambda story: step(story, 'failed')['in']['heard']['message'].update(charged='0'))),
        ('a clause left with no story', lambda docs: docs.pop('takes/cut-idle.json')),
        ('a wake at another deadline', take('bridge-lost', lambda story: step(story, 'lost')['out'].update(wakeAt=step(story, 'lost')['out']['wakeAt'] + 1))),
        ('a recovery that closes a connection', take('recover-result-replaces', lambda story: story['steps'][0]['out']['do'].insert(0, {'close': 'A' * 22}))),
        ('a recovery that reads a session past RECOVER_FOR', take('recover-expired', lambda story: story['steps'][0]['out']['do'].insert(0, {'read': 'A' * 22}))),
        ('an end with another cause', take('end-background', lambda story: story['end'].update(cause='person'))),
        ('an end that counts a bridge it did not make', take('open-and-end', lambda story: story['end'].update(bridges=1))),
        ('a save past the page\'s limit', take('page-full', lambda story: story['steps'][3]['out']['saved'].update(body=story['steps'][3]['out']['saved']['body'] + ' c'))),
        ('a page changed by another hand that moves the mark', take('other-device-meanwhile', lambda story: step(story, 'changed')['out'].update(mark=None))),
        ('an unsettled range outside the text', take('multibyte', lambda story: story['steps'][-1]['out']['page'].update(unsettled=[[24, 99]]))),
        ('a session opened twice', take('bridge-lost', lambda story: step(story, 'lost')['out']['do'].insert(0, {'open': 'A' * 22}))),
        ('a callId that is not made up', take('open-and-end', lambda story: story['given'].update(callIds=['abcdefghijklmnopqrstuv']))),
        ('Undo that leaves the page spoken', take('end-undo', lambda story: step(story, 'undo')['out']['saved'].update(source='spoken'))),
        ('a mark that outlives a finished recovery', take('recover-unknown-keeps', lambda story: story['steps'][-1]['out'].update(mark=story['steps'][0]['out']['mark']))),
    ]
    for name, mutate in probes:
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
