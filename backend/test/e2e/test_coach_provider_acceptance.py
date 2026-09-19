import contextlib
import io
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
import zlib

import coach_provider_acceptance as acceptance


class ProviderAcceptanceTests(unittest.TestCase):
    def arguments(self, directory, *extra):
        credentials = {'token': 'synthetic-session-value-123456789', 'accountId': 'synthetic-account',
                       'email': 'coach-provider-test@example.invalid', 'syntheticAccount': True}
        session = directory / 'session.json'
        session.write_text(json.dumps(credentials))
        session.chmod(0o600)
        return acceptance.configuration(['--base-url', 'http://127.0.0.1:8188', '--session-file', str(session),
                                         '--candidate-sha', 'a' * 40, '--provider-marker', 'anthropic-production-configured',
                                         '--evidence-dir', str(directory / 'evidence'), *extra])

    def test_origin_and_synthetic_credentials_are_required_before_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            args = self.arguments(directory)
            self.assertFalse(args.execute)
            for origin in ('https://example.com', 'http://10.0.0.1:8188', 'http://127.0.0.1:8188/v1', 'http://user:password@127.0.0.1'):
                with self.subTest(origin=origin), self.assertRaises(acceptance.AcceptanceError):
                    self.arguments(directory, '--base-url', origin)
            remote = self.arguments(directory, '--base-url', 'https://example.com', '--allow-remote')
            self.assertEqual(remote.origin, 'https://example.com')
            with self.assertRaises(acceptance.AcceptanceError):
                self.arguments(directory, '--base-url', 'http://example.com', '--allow-remote')
            session = directory / 'session.json'
            session.chmod(0o644)
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.configuration(['--session-file', str(session), '--candidate-sha', 'a' * 40,
                                           '--provider-marker', 'anthropic-production-configured'])
            session.chmod(0o600)
            credentials = json.loads(session.read_text())
            credentials['email'] = 'real-user@example.com'
            session.write_text(json.dumps(credentials))
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.configuration(['--session-file', str(session), '--candidate-sha', 'a' * 40,
                                           '--provider-marker', 'anthropic-production-configured'])

    def test_png_is_exactly_four_known_128_pixel_quadrants(self):
        png = acceptance.four_colours()
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        offset, compressed = 8, bytearray()
        while offset < len(png):
            length = struct.unpack('!I', png[offset:offset + 4])[0]
            kind = png[offset + 4:offset + 8]
            data = png[offset + 8:offset + 8 + length]
            crc = struct.unpack('!I', png[offset + 8 + length:offset + 12 + length])[0]
            self.assertEqual(crc, zlib.crc32(kind + data) & 0xffffffff)
            if kind == b'IHDR':
                self.assertEqual(struct.unpack('!IIBBBBB', data), (128, 128, 8, 2, 0, 0, 0))
            if kind == b'IDAT':
                compressed.extend(data)
            offset += length + 12
        raw = zlib.decompress(compressed)
        expected = bytearray()
        for y in range(128):
            expected.append(0)
            expected.extend((b'\xff\x00\x00' * 64 + b'\x00\xff\x00' * 64) if y < 64
                            else (b'\x00\x00\xff' * 64 + b'\xff\xff\x00' * 64))
        self.assertEqual(raw, expected)

    def test_evidence_is_allowlisted_private_bounded_and_never_overwrites_existing_runs(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'evidence'
            directory.mkdir()
            evidence = acceptance.Evidence(directory, 'session-secret')
            source = {'id': 'gen_1', 'answer': 'Visible session-secret Bearer other-secret data:image/png;base64,AAAA',
                      'thinking': 'private reasoning', 'provider': {'api_key': 'never-store'},
                      'attachments': [{'id': 'img_1', 'width': 128, 'data': 'image-payload'}],
                      'results': [{'kind': 'routine-created', 'routineId': 'rt_1', 'arguments': 'private tool arguments'}],
                      'receipt': {'version': 1, 'read': {'sets': 0, 'sessions': 0, 'weeks': 0, 'secret': 'hidden'},
                                  'steps': [{'tool': 'gym_list_notes', 'failed': False, 'arguments': 'hidden'}],
                                  'proposals': [], 'observations': [], 'private': 'hidden'}}
            evidence.report({'generation': evidence.generation(source)})
            report = directory / 'coach-provider-acceptance.json'
            self.assertEqual(json.loads(report.read_text()), {'generation': {
                'id': 'gen_1', 'answer': 'Visible [REDACTED] Bearer [REDACTED] [IMAGE OMITTED]',
                'attachments': [{'id': 'img_1', 'width': 128}], 'results': [{'kind': 'routine-created', 'routineId': 'rt_1'}],
                'receipt': {'version': 1, 'read': {'sets': 0, 'sessions': 0, 'weeks': 0},
                            'steps': [{'tool': 'gym_list_notes', 'failed': False}], 'proposals': [], 'observationCount': 0}}})
            self.assertEqual(stat.S_IMODE(report.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertEqual([path.name for path in directory.iterdir()], ['coach-provider-acceptance.json'])
            with self.assertRaises(acceptance.AcceptanceError):
                acceptance.Evidence(directory, 'session-secret')
            before = report.read_bytes()
            with self.assertRaises(acceptance.AcceptanceError):
                evidence.report({'answer': 'word ' * 500000})
            self.assertEqual(report.read_bytes(), before)

    def test_full_acceptance_pipeline_withholds_buffered_stream_acceptance_without_extra_requests(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            args = self.arguments(directory)
            calls, generations, images, routines = [], {}, {}, []
            clients = []

            class Response:
                def __init__(self, body, media='application/json'):
                    self.status = 200
                    self.media = media
                    self.content = io.BytesIO(body if isinstance(body, bytes) else json.dumps(body).encode())

                def getheader(self, name):
                    return self.media if name == 'Content-Type' else 'private, no-store' if self.media == 'image/png' else 'no-cache'

                def read(self, size):
                    return self.content.read(size)

                def readline(self, size):
                    return self.content.readline(size)

            class Connection:
                def __init__(self, host, port, timeout):
                    self.response = None

                def request(self, method, path, content, headers):
                    calls.append((method, path))
                    if path == '/v1/me':
                        self.response = Response({'user': {key: args.credentials[key] for key in ('accountId', 'email')} | {'id': args.credentials['accountId']}})
                    elif path == '/v1/gym/routines':
                        self.response = Response({'routines': routines})
                    elif path.startswith('/v1/gym/routines/'):
                        self.response = Response(routines[0])
                    elif path == '/v1/gym/notes':
                        self.response = Response({'notes': []})
                    elif path == '/v1/gym/exercises':
                        self.response = Response({'exercises': [{'id': f'ex_{position}', 'name': f'Bodyweight movement {position}'} for position in range(3)]})
                    elif path == '/v1/gym/threads?limit=1':
                        self.response = Response({'threads': []})
                    elif method == 'PUT':
                        images[path] = content
                        self.response = Response({'attachment': {'id': path.split('/')[-1], 'mediaType': 'image/png', 'width': 128, 'height': 128, 'bytes': len(content)}})
                    elif '/attachments/' in path:
                        self.response = Response(images[path], 'image/png')
                    elif path == '/v1/gym/ask':
                        request = json.loads(content)
                        if request['requestId'] in generations:
                            self.response = Response({'thread': request['thread'], 'generation': generations[request['requestId']]})
                            return
                        routine = request['question'].startswith('Please create exactly one')
                        generation = {'id': 'gen_' + request['requestId'], 'requestId': request['requestId'], 'question': request['question'],
                                      'answer': 'Red, green, blue and yellow.' if request.get('attachmentIds') else 'Use comfortable effort and leave a few repetitions in reserve.',
                                      'at': 100, 'status': 'completed', 'revision': 2, 'results': [],
                                      'receipt': {'version': 1, 'read': {'sets': 0, 'sessions': 0, 'weeks': 0}, 'steps': [], 'proposals': [], 'observations': []}}
                        if routine:
                            routines.append({'id': 'rt_test', 'name': 'Gentle Beginner Practice', 'entries': [
                                {'exerciseId': f'ex_{position}', 'position': position, 'restSeconds': 60, 'sets': [{'reps': 8}, {'reps': 8}]} for position in range(3)]})
                            generation['results'] = [{'kind': 'routine-created', 'operationId': 'op_1', 'routineId': 'rt_test', 'routineName': 'Gentle Beginner Practice'}]
                        if request.get('attachmentIds'):
                            generation['attachments'] = [{'id': request['attachmentIds'][0], 'mediaType': 'image/png', 'width': 128, 'height': 128, 'bytes': len(next(iter(images.values())))}]
                        generations[request['requestId']] = generation
                        frames = [{'revision': 1, 'status': 'running', 'answer': 'Starting.'}, {'revision': 2, 'status': 'completed'}]
                        wire = ''.join(f"event: snapshot\nid: {generation['id']}:{frame['revision']}\ndata: "
                                       + json.dumps({'thread': request['thread'], 'generation': generation | frame}) + '\n\n' for frame in frames)
                        self.response = Response(wire.encode(), 'text/event-stream')
                    else:
                        generation = next(item for item in generations.values() if path.split('/')[4].split('?')[0] == clients[0].requests[item['requestId']]['thread'])
                        self.response = Response({'title': generation['question'] or 'Photo', 'turns': [
                            {'position': 0, 'from': 'lifter', 'requestId': generation['requestId'], 'text': generation['question'], 'attachments': generation.get('attachments', [])},
                            {'position': 1, 'from': 'ask', 'requestId': generation['requestId'], 'text': generation['answer'], 'status': generation['status'],
                             'results': generation['results'], 'receipt': generation['receipt']}]})

                def getresponse(self):
                    return self.response

                def close(self):
                    pass

            def backend(arguments, evidence):
                client = acceptance.Backend(arguments, evidence, Connection)
                clients.append(client)
                return client

            with contextlib.redirect_stdout(io.StringIO()) as output:
                result = acceptance.run(args, backend)
            report = json.loads((directory / 'evidence' / 'coach-provider-acceptance.json').read_text())
            self.assertEqual(result, 3, report)
            self.assertEqual(report['automatedOutcome'], 'inconclusive')
            self.assertEqual([case['contractOutcome'] for case in report['cases']], ['inconclusive', 'pass', 'pass'])
            self.assertEqual(report['manualQualityOutcome'], 'pending')
            self.assertEqual(report['coachRequests'], 4)
            self.assertEqual(len(generations), 3)
            self.assertEqual(len(routines), 1)
            self.assertEqual([method for method, path in calls if method != 'GET'], ['POST', 'PUT', 'POST', 'POST', 'POST'])
            self.assertNotIn(args.credentials['token'], output.getvalue())
            self.assertNotIn(args.credentials['token'], json.dumps(report))
            prior_calls = len(calls)
            with self.assertRaises(acceptance.AcceptanceError):
                clients[0].call('extra_ask', 'POST', '/v1/gym/ask', {'thread': 'thr_extra', 'requestId': 'ask_extra', 'question': 'Extra'})
            with self.assertRaises(acceptance.AcceptanceError):
                clients[0].call('delete', 'DELETE', '/v1/gym/threads/thr_extra')
            self.assertEqual(len(calls), prior_calls)

    def test_stream_timing_distinguishes_buffered_frames_from_observed_partial_growth(self):
        interpretation = ('Acceptance requires visible partial text at least 250 ms before terminal, with later text growth and revision. '
                          'Insufficient evidence does not establish a product defect.')
        for terminal_time, answer, revision, status in ((1.000008, 'Start. Continue.', 2, 'inconclusive'),
                                                       (1.25, 'Start. Continue.', 2, 'pass'),
                                                       (1.5, 'Start.', 2, 'inconclusive'),
                                                       (1.5, 'Start. Continue.', 1, 'inconclusive')):
            with self.subTest(terminal_time=terminal_time, answer=answer, revision=revision):
                snapshots = [{'seconds': 1.0, 'payload': {'generation': {'status': 'running', 'answer': 'Start.', 'revision': 1}}},
                             {'seconds': terminal_time, 'payload': {'generation': {'status': 'completed', 'answer': answer, 'revision': revision}}}]
                self.assertEqual(acceptance.visible_text_timing(snapshots), {
                    'status': status, 'minimumIntervalSeconds': 0.25, 'firstVisibleSeconds': 1.0,
                    'terminalSeconds': terminal_time, 'visibleToTerminalSeconds': round(terminal_time - 1.0, 6),
                    'answerGrowthCharacters': len(answer) - 6, 'firstVisibleRevision': 1, 'terminalRevision': revision,
                    'interpretation': interpretation})

    def test_refusals_keep_status_and_code_without_provider_body_or_retry(self):
        class RefusalApi:
            def call(self, *args, **kwargs):
                return 200, {'events': [{'event': 'error', 'payload': {'status': 429, 'code': 'ask-out-of-budget',
                                                                    'error': 'untrusted provider secret'}}]}, {'Cache-Control': 'no-cache'}

        case = {'name': 'text', 'contract': [], 'quality': []}
        with self.assertRaises(acceptance.AcceptanceError):
            acceptance.streamed_case(RefusalApi(), case, {'thread': 'thr_test', 'requestId': 'ask_test', 'question': 'Question'})
        self.assertEqual(case, {'name': 'text', 'contract': [], 'quality': [], 'httpStatus': 200,
                                'refusals': [{'status': 429, 'code': 'ask-out-of-budget'}]})

    def test_transport_timeout_retains_identity_and_refuses_an_automatic_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            args = self.arguments(directory)
            connections = []

            class TimeoutConnection:
                def __init__(self, *args, **kwargs):
                    connections.append(self)

                def request(self, *args):
                    pass

                def getresponse(self):
                    raise TimeoutError('private credential/provider response')

                def close(self):
                    pass

            client = acceptance.Backend(args, acceptance.Evidence(directory / 'evidence', args.credentials['token']), TimeoutConnection)
            request = {'thread': 'thr_test', 'requestId': 'ask_test', 'question': 'Question', 'stream': True}
            with self.assertRaisesRegex(acceptance.AcceptanceError, 'text: TimeoutError; no retry was sent'):
                client.call('text', 'POST', '/v1/gym/ask', request, stream=True)
            with self.assertRaisesRegex(acceptance.AcceptanceError, 'Only an identical completed request may be replayed'):
                client.call('text', 'POST', '/v1/gym/ask', request, stream=True)
            self.assertEqual(len(connections), 1)
            self.assertEqual(client.asks, 1)


if __name__ == '__main__':
    unittest.main()
