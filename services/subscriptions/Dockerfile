# syntax=docker/dockerfile:1.7
#
# The Windmill One subscription service: the binary `subscriptions` on a slim Debian, run as a user of
# its own. The context is services/subscriptions:
#   docker build --build-arg SENTRY_RELEASE="$(git rev-parse HEAD)" -t windmill-subscriptions services/subscriptions

########################  build  ########################
# The Rust release rust-toolchain.toml pins. The check below fails the build when the two differ.
FROM rust:1.99.1-slim-trixie AS build

COPY rust-toolchain.toml /pinned/rust-toolchain.toml
RUN grep -qxF "channel = \"${RUST_VERSION}\"" /pinned/rust-toolchain.toml \
 || { echo "the image's Rust ${RUST_VERSION} is not the release rust-toolchain.toml pins" >&2; exit 1; }

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin subscriptions \
 && cp target/release/subscriptions /usr/local/bin/subscriptions

########################  runtime  ########################
# The builder's Debian release, so the binary finds the glibc it linked against. ca-certificates lets
# Sentry's TLS verify ingest's certificate; curl serves the health check.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin subscriptions

COPY --from=build /usr/local/bin/subscriptions /usr/local/bin/subscriptions

ARG SENTRY_RELEASE=
ENV SENTRY_RELEASE=${SENTRY_RELEASE} \
    SUBSCRIPTIONS_PUBLIC_ADDRESS=0.0.0.0:8082 \
    SUBSCRIPTIONS_INTERNAL_ADDRESS=0.0.0.0:8083
EXPOSE 8082 8083

USER subscriptions

# The internal listener's /health, on whatever port SUBSCRIPTIONS_INTERNAL_ADDRESS names at run time.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${SUBSCRIPTIONS_INTERNAL_ADDRESS##*:}/health" || exit 1

CMD ["subscriptions"]
