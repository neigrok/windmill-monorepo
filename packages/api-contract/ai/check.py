#!/usr/bin/env python3
import copy
import json
import pathlib
import re
import sys


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names.split()):
        raise ValueError('wire fields differ')


def money(value, nullable=False):
    if nullable and value is None:
        return
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]{1,9})?', value):
        raise ValueError('money must be an exact decimal string')


def allowance(value):
    fields(value, 'tier period limit used reserved remaining resetsAt budgetResetsAt code capabilities')
    if value['tier'] not in ['anonymous', 'free', 'one']:
        raise ValueError('unknown tier')
    if value['period'] not in ['lifetime', 'calendar_month_utc', 'billing_period']:
        raise ValueError('unknown period')
    for name in ['limit', 'used', 'reserved', 'remaining']:
        money(value[name])
    fields(value['capabilities'], 'text transcription')
    fields(value['capabilities']['text'], 'large medium small')
    if set(value['capabilities']['text'].values()) - {'large', 'medium', 'small'}:
        raise ValueError('unknown model class')
    if not isinstance(value['capabilities']['transcription'], bool):
        raise ValueError('transcription must be boolean')


def check(fixture):
    allowance(fixture['allowance'])
    expected = {400: ['invalid_request'], 401: ['pass_missing', 'pass_signature', 'pass_audience', 'pass_malformed', 'pass_expired'], 403: ['funding_required', 'device_bound'], 404: ['call_unknown'], 409: ['conflict'], 410: ['result_gone'], 413: ['too_large'], 429: ['subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'concurrency_exhausted', 'rate_limited'], 503: ['busy', 'paused', 'accounting_unavailable']}
    actual = {}
    for refusal in fixture['refusals']:
        fields(refusal, 'status body')
        fields(refusal['body'], 'code allowance')
        code = refusal['body']['code']
        actual.setdefault(refusal['status'], []).append(code)
        if refusal['status'] == 401 or code == 'accounting_unavailable':
            if refusal['body']['allowance'] is not None:
                raise ValueError('unavailable allowance must be null')
        else:
            allowance(refusal['body']['allowance'])
    if actual != expected:
        raise ValueError('refusal coverage differs')
    if {call['state'] for call in fixture['calls']} != {'reserved', 'dispatched', 'settled', 'unconsumed', 'assumed'}:
        raise ValueError('call states incomplete')
    for call in fixture['calls']:
        fields(call, 'callId capability state stop code served charged endedAt')
        money(call['charged'], nullable=call['state'] in ['reserved', 'dispatched'])
        if (call['endedAt'] is None) != (call['state'] in ['reserved', 'dispatched']):
            raise ValueError('call end differs from state')
    if fixture['grantOutcomes'] != [{'outcome': outcome} for outcome in ['ok', 'replay', 'conflict', 'not_found']]:
        raise ValueError('grant outcomes incomplete')
    text = {'started': 'callId served maxTokens', 'text': 'delta', 'toolCall': 'id name input', 'ended': 'stop message charged allowance', 'failed': 'code charged allowance'}
    if {event['event'] for event in fixture['textEvents']} != set(text):
        raise ValueError('text event coverage incomplete')
    for event in fixture['textEvents']:
        fields(event, 'event data')
        fields(event['data'], text[event['event']])
        if event['event'] in ['ended', 'failed']:
            money(event['data']['charged'], nullable=True)
            allowance(event['data']['allowance'])
    live = {'started': 'type callId remainingSeconds', 'text': 'type turn delta', 'turn': 'type turn text', 'ended': 'type stop code text seconds charged allowance', 'failed': 'type code text seconds charged allowance'}
    if {event['type'] for event in fixture['liveEvents']} != set(live):
        raise ValueError('live event coverage incomplete')
    for event in fixture['liveEvents']:
        fields(event, live[event['type']])
        if event['type'] in ['ended', 'failed']:
            money(event['charged'], nullable=True)
            allowance(event['allowance'])
    fields(fixture['internalRequests']['fund'], 'accountId plan period')
    fields(fixture['internalRequests']['fund']['period'], 'start end')
    fields(fixture['internalRequests']['close'], 'closedAt')
    fields(fixture['internalRequests']['correct'], 'charged')
    money(fixture['internalRequests']['correct']['charged'])


def main():
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != '--self-test' else pathlib.Path(__file__).resolve().parent / 'wire' / 'fixtures.json'
    fixture = json.loads(path.read_text())
    check(fixture)
    invalid = copy.deepcopy(fixture)
    del invalid['textEvents'][3]['data']['charged']
    try:
        check(invalid)
    except ValueError:
        pass
    else:
        raise ValueError('checker accepted a terminal event without charged')
    invalid = copy.deepcopy(fixture)
    invalid['calls'][2]['charged'] = 0.001
    try:
        check(invalid)
    except ValueError:
        pass
    else:
        raise ValueError('checker accepted floating point money')
    print('AI wire contracts verified, including negative checker probes')


if __name__ == '__main__':
    main()
