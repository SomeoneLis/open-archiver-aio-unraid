# Open Archiver AIO for Unraid
# One container: Open Archiver (app + workers), PostgreSQL 17, Valkey, Meilisearch and Apache Tika,
# supervised by s6-overlay v3. Versions are injected by the GitHub Actions workflow, which reads the
# latest upstream release and the Meilisearch/Tika versions pinned in that release's docker-compose.yml.

ARG OA_VERSION=v0.6.2
ARG MEILI_VERSION=v1.38
ARG TIKA_VERSION=4.1.0

# --- Meilisearch: the official image is Alpine/musl, so its binary runs as-is on the Alpine base ---
FROM getmeili/meilisearch:${MEILI_VERSION} AS meili

# --- Apache Tika: take the server jar from the official image (no OCR stack) ---
FROM apache/tika:${TIKA_VERSION} AS tika
USER root
RUN mkdir -p /out \
    && JAR="$(find / -xdev -type f -name 'tika-server-standard-*.jar' 2>/dev/null | head -n 1)" \
    && echo "Found Tika server jar: ${JAR}" \
    && test -n "${JAR}" \
    && cp "${JAR}" /out/tika-server.jar

# --- Final image: the official Open Archiver image (node:22-alpine) plus the companion services ---
FROM logiclabshq/open-archiver:${OA_VERSION}

ARG OA_VERSION
ARG MEILI_VERSION
ARG TIKA_VERSION
ARG S6_OVERLAY_VERSION=3.2.0.0

LABEL org.opencontainers.image.title="Open Archiver AIO" \
      org.opencontainers.image.description="Open Archiver with PostgreSQL, Valkey, Meilisearch and Apache Tika in one container for Unraid" \
      org.opencontainers.image.source="https://github.com/SomeoneLis/open-archiver-aio-unraid" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${OA_VERSION}" \
      io.openarchiver.aio.meilisearch="${MEILI_VERSION}" \
      io.openarchiver.aio.tika="${TIKA_VERSION}"

# 1. Companion services and tools from Alpine
RUN apk add --no-cache \
        bash \
        curl \
        xz \
        tzdata \
        su-exec \
        postgresql17 \
        postgresql17-client \
        valkey \
        openjdk21-jre-headless \
    && (command -v valkey-cli >/dev/null 2>&1 || apk add --no-cache valkey-cli) \
    && command -v valkey-server && command -v valkey-cli \
    && test -x /usr/libexec/postgresql17/postgres \
    && test -x /usr/libexec/postgresql17/psql \
    && test -x /usr/libexec/postgresql17/pg_isready \
    && java -version

# 2. s6-overlay v3
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz \
    && rm -f /tmp/s6-overlay-*.tar.xz

# 3. Meilisearch and Tika
COPY --from=meili /bin/meilisearch /usr/local/bin/meilisearch
COPY --from=tika /out/tika-server.jar /opt/tika/tika-server.jar
RUN meilisearch --version

# 4. s6 services, init script and healthcheck
COPY rootfs/ /
RUN chmod +x /etc/cont-init.d/* /etc/services.d/*/run /usr/local/bin/oa-healthcheck

ENV NODE_ENV=production \
    PORT_FRONTEND=3000 \
    PORT_BACKEND=4000 \
    STORAGE_TYPE=local \
    STORAGE_LOCAL_ROOT_PATH=/data \
    BODY_SIZE_LIMIT=100M \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_SERVICES_GRACETIME=30000 \
    S6_KILL_GRACETIME=5000 \
    OA_AIO_VERSION="${OA_VERSION}"

WORKDIR /app
VOLUME ["/config", "/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD /usr/local/bin/oa-healthcheck

ENTRYPOINT ["/init"]
CMD []
