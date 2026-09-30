# PicoSHA2

`picosha2.h` is vendored from https://github.com/okdshin/PicoSHA2 at commit
`161cb3fc4170fa7a3eca9e582cebd27cc4d1fe29`, unmodified. The header carries its MIT license. The sync
engine's domain (`platform/domain/sync/Digest.cpp`) hashes with it, so the scope digest needs no
OpenSSL; `test/platform/domain/sync/DigestTest.cpp` pins it with the FIPS 180-4 vectors.
