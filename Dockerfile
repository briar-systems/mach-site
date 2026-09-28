# the machlang.org server image
#
# build: installs the pinned mach release, realizes the dependencies at the
# release tags mach.toml names, builds the server in release and precompresses
# the text files it serves. llms: builds llms.txt and llms-full.txt for the
# newest mach release. the final image holds the server, its configuration,
# public/ and the CA bundle, and nothing else.

# the compiler, and the sha256 its release lists in SHA256SUMS
ARG MACH_VERSION=6.3.0
ARG MACH_SHA256=e42717ae4f54e3e23c1b3d12f741ccf15616f6465018f0f6eaed7f0550bea3a9

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
RUN apt-get update \
    && apt-get install -y --no-install-recommends brotli ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /site
COPY .github/scripts/build-llms.js .github/scripts/
COPY public public
RUN set -eu; \
    tag=$(git ls-remote --tags --refs https://github.com/briar-systems/mach 'v*' \
        | sed 's|.*refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1); \
    test -n "$tag"; \
    git clone -q --depth 1 --branch "$tag" --filter=blob:none --sparse \
        https://github.com/briar-systems/mach /tmp/mach; \
    git -C /tmp/mach sparse-checkout set doc/language; \
    sed -i "s/@MACH_VERSION@/${tag#v}/" public/assets/version.js; \
    MACH_DOCS_DIR=/tmp/mach/doc/language node .github/scripts/build-llms.js; \
    mkdir /out; \
    for f in llms.txt llms-full.txt; do \
        cp "public/$f" /out/; gzip -9 -k -n "/out/$f"; brotli -q 11 -k "/out/$f"; \
    done

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /srv/site
COPY --from=build /src/out/linux-x86_64/release/bin/site ./site
COPY --from=build /src/hedge.toml ./hedge.toml
COPY --from=build /src/public ./public
COPY --from=llms /out/ ./public/
USER 65534:65534
ENV LISTEN=0.0.0.0:8080
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/srv/site/site", "/srv/site/hedge.toml"]
