// run against a running server image that was started as railway starts it,
// with RAILWAY_SERVICE_ID and RAILWAY_ENVIRONMENT_ID set, whose deploy
// settings point at test/stub/railway.js and at a list of built releases older
// than the newest release test/stub/github.js answers, and whose llms period
// is one second:
//   SITE_URL=http://127.0.0.1:8080 RAILWAY_STUB=http://127.0.0.1:18213 \
//     GITHUB_STUB=http://127.0.0.1:18212 STUB_TOKEN=test-token \
//     BUILT=6.9.0 SERVICE=svc-1 ENVIRONMENT=env-1 node --test test/deploy.test.js
// checks that the server asks railway for nothing while the only release newer
// than its docs was out before it started, that a release tagged while it runs
// gets one rebuild, as that service in that environment, and that the health
// check names what the docs hold. the tests run in order and each builds on
// the one before.
const test = require("node:test");
const assert = require("node:assert/strict");

const { SITE_URL, RAILWAY_STUB, GITHUB_STUB, STUB_TOKEN, BUILT, SERVICE, ENVIRONMENT } = process.env;
const SERVER = { skip: SITE_URL && RAILWAY_STUB && GITHUB_STUB ? false : "set SITE_URL, RAILWAY_STUB and GITHUB_STUB to check a running server" };

// the release tagged while the server runs, newer than the stub's newest
const TAGGED = "6.11.0";
// long enough for several of the server's one-second periods
const PERIODS_MS = 3500;

async function calls() {
  return (await fetch(new URL("/calls", RAILWAY_STUB))).json();
}

// waits until the health check names the release the llms files are served
// for, which the run that noticed a release publishes last. with no release
// given, any will do
async function served(release) {
  const until = Date.now() + 15000;
  for (;;) {
    const health = await (await fetch(new URL("/healthz", SITE_URL))).text();
    const found = /^llms_version ([\d.]+)$/m.exec(health);
    if (found && (!release || found[1] === release)) { return; }
    if (Date.now() > until) { throw new Error(`the llms files were not served for ${release || "any release"} within 15 seconds`); }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a release out before the server started asks railway for nothing", SERVER, async () => {
  await served();
  await sleep(PERIODS_MS);
  assert.deepEqual(await calls(), []);
});

test("a release tagged while the server runs asks railway for one rebuild", SERVER, async () => {
  const tagged = await fetch(new URL(`/mach/tags/v${TAGGED}`, GITHUB_STUB), { method: "POST", headers: { authorization: `bearer ${STUB_TOKEN}` } });
  assert.equal(tagged.status, 204);
  await served(TAGGED);
  await sleep(PERIODS_MS);
  const seen = await calls();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorized, true);
  assert.equal(seen[0].type, "application/json");
  assert.match(seen[0].query, /^mutation\(\$s:String!,\$e:String!\)\{serviceInstanceDeployV2\(serviceId:\$s,environmentId:\$e\)\}$/);
  assert.deepEqual(seen[0].variables, { s: SERVICE, e: ENVIRONMENT });
});

test("the health check names the newest release the docs hold", SERVER, async () => {
  const body = await (await fetch(new URL("/healthz", SITE_URL))).text();
  assert.match(body, new RegExp(`^docs_version ${BUILT.replace(/\./g, "\\.")}$`, "m"));
});
