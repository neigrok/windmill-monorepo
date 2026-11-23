#!/usr/bin/env python3
import argparse
import base64
import copy
import json
from pathlib import Path
import re


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def fields(value, names):
    require(isinstance(value, dict) and set(value) == set(names.split()), 'wire fields differ')


def integer(value, minimum=0, nullable=False):
    if nullable and value is None:
        return
    require(type(value) is int and minimum <= value <= 9223372036854775807, 'invalid integer')


def money(value, nullable=False):
    if nullable and value is None:
        return None
    require(isinstance(value, str) and re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]{1,9})?', value), 'money must be an exact decimal string')
    whole, _, fraction = value.partition('.')
    amount = int(whole) * 1000000000 + int(fraction.ljust(9, '0'))
    require(amount <= 9223372036854775807, 'money overflow')
    return amount


def period(value, nullable=False):
    if nullable and value is None:
        return
    fields(value, 'start end')
    integer(value['start'])
    integer(value['end'])
    require(value['start'] < value['end'], 'empty period')


def allowance(value, nullable=False):
    if nullable and value is None:
        return
    fields(value, 'tier period limit used reserved remaining resetsAt budgetResetsAt code capabilities')
    require(value['tier'] in {'anonymous', 'free', 'one'}, 'unknown tier')
    require(value['period'] in {'lifetime', 'calendar_month_utc', 'billing_period'}, 'unknown allowance period')
    amounts = {key: money(value[key]) for key in ['limit', 'used', 'reserved', 'remaining']}
    require(amounts['remaining'] == max(0, amounts['limit'] - amounts['used'] - amounts['reserved']), 'remaining money differs')
    integer(value['resetsAt'], nullable=True)
    integer(value['budgetResetsAt'], nullable=True)
    require((value['resetsAt'] is None) == (value['period'] == 'lifetime'), 'allowance reset differs')
    require(value['code'] in {'ok', 'device_bound', 'subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'concurrency_exhausted'}, 'invalid allowance code')
    if value['code'] not in {'subject_exhausted', 'free_month_exhausted', 'free_day_exhausted'}:
        require(value['budgetResetsAt'] is None, 'unrelated budget reset')
    fields(value['capabilities'], 'text transcription')
    fields(value['capabilities']['text'], 'large medium small')
    require(set(value['capabilities']['text'].values()) <= {'large', 'medium', 'small'}, 'unknown model class')
    require(type(value['capabilities']['transcription']) is bool, 'transcription must be boolean')
    require(value['capabilities']['transcription'] == (value['tier'] == 'one'), 'transcription must be grant funded')
    require(value['tier'] != 'anonymous' or value['period'] == 'lifetime', 'installation allowance period differs')
    require(value['tier'] != 'free' or value['period'] == 'calendar_month_utc', 'free allowance period differs')


def caller_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{22,64}', value), 'invalid caller ID')


def status(value):
    fields(value, 'callId capability state stop code served charged endedAt')
    caller_id(value['callId'])
    require(value['capability'] in {'text', 'transcription'}, 'unknown capability')
    require(value['state'] in {'reserved', 'dispatched', 'settled', 'unconsumed', 'assumed'}, 'unknown call state')
    require(value['served'] in {'large', 'medium', 'small'}, 'unknown served class')
    require(value['stop'] in {None, 'completed', 'tool_calls', 'truncated', 'declined', 'cut'}, 'unknown stop')
    require(value['code'] in {None, 'provider_rejected', 'provider_unavailable', 'provider_failed', 'accounting_unavailable', 'subject_exhausted', 'funding_required', 'paused', 'session_limit', 'idle', 'went_away', 'restarting', 'invalid_request'}, 'unknown call code')
    active = value['state'] in {'reserved', 'dispatched'}
    require((value['charged'] is None) == active, 'call charge differs from state')
    money(value['charged'], nullable=active)
    integer(value['endedAt'], nullable=active)
    require((value['endedAt'] is None) == active, 'call end differs from state')
    if value['state'] == 'unconsumed':
        require(money(value['charged']) == 0, 'unconsumed call was charged')


def call(value):
    fields(value, 'id principal callId capability tier requested served provider model priceVersion label client state reservation charged originalCharge maxTokens usage audioBytes audioSeconds turns slices providerRequestId stop code createdAt endedAt')
    status({key: value[key] for key in 'callId capability state stop code served charged endedAt'.split()})
    integer(value['id'], 1)
    fields(value['principal'], 'kind id')
    require(value['principal']['kind'] in {'installation', 'account'} and isinstance(value['principal']['id'], str) and value['principal']['id'], 'invalid principal')
    require(value['tier'] in {'anonymous', 'free', 'one', 'background'}, 'unknown call tier')
    require((value['tier'] == 'background') == (value['client'] == 'server'), 'background differs from a server pass')
    require(value['requested'] in {'large', 'medium', 'small'}, 'unknown requested class')
    require(value['provider'] in {'anthropic', 'openai', 'azure'}, 'unknown provider')
    require(value['client'] in {'ios', 'android', 'web', 'server'}, 'unknown client')
    for key in ['model', 'priceVersion', 'label']:
        require(isinstance(value[key], str) and value[key], 'missing metadata label')
    money(value['reservation'])
    money(value['originalCharge'], nullable=True)
    integer(value['maxTokens'], 1, nullable=True)
    integer(value['createdAt'])
    for key in ['audioBytes', 'audioSeconds', 'turns', 'slices']:
        integer(value[key])
    require(value['providerRequestId'] is None or isinstance(value['providerRequestId'], str), 'invalid provider request ID')
    if value['usage'] is not None:
        fields(value['usage'], 'input output cacheWrite cacheWrite1h cacheRead')
        for count in value['usage'].values():
            integer(count)
    if value['capability'] == 'transcription':
        require(value['maxTokens'] is None and value['usage'] is None, 'live call has token data')


def budget(value):
    fields(value, 'id kind period limit spent held')
    integer(value['id'], 1)
    require(value['kind'] in {'installation', 'account_month', 'free_month', 'free_day', 'grant', 'background_account_month', 'background_month', 'background_day'}, 'unknown budget kind')
    period(value['period'], nullable=True)
    for key in ['limit', 'spent', 'held']:
        money(value[key])


def grant(value):
    fields(value, 'id reference accountId source period closedAt amount spent held')
    integer(value['id'], 1)
    require(value['source'] in {'subscription', 'owner'}, 'unknown grant source')
    for key in ['reference', 'accountId']:
        require(isinstance(value[key], str) and value[key], 'invalid grant identity')
    period(value['period'])
    integer(value['closedAt'], nullable=True)
    for key in ['amount', 'spent', 'held']:
        money(value[key])


def page(value):
    fields(value, 'calls nextBeforeId')
    require(isinstance(value['calls'], list) and len(value['calls']) <= 1000, 'invalid call page size')
    for item in value['calls']:
        call(item)
    ids = [item['id'] for item in value['calls']]
    require(ids == sorted(set(ids), reverse=True), 'page IDs must be unique and descending')
    integer(value['nextBeforeId'], 1, nullable=True)
    if value['nextBeforeId'] is not None:
        require(bool(ids) and value['nextBeforeId'] == ids[-1], 'cursor must identify last returned call')


def tool_call(value):
    fields(value, 'id name input')
    require(isinstance(value['id'], str) and value['id'], 'missing tool call ID')
    require(isinstance(value['name'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value['name']), 'invalid tool name')
    require(isinstance(value['input'], dict), 'tool input must be object')


def parts(value):
    require(isinstance(value, list), 'parts must be an array')
    for part in value:
        require(isinstance(part, dict) and len(part) == 1, 'part must have one type')
        if 'text' in part:
            require(isinstance(part['text'], str), 'text must be a string')
        elif 'toolCall' in part:
            tool_call(part['toolCall'])
        elif 'image' in part:
            if 'picture' in part['image']:
                fields(part['image'], 'picture')
                caller_id(part['image']['picture'])
                continue
            fields(part['image'], 'mediaType data')
            require(part['image']['mediaType'] in {'image/png', 'image/jpeg'}, 'unknown image type')
            try:
                raw = base64.b64decode(part['image']['data'], validate=True)
            except (ValueError, TypeError) as error:
                raise ValueError('invalid image base64') from error
            signature = b'\x89PNG\r\n\x1a\n' if part['image']['mediaType'] == 'image/png' else b'\xff\xd8\xff'
            require(raw.startswith(signature), 'image signature differs')
        else:
            raise ValueError('unknown part type')


def text_request(value):
    fields(value, 'model system tools messages output effort cache')
    require(value['model'] in {'large', 'medium', 'small'}, 'unknown requested model')
    require(value['effort'] in {'low', 'medium', 'high', 'xhigh', 'max'}, 'unknown effort')
    require(type(value['cache']) is bool and all(isinstance(item, str) for item in value['system']), 'invalid text options')
    for tool in value['tools']:
        fields(tool, 'name description input strict' if 'strict' in tool else 'name description input')
        require(type(tool.get('strict', True)) is bool, 'invalid tool strictness')
        require(isinstance(tool['description'], str), 'invalid tool description')
        require(isinstance(tool['input'], dict) and tool['input'].get('type') == 'object', 'invalid tool schema')
    pending = set()
    images = 0
    for message in value['messages']:
        role = message.get('role')
        if role == 'user':
            fields(message, 'role parts')
            require(not pending, 'missing tool answers')
            parts(message['parts'])
            require(all('toolCall' not in part for part in message['parts']), 'user cannot call tools')
            images += sum('image' in part for part in message['parts'])
            require(images <= 8, 'too many images')
        elif role == 'assistant':
            fields(message, 'role parts carry')
            require(not pending and isinstance(message['carry'], str), 'invalid assistant continuation')
            parts(message['parts'])
            require(all('image' not in part for part in message['parts']), 'assistant cannot send images')
            pending = {part['toolCall']['id'] for part in message['parts'] if 'toolCall' in part}
        elif role == 'tool':
            fields(message, 'role results')
            require(bool(pending), 'unsolicited tool results')
            ids = []
            for result in message['results']:
                fields(result, 'id content isError')
                require(isinstance(result['content'], str) and type(result['isError']) is bool, 'invalid tool result')
                ids.append(result['id'])
            require(set(ids) == pending and len(ids) == len(pending), 'tool result IDs differ')
            pending.clear()
        else:
            raise ValueError('unknown message role')
    require(not pending, 'unanswered tool calls')
    fields(value['output'], 'maxTokens minTokens schema')
    integer(value['output']['maxTokens'], 1)
    integer(value['output']['minTokens'], 1, nullable=True)
    require(value['output']['minTokens'] is None or value['output']['minTokens'] <= value['output']['maxTokens'], 'output floor exceeds cap')
    require(value['output']['schema'] is None or isinstance(value['output']['schema'], dict), 'invalid output schema')


def text_event(value):
    fields(value, 'event data')
    shapes = {'started': 'callId served maxTokens', 'text': 'delta', 'toolCall': 'id name input', 'ended': 'stop message charged allowance', 'failed': 'code charged allowance'}
    require(value['event'] in shapes, 'unknown text event')
    data = value['data']
    fields(data, shapes[value['event']])
    if value['event'] == 'started':
        caller_id(data['callId'])
        integer(data['maxTokens'], 1)
        require(data['served'] in {'large', 'medium', 'small'}, 'unknown served class')
    elif value['event'] == 'text':
        require(isinstance(data['delta'], str), 'invalid text delta')
    elif value['event'] == 'toolCall':
        tool_call(data)
    else:
        money(data['charged'], nullable=True)
        allowance(data['allowance'], nullable=True)
        if value['event'] == 'ended':
            require(data['stop'] in {'completed', 'tool_calls', 'truncated', 'declined'}, 'unknown text stop')
            fields(data['message'], 'role parts carry')
            require(data['message']['role'] == 'assistant' and isinstance(data['message']['carry'], str), 'invalid answer message')
            parts(data['message']['parts'])
        else:
            require(data['code'] in {'provider_rejected', 'provider_unavailable', 'provider_failed', 'accounting_unavailable'}, 'unknown text failure')


def live_event(value):
    shapes = {'started': 'type callId remainingSeconds', 'text': 'type turn delta', 'turn': 'type turn text', 'ended': 'type stop code text seconds charged allowance', 'failed': 'type code text seconds charged allowance'}
    require(value.get('type') in shapes, 'unknown live event')
    fields(value, shapes[value['type']])
    if value['type'] == 'started':
        caller_id(value['callId'])
        integer(value['remainingSeconds'])
    elif value['type'] in {'text', 'turn'}:
        integer(value['turn'], 1)
        require(isinstance(value.get('delta', value.get('text')), str), 'invalid transcript')
    else:
        require(isinstance(value['text'], str), 'invalid transcript')
        integer(value['seconds'])
        money(value['charged'], nullable=True)
        allowance(value['allowance'], nullable=True)
        if value['type'] == 'ended':
            require(value['stop'] in {'completed', 'cut'}, 'unknown live stop')
            require((value['stop'] == 'completed') == (value['code'] is None), 'live stop/code differ')
            require(value['code'] in {None, 'subject_exhausted', 'funding_required', 'paused', 'session_limit', 'idle', 'went_away', 'restarting'}, 'unknown live cut')
        else:
            require(value['code'] in {'provider_failed', 'provider_unavailable', 'accounting_unavailable', 'invalid_request', 'funding_required'}, 'unknown live failure')


def check(fixture):
    fields(fixture, 'allowance allowances refusals prestreamRefusals textRequest textPictureRequest pictureUploads calls grantOutcomes textEvents textTerminals liveEvents liveFrames liveTerminals liveFirstFailures internalRequests internalCalls internalPrincipal internalPages corrections shared')
    allowance(fixture['allowance'])
    require(set(fixture['allowances']) == {'anonymous', 'free', 'one_subscription', 'one_owner', 'one_without_grant', 'subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'concurrency_exhausted'}, 'allowance coverage differs')
    for value in fixture['allowances'].values():
        allowance(value)
    require(fixture['allowances']['one_without_grant']['tier'] == 'free', 'plan grace must use free tier')
    expected_status = {400: {'invalid_request', 'provider_rejected'}, 401: {'pass_missing', 'pass_signature', 'pass_audience', 'pass_malformed', 'pass_expired'}, 403: {'funding_required', 'device_bound'}, 404: {'call_unknown'}, 409: {'conflict'}, 410: {'result_gone', 'picture_gone'}, 413: {'too_large'}, 429: {'subject_exhausted', 'free_month_exhausted', 'free_day_exhausted', 'background_exhausted', 'concurrency_exhausted', 'rate_limited'}, 503: {'busy', 'paused', 'accounting_unavailable', 'provider_unavailable'}}
    actual_status = {}
    for refusal in fixture['refusals']:
        fields(refusal, 'status body')
        fields(refusal['body'], 'code allowance')
        integer(refusal['status'], 100)
        code = refusal['body']['code']
        require(code not in actual_status.setdefault(refusal['status'], set()), 'duplicate refusal')
        actual_status[refusal['status']].add(code)
        allowance(refusal['body']['allowance'], nullable=True)
        require((refusal['body']['allowance'] is None) == (refusal['status'] == 401 or code in {'accounting_unavailable', 'background_exhausted'}), 'refusal allowance differs')
    require(actual_status == expected_status, 'refusal coverage differs')
    require(set(fixture['prestreamRefusals']) == {'provider_rejected', 'provider_unavailable'}, 'prestream refusal coverage differs')
    for code, value in fixture['prestreamRefusals'].items():
        fields(value, 'status body')
        fields(value['body'], 'code allowance')
        require(value['status'] == (400 if code == 'provider_rejected' else 503) and value['body']['code'] == code, 'prestream refusal differs')
        allowance(value['body']['allowance'])
    text_request(fixture['textRequest'])
    text_request(fixture['textPictureRequest'])
    require(len(fixture['pictureUploads']) == 2, 'picture upload coverage differs')
    for upload in fixture['pictureUploads']:
        fields(upload, 'pictureId mediaType data status')
        caller_id(upload['pictureId'])
        require(upload['status'] == 204, 'picture upload response differs')
        parts([{'image': {key: upload[key] for key in ['mediaType', 'data']}}])
    require({upload['mediaType'] for upload in fixture['pictureUploads']} == {'image/jpeg', 'image/png'}, 'picture types incomplete')
    require(fixture['textPictureRequest']['messages'][0]['parts'][1] == {'image': {'picture': fixture['pictureUploads'][0]['pictureId']}}, 'picture reference differs')
    require({value['state'] for value in fixture['calls']} == {'reserved', 'dispatched', 'settled', 'unconsumed', 'assumed'}, 'call states incomplete')
    for value in fixture['calls']:
        status(value)
    require(fixture['grantOutcomes'] == [{'outcome': name} for name in ['ok', 'replay', 'conflict', 'not_found']], 'grant outcomes differ')
    require(set(fixture['textTerminals']) == {'completed', 'tool_calls', 'truncated', 'declined', 'provider_rejected', 'provider_unavailable', 'provider_failed', 'null_charged'}, 'text terminal coverage differs')
    for value in fixture['textEvents'] + list(fixture['textTerminals'].values()):
        text_event(value)
    require(set(fixture['liveTerminals']) == {'completed', 'subject_exhausted', 'funding_required', 'paused', 'session_limit', 'idle', 'went_away', 'restarting', 'provider_failed', 'accounting_unavailable', 'invalid_request', 'provider_unavailable', 'null_charged'}, 'live terminal coverage differs')
    for value in fixture['liveEvents'] + list(fixture['liveTerminals'].values()) + list(fixture['liveFirstFailures'].values()):
        live_event(value)
    for value in fixture['liveFirstFailures'].values():
        require(value['charged'] is None and value['seconds'] == 0 and value['text'] == '', 'first failure must be uncharged')
    require([value.get('type') for value in fixture['liveFrames']] == ['context', 'commit', 'end'], 'live controls incomplete')
    for value in fixture['liveFrames']:
        fields(value, 'type keywords' if value['type'] == 'context' else 'type')
        if value['type'] == 'context':
            require(isinstance(value['keywords'], list) and all(isinstance(word, str) and 0 < len(word) <= 256 for word in value['keywords']), 'invalid context')
    requests = fixture['internalRequests']
    fields(requests, 'fund close reopen correct')
    fields(requests['fund'], 'accountId plan period')
    period(requests['fund']['period'])
    require(requests['fund']['plan'] == 'one', 'unknown funded plan')
    fields(requests['close'], 'closedAt')
    integer(requests['close']['closedAt'])
    require(requests['reopen'] is None, 'reopen must have no body')
    fields(requests['correct'], 'charged')
    money(requests['correct']['charged'])
    for value in fixture['internalCalls'].values():
        call(value)
    principal = fixture['internalPrincipal']
    fields(principal, 'budgets grants installations calls nextBeforeId')
    for value in principal['budgets']:
        budget(value)
    for value in principal['grants']:
        grant(value)
    require(all(isinstance(value, str) for value in principal['installations']), 'invalid binding IDs')
    page({key: principal[key] for key in ['calls', 'nextBeforeId']})
    for value in fixture['internalPages'].values():
        page(value)
    require(fixture['internalPages']['first']['nextBeforeId'] is not None and fixture['internalPages']['last']['nextBeforeId'] is None, 'pagination states incomplete')
    for name, value in fixture['corrections'].items():
        fields(value, 'state charged replay')
        require(value['state'] == 'assumed' and type(value['replay']) is bool and value['replay'] == (name == 'replayed'), 'invalid correction')
        money(value['charged'])
    require(set(fixture['internalCalls']) == {'settled', 'corrected', 'transcription', 'background'}, 'internal call coverage differs')
    fields(fixture['shared'], 'budgets fuses')
    for value in fixture['shared']['budgets']:
        budget(value)
        require(value['kind'] in {'free_month', 'free_day', 'background_month', 'background_day'}, 'shared budget kind differs')
    for value in fixture['shared']['fuses']:
        fields(value, 'provider spent limit paused')
        require(value['provider'] in {'anthropic', 'openai', 'azure'}, 'unknown fuse provider')
        require(type(value['paused']) is bool and value['paused'] == (money(value['spent']) > money(value['limit'])), 'fuse threshold differs')


def negative_probes(fixture):
    probes = [
        ('too many pictures', lambda f: f['textPictureRequest']['messages'][0].update(parts=[{'image': {'picture': 'pictureabcdefghijklmn0'}}] * 9)),
        ('assistant picture', lambda f: f['textPictureRequest']['messages'][1]['parts'].append({'image': {'picture': 'pictureabcdefghijklmn0'}})),
        ('mixed picture reference', lambda f: f['textPictureRequest']['messages'][0]['parts'][1]['image'].update(data='AA==')),
        ('invalid picture ID', lambda f: f['textPictureRequest']['messages'][0]['parts'][1]['image'].update(picture='short')),
        ('unknown picture field', lambda f: f['pictureUploads'][0].update(url='https://invalid.example')),
        ('wrong picture media', lambda f: f['pictureUploads'][0].update(mediaType='image/gif')),
        ('wrong picture signature', lambda f: f['pictureUploads'][0].update(data='/9j/2Q==')),
        ('missing picture refusal', lambda f: f['refusals'].__setitem__(slice(None), [item for item in f['refusals'] if item['body']['code'] != 'picture_gone'])),
        ('background refusal with an allowance', lambda f: next(item for item in f['refusals'] if item['body']['code'] == 'background_exhausted')['body'].update(allowance=f['allowance'])),
        ('background call from a device', lambda f: f['internalCalls']['background'].update(client='web')),
        ('account budget listed as shared', lambda f: f['shared']['budgets'][1].update(kind='background_account_month')),
        ('missing charged', lambda f: f['textTerminals']['completed']['data'].pop('charged')),
        ('floating money', lambda f: f['calls'][2].update(charged=0.001)),
        ('boolean money', lambda f: f['internalCalls']['settled'].update(charged=False)),
        ('excess money precision', lambda f: f['allowance'].update(used='0.0000000001')),
        ('unknown state', lambda f: f['calls'][2].update(state='finished')),
        ('unknown field', lambda f: f['internalCalls']['settled'].update(prompt='forbidden')),
        ('numeric string cursor', lambda f: f['internalPages']['first'].update(nextBeforeId='42')),
        ('nonpositive cursor', lambda f: f['internalPages']['first'].update(nextBeforeId=0)),
        ('cursor typo', lambda f: f['internalPages']['first'].update(nexBeforeId=42)),
        ('cursor skips rows', lambda f: f['internalPages']['first'].update(nextBeforeId=41)),
        ('ascending page', lambda f: f['internalPages']['first']['calls'].reverse()),
        ('missing live charge', lambda f: f['liveTerminals']['completed'].pop('charged')),
        ('completed with cut code', lambda f: f['liveTerminals']['completed'].update(code='idle')),
        ('unknown control field', lambda f: f['liveFrames'][1].update(language='en')),
        ('missing tool answer', lambda f: f['textRequest']['messages'][2].update(results=[])),
        ('strictness not a boolean', lambda f: f['textRequest']['tools'][0].update(strict='yes')),
    ]
    for name, mutate in probes:
        invalid = copy.deepcopy(fixture)
        mutate(invalid)
        try:
            check(invalid)
        except ValueError:
            continue
        raise ValueError(f'checker accepted {name}')
    return len(probes)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('path', nargs='?', type=Path, default=Path(__file__).resolve().parent / 'wire' / 'fixtures.json')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    fixture = json.loads(args.path.read_text())
    check(fixture)
    count = negative_probes(fixture)
    print(f'AI wire contracts verified; {count} independent negative probes rejected')


if __name__ == '__main__':
    main()
