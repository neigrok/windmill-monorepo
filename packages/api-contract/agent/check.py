#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('ai_wire', ROOT.parent / 'ai' / 'check.py')
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)

def check(story):
    wire.fields(story, 'format name profile input runtime host service controls expected')
    wire.require(story['format'] == 'coach-turn/v1', 'unknown story format')
    wire.fields(story['runtime'], 'nowMs callIds lockAvailable connected')
    wire.require(type(story['runtime']['connected']) is bool, 'connected is the device\'s report, true or false')
    for control in story['controls']:
        wire.fields(control, 'at action')
        wire.require(control['action'] in ['stop', 'seat', 'delete', 'stale', 'disconnect'], 'unknown control action')
    wire.fields(story['expected'], 'requests hostCalls gateRefusals marks waitsMs telemetry end')
    if not story['runtime']['connected'] and story['host']['recovery'] is None:
        wire.require(story['expected']['requests'] == [], 'a turn begun with no connection sends nothing')
    end = story['expected']['end']
    if end is not None and end['state'] == 'failed':
        wire.require(isinstance(end['code'], str) and bool(end['code']), 'failed end requires a code; an unknown outcome is interrupted')
    for exchange in story['service']['exchanges']:
        wire.fields({key: value for key, value in exchange.items() if key not in ['http', 'transport']}, 'events refusal broken repeat')
        if 'transport' in exchange:
            wire.require(exchange['transport'] == 'offline', 'transport failure')
            wire.require('http' not in exchange and not exchange['events'] and exchange['refusal'] is None and not exchange['broken'], 'a request that fails as offline has no answer')
        if 'http' in exchange:
            wire.fields(exchange['http'], 'status contentType body')
            wire.require(exchange['http']['status'] in [502, 503, 504], 'proxy status')
            wire.require(exchange['http']['contentType'] == 'text/html' and isinstance(exchange['http']['body'], str), 'proxy body')
        wire.integer(exchange['repeat'], 1)
        for event in exchange['events']:
            wire.fields(event, 'id event data')
            wire.integer(event['id'], 1)
            wire.text_event({key: event[key] for key in ['event', 'data']})
        if exchange['refusal'] is not None:
            wire.fields(exchange['refusal'], 'code allowance')
            wire.allowance(exchange['refusal']['allowance'], nullable=True)
    for request in story['expected']['requests']:
        wire.fields(request, 'method path body')
        if request['method'] == 'PUT' and '/text?' in request['path']:
            wire.text_request(request['body'])
    for mark in story['expected']['marks']:
        if mark is not None:
            wire.fields(mark, 'turnId callId textBytesBeforeRound')
            wire.integer(mark['textBytesBeforeRound'])
            if mark['callId'] is not None: wire.caller_id(mark['callId'])
    for event in story['expected']['telemetry']:
        shapes = {'failure': 'kind operation', 'ability': 'kind name outcome code', 'turn': 'kind state seat code rounds abilityCalls refusals answerBytes durationMs'}
        wire.fields(event, shapes[event['kind']])
        if event['kind'] == 'failure': wire.require(event['operation'] in ['ai-call', 'ai-pass', 'agent-host'], 'unbounded failure')

if __name__ == '__main__':
    paths = sorted((ROOT / 'turns').glob('*.json'))
    for path in paths:
        try: check(json.loads(path.read_text()))
        except Exception as error: raise ValueError(path.name + ': ' + str(error)) from error
    print(f'{len(paths)} Coach turn stories checked against AI wire shapes')
