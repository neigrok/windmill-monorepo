# syntax=docker/dockerfile:1.7
#
# Windmill backend image. One image, two service binaries (windmill_server on :8080,
# windmill_mcp_http on :8090) — the compose file picks which to run per service.
#
# The build boundary lives here: Drogon and libpqxx are the messy vendor deps, so we
# resolve them once in a fat builder and ship a slim runtime that carries only the two
# binaries, the schema, and the shared libraries ldd actually reports.

########################  builder  ########################
# Official Drogon image: Ubuntu 22.04, Drogon prebuilt as a static lib with a working
# CMake package, gcc-11/g++-11 via CC/CXX, libpq-dev present. It does NOT ship libpqxx.
FROM drogonframework/drogon:latest AS build

# apt's libpqxx on 22.04 is 6.4 and exposes only pkg-config — the build's
# find_package(libpqxx CONFIG) can't see it, so it would silently skip the server
# targets. Build libpqxx 7.x from source: it installs libpqxxConfig.cmake and the
# libpqxx::pqxx target, matching the Homebrew dev environment.
ARG LIBPQXX_VERSION=7.10.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && git clone --depth 1 --branch "${LIBPQXX_VERSION}" https://github.com/jtv/libpqxx /tmp/libpqxx \
 && cmake -S /tmp/libpqxx -B /tmp/libpqxx/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
      -DSKIP_BUILD_TEST=ON \
 && cmake --build /tmp/libpqxx/build -j"$(nproc)" \
 && cmake --install /tmp/libpqxx/build \
 && rm -rf /tmp/libpqxx /var/lib/apt/lists/*

WORKDIR /src
COPY . .

# Configure once, then build the two service binaries plus every test suite. The guard
# in CMakeLists only defines these targets when Drogon + libpqxx are found, so a failed
# dependency resolution surfaces as "unknown target" here, not a silent skip. Every suite
# ctest registers must be listed, or ctest fails on a missing executable, not a red test.
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)" \
      --target windmill_server windmill_mcp_http windmill_domain_tests windmill_mcp_tests windmill_adapters_tests

# Tests are self-contained (in-memory fakes, no database) — run them in the build so a
# red suite fails the image, and a PR that only builds this stage still gets tested.
RUN ctest --test-dir build --output-on-failure

# Belt and braces: prove the binaries exist before we carry them to the runtime stage.
RUN test -x build/windmill_server && test -x build/windmill_mcp_http

########################  runtime  ########################
# Same Ubuntu 22.04 userland as the builder, so glibc/libstdc++ ABI matches exactly.
# Drogon is statically linked into the binaries; these are the shared libraries its
# transitive features (jsoncpp, tls, postgres, compression, dns, uuid) still resolve at
# runtime — the exact set ldd reports against the built binary.
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
      libhiredis0.14 \
      libmariadb3 \
      libsqlite3-0 \
      postgresql-client-14 \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/windmill_server   /usr/local/bin/windmill_server
COPY --from=build /src/build/windmill_mcp_http  /usr/local/bin/windmill_mcp_http
COPY --from=build /src/db/schema.sql            /app/db/schema.sql

WORKDIR /app
EXPOSE 8080 8090

# Drop root: the binaries and schema are world-readable/executable, curl (healthcheck)
# needs no privilege, and psql runs in the separate migrate service — nothing here does.
RUN useradd --system --uid 10001 --user-group windmill
USER windmill

# Default to the web server; the mcp service overrides `command` in compose.
CMD ["windmill_server"]
