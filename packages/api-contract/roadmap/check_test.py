#!/usr/bin/env python3
import json
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
import check

# Each test reads the contract as it stands, breaks one thing, and holds the whole refusal check.py answers with. A row
# is the thing broken, as a function of the contract read, and the refusal's words.

class Rows(unittest.TestCase):
    def refused(self, rows, run):
        for change, reason in rows:
            with self.subTest(reason=reason):
                contract = check.Contract.read()
                change(contract)
                with self.assertRaises(ValueError) as raised: getattr(contract, run)()
                self.assertEqual(str(raised.exception), reason)


class ContractTest(unittest.TestCase):
    def test_the_contract_as_it_stands_holds(self):
        contract = check.Contract.read()
        self.assertEqual(contract.check(), sum(len(cases) for cases in contract.files.values()))


class CatalogTest(Rows):
    def test_an_entry_the_kit_would_not_read_is_refused(self):
        self.refused([
            (lambda c: c.catalog.update(catalog='catalog/3'), 'the catalog: `catalog/3` where it is `roadmap/1`'),
            (lambda c: c.catalog.update(abilities={}), 'the catalog: `abilities` that is not a list'),
            (lambda c: c.catalog['abilities'][0].pop('input'), 'get_tree: no input schema'),
            (lambda c: c.catalog['abilities'][0].update(since='catalog/2'), 'get_tree: `since` is not one of its keys'),
            (lambda c: c.catalog['abilities'][0].pop('strict'), 'get_tree: no `strict`'),
            (lambda c: c.catalog['abilities'].append(c.catalog['abilities'][0]), 'get_tree: named twice'),
            (lambda c: c.catalog['abilities'][0].update(phrase=''), 'get_tree: `phrase` that is not words'),
            (lambda c: c.catalog['abilities'][0].update(seats='anon'), "get_tree: `seats: anon` is not one of ['any', 'bound']"),
            (lambda c: c.catalog['abilities'][0].update(strict='no'), 'get_tree: `strict` that is not a boolean'),
            (lambda c: c.ability('connect').update({'class': 'remove'}), 'connect: an ability that runs at once and removes; a removal is a change of a proposal (§4)'),
        ], 'check_catalog')

    def test_an_ability_other_than_section_4_lists_is_refused(self):
        self.refused([
            (lambda c: c.ability('rename_node').update(agent='withheld'), 'rename_node: `change` and `withheld`, where §4 has `change` and `runs`'),
            (lambda c: c.ability('create_node').update({'class': 'change'}), 'create_node: `change` and `runs`, where §4 has `add` and `runs`'),
            (lambda c: c.ability('set_progress').update(seats='bound'), 'set_progress: seats other than `any` or a strict tool, where §4 offers every ability signed out and none strict'),
            (lambda c: c.ability('get_tree').update(strict=True), 'get_tree: seats other than `any` or a strict tool, where §4 offers every ability signed out and none strict'),
            (lambda c: c.catalog['abilities'].remove(c.ability('annotate_node')), "the catalog: abilities ['annotate_node'] in one of the catalog and §4 alone"),
            (lambda c: c.catalog['abilities'].append({**json.loads(json.dumps(c.ability('set_progress'))), 'name': 'delete_tree'}), "the catalog: abilities ['delete_tree'] in one of the catalog and §4 alone"),
        ], 'check_catalog')

    def test_a_schema_outside_the_vocabulary_is_refused(self):
        def tree_id(c): return c.ability('get_tree')['input']['properties']['treeId']
        def links(c): return c.ability('annotate_node')['input']['properties']['links']
        self.refused([
            (lambda c: c.ability('get_tree').update(input={'type': 'string'}), 'get_tree: an input schema that is not `type: object`'),
            (lambda c: c.ability('rename_node')['input']['properties']['label'].update(maxLength=200), 'rename_node.label: `maxLength` is not in the shared vocabulary'),
            (lambda c: c.ability('get_tree')['input']['properties'].update(cursor={'anyOf': [{'type': 'string'}, {'type': 'null'}]}), 'get_tree.cursor: `anyOf` is not in the shared vocabulary'),
            (lambda c: c.ability('get_tree')['input']['properties'].update(cursor='a string'), 'get_tree.cursor: no schema'),
            (lambda c: links(c)['items'].pop('additionalProperties'), 'annotate_node.links[]: an object without `additionalProperties: false`'),
            (lambda c: links(c)['items'].pop('required'), 'annotate_node.links[]: an object without `required`'),
            (lambda c: links(c)['items']['required'].append('title'), 'annotate_node.links[]: `title` required but not a property'),
            (lambda c: links(c).pop('items'), 'annotate_node.links: an array without `items`'),
            (lambda c: links(c)['items'].pop('type'), 'annotate_node.links[]: a schema without a known `type`'),
            (lambda c: links(c).update(minItems=2), 'annotate_node.links: `minItems` other than the integer 0 or 1'),
            (lambda c: tree_id(c).update(properties={}), 'get_tree.treeId: an object\'s keywords on a schema that is not `type: object`'),
            (lambda c: tree_id(c).update(enum=[{'a': 1}]), 'get_tree.treeId: `enum` that is not a list of scalars'),
            (lambda c: tree_id(c).update(const=['t']), 'get_tree.treeId: `const` that is not a scalar'),
            (lambda c: tree_id(c).update(pattern=1), 'get_tree.treeId: `pattern` that is not a string'),
            (lambda c: c.ability('get_tree')['result']['properties']['steps']['items']['properties']['label'].update(maxLength=200), 'get_tree → result.steps[].label: `maxLength` is not in the shared vocabulary'),
        ], 'check_catalog')

    def test_an_unknown_pattern_is_refused(self):
        rows = []
        for pattern, reason in [
            ('^.+$', '`.`, where the vocabulary writes each class out'),
            ('^[a-z]\\d$', '`\\d`, where the vocabulary escapes punctuation alone'),
            ('^\\w+$', '`\\w`, where the vocabulary escapes punctuation alone'),
            ('^[\\s]$', '`\\s`, where the vocabulary escapes punctuation alone'),
            ('^(a)\\1$', '`\\1`, where the vocabulary escapes punctuation alone'),
            ('^(?=a)a$', 'a `(?` group other than `(?:`'),
            ('^[a-z]{1,100}$', 'a quantifier range past 64'),
            ('^[a-z]{3,}$', 'a quantifier range past 64'),
        ]: rows.append((lambda c, p=pattern: c.ability('get_tree')['input']['properties']['treeId'].update(pattern=p), f'get_tree.treeId: an unknown pattern, `{pattern}`: {reason}'))
        rows.append((lambda c: c.ability('get_tree')['input']['properties']['treeId'].update(pattern='^[a-z'), 'get_tree.treeId: an unknown pattern, `^[a-z`, which does not compile'))
        self.refused(rows, 'check_catalog')

    def test_a_pattern_of_explicit_classes_holds(self):
        for pattern in ['^t_[0-9a-f]{16}$', '^[.]+$', '^a\\.b$', '^(?:ab|c)[A-Za-z0-9_-]{8,64}$']:
            with self.subTest(pattern=pattern): check.check_pattern(pattern, 'a pattern')

    def test_an_answer_other_than_the_spec_states_is_refused(self):
        self.refused([
            (lambda c: c.ability('get_tree').update(result={}), 'get_tree: a read whose result is not held to 16384 bytes (§5)'),
            (lambda c: c.ability('propose_roadmap_change')['result'].update(maxBytes=99), 'propose_roadmap_change: a `maxBytes` on an answer that is no read\'s'),
            (lambda c: c.ability('rename_node').update(result=[]), 'rename_node: a result schema that is not an object'),
            (lambda c: c.ability('rename_node').update(result={}), 'rename_node: an answer with no schema, where §4 states every ability\'s'),
            (lambda c: c.ability('connect').update(result={'type': 'object', 'properties': {'nodeId': {'type': 'string'}}, 'required': [], 'additionalProperties': False}), "connect: an answer of ['nodeId'], where §6 answers []"),
        ], 'check_catalog')

    def test_a_read_other_than_section_5_states_is_refused(self):
        self.refused([
            (lambda c: c.ability('find_nodes')['input']['properties']['cursor'].update(pattern='^[0-9]{1,9}$'), f'find_nodes: a `cursor` whose pattern is not §5.2\'s, `{check.CURSOR.pattern}`'),
            (lambda c: c.ability('get_nodes')['input']['properties']['fields']['items']['enum'].remove('opens'), "get_nodes: `fields` other than §5.1's, ['id', 'label', 'kind', 'state', 'prerequisites', 'unlockCount', 'summary', 'description', 'links', 'opens']"),
            (lambda c: c.ability('find_nodes')['result']['properties']['steps']['items']['properties'].pop('opens'), 'find_nodes: an answered step whose fields are not §5.1\'s'),
            (lambda c: c.ability('get_tree')['result']['properties']['steps']['items']['properties']['state']['enum'].remove('unknown'), "get_tree: states other than §5.1's, ['locked', 'available', 'complete', 'unknown']"),
        ], 'check_catalog')

    def test_a_proposal_other_than_section_7_states_is_refused(self):
        def change(c): return c.ability('propose_roadmap_change')['input']['properties']['changes']['items']
        def description(c, old, new): c.ability('propose_roadmap_change').update(description=c.ability('propose_roadmap_change')['description'].replace(old, new))
        self.refused([
            (lambda c: change(c)['properties']['op']['enum'].remove('rename_kind'), "propose_roadmap_change: ops other than §7's, ['add_step', 'remove_step', 'rename', 'describe', 'set_kind', 'connect', 'disconnect', 'merge', 'split', 'set_progress', 'add_kind', 'rename_kind', 'recolor_kind']"),
            (lambda c: change(c)['properties'].pop('removeId'), "propose_roadmap_change: change fields ['description', 'hue', 'kind', 'label', 'links', 'nodeId', 'op', 'parts', 'prerequisiteId', 'prerequisites', 'ref', 'status'], where §7 names ['description', 'hue', 'kind', 'label', 'links', 'nodeId', 'op', 'parts', 'prerequisiteId', 'prerequisites', 'ref', 'removeId', 'status']"),
            (lambda c: c.ability('propose_roadmap_change')['input']['properties']['changes'].pop('minItems'), 'propose_roadmap_change: `changes` without `minItems: 1`, where §7 takes one to 100'),
            (lambda c: change(c)['properties']['ref'].update(pattern='^new:[a-z]{1,8}$'), f'propose_roadmap_change: a `ref` whose pattern is not §7\'s, `{check.REF.pattern}`'),
            (lambda c: description(c, 'add_kind: required ref, label, hue; optional description. A hue another kind wears is refused.\n', ''), 'propose_roadmap_change: no line `add_kind: required …; optional …` in the description'),
            (lambda c: description(c, 'connect: required nodeId, prerequisiteId; optional none.', 'connect: required nodeId; optional prerequisiteId.'), "propose_roadmap_change: the line of `connect` says required ['nodeId'], optional ['prerequisiteId'], where §7 has ['nodeId', 'prerequisiteId'] and []"),
            (lambda c: description(c, 'rename: required', 'rename_step: required nodeId, label; optional none.\nrename: required'), 'propose_roadmap_change: a line for `rename_step`, which is no op of §7'),
            (lambda c: change(c)['properties']['hue']['enum'].remove('plum'), "propose_roadmap_change.changes[].hue: hues ['terracotta', 'olive', 'gold', 'brick', 'sky'], where the registry has ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum']"),
            (lambda c: next(entry for entry in c.registry['types'] if entry['type'] == 'node')['fields']['color']['domain']['enum'].remove('plum'), "packages/api-contract/sync/roadmap.registry.json: step colours ['terracotta', 'olive', 'gold', 'brick', 'sky'], where its kinds' hues are ['terracotta', 'olive', 'gold', 'brick', 'sky', 'plum']"),
            (lambda c: c.spec.actions.pop('connect'), "the catalog: direct writes ['annotate_node', 'connect', 'create_node', 'rename_node', 'set_progress'], where §6 names the actions of ['annotate_node', 'create_node', 'rename_node', 'set_progress']"),
        ], 'check_catalog')


class SpecTest(unittest.TestCase):
    def test_a_spec_without_a_table_the_check_reads_is_refused(self):
        text = check.REPO.joinpath(check.SPEC).read_text()
        start, end = text.index('## §4 The catalog'), text.index('## §5 Reading')
        untabled = text[:start] + '\n'.join(line for line in text[start:end].split('\n') if not line.startswith('|')) + text[end:]
        for broken, reason in [(text.replace('## §4 The catalog', '## §4 Abilities'), 'docs/foundation/roadmap-coach.md: no `## §4 The catalog`'),
                               (untabled, 'docs/foundation/roadmap-coach.md: no table 1 under `## §4 The catalog`')]:
            with self.subTest(reason=reason):
                with self.assertRaises(ValueError) as raised: check.Spec(broken)
                self.assertEqual(str(raised.exception), reason)


class VectorsTest(Rows):
    def vector(self, file, index, change, tail):
        return (lambda c: change(c.files[file][index], c), f'abilities/{file}.json · {check.Contract.read().files[file][index]["case"]}{tail}')

    def test_a_file_or_case_out_of_shape_is_refused(self):
        self.refused([
            (lambda c: c.files.update(set_mark=c.files['set_progress']), 'abilities/set_mark.json: names no ability of the catalog'),
            (lambda c: c.files.update(set_progress=[]), 'abilities/set_progress.json: not a list of cases'),
            (lambda c: c.files['set_progress'][0].update(case=''), 'abilities/set_progress.json · : a case that is not named'),
            self.vector('set_progress', 0, lambda case, c: case['call'].update(name='rename_node'), ': calls `rename_node` in the file of `set_progress`'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect=[]), ': an expectation that is not an object'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect={'refused': {'code': 'roadmap-not-ready'}, 'writes': []}), ': a refusal beside `writes`'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect={'result': {}}), ': a write that expects `result` where it expects `result writes`'),
            self.vector('get_progress', 1, lambda case, c: case.update(expect={'writes': []}), ': a read that expects `writes` where it expects `result`'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case['expect'].pop('proposal'), ': a proposal that expects `result` where it expects `proposal result`'),
        ], 'check_vectors')

    def test_what_a_case_gives_out_of_shape_is_refused(self):
        self.refused([
            self.vector('set_progress', 0, lambda case, c: case['given'].update(trees={}), ': `trees` that are not a list'),
            self.vector('set_progress', 0, lambda case, c: case['given']['trees'][0].pop('nodes'), ' · a given tree: no `nodes`'),
            self.vector('set_progress', 0, lambda case, c: case['given']['trees'][0]['nodes'][0].pop('icon'), ' · t_0000000000000001.nodes: no `icon`'),
            self.vector('set_progress', 0, lambda case, c: case['given']['trees'].append(case['given']['trees'][0]), ': a roadmap given twice'),
            self.vector('set_progress', 3, lambda case, c: case.update(about='t_0000000000000009'), ': `about` names `t_0000000000000009`, a roadmap not given'),
            self.vector('set_progress', 2, lambda case, c: case['given']['held'][0].update(tree='t_0000000000000009'), ': a held step of `t_0000000000000009`, a roadmap not given'),
            self.vector('set_progress', 2, lambda case, c: case['given']['trees'][0]['nodes'][2].update(present=True), ': a held step `c` that its roadmap does not hold as removed'),
            self.vector('set_progress', 2, lambda case, c: case['given'].update(held=['c']), ' · held: not an object'),
            self.vector('create_node', 0, lambda case, c: case['given'].update(ids=['x', 'x']), ': `ids` that are not distinct ids'),
        ], 'check_vectors')

    def test_an_input_or_answer_out_of_its_schema_is_refused(self):
        self.refused([
            self.vector('set_progress', 0, lambda case, c: case['call']['input'].update(treeId='Learn to sail'), ': input.treeId: not ^t_[0-9a-f]{16}$'),
            self.vector('set_progress', 0, lambda case, c: case['call']['input'].update(outOfOrder=True), ': input.outOfOrder: not a property'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case['call']['input']['changes'][0].update(ref='hoist'), ': input.changes[0].ref: not ^new:[a-z0-9][a-z0-9-]{0,31}$'),
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['steps'][0].update(state='done'), ': result.steps[0].state: not one of the enum'),
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['tree'].update(kinds=[{'id': 'build'}]), ': result.tree.kinds[0].label: required'),
            self.vector('get_progress', 1, lambda case, c: case['expect']['result']['completed'][0].update(at=2.0), ': a number with a fraction, which no roadmap answer holds'),
            self.vector('get_progress', 1, lambda case, c: case['expect']['result']['completed'][0].update(id='\ud83e'), ': a lone surrogate, which no canonical text holds'),
            self.vector('get_progress', 1, lambda case, c: case['expect']['result'].update(completed=[{'id': 'é' * 8180, 'at': None}]), ': a result of 16395 bytes, past 16384'),
        ], 'check_vectors')

    def test_a_page_against_the_rules_of_pages_is_refused(self):
        self.refused([
            self.vector('get_tree', 1, lambda case, c: case['expect']['result'].update(nextCursor='page-2'), ': a `nextCursor`, `page-2`, that is not index.part.digest'),
            self.vector('get_tree', 1, lambda case, c: case['expect']['result'].update(nextCursor='7.1.' + case['expect']['result']['nextCursor'][4:]), ': a `nextCursor` past the 4 objects of the read\'s sequence'),
            self.vector('get_tree', 3, lambda case, c: case['expect']['result']['steps'].reverse(), ': an object in parts that does not start its page'),
            self.vector('get_tree', 2, lambda case, c: case['expect']['result'].update(steps=[{**case['expect']['result']['steps'][0], 'description': 'Round the post'}, {'id': 'c'}]), ': a part before the last that does not take its page alone'),
            self.vector('get_tree', 3, lambda case, c: case['expect']['result']['steps'][0].update(label='Clove hitch'), ': a later part that carries `label`'),
            self.vector('get_tree', 2, lambda case, c: case['expect']['result']['steps'][0].update(part=3), ': a part that is not `part` n of `parts` N, N at least 2'),
        ], 'check_vectors')

    def test_a_step_other_than_the_case_gives_is_refused(self):
        self.refused([
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['steps'][1].update(summary='Practise'), ': `b`\'s summary, which is not its description cut after 160 characters'),
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['steps'][1].update(label='Tie a knot'), ': `b`\'s label, which is not the step\'s'),
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['steps'].append({'id': 'zz'}), ': a step `zz` the roadmap does not hold'),
            self.vector('get_tree', 1, lambda case, c: case['expect']['result']['steps'][0].update(description='A loop'), ': `a`\'s description, which is not the step\'s'),
            self.vector('get_tree', 3, lambda case, c: case['expect']['result']['steps'][0].update(description='x'), ': `b`\'s description in part 2, which is not that part of the step\'s'),
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['tree'].update(stepCount=99), ': a `stepCount` of 99, where the roadmap holds 6 steps'),
            self.vector('get_tree', 0, lambda case, c: case['expect']['result']['tree'].update(title='Learn to swim'), ': a header whose title is not the roadmap\'s'),
        ], 'check_vectors')

    def test_a_write_other_than_section_6_gives_is_refused(self):
        self.refused([
            self.vector('set_progress', 0, lambda case, c: case['expect'].update(writes=[]), ': writes that are not a list of actions'),
            self.vector('set_progress', 0, lambda case, c: case['expect']['writes'][0].update(action='SetProgress'), ': writes `SetProgress`, which is no action of the domain'),
            self.vector('set_progress', 0, lambda case, c: case['expect']['writes'][0].update(action='DeleteStep'), ": writes `DeleteStep`, where §6 gives set_progress ['Complete', 'Reset']"),
            self.vector('set_progress', 0, lambda case, c: case['expect']['writes'][0].update(input={'tree': 't_0000000000000001', 'node': 'b'}), ': a `Complete` whose input is not of the shape the domain\'s cases give it'),
            self.vector('create_node', 0, lambda case, c: case['expect'].update(result={'nodeId': 'zzzzzzzzzzzzzzzz'}), ': a new step whose id is not the one id minted'),
            self.vector('rename_node', 1, lambda case, c: case.update(expect={'writes': [{'action': 'ChangeStep', 'input': {}}], 'result': {}}), ': an input past a cap of limits.json that is not refused as `over-limit`, nor by a rule §6 checks before the caps'),
            self.vector('rename_node', 1, lambda case, c: case['expect']['refused'].update(code='unknown-step'), ': an input past a cap of limits.json that is not refused as `over-limit`, nor by a rule §6 checks before the caps'),
            self.vector('rename_node', 0, lambda case, c: case['call']['input'].update(label='Tie a\x00bowline'), ': a text the domain cannot store that is not refused as `invalid-input`'),
            self.vector('annotate_node', 0, lambda case, c: case['call']['input']['links'][0].update(label='Knots \udc00'), ': a text the domain cannot store that is not refused as `invalid-input`'),
        ], 'check_vectors')

    # A roadmap whose count of steps or links is full, too large to hold as a vector of its own.
    @staticmethod
    def full(case, steps=0, links=0):
        tree = case['given']['trees'][0]
        tree['nodes'] += [{**tree['nodes'][0], 'id': f's{index}'} for index in range(steps)]
        tree['edges'] += [{'from': 's0', 'to': f's{index}', 'present': True} for index in range(links)]

    def test_a_full_count_of_steps_or_links_is_over_limit_naming_the_roadmap(self):
        contract = check.Contract.read()
        create, link = contract.files['create_node'][0], contract.files['connect'][0]
        self.full(create, steps=10_000 - 3)
        self.full(link, steps=1, links=20_000 - 2)
        for case in (create, link): case['expect'] = {'refused': {'code': 'over-limit', 'id': 't_0000000000000001'}}
        self.assertEqual(contract.check_vectors(), sum(len(cases) for cases in contract.files.values()))
        self.refused([
            (lambda c: (self.full(c.files['create_node'][0], steps=10_000 - 3), c.files['create_node'][0].update(expect={'refused': {'code': 'over-limit'}})),
             f'abilities/create_node.json · {create["case"]}: an `over-limit` that names none, where §6.1 names `t_0000000000000001`'),
            (lambda c: c.files['create_node'][0].update(expect={'refused': {'code': 'over-limit', 'id': 't_0000000000000001'}}),
             f'abilities/create_node.json · {create["case"]}: `over-limit` for a call that passes no cap of limits.json'),
        ], 'check_vectors')

    def test_a_proposal_other_than_section_7_mints_is_refused(self):
        self.refused([
            self.vector('propose_roadmap_change', 0, lambda case, c: case['expect']['result'].update(proposalId='k1x9q2m7p4z8w3r5'), ': a `proposalId` that is not the first id minted'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case['given']['ids'].append('zzzzzzzzzzzzzzzz'), ': 4 ids minted, where the proposal and its 2 refs take 3'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case['given'].update(ids=case['given']['ids'][:2]), ': 2 ids minted, where the proposal and its 2 refs take 3'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case['expect']['proposal']['changes'][1].update(prerequisites=['new:hoist']), ': a record whose changes are not the call\'s with each ref under its minted id'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case['expect']['proposal']['changes'].pop(), ': a record whose changes are not the call\'s with each ref under its minted id'),
            self.vector('propose_roadmap_change', 1, lambda case, c: case['expect']['result'].update(removes=[]), ": removes of [], where the changes remove ['d']"),
            self.vector('propose_roadmap_change', 1, lambda case, c: case['expect']['result']['removes'][0].update(descriptionChars=9), ': a removes entry for `d` that is not the step as the roadmap holds it'),
            self.vector('propose_roadmap_change', 4, lambda case, c: case['expect'].pop('folded'), ': a recolour with no `folded` colours pinned'),
            self.vector('propose_roadmap_change', 4, lambda case, c: case['expect']['folded']['kinds'][1].update(hue='gold'), ': folded kinds that share a hue'),
            self.vector('propose_roadmap_change', 4, lambda case, c: case['expect']['folded'].pop('steps'), ' · folded: no `steps`'),
            self.vector('propose_roadmap_change', 1, lambda case, c: case['expect']['proposal'].update(base={}), ' · proposal: `base` is not one of its keys'),
        ], 'check_vectors')

    def test_a_refusal_other_than_the_case_allows_is_refused(self):
        self.refused([
            self.vector('set_progress', 2, lambda case, c: case['expect']['refused'].update(code='not ready'), ': `not ready`, which is no refusal code of §6.1'),
            self.vector('set_progress', 2, lambda case, c: case['expect']['refused'].update(id=''), ': an `id` that is not an id'),
            self.vector('set_progress', 2, lambda case, c: case['expect']['refused'].update(why='held'), ' · refused: `why` is not one of its keys'),
            self.vector('get_progress', 1, lambda case, c: case.update(expect={'refused': {'code': 'unknown-roadmap'}}), ': `unknown-roadmap` for a roadmap the case gives'),
            self.vector('get_progress', 1, lambda case, c: case.update(expect={'refused': {'code': 'roadmap-unavailable'}}), ': `roadmap-unavailable` for a roadmap the device holds whole'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect={'refused': {'code': 'not-owner'}}), ': `not-owner` for a roadmap the person owns'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect={'refused': {'code': 'out-of-scope'}}), ': `out-of-scope` for a write to the conversation\'s roadmap'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect={'refused': {'code': 'roadmap-not-ready', 'id': 'b'}}), ': `roadmap-not-ready` that names no held step'),
            self.vector('set_progress', 0, lambda case, c: case.update(expect={'refused': {'code': 'over-limit'}}), ': `over-limit` for a call that passes no cap of limits.json'),
            self.vector('rename_node', 1, lambda case, c: case['expect']['refused'].update(id='t_0000000000000001'), ': an `over-limit` that names `t_0000000000000001`, where §6.1 names `b`'),
            self.vector('set_progress', 2, lambda case, c: case['expect']['refused'].update(at=0), ': an `at` on a refusal of no proposal'),
        ], 'check_vectors')

    def test_a_proposal_refusal_whose_at_breaks_section_7_is_refused(self):
        self.refused([
            self.vector('propose_roadmap_change', 3, lambda case, c: case['expect']['refused'].pop('at'), ': no `at` on `hue-taken`, which refuses a change'),
            self.vector('propose_roadmap_change', 5, lambda case, c: case['expect']['refused'].update(at=2), ': an `at` of 2, past the changes sent'),
            self.vector('propose_roadmap_change', 10, lambda case, c: case['expect']['refused'].update(at=0), ': an `at` on `over-limit`, which refuses the whole call'),
            self.vector('propose_roadmap_change', 11, lambda case, c: case['expect']['refused'].update(at=99), ': an `at` of 99 on `over-limit`, where change 100 is the first past a cap'),
            self.vector('propose_roadmap_change', 11, lambda case, c: case['expect']['refused'].update(id='a'), ': an `id` on a refusal of the count of changes'),
            self.vector('propose_roadmap_change', 13, lambda case, c: case['expect']['refused'].update(at=0), ': an `at` of 0 on a Shape refusal of changes[1]'),
            self.vector('propose_roadmap_change', 0, lambda case, c: case.update(expect={'refused': {'code': 'not-owner', 'at': 0}}), ': `not-owner` for a roadmap the person owns'),
        ], 'check_vectors')

    def test_a_proposal_refused_as_not_owner_carries_no_at(self):
        self.refused([
            self.vector('propose_roadmap_change', 0, lambda case, c: (case['given']['trees'][0].update(own=False), case.update(expect={'refused': {'code': 'not-owner', 'at': 0}})), ': an `at` on `not-owner`, which refuses the whole call'),
        ], 'check_vectors')


class LimitsTest(Rows):
    def test_a_cap_other_than_section_6_states_is_refused(self):
        self.refused([
            (lambda c: c.limits['limits'].pop('kinds'), "limits.json: caps ['kinds'] in one of limits.json and §6 alone"),
            (lambda c: c.limits['limits']['webLinkLabel'].update(backend='kMaxTitleChars'), "webLinkLabel: {'max': 200, 'unit': 'characters', 'backend': 'kMaxTitleChars', 'registry': ['node.links.label'], 'web': 'linkLabel'} here, where §6 has {'max': 200, 'unit': 'characters', 'backend': 'kMaxLinkLabelLength', 'registry': ['node.links.label'], 'web': 'linkLabel'}"),
            (lambda c: c.limits['limits']['label'].update(registry=['subtask.label']), "label: {'max': 200, 'unit': 'characters', 'backend': 'kMaxNodeLabelLength', 'registry': ['subtask.label'], 'web': 'label'} here, where §6 has {'max': 200, 'unit': 'characters', 'backend': 'kMaxNodeLabelLength', 'registry': ['node.label'], 'web': 'label'}"),
            (lambda c: c.limits['limits']['label'].pop('web'), "label: {'max': 200, 'unit': 'characters', 'backend': 'kMaxNodeLabelLength', 'registry': ['node.label'], 'web': None} here, where §6 has {'max': 200, 'unit': 'characters', 'backend': 'kMaxNodeLabelLength', 'registry': ['node.label'], 'web': 'label'}"),
            (lambda c: c.limits['limits']['label'].update(why='a label'), 'label: `why` is not one of its keys'),
            (lambda c: (c.limits['limits']['steps'].update(max=0), c.spec.caps['steps'].update(max=0)), 'steps: `max` that is not a positive integer'),
            (lambda c: (c.limits['limits']['steps'].update(unit='nodes'), c.spec.caps['steps'].update(unit='nodes')), "steps: `unit: nodes` is not one of ['bytes', 'characters', 'items']"),
        ], 'check_limits')

    def test_a_cap_its_backend_holds_otherwise_is_refused(self):
        def header(c, old, new): c.header = c.header.replace(old, new)
        self.refused([
            (lambda c: header(c, 'kMaxNodeLabelLength = 200;', 'kMaxNodeLabelLength = 240;'), "label: 200 here, 240 in the backend's kMaxNodeLabelLength"),
            (lambda c: header(c, 'kMaxKinds', 'kMaxLegendKinds'), 'kinds: `kMaxKinds` is no constant of backend/products/roadmap/domain/Command.h'),
            (lambda c: header(c, 'kMaxNodes = 10000;', "kMaxNodes = 10'000;"), "steps: `kMaxNodes` is `10'000`, not a number"),
            (lambda c: header(c, 'constexpr std::size_t kMaxNodes = 10000;', 'constexpr std::size_t kMaxNodes = 12000;\n// constexpr std::size_t kMaxNodes = 10000;'), 'backend/products/roadmap/domain/Command.h: `kMaxNodes` defined twice'),
        ], 'check_limits')

    def test_a_cap_its_registry_declares_otherwise_is_refused(self):
        def field(c, type_name, name): return next(entry for entry in c.registry['types'] if entry['type'] == type_name)['fields'][name]
        self.refused([
            (lambda c: field(c, 'node', 'links')['domain']['items']['properties']['url'].update(max=4096), "webLinkAddress: 2048 here, 4096 in the registry's node.links.url"),
            (lambda c: field(c, 'node', 'label').update(unit='bytes'), "label: characters here, bytes in the registry's node.label"),
            (lambda c: next(entry for entry in c.registry['types'] if entry['type'] == 'kind')['idDomain'].update(max=16), "id: 128 here, 16 in the registry's kind.id"),
            (lambda c: field(c, 'coachProposal', 'changes')['domain'].update(maxItems=50), "proposalChanges: 100 here, 50 in the registry's coachProposal.changes"),
            (lambda c: field(c, 'coachProposal', 'base').update(max=131072), "proposalBaseBytes: 262144 here, 131072 in the registry's coachProposal.base"),
            (lambda c: (c.limits['limits']['kinds'].update(registry=['legend']), c.spec.caps['kinds'].update(registry=['legend'])), 'kinds: `legend` declares no cap in packages/api-contract/sync/roadmap.registry.json'),
        ], 'check_limits')

    def test_a_cap_the_web_holds_otherwise_is_refused(self):
        def rules(c, old, new): c.rules = c.rules.replace(old, new)
        self.refused([
            (lambda c: rules(c, "chars('kind.description', 80)", "chars('kind.description', 120)"), "kindDescription: 80 here, 120 in the web's RoadmapSpecs.kindDescription"),
            (lambda c: rules(c, "new CountSpec('node.links', { min: 0, max: 32 })", "new CountSpec('node.links', { max: 64, min: 0 })"), "webLinks: 32 here, 64 in the web's RoadmapSpecs.links"),
            (lambda c: rules(c, "label: chars('node.label', 200)", "label: chars('node.title', 200)"), "label: the web's RoadmapSpecs.label holds `node.title`, where the registry's is `node.label`"),
            (lambda c: rules(c, "label: chars('node.label', 200)", "label: new CountSpec('node.label', { max: 200 })"), "label: characters here, items in the web's RoadmapSpecs.label"),
            (lambda c: rules(c, "label: chars('node.label', 200),", "label: chars('node.label', 240),\n  label: chars('node.label', 200),"), 'web/src/products/roadmap/domain/roadmapRules.js: `RoadmapSpecs.label` defined twice'),
            (lambda c: rules(c, 'export const RoadmapSpecs', 'export const Specs'), 'web/src/products/roadmap/domain/roadmapRules.js: no `RoadmapSpecs`'),
            (lambda c: (c.limits['limits']['label'].update(web='stepLabel'), c.spec.caps['label'].update(web='stepLabel')), 'label: `stepLabel` is no spec of web/src/products/roadmap/domain/roadmapRules.js'),
        ], 'check_limits')

    def test_a_stray_spec_outside_roadmap_specs_is_not_read(self):
        contract = check.Contract.read()
        contract.rules += "\nconst other = Object.freeze({\n  label: chars('x', 999),\n});\n"
        contract.check_limits()


class PartsTest(unittest.TestCase):
    def test_a_part_is_its_start_its_end_or_a_run_within(self):
        for piece, part, parts, held in [('ab', 1, 3, True), ('bc', 1, 3, False), ('cd', 2, 3, True), ('de', 3, 3, True), ('cd', 3, 3, False), ([2, 3], 2, 3, True), ([3, 2], 2, 3, False)]:
            with self.subTest(piece=piece, part=part):
                self.assertEqual(check.within(piece, 'abcde' if isinstance(piece, str) else [1, 2, 3, 4], part, parts), held)

    def test_a_key_past_ascii_has_no_canonical_text(self):
        with self.assertRaises(ValueError) as raised: check.canonical({'é': 1}, 'a page')
        self.assertEqual(str(raised.exception), 'a page: a key past ASCII, `é`')


if __name__ == '__main__':
    unittest.main()
