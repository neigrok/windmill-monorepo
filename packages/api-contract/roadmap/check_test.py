#!/usr/bin/env python3
import json
import unittest
from pathlib import Path

import check

# Each test takes the contract as it stands, breaks one thing, and holds the whole refusal check.py answers with.

class CatalogTest(unittest.TestCase):
    def refused(self, catalog, reason):
        with self.assertRaises(ValueError) as raised: check.check_catalog(catalog)
        self.assertEqual(str(raised.exception), reason)

    def test_the_contract_as_it_stands_holds(self):
        here = Path(__file__).parent
        catalog = json.loads((here / 'catalog.json').read_text())
        limits = json.loads((here / 'limits.json').read_text())
        check.check_catalog(catalog)
        check.check_limits(limits, (here.parents[2] / limits['backend']).read_text(), json.loads((here.parents[2] / limits['registry']).read_text()),
                           (here.parents[2] / limits['web']).read_text())
        files = {path.stem: json.loads(path.read_text()) for path in (here / 'abilities').glob('*.json')}
        self.assertEqual(check.check_vectors(catalog, files, check.domain_actions(here / 'domain')), sum(len(cases) for cases in files.values()))

    def test_an_ability_with_no_input_schema_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        del catalog['abilities'][0]['input']
        self.refused(catalog, 'get_tree: no input schema')

    def test_an_input_that_is_not_an_object_schema_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['input'] = {'type': 'string'}
        self.refused(catalog, 'get_tree: an input schema that is not `type: object`')

    def test_a_bound_outside_the_vocabulary_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        rename = next(ability for ability in catalog['abilities'] if ability['name'] == 'rename_node')
        rename['input']['properties']['label']['maxLength'] = 200
        self.refused(catalog, 'rename_node.label: `maxLength` is not in the shared vocabulary')

    def test_a_union_is_refused_since_the_kit_checks_none(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['input']['properties']['cursor'] = {'anyOf': [{'type': 'string'}, {'type': 'null'}]}
        self.refused(catalog, 'get_tree.cursor: `anyOf` is not in the shared vocabulary')

    def test_an_unknown_pattern_is_refused(self):
        for pattern, reason in [
            ('^.+$', 'an unknown pattern, `^.+$`: `.`, where the vocabulary writes each class out'),
            ('^[a-z]\\d$', 'an unknown pattern, `^[a-z]\\d$`: `\\d`, where the vocabulary escapes punctuation alone'),
            ('^\\w+$', 'an unknown pattern, `^\\w+$`: `\\w`, where the vocabulary escapes punctuation alone'),
            ('^[\\s]$', 'an unknown pattern, `^[\\s]$`: `\\s`, where the vocabulary escapes punctuation alone'),
            ('^(a)\\1$', 'an unknown pattern, `^(a)\\1$`: `\\1`, where the vocabulary escapes punctuation alone'),
            ('^(?=a)a$', 'an unknown pattern, `^(?=a)a$`: a `(?` group other than `(?:`'),
            ('^[a-z]{1,100}$', 'an unknown pattern, `^[a-z]{1,100}$`: a quantifier range past 64'),
            ('^[a-z]{3,}$', 'an unknown pattern, `^[a-z]{3,}$`: a quantifier range past 64'),
            ('^[a-z', 'an unknown pattern, `^[a-z`, which does not compile'),
        ]:
            with self.subTest(pattern=pattern):
                catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
                catalog['abilities'][0]['input']['properties']['treeId']['pattern'] = pattern
                self.refused(catalog, f'get_tree.treeId: {reason}')

    def test_a_pattern_of_explicit_classes_holds(self):
        for pattern in ['^t_[0-9a-f]{16}$', '^[.]+$', '^a\\.b$', '^(?:ab|c)[A-Za-z0-9_-]{8,64}$']:
            with self.subTest(pattern=pattern):
                catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
                catalog['abilities'][0]['input']['properties']['treeId']['pattern'] = pattern
                check.check_catalog(catalog)

    def test_an_object_that_is_not_closed_is_refused(self):
        for change, reason in [
            (lambda links: links['items'].pop('additionalProperties'), 'annotate_node.links[]: an object without `additionalProperties: false`'),
            (lambda links: links['items'].pop('required'), 'annotate_node.links[]: an object without `required`'),
            (lambda links: links['items']['required'].append('title'), 'annotate_node.links[]: `title` required but not a property'),
            (lambda links: links.pop('items'), 'annotate_node.links: an array without `items`'),
            (lambda links: links['items'].pop('type'), 'annotate_node.links[]: a schema without a known `type`'),
            (lambda links: links.update(minItems=2), 'annotate_node.links: `minItems` other than the integer 0 or 1'),
        ]:
            with self.subTest(reason=reason):
                catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
                annotate = next(ability for ability in catalog['abilities'] if ability['name'] == 'annotate_node')
                change(annotate['input']['properties']['links'])
                self.refused(catalog, reason)

    def test_an_entry_the_kit_would_not_read_is_refused(self):
        for change, reason in [
            (lambda ability: ability.update(since='catalog/2'), 'get_tree: `since` is not one of its keys'),
            (lambda ability: ability.pop('strict'), 'get_tree: no `strict`'),
            (lambda ability: ability.update(strict='no'), 'get_tree: `strict` that is not a boolean'),
            (lambda ability: ability.update(seats='anon'), "get_tree: `seats: anon` is not one of ['any', 'bound']"),
            (lambda ability: ability.update(phrase=''), 'get_tree: `phrase` that is not words'),
        ]:
            with self.subTest(reason=reason):
                catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
                change(catalog['abilities'][0])
                self.refused(catalog, reason)

    def test_an_ability_that_runs_and_removes_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        connect = next(ability for ability in catalog['abilities'] if ability['name'] == 'connect')
        connect['class'] = 'remove'
        self.refused(catalog, 'connect: an ability that runs at once and removes; a removal is a change of a proposal (§4)')

    def test_an_ability_named_twice_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'].append(catalog['abilities'][0])
        self.refused(catalog, 'get_tree: named twice')

    def test_another_catalog_version_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['catalog'] = 'catalog/3'
        self.refused(catalog, 'the catalog: `catalog/3` where it is `roadmap/1`')

    def test_a_result_schema_outside_the_vocabulary_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['result']['properties']['steps']['items']['properties']['label']['maxLength'] = 200
        self.refused(catalog, 'get_tree → result.steps[].label: `maxLength` is not in the shared vocabulary')

    def test_a_read_whose_result_is_not_held_to_16_KiB_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['result'] = {}
        self.refused(catalog, 'get_tree: a read whose result is not held to 16384 bytes (§5)')


class VectorsTest(unittest.TestCase):
    def refused(self, files, reason):
        here = Path(__file__).parent
        with self.assertRaises(ValueError) as raised:
            check.check_vectors(json.loads((here / 'catalog.json').read_text()), files, check.domain_actions(here / 'domain'))
        self.assertEqual(str(raised.exception), reason)

    def test_a_file_named_for_no_ability_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        self.refused({'set_mark': cases}, 'abilities/set_mark.json: names no ability of the catalog')

    def test_a_case_that_calls_another_ability_than_its_file_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['call']['name'] = 'rename_node'
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: calls `rename_node` in the file of `set_progress`')

    def test_an_input_outside_its_schema_is_refused(self):
        for change, reason in [
            (lambda input: input.update(treeId='Learn to sail'), 'input.treeId: not ^t_[0-9a-f]{16}$'),
            (lambda input: input.update(status='done'), 'input.status: not one of the enum'),
            (lambda input: input.update(outOfOrder=True), 'input.outOfOrder: not a property'),
            (lambda input: input.pop('nodeId'), 'input.nodeId: required'),
        ]:
            with self.subTest(reason=reason):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
                change(cases[0]['call']['input'])
                self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: {reason}')

    def test_a_ref_outside_its_pattern_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('propose_roadmap_change.json').read_text())
        cases[0]['call']['input']['changes'][0]['ref'] = 'hoist'
        self.refused({'propose_roadmap_change': cases}, f'abilities/propose_roadmap_change.json · {cases[0]["case"]}: input.changes[0].ref: not ^new:[a-z0-9][a-z0-9-]{{0,31}}$')

    def test_an_expectation_that_is_not_its_ability_kind_is_refused(self):
        for name, expect, reason in [
            ('set_progress', {'result': {}}, 'a write that expects `result` where it expects `writes`'),
            ('get_progress', {'writes': [{'action': 'Complete', 'input': {}}]}, 'a read that expects `writes` where it expects `result`'),
            ('propose_roadmap_change', {'result': {'proposalId': 'Pq7Rk2Xw9Lm4Nb6T', 'removes': []}}, 'a proposal that expects `result` where it expects `proposal result`'),
            ('set_progress', {'refused': {'code': 'roadmap-not-ready'}, 'writes': []}, 'a refusal beside `writes`'),
        ]:
            with self.subTest(reason=reason):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath(f'{name}.json').read_text())
                cases[0]['expect'] = expect
                self.refused({name: cases}, f'abilities/{name}.json · {cases[0]["case"]}: {reason}')

    def test_a_write_that_is_no_action_of_the_domain_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['expect']['writes'][0]['action'] = 'SetProgress'
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: writes `SetProgress`, which is no action of the domain')

    def test_a_result_is_held_to_16_KiB_of_its_canonical_text(self):
        here = Path(__file__).parent
        cases = json.loads((here / 'abilities' / 'get_progress.json').read_text())
        cases[0]['expect'] = {'result': {'completed': ['é' * 8183]}}
        self.assertEqual(check.check_vectors(json.loads((here / 'catalog.json').read_text()), {'get_progress': cases}, check.domain_actions(here / 'domain')), 1)
        cases[0]['expect'] = {'result': {'completed': ['é' * 8184]}}
        self.refused({'get_progress': cases}, f'abilities/get_progress.json · {cases[0]["case"]}: a result of 16386 bytes, past 16384')

    def test_a_result_with_no_canonical_text_is_refused(self):
        for result, reason in [
            ({'completed': [1.5]}, 'a number with a fraction, which no roadmap answer holds'),
            ({'completed': ['\ud83e']}, 'a lone surrogate, which no canonical text holds'),
        ]:
            with self.subTest(reason=reason):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath('get_progress.json').read_text())
                cases[0]['expect'] = {'result': result}
                self.refused({'get_progress': cases}, f'abilities/get_progress.json · {cases[0]["case"]}: {reason}')

    def test_a_result_outside_its_schema_is_refused(self):
        for change, reason in [
            (lambda page: page['steps'][0].update(state='done'), 'result.steps[0].state: not one of the enum'),
            (lambda page: page['steps'][0].update(color='olive'), 'result.steps[0].color: not a property'),
            (lambda page: page['tree'].update(kinds=[{'id': 'build'}]), 'result.tree.kinds[0].label: required'),
            (lambda page: page.pop('steps'), 'result.steps: required'),
        ]:
            with self.subTest(reason=reason):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath('get_tree.json').read_text())
                change(cases[0]['expect']['result'])
                self.refused({'get_tree': cases}, f'abilities/get_tree.json · {cases[0]["case"]}: {reason}')

    def test_a_page_that_breaks_the_rules_of_pages_is_refused(self):
        for page, change, reason in [
            (0, lambda result: result.update(nextCursor='page-2'), 'a `nextCursor`, `page-2`, that is not index.part.digest'),
            (2, lambda result: result['steps'].reverse(), 'an object in parts that does not start its page'),
            (1, lambda result: result.update(steps=[{**result['steps'][0], 'description': 'Round the post'}, {'id': 'c'}]), 'a part before the last that does not take its page alone'),
            (2, lambda result: result['steps'][0].update(label='Clove hitch'), 'a later part that carries `label`'),
            (1, lambda result: result['steps'][0].update(part=3), 'a part that is not `part` n of `parts` N, N at least 2'),
        ]:
            with self.subTest(reason=reason):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath('get_tree.json').read_text())
                change(cases[1 + page]['expect']['result'])
                self.refused({'get_tree': cases}, f'abilities/get_tree.json · {cases[1 + page]["case"]}: {reason}')

    def test_a_proposal_that_breaks_the_rules_of_minting_is_refused(self):
        for change, reason in [
            (lambda case: case['expect']['result'].update(proposalId='k1x9q2m7p4z8w3r5'), 'a `proposalId` that is not the first id minted'),
            (lambda case: case['given'].pop('ids'), 'a `proposalId` that is not the first id minted'),
            (lambda case: case['expect']['proposal']['changes'][1].update(prerequisites=['new:hoist']), 'a minted change that still holds the ref `new:hoist`'),
            (lambda case: case['expect']['proposal']['changes'][0].update(op='add'), 'a minted change with no `op` of the catalog'),
            (lambda case: case['expect']['result']['removes'].append({'nodeId': 'b'}), 'result.removes[0].label: required'),
        ]:
            with self.subTest(reason=reason):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath('propose_roadmap_change.json').read_text())
                change(cases[0])
                self.refused({'propose_roadmap_change': cases}, f'abilities/propose_roadmap_change.json · {cases[0]["case"]}: {reason}')

    def test_a_refusal_that_breaks_the_rules_of_refusals_is_refused(self):
        for name, refusal, tail in [
            ('set_progress', {'code': 'not ready'}, ': `not ready`, which is no refusal code of §6.1'),
            ('set_progress', {'code': 'roadmap-not-ready', 'at': 0}, ': an `at` on a refusal of no proposal'),
            ('propose_roadmap_change', {'code': 'closes-cycle', 'at': 3}, ': an `at` of 3, past the changes sent'),
            ('set_progress', {'code': 'roadmap-not-ready', 'id': ''}, ': an `id` that is not an id'),
            ('set_progress', {'code': 'roadmap-not-ready', 'why': 'held'}, ' · refused: `why` is not one of its keys'),
        ]:
            with self.subTest(tail=tail):
                cases = json.loads(Path(__file__).with_name('abilities').joinpath(f'{name}.json').read_text())
                cases[0]['expect'] = {'refused': refusal}
                self.refused({name: cases}, f'abilities/{name}.json · {cases[0]["case"]}{tail}')

    def test_a_held_step_of_a_roadmap_not_given_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['given']['held'] = [{'tree': 't_0000000000000009', 'step': 'c'}]
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: a held step of `t_0000000000000009`, a roadmap not given')


class LimitsTest(unittest.TestCase):
    def refused(self, reason, limits=None, header=None, registry=None, rules=None):
        here = Path(__file__).parent
        limits = limits or json.loads((here / 'limits.json').read_text())
        with self.assertRaises(ValueError) as raised:
            check.check_limits(limits, header or (here.parents[2] / limits['backend']).read_text(), registry or json.loads((here.parents[2] / limits['registry']).read_text()),
                               rules or (here.parents[2] / limits['web']).read_text())
        self.assertEqual(str(raised.exception), reason)

    def test_a_cap_the_backend_changed_is_refused(self):
        header = Path(__file__).parents[3].joinpath('backend/products/roadmap/domain/Command.h').read_text().replace('kMaxNodeLabelLength = 200;', 'kMaxNodeLabelLength = 240;')
        self.refused("label: 200 here, 240 in the backend's kMaxNodeLabelLength", header=header)

    def test_a_cap_the_registry_changed_is_refused(self):
        registry = json.loads(Path(__file__).parents[3].joinpath('packages/api-contract/sync/roadmap.registry.json').read_text())
        next(entry for entry in registry['types'] if entry['type'] == 'node')['fields']['links']['domain']['items']['properties']['url']['max'] = 4096
        self.refused("webLinkAddress: 2048 here, 4096 in the registry's node.links.url", registry=registry)

    def test_a_cap_the_web_changed_is_refused(self):
        rules = Path(__file__).parents[3].joinpath('web/src/products/roadmap/domain/roadmapRules.js').read_text()
        self.refused("kindDescription: 80 here, 120 in the web's RoadmapSpecs.kindDescription", rules=rules.replace("chars('kind.description', 80)", "chars('kind.description', 120)"))
        self.refused("webLinks: 32 here, 64 in the web's RoadmapSpecs.links", rules=rules.replace('max: 32 }', 'max: 64 }'))

    def test_a_cap_changed_here_alone_is_refused(self):
        limits = json.loads(Path(__file__).with_name('limits.json').read_text())
        limits['limits']['steps']['max'] = 12000
        self.refused("steps: 12000 here, 10000 in the backend's kMaxNodes", limits=limits)

    def test_a_cap_its_source_does_not_declare_is_refused(self):
        header = Path(__file__).parents[3].joinpath('backend/products/roadmap/domain/Command.h').read_text().replace('kMaxKinds', 'kMaxLegendKinds')
        self.refused('kinds: `kMaxKinds` is no constant of backend/products/roadmap/domain/Command.h', header=header)
        limits = json.loads(Path(__file__).with_name('limits.json').read_text())
        limits['limits']['kinds']['registry'] = 'legend'
        self.refused('kinds: `legend` declares no cap in packages/api-contract/sync/roadmap.registry.json', limits=limits)
        limits = json.loads(Path(__file__).with_name('limits.json').read_text())
        limits['limits']['label']['web'] = 'stepLabel'
        self.refused('label: `stepLabel` is no spec of web/src/products/roadmap/domain/roadmapRules.js', limits=limits)


if __name__ == '__main__':
    unittest.main()
