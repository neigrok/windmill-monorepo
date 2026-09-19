#!/usr/bin/env python3
import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import stat
import struct
import sys
import time
from urllib.parse import urlsplit
import uuid
import zlib


class AcceptanceError(Exception):
    def __init__(self, message, status=None, code=None):
        super().__init__(message)
        self.status = status
        self.code = code if isinstance(code, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,79}', code) else None


def require(condition, message):
    if not condition:
        raise AcceptanceError(message)


def four_colours():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)

    pixels = bytearray()
    colours = ((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))
    for y in range(128):
        pixels.append(0)
        for x in range(128):
            pixels.extend(colours[(2 if y >= 64 else 0) + (1 if x >= 64 else 0)])
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 128, 128, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def configuration(argv=None):
    parser = argparse.ArgumentParser(description='Real-provider Coach acceptance. Without --execute, validates local inputs only; no network calls.')
    parser.add_argument('--base-url', '--origin', dest='origin', default=os.environ.get('COACH_TEST_ORIGIN', 'http://127.0.0.1:8088'))
    parser.add_argument('--session-file', '--input', dest='input', type=Path, help='Owner-only JSON: token, accountId, email, syntheticAccount:true. Otherwise use COACH_TEST_* environment variables.')
    parser.add_argument('--candidate-sha', default=os.environ.get('COACH_TEST_CANDIDATE_SHA'))
    parser.add_argument('--provider-marker', choices=['anthropic-production-configured'], default=os.environ.get('COACH_TEST_PROVIDER_MARKER'))
    parser.add_argument('--allow-remote', action='store_true', help='Explicitly allow a non-loopback HTTPS backend.')
    parser.add_argument('--execute', action='store_true', help='Send the bounded requests, which can incur provider charges and create test data.')
    parser.add_argument('--evidence-dir', type=Path, help='New or empty directory; made owner-only. Existing evidence is refused.')
    parser.add_argument('--request-timeout', type=int, default=180, choices=range(10, 181), metavar='10..180')
    parser.add_argument('--total-timeout', type=int, default=600, choices=range(30, 601), metavar='30..600')
    args = parser.parse_args(argv)
    require(args.origin and args.candidate_sha and args.provider_marker, 'Origin, candidate SHA and provider marker are required.')
    require(re.fullmatch(r'[0-9a-fA-F]{40}', args.candidate_sha), 'Candidate SHA must be a full 40-character source commit SHA.')
    parsed = urlsplit(args.origin)
    require(parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password
            and parsed.path in ('', '/') and not parsed.query and not parsed.fragment, 'Origin must be an HTTP(S) origin without credentials, path, query or fragment.')
    try:
        local = parsed.hostname == 'localhost' or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        local = False
    require(local or args.allow_remote, 'Non-loopback origins require explicit --allow-remote.')
    require(local or parsed.scheme == 'https', 'Non-loopback origins require HTTPS.')
    args.port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    args.host = parsed.hostname
    args.scheme = parsed.scheme
    args.origin = f'{parsed.scheme}://{parsed.netloc}'.rstrip('/')
    if args.input:
        descriptor = os.open(args.input, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor) as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                    'Credential file must be a regular file owned by you with no group or other permissions (chmod 600).')
            require(info.st_size <= 16384, 'Credential file is too large.')
            credentials = json.load(source)
    else:
        credentials = {'token': os.environ.get('COACH_TEST_TOKEN'), 'accountId': os.environ.get('COACH_TEST_ACCOUNT_ID'),
                       'email': os.environ.get('COACH_TEST_EMAIL'), 'syntheticAccount': os.environ.get('COACH_TEST_SYNTHETIC') == 'true'}
    require(isinstance(credentials, dict), 'Credential input must be a JSON object.')
    require(credentials.get('syntheticAccount') is True, 'Explicit syntheticAccount:true attestation is required.')
    require(isinstance(credentials.get('token'), str) and 16 <= len(credentials['token']) <= 4096
            and not re.search(r'\s', credentials['token']), 'A valid synthetic account bearer token is required.')
    require(isinstance(credentials.get('accountId'), str) and credentials['accountId'], 'Expected synthetic account ID is required.')
    require(isinstance(credentials.get('email'), str) and re.fullmatch(r'[^@\s]+@example\.invalid', credentials['email']),
            'The dedicated synthetic account email must use example.invalid.')
    args.credentials = credentials
    return args


class Evidence:
    def __init__(self, directory, token):
        require(not directory.is_symlink(), 'Evidence directory must not be a symlink.')
        directory.mkdir(mode=0o700, parents=False, exist_ok=True)
        require(directory.stat().st_uid == os.getuid() and not any(directory.iterdir()), 'Evidence directory must be yours and empty; existing evidence is never overwritten.')
        directory.chmod(0o700)
        self.directory = directory
        self.token = token

    def sanitize(self, value):
        if isinstance(value, dict):
            return {key: self.sanitize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.sanitize(item) for item in value]
        if not isinstance(value, str):
            return value
        value = value.replace(self.token, '[REDACTED]')
        value = re.sub(r'(?i)Bearer\s+[^\s"\\]+', 'Bearer [REDACTED]', value)
        value = re.sub(r'(?i)data:image/[^\s"<>]+', '[IMAGE OMITTED]', value)
        return re.sub(r'[A-Za-z0-9+/]{120,}={0,2}', '[ENCODED PAYLOAD OMITTED]', value)

    def generation(self, generation):
        fields = ('id', 'requestId', 'question', 'answer', 'at', 'status', 'revision')
        result = {field: generation[field] for field in fields if field in generation and isinstance(generation[field], (str, int))}
        result['results'] = [{key: item[key] for key in ('kind', 'operationId', 'routineId', 'routineName') if key in item and isinstance(item[key], str)}
                             for item in generation.get('results', []) if isinstance(item, dict)]
        result['attachments'] = [{key: image[key] for key in ('id', 'mediaType', 'width', 'height', 'bytes') if key in image and isinstance(image[key], (str, int))}
                                 for image in generation.get('attachments', []) if isinstance(image, dict)]
        receipt = generation.get('receipt')
        if isinstance(receipt, dict):
            read = receipt.get('read') if isinstance(receipt.get('read'), dict) else {}
            result['receipt'] = {'version': receipt.get('version') if type(receipt.get('version')) is int else None,
                                 'read': {key: read[key] for key in ('sets', 'sessions', 'weeks') if type(read.get(key)) is int},
                                 'steps': [{key: step[key] for key in ('tool', 'failed') if key in step and isinstance(step[key], (str, bool))}
                                           for step in receipt.get('steps', []) if isinstance(step, dict)],
                                 'proposals': [item for item in receipt.get('proposals', []) if isinstance(item, str)],
                                 'observationCount': len(receipt.get('observations', []))}
        return self.sanitize(result)

    def report(self, report):
        content = json.dumps(self.sanitize(report), indent=2, ensure_ascii=False) + '\n'
        require(len(content.encode()) <= 2 * 1024 * 1024, 'Sanitized evidence exceeded 2 MiB; no larger artifact will be written.')
        descriptor = os.open(self.directory / 'coach-provider-acceptance.json', os.O_WRONLY | os.O_TRUNC | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as target:
            target.write(content)

    def routine(self, routine, exercise_names):
        result = {key: routine[key] for key in ('id', 'name') if isinstance(routine.get(key), str)}
        result['entries'] = []
        for entry in routine.get('entries', []):
            line = {key: entry[key] for key in ('position', 'exerciseId', 'restSeconds') if isinstance(entry.get(key), (str, int))}
            line['exerciseName'] = exercise_names.get(entry.get('exerciseId'))
            line['sets'] = [{key: target[key] for key in ('reps', 'weightKg') if key in target and isinstance(target[key], (int, float, type(None)))}
                            for target in entry.get('sets', [])]
            result['entries'].append(line)
        return self.sanitize(result)


class Backend:
    def __init__(self, args, evidence, connection_factory=None):
        self.args = args
        self.evidence = evidence
        self.deadline = time.monotonic() + args.total_timeout
        self.calls = 0
        self.asks = 0
        self.requests = {}
        self.completed = set()
        self.trace = []
        self.connection_factory = connection_factory

    def call(self, label, method, path, body=None, image=None, stream=False, binary=False):
        require(method == 'GET' or method == 'POST' and path == '/v1/gym/ask'
                or method == 'PUT' and re.fullmatch(r'/v1/gym/threads/thr_[a-f0-9]{32}/attachments/img_[a-f0-9]{32}', path),
                'This script only reads, asks Coach, and uploads its synthetic image.')
        require(self.calls < 24, 'HTTP request bound reached.')
        if path == '/v1/gym/ask':
            require(self.asks < 4, 'Coach request bound reached; no automatic retries are allowed.')
            payload = {key: value for key, value in body.items() if key != 'stream'}
            request_id = payload['requestId']
            if request_id in self.requests:
                require(self.requests[request_id] == payload and request_id in self.completed, 'Only an identical completed request may be replayed.')
            else:
                require(len(self.requests) < 3, 'New Coach request bound reached.')
                self.requests[request_id] = payload
            self.asks += 1
        remaining = min(self.args.request_timeout, self.deadline - time.monotonic())
        require(remaining > 0, 'Total acceptance deadline reached.')
        self.calls += 1
        content = image if image is not None else json.dumps(body).encode() if body is not None else None
        connection_type = self.connection_factory or (http.client.HTTPSConnection if self.args.scheme == 'https' else http.client.HTTPConnection)
        host = '127.0.0.1' if self.args.host == 'localhost' and self.args.scheme == 'http' else self.args.host
        connection = connection_type(host, self.args.port, timeout=min(30, remaining))
        start = time.monotonic()
        signal.setitimer(signal.ITIMER_REAL, remaining)
        try:
            connection.request(method, path, content, {'Authorization': 'Bearer ' + self.args.credentials['token'],
                               'Content-Type': 'image/png' if image is not None else 'application/json',
                               'Accept': 'text/event-stream' if stream else '*/*'})
            response = connection.getresponse()
            headers = {key: response.getheader(key) for key in ('Content-Type', 'Cache-Control')}
            self.trace.append({'label': label, 'method': method, 'status': response.status})
            if stream and response.status == 200 and 'text/event-stream' in (headers['Content-Type'] or ''):
                events, frame, total = [], [], 0
                while True:
                    raw = response.readline(1048577)
                    total += len(raw)
                    require(len(raw) <= 1048576 and total <= 8 * 1024 * 1024, 'SSE evidence size limit reached.')
                    if not raw:
                        break
                    line = raw.decode('utf-8')
                    frame.append(line)
                    if line.rstrip('\r\n'):
                        continue
                    wire = ''.join(frame)
                    frame = []
                    event, data, event_id = '', [], ''
                    for field in wire.splitlines():
                        if field.startswith('event:'):
                            event = field[6:].strip()
                        elif field.startswith('data:'):
                            data.append(field[5:].lstrip(' '))
                        elif field.startswith('id:'):
                            event_id = field[3:].strip()
                    if not data:
                        continue
                    payload = json.loads('\n'.join(data))
                    item = {'event': event, 'id': event_id, 'seconds': round(time.monotonic() - start, 6), 'payload': payload}
                    events.append(item)
                    if payload.get('generation', {}).get('status') == 'completed':
                        self.completed.add(payload['generation'].get('requestId'))
                    if event == 'error' or payload.get('generation', {}).get('status') in ('completed', 'failed', 'stopped'):
                        break
                return response.status, {'events': events}, headers
            raw = response.read(2 * 1024 * 1024 + 1)
            require(len(raw) <= 2 * 1024 * 1024, 'HTTP response size limit reached.')
            if binary:
                return response.status, raw, headers
            wire = raw.decode('utf-8')
            return response.status, json.loads(wire) if wire else None, headers
        except (OSError, ValueError, http.client.HTTPException, TimeoutError) as error:
            raise AcceptanceError(f'{label}: {type(error).__name__}; no retry was sent. An accepted request may still be running.') from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            connection.close()

    def get(self, label, path):
        status, body, _ = self.call(label, 'GET', path)
        if status != 200:
            raise AcceptanceError(f'{label}: expected HTTP 200, received {status}.', status, body.get('code') if isinstance(body, dict) else None)
        return body


def check(case, area, name, passed, detail=None):
    case[area].append({'check': name, 'status': 'pass' if passed else 'fail', **({'detail': detail} if detail else {})})


def visible_text_timing(snapshots):
    terminal = snapshots[-1]
    final = terminal['payload']['generation']
    partial = next((event for event in snapshots[:-1] if event['payload']['generation'].get('status') == 'running'
                    and event['payload']['generation'].get('answer', '').strip()), None)
    interval = round(terminal['seconds'] - partial['seconds'], 6) if partial else None
    first = partial['payload']['generation'] if partial else {}
    growth = len(final.get('answer', '')) - len(first.get('answer', '')) if partial else None
    revision_advanced = type(first.get('revision')) is int and type(final.get('revision')) is int and first['revision'] < final['revision']
    observed = (partial is not None and interval >= 0.25 and growth > 0 and revision_advanced
                and final.get('status') in ('completed', 'failed', 'stopped'))
    return {'status': 'pass' if observed else 'inconclusive', 'minimumIntervalSeconds': 0.25,
            'firstVisibleSeconds': partial['seconds'] if partial else None, 'terminalSeconds': terminal['seconds'],
            'visibleToTerminalSeconds': interval, 'answerGrowthCharacters': growth,
            'firstVisibleRevision': first.get('revision'), 'terminalRevision': final.get('revision'),
            'interpretation': 'Acceptance requires visible partial text at least 250 ms before terminal, with later text growth and revision. Insufficient evidence does not establish a product defect.'}


def streamed_case(api, case, request):
    status, body, headers = api.call(case['name'], 'POST', '/v1/gym/ask', {**request, 'stream': True}, stream=True)
    case['httpStatus'] = status
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get('events'), list):
        raise AcceptanceError('Expected HTTP 200 SSE response.', status, body.get('code') if isinstance(body, dict) else None)
    events = body['events']
    case['refusals'] = []
    for event in events:
        if event['event'] == 'error':
            refusal = AcceptanceError('SSE refusal', event['payload'].get('status'), event['payload'].get('code'))
            case['refusals'].append({'status': refusal.status if type(refusal.status) is int else None, 'code': refusal.code})
    snapshots = [event for event in events if event['event'] == 'snapshot']
    require(snapshots, 'No generation snapshots received.')
    generations = [event['payload'].get('generation', {}) for event in snapshots]
    final = generations[-1]
    check(case, 'contract', 'no_sse_refusal', not any(event['event'] == 'error' for event in events))
    check(case, 'contract', 'stream_cache_policy', 'no-cache' in (headers['Cache-Control'] or ''))
    check(case, 'contract', 'immutable_identity', all(event['payload'].get('thread') == request['thread']
          and generation.get('requestId') == request['requestId'] and generation.get('question') == request['question']
          and generation.get('id') == final.get('id') for event, generation in zip(snapshots, generations)))
    revisions = [generation.get('revision') for generation in generations]
    check(case, 'contract', 'monotonic_revisions', all(type(value) is int for value in revisions)
          and all(a < b for a, b in zip(revisions, revisions[1:])))
    check(case, 'contract', 'event_ids_match_snapshots', all(event['id'] == f"{generation.get('id')}:{generation.get('revision')}"
          for event, generation in zip(snapshots, generations)))
    check(case, 'contract', 'terminal_snapshot', final.get('status') in ('completed', 'failed', 'stopped'))
    check(case, 'quality', 'model_completed', final.get('status') == 'completed')
    case['timing'] = {'snapshots': len(snapshots), 'lastSnapshotSeconds': snapshots[-1]['seconds']}
    case['snapshots'] = [{'seconds': event['seconds'], 'generation': api.evidence.generation(event['payload']['generation'])} for event in snapshots]
    return final, snapshots


def history_pair(api, case, request, final):
    thread = api.get(case['name'] + '_history', '/v1/gym/threads/' + request['thread'] + '?limit=50')
    turns = [turn for turn in thread.get('turns', []) if turn.get('requestId') == request['requestId']]
    check(case, 'contract', 'persisted_exchange', len(turns) == 2 and [turn.get('from') for turn in turns] == ['lifter', 'ask'])
    if len(turns) == 2:
        check(case, 'contract', 'persisted_answer_and_status', turns[1].get('text') == final.get('answer') and turns[1].get('status') == final.get('status'))
        check(case, 'contract', 'persisted_results', turns[1].get('results', []) == final.get('results', []))
    case['persistedExchange'] = [{key: turn[key] for key in ('position', 'from', 'text', 'status', 'requestId', 'generationId') if key in turn and isinstance(turn[key], (str, int))} for turn in turns]
    return thread, turns


def run(args, backend_factory=Backend):
    run_id = uuid.uuid4().hex
    directory = args.evidence_dir or Path(__file__).parent / ('live-provider-' + run_id)
    evidence = Evidence(directory, args.credentials['token'])
    api = backend_factory(args, evidence)
    report = {'candidateSourceSha': args.candidate_sha.lower(), 'origin': args.origin,
              'provider': {'configuredMarker': args.provider_marker, 'source': 'operator attestation; not independently inferred from the backend'},
              'runId': run_id, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'limits': {'newCoachRequests': 3, 'completedReplayRequests': 1, 'httpRequests': 24,
                         'requestSeconds': args.request_timeout, 'totalSeconds': args.total_timeout},
              'evidence': 'Allowlisted synthetic visible answers, generation metadata, receipts, results and check outcomes; no raw transport/provider payloads, headers, internal reasoning, credentials or image bytes.',
              'manualJudgment': ['Confirm deployed backend binary corresponds to candidate source SHA and uses the real provider.',
                                 'Assess friendliness, relevance, factual grounding and useful length of the text answer.',
                                 'Review prompt adherence: read user context before decisions, short direct friendly paragraphs, numbers with reasons, and questions when information is missing.',
                                 'If Coach saves Notes, verify useful stated constraints were saved faithfully without invented facts.',
                                 'Check image answer maps red top-left, green top-right, blue bottom-left and yellow bottom-right; lexical color checks are not semantic proof.',
                                 'Assess routine suitability and cautious guidance; automated schema/target checks do not establish personal exercise safety.',
                                 'No provider billing introspection: same-ID replay is checked via response/persistence equality, not an independent vendor-call counter.'],
              'cases': [], 'cleanup': 'No data deleted; all test conversations, image and any created routine remain on the synthetic account.'}
    evidence.report(report)
    try:
        user = api.get('synthetic_identity', '/v1/me').get('user', {})
        require(user.get('id') == args.credentials['accountId'] and user.get('email') == args.credentials['email'], 'Authenticated account does not match the explicit synthetic identity.')
        routines = api.get('preflight_routines', '/v1/gym/routines')
        threads = api.get('preflight_threads', '/v1/gym/threads?limit=1')
        notes = api.get('preflight_notes', '/v1/gym/notes')
        require(routines.get('routines') == [] and threads.get('threads') == [] and notes.get('notes') == [],
                'Use a separately created fresh synthetic account with no routines, conversations or Notes. Nothing was deleted.')
        report['preflight'] = 'pass'
        for name in ('streamed_text', 'photo_understanding', 'routine_creation'):
            case = {'name': name, 'contract': [], 'quality': [], 'manualQualityReview': 'pending'}
            report['cases'].append(case)
            request = {'thread': 'thr_' + uuid.uuid4().hex, 'requestId': 'ask_' + uuid.uuid4().hex, 'question': ''}
            case['request'] = request
            try:
                if name == 'streamed_text':
                    request['question'] = ('I am a healthy adult beginner with no injuries, learning strength training. Explain in about 200 words how to choose a comfortable starting weight and make small progress without testing a maximum. Please give practical guidance; do not create or change a routine.')
                    final, snapshots = streamed_case(api, case, request)
                    timing = visible_text_timing(snapshots)
                    case['timing'].update(timing)
                    case['contract'].append({'check': 'visible_text_before_terminal', 'status': timing['status']})
                    check(case, 'quality', 'nonempty_visible_answer', bool(final.get('answer', '').strip()))
                    check(case, 'quality', 'no_unrequested_routine', not final.get('results'))
                    history_pair(api, case, request, final)
                elif name == 'photo_understanding':
                    png = four_colours()
                    case['syntheticImage'] = {'width': 128, 'height': 128, 'sha256': hashlib.sha256(png).hexdigest(),
                                              'quadrants': {'topLeft': 'red', 'topRight': 'green', 'bottomLeft': 'blue', 'bottomRight': 'yellow'}}
                    image_id = 'img_' + uuid.uuid4().hex
                    path = '/v1/gym/threads/' + request['thread'] + '/attachments/' + image_id
                    status, upload, _ = api.call('synthetic_image_upload', 'PUT', path, image=png)
                    if status != 200 or not isinstance(upload, dict):
                        raise AcceptanceError('Synthetic PNG upload failed; no image question sent.', status, upload.get('code') if isinstance(upload, dict) else None)
                    metadata = upload.get('attachment', {})
                    check(case, 'contract', 'image_metadata', metadata == {'id': image_id, 'mediaType': 'image/png', 'width': 128, 'height': 128, 'bytes': len(png)})
                    request['question'] = 'Describe the colors in this image by quadrant: top left, top right, bottom left, and bottom right. Only describe what you see; do not create or change anything.'
                    request['attachmentIds'] = [image_id]
                    final, _ = streamed_case(api, case, request)
                    thread, turns = history_pair(api, case, request, final)
                    check(case, 'contract', 'image_caption_title', thread.get('title') == request['question'])
                    check(case, 'contract', 'image_reference_and_caption_persist', final.get('attachments') == [metadata] and bool(turns) and turns[0].get('attachments') == [metadata] and turns[0].get('text') == request['question'])
                    status, returned, headers = api.call('owner_image_history_read', 'GET', path, binary=True)
                    check(case, 'contract', 'owner_image_bytes', status == 200 and returned == png)
                    check(case, 'contract', 'private_image_cache_policy', 'private' in (headers['Cache-Control'] or '') and 'no-store' in (headers['Cache-Control'] or ''))
                    colors = {color: bool(re.search(r'\b' + color + r'\b', final.get('answer', ''), re.IGNORECASE)) for color in ('red', 'green', 'blue', 'yellow')}
                    case['qualitySignals'] = {'expectedColorWordsPresent': colors, 'interpretation': 'Lexical hints only; semantic color identification requires manual review.'}
                    check(case, 'quality', 'nonempty_image_description', bool(final.get('answer', '').strip()))
                    check(case, 'quality', 'no_unrequested_routine', not final.get('results'))
                else:
                    require(api.get('before_create_routines', '/v1/gym/routines').get('routines') == [], 'Earlier test unexpectedly created a routine; creation case withheld.')
                    request['question'] = ('Please create exactly one new routine called Gentle Beginner Practice now. I am a healthy adult beginner with no injuries or restrictions, familiar with basic bodyweight movements, and want general strength. I have a mat and bodyweight only, 20 minutes, twice a week on nonconsecutive days. Use the supported movement catalog to choose three simple bodyweight exercises, two sets of eight comfortable repetitions each, no added weight, and 60 seconds rest. Keep effort easy with several repetitions in reserve. I authorize saving this new routine; do not alter existing routines or create more than one. You have enough context to choose suitable catalog movements.')
                    final, _ = streamed_case(api, case, request)
                    thread, turns = history_pair(api, case, request, final)
                    results = [result for result in final.get('results', []) if result.get('kind') == 'routine-created']
                    check(case, 'quality', 'requested_routine_created', len(results) == 1)
                    receipt = final.get('receipt')
                    check(case, 'contract', 'structured_receipt', isinstance(receipt, dict) and isinstance(receipt.get('version'), int)
                          and isinstance(receipt.get('read'), dict) and all(type(receipt['read'].get(field)) is int for field in ('sets', 'sessions', 'weeks'))
                          and all(isinstance(receipt.get(field), list) for field in ('steps', 'proposals', 'observations')))
                    check(case, 'contract', 'immutable_history_receipt', bool(receipt) and len(turns) == 2 and turns[1].get('receipt') == receipt)
                    before = api.get('after_create_routines', '/v1/gym/routines').get('routines', [])
                    if len(results) == 1:
                        routine_id = results[0].get('routineId')
                        require(isinstance(routine_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', routine_id), 'Malformed routine ID in result.')
                        routine = api.get('created_routine', '/v1/gym/routines/' + routine_id)
                        check(case, 'contract', 'exactly_one_persisted_routine', len(before) == 1 and before[0].get('id') == routine_id)
                        entries = routine.get('entries', [])
                        catalog = api.get('created_routine_catalog', '/v1/gym/exercises').get('exercises', [])
                        exercise_names = {exercise['id']: exercise['name'] for exercise in catalog
                                          if isinstance(exercise.get('id'), str) and isinstance(exercise.get('name'), str)}
                        case['routine'] = api.evidence.routine(routine, exercise_names)

                        check(case, 'quality', 'requested_easy_targets', len(entries) == 3 and all(entry.get('restSeconds') == 60
                              and len(entry.get('sets', [])) == 2 and all(target.get('reps') == 8 and target.get('weightKg', 0) in (0, None)
                              for target in entry.get('sets', [])) for entry in entries))
                    if final.get('status') == 'completed':
                        before_notes = api.get('before_replay_notes', '/v1/gym/notes').get('notes', [])
                        case['savedNotes'] = [{key: note[key] for key in ('id', 'position', 'title', 'body', 'updatedAt')
                                               if key in note and isinstance(note[key], (str, int))} for note in before_notes]
                        status, replay, _ = api.call('completed_request_replay', 'POST', '/v1/gym/ask', request)
                        refusal = AcceptanceError('Replay', status, replay.get('code') if isinstance(replay, dict) else None)
                        case['replayResponse'] = {'status': status, 'code': refusal.code}
                        check(case, 'contract', 'same_request_replays_snapshot', status == 200 and replay.get('generation') == final)
                        after = api.get('after_replay_routines', '/v1/gym/routines').get('routines', [])
                        check(case, 'contract', 'replay_preserves_routines', after == before and len(after) == 1)
                        after_thread = api.get('after_replay_history', '/v1/gym/threads/' + request['thread'] + '?limit=50')
                        check(case, 'contract', 'replay_preserves_exchange_and_receipt', after_thread.get('turns') == thread.get('turns'))
                        after_notes = api.get('after_replay_notes', '/v1/gym/notes').get('notes', [])
                        check(case, 'contract', 'replay_preserves_notes_without_duplicates', after_notes == before_notes)
                    else:
                        case['contract'].append({'check': 'completed_request_replay', 'status': 'not_evaluated', 'detail': 'Non-completed generations are never automatically retried.'})
            except (AcceptanceError, KeyError, TypeError, AttributeError) as error:
                case['error'] = str(error) if isinstance(error, AcceptanceError) else type(error).__name__
                if isinstance(error, AcceptanceError):
                    case['failure'] = {'status': error.status, 'code': error.code}
                check(case, 'contract', 'case_completed', False)
            evidence.report(report)
    except AcceptanceError as error:
        report['error'] = str(error)
        report['failure'] = {'status': error.status, 'code': error.code}
    finally:
        report['httpRequests'] = api.calls
        report['httpOutcomes'] = api.trace
        report['coachRequests'] = api.asks
        report['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        for case in report['cases']:
            for area in ('contract', 'quality'):
                statuses = {item['status'] for item in case[area]}
                case[area + 'Outcome'] = 'fail' if 'fail' in statuses else 'inconclusive' if 'inconclusive' in statuses else 'pass' if statuses else 'not_evaluated'
        outcomes = {case[area + 'Outcome'] for case in report['cases'] for area in ('contract', 'quality')}
        if report.get('error') or len(report['cases']) != 3 or outcomes.intersection({'fail', 'not_evaluated'}):
            report['automatedOutcome'] = 'fail'
        elif 'inconclusive' in outcomes:
            report['automatedOutcome'] = 'inconclusive'
        else:
            report['automatedOutcome'] = 'pass'
        report['manualQualityOutcome'] = 'pending'
        evidence.report(report)
    print(f"Automated checks: {report['automatedOutcome']}; manual quality review: pending. Evidence: {directory}")
    return {'pass': 0, 'fail': 1, 'inconclusive': 3}[report['automatedOutcome']]


def main():
    def deadline(signum, frame):
        raise TimeoutError('Acceptance deadline reached')

    signal.signal(signal.SIGALRM, deadline)
    try:
        args = configuration()
        if not args.execute:
            print('Configuration valid. No HTTP/provider calls sent. Use --execute only when authorized.')
            return 0
        return run(args)
    except (AcceptanceError, OSError, ValueError) as error:
        print(str(error) if isinstance(error, AcceptanceError) else f'Configuration/evidence failure: {type(error).__name__}.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
