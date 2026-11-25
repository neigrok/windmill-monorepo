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
# The context (§5): its cases' file, the fields of a step's line and of a step in full, and the codes it refuses with.
# Its bounds are limits.json's `context`, held to §5's table.
CONTEXT = 'abilities/context.json'
LINE = ['id', 'label', 'kind', 'state', 'prerequisites', 'unlockCount', 'summary']
IN_FULL = ['id', 'label', 'kind', 'state', 'prerequisites', 'unlockCount', 'description', 'links', 'opens']
CONTEXT_CODES = {'roadmap-unavailable', 'unknown-roadmap'}

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
        self.bounds = {ticked(row[0])[0]: {'max': int(row[1]), 'unit': row[2]} for row in self.table(text, '## §5 Reading')}

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
# A context case's roadmap may give its steps, links and marks as a table, `{columns, rows}`, each row one record's values
# in the columns' order (abilities/README.md, The context): spelled here as the records the rest of the check reads.
def spelled(given, where):
    for tree in given.get('trees', []) if isinstance(given, dict) and isinstance(given.get('trees'), list) else []:
        for key in ('nodes', 'edges', 'marks'):
            table = tree.get(key) if isinstance(tree, dict) else None
            if not isinstance(table, dict): continue
            members(table, {'columns', 'rows'}, f'{where} · {tree.get("id")}.{key}')
            if any(not isinstance(row, list) or len(row) != len(table['columns']) for row in table['rows']): refuse(where, f'a row of {tree.get("id")}.{key} that does not hold a value for each column')
            tree[key] = [dict(zip(table['columns'], row)) for row in table['rows']]

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
    def __init__(self, catalog, spec, limits, header, registry, rules, files, context, actions):
        self.catalog, self.spec, self.limits, self.header, self.registry, self.rules, self.files, self.context, self.actions = catalog, spec, limits, header, registry, rules, files, context, actions

    @staticmethod
    def read():
        limits = json.loads((ROOT / 'limits.json').read_text())
        return Contract(json.loads((ROOT / 'catalog.json').read_text()), Spec((REPO / SPEC).read_text()), limits, (REPO / limits['backend']).read_text(),
                        json.loads((REPO / limits['registry']).read_text()), (REPO / limits['web']).read_text(),
                        {path.stem: json.loads(path.read_text()) for path in (ROOT / 'abilities').glob('*.json') if path.name != Path(CONTEXT).name},
                        json.loads((ROOT / CONTEXT).read_text()), Actions(ROOT / 'domain'))

    def check(self):
        self.check_catalog()
        self.check_limits()
        return self.check_vectors() + self.check_context()

    # A bound of the context, as limits.json holds it.
    def bound(self, name):
        return self.limits['context'][name]['max']

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
        members(limits, {'backend', 'registry', 'web', 'limits', 'context'}, 'limits.json')
        if limits['context'] != spec.bounds: refuse('limits.json', f'context bounds {limits["context"]}, where §5 has {spec.bounds}')
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
        if self.over_cap(ability, case['call']['input']) and code not in ('over-limit', 'invalid-input'): refuse(where, 'an input past a cap of limits.json that is not refused as `over-limit`')
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

    def step_over(self, fields, kind=False):
        caps = {name: limit['max'] for name, limit in self.limits['limits'].items()}
        def text(value, cap): return isinstance(value, str) and len(value) > caps[cap]
        if kind: return text(fields.get('label'), 'kindLabel') or text(fields.get('description'), 'kindDescription')
        links = fields.get('links') if isinstance(fields.get('links'), list) else []
        return (text(fields.get('label'), 'label') or text(fields.get('description'), 'description') or len(links) > caps['webLinks']
                or any(isinstance(link, dict) and (text(link.get('url'), 'webLinkAddress') or text(link.get('label'), 'webLinkLabel')) for link in links))

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
        if code == 'over-limit' and not self.over_cap(ability, input): refuse(where, '`over-limit` for a call that passes no cap of limits.json')
        if ability['agent'] != 'proposes':
            if 'at' in refusal: refuse(where, 'an `at` on a refusal of no proposal')
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

    # --- the context
    def check_context(self):
        if not isinstance(self.context, list) or not self.context: refuse(CONTEXT, 'not a list of cases')
        for case in self.context:
            where = f'{CONTEXT} · {case.get("case") if isinstance(case, dict) else "a case"}'
            members(case, {'case', 'about', 'step', 'given', 'expect'}, where)
            if not isinstance(case['case'], str) or not case['case']: refuse(where, 'a case that is not named')
            spelled(case['given'], where)
            self.check_given(case, where)
            tree = next((tree for tree in case['given']['trees'] if tree['id'] == case['about']), None)
            if case['step'] is not None and tree is None: refuse(where, 'a conversation about all roadmaps started from a step')
            if case['step'] is not None and case['step'] not in {node['id'] for node in tree['nodes']}: refuse(where, f'a conversation started from `{case["step"]}`, a step its roadmap does not hold')
            expect = case['expect']
            if not isinstance(expect, dict) or sorted(expect) not in (['refused'], ['result']): refuse(where, 'an expectation that is neither a result nor a refusal')
            if 'refused' in expect: self.check_context_refusal(case, tree, where)
            elif tree is None: self.check_rows(case, where)
            else: self.check_roadmap_context(case, tree, where)
        return len(self.context)

    # What Coach is told of all the person's roadmaps: whole rows of list_trees' shape, never paged, each with at most the
    # first ten titles of its frontier and `frontierOmitted` counting the rest of its available steps where there are more;
    # taken while the context stays within CONTEXT_BYTES, and `omitted`, no more than the roadmaps of theirs the case gives.
    def check_rows(self, case, where):
        result = case['expect']['result']
        members(result, {'trees', 'omitted'}, where)
        found = fault({'trees': [{key: value for key, value in row.items() if key != 'frontierOmitted'} for row in result['trees']]},
                      result_schema(self.ability('list_trees')), 'result')
        if found: refuse(where, found)
        for row in result['trees']:
            members(row, {'id', 'title', 'counts', 'frontier', 'lastCompletedAt'}, f'{where} · trees', {'frontierOmitted'})
            frontier, left = row['frontier'] or [], row.get('frontierOmitted')
            if len(frontier) > self.bound('frontier') or left is not None and (type(left) is not int or left < 1 or len(frontier) < self.bound('frontier')): refuse(where, f'`{row["id"]}`\'s frontier, which is not its first {self.bound("frontier")} titles and a count of the rest from one')
            if row['counts'] is not None and len(frontier) + (left or 0) != row['counts']['available']: refuse(where, f'`{row["id"]}`\'s frontier and the titles left off, which are not its {row["counts"]["available"]} available steps')
        own = sum(1 for tree in case['given']['trees'] if tree['own'])
        if type(result['omitted']) is not int or result['omitted'] < 0 or len(result['trees']) + result['omitted'] > own: refuse(where, f'{len(result["trees"])} rows and {result["omitted"]} left off, of {own} roadmaps the person owns')
        size = len(canonical(result, where))
        if result['trees'] and size > self.bound('bytes'): refuse(where, f'a context of {size} bytes about all roadmaps, past CONTEXT_BYTES, {self.bound("bytes")}')

    def check_context_refusal(self, case, tree, where):
        members(case['expect']['refused'], {'code'}, f'{where} · refused', {'id'})
        code = case['expect']['refused']['code']
        if code not in CONTEXT_CODES: refuse(where, f'`{code}`, which the context does not refuse with')
        if code == 'roadmap-unavailable' and tree is not None and tree['read'] != 'unread': refuse(where, '`roadmap-unavailable` for a roadmap the device holds whole')
        if case['expect']['refused'].get('id', case['about']) != case['about']: refuse(where, 'a refusal that names a roadmap other than the conversation\'s')

    # What Coach is told of one roadmap: its header with its guides, its diagnostics' summary and newest dated completions,
    # and either every step's line and completion, within the bounds, or its counts and the lines around its frontier while
    # the context stays within CONTEXT_BYTES; and a step in full where the conversation started from one the roadmap shows.
    def check_roadmap_context(self, case, tree, where):
        result, nodes = case['expect']['result'], {node['id']: node for node in tree['nodes']}
        present = [node for node in tree['nodes'] if node['present']]
        whole = 'counts' not in result
        members(result, {'tree', 'steps', 'diagnostics', 'recent'} | ({'completed'} if whole else {'counts', 'omitted'}), where, {'step'})
        members(result['tree'], {'id', 'title', 'kinds', 'guides'}, f'{where} · tree', {'guidesOmitted'} if not whole else set())
        if (result['tree']['id'], result['tree']['title']) != (tree['id'], tree['meta']['title']): refuse(where, 'a header that is not the roadmap\'s')
        found = fault(result['tree']['kinds'], self.ability('get_tree')['result']['properties']['tree']['properties']['kinds'], 'result.tree.kinds')
        if found: refuse(where, found)
        self.check_guides(result['tree']['guides'], result['tree'].get('guidesOmitted'), tree, where)
        for item in result['steps']:
            found = fault(item, self.ability('get_tree')['result']['properties']['steps']['items'], 'result.steps[]')
            if found: refuse(where, found)
            if sorted(item) != sorted(LINE): refuse(where, f'`{item["id"]}`\'s line, whose fields are not §5.1\'s default')
            if item['id'] not in nodes or not nodes[item['id']]['present']: refuse(where, f'a step `{item["id"]}` the roadmap does not hold')
            check_projection(item, nodes[item['id']], where)
        told = canonical(result, where)
        if whole and len(result['steps']) != len(present): refuse(where, f'{len(result["steps"])} lines of a roadmap given whole, where it holds {len(present)} steps')
        if whole and len(present) > self.bound('steps'): refuse(where, f'a roadmap of {len(present)} steps given whole, past {self.bound("steps")}')
        if whole and len(told) > self.bound('bytes'): refuse(where, f'a context of {len(told)} bytes given whole, past CONTEXT_BYTES, {self.bound("bytes")}')
        if whole:
            found = fault(result['completed'], {'type': 'array', 'items': self.ability('get_progress')['result']['properties']['completed']['items']}, 'result.completed')
            if found: refuse(where, found)
        else:
            self.check_counts(result['counts'], len(present), [kind['id'] for kind in result['tree']['kinds']], where)
            if type(result['omitted']) is not int or result['omitted'] < 0 or len(result['steps']) + result['omitted'] > len(present): refuse(where, f'{len(result["steps"])} lines and {result["omitted"]} left off, of a roadmap of {len(present)} steps')
            if result['steps'] and len(told) > self.bound('bytes'): refuse(where, f'a context of {len(told)} bytes given around where the person stands, past CONTEXT_BYTES, {self.bound("bytes")}')
        members(result['diagnostics'], {'cycles', 'dangling', 'selfEdges', 'smells'} | ({'treeLoops', 'danglingPointers'} if tree['own'] else set()), f'{where} · diagnostics')
        recent = result['recent']
        if len(recent) > self.bound('recent'): refuse(where, f'{len(recent)} newest completions, past {self.bound("recent")}')
        for item in recent:
            members(item, {'id', 'label', 'at'}, f'{where} · recent')
            if type(item['at']) is not int or item['id'] not in nodes or item['label'] != nodes[item['id']]['label']: refuse(where, f'a newest completion `{item["id"]}` that is not a dated step of the roadmap')
        if recent != sorted(recent, key=lambda item: (-item['at'], item['id'].encode())): refuse(where, 'newest completions that are not newest first, and in id byte order at one date')
        shown = case['step'] is not None and nodes[case['step']]['present']
        if shown != ('step' in result): refuse(where, 'a step in full where the conversation started from no step the roadmap shows' if not shown else 'no step in full, where the conversation started from a step the roadmap shows')
        if shown:
            step, cap = result['step'], self.bound('prerequisites')
            if sorted(set(step) - {'prerequisitesOmitted'}) != sorted(IN_FULL) or step['id'] != case['step']: refuse(where, 'a step in full that is not the step started from with every field of §5.1 but its summary')
            left = step.get('prerequisitesOmitted')
            if len(step['prerequisites']) > cap or left is not None and (type(left) is not int or left < 1 or len(step['prerequisites']) < cap): refuse(where, f'a step in full whose prerequisites are not their first {cap} ids and a count of the rest from one')
            check_projection(step, nodes[case['step']], where)

    # The guides Coach reads, as the server's get_tree gives them: each `{treeId, title, text, yours}`; on a roadmap the
    # person owns, at most eight, farthest first, so its own last where it has one; on one they only read, its own alone.
    # Those that gave way, from the farthest, are counted in `guidesOmitted`, from one, beside the guides that stay.
    def check_guides(self, guides, omitted, tree, where):
        if omitted is not None and (type(omitted) is not int or omitted < 1): refuse(where, '`guidesOmitted` that is not a count from one')
        left = omitted or 0
        if not isinstance(guides, list) or len(guides) + left > 8: refuse(where, 'guides that are not a list of at most eight, those left off counted in')
        for guide in guides:
            members(guide, {'treeId', 'title', 'text', 'yours'}, f'{where} · tree.guides')
            if not all(isinstance(guide[key], str) for key in ('treeId', 'title', 'text')) or type(guide['yours']) is not bool or not guide['text']: refuse(where, f'a guide of `{guide["treeId"]}` that is not its words')
        own = tree['meta']['guide']
        mine = {'treeId': tree['id'], 'title': tree['meta']['title'], 'text': own}
        if tree['own'] and own and guides and {key: guides[-1][key] for key in mine} != mine: refuse(where, 'guides whose last is not the roadmap\'s own')
        alone = [{**mine, 'yours': False}] if own else []
        if not tree['own'] and guides != alone[left:]: refuse(where, 'guides of a roadmap the person only reads other than its own alone, not theirs')

    def check_counts(self, counts, total, kinds, where):
        states = ['total', 'done', 'available', 'locked', 'unknown']
        members(counts, set(states) | {'byKind'}, f'{where} · counts')
        if counts['total'] != total or sum(counts[state] for state in states[1:]) != total: refuse(where, f'counts of {counts["total"]} steps, where the roadmap holds {total}')
        for row in counts['byKind']: members(row, set(states) | {'kind'}, f'{where} · counts.byKind')
        if [row['kind'] for row in counts['byKind']] not in (kinds, kinds + [None]): refuse(where, 'counts by kind other than one row for each kind in the room\'s order, then the steps no kind owns')
        if any(sum(row[state] for row in counts['byKind']) != counts[state] for state in states): refuse(where, 'counts by kind that do not add up to the roadmap\'s')

if __name__ == '__main__':
    try:
        contract = Contract.read()
        cases = contract.check()
    except ValueError as error: sys.exit(str(error))
    print(f'{len(contract.catalog["abilities"])} abilities of {VERSION} as §4 lists them, in the shared vocabulary; {len(contract.limits["limits"])} caps as §6, '
          f'the backend, the registry and the web hold them; {cases} vectors in {len(contract.files) + 1} files well formed, the context\'s among them')
