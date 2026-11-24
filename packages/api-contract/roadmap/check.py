#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

# Roadmap Coach's contract (docs/foundation/roadmap-coach.md): the catalog, its vectors and its caps, each held to the
# tables of the spec and to the sources it names.
ROOT = Path(__file__).parent
REPO = ROOT.parents[2]
SPEC = 'docs/foundation/roadmap-coach.md'
VERSION = 'roadmap/1'
ENTRY = {'name', 'description', 'input', 'result', 'class', 'agent', 'seats', 'strict', 'phrase', 'ui'}
CLASSES = {'read', 'add', 'change', 'remove'}
AGENTS = {'runs', 'proposes', 'withheld'}
SEATS = {'any', 'bound'}
RESULT_BYTES = 16 * 1024
# What the kit's schema checks read (domain-kit.md §9.4) and strict mode accepts (gym-coach-on-ai-service.md §3).
KEYWORDS = {'type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minItems', 'pattern'}
TYPES = {'object', 'array', 'string', 'integer', 'number', 'boolean', 'null'}
# A pattern keeps to explicit classes, which Swift, Kotlin, JavaScript and strict mode all read alike.
QUANTIFIER = re.compile(r'(?<!\\)\{(\d+)(,(\d*))?\}')
QUANTIFIER_RANGE = 64
REF = re.compile(r'^new:[a-z0-9][a-z0-9-]{0,31}$')
CURSOR = re.compile(r'^(0|[1-9][0-9]{0,8})\.[1-9][0-9]{0,8}\.[0-9a-f]{16}$')
# The fields a later part of a paged object carries beside its `id` (§5.2).
LONG = {'description', 'links', 'prerequisites', 'guide', 'frontier'}
# A cap's unit in limits.json, and the unit the registry and the web state it in.
UNITS = {'characters': 'chars', 'bytes': 'bytes', 'items': None}
CONSTANT = re.compile(r'constexpr\s+std::size_t\s+(k\w+)\s*=\s*([^;]+);')
WEB_SPECS = re.compile(r'export const RoadmapSpecs = Object\.freeze\(\{(.*?)\n\}\);', re.S)
WEB_SPEC = re.compile(r"(\w+):\s*(chars|new CountSpec)\(\s*'([^']*)',\s*(?:(\d+)|\{([^}]*)\})")
# A normalized tree as the domain's pure reads take it, every field spelled (abilities/README.md).
TREE = {'id', 'present', 'read', 'own', 'updatedAt', 'parent', 'meta', 'nodes', 'edges', 'kinds', 'marks', 'pointers'}
NODE = ({'id', 'present', 'born', 'rc', 'ru', 'label', 'icon', 'color', 'ord', 'status', 'description', 'links', 'branch'}, {'branchStamp'})
EDGE = ({'from', 'to', 'present'}, set())
KIND = ({'id', 'present', 'born', 'hue', 'label', 'description', 'ord'}, set())
MARK = ({'node', 'status', 'outOfOrder', 'recordedAt', 'deviceAt'}, {'stamp'})
POINTER = ({'node', 'present', 'opens'}, {'setAt'})
# The codes that refuse a whole call, before any change of a proposal folds (§7).
CALL_CODES = {'not-owner', 'roadmap-unavailable', 'unknown-roadmap'}
# The codes §6 refuses a write with before its caps: the roadmap and whether the write may reach it (rules 1 to 3), and
# the rules of its input.
BEFORE_CAPS = CALL_CODES | {'invalid-input', 'roadmap-not-ready', 'out-of-scope'}
# A text the domain cannot store: one that holds U+0000 or a lone surrogate (§6.1, `invalid-input`).
UNSTORABLE = re.compile('[\x00\ud800-\udfff]')
# The white space the domain trims from either end of an address before it measures it, ECMAScript's `trim`, which
# Python's `strip` reads otherwise.
TRIM = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

def refuse(where, reason):
    raise ValueError(f'{where}: {reason}')

def members(value, required, where, optional=frozenset()):
    if not isinstance(value, dict): refuse(where, 'not an object')
    missing = sorted(set(required) - set(value))
    if missing: refuse(where, f'no `{missing[0]}`')
    extra = sorted(set(value) - set(required) - set(optional))
    if extra: refuse(where, f'`{extra[0]}` is not one of its keys')

def scalar(value):
    return value is None or isinstance(value, (str, bool, int, float))

def ticked(cell):
    return re.findall(r'`([^`]+)`', cell)

# The spec's tables the contract is held to: §4's abilities, §5.1's fields, §6's actions and caps, §6.1's codes and
# §7's ops.
class Spec:
    def __init__(self, text):
        self.abilities = {ticked(row[0])[0]: (row[1], row[2]) for row in self.table(text, '## §4 The catalog')}
        fields = self.table(text, '### §5.1 What each read answers')
        self.fields = [ticked(row[0])[0] for row in fields]
        self.states = next(ticked(row[1]) for row in fields if ticked(row[0]) == ['state'])
        self.actions = {ticked(row[0])[0]: ({name for name in ticked(row[1]) if name[0].isupper()}, set(re.findall(r'\w+', row[2]))) for row in self.table(text, '## §6 Writing')}
        self.caps = {ticked(row[0])[0]: {'max': int(row[1]), 'unit': row[2], 'backend': (ticked(row[3]) or [None])[0], 'registry': ticked(row[4]), 'web': (ticked(row[5]) or [None])[0]}
                     for row in self.table(text, '## §6 Writing', 1)}
        self.codes = {ticked(row[0])[0] for row in self.table(text, '### §6.1 Refusals')}
        self.ops = {ticked(row[0])[0]: (ticked(row[1]), ticked(row[2])) for row in self.table(text, '## §7 Proposals')}

    @staticmethod
    def table(text, heading, skip=0):
        if heading not in text: refuse(SPEC, f'no `{heading}`')
        rows, tables, inside = [], [], False
        for line in text[text.index(heading) + len(heading):].split('\n'):
            if line.startswith('#'): break
            line = line.strip()
            if line.startswith('|'):
                cells = [cell.strip() for cell in line.strip('|').split('|')]
                if not inside: inside = True; rows = []
                elif not set(''.join(cells)) <= {'-', ':', ' '}: rows.append(cells)
            elif inside:
                inside = False
                tables.append(rows)
        if inside: tables.append(rows)
        if len(tables) <= skip: refuse(SPEC, f'no table {skip + 1} under `{heading}`')
        return tables[skip]

def check_pattern(pattern, where):
    try: re.compile(pattern)
    except re.error: refuse(where, f'an unknown pattern, `{pattern}`, which does not compile')
    in_class = False
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == '\\':
            escaped = pattern[index + 1:index + 2]
            if escaped.isalnum(): refuse(where, f'an unknown pattern, `{pattern}`: `\\{escaped}`, where the vocabulary escapes punctuation alone')
            index += 2
            continue
        if in_class: in_class = char != ']'
        elif char == '[': in_class = True
        elif char == '.': refuse(where, f'an unknown pattern, `{pattern}`: `.`, where the vocabulary writes each class out')
        elif char == '(' and pattern[index + 1:index + 2] == '?' and pattern[index + 2:index + 3] != ':': refuse(where, f'an unknown pattern, `{pattern}`: a `(?` group other than `(?:`')
        index += 1
    for low, comma, high in QUANTIFIER.findall(pattern):
        if comma and not high or int(high or low) > QUANTIFIER_RANGE: refuse(where, f'an unknown pattern, `{pattern}`: a quantifier range past {QUANTIFIER_RANGE}')

def check_schema(schema, where):
    if not isinstance(schema, dict): refuse(where, 'no schema')
    unknown = sorted(set(schema) - KEYWORDS)
    if unknown: refuse(where, f'`{unknown[0]}` is not in the shared vocabulary')
    kinds = schema['type'] if isinstance(schema.get('type'), list) else [schema.get('type')]
    if not kinds or not all(kind in TYPES for kind in kinds): refuse(where, 'a schema without a known `type`')
    if 'object' in kinds:
        if schema.get('additionalProperties') is not False: refuse(where, 'an object without `additionalProperties: false`')
        if not isinstance(schema.get('required'), list): refuse(where, 'an object without `required`')
        properties = schema.get('properties', {})
        for name in schema['required']:
            if name not in properties: refuse(where, f'`{name}` required but not a property')
        for name, child in properties.items(): check_schema(child, f'{where}.{name}')
    elif 'properties' in schema or 'required' in schema or 'additionalProperties' in schema: refuse(where, 'an object\'s keywords on a schema that is not `type: object`')
    if 'array' in kinds:
        if 'items' not in schema: refuse(where, 'an array without `items`')
        check_schema(schema['items'], f'{where}[]')
    if 'minItems' in schema and (type(schema['minItems']) is not int or schema['minItems'] not in (0, 1)): refuse(where, '`minItems` other than the integer 0 or 1')
    if 'enum' in schema and not (isinstance(schema['enum'], list) and schema['enum'] and all(scalar(item) for item in schema['enum'])): refuse(where, '`enum` that is not a list of scalars')
    if 'const' in schema and not scalar(schema['const']): refuse(where, '`const` that is not a scalar')
    if 'pattern' in schema:
        if not isinstance(schema['pattern'], str): refuse(where, '`pattern` that is not a string')
        check_pattern(schema['pattern'], where)

# What a result schema says beside its `maxBytes`, or None where it says nothing more.
def result_schema(ability):
    shape = {key: value for key, value in ability['result'].items() if key != 'maxBytes'}
    return shape or None

# A value against a schema of the shared vocabulary, as the gate's Shape rule holds a call to it.
def fault(value, schema, where):
    def matches(kind):
        if kind == 'integer': return type(value) is int or type(value) is float and value.is_integer()
        if kind == 'number': return type(value) in (int, float)
        return {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'null': type(None)}[kind] is type(value)
    kinds = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
    if not any(matches(kind) for kind in kinds): return f'{where}: not {schema["type"]}'
    if 'enum' in schema and value not in schema['enum']: return f'{where}: not one of the enum'
    if 'const' in schema and value != schema['const']: return f'{where}: not the constant'
    if isinstance(value, dict):
        properties = schema.get('properties', {})
        for name in schema.get('required', []):
            if name not in value: return f'{where}.{name}: required'
        for name, member in value.items():
            if name not in properties: return f'{where}.{name}: not a property'
            found = fault(member, properties[name], f'{where}.{name}')
            if found: return found
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0): return f'{where}: fewer than {schema["minItems"]} items'
        for index, item in enumerate(value):
            found = fault(item, schema['items'], f'{where}[{index}]')
            if found: return found
    if isinstance(value, str) and 'pattern' in schema and not re.fullmatch(schema['pattern'], value): return f'{where}: not {schema["pattern"]}'
    return None

# The canonical text a page is measured on (abilities/README.md): JCS, for the integers, ASCII keys and text it holds.
def canonical(value, where):
    def walk(item):
        if type(item) is float: refuse(where, 'a number with a fraction, which no roadmap answer holds')
        if isinstance(item, dict):
            for key, member in item.items():
                if not key.isascii(): refuse(where, f'a key past ASCII, `{key}`')
                walk(member)
        if isinstance(item, list):
            for member in item: walk(member)
    walk(value)
    try: return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode()
    except UnicodeEncodeError: refuse(where, 'a lone surrogate, which no canonical text holds')

# A page keeps §5.2's rules a reader can see: its cursor's form, and parts that start a page and fill one alone.
def check_page(page, where):
    if 'nextCursor' in page and not CURSOR.match(page['nextCursor']): refuse(where, f'a `nextCursor`, `{page["nextCursor"]}`, that is not index.part.digest')
    objects = ([page['tree']] if 'tree' in page else []) + page.get('steps', []) + page.get('trees', [])
    for index, item in enumerate(objects):
        if 'part' not in item and 'parts' not in item: continue
        part, parts = item.get('part'), item.get('parts')
        if type(part) is not int or type(parts) is not int or not 1 <= part <= parts or parts < 2: refuse(where, 'a part that is not `part` n of `parts` N, N at least 2')
        if index != 0: refuse(where, 'an object in parts that does not start its page')
        if part < parts and (len(objects) != 1 or 'nextCursor' not in page): refuse(where, 'a part before the last that does not take its page alone')
        extra = sorted(set(item) - {'id', 'part', 'parts'} - LONG)
        if part > 1 and extra: refuse(where, f'a later part that carries `{extra[0]}`')

# Whether a part's piece of a text or a list can be that part of the whole: its start, its end, or a run within it.
def within(piece, whole, part, parts):
    if part == 1: return whole[:len(piece)] == piece
    if part == parts: return len(piece) <= len(whole) and whole[len(whole) - len(piece):] == piece
    return any(whole[start:start + len(piece)] == piece for start in range(len(whole) - len(piece) + 1))

# What a read answers of a step, held to the step the case gives, where a field is the step's own value (§5.1).
def check_projection(item, node, where):
    for field in ['description', 'links']:
        if field not in item: continue
        if 'part' not in item and item[field] != node[field]: refuse(where, f'`{item["id"]}`\'s {field}, which is not the step\'s')
        if 'part' in item and not within(item[field], node[field], item['part'], item['parts']): refuse(where, f'`{item["id"]}`\'s {field} in part {item["part"]}, which is not that part of the step\'s')
    if 'label' in item and item['label'] != node['label']: refuse(where, f'`{item["id"]}`\'s label, which is not the step\'s')
    if 'summary' in item and item['summary'] != (node['description'][:160] + '…' if len(node['description']) > 160 else node['description']): refuse(where, f'`{item["id"]}`\'s summary, which is not its description cut after 160 characters')

# The room's actions, and the inputs the domain corpus gives each: the keys every case holds, and every key one holds.
class Actions:
    def __init__(self, directory):
        self.shapes = {}
        for path in sorted(directory.glob('*-actions.json')):
            for case in json.loads(path.read_text()):
                if 'action' not in case['input']: continue
                keys = set(case['input']['input'])
                required, allowed = self.shapes.get(case['input']['action'], (keys, set()))
                self.shapes[case['input']['action']] = (required & keys, allowed | keys)

class Contract:
    def __init__(self, catalog, spec, limits, header, registry, rules, files, actions):
        self.catalog, self.spec, self.limits, self.header, self.registry, self.rules, self.files, self.actions = catalog, spec, limits, header, registry, rules, files, actions

    @staticmethod
    def read():
        limits = json.loads((ROOT / 'limits.json').read_text())
        return Contract(json.loads((ROOT / 'catalog.json').read_text()), Spec((REPO / SPEC).read_text()), limits, (REPO / limits['backend']).read_text(),
                        json.loads((REPO / limits['registry']).read_text()), (REPO / limits['web']).read_text(),
                        {path.stem: json.loads(path.read_text()) for path in (ROOT / 'abilities').glob('*.json')}, Actions(ROOT / 'domain'))

    def check(self):
        self.check_catalog()
        self.check_limits()
        return self.check_vectors()

    def ability(self, name):
        return next(ability for ability in self.catalog['abilities'] if ability['name'] == name)

    # --- the catalog
    def check_catalog(self):
        catalog, spec = self.catalog, self.spec
        members(catalog, {'catalog', 'abilities'}, 'the catalog')
        if catalog['catalog'] != VERSION: refuse('the catalog', f'`{catalog["catalog"]}` where it is `{VERSION}`')
        if not isinstance(catalog['abilities'], list): refuse('the catalog', '`abilities` that is not a list')
        names = []
        for ability in catalog['abilities']:
            where = ability.get('name') if isinstance(ability, dict) and isinstance(ability.get('name'), str) else 'an ability'
            if not isinstance(ability, dict) or 'input' not in ability: refuse(where, 'no input schema')
            members(ability, ENTRY, where)
            if where in names: refuse(where, 'named twice')
            names.append(where)
            for text in ['description', 'phrase', 'ui']:
                if not isinstance(ability[text], str) or not ability[text]: refuse(where, f'`{text}` that is not words')
            for key, words in [('class', CLASSES), ('agent', AGENTS), ('seats', SEATS)]:
                if ability[key] not in words: refuse(where, f'`{key}: {ability[key]}` is not one of {sorted(words)}')
            if type(ability['strict']) is not bool: refuse(where, '`strict` that is not a boolean')
            if ability['agent'] == 'runs' and ability['class'] == 'remove': refuse(where, 'an ability that runs at once and removes; a removal is a change of a proposal (§4)')
            if (ability['class'], ability['agent']) != spec.abilities.get(where, (ability['class'], ability['agent'])): refuse(where, f'`{ability["class"]}` and `{ability["agent"]}`, where §4 has `{spec.abilities[where][0]}` and `{spec.abilities[where][1]}`')
            if ability['seats'] != 'any' or ability['strict'] is not False: refuse(where, 'seats other than `any` or a strict tool, where §4 offers every ability signed out and none strict')
            if not isinstance(ability['input'], dict) or ability['input'].get('type') != 'object': refuse(where, 'an input schema that is not `type: object`')
            check_schema(ability['input'], where)
            if not isinstance(ability['result'], dict): refuse(where, 'a result schema that is not an object')
            bound = ability['result'].get('maxBytes')
            if ability['class'] == 'read' and bound != RESULT_BYTES: refuse(where, f'a read whose result is not held to {RESULT_BYTES} bytes (§5)')
            if ability['class'] != 'read' and bound is not None: refuse(where, 'a `maxBytes` on an answer that is no read\'s')
            if result_schema(ability) is None: refuse(where, 'an answer with no schema, where §4 states every ability\'s')
            check_schema(result_schema(ability), f'{where} → result')
        if sorted(names) != sorted(spec.abilities): refuse('the catalog', f'abilities {sorted(set(names) ^ set(spec.abilities))} in one of the catalog and §4 alone')
        self.check_reads()
        self.check_writes()
        self.check_ops()
        hues = next(entry for entry in self.registry['types'] if entry['type'] == 'kind')['fields']['hue']['domain']['enum']
        colors = next(entry for entry in self.registry['types'] if entry['type'] == 'node')['fields']['color']['domain']['enum']
        if colors != hues: refuse(self.limits['registry'], f'step colours {colors}, where its kinds\' hues are {hues}')
        for where, schema in [('propose_roadmap_change.changes[].hue', self.change_schema()['properties']['hue']), ('get_tree → result.tree.kinds[].hue', self.ability('get_tree')['result']['properties']['tree']['properties']['kinds']['items']['properties']['hue'])]:
            if schema['enum'] != hues: refuse(where, f'hues {schema["enum"]}, where the registry has {hues}')

    def check_reads(self):
        for ability in self.catalog['abilities']:
            if ability['class'] != 'read': continue
            if ability['input']['properties'].get('cursor', {}).get('pattern') != CURSOR.pattern: refuse(ability['name'], f'a `cursor` whose pattern is not §5.2\'s, `{CURSOR.pattern}`')
        for name in ['get_tree', 'get_nodes', 'find_nodes']:
            ability = self.ability(name)
            if ability['input']['properties']['fields']['items']['enum'] != self.spec.fields: refuse(name, f'`fields` other than §5.1\'s, {self.spec.fields}')
            step = ability['result']['properties']['steps']['items']
            if sorted(set(step['properties']) - {'part', 'parts'}) != sorted(self.spec.fields): refuse(name, 'an answered step whose fields are not §5.1\'s')
            if step['properties']['state']['enum'] != self.spec.states: refuse(name, f'states other than §5.1\'s, {self.spec.states}')

    def check_writes(self):
        for name, (actions, answer) in self.spec.actions.items():
            ability = self.ability(name)
            if sorted(ability['result']['properties']) != sorted(answer): refuse(name, f'an answer of {sorted(ability["result"]["properties"])}, where §6 answers {sorted(answer)}')
        writes = sorted(ability['name'] for ability in self.catalog['abilities'] if ability['agent'] == 'runs' and ability['class'] != 'read')
        if writes != sorted(self.spec.actions): refuse('the catalog', f'direct writes {writes}, where §6 names the actions of {sorted(self.spec.actions)}')

    def change_schema(self):
        return self.ability('propose_roadmap_change')['input']['properties']['changes']['items']

    def check_ops(self):
        propose, change = self.ability('propose_roadmap_change'), self.change_schema()
        if change['properties']['op']['enum'] != list(self.spec.ops): refuse('propose_roadmap_change', f'ops other than §7\'s, {list(self.spec.ops)}')
        named = sorted({field for required, optional in self.spec.ops.values() for field in required + optional} | {'op'})
        if sorted(change['properties']) != named: refuse('propose_roadmap_change', f'change fields {sorted(change["properties"])}, where §7 names {named}')
        if propose['input']['properties']['changes'].get('minItems') != 1: refuse('propose_roadmap_change', '`changes` without `minItems: 1`, where §7 takes one to 100')
        for ref in [change['properties']['ref'], change['properties']['parts']['items']['properties']['ref']]:
            if ref.get('pattern') != REF.pattern: refuse('propose_roadmap_change', f'a `ref` whose pattern is not §7\'s, `{REF.pattern}`')
        lines = {}
        for line in propose['description'].split('\n'):
            found = re.match(r'^([a-z_]+): required ([^;]+); optional ([^.]+)\.', line)
            if found: lines[found[1]] = (found[2].split(', '), [] if found[3] == 'none' else found[3].split(', '))
        for op, (required, optional) in self.spec.ops.items():
            if op not in lines: refuse('propose_roadmap_change', f'no line `{op}: required …; optional …` in the description')
            if lines[op] != (required, optional): refuse('propose_roadmap_change', f'the line of `{op}` says required {lines[op][0]}, optional {lines[op][1]}, where §7 has {required} and {optional}')
        extra = sorted(set(lines) - set(self.spec.ops))
        if extra: refuse('propose_roadmap_change', f'a line for `{extra[0]}`, which is no op of §7')

    # --- the caps
    def check_limits(self):
        limits, spec = self.limits, self.spec
        members(limits, {'backend', 'registry', 'web', 'limits'}, 'limits.json')
        if sorted(limits['limits']) != sorted(spec.caps): refuse('limits.json', f'caps {sorted(set(limits["limits"]) ^ set(spec.caps))} in one of limits.json and §6 alone')
        constants = {}
        for name, value in CONSTANT.findall(self.header):
            if name in constants: refuse(limits['backend'], f'`{name}` defined twice')
            constants[name] = value.strip()
        block = WEB_SPECS.search(self.rules)
        if block is None: refuse(limits['web'], 'no `RoadmapSpecs`')
        specs = {}
        for name, kind, path, chars, braces in WEB_SPEC.findall(block[1]):
            if name in specs: refuse(limits['web'], f'`RoadmapSpecs.{name}` defined twice')
            count = re.search(r'max:\s*(\d+)', braces or '')
            specs[name] = (path, 'chars' if kind == 'chars' else None, int(chars) if chars else int(count[1]) if count else None)
        for name, limit in limits['limits'].items():
            members(limit, {'max', 'unit', 'registry'}, name, {'backend', 'web'})
            stated = {'max': limit['max'], 'unit': limit['unit'], 'backend': limit.get('backend'), 'registry': limit['registry'], 'web': limit.get('web')}
            if stated != spec.caps[name]: refuse(name, f'{stated} here, where §6 has {spec.caps[name]}')
            if type(limit['max']) is not int or limit['max'] < 1: refuse(name, '`max` that is not a positive integer')
            if limit['unit'] not in UNITS: refuse(name, f'`unit: {limit["unit"]}` is not one of {sorted(UNITS)}')
            if 'backend' in limit:
                if limit['backend'] not in constants: refuse(name, f'`{limit["backend"]}` is no constant of {limits["backend"]}')
                if not constants[limit['backend']].isdigit(): refuse(name, f'`{limit["backend"]}` is `{constants[limit["backend"]]}`, not a number')
                if int(constants[limit['backend']]) != limit['max']: refuse(name, f'{limit["max"]} here, {constants[limit["backend"]]} in the backend\'s {limit["backend"]}')
            for reference in limit['registry']:
                declared = self.registry_cap(reference, limit['unit'])
                if declared is None: refuse(name, f'`{reference}` declares no cap in {limits["registry"]}')
                if declared[1] != UNITS[limit['unit']]: refuse(name, f'{limit["unit"]} here, {declared[1]} in the registry\'s {reference}')
                if declared[0] != limit['max']: refuse(name, f'{limit["max"]} here, {declared[0]} in the registry\'s {reference}')
            if 'web' not in limit: continue
            if limit['web'] not in specs: refuse(name, f'`{limit["web"]}` is no spec of {limits["web"]}')
            path, unit, value = specs[limit['web']]
            if path != limit['registry'][0]: refuse(name, f'the web\'s RoadmapSpecs.{limit["web"]} holds `{path}`, where the registry\'s is `{limit["registry"][0]}`')
            if unit != UNITS[limit['unit']]: refuse(name, f'{limit["unit"]} here, {unit or "items"} in the web\'s RoadmapSpecs.{limit["web"]}')
            if value != limit['max']: refuse(name, f'{limit["max"]} here, {value} in the web\'s RoadmapSpecs.{limit["web"]}')

    # The cap a registry path declares, and the unit it counts in: a type's count, an id's length, a field's length or
    # items, or the length of a property of a field's items.
    def registry_cap(self, reference, unit):
        type_name, *path = reference.split('.')
        entry = next((entry for entry in self.registry['types'] if entry['type'] == type_name), None)
        if entry is None: return None
        if not path: return None if entry.get('cap') is None else (entry['cap'], None)
        if path == ['id']: return None if 'idDomain' not in entry else (entry['idDomain'].get('max'), entry['idDomain'].get('unit'))
        field = entry['fields'].get(path[0], {})
        if len(path) == 2: field = field.get('domain', {}).get('items', {}).get('properties', {}).get(path[1], {})
        if unit == 'items': return None if 'maxItems' not in field.get('domain', {}) else (field['domain']['maxItems'], None)
        return None if 'max' not in field else (field['max'], field.get('unit'))

    # --- the vectors
    def check_vectors(self):
        cases = 0
        for name, file in sorted(self.files.items()):
            if name not in [ability['name'] for ability in self.catalog['abilities']]: refuse(f'abilities/{name}.json', 'names no ability of the catalog')
            if not isinstance(file, list) or not file: refuse(f'abilities/{name}.json', 'not a list of cases')
            for case in file:
                self.check_case(self.ability(name), case, f'abilities/{name}.json · {case.get("case") if isinstance(case, dict) else "a case"}')
                cases += 1
        return cases

    def check_case(self, ability, case, where):
        members(case, {'case', 'about', 'given', 'call', 'expect'}, where)
        if not isinstance(case['case'], str) or not case['case']: refuse(where, 'a case that is not named')
        self.check_given(case, where)
        members(case['call'], {'name', 'input'}, f'{where} · call')
        if case['call']['name'] != ability['name']: refuse(where, f'calls `{case["call"]["name"]}` in the file of `{ability["name"]}`')
        expect = case['expect']
        if not isinstance(expect, dict): refuse(where, 'an expectation that is not an object')
        code = expect['refused'].get('code') if isinstance(expect.get('refused'), dict) else None
        found = fault(case['call']['input'], ability['input'], 'input')
        if found and code != 'invalid-input': refuse(where, found)
        if self.over_cap(ability, case['call']['input']) and code not in BEFORE_CAPS | {'over-limit'}: refuse(where, 'an input past a cap of limits.json that is not refused as `over-limit`, nor by a rule §6 checks before the caps')
        if self.unstorable(ability, case['call']['input']) and code not in BEFORE_CAPS: refuse(where, 'a text the domain cannot store that is not refused as `invalid-input`')
        if 'refused' in expect: return self.check_refusal(ability, case, where, found)
        kind = 'proposal' if ability['agent'] == 'proposes' else 'read' if ability['class'] == 'read' else 'write'
        wanted = {'read': [['result']], 'proposal': [['proposal', 'result'], ['folded', 'proposal', 'result']], 'write': [['result', 'writes']]}[kind]
        if sorted(expect) not in wanted: refuse(where, f'a {kind} that expects `{" ".join(sorted(expect))}` where it expects `{" ".join(wanted[0])}`')
        result = fault(expect['result'], result_schema(ability), 'result')
        if result: refuse(where, result)
        if kind == 'proposal': return self.check_proposal(case, where)
        if kind == 'write': return self.check_write(ability, case, where)
        size = len(canonical(expect['result'], where))
        if size > ability['result']['maxBytes']: refuse(where, f'a result of {size} bytes, past {ability["result"]["maxBytes"]}')
        check_page(expect['result'], where)
        tree = next((tree for tree in case['given']['trees'] if tree['id'] == case['call']['input'].get('treeId')), None)
        if tree is None: return
        nodes = {node['id']: node for node in tree['nodes']}
        sequence = {'get_tree': 1 + sum(node['present'] for node in tree['nodes']), 'get_nodes': len(case['call']['input'].get('nodeIds', [])), 'find_nodes': sum(node['present'] for node in tree['nodes'])}.get(ability['name'])
        if sequence is not None and 'nextCursor' in expect['result'] and int(expect['result']['nextCursor'].split('.')[0]) >= sequence: refuse(where, f'a `nextCursor` past the {sequence} objects of the read\'s sequence')
        for item in expect['result'].get('steps', []):
            if item['id'] not in nodes or not nodes[item['id']]['present']: refuse(where, f'a step `{item["id"]}` the roadmap does not hold')
            check_projection(item, nodes[item['id']], where)
        header = expect['result'].get('tree')
        if header and 'stepCount' in header and header['stepCount'] != sum(node['present'] for node in tree['nodes']): refuse(where, f'a `stepCount` of {header["stepCount"]}, where the roadmap holds {sum(node["present"] for node in tree["nodes"])} steps')
        if header and 'title' in header and header['title'] != tree['meta']['title']: refuse(where, 'a header whose title is not the roadmap\'s')

    def check_given(self, case, where):
        members(case['given'], {'trees'}, f'{where} · given', {'held', 'ids'})
        trees = case['given']['trees']
        if not isinstance(trees, list): refuse(where, '`trees` that are not a list')
        for tree in trees:
            members(tree, TREE, f'{where} · a given tree')
            for key, (required, optional) in [('nodes', NODE), ('edges', EDGE), ('kinds', KIND), ('marks', MARK), ('pointers', POINTER)]:
                for item in tree[key]: members(item, required, f'{where} · {tree["id"]}.{key}', optional)
        ids = [tree['id'] for tree in trees]
        if len(set(ids)) != len(ids): refuse(where, 'a roadmap given twice')
        if case['about'] is not None and case['about'] not in ids: refuse(where, f'`about` names `{case["about"]}`, a roadmap not given')
        for held in case['given'].get('held', []):
            members(held, {'tree', 'step'}, f'{where} · held')
            if held['tree'] not in ids: refuse(where, f'a held step of `{held["tree"]}`, a roadmap not given')
            node = next((node for node in trees[ids.index(held['tree'])]['nodes'] if node['id'] == held['step']), None)
            if node is None or node['present']: refuse(where, f'a held step `{held["step"]}` that its roadmap does not hold as removed')
        minted = case['given'].get('ids', [])
        if not isinstance(minted, list) or not all(isinstance(id, str) and id for id in minted) or len(set(minted)) != len(minted): refuse(where, '`ids` that are not distinct ids')

    # Whether a value the call sends passes a cap of limits.json, which the ability must refuse as `over-limit`.
    def over_cap(self, ability, input):
        if ability['name'] != 'propose_roadmap_change': return ability['class'] != 'read' and self.step_over(input)
        changes = input.get('changes') if isinstance(input.get('changes'), list) else []
        caps = self.limits['limits']
        return self.change_over(changes) is not None or len(changes) > caps['proposalChanges']['max'] or len(canonical(changes, ability['name'])) > caps['proposalChangesBytes']['max']

    # A value is measured as the domain stores it: an address after its trim, every text in Unicode code points.
    def step_over(self, fields, kind=False):
        caps = {name: limit['max'] for name, limit in self.limits['limits'].items()}
        def text(value, cap): return isinstance(value, str) and len(value) > caps[cap]
        if kind: return text(fields.get('label'), 'kindLabel') or text(fields.get('description'), 'kindDescription')
        links = fields.get('links') if isinstance(fields.get('links'), list) else []
        def address(link): return link.get('url').strip(TRIM) if isinstance(link.get('url'), str) else None
        return (text(fields.get('label'), 'label') or text(fields.get('description'), 'description') or len(links) > caps['webLinks']
                or any(isinstance(link, dict) and (text(address(link), 'webLinkAddress') or text(link.get('label'), 'webLinkLabel')) for link in links))

    # Whether a direct write sends a text the domain cannot store.
    def unstorable(self, ability, fields):
        if ability['agent'] != 'runs' or ability['class'] == 'read': return False
        links = fields.get('links') if isinstance(fields.get('links'), list) else []
        texts = [fields.get('label'), fields.get('description')] + [value for link in links if isinstance(link, dict) for value in (link.get('url'), link.get('label'))]
        return any(isinstance(text, str) and UNSTORABLE.search(text) for text in texts)

    # Whether a direct write would pass its roadmap's caps of steps or links (§6 rule 4), counted alive as the engine
    # counts them: each step present or under a delete the person can still undo, and each live link.
    def count_over(self, ability, case):
        input = case['call']['input']
        tree = next((tree for tree in case['given']['trees'] if tree['id'] == input.get('treeId')), None)
        if tree is None or ability['name'] not in ('create_node', 'connect'): return False
        held = {each['step'] for each in case['given'].get('held', []) if each['tree'] == tree['id']}
        steps = sum(1 for node in tree['nodes'] if node['present'] or node['id'] in held)
        links = sum(1 for edge in tree['edges'] if edge['present'])
        adding = (1, len(set(input.get('prerequisites', [])))) if ability['name'] == 'create_node' else (0, 1)
        caps = self.limits['limits']
        return steps + adding[0] > caps['steps']['max'] or links + adding[1] > caps['links']['max']

    # The index of the first change that sends a value past a cap, or None.
    def change_over(self, changes):
        for index, change in enumerate(changes):
            if not isinstance(change, dict): continue
            parts = change.get('parts') if isinstance(change.get('parts'), list) else []
            if self.step_over(change, change.get('op') in ('add_kind', 'rename_kind')) or any(isinstance(part, dict) and self.step_over(part) for part in parts): return index
        return None

    def check_refusal(self, ability, case, where, shape):
        beside = sorted(set(case['expect']) - {'refused'})
        if beside: refuse(where, f'a refusal beside `{beside[0]}`')
        refusal = case['expect']['refused']
        members(refusal, {'code'}, f'{where} · refused', {'at', 'id'})
        code, input, given = refusal['code'], case['call']['input'], case['given']
        if code not in self.spec.codes: refuse(where, f'`{code}`, which is no refusal code of §6.1')
        if 'id' in refusal and (not isinstance(refusal['id'], str) or not refusal['id']): refuse(where, 'an `id` that is not an id')
        trees = {tree['id']: tree for tree in given['trees']}
        tree = trees.get(input.get('treeId'))
        if code == 'unknown-roadmap' and tree is not None: refuse(where, '`unknown-roadmap` for a roadmap the case gives')
        if code == 'roadmap-unavailable' and (tree is None or tree['read'] != 'unread'): refuse(where, '`roadmap-unavailable` for a roadmap the device holds whole')
        if code == 'not-owner' and (tree is None or tree['own']): refuse(where, '`not-owner` for a roadmap the person owns')
        if code == 'out-of-scope' and case['about'] in (None, input.get('treeId')): refuse(where, '`out-of-scope` for a write to the conversation\'s roadmap')
        if code == 'roadmap-not-ready' and refusal.get('id') not in {held['step'] for held in given.get('held', [])}: refuse(where, '`roadmap-not-ready` that names no held step')
        if code == 'over-limit' and not (self.over_cap(ability, input) or self.count_over(ability, case)): refuse(where, '`over-limit` for a call that passes no cap of limits.json')
        if ability['agent'] != 'proposes':
            if 'at' in refusal: refuse(where, 'an `at` on a refusal of no proposal')
            if code == 'over-limit':
                named = None if ability['name'] == 'create_node' else input.get('nodeId')
                wanted = named if self.step_over(input) else input.get('treeId')
                def said(id): return f'`{id}`' if id is not None else 'none'
                if refusal.get('id') != wanted: refuse(where, f'an `over-limit` that names {said(refusal.get("id"))}, where §6.1 names {said(wanted)}')
            return
        changes = input.get('changes') if isinstance(input.get('changes'), list) else []
        count = self.limits['limits']['proposalChanges']['max']
        first = self.change_over(changes) if code == 'over-limit' else None
        at = first if first is not None and first < count else count if code == 'over-limit' and len(changes) > count else None
        whole = code in CALL_CODES or code == 'over-limit' and at is None
        if whole and 'at' in refusal: refuse(where, f'an `at` on `{code}`, which refuses the whole call')
        if whole: return
        if 'at' not in refusal: refuse(where, f'no `at` on `{code}`, which refuses a change')
        if type(refusal['at']) is not int or not 0 <= refusal['at'] < len(changes): refuse(where, f'an `at` of {refusal["at"]}, past the changes sent')
        if at is not None and refusal['at'] != at: refuse(where, f'an `at` of {refusal["at"]} on `over-limit`, where change {at} is the first past a cap')
        if code == 'over-limit' and at == count and 'id' in refusal: refuse(where, 'an `id` on a refusal of the count of changes')
        shaped = re.match(r'^input\.changes\[(\d+)\]', shape or '')
        if shaped and int(shaped[1]) != refusal['at']: refuse(where, f'an `at` of {refusal["at"]} on a Shape refusal of changes[{shaped[1]}]')

    def check_write(self, ability, case, where):
        writes, result, ids = case['expect']['writes'], case['expect']['result'], case['given'].get('ids', [])
        allowed = self.spec.actions[ability['name']][0]
        if not isinstance(writes, list) or not writes: refuse(where, 'writes that are not a list of actions')
        for write in writes:
            members(write, {'action', 'input'}, f'{where} · writes')
            if write['action'] not in self.actions.shapes: refuse(where, f'writes `{write["action"]}`, which is no action of the domain')
            if write['action'] not in allowed: refuse(where, f'writes `{write["action"]}`, where §6 gives {ability["name"]} {sorted(allowed)}')
            required, keys = self.actions.shapes[write['action']]
            if not isinstance(write['input'], dict) or not required <= set(write['input']) <= keys: refuse(where, f'a `{write["action"]}` whose input is not of the shape the domain\'s cases give it')
        if ability['name'] == 'create_node' and (ids[:1] != [result['nodeId']] or writes[0]['input'].get('id') != result['nodeId'] or len(ids) != 1):
            refuse(where, 'a new step whose id is not the one id minted')

    def check_proposal(self, case, where):
        expect, changes, ids = case['expect'], case['call']['input']['changes'], case['given'].get('ids', [])
        if not ids or expect['result']['proposalId'] != ids[0]: refuse(where, 'a `proposalId` that is not the first id minted')
        members(expect['proposal'], {'changes'}, f'{where} · proposal')
        refs = {}
        for change in changes:
            for given in [change.get('ref')] + [part.get('ref') for part in change.get('parts', [])]:
                if given is not None: refs[given] = ids[1 + len(refs)] if 1 + len(refs) < len(ids) else None
        if len(ids) != 1 + len(refs) or None in refs.values(): refuse(where, f'{len(ids)} ids minted, where the proposal and its {len(refs)} refs take {1 + len(refs)}')
        def minted(value):
            if isinstance(value, str): return refs.get(value, value)
            if isinstance(value, list): return [minted(item) for item in value]
            return {('kind' if key == 'ref' and value.get('op') == 'add_kind' else 'nodeId' if key == 'ref' else key): minted(member) for key, member in value.items()}
        if expect['proposal']['changes'] != [minted(change) for change in changes]: refuse(where, 'a record whose changes are not the call\'s with each ref under its minted id')
        removed = []
        for change in changes:
            if change['op'] in ('remove_step', 'split'): removed.append(minted(change['nodeId']))
            if change['op'] == 'merge': removed.append(minted(change['removeId']))
        if [entry['nodeId'] for entry in expect['result']['removes']] != removed: refuse(where, f'removes of {[entry["nodeId"] for entry in expect["result"]["removes"]]}, where the changes remove {removed}')
        tree = next((tree for tree in case['given']['trees'] if tree['id'] == case['call']['input']['treeId']), None)
        nodes = {node['id']: node for node in tree['nodes']} if tree else {}
        entries, named = iter(expect['result']['removes']), set()
        for change in changes:
            if change['op'] in ('remove_step', 'split', 'merge'):
                entry = next(entries)
                node = nodes.get(entry['nodeId'])
                if node and entry['nodeId'] not in named and (entry['label'], entry['descriptionChars'], entry['links']) != (node['label'], len(node['description']), len(node['links'])):
                    refuse(where, f'a removes entry for `{entry["nodeId"]}` that is not the step as the roadmap holds it')
            named |= {minted(change[field]) for field in ('nodeId', 'removeId') if field in change}
        if any(change['op'] == 'recolor_kind' for change in changes) and 'folded' not in expect: refuse(where, 'a recolour with no `folded` colours pinned')
        if 'folded' in expect:
            members(expect['folded'], {'kinds', 'steps'}, f'{where} · folded')
            hues = [kind['hue'] for kind in expect['folded']['kinds']]
            if len(set(hues)) != len(hues): refuse(where, 'folded kinds that share a hue')

if __name__ == '__main__':
    try:
        contract = Contract.read()
        cases = contract.check()
    except ValueError as error: sys.exit(str(error))
    print(f'{len(contract.catalog["abilities"])} abilities of {VERSION} as §4 lists them, in the shared vocabulary; {len(contract.limits["limits"])} caps as §6, '
          f'the backend, the registry and the web hold them; {cases} vectors in {len(contract.files)} files well formed')
