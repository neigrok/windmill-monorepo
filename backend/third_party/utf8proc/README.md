# utf8proc

`utf8proc.c`, `utf8proc.h` and `utf8proc_data.c` are vendored from https://github.com/JuliaStrings/utf8proc at
release `v2.10.0` (commit `a1b99daa2a3393884220264c927a48ba1251a9c6`, Unicode 16), unmodified; `LICENSE.md` is the
release's own (MIT, with the Unicode data license for `utf8proc_data.c`). `CMakeLists.txt` compiles `utf8proc.c`,
which includes the data table, as the C library `utf8proc` that `windmill_platform` links. Only
`platform/domain/Nfc.cpp` calls it, for the NFC every gym display name and note enters the store in
(gym_coach.md §3.3); `test/platform/domain/NfcTest.cpp` pins it.
