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
FORMATS = {'date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'}
PATTERN_REFUSED = re.compile(r'\\[1-9bB]|\(\?[=!<]')
SEATS = {'bound': lambda ability: True, 'anon': lambda ability: ability['seats'] != 'bound'}

def refuse(where, reason):
    raise ValueError(f'{where}: {reason}')

def parameters(schema, where):
    for key in schema:
        if key not in KEYWORDS: refuse(where, f'strict mode refuses `{key}`')
    if 'anyOf' in schema and ('type' in schema or 'properties' in schema): refuse(where, '`anyOf` beside `type` or `properties`')
    if schema.get('minItems', 0) not in (0, 1): refuse(where, '`minItems` other than 0 or 1')
    if 'format' in schema and schema['format'] not in FORMATS: refuse(where, f'unsupported format `{schema["format"]}`')
    if 'pattern' in schema and PATTERN_REFUSED.search(schema['pattern']): refuse(where, 'a pattern with a backreference, lookaround or word boundary')
    if 'object' in types_of(schema):
        if schema.get('additionalProperties') is not False: refuse(where, 'an object without `additionalProperties: false`')
        if not isinstance(schema.get('required'), list): refuse(where, 'an object without `required`')
        properties = schema.get('properties', {})
        for name in schema['required']:
            if name not in properties: refuse(where, f'`{name}` required but not a property')
        for name, child in properties.items():
            optional = name not in schema['required']
            union = len(types_of(child)) > 1 or 'anyOf' in child
            yield f'{where}.{name}', optional, union
            yield from parameters(child, f'{where}.{name}')
    if 'items' in schema: yield from parameters(schema['items'], f'{where}[]')
    for index, branch in enumerate(schema.get('anyOf', [])): yield from parameters(branch, f'{where}|{index}')

def types_of(schema):
    return schema['type'] if isinstance(schema.get('type'), list) else [schema.get('type')]

def check(catalog):
    counted = {ability['name']: list(parameters(ability['input'], ability['name'])) for ability in catalog['abilities']}
    lines = []
    for seat, admits in SEATS.items():
        tools = [a['name'] for a in catalog['abilities'] if a['agent'] != 'withheld' and a.get('declared', True) and admits(a)]
        optional = sum(1 for name in tools for _, is_optional, _ in counted[name] if is_optional)
        union = sum(1 for name in tools for _, _, is_union in counted[name] if is_union)
        lines.append(f'{seat}: {len(tools)} strict tools (of {STRICT_TOOLS}), {optional} optional parameters (of {OPTIONAL_PARAMETERS}), {union} union-typed parameters (of {UNION_PARAMETERS})')
        if len(tools) > STRICT_TOOLS: refuse(seat, f'{len(tools)} strict tools')
        if optional > OPTIONAL_PARAMETERS: refuse(seat, f'{optional} optional parameters')
        if union > UNION_PARAMETERS: refuse(seat, f'{union} union-typed parameters')
    return lines

if __name__ == '__main__':
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / 'catalog-3.json'
    try: print('\n'.join(check(json.loads(path.read_text()))))
    except ValueError as error: sys.exit(f'{path.name}: {error}')
