# Deploying machlang.org on Railway

This is the runbook for the Railway service that serves machlang.org. Everything
the service runs is in this repository: `Dockerfile` builds the image,
`railway.toml` holds the build and deploy settings, and `hedge.toml` is the
server's configuration. Deploying needs no code change. Follow the steps in
order and do not skip a verification.

Until the cutover at the end, GitHub Pages keeps serving machlang.org from
`.github/workflows/deploy.yml`, and the Railway service runs on its Railway
domain only.

## What runs

One container from `Dockerfile`:

- The build stage installs the mach release pinned in `Dockerfile`
  (`MACH_VERSION`, checked against the release's `SHA256SUMS` and the pinned
  `MACH_SHA256`), realizes the dependencies at the release tags `mach.toml`
  names, builds the server with `--profile release`, and writes a `.gz` and a
  `.br` beside every text file under `public/`.
- The llms stage builds `llms.txt` and `llms-full.txt` for the newest mach
  release at the time of the build. They change only with a build, so
  redeploy the service (**Deployments → ⋯ → Redeploy**) after each mach
  release.
- The final image is `FROM scratch`: the server at `/srv/site/site`, its
  configuration at `/srv/site/hedge.toml`, the site at `/srv/site/public/`, and
  the CA bundle at `/etc/ssl/certs/ca-certificates.crt`. It runs as uid and gid
  65534.

The server is hedge with the site's laurel application mounted through graft.
It listens on plain HTTP/1.1 at `LISTEN`, since Railway terminates TLS at its
edge. hedge serves every file under `public/` and `GET /healthz` itself, logs
one line per request to stdout, and on SIGTERM stops accepting, drains the
requests in flight for up to 10 seconds, and exits 0.

A build needs outbound access to github.com (the mach release, the dependencies
and the mach docs) and about 2 GB of memory at its peak.

## 1. Service

In the Railway project, create the service:

1. **New → GitHub Repo →** `briar-systems/mach-site`.
2. **Settings → Source:** branch `main`, root directory `/` (empty). Leave
   "Wait for CI" off: this repository runs CI on pull requests, not on pushes
   to `main`.
3. **Settings → Build and Deploy:** Railway reads `railway.toml` from the
   repository root. Confirm the service shows these values, which come from it,
   and do not override them in the dashboard:

   | setting | value |
   |---|---|
   | builder | Dockerfile |
   | Dockerfile path | `Dockerfile` |
   | healthcheck path | `/healthz` |
   | healthcheck timeout | 120 seconds |
   | restart policy | on failure, at most 10 retries |
   | overlap | 15 seconds |
   | draining | 30 seconds |

4. **Settings → Deploy:** leave the start command empty (the image's entrypoint
   runs the server), one replica, and serverless (app sleeping) off.

## 2. Variables

Set these under **Variables**. Nothing else is read.

| name | purpose | example | secret |
|---|---|---|---|
| `PORT` | the port Railway routes the domain and its health check to. It must equal the port in `LISTEN` | `8080` | no |
| `LISTEN` | the address the server listens on, `host:port`, read by `hedge.toml` through `${ENV:LISTEN}`. The image defaults it to `0.0.0.0:8080`, so setting it is optional as long as `PORT` is `8080` | `0.0.0.0:8080` | no |

## 3. Networking

1. **Settings → Networking → Public Networking → Generate Domain.** Set its
   target port to `8080`.
2. Do not add a custom domain yet. That is the cutover.

## 4. Deploy

Deploy the service (a push to `main` deploys it from then on). The deployment
goes live once `/healthz` answers `200`. The deploy log ends with:

```
graft: serving site on 2 workers
```

## 5. Verify on the Railway domain

Set `SITE` to the generated domain, for example
`SITE=https://mach-site-production.up.railway.app`, and run each check. Every one
must print exactly what is shown.

```sh
# the health check, for the platform's host name and any other
curl -s "$SITE/healthz"                                  # ok
curl -s -H 'Host: healthcheck.railway.app' "$SITE/healthz" # ok

# pages, with their type and caching
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/"
# 200 text/html; charset=utf-8
curl -sI "$SITE/" | grep -i '^cache-control'             # cache-control: no-cache
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$SITE/docs"
# 301 https://<the domain>/docs/
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/docs/types.html"     # 200

# the install forwarders at their public urls
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/install.sh"
# 200 application/x-sh
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/install.ps1"
# 200 text/plain; charset=utf-8
curl -fsSL "$SITE/install.sh" | head -n 1                # #!/bin/sh

# an example, an asset, and the llms files
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/examples/hello.mach"
# 200 text/plain; charset=utf-8
curl -sI "$SITE/assets/mach.svg" | grep -i '^cache-control' # cache-control: public, max-age=86400
curl -s "$SITE/llms.txt" | head -n 1                     # # Mach

# precompressed variants and a revalidation
curl -s -o /dev/null -H 'Accept-Encoding: br' -w '%{content_type}\n' -D - "$SITE/style.css" | grep -i '^content-encoding'
# content-encoding: br
etag=$(curl -sI "$SITE/style.css" | tr -d '\r' | sed -n 's/^etag: //Ip')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $etag" "$SITE/style.css"   # 304

# a missing page
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/no/such/page"
# 404 text/html; charset=utf-8
```

Then check the service itself:

- **Logs:** the deploy log shows one `request completed` line per request
  above, on stdout.
- **Drain:** redeploy the service (**Deployments → ⋯ → Redeploy**) while
  running `while :; do curl -s -o /dev/null -w '%{http_code}\n' "$SITE/"; done`.
  Every line is `200`, and the old deployment's log ends with `graft: stopped`.

The same checks run in CI on every pull request against the image built from
it (`test/serve.test.js`, the `container` job).

## 6. Cutover

Do this only once the live ecosystem catalog (#112) passes its checks on the
Railway domain. Until then Pages keeps serving machlang.org.

machlang.org's DNS is on Cloudflare. Today the apex has four `A` records to
GitHub Pages (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
`185.199.111.153`) and `www` is a `CNAME` to `briar-systems.github.io`.

1. **Railway → Settings → Networking → Custom Domain →** `machlang.org`, target
   port `8080`. Railway shows a `CNAME` target (`<id>.up.railway.app`) and a
   `TXT` verification record.
2. **Cloudflare → DNS:**
   1. Add the `TXT` record exactly as Railway shows it.
   2. Delete the four `A` records on `machlang.org`.
   3. Add `CNAME` `machlang.org` (name `@`) → the Railway target, proxy status
      **DNS only**. Cloudflare flattens a `CNAME` at the apex.
   4. Change `www` to `CNAME` `www` → `machlang.org`, proxy status **Proxied**,
      and add a redirect rule (**Rules → Redirect Rules → Single Redirect**):
      when hostname equals `www.machlang.org`, redirect dynamically to
      `concat("https://machlang.org", http.request.uri.path)` with status 301
      and the query string preserved.
3. Wait for Railway to show the domain verified with a certificate issued
   (a green check). This takes up to an hour after the records resolve.
4. Verify through the edge:

   ```sh
   SITE=https://machlang.org
   dig +short machlang.org                               # Railway's addresses, no 185.199.x
   curl -s "$SITE/healthz"                               # ok
   curl -s -o /dev/null -w '%{http_code}\n' "$SITE/"          # 200
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.machlang.org/docs/
   # 301 https://machlang.org/docs/
   curl -fsSL "$SITE/install.sh" | head -n 1             # #!/bin/sh
   ```

   and repeat every check of step 5 with this `SITE`.
5. **Remove GitHub Pages**, in this order, once step 4 passes:
   1. **GitHub → briar-systems/mach-site → Settings → Pages:** unpublish the
      site and set the source to none. Remove the `github-pages` environment
      under **Settings → Environments**.
   2. Open one pull request into `dev` that deletes what only the Pages deploy
      used, and nothing else:
      - `.github/workflows/deploy.yml`
      - `.github/workflows/refresh.yml`
      - `CNAME`

      Merge it into `dev`, then release `dev` to `main` as usual. Railway
      deploys `main`.
