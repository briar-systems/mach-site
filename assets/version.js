// advertised mach version. the deploy replaces the placeholder with the latest
// mach release (.github/scripts/bake-version.sh), so a local preview shows it raw.
// populates every .badge-version span (prefixed with "v") and any
// [data-mach-version] element (raw token, e.g. the cli "mach info" line).
(function () {
  "use strict";

  var MACH_VERSION = "@MACH_VERSION@";

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
