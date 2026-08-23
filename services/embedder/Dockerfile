# The weights are not copied in: they are bind-mounted from the deployed web root.

FROM node:20-slim

WORKDIR /app

# Prune onnxruntime to the target arch in the SAME step as the install: a `rm` in a later layer
# only writes a whiteout and the bytes still ship.
ARG TARGETARCH
COPY package.json package-lock.json ./
RUN set -eu; \
    npm ci --omit=dev; \
    case "${TARGETARCH:-amd64}" in \
      amd64) keep=x64 ;; \
      arm64) keep=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    rm -rf node_modules/onnxruntime-web; \
    find node_modules/onnxruntime-node/bin/napi-v3 -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} +; \
    find node_modules/onnxruntime-node/bin/napi-v3/linux -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} +; \
    npm cache clean --force; \
    node -e "import('onnxruntime-node').then(() => console.log('onnxruntime-node loads'))"

COPY embedder.js server.js ./
COPY check ./check

ENV MODEL_DIR=/models
ENV PORT=8081
EXPOSE 8081
USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
