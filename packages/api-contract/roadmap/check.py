#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

# Roadmap Coach's contract (docs/foundation/roadmap-coach.md §3, §4, §6): the catalog, its vectors and its caps.
ROOT = Path(__file__).parent
REPO = ROOT.parents[2]
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
UNITS = {'characters', 'items'}
CONSTANT = re.compile(r'constexpr\s+std::size_t\s+(k\w+)\s*=\s*(\d+)\s*;')
WEB_SPEC = re.compile(r"^\s*(\w+): (?:chars\('[^']*', (\d+)|new CountSpec\('[^']*', \{[^}]*max: (\d+))", re.M)
# The codes an ability refuses with (roadmap-coach.md §6.1).
CODES = {'roadmap-not-ready', 'not-owner', 'out-of-scope', 'over-limit', 'unknown-step', 'closes-cycle', 'unknown-kind', 'address-not-allowed',
         'opens-roadmap', 'hue-taken', 'kind-exists', 'invalid-input', 'unknown-roadmap', 'roadmap-changed', 'roadmap-unavailable', 'no-change'}
REF = re.compile(r'^new:[a-z0-9][a-z0-9-]{0,31}$')
CURSOR = re.compile(r'^(0|[1-9][0-9]{0,8})\.([1-9][0-9]{0,8})\.[0-9a-f]{16}$')
# The fields a later part of a paged object carries beside its `id` (§5.2).
LONG = {'description', 'links', 'prerequisites', 'guide'}

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

def check_catalog(catalog):
    members(catalog, {'catalog', 'abilities'}, 'the catalog')
    if catalog['catalog'] != VERSION: refuse('the catalog', f'`{catalog["catalog"]}` where it is `{VERSION}`')
    if not isinstance(catalog['abilities'], list): refuse('the catalog', '`abilities` that is not a list')
    names = set()
    for ability in catalog['abilities']:
        where = ability.get('name') if isinstance(ability, dict) and isinstance(ability.get('name'), str) else 'an ability'
        if not isinstance(ability, dict) or 'input' not in ability: refuse(where, 'no input schema')
        members(ability, ENTRY, where)
        if where in names: refuse(where, 'named twice')
        names.add(where)
        for text in ['description', 'phrase', 'ui']:
            if not isinstance(ability[text], str) or not ability[text]: refuse(where, f'`{text}` that is not words')
        for key, words in [('class', CLASSES), ('agent', AGENTS), ('seats', SEATS)]:
            if ability[key] not in words: refuse(where, f'`{key}: {ability[key]}` is not one of {sorted(words)}')
        if type(ability['strict']) is not bool: refuse(where, '`strict` that is not a boolean')
        if ability['agent'] == 'runs' and ability['class'] == 'remove': refuse(where, 'an ability that runs at once and removes; a removal is a change of a proposal (§4)')
        if not isinstance(ability['input'], dict) or ability['input'].get('type') != 'object': refuse(where, 'an input schema that is not `type: object`')
        check_schema(ability['input'], where)
        if not isinstance(ability['result'], dict): refuse(where, 'a result schema that is not an object')
        bound = ability['result'].get('maxBytes')
        if ability['class'] == 'read' and bound != RESULT_BYTES: refuse(where, f'a read whose result is not held to {RESULT_BYTES} bytes (§5)')
        if bound is not None and (type(bound) is not int or bound < 1): refuse(where, '`maxBytes` that is not a positive integer')
        shape = result_schema(ability)
        if shape is not None: check_schema(shape, f'{where} → result')

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

# A page of steps keeps §5.2's rules a reader can see: its cursor's form, and parts that start a page and fill one alone.
def check_page(page, where):
    if 'nextCursor' in page and not CURSOR.match(page['nextCursor']): refuse(where, f'a `nextCursor`, `{page["nextCursor"]}`, that is not index.part.digest')
    objects = ([page['tree']] if 'tree' in page else []) + page.get('steps', [])
    for index, item in enumerate(objects):
        if 'part' not in item and 'parts' not in item: continue
        part, parts = item.get('part'), item.get('parts')
        if type(part) is not int or type(parts) is not int or not 1 <= part <= parts or parts < 2: refuse(where, 'a part that is not `part` n of `parts` N, N at least 2')
        if index != 0: refuse(where, 'an object in parts that does not start its page')
        if part < parts and (len(objects) != 1 or 'nextCursor' not in page): refuse(where, 'a part before the last that does not take its page alone')
        extra = sorted(set(item) - {'id', 'part', 'parts'} - LONG)
        if part > 1 and extra: refuse(where, f'a later part that carries `{extra[0]}`')

# The actions the room's own controls run, as the domain corpus names them: the only writes an ability returns (INV-2).
def domain_actions(directory):
    return {case['input']['action'] for path in directory.glob('*-actions.json') for case in json.loads(path.read_text()) if 'action' in case['input']}

def check_refusal(ability, case, where):
    beside = sorted(set(case['expect']) - {'refused'})
    if beside: refuse(where, f'a refusal beside `{beside[0]}`')
    refusal = case['expect']['refused']
    members(refusal, {'code'}, f'{where} · refused', {'at', 'id'})
    if refusal['code'] not in CODES: refuse(where, f'`{refusal["code"]}`, which is no refusal code of §6.1')
    if 'id' in refusal and (not isinstance(refusal['id'], str) or not refusal['id']): refuse(where, 'an `id` that is not an id')
    if 'at' not in refusal: return
    if ability['agent'] != 'proposes': refuse(where, 'an `at` on a refusal of no proposal')
    if type(refusal['at']) is not int or not 0 <= refusal['at'] < len(case['call']['input']['changes']): refuse(where, f'an `at` of {refusal["at"]}, past the changes sent')

def check_proposal(ability, case, where):
    found = fault(case['expect']['result'], result_schema(ability), 'result')
    if found: refuse(where, found)
    ids = case['given'].get('ids', [])
    if not ids or case['expect']['result']['proposalId'] != ids[0]: refuse(where, 'a `proposalId` that is not the first id minted')
    members(case['expect']['proposal'], {'changes'}, f'{where} · proposal')
    operations = ability['input']['properties']['changes']['items']['properties']['op']['enum']
    def refs(value):
        if isinstance(value, str): return [value] if REF.match(value) else []
        if isinstance(value, dict): return [ref for member in value.values() for ref in refs(member)]
        if isinstance(value, list): return [ref for member in value for ref in refs(member)]
        return []
    for change in case['expect']['proposal']['changes']:
        if not isinstance(change, dict) or change.get('op') not in operations: refuse(where, 'a minted change with no `op` of the catalog')
        left = refs(change)
        if left: refuse(where, f'a minted change that still holds the ref `{left[0]}`')

def check_case(ability, case, where, actions):
    members(case, {'case', 'about', 'given', 'call', 'expect'}, where)
    if not isinstance(case['case'], str) or not case['case']: refuse(where, 'a case that is not named')
    if case['about'] is not None and not isinstance(case['about'], str): refuse(where, '`about` that is neither a roadmap\'s id nor null')
    members(case['given'], {'trees'}, f'{where} · given', {'held', 'ids'})
    trees = case['given']['trees']
    if not isinstance(trees, list) or not all(isinstance(tree, dict) and isinstance(tree.get('id'), str) for tree in trees): refuse(where, '`trees` that are not roadmaps with an id')
    ids = [tree['id'] for tree in trees]
    if len(set(ids)) != len(ids): refuse(where, 'a roadmap given twice')
    for held in case['given'].get('held', []):
        members(held, {'tree', 'step'}, f'{where} · held')
        if held['tree'] not in ids: refuse(where, f'a held step of `{held["tree"]}`, a roadmap not given')
    minted = case['given'].get('ids', [])
    if not isinstance(minted, list) or not all(isinstance(id, str) and id for id in minted) or len(set(minted)) != len(minted): refuse(where, '`ids` that are not distinct ids')
    members(case['call'], {'name', 'input'}, f'{where} · call')
    if case['call']['name'] != ability['name']: refuse(where, f'calls `{case["call"]["name"]}` in the file of `{ability["name"]}`')
    found = fault(case['call']['input'], ability['input'], 'input')
    if found: refuse(where, found)
    expect = case['expect']
    if not isinstance(expect, dict): refuse(where, 'an expectation that is not an object')
    if 'refused' in expect: return check_refusal(ability, case, where)
    kind = 'proposal' if ability['agent'] == 'proposes' else 'read' if ability['class'] == 'read' else 'write'
    wanted = {'read': ['result'], 'proposal': ['proposal', 'result'], 'write': ['writes']}[kind]
    if sorted(expect) != wanted: refuse(where, f'a {kind} that expects `{" ".join(sorted(expect))}` where it expects `{" ".join(wanted)}`')
    if kind == 'proposal': return check_proposal(ability, case, where)
    if kind == 'read':
        shape = result_schema(ability)
        found = shape and fault(expect['result'], shape, 'result')
        if found: refuse(where, found)
        size = len(canonical(expect['result'], where))
        if size > ability['result']['maxBytes']: refuse(where, f'a result of {size} bytes, past {ability["result"]["maxBytes"]}')
        if isinstance(expect['result'], dict) and 'steps' in expect['result']: check_page(expect['result'], where)
        return
    if not isinstance(expect['writes'], list) or not expect['writes']: refuse(where, 'writes that are not a list of actions')
    for write in expect['writes']:
        members(write, {'action', 'input'}, f'{where} · writes')
        if write['action'] not in actions: refuse(where, f'writes `{write["action"]}`, which is no action of the domain')

def check_vectors(catalog, files, actions):
    abilities = {ability['name']: ability for ability in catalog['abilities']}
    cases = 0
    for name, file in sorted(files.items()):
        if name not in abilities: refuse(f'abilities/{name}.json', 'names no ability of the catalog')
        if not isinstance(file, list) or not file: refuse(f'abilities/{name}.json', 'not a list of cases')
        for case in file:
            check_case(abilities[name], case, f'abilities/{name}.json · {case.get("case") if isinstance(case, dict) else "a case"}', actions)
            cases += 1
    return cases

def registry_max(registry, reference):
    type_name, *path = reference.split('.')
    entry = next((entry for entry in registry['types'] if entry['type'] == type_name), None)
    if entry is None: return None
    if not path: return entry.get('cap')
    if path == ['id']: return entry.get('idDomain', {}).get('max')
    field = entry['fields'].get(path[0], {})
    if len(path) == 1: return field.get('max', field.get('domain', {}).get('maxItems'))
    return field.get('domain', {}).get('items', {}).get('properties', {}).get(path[1], {}).get('max')

def check_limits(limits, header, registry, rules):
    members(limits, {'backend', 'registry', 'web', 'limits'}, 'limits.json')
    constants = {name: int(value) for name, value in CONSTANT.findall(header)}
    specs = {name: int(chars or count) for name, chars, count in WEB_SPEC.findall(rules)}
    for name, limit in limits['limits'].items():
        members(limit, {'max', 'unit', 'backend', 'registry'}, name, {'web'})
        if type(limit['max']) is not int or limit['max'] < 1: refuse(name, '`max` that is not a positive integer')
        if limit['unit'] not in UNITS: refuse(name, f'`unit: {limit["unit"]}` is not one of {sorted(UNITS)}')
        if limit['backend'] not in constants: refuse(name, f'`{limit["backend"]}` is no constant of {limits["backend"]}')
        if constants[limit['backend']] != limit['max']: refuse(name, f'{limit["max"]} here, {constants[limit["backend"]]} in the backend\'s {limit["backend"]}')
        declared = registry_max(registry, limit['registry'])
        if declared is None: refuse(name, f'`{limit["registry"]}` declares no cap in {limits["registry"]}')
        if declared != limit['max']: refuse(name, f'{limit["max"]} here, {declared} in the registry\'s {limit["registry"]}')
        if 'web' not in limit: continue
        if limit['web'] not in specs: refuse(name, f'`{limit["web"]}` is no spec of {limits["web"]}')
        if specs[limit['web']] != limit['max']: refuse(name, f'{limit["max"]} here, {specs[limit["web"]]} in the web\'s RoadmapSpecs.{limit["web"]}')

if __name__ == '__main__':
    try:
        catalog = json.loads((ROOT / 'catalog.json').read_text())
        check_catalog(catalog)
        limits = json.loads((ROOT / 'limits.json').read_text())
        check_limits(limits, (REPO / limits['backend']).read_text(), json.loads((REPO / limits['registry']).read_text()), (REPO / limits['web']).read_text())
        files = {path.stem: json.loads(path.read_text()) for path in (ROOT / 'abilities').glob('*.json')}
        cases = check_vectors(catalog, files, domain_actions(ROOT / 'domain'))
    except ValueError as error: sys.exit(str(error))
    print(f'{len(catalog["abilities"])} abilities of {VERSION} in the shared vocabulary; {len(limits["limits"])} caps as the backend, the registry '
          f'and the web hold them; {cases} vectors in {len(files)} files well formed')
