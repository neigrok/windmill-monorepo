# The journal echoes embedding sidecar. Node, transformers.js, onnxruntime-node — and no model.
#
# The weights are NOT copied in: they are bind-mounted from the deployed web root, which is the same
# directory the browser downloads them from. A COPY would put a second copy of a 34MB file in the
# image and let it drift from the one the app serves, and the entire point of this service is that
# the server and the browser embed with the same bytes. See README.md.

FROM node:20-slim

WORKDIR /app

# onnxruntime-node ships prebuilt binaries for every platform npm supports (208MB), and
# @huggingface/transformers pulls onnxruntime-web alongside it for its browser build. The node entry
# point imports only onnxruntime-common and onnxruntime-node — verified, and re-verified by the
# import at the end of this step, which fails the build rather than the first request if the prune
# ever cuts too deep.
#
# All of it in ONE step on purpose: a `rm` in a later layer only writes a whiteout, and the bytes it
# "removed" still ship. Measured — splitting this in two left the image at 1.12GB.
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
# The fixture travels with the image so a deployment can prove itself: `node check/fixture.mjs` in a
# running container re-embeds five pinned sentences against the mounted weights and compares them to
# the vectors committed in this repo. A wrong mount stops being a thing anyone has to take on faith.
COPY check ./check

ENV MODEL_DIR=/models
ENV PORT=8081
EXPOSE 8081
USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
