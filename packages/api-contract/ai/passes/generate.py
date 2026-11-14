#!/usr/bin/env python3
import base64
import json
import pathlib
import subprocess
import tempfile
import sys

ROOT = pathlib.Path(__file__).resolve().parent

def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')

def generate():
    seed = bytes.fromhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
    public = bytes.fromhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
    with tempfile.TemporaryDirectory(prefix='wm-ai-pass-vectors-') as folder:
        folder = pathlib.Path(folder)
        key = folder / 'key.der'
        key.write_bytes(bytes.fromhex('302e020100300506032b657004220420') + seed)
        def sign(payload, kid='test-rfc8032'):
            signed = 'wm-pass.v1.' + kid + '.' + b64(payload.encode())
            source = folder / 'message'
            source.write_bytes(signed.encode())
            signature = subprocess.check_output(['openssl','pkeyutl','-sign','-rawin','-inkey',str(key),'-keyform','DER','-in',str(source)])
            return signed + '.' + b64(signature)
        base = dict(aud='ai', env='development', iat=1800000000000, exp=1800000600000, sub={'account':'account-vector'}, plan='one', ownerGrant=True, installation='installation-vector', client='web')
        cases = []
        def add(name, changes, expected, now=1800000000000):
            claims = dict(base)
            claims.update(changes)
            payload = json.dumps(claims, separators=(',',':'))
            cases.append(dict(name=name,payload=payload,passValue=sign(payload),now=now,expected=expected))
        add('account',{},'ok')
        installation = dict(aud='ai',env='development',iat=1800000000000,exp=1800000600000,sub={'installation':'installation-vector'},client='ios')
        payload=json.dumps(installation,separators=(',',':'))
        cases.append(dict(name='installation',payload=payload,passValue=sign(payload),now=1800000000000,expected='ok'))
        cases.append(dict(name='missing',payload=None,passValue=None,now=1800000000000,expected='pass_missing'))
        add('audience',{'aud':'other'},'pass_audience')
        add('environment',{'env':'production'},'pass_audience')
        add('unknown_claim',{'secret':'unknown'},'pass_malformed')
        add('too_long_lifetime',{'exp':1800000600001},'pass_malformed')
        add('expired',{},'pass_expired',1800000600000)
        add('future',{},'pass_expired',1799999939999)
        add('invalid_owner',{'ownerGrant':False},'pass_malformed')
        add('null_claim',{'installation':None},'pass_malformed')
        duplicate='{"aud":"ai",'+cases[0]['payload'][1:]
        cases.append(dict(name='duplicate_claim',payload=duplicate,passValue=sign(duplicate),now=1800000000000,expected='pass_malformed'))
        cases.append(dict(name='unknown_key',payload=cases[0]['payload'],passValue=sign(cases[0]['payload'],'unknown'),now=1800000000000,expected='pass_signature'))
        cases.append(dict(name='signature_before_payload',payload='{not-json',passValue='wm-pass.v1.test-rfc8032.'+b64(b'{not-json')+'.'+b64(bytes(64)),now=1800000000000,expected='pass_signature'))
        return dict(kid='test-rfc8032',privateSeed=b64(seed),publicKey=b64(public),cases=cases)

content=json.dumps(generate(),indent=2,ensure_ascii=False)+'\n'
path=ROOT/'vectors.json'
if '--check' in sys.argv:
    if path.read_text()!=content:
        raise SystemExit('pass vectors differ; regenerate with generate.py')
else:
    path.write_text(content)
