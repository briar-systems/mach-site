// single source of truth for the advertised mach version.
// populates every .badge-version span (prefixed with "v") and any
// [data-mach-version] element (raw token, e.g. the cli "mach info" line).
(function () {
  "use strict";

  // the one place a release bumps the advertised mach version.
  var MACH_VERSION = "2.6.0";

  function apply() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".badge-version"),
      function (el) { el.textContent = "v" + MACH_VERSION; }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-mach-version]"),
      function (el) { el.textContent = MACH_VERSION; }
    );
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { MACH_VERSION: MACH_VERSION };
  } else if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply);
    } else {
      apply();
    }
  }
})();
