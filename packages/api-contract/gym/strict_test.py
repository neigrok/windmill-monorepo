#!/usr/bin/env python3
import strict

def obj(properties, required=None, **extra):
    return {'type': 'object', 'properties': properties, 'required': list(properties) if required is None else required, 'additionalProperties': False, **extra}

def array(items, **extra):
    return {'type': 'array', 'items': items, **extra}

NULLABLE = [{'type': 'string'}, {'type': 'null'}]

# Each schema is one ability's input, declared strict unless the fixture says otherwise: a rule strict.py refuses, by the
# words it refuses with, or the optional and union-typed parameters it counts.
FIXTURES = [
    ('a number bound is refused', obj({'n': {'type': 'integer', 'maximum': 200}}), 'strict mode refuses `maximum`'),
    ('a string bound is refused', obj({'s': {'type': 'string', 'maxLength': 240}}), 'strict mode refuses `maxLength`'),
    ('a list bound is refused', obj({'l': array({'type': 'string'}, maxItems=50)}), 'strict mode refuses `maxItems`'),
    ('an enum of objects is refused', obj({'e': {'type': 'string', 'enum': [{'a': 1}]}}), '`enum` holding other than scalars'),
    ('a list constant is refused', obj({'c': array({'type': 'string'}, const=['a'])}), '`const` that is not a scalar'),
    ('anyOf beside items is refused', obj({'a': {'anyOf': NULLABLE, 'items': {'type': 'string'}}}), '`anyOf` beside `items`'),
    ('anyOf beside type is refused', obj({'a': {'type': 'string', 'anyOf': NULLABLE}}), '`anyOf` beside `type`'),
    ('anyOf beside enum is refused', obj({'a': {'enum': ['x'], 'anyOf': NULLABLE}}), '`anyOf` beside `enum`'),
    ('anyOf beside properties is refused', obj({'a': {'properties': {}, 'anyOf': NULLABLE}}), '`anyOf` beside `properties`'),
    ('an object schema without its type is refused', obj({'o': {'properties': {}, 'required': [], 'additionalProperties': False}}), 'without `type: object`'),
    ('an open object is refused', obj({'o': {'type': 'object', 'properties': {}, 'required': [], 'additionalProperties': True}}), 'without `additionalProperties: false`'),
    ('an object without required is refused', {'type': 'object', 'properties': {}, 'additionalProperties': False}, 'an object without `required`'),
    ('an input that is not an object is refused', {'type': 'string'}, 'an input that is not `type: object`'),
    ('a boolean minItems is refused', obj({'l': array({'type': 'string'}, minItems=True)}), '`minItems` other than the integer 0 or 1'),
    ('minItems of 2 is refused', obj({'l': array({'type': 'string'}, minItems=2)}), '`minItems` other than the integer 0 or 1'),
    ('a quantifier range past the bound is refused', obj({'s': {'type': 'string', 'pattern': '^[a-z]{1,100}$'}}), 'a pattern quantifier range past 64'),
    ('an open quantifier range is refused', obj({'s': {'type': 'string', 'pattern': '^[a-z]{3,}$'}}), 'a pattern quantifier range past 64'),
    ('a backreference is refused', obj({'s': {'type': 'string', 'pattern': '^(a)\\1$'}}), 'a backreference, lookaround or word boundary'),
    ('an unknown format is refused', obj({'s': {'type': 'string', 'format': 'phone'}}), 'unsupported format `phone`'),
    ('a schema without a type is refused', obj({'s': {'description': 'anything'}}), 'without a known `type`'),
    ('an id pattern within the bound passes and counts nothing', obj({'id': {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{8,64}$'}}), (0, 0)),
    ('a nullable parameter is one union', obj({'s': {'type': ['string', 'null']}}), (0, 1)),
    ('a union-typed items counts as a union', obj({'ids': array({'type': ['string', 'null']})}), (0, 1)),
    ('anyOf counts as a union', obj({'a': {'description': 'either', 'anyOf': [{'type': 'string'}, {'type': 'integer'}]}}), (0, 1)),
    ('optional parameters count at every depth', obj({'lines': array(obj({'a': {'type': 'integer'}, 'b': {'type': 'string'}}, [])), 'top': {'type': 'boolean'}}, ['lines']), (3, 0)),
    ('a tool not declared strict counts nothing', obj({'s': {'type': ['string', 'null']}, 'n': {'type': 'integer'}}, ['s']), (0, 0), {'strict': False}),
    ('a tool not declared strict is still refused what strict mode refuses', obj({'n': {'type': 'integer', 'maximum': 200}}), 'strict mode refuses `maximum`', {'strict': False}),
    ('an ability that does not say whether it is strict is refused', obj({}), '`strict` that is not a boolean', {'strict': None}),
    ('a strict that is not a boolean is refused', obj({}), '`strict` that is not a boolean', {'strict': 1}),
]

def run(case, schema, expected, ability=None):
    declared = {'name': 'fixture', 'agent': 'runs', 'seats': 'any', 'strict': True, 'input': schema, **(ability or {})}
    catalog = {'abilities': [{key: value for key, value in declared.items() if value is not None}]}
    try: found = strict.counts(catalog)['bound']
    except ValueError as error:
        assert isinstance(expected, str) and expected in str(error), f'{case}: refused as {error}'
        return
    assert not isinstance(expected, str), f'{case}: not refused, wanted {expected}'
    assert (found['tools'], found['optional'], found['union']) == (int(declared['strict']), *expected), f'{case}: counted {found}'

if __name__ == '__main__':
    for fixture in FIXTURES: run(*fixture)
    print(f'{len(FIXTURES)} fixtures hold')
