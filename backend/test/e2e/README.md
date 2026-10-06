# End-to-end checks

| File | What it drives |
| --- | --- |
| `auth_differential.py` | `origin/main`'s server beside this branch's, comparing auth responses byte for byte (below) |
| `differential_harness.py` | what a differential shares: throwaway databases, `psql`, and the `origin/main` baseline build |
| `deployment_conformance.mjs` | what engine.md asks of a deployment, directly and through the production Caddyfile |
| `deploy_auth_env_test.py` | that `deploy.yml` forwards the native-auth settings |
| `sync_probe.sh` | the sync engine against `windmill_server_probe` |
| `journal.sh`, `journal_echo.sh`, `journal_nudge.sh` | journal pages, echoes and nudges against the local stack |

Each shell and Node script's header names its prerequisites and how to run it.

## Authentication differential

`auth_differential.py` compares `origin/main` with the current production composition using two
throwaway Postgres databases and persistent raw HTTP sockets on ports 18870–18871. Its databases,
`psql` calls and baseline build come from `differential_harness.py`. It builds the baseline in an
isolated shared mirror unless `--main-bin` supplies an already built baseline:

```sh
python3 backend/test/e2e/auth_differential.py \
  --bin-dir /path/to/current/build \
  --main-bin /path/to/origin-main/windmill_server
```

The baseline must have the identical test-only `SystemClock.h` and `WM_TEST_CLOCK=1` instrumentation;
the current build uses `windmill_server_test_clock`. `--drogon-prefix` supplies the pinned Drogon
prefix when the harness builds the baseline. `--maintenance-db` supplies a local Postgres URL with
CREATE DATABASE permission. Both servers and both databases are removed even on failure; server
cleanup resolves listeners by their allocated ports.

The sequence covers email requests for web and `door=app`, malformed inputs, rate limits,
unconfigured-provider failure, successful link/code verification, the legacy cookie transport
options, unknown/expired credentials, wrong-code attempt exhaustion, replay, logout and token
replay after logout. Every case runs with HTTP host-only cookies and HTTPS live/retired domains.
No email provider is contacted: request persistence is checked, then the newest stored code digest
is replaced with a known fixture for verification. Successful provider delivery is outside this
local comparison. Native `sessionTransport=bearer` is a new opt-in and is outside the legacy corpus.

Status and body bytes compare exactly, apart from two changes the comparator pins byte for byte:
the expired-code copy and the `signInMethods` addition to `/v1/me`. Set-Cookie field lines retain
their original header case, spacing, attribute order, scope, flags and line endings; only the
independently minted 43-byte live session secret is substituted. The minted secret must authenticate
the same seeded account and exist in its database. Logout and failure cookies have no substitutions.
Comparator tests reject body reformatting, cookie attribute changes, reordered lines and broader
entropy normalization.
