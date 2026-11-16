# syntax=docker/dockerfile:1.7
FROM rust:1.99.1-slim-trixie AS build
COPY rust-toolchain.toml /pinned/rust-toolchain.toml
RUN grep -qxF "channel = \"${RUST_VERSION}\"" /pinned/rust-toolchain.toml
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY tools ./tools
COPY migrations ./migrations
COPY config ./config
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin windmill-ai \
 && cp target/release/windmill-ai /usr/local/bin/windmill-ai

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10002 --no-create-home --shell /usr/sbin/nologin windmill-ai
WORKDIR /app
COPY --from=build /usr/local/bin/windmill-ai /usr/local/bin/windmill-ai
COPY --from=build /src/config /app/config
ARG SENTRY_RELEASE=
ENV SENTRY_RELEASE=${SENTRY_RELEASE} \
    AI_PUBLIC_ADDRESS=0.0.0.0:8084 \
    AI_INTERNAL_ADDRESS=0.0.0.0:8085
EXPOSE 8084 8085
USER windmill-ai
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${AI_INTERNAL_ADDRESS##*:}/health" | grep -qxF '{"status":"ready"}'
CMD ["windmill-ai"]
