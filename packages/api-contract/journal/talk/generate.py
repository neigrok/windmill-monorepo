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


def documents():
    return {'pauses.json': vectors(pause_cases())}


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
