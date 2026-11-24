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
        check.check_limits(limits, (here.parents[2] / limits['backend']).read_text(), json.loads((here.parents[2] / limits['registry']).read_text()))
        files = {path.stem: json.loads(path.read_text()) for path in (here / 'abilities').glob('*.json')}
        self.assertEqual(check.check_vectors(catalog, files, check.domain_actions(here / 'domain')), sum(len(cases) for cases in files.values()))

    def test_an_ability_with_no_input_schema_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        del catalog['abilities'][0]['input']
        self.refused(catalog, 'get_nodes: no input schema')

    def test_an_input_that_is_not_an_object_schema_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['input'] = {'type': 'string'}
        self.refused(catalog, 'get_nodes: an input schema that is not `type: object`')

    def test_a_bound_outside_the_vocabulary_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        rename = next(ability for ability in catalog['abilities'] if ability['name'] == 'rename_node')
        rename['input']['properties']['label']['maxLength'] = 200
        self.refused(catalog, 'rename_node.label: `maxLength` is not in the shared vocabulary')

    def test_a_union_is_refused_since_the_kit_checks_none(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['input']['properties']['cursor'] = {'anyOf': [{'type': 'string'}, {'type': 'null'}]}
        self.refused(catalog, 'get_nodes.cursor: `anyOf` is not in the shared vocabulary')

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
                self.refused(catalog, f'get_nodes.treeId: {reason}')

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
            (lambda ability: ability.update(since='catalog/2'), 'get_nodes: `since` is not one of its keys'),
            (lambda ability: ability.pop('strict'), 'get_nodes: no `strict`'),
            (lambda ability: ability.update(strict='no'), 'get_nodes: `strict` that is not a boolean'),
            (lambda ability: ability.update(seats='anon'), "get_nodes: `seats: anon` is not one of ['any', 'bound']"),
            (lambda ability: ability.update(phrase=''), 'get_nodes: `phrase` that is not words'),
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
        self.refused(catalog, 'get_nodes: named twice')

    def test_another_catalog_version_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['catalog'] = 'catalog/3'
        self.refused(catalog, 'the catalog: `catalog/3` where it is `roadmap/1`')

    def test_a_read_whose_result_is_not_held_to_16_KiB_is_refused(self):
        catalog = json.loads(Path(__file__).with_name('catalog.json').read_text())
        catalog['abilities'][0]['result'] = {}
        self.refused(catalog, 'get_nodes: a read whose result is not held to 16384 bytes (§5)')


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

    def test_an_expectation_that_is_not_one_result_writes_or_refusal_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['expect']['refused'] = 'roadmap-not-ready'
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: an expectation that is not one of a result, writes or a refusal')

    def test_a_write_that_is_no_action_of_the_domain_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['expect']['writes'][0]['action'] = 'SetProgress'
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: writes `SetProgress`, which is no action of the domain')

    def test_a_write_that_expects_a_result_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['expect'] = {'result': {}}
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: a write that expects no writes')

    def test_a_read_that_expects_writes_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('get_progress.json').read_text())
        cases[0]['expect'] = {'writes': [{'action': 'Complete', 'input': {}}]}
        self.refused({'get_progress': cases}, f'abilities/get_progress.json · {cases[0]["case"]}: a read that expects no result')

    def test_a_result_is_held_to_16_KiB_of_its_json_as_utf8(self):
        here = Path(__file__).parent
        cases = json.loads((here / 'abilities' / 'get_progress.json').read_text())
        cases[0]['expect'] = {'result': {'completed': ['é' * 8183]}}
        self.assertEqual(check.check_vectors(json.loads((here / 'catalog.json').read_text()), {'get_progress': cases}, check.domain_actions(here / 'domain')), 1)
        cases[0]['expect'] = {'result': {'completed': ['é' * 8184]}}
        self.refused({'get_progress': cases}, f'abilities/get_progress.json · {cases[0]["case"]}: a result of 16386 bytes, past 16384')

    def test_a_held_step_of_a_roadmap_not_given_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['given']['held'] = [{'tree': 't_0000000000000009', 'step': 'c'}]
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: a held step of `t_0000000000000009`, a roadmap not given')

    def test_a_refusal_that_is_not_a_code_is_refused(self):
        cases = json.loads(Path(__file__).with_name('abilities').joinpath('set_progress.json').read_text())
        cases[0]['expect'] = {'refused': 'Not ready'}
        self.refused({'set_progress': cases}, f'abilities/set_progress.json · {cases[0]["case"]}: a refusal that is not a code')


class LimitsTest(unittest.TestCase):
    def refused(self, limits, header, registry, reason):
        with self.assertRaises(ValueError) as raised: check.check_limits(limits, header, registry)
        self.assertEqual(str(raised.exception), reason)

    def test_a_cap_the_backend_changed_is_refused(self):
        here = Path(__file__).parent
        limits = json.loads((here / 'limits.json').read_text())
        header = (here.parents[2] / limits['backend']).read_text().replace('kMaxNodeLabelLength = 200;', 'kMaxNodeLabelLength = 240;')
        self.refused(limits, header, json.loads((here.parents[2] / limits['registry']).read_text()),
                     "label: 200 here, 240 in the backend's kMaxNodeLabelLength")

    def test_a_cap_the_registry_changed_is_refused(self):
        here = Path(__file__).parent
        limits = json.loads((here / 'limits.json').read_text())
        registry = json.loads((here.parents[2] / limits['registry']).read_text())
        next(entry for entry in registry['types'] if entry['type'] == 'node')['fields']['links']['domain']['items']['properties']['url']['max'] = 4096
        self.refused(limits, (here.parents[2] / limits['backend']).read_text(), registry, "webLinkAddress: 2048 here, 4096 in the registry's node.links.url")

    def test_a_cap_changed_here_alone_is_refused(self):
        here = Path(__file__).parent
        limits = json.loads((here / 'limits.json').read_text())
        limits['limits']['steps']['max'] = 12000
        self.refused(limits, (here.parents[2] / limits['backend']).read_text(), json.loads((here.parents[2] / limits['registry']).read_text()),
                     "steps: 12000 here, 10000 in the backend's kMaxNodes")

    def test_a_cap_the_backend_does_not_declare_is_refused(self):
        here = Path(__file__).parent
        limits = json.loads((here / 'limits.json').read_text())
        header = (here.parents[2] / limits['backend']).read_text().replace('kMaxKinds', 'kMaxLegendKinds')
        self.refused(limits, header, json.loads((here.parents[2] / limits['registry']).read_text()),
                     'kinds: `kMaxKinds` is no constant of backend/products/roadmap/domain/Command.h')

    def test_a_cap_the_registry_does_not_declare_is_refused(self):
        here = Path(__file__).parent
        limits = json.loads((here / 'limits.json').read_text())
        limits['limits']['kinds']['registry'] = 'legend'
        self.refused(limits, (here.parents[2] / limits['backend']).read_text(), json.loads((here.parents[2] / limits['registry']).read_text()),
                     'kinds: `legend` declares no cap in packages/api-contract/sync/roadmap.registry.json')


if __name__ == '__main__':
    unittest.main()
