/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "shared-no-upper-layers",
      comment: "shared/ must not depend on domain, features, app, or pi",
      severity: "error",
      from: { path: "^extension-src/pi-subagents/shared/" },
      to: { path: "^(extension-src/pi-subagents/domain/|extension-src/pi-subagents/features/|extension-src/pi-subagents/app/|extension-src/pi-subagents/pi/)" },
    },
    {
      name: "domain-no-upper-layers",
      comment: "domain/ must not depend on features, app, or pi",
      severity: "error",
      from: { path: "^extension-src/pi-subagents/domain/" },
      to: { path: "^(extension-src/pi-subagents/features/|extension-src/pi-subagents/app/|extension-src/pi-subagents/pi/)" },
    },
    {
      name: "features-no-upper-layers",
      comment: "features/ must not depend on app or pi",
      severity: "error",
      from: { path: "^extension-src/pi-subagents/features/" },
      to: { path: "^(extension-src/pi-subagents/app/|extension-src/pi-subagents/pi/)" },
    },
    {
      name: "features-no-sibling-features",
      comment:
        "feature modules must not depend on sibling features; app/ composes features. Submodules within one feature folder are allowed (e.g. features/agent-panel/index.ts → features/agent-panel/run-row.ts, features/agent-view/index.ts → features/agent-view/transcript.ts). Shared rendering primitives live in shared/ so cross-feature imports remain violations.",
      severity: "error",
      from: { path: "^extension-src/pi-subagents/features/" },
      to: {
        path: "^extension-src/pi-subagents/features/",
        pathNot: "^extension-src/pi-subagents/features/(agent-panel|agent-view|notifications)/",
      },
    },
    {
      name: "app-no-pi",
      comment: "app/ must not depend on pi/",
      severity: "error",
      from: { path: "^extension-src/pi-subagents/app/" },
      to: { path: "^extension-src/pi-subagents/pi/" },
    },
    {
      name: "no-cross-layer-skips",
      comment: "Only pi/ may skip layers. All other layers follow the strict chain.",
      severity: "error",
      from: { path: "^(extension-src/pi-subagents/shared/|extension-src/pi-subagents/domain/|extension-src/pi-subagents/features/|extension-src/pi-subagents/app/)" },
      to: { path: "^extension-src/pi-subagents/pi/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "default"],
    },
  },
};
