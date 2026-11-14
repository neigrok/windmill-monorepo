# App Store test chain

A certificate chain shaped like Apple's App Store signing chain, made for Windmill's tests. It is not
Apple's, and its key signs nothing real. Only non-production configurations trust `root.cer`: the
subscription service's tests, the local stack and CI. Production trusts Apple's pinned root alone
(`SignedDataVerifier::windmill`), which refuses everything this chain signs with `untrusted_chain`.

| File | What it is |
|---|---|
| `root.cer` | Windmill App Store Test Root: a P-384 key, self-signed with ECDSA SHA-384, a certificate authority |
| `intermediate.cer` | Windmill App Store Test Intermediate: a P-384 key, issued by the root, a certificate authority with path length 0, carrying Apple's WWDR marker `1.2.840.113635.100.6.2.1` |
| `leaf.cer` | Windmill App Store Test Leaf: a P-256 key, issued by the intermediate, not a certificate authority, carrying Apple's receipt-signing marker `1.2.840.113635.100.6.11.1` |
| `leaf-key.der` | The leaf's private key, PKCS#8 DER |
| `issue.sh` | Issues the four files above, replacing them |

The certificates are DER, valid from 2026-01-01 to 2126-01-01, and each subject reads
`O=Windmill, OU=Test only, not Apple`. The chain here was issued by `issue.sh` under OpenSSL 3.6.2.
The root's and intermediate's keys exist only while `issue.sh` runs, so nothing else can be issued
under this root. Running `issue.sh` again makes a new chain under a new root, and every configuration
that trusts `root.cer` must take the new file.

`app_store_test_signer` signs with this chain;
[ARCHITECTURE.md](../../../../ARCHITECTURE.md#app-store-test-signer) says how.
