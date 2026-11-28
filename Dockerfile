# the machlang.org server image
#
# build: installs the pinned mach release and fetches the same release built
# for wasi, realizes the dependencies mach.toml pins and builds the server in
# release. generate: builds the site's half of llms.txt and llms-full.txt from
# public/docs/, which the server completes with mach's newest release, and
# packs the libraries the playground's compiler builds against. static: public/
# with those libraries and the playground's compiler, precompressed. the final
# image holds the server, its configuration, public/, the llms templates and
# the CA bundle, and nothing else.

# the mach release, and the sha256 its SHA256SUMS lists for the compiler that
# builds the server and for the one the playground loads
ARG MACH_VERSION=7.3.0
ARG MACH_SHA256=dd92c6c739c78f6a4aeab189bef835e3a56c89fab210cff33d8eb25d015c8798
ARG MACH_WASM_SHA256=5ab1bf111c650edae0592a3575f17b3a0be1b4c53aa0ebfc8cd6374358ba9517

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
WORKDIR /site
COPY .github/scripts/build-llms.js .github/scripts/build-playground-libs.js .github/scripts/
COPY public public
COPY --from=build /src/dep/std dep/std
COPY --from=build /src/dep/shader dep/shader
RUN node .github/scripts/build-llms.js /out \
    && node .github/scripts/build-playground-libs.js /playground/libs.json

FROM build AS static
COPY public public
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
