#!/usr/bin/env python3
# Holds Talk's stories to the specification by a second derivation: nothing here reads generate.py.
import argparse
import copy
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).parent
CONTRACT = ROOT.parent.parent
spec = importlib.util.spec_from_file_location('ai_wire', CONTRACT / 'ai' / 'check.py')
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)

SAMPLES, PAUSE, MIN_TURN, SPEECH_MIN = 2400, 7, 10, 10737

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


def check(documents):
    require(set(documents) == set(PINS), 'story files differ: ' + ', '.join(sorted(set(documents) ^ set(PINS))))
    return {'pause cases': check_pauses(documents['pauses.json'])}


def negative_probes(documents):
    def pauses(change):
        return lambda docs: change(docs['pauses.json'])

    probes = [
        ('a commit one frame late', pauses(lambda cases: next(case for case in cases if case['expect'] == {'commits': [27]})['expect'].update(commits=[28]))),
        ('an energy rounded up', pauses(lambda cases: cases[2]['expect'].update(energy=1))),
        ('a frame one sample short', pauses(lambda cases: cases[0]['input'].update(samples=[[0, 2399]]))),
        ('an unknown pause operation', pauses(lambda cases: cases[0]['input'].update(op='PauseRule.floor'))),
        ('a story no clause names', pauses(lambda cases: cases.append(copy.deepcopy(dict(cases[0], name='unpinned'))))),
        ('a repeated name', pauses(lambda cases: cases.append(copy.deepcopy(cases[0])))),
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
    counts = check(documents)
    probes = negative_probes(documents)
    print('Talk stories verified: ' + ', '.join(f'{count} {kind}' for kind, count in counts.items()) + f'; {probes} negative probes rejected')


if __name__ == '__main__':
    main()
