#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

# Anthropic's strict tool use, read at platform.claude.com/docs/en/build-with-claude/structured-outputs on 2026-11-22.
STRICT_TOOLS = 20
OPTIONAL_PARAMETERS = 24
UNION_PARAMETERS = 16
KEYWORDS = {'type', 'description', 'title', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minItems', 'pattern', 'format', 'default', 'anyOf'}
BESIDE_ANY_OF = {'anyOf', 'description', 'title'}
TYPES = {'object', 'array', 'string', 'integer', 'number', 'boolean', 'null'}
FORMATS = {'date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'}
# The docs accept "simple {n,m} cases" and refuse "complex {n,m} quantifiers with large ranges"; this is the bound held to.
QUANTIFIER_RANGE = 64
PATTERN_REFUSED = re.compile(r'\\[1-9bB]|\(\?[=!<]')
QUANTIFIER = re.compile(r'(?<!\\)\{(\d+)(,(\d*))?\}')
SEATS = {'bound': lambda ability: True, 'anon': lambda ability: ability['seats'] != 'bound'}
ROOT = Path(__file__).parent

def refuse(where, reason):
    raise ValueError(f'{where}: {reason}')

def types_of(schema):
    return schema['type'] if isinstance(schema.get('type'), list) else [schema.get('type')]

def union(schema):
    return len(types_of(schema)) > 1 or 'anyOf' in schema

def scalar(value):
    return value is None or isinstance(value, (str, bool, int, float))

def parameters(schema, where):
    if not isinstance(schema, dict): refuse(where, 'a schema that is not an object')
    for key in schema:
        if key not in KEYWORDS: refuse(where, f'strict mode refuses `{key}`')
    if 'anyOf' in schema and set(schema) - BESIDE_ANY_OF: refuse(where, '`anyOf` beside ' + ', '.join(f'`{key}`' for key in sorted(set(schema) - BESIDE_ANY_OF)))
    shaped = 'properties' in schema or 'required' in schema or 'additionalProperties' in schema
    if 'anyOf' not in schema and not shaped and not all(kind in TYPES for kind in types_of(schema)): refuse(where, 'a schema without a known `type`')
    if 'minItems' in schema and (type(schema['minItems']) is not int or schema['minItems'] not in (0, 1)): refuse(where, '`minItems` other than the integer 0 or 1')
    if 'enum' in schema and not (isinstance(schema['enum'], list) and all(scalar(item) for item in schema['enum'])): refuse(where, '`enum` holding other than scalars')
    if 'const' in schema and not scalar(schema['const']): refuse(where, '`const` that is not a scalar')
    if 'format' in schema and schema['format'] not in FORMATS: refuse(where, f'unsupported format `{schema["format"]}`')
    if 'pattern' in schema:
        if PATTERN_REFUSED.search(schema['pattern']): refuse(where, 'a pattern with a backreference, lookaround or word boundary')
        for low, comma, high in QUANTIFIER.findall(schema['pattern']):
            if comma and not high or int(high or low) > QUANTIFIER_RANGE: refuse(where, f'a pattern quantifier range past {QUANTIFIER_RANGE}')
    if shaped or 'object' in types_of(schema):
        if schema.get('type') != 'object': refuse(where, 'an object schema without `type: object`')
        if schema.get('additionalProperties') is not False: refuse(where, 'an object without `additionalProperties: false`')
        if not isinstance(schema.get('required'), list): refuse(where, 'an object without `required`')
        properties = schema.get('properties', {})
        for name in schema['required']:
            if name not in properties: refuse(where, f'`{name}` required but not a property')
        for name, child in properties.items():
            yield f'{where}.{name}', name not in schema['required'], isinstance(child, dict) and union(child)
            yield from parameters(child, f'{where}.{name}')
    if 'items' in schema:
        if union(schema['items']): yield f'{where}[]', False, True
        yield from parameters(schema['items'], f'{where}[]')
    for index, branch in enumerate(schema.get('anyOf', [])): yield from parameters(branch, f'{where}|{index}')

def counts(catalog):
    counted = {}
    for ability in catalog['abilities']:
        if ability['input'].get('type') != 'object': refuse(ability['name'], 'an input that is not `type: object`')
        counted[ability['name']] = list(parameters(ability['input'], ability['name']))
    seats = {}
    for seat, admits in SEATS.items():
        tools = [a['name'] for a in catalog['abilities'] if a['agent'] != 'withheld' and a.get('declared', True) and admits(a)]
        seats[seat] = {'tools': len(tools),
                       'optional': sum(1 for name in tools for _, optional, _ in counted[name] if optional),
                       'union': sum(1 for name in tools for _, _, is_union in counted[name] if is_union)}
    return seats

def check(catalog):
    lines = []
    for seat, count in counts(catalog).items():
        lines.append(f'{seat}: {count["tools"]} strict tools (of {STRICT_TOOLS}), {count["optional"]} optional parameters (of {OPTIONAL_PARAMETERS}), {count["union"]} union-typed parameters (of {UNION_PARAMETERS})')
        if count['tools'] > STRICT_TOOLS: refuse(seat, f'{count["tools"]} strict tools')
        if count['optional'] > OPTIONAL_PARAMETERS: refuse(seat, f'{count["optional"]} optional parameters')
        if count['union'] > UNION_PARAMETERS: refuse(seat, f'{count["union"]} union-typed parameters')
    return lines

# A value against a schema strict mode accepts: the keywords above, and nothing a catalog/3 input cannot hold.
def fault(value, schema, where=''):
    def matches(kind):
        if kind == 'integer': return type(value) is int or type(value) is float and value.is_integer()
        if kind == 'number': return type(value) in (int, float)
        return {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'null': type(None)}[kind] is type(value)
    if 'anyOf' in schema:
        return None if any(fault(value, branch, where) is None for branch in schema['anyOf']) else f'{where}: matches no branch'
    if not any(matches(kind) for kind in types_of(schema)): return f'{where}: not {schema["type"]}'
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
            found = fault(item, schema.get('items', {'type': list(TYPES)}), f'{where}[{index}]')
            if found: return found
    if isinstance(value, str) and 'pattern' in schema and not re.fullmatch(schema['pattern'], value): return f'{where}: not {schema["pattern"]}'
    return None

def corpora(catalog, directory):
    inputs = {ability['name']: ability['input'] for ability in catalog['abilities']}
    cases = 0
    for path in sorted(directory.glob('*.json')):
        for case in json.loads(path.read_text()):
            name = case['call']['name']
            if path.stem != name: refuse(f'{path.name} · {case["case"]}', f'calls {name}')
            found = fault(case['call']['input'], inputs[name], name)
            if found: refuse(f'{path.name} · {case["case"]}', found)
            cases += 1
    return f'{cases} corpus inputs stand inside their schemas'

if __name__ == '__main__':
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'catalog-3.json'
    try:
        catalog = json.loads(path.read_text())
        lines = check(catalog)
        if len(sys.argv) == 1: lines.append(corpora(catalog, ROOT / 'abilities-3'))
        print('\n'.join(lines))
    except ValueError as error: sys.exit(f'{path.name}: {error}')
