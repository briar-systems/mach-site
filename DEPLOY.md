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
  release.
- The final image is `FROM scratch`: the server at `/srv/site/site`, its
  configuration at `/srv/site/hedge.toml` (the image's command, so a run can
  name another), the site at `/srv/site/public/`, and the CA bundle at
  `/etc/ssl/certs/ca-certificates.crt`. It runs as uid and gid 65534 unless
  Railway's `RAILWAY_RUN_UID` says otherwise (see Variables).

The server is hedge with the site's laurel application mounted through graft.
It listens on plain HTTP/1.1 at `LISTEN`, since Railway terminates TLS at its
edge. hedge serves every file under `public/` itself. The application serves
`GET /healthz`, `GET /ecosystem/` (and redirects `/ecosystem` to it),
`GET /ecosystem.json` and `POST /hooks/ecosystem`. The server logs one line per
request to stdout, and on SIGTERM stops accepting, drains the requests in
flight for up to 10 seconds, and exits 0.

The ecosystem catalog is refreshed by a background task every 5 minutes, and
at once when mach-ecosystem's webhook calls `/hooks/ecosystem`. Each refresh
reads `entries.json` from mach-ecosystem's `main` and GitHub's GraphQL API
with `GITHUB_TOKEN`, publishes the new catalog, and writes it to
`/data/ecosystem.json` on the volume. At start the server publishes the
volume's copy before it asks GitHub, so a restart while GitHub is down still
serves the last catalog, marked stale once it is over 10 minutes old, and the
page shows its age once it is over an hour old. With no
copy and no GitHub, `/ecosystem/` shows a notice linking to mach-ecosystem.
Page requests never call GitHub.

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

4. **Settings → Deploy:** leave the start command empty (the image runs the
   server with `/srv/site/hedge.toml`), one replica, and serverless (app
   sleeping) off.
5. **Volume:** right-click the service (or **⌘K → Volume**) and attach a new
   volume with mount path `/data`, the smallest size the plan offers. The
   catalog file is tens of kilobytes. A service with a volume cannot run two
   deployments at once, so Railway stops the old deployment before the new one
   starts, and a redeploy is unavailable for the few seconds that takes: the
   overlap setting has no effect then.

## 2. Variables

Set these under **Variables**. Nothing else is read.

| name | purpose | example | secret |
|---|---|---|---|
| `PORT` | the port Railway routes the domain and its health check to. It must equal the port in `LISTEN` | `8080` | no |
| `LISTEN` | the address the server listens on, `host:port`, read by `hedge.toml` through `${ENV:LISTEN}`. The image defaults it to `0.0.0.0:8080`, so setting it is optional as long as `PORT` is `8080` | `0.0.0.0:8080` | no |
| `GITHUB_TOKEN` | the token the catalog refresh sends GitHub's GraphQL API. A fine-grained personal access token of a machine account, not a person's, with **Repository access: Public repositories (read-only)** and no permissions, so the rate limit (5,000 points an hour, of which the refresh uses about 12) is the machine account's. Set a reminder for its expiry. The server refuses to start without it | `github_pat_11AAAA...` | yes |
| `ECOSYSTEM_WEBHOOK_SECRET` | the secret mach-ecosystem's webhook signs each delivery with (`X-Hub-Signature-256`). Generate it with `openssl rand -hex 32` and enter the same value in the webhook (step 5). The server refuses to start without it | `3f9c...` (64 hex characters) | yes |
| `RAILWAY_RUN_UID` | Railway mounts volumes owned by root, so the process must run as root to write `/data`. Without it the catalog is served and refreshed but never kept, and a restart while GitHub is down has nothing to serve | `0` | no |

A change to any variable redeploys the service. Rotating a secret is setting
its new value here, and for the webhook secret also in the webhook, in either
order: deliveries fail with 401 until both match.

## 3. Networking

1. **Settings → Networking → Public Networking → Generate Domain.** Set its
   target port to `8080`.
2. Do not add a custom domain yet. That is the cutover.

## 4. Deploy

Deploy the service (a push to `main` deploys it from then on). The deployment
goes live once `/healthz` answers `200`. The first deploy's log shows:

```
site: no catalog on the volume at /data/ecosystem.json
site: serving site on 2 workers
site: catalog refreshed: <n> entries, <m> with github metadata
```

A later deploy shows `site: published the catalog kept at /data/ecosystem.json`
in place of the first line. A line `site: catalog refresh failed: ...` names
what went wrong: `answered with an error status (cause 401)` from the GraphQL
API is a wrong `GITHUB_TOKEN`. `site: the catalog could not be kept at
/data/ecosystem.json` is a missing volume or `RAILWAY_RUN_UID`.

## 5. Webhook on mach-ecosystem

**GitHub → briar-systems/mach-ecosystem → Settings → Webhooks → Add webhook:**

| field | value |
|---|---|
| Payload URL | `https://<the Railway domain>/hooks/ecosystem` |
| Content type | `application/json` |
| Secret | the value of `ECOSYSTEM_WEBHOOK_SECRET` |
| SSL verification | enabled |
| Which events | Just the `push` event |
| Active | checked |

GitHub sends a `ping` at once. Under **Recent Deliveries** it answers `202` with
`{"refresh":"queued"}` (or `"coalesced"`), and the service log shows a
`site: catalog refreshed` line within seconds. A `401` means the two secrets
differ. mach-ecosystem's own workflows are unchanged: the rebuild commit its bot
pushes after a merge is the push that refreshes the catalog.

## 6. Verify on the Railway domain

Set `SITE` to the generated domain, for example
`SITE=https://mach-site-production.up.railway.app`, and run each check. Every one
must print exactly what is shown.

```sh
# the health check, for the platform's host name and any other, with the
# catalog's age
curl -s "$SITE/healthz"
# ok
# catalog_generated 2026-10-01T12:00:00Z   (the last refresh, within 5 minutes)
# catalog_age_seconds 42                    (under 300)
# catalog_stale false
curl -s -H 'Host: healthcheck.railway.app' "$SITE/healthz" | head -n 1   # ok

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

# the catalog: its json, the page, filters without javascript, the redirect
curl -s "$SITE/ecosystem.json" | head -c 16; echo        # {"stale":false,
curl -sI "$SITE/ecosystem.json" | grep -i '^cache-control' # cache-control: public, max-age=60
curl -s "$SITE/ecosystem/" | grep -o 'class="panel eco-card"' | wc -l
# the number of entries in mach-ecosystem's entries.json
curl -s "$SITE/ecosystem/?category=web&sort=name" | grep -o 'eco-status" aria-live="polite">[^<]*'
# eco-status" aria-live="polite">showing <k> of <n> projects
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$SITE/ecosystem?q=http"
# 301 https://<the domain>/ecosystem/?q=http

# the webhook refuses an unsigned call
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' "$SITE/hooks/ecosystem"   # 401
```

Then check the service itself:

- **Logs:** the deploy log shows one `request completed` line per request
  above, on stdout.
- **Drain:** redeploy the service (**Deployments → ⋯ → Redeploy**). The old
  deployment's log ends with `graft: stopped`, which it prints only after a
  drain that finished every request in flight. Because of the volume, the
  site is unavailable for the seconds between that and the new deployment's
  health check passing.
- **Persistence:** after the redeploy, the new deployment's log starts with
  `site: published the catalog kept at /data/ecosystem.json`.
- **Webhook:** in mach-ecosystem's webhook, **Recent Deliveries → ⋯ →
  Redeliver** the ping. It answers `202`, and `catalog_generated` in
  `/healthz` moves to that moment.

The same checks run in CI on every pull request against the image built from
it, with a local stand-in for GitHub (`test/serve.test.js`,
`test/catalog.test.js` and `test/stub/github.js`, the `container` job).

## 7. Cutover

Do this only once every check of step 6 passes on the Railway domain. Until
then Pages keeps serving machlang.org.

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
   curl -s "$SITE/healthz" | head -n 1                   # ok
   curl -s -o /dev/null -w '%{http_code}\n' "$SITE/"          # 200
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.machlang.org/docs/
   # 301 https://machlang.org/docs/
   curl -fsSL "$SITE/install.sh" | head -n 1             # #!/bin/sh
   ```

   and repeat every check of step 6 with this `SITE`.
5. **Point the webhook at the public name:** in mach-ecosystem's webhook, set
   the Payload URL to `https://machlang.org/hooks/ecosystem`, save, and
   redeliver the last delivery. It answers `202`.
6. **Remove GitHub Pages**, in this order, once steps 4 and 5 pass:
   1. **GitHub → briar-systems/mach-site → Settings → Pages:** unpublish the
      site and set the source to none. Remove the `github-pages` environment
      under **Settings → Environments**.
   2. Open one pull request into `dev` that deletes what only the Pages deploy
      used, and nothing else:
      - `.github/workflows/deploy.yml`
      - `.github/workflows/refresh.yml`
      - `CNAME`
      - `.github/scripts/bake-ecosystem.js` and `test/bake.test.js`
      - the `pages-bake` job in `.github/workflows/ci.yml`, and `pages-bake`
        in the `gate` job's `needs`
      - `public/ecosystem/index.html` and `public/ecosystem/pages.js`, the
        pages copy of the ecosystem page
      - the line `public/ecosystem/data.json` in `.gitignore`

      Merge it into `dev`, then release `dev` to `main` as usual. Railway
      deploys `main`.
