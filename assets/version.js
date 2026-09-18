// advertised mach version. the deploy bakes the latest mach release into the
// placeholder (.github/scripts/bake-version.sh), so a local preview shows it raw.
// the page applies that baked value first, then asks the github api for the
// latest release and re-applies if the answer is a well-formed tag. any failure
// keeps the baked value. populates every .badge-version span (prefixed with "v")
// and any [data-mach-version] element (raw token, e.g. the cli "mach info" line).
(function () {
  "use strict";

  var MACH_VERSION = "@MACH_VERSION@";
  var LATEST_URL = "https://api.github.com/repos/briar-systems/mach/releases/latest";
  var TAG = /^v(\d+\.\d+\.\d+)$/;

  // the version a release object carries, or null when it is not a plain vX.Y.Z tag
  function versionOf(release) {
    if (!release || typeof release.tag_name !== "string") { return null; }
    var m = TAG.exec(release.tag_name);
    return m ? m[1] : null;
  }

  function apply(version) {
    Array.prototype.forEach.call(
      document.querySelectorAll(".badge-version"),
      function (el) { el.textContent = "v" + version; }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-mach-version]"),
      function (el) { el.textContent = version; }
    );
  }

  // resolves to the live version, or to the fallback on any failure
  function latest(fetchFn, fallback) {
    function keep() { return fallback; }
    if (typeof fetchFn !== "function") { return Promise.resolve(fallback); }
    try {
      return fetchFn(LATEST_URL, { headers: { Accept: "application/vnd.github+json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) { return versionOf(body) || fallback; })
        .catch(keep);
    } catch (e) {
      return Promise.resolve(fallback);
    }
  }

  function start() {
    apply(MACH_VERSION);
    latest(typeof fetch === "function" ? fetch : null, MACH_VERSION).then(function (v) {
      if (v !== MACH_VERSION) { apply(v); }
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { MACH_VERSION: MACH_VERSION, versionOf: versionOf, latest: latest };
  } else if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
})();
