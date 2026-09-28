# the machlang.org server image
#
# build: installs the pinned mach release, realizes the dependencies at the
# release tags mach.toml names, builds the server in release and precompresses
# the text files it serves. llms: builds the site's half of llms.txt and
# llms-full.txt from public/docs/, which the server completes with mach's newest
# release. the final image holds the server, its configuration, public/, the
# llms templates and the CA bundle, and nothing else.

# the compiler, and the sha256 its release lists in SHA256SUMS
ARG MACH_VERSION=6.5.0
ARG MACH_SHA256=d08913e34e379d4a0e34f96d7e62d797b87a0e64de3759a34ea6d1812585f2e9

FROM debian:bookworm-slim AS build
ARG MACH_VERSION
ARG MACH_SHA256
RUN apt-get update \
    && apt-get install -y --no-install-recommends brotli ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mach
RUN set -eu; \
    archive="mach-${MACH_VERSION}-x86_64-linux.tar.gz"; \
    base="https://github.com/briar-systems/mach/releases/download/v${MACH_VERSION}"; \
    curl -fsSLO "$base/$archive"; \
    curl -fsSLO "$base/SHA256SUMS"; \
    grep -qx "${MACH_SHA256}  $archive" SHA256SUMS; \
    sha256sum -c --ignore-missing SHA256SUMS; \
    tar -xzf "$archive"; \
    install -m 0755 mach /usr/local/bin/mach; \
    mach info
WORKDIR /src
COPY mach.toml ./
RUN mach dep pull . && mach dep verify .
COPY src src
RUN mach build . --profile release
COPY hedge.toml ./
COPY public public
RUN find public -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' \
        -o -name '*.svg' -o -name '*.txt' -o -name '*.json' -o -name '*.mach' \
        -o -name '*.sh' -o -name '*.ps1' \) \
        -exec gzip -9 -k -n {} \; -exec brotli -q 11 -k {} \;

FROM node:22-bookworm-slim AS llms
WORKDIR /site
COPY .github/scripts/build-llms.js .github/scripts/
COPY public public
RUN node .github/scripts/build-llms.js /out

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /srv/site
COPY --from=build /src/out/linux-x86_64/release/bin/site ./site
COPY --from=build /src/hedge.toml ./hedge.toml
COPY --from=build /src/public ./public
COPY --from=llms /out/ ./llms/
USER 65534:65534
ENV LISTEN=0.0.0.0:8080
EXPOSE 8080
STOPSIGNAL SIGTERM
# the configuration is the one argument, so a run can name another
ENTRYPOINT ["/srv/site/site"]
CMD ["/srv/site/hedge.toml"]
