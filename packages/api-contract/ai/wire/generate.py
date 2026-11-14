#!/usr/bin/env python3
import argparse
import copy
import json
from pathlib import Path


def allowance(tier='free', used='0', reserved='0', remaining='0.5', code='ok', budget_reset=None, owner=False):
    one = tier == 'one'
    anonymous = tier == 'anonymous'
    return {
        'tier': tier,
        'period': 'lifetime' if anonymous else 'calendar_month_utc' if not one or owner else 'billing_period',
        'limit': '7' if one else '0.25' if anonymous else '0.5',
        'used': used, 'reserved': reserved, 'remaining': remaining,
        'resetsAt': None if anonymous else 1801440000000 if not one or owner else 1802592000000,
        'budgetResetsAt': budget_reset, 'code': code,
        'capabilities': {
            'text': {'large': 'medium' if anonymous else 'large', 'medium': 'medium', 'small': 'small'},
            'transcription': one,
        },
    }


def call_status(state, charged, ended, stop=None, code=None, capability='text'):
    return {
        'callId': 'abcdefghijklmnopqrstuv', 'capability': capability, 'state': state,
        'stop': stop, 'code': code, 'served': 'small', 'charged': charged, 'endedAt': ended,
    }


def internal_call():
    return {
        'id': 41, 'principal': {'kind': 'account', 'id': 'account-vector'},
        'callId': 'abcdefghijklmnopqrstuv', 'capability': 'text', 'tier': 'free',
        'requested': 'small', 'served': 'small', 'provider': 'anthropic',
        'model': 'claude-haiku-4-5', 'priceVersion': '2026-11-15', 'label': 'other', 'client': 'web',
        'state': 'settled', 'reservation': '0.002', 'charged': '0.0002325', 'originalCharge': None,
        'maxTokens': 100, 'usage': {'input': 10, 'output': 20, 'cacheWrite': 30, 'cacheWrite1h': 40, 'cacheRead': 50},
        'audioBytes': 0, 'audioSeconds': 0, 'turns': 0, 'slices': 0,
        'providerRequestId': 'req_vector', 'stop': 'completed', 'code': None,
        'createdAt': 1800000000000, 'endedAt': 1800000001000,
    }


def generate():
    free = allowance(used='0.01', reserved='0.02', remaining='0.47')
    allowances = {
        'anonymous': allowance('anonymous', remaining='0.25'),
        'free': free,
        'one_subscription': allowance('one', used='0.1', reserved='0.2', remaining='6.7'),
        'one_owner': allowance('one', remaining='7', owner=True),
        'one_without_grant': allowance(),
        'subject_exhausted': allowance(used='0.5', remaining='0', code='subject_exhausted', budget_reset=1801440000000),
        'free_month_exhausted': allowance(code='free_month_exhausted', budget_reset=1801440000000),
        'free_day_exhausted': allowance(code='free_day_exhausted', budget_reset=1800057600000),
        'concurrency_exhausted': allowance(reserved='0.002', remaining='0.498', code='concurrency_exhausted'),
    }
    statuses = {
        400: ['invalid_request', 'provider_rejected'],
        401: ['pass_missing', 'pass_signature', 'pass_audience', 'pass_malformed', 'pass_expired'],
        403: ['funding_required', 'device_bound'], 404: ['call_unknown'], 409: ['conflict'],
        410: ['result_gone'], 413: ['too_large'],
        429: ['subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'concurrency_exhausted', 'rate_limited'],
        503: ['busy', 'paused', 'accounting_unavailable', 'provider_unavailable'],
    }
    refusals = [
        {'status': status, 'body': {'code': code, 'allowance': None if status == 401 or code == 'accounting_unavailable' else free}}
        for status, codes in statuses.items() for code in codes
    ]
    text_request = {
        'model': 'large', 'system': ['Help me plan a small next step.'],
        'tools': [{'name': 'read', 'description': 'Read the current item.', 'input': {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id'], 'additionalProperties': False}}],
        'messages': [
            {'role': 'user', 'parts': [{'text': 'What can I do next?'}, {'image': {'mediaType': 'image/png', 'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSh0AAAAASUVORK5CYII='}}]},
            {'role': 'assistant', 'parts': [{'text': 'I will read the item.'}, {'toolCall': {'id': 'tool-1', 'name': 'read', 'input': {'id': 'item-1'}}}], 'carry': 'wm-carry.v1.opaque'},
            {'role': 'tool', 'results': [{'id': 'tool-1', 'content': 'The item is ready.', 'isError': False}]},
        ],
        'output': {'maxTokens': 2000, 'minTokens': 1024, 'schema': {'type': 'object', 'properties': {'step': {'type': 'string'}}, 'required': ['step'], 'additionalProperties': False}},
        'effort': 'high', 'cache': True,
    }
    text_events = [
        {'event': 'started', 'data': {'callId': 'abcdefghijklmnopqrstuv', 'served': 'small', 'maxTokens': 100}},
        {'event': 'text', 'data': {'delta': 'Hello'}},
        {'event': 'toolCall', 'data': {'id': 'tool-1', 'name': 'read', 'input': {}}},
    ]
    terminal_text = {}
    for stop in ['completed', 'tool_calls', 'truncated', 'declined']:
        parts = [{'toolCall': {'id': 'tool-1', 'name': 'read', 'input': {}}}] if stop == 'tool_calls' else [{'text': 'Hello'}]
        terminal_text[stop] = {'event': 'ended', 'data': {
            'stop': stop, 'message': {'role': 'assistant', 'parts': parts, 'carry': 'wm-carry.v1.<opaque>'},
            'charged': '0.000015', 'allowance': allowance('one', used='0.000015', remaining='6.999985', owner=True),
        }}
    for code in ['provider_rejected', 'provider_unavailable', 'provider_failed']:
        assumed = code == 'provider_failed'
        terminal_text[code] = {'event': 'failed', 'data': {
            'code': code, 'charged': '0.000575' if assumed else '0',
            'allowance': allowance('one', used='0.000575' if assumed else '0', remaining='6.999425' if assumed else '7', owner=True),
        }}
    terminal_text['null_charged'] = copy.deepcopy(terminal_text['completed'])
    terminal_text['null_charged']['data']['charged'] = None
    terminal_text['null_charged']['data']['allowance'] = allowance('one', reserved='0.000575', remaining='6.999425', owner=True)
    text_events += [terminal_text['completed'], terminal_text['provider_failed']]
    live_allowance = allowance('one', used='0.000283334', remaining='6.999716666', owner=True)
    live_terminal = {
        'completed': {'type': 'ended', 'stop': 'completed', 'code': None, 'text': 'Hello', 'seconds': 1, 'charged': '0.000283334', 'allowance': live_allowance},
    }
    for code in ['subject_exhausted', 'funding_required', 'paused', 'session_limit', 'idle', 'went_away', 'restarting']:
        live_terminal[code] = dict(live_terminal['completed'], stop='cut', code=code)
    for code in ['provider_failed', 'accounting_unavailable', 'invalid_request']:
        live_terminal[code] = {'type': 'failed', 'code': code, 'text': 'Hello', 'seconds': 1, 'charged': '0.000283334', 'allowance': live_allowance}
    live_terminal['provider_unavailable'] = {'type': 'failed', 'code': 'provider_unavailable', 'text': '', 'seconds': 0, 'charged': '0', 'allowance': allowances['one_owner']}
    live_terminal['null_charged'] = dict(live_terminal['provider_failed'], charged=None, allowance=None)
    first_failures = {
        'funding_required': {'type': 'failed', 'code': 'funding_required', 'text': '', 'seconds': 0, 'charged': None, 'allowance': allowances['one_without_grant']},
        'provider_unavailable': {'type': 'failed', 'code': 'provider_unavailable', 'text': '', 'seconds': 0, 'charged': None, 'allowance': allowances['one_owner']},
        'accounting_unavailable': {'type': 'failed', 'code': 'accounting_unavailable', 'text': '', 'seconds': 0, 'charged': None, 'allowance': None},
    }
    metadata = internal_call()
    corrected = dict(metadata, state='assumed', charged='0.001', originalCharge='0.002', usage=None, stop=None, code='provider_failed')
    live_call = dict(metadata, id=42, capability='transcription', tier='one', provider='openai', model='gpt-live-transcribe', reservation='0.017', charged='0.000283334', maxTokens=None, usage=None, audioBytes=48000, audioSeconds=1, turns=1, slices=1)
    budget = {'id': 1, 'kind': 'account_month', 'period': {'start': 1798761600000, 'end': 1801440000000}, 'limit': '0.5', 'spent': '0.01', 'held': '0.02'}
    grant = {'id': 2, 'reference': 'period-vector', 'accountId': 'account-vector', 'source': 'subscription', 'period': {'start': 1800000000000, 'end': 1802592000000}, 'closedAt': None, 'amount': '7', 'spent': '0.1', 'held': '0.2'}
    grant_budget = dict(budget, id=2, kind='grant', period=grant['period'], limit='7', spent='0.1', held='0.2')
    principal = {'budgets': [budget, grant_budget], 'grants': [grant], 'installations': ['installation-vector'], 'nextBeforeId': None, 'calls': [metadata]}
    first_page = {'calls': [dict(metadata, id=43, callId='0000000000000000000043'), dict(metadata, id=42, callId='0000000000000000000042')], 'nextBeforeId': 42}
    last_page = {'calls': [metadata], 'nextBeforeId': None}
    return {
        'allowance': free, 'allowances': allowances, 'refusals': refusals,
        'prestreamRefusals': {
            'provider_rejected': {'status': 400, 'body': {'code': 'provider_rejected', 'allowance': allowances['one_owner']}},
            'provider_unavailable': {'status': 503, 'body': {'code': 'provider_unavailable', 'allowance': allowances['one_owner']}},
        },
        'textRequest': text_request,
        'calls': [call_status(state, charge, ended) for state, charge, ended in [
            ('reserved', None, None), ('dispatched', None, None), ('settled', '0.001', 1800000001000),
            ('unconsumed', '0', 1800000001000), ('assumed', '0.002', 1800000001000),
        ]],
        'grantOutcomes': [{'outcome': outcome} for outcome in ['ok', 'replay', 'conflict', 'not_found']],
        'textEvents': text_events, 'textTerminals': terminal_text,
        'liveEvents': [
            {'type': 'started', 'callId': 'abcdefghijklmnopqrstuv', 'remainingSeconds': 24705},
            {'type': 'text', 'turn': 1, 'delta': 'Hello'}, {'type': 'turn', 'turn': 1, 'text': 'Hello'},
            live_terminal['completed'], live_terminal['provider_failed'],
        ],
        'liveFrames': [{'type': 'context', 'keywords': ['Windmill', 'next step']}, {'type': 'commit'}, {'type': 'end'}],
        'liveTerminals': live_terminal, 'liveFirstFailures': first_failures,
        'internalRequests': {
            'fund': {'accountId': 'account-vector', 'plan': 'one', 'period': {'start': 1800000000000, 'end': 1802592000000}},
            'close': {'closedAt': 1800000001000}, 'reopen': None, 'correct': {'charged': '0.001'},
        },
        'internalCalls': {'settled': metadata, 'corrected': corrected, 'transcription': live_call},
        'internalPrincipal': principal,
        'internalPages': {'first': first_page, 'last': last_page, 'empty': {'calls': [], 'nextBeforeId': None}},
        'corrections': {
            'corrected': {'state': 'assumed', 'charged': '0.001', 'replay': False},
            'replayed': {'state': 'assumed', 'charged': '0.001', 'replay': True},
        },
        'shared': {
            'budgets': [dict(budget, id=3, kind='free_month', limit='100', spent='50', held='1')],
            'fuses': [{'provider': 'anthropic', 'spent': '20.000000001', 'limit': '20', 'paused': True}, {'provider': 'openai', 'spent': '0', 'limit': '20', 'paused': False}, {'provider': 'azure', 'spent': '0', 'limit': '20', 'paused': False}],
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    path = Path(__file__).with_name('fixtures.json')
    content = json.dumps(generate(), indent=2, ensure_ascii=False) + '\n'
    if args.check:
        if path.read_text() != content:
            raise SystemExit('wire fixtures differ; run wire/generate.py')
        return
    path.write_text(content)


if __name__ == '__main__':
    main()
