// the railway project that serves machlang.org. this repository is its only
// source, so the file describes the whole project and a resource left out of
// it is deleted on apply. the secrets are set on the service and never here:
// preserve() keeps whatever value railway holds.
import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const site = service("site", {
    source: github("briar-systems/mach-site", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      // hedge answers /healthz for every host name, the health checker's included
      healthcheckPath: "/healthz",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // the new deployment takes traffic before the old one is stopped, and the
      // old one gets SIGTERM with 30 seconds to drain (hedge.toml drains in 10,
      // then stops within 5) before it is killed
      overlapSeconds: 15,
      drainingSeconds: 30,
      sleepApplication: false,
    },
    replicas: 1,
    networking: {
      customDomains: { "machlang.org": { port: 8080 } },
      serviceDomains: { "site-production-6254.up.railway.app": { port: 8080 } },
    },
    env: {
      PORT: "8080",
      LISTEN: "0.0.0.0:8080",
      GITHUB_TOKEN: preserve(),
      ECOSYSTEM_WEBHOOK_SECRET: preserve(),
    },
  });

  return project("mach-site", { resources: [site] });
});
