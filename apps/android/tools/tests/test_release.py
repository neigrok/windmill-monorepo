import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='windmill-release-check-')
        self.root = Path(self.temporary.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.identity = 'ab' * 32
        self.transient = 'cd' * 32
        (self.project / 'release-signing.json').write_text(json.dumps({'certificateSha256': self.identity}))
        self.commit = '12' * 20
        self.env = {
            'GITHUB_EVENT_NAME': 'workflow_dispatch', 'DISPATCH_VERSION': '0.8.0',
            'GITHUB_REF': 'refs/heads/main', 'GITHUB_RUN_NUMBER': '57',
            'GITHUB_REPOSITORY': 'neigrok/windmill-monorepo', 'GITHUB_SHA': self.commit,
            'GITHUB_WORKFLOW_REF': 'neigrok/windmill-monorepo/.github/workflows/android.yml@refs/heads/main',
            'GITHUB_WORKFLOW_SHA': self.commit, 'GITHUB_RUN_ID': '123456', 'GITHUB_RUN_ATTEMPT': '1',
        }
        self.apk_directory = self.root / 'apks'
        self.apk_directory.mkdir()
        self.manifest = {'package': 'works.windmill.app', 'code': 57, 'version': '0.8.0', 'debuggable': False}
        self.payload = {
            'AndroidManifest.xml': json.dumps(self.manifest).encode(),
            'classes.dex': b'public synthetic application bytes',
            'META-INF/services/keep': b'preserve this service',
            'META-INF/NOTSIG.SF': b'not a signature, preserve it',
            'META-INF/nested/CERT.RSA': b'preserve nested metadata',
            'META-INF/versions/9/OSGI-INF/MANIFEST.MF': b'preserve the dependency manifest',
        }
        self.v1 = {'META-INF/MANIFEST.MF': b'Manifest-Version: 1.0\r\nold manifest\r\n',
                   'META-INF/ANDROID.SF': b'Signature-Version: 1.0\r\nold signature\r\n',
                   'META-INF/ANDROID.RSA': b'\x30public synthetic signature block'}
        self.make_apk(self.apk_directory / 'app-release.apk')
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        self.key = self.root / 'public-key-fixture.p12'
        self.key.write_bytes(b'not a real keystore; SDK fixture never opens this file')
        self.sdk_fixture()

    def tearDown(self):
        self.temporary.cleanup()

    def make_apk(self, path, payload=None, signer=None):
        with zipfile.ZipFile(path, 'w') as archive:
            for name, content in {**(payload or self.payload), **self.v1}.items():
                archive.writestr(name, content)
            archive.comment = (signer or self.transient).encode()

    def sdk_fixture(self, mode='normal', verify_exit=0, multiple=False, v2=True, legacy='valid'):
        config = {'identity': self.identity, 'mode': mode, 'verify_exit': verify_exit,
                  'multiple': multiple, 'v2': v2, 'legacy': legacy,
                  'capture': str(self.tools / 'public-call.json'),
                  'verifications': str(self.tools / 'public-verify.jsonl')}
        signer = '#!' + sys.executable + '\n' + 'config = ' + repr(config) + '\n' + textwrap.dedent('''
            import json
            from pathlib import Path
            import sys
            import zipfile
            args = sys.argv[1:]
            if args[0] == 'verify':
                with zipfile.ZipFile(args[-1]) as archive:
                    signer = archive.comment.decode()
                    metadata = 'META-INF/MANIFEST.MF' in archive.namelist()
                legacy = '--min-sdk-version' in args and args[args.index('--min-sdk-version') + 1] == '23'
                v1 = metadata and legacy and config['legacy'] != 'false'
                with Path(config['verifications']).open('a') as log:
                    log.write(json.dumps({'args':args, 'reportedV1':v1}) + '\\n')
                if legacy and config['legacy'] == 'wrong-signer':
                    signer = 'ef' * 32
                print('Verifies')
                print('Verified using v1 scheme (JAR signing): ' + str(v1).lower())
                print('Verified using v2 scheme (APK Signature Scheme v2): ' + str(config['v2'] and not legacy).lower())
                print('Signer #1 certificate SHA-256 digest: ' + signer)
                if config['multiple']:
                    print('Signer #2 certificate SHA-256 digest: ' + signer)
                sys.exit(1 if legacy and config['legacy'] == 'failed' else config['verify_exit'])
            assert args[0] == 'sign'
            value = sys.stdin.buffer.read()
            Path(config['capture']).write_text(json.dumps({'args':args,
                'stdinMatched': value == b'public-fixture-password\\npublic-fixture-password\\n'}))
            if config['mode'] == 'failure':
                sys.stderr.buffer.write(value)
                sys.exit(1)
            output = Path(args[args.index('--out') + 1])
            with zipfile.ZipFile(args[-1]) as source, zipfile.ZipFile(output, 'w') as target:
                for entry in source.infolist():
                    if entry.filename in ('META-INF/MANIFEST.MF', 'META-INF/ANDROID.SF', 'META-INF/ANDROID.RSA'):
                        continue
                    content = source.read(entry)
                    if config['mode'] == 'payload' and entry.filename == 'classes.dex':
                        content += b'changed'
                    if config['mode'] == 'metadata' and entry.filename == 'META-INF/services/keep':
                        content += b'changed'
                    if config['mode'] == 'manifest' and entry.filename == 'AndroidManifest.xml':
                        manifest = json.loads(content)
                        manifest['code'] += 1
                        content = json.dumps(manifest).encode()
                    target.writestr(entry, content)
                target.writestr('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\\r\\nnew manifest\\r\\n')
                target.writestr('META-INF/WINDMILL.SF', b'Signature-Version: 1.0\\r\\nnew signature\\r\\n')
                target.writestr('META-INF/WINDMILL.RSA', b'\\x30public replacement signature block')
                target.comment = (('ef' * 32) if config['mode'] == 'wrong-key' else config['identity']).encode()
        ''')
        aapt = '#!' + sys.executable + '\n' + textwrap.dedent('''
            import json
            import sys
            import zipfile
            with zipfile.ZipFile(sys.argv[-1]) as archive:
                manifest = json.loads(archive.read('AndroidManifest.xml'))
            print("package: name='%s' versionCode='%s' versionName='%s'" % (
                manifest['package'], manifest['code'], manifest['version']))
            if manifest['debuggable']:
                print('application-debuggable')
        ''')
        for name, source in (('apksigner', signer), ('aapt2', aapt)):
            path = self.tools / name
            path.write_text(source)
            path.chmod(0o700)

    def staged(self):
        output = self.root / 'signing-input'
        release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
        candidate = output / 'windmill-0.8.0-signing-input.apk'
        return candidate, candidate.with_suffix('.apk.provenance.json')

    def final(self, candidate, provenance, output, password=b'public-fixture-password\n'):
        release.finalize(self.project, release.request(self.env, self.commit), candidate, provenance,
                         self.key, output, self.tools, io.BytesIO(password))

    def test_semver_handles_canonical_versions_and_refuses_output_injection(self):
        for value in ('0.8.0', '1.2.3-rc.1', '1.2.3+build.01', '1.2.3-rc+abc'):
            self.assertEqual(release.semver(value), value)
        for value in ('', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', 'v1.2.3',
                      '1.2.3/../../x', '1.2.3\nkeystore=x', '1.2.3$(id)', '1.2.3`id`',
                      '1.2.3;id', '1.2.3"', '1.2.3 ', '1.2.3+é', '1.2.3+' + 'a' * 80):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.semver(value)

    def test_prepare_needs_no_private_material_and_refuses_accidental_signing_environment(self):
        self.assertEqual(release.prepare(self.env, self.project, self.commit), '0.8.0')
        for name in ('KEYSTORE_B64', 'KEYSTORE', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.prepare(dict(self.env, **{'WINDMILL_ANDROID_' + name: 'public fixture'}), self.project, self.commit)
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), ['release-signing.json'])

    def test_public_identity_is_required_and_duplicate_or_extra_fields_are_refused(self):
        path = self.project / 'release-signing.json'
        for value in ('null', '{}', '{"certificateSha256":null}',
                      json.dumps({'certificateSha256': self.identity.upper()}),
                      '{"certificateSha256":"' + self.identity + '","certificateSha256":"' + self.identity + '"}',
                      json.dumps({'certificateSha256': self.identity, 'extra': True})):
            path.write_text(value)
            with self.subTest(identity=value), self.assertRaises(ValueError):
                release.prepare(self.env, self.project, self.commit)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            release.prepare(self.env, self.project, self.commit)

    def test_tag_and_dispatch_validate_exact_repository_version_source_and_workflow_run(self):
        tag = dict(self.env, GITHUB_EVENT_NAME='push', GITHUB_REF='refs/tags/android-v0.8.0',
                   GITHUB_WORKFLOW_REF='neigrok/windmill-monorepo/.github/workflows/android.yml@refs/tags/android-v0.8.0')
        self.assertEqual(release.prepare(tag, self.project, self.commit), '0.8.0')
        self.assertEqual(release.request(tag, self.commit)['source']['tag'], 'android-v0.8.0')
        for name, value in [('GITHUB_RUN_NUMBER', '56'), ('GITHUB_RUN_NUMBER', '057'),
                            ('GITHUB_RUN_NUMBER', '2100000001'), ('GITHUB_SHA', '34' * 20),
                            ('GITHUB_WORKFLOW_REF', 'unexpected'), ('GITHUB_WORKFLOW_SHA', 'bad'),
                            ('GITHUB_REPOSITORY', 'other/repo'), ('GITHUB_RUN_ID', ''),
                            ('GITHUB_RUN_ATTEMPT', '0'), ('GITHUB_REF', 'refs/heads/main\nextra')]:
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                release.request(dict(self.env, **{name: value}), self.commit)
        with self.assertRaises(ValueError):
            release.request(dict(tag, GITHUB_EVENT_NAME='workflow_dispatch', DISPATCH_VERSION='0.9.0'), self.commit)

    def test_complete_candidate_digest_and_provenance_never_call_the_transient_signer_final(self):
        candidate, provenance = self.staged()
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        records = [[name, len(value), hashlib.sha256(value).hexdigest()] for name, value in sorted(self.payload.items())]
        payload_hash = hashlib.sha256(json.dumps(records, separators=(',', ':')).encode()).hexdigest()
        expected = {'schemaVersion': 2, 'artifactKind': 'signing-input',
                    'apk': {'sha256': digest, 'certificateSha256': self.transient, 'package': 'works.windmill.app',
                            'debuggable': False, 'versionCode': 57, 'versionName': '0.8.0',
                            'payloadSha256': payload_hash, 'fileName': candidate.name},
                    'source': {'repository': 'neigrok/windmill-monorepo', 'commit': self.commit,
                               'ref': 'refs/heads/main', 'tag': None},
                    'workflow': {'file': '.github/workflows/android.yml',
                                 'ref': 'neigrok/windmill-monorepo/.github/workflows/android.yml@refs/heads/main',
                                 'commit': self.commit, 'runId': '123456', 'runNumber': 57, 'attempt': 1,
                                 'event': 'workflow_dispatch',
                                 'url': 'https://github.com/neigrok/windmill-monorepo/actions/runs/123456'}}
        self.assertEqual(provenance.read_text(), json.dumps(expected, indent=2) + '\n')
        self.assertEqual(candidate.with_suffix('.apk.sha256').read_text(), digest + '  ' + candidate.name + '\n')
        self.assertEqual(candidate.read_bytes(), (self.apk_directory / 'app-release.apk').read_bytes())
        self.assertEqual(sorted(p.name for p in candidate.parent.iterdir()),
                         [candidate.name, candidate.name + '.provenance.json', candidate.name + '.sha256'])

    def test_candidate_signature_package_version_and_debug_refusals_remove_output(self):
        for index, change in enumerate(({'debuggable': True}, {'package': 'other.app'}, {'code': 56},
                                        {'code': 58}, {'version': '0.8.1'})):
            payload = dict(self.payload, **{'AndroidManifest.xml': json.dumps(dict(self.manifest, **change)).encode()})
            self.make_apk(self.apk_directory / 'app-release.apk', payload)
            output = self.root / f'failed-{index}'
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
            self.assertFalse(output.exists())
        self.make_apk(self.apk_directory / 'app-release.apk')
        for index, config in enumerate(({'verify_exit': 1}, {'multiple': True}, {'v2': False})):
            self.sdk_fixture(**config)
            output = self.root / f'signature-{index}'
            with self.subTest(config=config), self.assertRaises(ValueError):
                release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
            self.assertFalse(output.exists())

    def test_missing_ambiguous_symlink_and_duplicate_entry_candidates_are_refused(self):
        apk = self.apk_directory / 'app-release.apk'
        apk.unlink()
        output = self.root / 'out'
        with self.assertRaises(ValueError):
            release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
        self.make_apk(apk)
        self.make_apk(self.apk_directory / 'second.apk')
        with self.assertRaises(ValueError):
            release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
        (self.apk_directory / 'second.apk').unlink()
        apk.unlink()
        apk.symlink_to(self.project / 'release-signing.json')
        with self.assertRaises(ValueError):
            release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
        apk.unlink()
        self.make_apk(apk)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(apk, 'a') as archive:
                archive.writestr('classes.dex', b'duplicate')
        with self.assertRaises(ValueError):
            release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
        self.assertFalse(output.exists())

    def test_payload_exclusion_requires_paired_narrow_v1_metadata_and_keeps_every_other_entry(self):
        apk = self.apk_directory / 'app-release.apk'
        expected = release.payload_digest(apk, True)
        self.assertNotEqual(expected, release.payload_digest(apk, False))
        for name in self.payload:
            payload = dict(self.payload)
            payload[name] += b'changed'
            self.make_apk(apk, payload)
            with self.subTest(entry=name):
                self.assertNotEqual(expected, release.payload_digest(apk, True))
        self.make_apk(apk)
        with zipfile.ZipFile(apk, 'a') as archive:
            archive.writestr('META-INF/ORPHAN.SF', b'Signature-Version: 1.0\r\n')
        self.assertNotEqual(expected, release.payload_digest(apk, True))

    def test_min26_verification_skips_v1_and_separate_crypto_proof_is_required_for_exclusion(self):
        apk = self.apk_directory / 'app-release.apk'
        facts = release.inspect_apk(apk, self.tools)
        calls = [json.loads(line) for line in (self.tools / 'public-verify.jsonl').read_text().splitlines()]
        self.assertEqual(calls, [
            {'args': ['verify', '--verbose', '--print-certs', str(apk)], 'reportedV1': False},
            {'args': ['verify', '--min-sdk-version', '23', '--max-sdk-version', '23',
                      '--verbose', '--print-certs', str(apk)], 'reportedV1': True}])
        self.assertEqual(facts['payloadSha256'], release.payload_digest(apk, True))
        for legacy in ('false', 'failed', 'wrong-signer'):
            self.sdk_fixture(legacy=legacy)
            output = self.root / legacy
            with self.subTest(legacy=legacy), self.assertRaises(ValueError):
                release.stage(self.env, self.project, self.commit, self.apk_directory, output, self.tools)
            self.assertFalse(output.exists())

    def test_finalize_signs_only_stdin_then_checks_exact_payload_and_links_original_provenance_bytes(self):
        candidate, provenance = self.staged()
        provenance.write_bytes(provenance.read_bytes() + b' \n')
        original_bytes, provenance_bytes = candidate.read_bytes(), provenance.read_bytes()
        output = self.root / 'final'
        self.final(candidate, provenance, output)
        target = output / 'windmill-0.8.0.apk'
        result = json.loads(target.with_suffix('.apk.provenance.json').read_text())
        original = json.loads(provenance_bytes)
        expected = dict(original, artifactKind='signed-release', apk=dict(original['apk'],
            sha256=hashlib.sha256(target.read_bytes()).hexdigest(), certificateSha256=self.identity, fileName=target.name),
            input={'apkSha256': hashlib.sha256(original_bytes).hexdigest(),
                   'provenanceSha256': hashlib.sha256(provenance_bytes).hexdigest(),
                   'certificateSha256': self.transient, 'payloadSha256': original['apk']['payloadSha256']})
        self.assertEqual(result, expected)
        self.assertEqual(target.with_suffix('.apk.sha256').read_text(), expected['apk']['sha256'] + '  ' + target.name + '\n')
        call = json.loads((self.tools / 'public-call.json').read_text())
        self.assertEqual(call, {'args': ['sign', '--ks', str(self.key), '--ks-type', 'PKCS12',
            '--ks-key-alias', 'windmill-android', '--ks-pass', 'stdin', '--key-pass', 'stdin',
            '--v1-signer-name', 'WINDMILL', '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
            '--v3-signing-enabled', 'true', '--v4-signing-enabled', 'false', '--out', str(target),
            str(output / '.signing-input.apk')], 'stdinMatched': True})
        self.assertEqual(candidate.read_bytes(), original_bytes)
        self.assertEqual(provenance.read_bytes(), provenance_bytes)
        self.assertEqual(sorted(p.name for p in output.iterdir()), [target.name, target.name + '.provenance.json', target.name + '.sha256'])

    def test_finalize_refuses_changed_run_source_and_manifest_before_reading_password(self):
        candidate, provenance = self.staged()
        original = json.loads(provenance.read_text())
        mutations = [('source', 'repository', 'other/repo'), ('source', 'commit', '34' * 20),
                     ('source', 'ref', 'refs/heads/other'), ('source', 'tag', 'android-v0.8.0'),
                     ('workflow', 'file', 'other.yml'), ('workflow', 'ref', 'other'),
                     ('workflow', 'commit', '34' * 20), ('workflow', 'runId', '999'),
                     ('workflow', 'runNumber', 58), ('workflow', 'attempt', True),
                     ('workflow', 'event', 'push'), ('workflow', 'url', 'https://other'),
                     ('apk', 'sha256', '00' * 32), ('apk', 'certificateSha256', self.identity),
                     ('apk', 'payloadSha256', '00' * 32), ('apk', 'package', 'other.app'),
                     ('apk', 'fileName', 'other.apk')]
        for index, (section, name, value) in enumerate(mutations):
            document = json.loads(json.dumps(original))
            document[section][name] = value
            provenance.write_text(json.dumps(document))
            password = io.BytesIO(b'public-fixture-password\n')
            output = self.root / f'refusal-{index}'
            with self.subTest(section=section, field=name), self.assertRaises(ValueError):
                release.finalize(self.project, release.request(self.env, self.commit), candidate,
                                 provenance, self.key, output, self.tools, password)
            self.assertEqual(password.tell(), 0)
            self.assertFalse(output.exists())
        self.assertFalse((self.tools / 'public-call.json').exists())

    def test_v2_only_candidate_gains_v1_signatures_without_losing_dependency_metadata(self):
        self.v1 = {}
        self.make_apk(self.apk_directory / 'app-release.apk')
        candidate, provenance = self.staged()
        output = self.root / 'final'
        self.final(candidate, provenance, output)
        target = output / 'windmill-0.8.0.apk'
        with zipfile.ZipFile(target) as archive:
            for name, content in self.payload.items():
                self.assertEqual(archive.read(name), content)
            self.assertEqual(sorted(archive.namelist()), sorted([*self.payload,
                'META-INF/MANIFEST.MF', 'META-INF/WINDMILL.SF', 'META-INF/WINDMILL.RSA']))
        self.assertEqual(json.loads(provenance.read_text())['apk']['payloadSha256'],
                         json.loads(target.with_suffix('.apk.provenance.json').read_text())['apk']['payloadSha256'])

    def test_finalize_refuses_provenance_shape_duplicate_fields_and_changed_input_bytes(self):
        candidate, provenance = self.staged()
        original = provenance.read_text()
        for index, text in enumerate(('null', '{}', original[:-2] + ',"extra":true}',
                                      original.replace('"schemaVersion": 2', '"schemaVersion": true'),
                                      original.replace('"schemaVersion": 2', '"schemaVersion": 2, "schemaVersion": 2'))):
            provenance.write_text(text)
            output = self.root / f'shape-{index}'
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.final(candidate, provenance, output)
            self.assertFalse(output.exists())
        provenance.write_text(original)
        with zipfile.ZipFile(candidate, 'a') as archive:
            archive.writestr('new-payload', b'changed input')
        with self.assertRaises(ValueError):
            self.final(candidate, provenance, self.root / 'changed')
        self.assertFalse((self.tools / 'public-call.json').exists())

    def test_signer_failure_wrong_identity_or_application_mutation_removes_all_final_outputs(self):
        candidate, provenance = self.staged()
        original = candidate.read_bytes()
        for mode in ('failure', 'wrong-key', 'payload', 'metadata', 'manifest'):
            self.sdk_fixture(mode=mode)
            output = self.root / mode
            with self.subTest(mode=mode), self.assertRaises(ValueError) as caught:
                self.final(candidate, provenance, output)
            self.assertNotIn('public-fixture-password', str(caught.exception))
            self.assertFalse(output.exists())
            self.assertEqual(candidate.read_bytes(), original)

    def test_existing_outputs_and_invalid_password_lines_are_never_overwritten(self):
        candidate, provenance = self.staged()
        output = self.root / 'existing'
        output.mkdir()
        (output / 'keep').write_text('preserve')
        with self.assertRaises(FileExistsError):
            self.final(candidate, provenance, output)
        self.assertEqual((output / 'keep').read_text(), 'preserve')
        for index, password in enumerate((b'', b'\n', b'no newline', b'one\ntwo\n', b'bad\r\n', b'x' * 4096 + b'\n')):
            target = self.root / f'password-{index}'
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.final(candidate, provenance, target, password)
            self.assertFalse(target.exists())
        self.assertFalse((self.tools / 'public-call.json').exists())

    def test_workflow_never_receives_private_signing_secrets_or_publishes_a_release(self):
        workflow = Path(__file__).resolve().parents[4] / '.github/workflows/android.yml'
        source = workflow.read_text()
        self.assertNotIn('secrets.', source)
        self.assertNotIn('WINDMILL_ANDROID_', source)
        self.assertNotIn('gh release', source)
        self.assertNotIn('contents: write', source)
        self.assertNotIn('unsigned', source)
        self.assertIn('permissions:\n  contents: read\n', source)
        self.assertIn("if: startsWith(github.ref, 'refs/tags/android-v') || github.event_name == 'workflow_dispatch'", source)
        upload = source[source.index('      - name: Upload the unpublished signing input'):]
        self.assertNotIn('if:', upload)
        self.assertIn('path: apps/android/signing-input/', upload)
        self.assertIn('python3 tools/release.py stage', source)

    def test_failed_candidate_build_logs_stay_private_and_cleanup_preserves_other_files(self):
        workflow = Path(__file__).resolve().parents[4] / '.github/workflows/android.yml'
        lines = workflow.read_text().splitlines()

        def run_block(name):
            start = lines.index('      - name: ' + name)
            start = lines.index('        run: |', start) + 1
            result = []
            for line in lines[start:]:
                if line and not line.startswith('          '):
                    break
                result.append(line[10:])
            return '\n'.join(result)

        other = self.root / 'unrelated'
        other.write_text('preserve')
        gradle = self.root / 'gradlew'
        gradle.write_text('#!/bin/sh\nprintf "private diagnostic fixture\\n" >&2\nexit 1\n')
        gradle.chmod(0o700)
        env = dict(os.environ, RUNNER_TEMP=str(self.root), VERSION='0.8.0', GITHUB_RUN_NUMBER='57')
        build = subprocess.run(['bash', '-e', '-c', run_block('Assemble the build candidate')], cwd=self.root,
                               env=env, capture_output=True, text=True)
        self.assertEqual(build.returncode, 1)
        self.assertNotIn('private diagnostic fixture', build.stdout + build.stderr)
        log = self.root / 'windmill-android-candidate-build.log'
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        cleanup = subprocess.run(['bash', '-e', '-c', run_block('Remove captured build output')],
                                 cwd=self.root, env=env, capture_output=True, text=True)
        self.assertEqual((cleanup.returncode, cleanup.stdout, cleanup.stderr), (0, '', ''))
        self.assertFalse(log.exists())
        self.assertEqual(other.read_text(), 'preserve')
        start = lines.index('      - name: Remove captured build output')
        self.assertEqual(lines[start + 1], '        if: always()')


if __name__ == '__main__':
    unittest.main()
