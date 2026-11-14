# App Store fixtures

The files in this folder are material recorded from Apple that the `app_store` crate's tests read.
Its two subfolders are Windmill's own test material for `app_store_test_signer`, and Apple signed
none of it: [`test-chain/`](test-chain/README.md), a chain only non-production configurations may
trust, and [`test-payloads/`](test-payloads/README.md), descriptions of payloads to sign under it.

| File | What it is | Where it comes from |
|---|---|---|
| `apple-intermediate.cer` | Apple Worldwide Developer Relations Certification Authority G6, valid 2021-03-17 to 2036-03-19; SHA-256 `bdd4ed6e74691f0c2bfd01be0296197af1379e0418e2d300efa9c3bef642ca30` | [Apple PKI](https://www.apple.com/certificateauthority/AppleWWDRCAG6.cer) |
| `apple-leaf.cer` | Apple's "Prod ECC Mac App Store and iTunes Store Receipt Signing" certificate, valid 2025-09-19 to 2027-10-13; SHA-256 `4c381556c16121e605d1fc2eef6d0de4e072ed65964fe72f575f19711e84c417` | `REAL_APPLE_SIGNING_CERTIFICATE_BASE64_ENCODED` in `tests/test_x509_verification.py` of [apple/app-store-server-library-python](https://github.com/apple/app-store-server-library-python) at `e5ffded`, MIT licence, Copyright 2023 Apple Inc. |
| `go-iap-renewal-info.jws` | A renewal info Apple signed in its sandbox on 2023-05-23 for another app's product `co.ringalarm.swtich.quarterly2`, under a "Prod ECC Mac App Store and iTunes Store Receipt Signing" leaf valid 2021-08-25 to 2023-09-24, WWDR G6 and Root CA - G3 | `TestParseNotificationV2` in `appstore/validator_test.go` of [awa/go-iap](https://github.com/awa/go-iap) at `bd18fa0e0`, MIT licence, Copyright 2014 AWA Developers |
| `storekit-testing-transaction.jws` | A transaction signed by StoreKit testing in Xcode: environment `Xcode`, one self-signed "StoreKit Testing in Xcode" certificate, fractional dates | `tests/resources/xcode/xcode-signed-transaction` of [apple/app-store-server-library-python](https://github.com/apple/app-store-server-library-python) at `e5ffded`, MIT licence, Copyright 2023 Apple Inc. |

No payload Apple signed for Windmill is recorded here: recording one takes an App Store Connect
sandbox purchase. The test `a_payload_recorded_from_apple_verifies` reads `sandbox-notification.jws`
from this folder and stays ignored until that file exists.
