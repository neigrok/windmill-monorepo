# Coach against the local services

`run.py` drives a surface's actual engine and HTTP client through the C++ pass issuer, the Rust AI
service and a loopback provider fixture. It creates UTF-8 databases, starts isolated listeners and
removes its databases and processes when it finishes. It never reads provider credentials from the
environment or calls a paid provider.

Build the backend and AI binaries first. Build the native probe before running it with `--skip-build`.
The web command is `node web/test/platform/agent/service-probe.mjs`. The iOS command is
`swift test --package-path apps/ios/WindmillKit --skip-build --filter CoachLocalProbeTests`;
use the same scratch and cache paths as the build. Each command runs from its checkout root.

Store the command as a JSON argv array in a file. A private database configuration file supplies
`DATABASE_URL` for a PostgreSQL role that can create throwaway databases. Neither file is committed.

```sh
python3 tools/coach-e2e/run.py \
  --database-admin-file /private/tmp/coach/database.json \
  --backend-binary /private/tmp/coach/backend/windmill_server \
  --ai-binary /private/tmp/coach/ai/windmill-ai \
  --command-file /private/tmp/coach/web-command.json \
  --client-cwd "$PWD" --surface web --scratch /private/tmp/coach/web-proof
```

The scratch directory must be empty. The harness bounds each client process to 60 seconds and each
provider barrier to 90 seconds. It kills the driver's complete process tree before recovery, including
native test runners that start their own process group. Run the whole command under the build coordinator's bounded gate
when another task shares the machine.

Eight cases cover two rounds with a read and a write, a transient refusal with an identical retry,
a cut stream resumed by cursor, an admitted first request replaced by an HTML 502, an HTML 502
while reading by cursor, Stop before a tool terminal, a process killed during the final
round and a process killed before a tool terminal. Recovery starts a new client process and reads
the existing call; it cannot dispatch a new call or repeat an ability. Every case checks one settled
ledger charge per call, no duplicate visible text, no unexpected client failure report, and a cleared
terminal mark. The proxy cases replace a successful upstream response after admission, so a passing
retry proves the client read the same charged call.

`evidence.json` holds bounded outcomes, request methods and paths, and ledger assertions. The pass
issuer and AI logs are scanned for the synthetic private question, session credential and issued
passes. Probe configuration files containing the session are removed during cleanup. Remaining
scratch files contain only synthetic test data and can be removed after reading the evidence.

The probe host persists only its visible values, execution identities and recovery mark. Working
requests, prompts, passes, carries and full tool results stay in memory. Product integration and
paid-provider acceptance are separate from this library proof.
