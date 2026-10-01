# syntax=docker/dockerfile:1.7
#
# Windmill backend image. The service and offline migration binaries share one image.
# windmill_server (:8080) is the only service the compose file starts — it serves REST, the collab socket and
# MCP from one process. windmill_mcp_http (:8090) is the standalone MCP transport, carried
# here so a local or single-purpose run has it (deploy/docker-compose.yml, where the retired
# `mcp` service is noted).
#
# The build boundary lives here: Drogon and libpqxx are the messy vendor deps, so we
# resolve them once in a fat builder and ship a slim runtime that carries the
# service and migration binaries, schemas, rehearsal, and their shared libraries.
#
# The context is backend/, which cannot see the sync contract the build embeds and the tests read
# (the corpus and the registries), so the build takes it as a second, named context:
#   docker buildx build --build-context contract=packages/api-contract backend

########################  builder  ########################
# Ubuntu 22.04, the runtime stage's own userland, so glibc/libstdc++ ABI matches exactly.
FROM ubuntu:22.04 AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git cmake make g++ pkg-config python3 postgresql-client \
      libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev libc-ares-dev libbrotli-dev \
      libpq-dev libcurl4-openssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Drogon, its pinned release with the patches in third_party/drogon, built by the same script the CMake configure runs
# and in a layer of its own: it rebuilds only when the pin (drogon.cmake), a patch, or a layer above it changes (a new
# ubuntu:22.04 or its apt packages). The configure below finds it in place.
COPY third_party/drogon/drogon.cmake /src/third_party/drogon/drogon.cmake
COPY third_party/drogon/patches /src/third_party/drogon/patches
RUN cmake -DWM_DROGON_PREFIX=/opt/drogon -P /src/third_party/drogon/drogon.cmake

# apt's libpqxx on 22.04 is 6.4 and exposes only pkg-config — the build's
# find_package(libpqxx CONFIG) can't see it. Build libpqxx 7.x from source: it installs
# libpqxxConfig.cmake and the libpqxx::pqxx target, matching the Homebrew dev environment.
ARG LIBPQXX_VERSION=7.10.1
RUN git clone --depth 1 --branch "${LIBPQXX_VERSION}" https://github.com/jtv/libpqxx /tmp/libpqxx \
 && cmake -S /tmp/libpqxx -B /tmp/libpqxx/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DSKIP_BUILD_TEST=ON \
 && cmake --build /tmp/libpqxx/build -j"$(nproc)" \
 && cmake --install /tmp/libpqxx/build \
 && rm -rf /tmp/libpqxx

WORKDIR /src
COPY . .
COPY --from=contract sync/*.registry.json sync/composition.json /contract/sync/
COPY --from=contract sync/corpus /contract/sync/corpus

# Configure once, then build the two service binaries, the probe server the sync conformance runs against, and every
# test suite. Every suite ctest registers must be listed, or ctest fails on a missing executable, not a red test.
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DWM_API_CONTRACT_DIR=/contract -DWM_DROGON_PREFIX=/opt/drogon \
 && cmake --build build -j"$(nproc)" \
      --target windmill_server windmill_server_test_clock windmill_mcp_http windmill_server_probe \
               windmill_gym_backfill windmill_gym_snapshot \
               windmill_domain_tests windmill_mcp_tests windmill_adapters_tests windmill_sync_tests

# Tests are self-contained (in-memory fakes, no database) — run them in the build so a
# red suite fails the image, and a PR that only builds this stage still gets tested.
RUN ctest --test-dir build --output-on-failure

# Belt and braces: prove the binaries exist before we carry them to the runtime stage.
RUN test -x build/windmill_server && test -x build/windmill_mcp_http \
 && test -x build/windmill_gym_backfill && test -x build/windmill_gym_snapshot

# The probe is the sync engine's test and dev product: it must never ship. windmill_server links no probe
# code, and the runtime stage carries schema.sql and gym_sync.sql, never probe.sql.
RUN ! nm -C build/windmill_server | grep -q 'wm::probe::'
RUN ! nm -C build/windmill_gym_backfill build/windmill_gym_snapshot | grep -q 'wm::probe::'

########################  runtime  ########################
# Same Ubuntu 22.04 userland as the builder, so glibc/libstdc++ ABI matches exactly.
# Drogon and libpqxx are statically linked into the binaries; these are the shared libraries
# they still resolve at runtime (jsoncpp, tls, postgres, compression, dns, uuid, and curl's
# own, which the curl package brings) — the exact set ldd reports against the built binary.
FROM ubuntu:22.04 AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libjsoncpp25 \
      libssl3 \
      libpq5 \
      libuuid1 \
      zlib1g \
      libc-ares2 \
      libbrotli1 \
      postgresql-client-14 \
      python3 \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/windmill_server   /usr/local/bin/windmill_server
COPY --from=build /src/build/windmill_mcp_http  /usr/local/bin/windmill_mcp_http
COPY --from=build /src/build/windmill_gym_backfill /usr/local/bin/windmill_gym_backfill
COPY --from=build /src/build/windmill_gym_snapshot /usr/local/bin/windmill_gym_snapshot
COPY --from=build /src/db/schema.sql            /app/db/schema.sql
COPY --from=build /src/db/gym_sync.sql          /app/db/gym_sync.sql
COPY --from=build /src/deploy/gym-migration/rehearse.py /app/deploy/gym-migration/rehearse.py
COPY --from=build /src/products/gym/routes.cpp  /app/products/gym/routes.cpp

WORKDIR /app
EXPOSE 8080 8090

# Drop root: the binaries and schema are world-readable/executable, curl (healthcheck)
# needs no privilege, and psql runs in the separate migrate service — nothing here does.
RUN useradd --system --uid 10001 --user-group windmill

# The server writes temp upload shards under ./uploads (CWD is /app). /app is root-owned by
# WORKDIR, so without an owned uploads dir the non-root runtime user hits EACCES on every
# upload/OG-image/share-video temp write. Give it one it can write.
RUN mkdir -p /app/uploads && chown -R windmill:windmill /app/uploads
USER windmill

# The web server; a standalone MCP run names windmill_mcp_http as its command instead.
CMD ["windmill_server"]
