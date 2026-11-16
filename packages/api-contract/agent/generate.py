#!/usr/bin/env python3
# Declarative story authoring imports no implementation and runs no policy.
import copy
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).parent
CALLS = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC']
TURN = 'turn-vector'
PROFILE = {
    'name': 'vector.coach', 'version': 1, 'system': ['Be useful.'],
    'firstContent': {'historyPrefix': 'History: ', 'contextPrefix': 'Context: ', 'questionPrefix': 'Question: ', 'emptyQuestion': 'Look.'},
    'refusals': {code: code + '.' for code in ['not-offered', 'seat-required', 'invalid-input', 'one-proposal', 'coach-turn-volume', 'product-refused', 'stopped', 'executor-refused']},
    'tools': [{'name': name, 'description': name + ' a value', 'input': {'type': 'object', 'required': ['value'], 'additionalProperties': False, 'properties': {'value': {'type': 'integer'}}}, 'countsAsWrite': name == 'write'} for name in ['read', 'write']],
    'model': 'small', 'effort': 'low', 'output': {'maxTokens': 100, 'minTokens': None}, 'label': 'other',
    'limits': {'modelCalls': 3, 'abilityCalls': 4, 'writes': 2}, 'groups': [{'name': 'proposal', 'tools': ['write'], 'maxSuccesses': 1, 'code': 'one-proposal'}],
}

def terminal(stop='completed', text='Hello', calls=(), code=None):
    if code:
        return {'event': 'failed', 'data': {'code': code, 'charged': None, 'allowance': None}}
    return {'event': 'ended', 'data': {'stop': stop, 'message': {'role': 'assistant', 'parts': ([{'text': text}] if text else []) + [{'toolCall': call} for call in calls], 'carry': 'opaque'}, 'charged': '0', 'allowance': None}}

def events(text='Hello', stop='completed', calls=(), code=None, round=0):
    values = [{'event': 'started', 'data': {'callId': CALLS[round], 'served': 'small', 'maxTokens': 100}}]
    if text:
        values.append({'event': 'text', 'data': {'delta': text}})
    values.append(terminal(stop, text, calls, code))
    return [{'id': index + 1, **value} for index, value in enumerate(values)]

def exchange(values=None, refusal=None, broken=False, repeat=1):
    return {'events': values or [], 'refusal': refusal, 'broken': broken, 'repeat': repeat}

def refusal(code):
    return {'code': code, 'allowance': None}

def story(name):
    return {'format': 'coach-turn/v1', 'name': name, 'profile': copy.deepcopy(PROFILE),
        'input': {'turnId': TURN, 'seat': {'kind': 'bound', 'key': 'seat-1'}, 'question': 'Help', 'pictures': []},
        'runtime': {'nowMs': 0, 'callIds': CALLS, 'lockAvailable': True},
        'host': {'open': {'history': 'Earlier', 'context': ['Now'], 'pictures': []}, 'checks': {}, 'executions': {}, 'recovery': None},
        'service': {'passes': [{'pass': 'vector-pass', 'expiresIn': 600000}], 'exchanges': [], 'pictures': []}, 'controls': [],
        'expected': {'requests': [], 'hostCalls': [], 'gateRefusals': [], 'marks': [], 'waitsMs': [], 'telemetry': [], 'end': None}}

def request(s, messages):
    p = s['profile']
    return {'model': p['model'], 'system': p['system'], 'tools': [{k: v for k, v in t.items() if k != 'countsAsWrite'} for t in p['tools']], 'messages': copy.deepcopy(messages), 'output': {**p['output'], 'schema': None}, 'effort': p['effort'], 'cache': True}

def first(s):
    o, p = s['host']['open'], s['profile']['firstContent']
    return {'role': 'user', 'parts': ([{'text': p['historyPrefix'] + o['history']}] if o['history'] else []) + [{'text': p['contextPrefix'] + c} for c in o['context'] if c] + [{'image': {'picture': pic['pictureId']}} for pic in o['pictures']] + [{'text': p['questionPrefix'] + s['input']['question'] if s['input']['question'] else p['emptyQuestion']}]}

def opened(s):
    e = s['expected']
    e['hostCalls'].append({'op': 'open', 'input': copy.deepcopy(s['input'])})
    e['marks'].append({'turnId': TURN, 'callId': None, 'textBytesBeforeRound': 0})

def begin(s, round, text, messages):
    mark = {'turnId': TURN, 'callId': CALLS[round], 'textBytesBeforeRound': len(text.encode())}
    s['expected']['hostCalls'].append({'op': 'beginRound', 'text': text, 'mark': mark})
    s['expected']['marks'].append(mark)
    s['expected']['requests'].append({'method': 'PUT', 'path': f'/v1/calls/{CALLS[round]}/text?label=other', 'body': request(s, messages)})

def text_write(s, text):
    s['expected']['hostCalls'].append({'op': 'text', 'text': text})

def finish(s, state='completed', text='Hello', code=None, truncated=False, rounds=1, abilities=0, refusals=0, duration=0, withdraw=False, gone=False):
    end = {'state': state, 'text': text, 'truncated': truncated, 'code': code}
    s['expected']['end'] = None if gone else end
    if not gone:
        s['expected']['hostCalls'].append({'op': 'withdraw'} if withdraw else {'op': 'end', 'end': end})
        s['expected']['marks'].append(None)
    s['expected']['telemetry'].append({'kind': 'turn', 'state': state, 'seat': s['input']['seat']['kind'], 'code': code, 'rounds': rounds, 'abilityCalls': abilities, 'refusals': refusals, 'answerBytes': len(text.encode()), 'durationMs': duration})

def simple(name, stop='completed', code=None):
    s = story(name)
    s['service']['exchanges'] = [exchange(events(stop=stop, code=code))]
    opened(s); begin(s, 0, '', [first(s)]); text_write(s, 'Hello')
    if code == 'provider_rejected': s['expected']['telemetry'].append({'kind':'failure','operation':'ai-call'})
    finish(s, 'failed' if code else 'declined' if stop == 'declined' else 'completed', code=code, truncated=stop == 'truncated')
    return s

def tool_story(name, plans, limits=None, groups=None):
    s = story(name)
    if limits: s['profile']['limits'].update(limits)
    if groups is not None: s['profile']['groups'] = groups
    calls = [{'id': f'tool-{i}', 'name': plan.get('name', 'read'), 'input': plan.get('input', {'value': i})} for i, plan in enumerate(plans)]
    answer = terminal('tool_calls', 'First', calls)
    s['service']['exchanges'] = [exchange(events('First', 'tool_calls', calls)), exchange(events('Last', round=1))]
    opened(s); messages = [first(s)]; begin(s, 0, '', messages); text_write(s, 'First')
    results = []; admitted = 0; refused = 0
    for call, plan in zip(calls, plans):
        code = plan.get('code'); checks = plan.get('checks', ['seat', 'shape', 'product'])
        for rule in checks:
            s['expected']['hostCalls'].append({'op': 'check', 'rule': rule, 'call': call})
        if plan.get('hostCode'):
            s['host']['checks'][call['id']] = {checks[-1]: code}
        outcome = {'ok': False, 'code': code} if code else {'ok': True, 'content': str(call['input']['value'])}
        if plan.get('execute', code is None):
            s['host']['executions'][call['id']] = outcome
            s['expected']['hostCalls'].append({'op': 'execute', 'callId': CALLS[0], 'call': call})
            admitted += 1
        else:
            refused += 1
            s['expected']['gateRefusals'].append({'id': call['id'], 'code': code})
        s['expected']['telemetry'].append({'kind': 'ability', 'name': call['name'] if call['name'] in ['read', 'write'] else 'unoffered', 'outcome': 'refused' if code else 'ok', 'code': code})
        results.append({'id': call['id'], 'content': json.dumps({'code': code, 'message': s['profile']['refusals'][code]}, separators=(',', ':')) if code else outcome['content'], 'isError': bool(code)})
    messages += [answer['data']['message'], {'role': 'tool', 'results': results}]
    begin(s, 1, 'First', messages); text_write(s, 'FirstLast'); finish(s, text='FirstLast', rounds=2, abilities=admitted, refusals=refused)
    return s

def stories():
    out = [simple('text'), simple('truncated', 'truncated'), simple('declined', 'declined')]
    out += [simple('failed-' + code, code=code) for code in ['provider_rejected', 'provider_unavailable', 'provider_failed', 'accounting_unavailable']]
    out += [tool_story('two-rounds', [{}]), tool_story('several-calls', [{}, {}]),
        tool_story('gate-offered', [{'name': 'absent', 'code': 'not-offered', 'checks': []}]),
        tool_story('gate-seat', [{'code': 'seat-required', 'checks': ['seat'], 'hostCode': True}]),
        tool_story('gate-shape', [{'code': 'invalid-input', 'checks': ['seat', 'shape'], 'hostCode': True, 'input': {'value': 'wrong'}}]),
        tool_story('gate-once', [{'name': 'write'}, {'name': 'write', 'code': 'one-proposal', 'checks': ['seat', 'shape']}]),
        tool_story('gate-volume', [{}, {'code': 'coach-turn-volume', 'checks': ['seat', 'shape']}], limits={'abilityCalls': 1}),
        tool_story('gate-write-volume', [{'name': 'write'}, {'name': 'write', 'code': 'coach-turn-volume', 'checks': ['seat', 'shape']}], limits={'writes': 1}, groups=[]),
        tool_story('gate-product', [{'code': 'product-refused', 'hostCode': True}]),
        tool_story('executor-refusal-counts', [{'code': 'executor-refused', 'execute': True}, {'code': 'coach-turn-volume', 'checks': ['seat', 'shape']}], limits={'abilityCalls': 1})]
    for name, code, retry in [('first-refused', 'subject_exhausted', False), ('refusal-passes', 'rate_limited', True), ('refusal-deadline', 'paused', False)]:
        s = story(name); opened(s); begin(s, 0, '', [first(s)])
        if retry:
            s['service']['exchanges'] = [exchange(refusal=refusal(code)), exchange(events())]
            s['expected']['requests'] *= 2; s['expected']['waitsMs'] = [1000]; text_write(s, 'Hello'); finish(s, duration=1000)
        elif code == 'paused':
            s['service']['exchanges'] = [exchange(refusal=refusal(code), repeat=6)]
            s['expected']['requests'] *= 6; s['expected']['waitsMs'] = [1000,2000,4000,8000,8000,7000]
            finish(s, 'failed', '', code, duration=30000, withdraw=True)
        else:
            s['service']['exchanges'] = [exchange(refusal=refusal(code))]; finish(s, 'failed', '', code, withdraw=True)
        out.append(s)
    s = tool_story('later-refused', [{}]); s['service']['exchanges'][1] = exchange(refusal=refusal('subject_exhausted'))
    s['expected']['hostCalls'] = s['expected']['hostCalls'][:-2]; s['expected']['telemetry'].pop(); s['expected']['marks'].pop()
    finish(s, 'failed', 'First', 'subject_exhausted', rounds=2, abilities=1); out.append(s)
    for after in [False, True]:
        for found in ['again', 'gone', 'unknown']:
            s = story('lost-' + ('after' if after else 'before') + '-' + found); opened(s); begin(s, 0, '', [first(s)])
            initial = events()[:2] if after else []
            s['service']['exchanges'] = [exchange(initial, broken=True), exchange(events() if found == 'again' else None, refusal=None if found == 'again' else refusal('result_gone' if found == 'gone' else 'call_unknown'))]
            if after: text_write(s, 'Hello')
            s['expected']['requests'].append({'method':'GET', 'path': f'/v1/calls/{CALLS[0]}/result?after=2', 'body': None} if after else copy.deepcopy(s['expected']['requests'][0]))
            s['expected']['waitsMs'] = [1000]
            if found == 'again':
                if not after: text_write(s, 'Hello')
                finish(s, duration=1000)
            else:
                if found == 'unknown': s['expected']['telemetry'].append({'kind':'failure', 'operation':'ai-call'})
                finish(s, 'failed', 'Hello' if after else '', 'result_gone' if found == 'gone' else 'call_unknown', duration=1000)
            out.append(s)
    for twice in [False, True]:
        s=story('pass-expired-' + ('twice' if twice else 'once')); opened(s); begin(s,0,'',[first(s)])
        s['service']['passes'] *= 2; s['service']['exchanges']=[exchange(refusal=refusal('pass_expired')), exchange(refusal=refusal('pass_expired')) if twice else exchange(events())]
        s['expected']['requests'] *= 2
        if twice:
            s['expected']['telemetry'].append({'kind':'failure','operation':'ai-call'}); finish(s,'failed','','pass_expired',withdraw=True)
        else: text_write(s,'Hello'); finish(s)
        out.append(s)
    for location, action, terminal_stop in [('open:beforeCommit','stop','completed'), ('event:0:2','stop','completed'), ('event:0:2','stop','tool_calls'), ('wait:0','stop','completed'), ('event:0:2','seat','completed'), ('text:beforeCommit','delete','completed'), ('event:0:2','stale','completed')]:
        name = {'open:beforeCommit':'stop-pending-open','wait:0':'stop-retry','text:beforeCommit':'delete-during-write'}.get(location, f'{action}-{terminal_stop}')
        s=story(name); s['controls']=[{'at':location,'action':action}]; opened(s)
        if location == 'open:beforeCommit': finish(s,'stopped','',rounds=0)
        else:
            begin(s,0,'',[first(s)])
            s['service']['exchanges']=[exchange(events(stop=terminal_stop, calls=[{'id':'tool-0','name':'read','input':{'value':0}}] if terminal_stop=='tool_calls' else []))]
            if location=='wait:0':
                s['service']['exchanges']=[exchange(broken=True)]; s['expected']['waitsMs']=[1000]; finish(s,'stopped','')
            elif action=='delete': finish(s,'interrupted','Hello',gone=True)
            elif action=='seat': finish(s,'interrupted','')
            else:
                text_write(s,'Hello'); finish(s,'stopped' if terminal_stop=='tool_calls' else 'completed')
        out.append(s)
    for stop in ['completed','truncated','declined','tool_calls','provider_failed','gone','no-call']:
        s=story('recover-'+stop); mark={'turnId':TURN,'callId':None if stop=='no-call' else CALLS[0],'textBytesBeforeRound':3}
        s['host']['recovery']={'mark':mark,'text':'é!partial','state':'running'}
        s['expected']['hostCalls']=[{'op':'recover','turnId':TURN}]
        if stop!='no-call':
            s['service']['exchanges']=[exchange(refusal=refusal('result_gone')) if stop=='gone' else exchange(events('Hello', stop=stop if stop not in ['provider_failed'] else 'completed', code=stop if stop=='provider_failed' else None))]
            s['expected']['requests']=[{'method':'GET','path':f'/v1/calls/{CALLS[0]}/result','body':None}]
            if stop!='gone': text_write(s,'é!Hello')
        text='é!partial' if stop in ['gone','no-call'] else 'é!Hello'
        state='interrupted' if stop in ['tool_calls','gone','no-call'] else 'failed' if stop=='provider_failed' else 'declined' if stop=='declined' else 'completed'
        finish(s,state,text,'provider_failed' if stop=='provider_failed' else None,truncated=stop=='truncated',rounds=0); out.append(s)
    s=simple('duplicate-tool-ids'); duplicate={'id':'same','name':'read','input':{'value':1}}
    s['service']['exchanges']=[exchange(events(stop='tool_calls',calls=[duplicate,duplicate]))]
    s['expected']['hostCalls'].pop(); s['expected']['marks'].pop(); s['expected']['telemetry']= [{'kind':'failure','operation':'ai-call'}]
    finish(s,'failed','Hello','invalid-answer'); out.append(s)
    s=story('picture-repair'); picture={'pictureId':'PPPPPPPPPPPPPPPPPPPPPP','mediaType':'image/png','bytes':[137,80,78,71,13,10,26,10]}
    s['input']['pictures']=[picture]; s['host']['open']['pictures']=[picture]
    opened(s); begin(s,0,'',[first(s)])
    upload={'method':'PUT','path':'/v1/pictures/'+picture['pictureId'],'body':picture['bytes']}
    call=s['expected']['requests'][0]; s['expected']['requests']=[upload,call,upload,call]
    s['service']['exchanges']=[exchange(refusal=refusal('picture_gone')),exchange(events())]
    s['service']['pictures']=[204,204]; text_write(s,'Hello'); finish(s); out.append(s)
    s=copy.deepcopy(s); s['name']='picture-repair-twice'; s['service']['exchanges'][1]=exchange(refusal=refusal('picture_gone'))
    s['expected']['hostCalls']=s['expected']['hostCalls'][:-2]; s['expected']['marks'].pop(); s['expected']['telemetry']=[{'kind':'failure','operation':'ai-call'}]
    finish(s,'failed','','picture_gone',withdraw=True); out.append(s)
    s=story('lost-then-refused'); opened(s); begin(s,0,'',[first(s)])
    s['service']['exchanges']=[exchange(broken=True),exchange(refusal=refusal('subject_exhausted'))]
    s['expected']['requests'] *= 2; s['expected']['waitsMs']=[1000]
    finish(s,'failed','','subject_exhausted',duration=1000); out.append(s)
    s=story('answer-deadline'); opened(s); begin(s,0,'',[first(s)])
    s['service']['exchanges']=[exchange(broken=True,repeat=153)]
    s['expected']['requests'] *= 153; s['expected']['waitsMs']=[1000,2000,4000]+[8000]*149+[1000]
    finish(s,'failed','','answer-timeout',duration=1200000); out.append(s)
    s=tool_story('stop-during-execution',[{},{}]); s['controls']=[{'at':'execute:tool-0:beforeCommit','action':'stop'}]
    s['service']['exchanges']=s['service']['exchanges'][:1]
    s['expected']['requests']=s['expected']['requests'][:1]
    s['expected']['hostCalls']=s['expected']['hostCalls'][:7]
    s['expected']['marks']=s['expected']['marks'][:2]
    s['expected']['telemetry']=s['expected']['telemetry'][:1]
    finish(s,'stopped','First',abilities=1); out.append(s)
    s=tool_story('model-call-limit',[{}],limits={'modelCalls':1})
    s['service']['exchanges']=s['service']['exchanges'][:1]; s['expected']['requests']=s['expected']['requests'][:1]
    s['expected']['hostCalls']=s['expected']['hostCalls'][:-3]; s['expected']['marks']=s['expected']['marks'][:2]; s['expected']['telemetry'].pop()
    finish(s,'failed','First','model-call-limit',abilities=1); out.append(s)
    s=tool_story('gate-stop',[{'code':'stopped'}]); s['controls']=[{'at':'check:tool-0:product','action':'stop'}]
    s['service']['exchanges']=s['service']['exchanges'][:1]; s['expected']['requests']=s['expected']['requests'][:1]
    s['expected']['hostCalls']=s['expected']['hostCalls'][:-3]; s['expected']['marks']=s['expected']['marks'][:2]; s['expected']['telemetry'].pop()
    finish(s,'stopped','First',refusals=1); out.append(s)
    s=story('seat-pending-open'); s['controls']=[{'at':'open:beforeCommit','action':'seat'}]
    opened(s); finish(s,'interrupted','',rounds=0); out.append(s)
    for action, state in [('seat', 'interrupted'), ('stop', 'stopped')]:
        s=story(action + '-pending-round'); s['controls']=[{'at':'beginRound:beforeCommit','action':action}]
        opened(s); begin(s,0,'',[first(s)]); s['expected']['requests']=[]
        finish(s,state,'',rounds=0); out.append(s)
    s=story('pass-door-refused'); opened(s); begin(s,0,'',[first(s)]); s['expected']['requests']=[]
    s['service']['passes']=[{'status':401,'code':'unauthenticated'}]; finish(s,'failed','','unauthenticated',withdraw=True); out.append(s)
    encoded = json.dumps(tool_story('call-id-widths', [{}]))
    for before, after in zip(CALLS[:2], ['A' * 24, 'B' * 64]):
        encoded = encoded.replace(before, after)
    out.append(json.loads(encoded))
    return out

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    documents = {value['name'] + '.json': json.dumps(value, indent=2, ensure_ascii=False) + '\n' for value in stories()}
    if args.check:
        if set(documents) != {path.name for path in (ROOT / 'turns').glob('*.json')}: raise ValueError('story file set differs')
        for name, document in documents.items():
            if (ROOT / 'turns' / name).read_text() != document: raise ValueError(name + ': stale story')
        print(f'{len(documents)} Coach story files match their declarations')
    else:
        for name, document in documents.items(): (ROOT / 'turns' / name).write_text(document)
