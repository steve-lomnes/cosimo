# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# ^ Dependabot's docker ecosystem only parses FROM lines, not this directive; update by hand.

# Cosimo container image: the single-file executable (web UI embedded) on distroless/cc.
#
# The builder always runs on the build host's platform and cross-compiles for TARGETARCH with
# `bun build --compile --target`, so multi-arch builds need no QEMU emulation.

FROM --platform=$BUILDPLATFORM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
ARG TARGETARCH
# Baked into the binary as the reported version/commit (packages/shared/src/distribution.ts).
# Unset, the binary reports the dev version and never checks for updates.
ARG COSIMO_VERSION
ARG COSIMO_COMMIT
WORKDIR /src

# Install with every CPU's optional deps so the target's @libsql/linux-<arch>-gnu native addon
# is present even when it differs from the build host's architecture.
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --os=linux --cpu='*'

COPY . .
RUN bun run build:web
RUN case "$TARGETARCH" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && set -- --target "bun-linux-${arch}" --outfile /out/cosimo \
 && if [ -n "$COSIMO_VERSION" ]; then set -- "$@" --version "$COSIMO_VERSION"; fi \
 && if [ -n "$COSIMO_COMMIT" ]; then set -- "$@" --commit "$COSIMO_COMMIT"; fi \
 && bun apps/server/scripts/build-binary.ts "$@"

# Non-root user (uid/gid 10001) and the directories it owns, staged for the distroless image,
# which has no shell to run useradd/mkdir.
RUN mkdir -p /rootfs/etc /rootfs/data /rootfs/etc/cosimo \
 && printf 'root:x:0:0:root:/root:/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin\ncosimo:x:10001:10001:cosimo:/data:/sbin/nologin\n' > /rootfs/etc/passwd \
 && printf 'root:x:0:\nnobody:x:65534:\ncosimo:x:10001:\n' > /rootfs/etc/group \
 && chown -R 10001:10001 /rootfs/data /rootfs/etc/cosimo

# distroless/cc ships glibc, libgcc/libstdc++ (needed by the libsql native addon) and CA certificates.
FROM gcr.io/distroless/cc-debian12:latest@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa
ARG COSIMO_VERSION
ARG COSIMO_COMMIT

LABEL org.opencontainers.image.title="Cosimo" \
      org.opencontainers.image.description="Self-hosted double-entry bookkeeping" \
      org.opencontainers.image.source="https://github.com/steve-lomnes/cosimo" \
      org.opencontainers.image.url="https://github.com/steve-lomnes/cosimo" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${COSIMO_VERSION}" \
      org.opencontainers.image.revision="${COSIMO_COMMIT}"

COPY --from=builder /rootfs/etc/passwd /rootfs/etc/group /etc/
COPY --from=builder --chown=10001:10001 /rootfs/data /data
COPY --from=builder --chown=10001:10001 /rootfs/etc/cosimo /etc/cosimo
COPY --from=builder --chmod=0755 /out/cosimo /usr/local/bin/cosimo

ENV COSIMO_CONFIG=/etc/cosimo/config.toml \
    COSIMO_DATABASE_DATA_DIR=/data \
    COSIMO_SERVER_HOST=0.0.0.0 \
    COSIMO_SERVER_PORT=8787 \
    HOME=/data

USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/cosimo"]
CMD ["serve"]
