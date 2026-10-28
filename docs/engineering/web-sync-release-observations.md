# Web sync release observations

Backend and web promotions are independent consumers of the same composed registry. Each needs a
live compatibility check before its own writes; sharing a deployment concurrency group only orders
those operations. The web guard reuses the backend metadata and anonymous-hello boundary, keeping
release policy outside application senders.

A held web promotion still has a complete source-pinned artifact, including hidden dist files and
streamed file hashes. Attempt-specific names preserve the earlier candidate when a run is retried.
The unchanged served bundle remains available until a compatible candidate can be promoted.

Modeled deployment tests execute the workflow's actual promotion block and reject unexpected remote
commands. They prove held candidates do not reach mkdir/rsync or change live fixture files. An owned
actual-hello gate and queued-delivery probe remain separate release evidence; these tests do not
claim a production cutoff, mobile availability or a live web deployment.
