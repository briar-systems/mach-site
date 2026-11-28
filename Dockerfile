# the machlang.org server image
#
# build: installs the pinned mach release and fetches the same release built
# for wasi, realizes the dependencies mach.toml pins and builds the server in
# release. generate: fetches mach's guide for every release that has one and
# builds the docs pages from them, builds the site's half of llms.txt and
# llms-full.txt from the newest, which the server completes with mach's newest
# release, and packs the libraries the playground's compiler builds against.
# static: public/ with what was generated and the playground's compiler,
# precompressed. the final image holds the server, its configuration, public/,
# the llms templates and the CA bundle, and nothing else.

# the mach release, and the sha256 its SHA256SUMS lists for the compiler that
# builds the server and for the one the playground loads
ARG MACH_VERSION=7.3.1
ARG MACH_SHA256=5b9f29b53b2cc0aa756573576b5ac2f89fac4a47df0c91ae39ef7ce22b8b3777
ARG MACH_WASM_SHA256=e1b7eb94860a1b171da2921084848811d6d70b5d8ad4d7a10bb0a3d04d53e878

FROM debian:bookworm-slim AS build
ARG MACH_VERSION
ARG MACH_SHA256
ARG MACH_WASM_SHA256
RUN apt-get update \
    && apt-get install -y --no-install-recommends brotli ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
COPY .github/scripts/fetch-compiler.sh /opt/fetch-compiler.sh
RUN set -eu; \
    sh /opt/fetch-compiler.sh "$MACH_VERSION" x86_64-linux "$MACH_SHA256" /opt/mach; \
    sh /opt/fetch-compiler.sh "$MACH_VERSION" wasm32-wasi "$MACH_WASM_SHA256" /opt/wasm; \
    install -m 0755 /opt/mach/mach /usr/local/bin/mach; \
    mach info
WORKDIR /src
COPY mach.toml ./
RUN mach dep pull . && mach dep verify .
COPY src src
RUN mach build . --profile release
COPY hedge.toml ./

FROM node:22-bookworm-slim AS generate
# a branch to read as a release in place of the tags, as feat/1=7.4.0, to
# build the site around a guide before its release
ARG GUIDE=
WORKDIR /site
# mach's refs name the releases to document. fetched as a build input, so a
# build after a new tag fetches the guides again and never reuses this layer
ADD https://github.com/briar-systems/mach.git/info/refs?service=git-upload-pack /refs
COPY .github/scripts/fetch-guide.js .github/scripts/build-docs.js .github/scripts/build-llms.js .github/scripts/build-playground-libs.js .github/scripts/
COPY public public
COPY --from=build /src/dep/std dep/std
COPY --from=build /src/dep/shader dep/shader
RUN node .github/scripts/fetch-guide.js /guide --refs /refs ${GUIDE} \
    && node .github/scripts/build-docs.js /guide /docs \
    && node .github/scripts/build-llms.js /out /guide \
    && node .github/scripts/build-playground-libs.js /playground/libs.json

FROM build AS static
COPY public public
COPY --from=generate /docs/ public/docs/
COPY --from=generate /playground/libs.json public/playground/libs.json
# the playground's compiler is the release itself, built for wasi
RUN install -m 0644 /opt/wasm/mach.wasm public/playground/mach.wasm
RUN find public -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' \
        -o -name '*.svg' -o -name '*.txt' -o -name '*.json' -o -name '*.mach' \
        -o -name '*.sh' -o -name '*.ps1' -o -name '*.wasm' \) \
        -exec gzip -9 -k -n {} \; -exec brotli -q 11 -k {} \;

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /srv/site
COPY --from=build /src/out/linux-x86_64/release/bin/site ./site
COPY --from=build /src/hedge.toml ./hedge.toml
COPY --from=static /src/public ./public
COPY --from=generate /out/ ./llms/
USER 65534:65534
ENV LISTEN=0.0.0.0:8080
EXPOSE 8080
STOPSIGNAL SIGTERM
# the configuration is the one argument, so a run can name another
ENTRYPOINT ["/srv/site/site"]
CMD ["/srv/site/hedge.toml"]
