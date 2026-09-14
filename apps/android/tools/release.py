#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile


REPOSITORY = 'neigrok/windmill-monorepo'
WORKFLOW = '.github/workflows/android.yml'
ALIAS = 'windmill-android'


def semver(value):
    if not isinstance(value, str) or len(value) > 80:
        raise ValueError('Version must be SemVer, at most 80 characters.')
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
                         r'(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
                         r'(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?', value)
    if not match or any(part.isdigit() and len(part) > 1 and part[0] == '0'
                        for part in (match[4] or '').split('.')):
        raise ValueError('Version must be canonical SemVer.')
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field.')
        result[key] = value
    return result


def certificate(path):
    value = json.loads(path.read_text(), object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != {'certificateSha256'}
            or not isinstance(value['certificateSha256'], str)
            or not re.fullmatch(r'[0-9a-f]{64}', value['certificateSha256'])):
        raise ValueError('release-signing.json must contain one lowercase certificateSha256.')
    return value['certificateSha256']


def request(env, commit):
    event = env.get('GITHUB_EVENT_NAME')
    ref = env.get('GITHUB_REF', '')
    tag = ref.removeprefix('refs/tags/') if ref.startswith('refs/tags/') else None
    if event == 'workflow_dispatch':
        version = semver(env.get('DISPATCH_VERSION'))
        if tag and tag != 'android-v' + version:
            raise ValueError('Dispatch from a tag must request that Android version.')
    elif event == 'push' and tag and tag.startswith('android-v'):
        version = semver(tag.removeprefix('android-v'))
    else:
        raise ValueError('Signing input requires an Android tag or workflow_dispatch.')
    if not re.fullmatch(r'refs/(heads|tags)/[A-Za-z0-9_./+-]+', ref):
        raise ValueError('Invalid workflow ref.')
    code = env.get('GITHUB_RUN_NUMBER', '')
    if not re.fullmatch(r'[1-9][0-9]*', code) or not 56 < int(code) <= 2_100_000_000:
        raise ValueError('Run number must exceed published code 56 and fit Android versionCode.')
    if env.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise ValueError('Unexpected repository identity.')
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or env.get('GITHUB_SHA') != commit:
        raise ValueError('Checked-out commit must equal GITHUB_SHA.')
    workflow_ref = REPOSITORY + '/' + WORKFLOW + '@' + ref
    if env.get('GITHUB_WORKFLOW_REF') != workflow_ref:
        raise ValueError('Unexpected Android workflow ref.')
    workflow_commit = env.get('GITHUB_WORKFLOW_SHA', '')
    if not re.fullmatch(r'[0-9a-f]{40}', workflow_commit):
        raise ValueError('Missing workflow commit.')
    for name in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        if not re.fullmatch(r'[1-9][0-9]*', env.get(name, '')):
            raise ValueError('Missing workflow run identity.')
    return {'version': version, 'code': int(code),
            'source': {'repository': REPOSITORY, 'commit': commit, 'ref': ref, 'tag': tag},
            'workflow': {'file': WORKFLOW, 'ref': workflow_ref, 'commit': workflow_commit,
                         'runId': env['GITHUB_RUN_ID'], 'runNumber': int(code),
                         'attempt': int(env['GITHUB_RUN_ATTEMPT']), 'event': event,
                         'url': f'https://github.com/{REPOSITORY}/actions/runs/{env["GITHUB_RUN_ID"]}'}}


def prepare(env, project, commit):
    if any(value for name, value in env.items() if name.startswith('WINDMILL_ANDROID_')):
        raise ValueError('CI signing inputs must not receive private signing configuration.')
    release = request(env, commit)
    certificate(project / 'release-signing.json')
    return release['version']


def command(arguments, input_bytes=None):
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith('WINDMILL_ANDROID_')
                   and key not in {'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'}}
    result = subprocess.run([str(arg) for arg in arguments], input=input_bytes or b'',
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=environment, timeout=120, check=False)
    if result.returncode:
        raise ValueError('APK inspection, signing, or source verification failed; output withheld.')
    return result.stdout.decode('utf-8')


def v1_metadata(archive):
    names = archive.namelist()
    paired = set()
    for name in names:
        match = re.fullmatch(r'META-INF/([A-Z0-9_-]{1,8})\.SF', name)
        if not match:
            continue
        blocks = [f'META-INF/{match[1]}.{suffix}' for suffix in ('RSA', 'DSA', 'EC')
                  if f'META-INF/{match[1]}.{suffix}' in names]
        if (len(blocks) == 1 and archive.read(name).startswith(b'Signature-Version: 1.0\r\n')
                and archive.read(blocks[0]).startswith(b'\x30')):
            paired.update((name, blocks[0]))
    if paired:
        if ('META-INF/MANIFEST.MF' not in names
                or not archive.read('META-INF/MANIFEST.MF').startswith(b'Manifest-Version: 1.0\r\n')):
            raise ValueError('Unrecognized v1 signature manifest.')
        paired.add('META-INF/MANIFEST.MF')
    return paired


def payload_digest(apk, v1_verified):
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names) or any(entry.flag_bits & 1 for entry in entries):
            raise ValueError('APK entries must be unique and unencrypted.')
        omitted = v1_metadata(archive) if v1_verified else set()
        records = []
        for entry in sorted(entries, key=lambda item: item.filename):
            if entry.filename in omitted:
                continue
            content = archive.read(entry)
            records.append([entry.filename, len(content), hashlib.sha256(content).hexdigest()])
        return hashlib.sha256(json.dumps(records, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


def inspect_apk(apk, build_tools):
    if not apk.is_file() or apk.is_symlink():
        raise ValueError('Expected a regular APK file.')
    signature = command([build_tools / 'apksigner', 'verify', '--verbose', '--print-certs', apk])
    cert_pattern = r'^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$'
    certs = re.findall(cert_pattern, signature, re.MULTILINE)
    if len(certs) != 1 or 'Verified using v2 scheme (APK Signature Scheme v2): true' not in signature:
        raise ValueError('APK must have one verified signer and a v2 signature.')
    with zipfile.ZipFile(apk) as archive:
        has_v1 = bool(v1_metadata(archive))
    if has_v1:
        legacy = command([build_tools / 'apksigner', 'verify', '--min-sdk-version', '23',
                          '--max-sdk-version', '23', '--verbose', '--print-certs', apk])
        if ('Verified using v1 scheme (JAR signing): true' not in legacy
                or [value.lower() for value in re.findall(cert_pattern, legacy, re.MULTILINE)]
                != [value.lower() for value in certs]):
            raise ValueError('v1 metadata must verify independently with the APK signer.')
    badging = command([build_tools / 'aapt2', 'dump', 'badging', apk])
    packages = re.findall(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'", badging, re.MULTILINE)
    if len(packages) != 1:
        raise ValueError('APK manifest identity is ambiguous.')
    package, code, version = packages[0]
    return {'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
            'certificateSha256': certs[0].lower(), 'package': package,
            'debuggable': 'application-debuggable' in badging.splitlines(),
            'versionCode': int(code), 'versionName': version,
            'payloadSha256': payload_digest(apk, has_v1)}


def verified_facts(facts, release):
    if facts['package'] != 'works.windmill.app' or facts['debuggable']:
        raise ValueError('APK must be a non-debuggable works.windmill.app build candidate.')
    if facts['versionCode'] != release['code'] or facts['versionCode'] <= 56:
        raise ValueError('APK versionCode must equal this run number and exceed 56.')
    if facts['versionName'] != release['version']:
        raise ValueError('APK versionName does not match the requested SemVer.')
    return {'schemaVersion': 2, 'artifactKind': 'signing-input', 'apk': facts,
            'source': release['source'], 'workflow': release['workflow']}


def sidecars(target, provenance):
    target.with_suffix('.apk.sha256').write_text(f'{provenance["apk"]["sha256"]}  {target.name}\n')
    target.with_suffix('.apk.provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')


def stage(env, project, commit, apk_directory, output, build_tools):
    prepare(env, project, commit)
    release = request(env, commit)
    apks = list(apk_directory.glob('*.apk'))
    if len(apks) != 1 or not apks[0].is_file() or apks[0].is_symlink():
        raise ValueError('Expected exactly one regular build candidate APK.')
    output.mkdir()
    target = output / f'windmill-{release["version"]}-signing-input.apk'
    try:
        shutil.copyfile(apks[0], target)
        facts = inspect_apk(target, build_tools)
        facts['fileName'] = target.name
        sidecars(target, verified_facts(facts, release))
    except BaseException:
        shutil.rmtree(output)
        raise


def finalize(project, release, candidate, provenance_file, keystore, output, build_tools, password_input):
    expected_certificate = certificate(project / 'release-signing.json')
    if candidate.is_symlink() or provenance_file.is_symlink() or not candidate.is_file():
        raise ValueError('Expected regular downloaded signing inputs.')
    provenance_bytes = provenance_file.read_bytes()
    provenance = json.loads(provenance_bytes, object_pairs_hook=unique_object)
    if not isinstance(provenance, dict) or set(provenance) != {'schemaVersion', 'artifactKind', 'apk', 'source', 'workflow'}:
        raise ValueError('Unsupported input provenance shape.')
    output.mkdir()
    target = output / f'windmill-{release["version"]}.apk'
    snapshot = output / '.signing-input.apk'
    password, request_bytes = bytearray(), bytearray()
    try:
        shutil.copyfile(candidate, snapshot)
        original = inspect_apk(snapshot, build_tools)
        original['fileName'] = f'windmill-{release["version"]}-signing-input.apk'
        expected = verified_facts(original, release)
        if candidate.name != original['fileName'] or json.dumps(provenance, sort_keys=True) != json.dumps(expected, sort_keys=True):
            raise ValueError('Signing input and provenance do not match the independently verified run.')
        password = bytearray(password_input.read(4097))
        if len(password) > 4096 or not password.endswith(b'\n'):
            raise ValueError('Supply one bounded password line through stdin.')
        password.pop()
        if not password or b'\r' in password or b'\n' in password:
            raise ValueError('Supply exactly one nonempty password line through stdin.')
        request_bytes = password + b'\n' + password + b'\n'
        command([build_tools / 'apksigner', 'sign', '--ks', keystore, '--ks-type', 'PKCS12',
                 '--ks-key-alias', ALIAS, '--ks-pass', 'stdin', '--key-pass', 'stdin',
                 '--v1-signer-name', 'WINDMILL', '--v1-signing-enabled', 'true',
                 '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
                 '--v4-signing-enabled', 'false', '--out', target, snapshot], request_bytes)
        final = inspect_apk(target, build_tools)
        final['fileName'] = target.name
        result = verified_facts(final, release)
        if final['certificateSha256'] != expected_certificate:
            raise ValueError('Final APK does not carry the retained public signing identity.')
        if final['payloadSha256'] != original['payloadSha256']:
            raise ValueError('Signing changed application payload entries.')
        result['artifactKind'] = 'signed-release'
        result['input'] = {'apkSha256': original['sha256'],
                           'provenanceSha256': hashlib.sha256(provenance_bytes).hexdigest(),
                           'certificateSha256': original['certificateSha256'],
                           'payloadSha256': original['payloadSha256']}
        snapshot.unlink()
        sidecars(target, result)
    except BaseException:
        shutil.rmtree(output)
        raise
    finally:
        password[:] = b'\0' * len(password)
        request_bytes[:] = b'\0' * len(request_bytes)


def main():
    parser = argparse.ArgumentParser(description='Stage unpublished Android signing inputs and finalize them locally.')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('prepare')
    check = commands.add_parser('stage')
    check.add_argument('--apk-dir', type=Path, required=True)
    check.add_argument('--out', type=Path, required=True)
    check.add_argument('--build-tools', type=Path, required=True)
    local = commands.add_parser('finalize')
    for name in ('candidate', 'provenance', 'keystore', 'out', 'build-tools'):
        local.add_argument('--' + name, type=Path, required=True)
    for name in ('commit', 'workflow-commit', 'ref', 'version', 'run-id', 'run-number', 'run-attempt'):
        local.add_argument('--expected-' + name, required=True)
    local.add_argument('--expected-event', choices=('push', 'workflow_dispatch'), required=True)
    args = parser.parse_args()
    os.umask(0o077)
    project = Path(__file__).resolve().parents[1]
    try:
        if args.command == 'finalize':
            observed = {'GITHUB_EVENT_NAME': args.expected_event, 'GITHUB_REF': args.expected_ref,
                        'DISPATCH_VERSION': args.expected_version, 'GITHUB_RUN_NUMBER': args.expected_run_number,
                        'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_SHA': args.expected_commit,
                        'GITHUB_WORKFLOW_REF': REPOSITORY + '/' + WORKFLOW + '@' + args.expected_ref,
                        'GITHUB_WORKFLOW_SHA': args.expected_workflow_commit, 'GITHUB_RUN_ID': args.expected_run_id,
                        'GITHUB_RUN_ATTEMPT': args.expected_run_attempt}
            release = request(observed, args.expected_commit)
            if release['version'] != semver(args.expected_version):
                raise ValueError('Observed version and tag differ.')
            finalize(project, release, args.candidate, args.provenance, args.keystore,
                     args.out, args.build_tools, sys.stdin.buffer)
            print('Local signature, unchanged application payload, digest and linked provenance verified; not published.')
        else:
            commit = command(['git', '-C', project, 'rev-parse', 'HEAD']).strip()
            if args.command == 'prepare':
                version = prepare(os.environ, project, commit)
                with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                    output.write(f'version={version}\n')
                print('Unpublished signing-input version and workflow identity validated.')
            else:
                stage(os.environ, project, commit, args.apk_dir, args.out, args.build_tools)
                print('Unpublished signing input verified; its transient signer is not the release identity.')
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile, subprocess.SubprocessError, KeyboardInterrupt):
        print('Signing input or local finalization refused; private tool output is withheld.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
