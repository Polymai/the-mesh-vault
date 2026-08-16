#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const checkPath = path.join(root, "POLYMAI_CHECKS.cjs");

try {
  if (!fs.existsSync(checkPath)) {
    console.error("Polymai report: POLYMAI_CHECKS.cjs is missing. Regenerate Polymai checks when convenient.");
    process.exit(0);
  }
  const result = childProcess.spawnSync(process.execPath, [checkPath, "--claude-report"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result.error) {
    console.error("Polymai report could not run: " + String(result.error && result.error.message || result.error));
  }
} catch (err) {
  console.error("Polymai report warning: " + String(err && err.message || err));
}

// Warn-only by design. Never block Claude from stopping.
process.exit(0);
