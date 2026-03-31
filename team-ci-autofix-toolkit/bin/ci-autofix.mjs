#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  initProject,
  loadConfigFile,
  renderWorkflow,
  validateConfig,
  writeWorkflowFile,
} from "../src/toolkit.mjs";

const HELP_TEXT = `team-ci-autofix

Commands:
  init <repo-dir> [--force]
  validate-config <config-path>
  render-workflow <config-path> [--output <path>]
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP_TEXT);
    return;
  }

  if (command === "init") {
    const repoDir = rest[0];
    if (!repoDir) {
      fail("Missing <repo-dir> for init");
    }

    const force = rest.includes("--force");
    const result = await initProject(path.resolve(repoDir), { force });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "validate-config") {
    const configPath = rest[0];
    if (!configPath) {
      fail("Missing <config-path> for validate-config");
    }

    const config = await loadConfigFile(path.resolve(configPath));
    validateConfig(config);
    console.log(
      JSON.stringify(
        {
          ok: true,
          project: config.project.repository,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "render-workflow") {
    const configPath = rest[0];
    if (!configPath) {
      fail("Missing <config-path> for render-workflow");
    }

    const outputIndex = rest.indexOf("--output");
    const outputPath =
      outputIndex >= 0 && rest[outputIndex + 1]
        ? path.resolve(rest[outputIndex + 1])
        : "";
    const config = await loadConfigFile(path.resolve(configPath));
    validateConfig(config);
    const workflow = renderWorkflow(config);

    if (outputPath) {
      await writeWorkflowFile(outputPath, workflow);
      console.log(outputPath);
      return;
    }

    process.stdout.write(workflow);
    return;
  }

  fail(`Unknown command: ${command}`);
}

await main();
