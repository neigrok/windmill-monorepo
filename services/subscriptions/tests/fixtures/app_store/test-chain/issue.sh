#!/usr/bin/env bash
# Issues the App Store test chain into this folder, replacing the chain there. README.md says what it is.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
keys="$(mktemp -d)"
trap 'rm -rf "$keys"' EXIT

validity=(-not_before 20260101000000Z -not_after 21260101000000Z)
subject() { echo "/O=Windmill/OU=Test only, not Apple/CN=Windmill App Store Test $1"; }

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-384 -out "$keys/root.pem"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-384 -out "$keys/intermediate.pem"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$keys/leaf.pem"

openssl req -x509 -new -key "$keys/root.pem" -sha384 "${validity[@]}" -subj "$(subject Root)" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -outform DER -out root.cer

# Apple's WWDR intermediate marker.
openssl req -new -key "$keys/intermediate.pem" -subj "$(subject Intermediate)" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "1.2.840.113635.100.6.2.1=ASN1:NULL" \
| openssl x509 -req -copy_extensions copyall -sha384 "${validity[@]}" \
  -CA root.cer -CAform DER -CAkey "$keys/root.pem" -outform DER -out intermediate.cer

# Apple's receipt-signing marker.
openssl req -new -key "$keys/leaf.pem" -subj "$(subject Leaf)" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "1.2.840.113635.100.6.11.1=ASN1:NULL" \
| openssl x509 -req -copy_extensions copyall -sha384 "${validity[@]}" \
  -CA intermediate.cer -CAform DER -CAkey "$keys/intermediate.pem" -outform DER -out leaf.cer

openssl pkey -in "$keys/leaf.pem" -outform DER -out leaf-key.der
