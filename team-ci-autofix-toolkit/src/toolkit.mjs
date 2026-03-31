import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TOOLKIT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

export async function loadConfigFile(configPath) {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be an object");
  }

  if (!config.project?.repository || !config.project?.workflowName) {
    throw new Error("Config project.repository and project.workflowName are required");
  }

  if (!Array.isArray(config.runner?.labels) || config.runner.labels.length === 0) {
    throw new Error("Config runner.labels must be a non-empty array");
  }

  if (!Array.isArray(config.validation) || config.validation.length === 0) {
    throw new Error("Config validation must be a non-empty array");
  }

  for (const item of config.validation) {
    if (!item?.name || !item?.command) {
      throw new Error("Each validation entry needs name and command");
    }
  }
}

function parseRepoSlug(remoteUrl) {
  const sshMatch = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return sshMatch?.[1] ?? "";
}

async function runCommand(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `Command failed: ${command} ${args.join(" ")}\n${out}\n${err}`,
          ),
        );
        return;
      }
      resolve(out.trim());
    });
  });
}

async function detectRepositorySlug(repoDir) {
  try {
    const remoteUrl = await runCommand(
      "git",
      ["remote", "get-url", "origin"],
      repoDir,
    );
    return parseRepoSlug(remoteUrl);
  } catch {
    return "owner/repo";
  }
}

function getDefaultConfig(repository) {
  return {
    project: {
      repository,
      workflowName: "CI",
    },
    runner: {
      labels: ["self-hosted", "macOS", "ARM64", "team-ci"],
    },
    runtime: {
      nodeVersion: "24.14.0",
      pnpmVersion: "10.29.2",
    },
    git: {
      allowedBranchRegex: ".*",
      protectedBranchRegex: "^(main|master|release\\/.*)$",
      maxAttempts: 2,
      commitPrefix: "fix(ci): auto-repair",
    },
    logging: {
      rootDir: "logs/ci-autofix",
      commentOnPr: true,
    },
    codex: {
      bin: "codex",
      model: "",
      dangerouslyBypassSandbox: true,
      promptAppendix: "",
    },
    validation: [
      {
        name: "install",
        command: "pnpm install --frozen-lockfile",
      },
      {
        name: "typecheck",
        command: "pnpm typecheck",
      },
      {
        name: "build",
        command: "pnpm build",
      },
    ],
  };
}

export function renderWorkflow(config) {
  validateConfig(config);

  const labels = config.runner.labels.map((label) => `      - ${label}`).join("\n");
  const nodeVersion = config.runtime?.nodeVersion || "24.14.0";
  const pnpmVersion = config.runtime?.pnpmVersion || "10.29.2";
  const allowedBranchRegex =
    config.git?.allowedBranchRegex || ".*";
  const protectedBranchRegex =
    config.git?.protectedBranchRegex || "^(main|master|release\\/.*)$";
  const maxAttempts = String(config.git?.maxAttempts ?? 2);
  const commentOnPr = String(config.logging?.commentOnPr ?? true);
  const logRoot = config.logging?.rootDir || "logs/ci-autofix";

  return `name: CI Autofix

on:
  workflow_run:
    workflows: ["${config.project.workflowName}"]
    types:
      - completed

permissions:
  actions: read
  contents: write
  pull-requests: write

concurrency:
  group: ci-autofix-\${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: true

jobs:
  autofix:
    name: Autofix Failed CI
    if: >-
      \${{
        github.event.workflow_run.conclusion == 'failure' &&
        github.event.workflow_run.head_repository.full_name == github.repository
      }}
    runs-on:
${labels}
    timeout-minutes: 90
    env:
      CI: true
      HUSKY: 0
      CI_AUTOFIX_SOURCE_RUN_ID: \${{ github.event.workflow_run.id }}
      CI_AUTOFIX_CONFIG: ci-autofix.config.json
      CI_AUTOFIX_ALLOWED_BRANCH_REGEX: "${allowedBranchRegex}"
      CI_AUTOFIX_PROTECTED_BRANCH_REGEX: "${protectedBranchRegex}"
      CI_AUTOFIX_MAX_ATTEMPTS: "${maxAttempts}"
      CI_AUTOFIX_WORKFLOW_NAME: "${config.project.workflowName}"
      CI_AUTOFIX_COMMENT_ON_PR: "${commentOnPr}"
      CI_AUTOFIX_LOG_ROOT: "${logRoot}"
    steps:
      - name: Checkout head branch
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.workflow_run.head_branch }}
          fetch-depth: 0

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${pnpmVersion}
          run_install: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${nodeVersion}
          cache: pnpm

      - name: Ensure Codex CLI
        run: |
          if ! command -v codex >/dev/null 2>&1; then
            pnpm add -g @openai/codex@0.116.0
          fi
          codex --version

      - name: Run CI autofix
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: node ./tools/ci-autofix/run.mjs

      - name: Append summary
        if: always()
        run: |
          ATTEMPT_FILE="${logRoot}/\${CI_AUTOFIX_SOURCE_RUN_ID}/latest-attempt.txt"
          if [ -f "$ATTEMPT_FILE" ]; then
            ATTEMPT_NAME="$(cat "$ATTEMPT_FILE")"
            SUMMARY_PATH="${logRoot}/\${CI_AUTOFIX_SOURCE_RUN_ID}/\${ATTEMPT_NAME}/summary.md"
            if [ -f "$SUMMARY_PATH" ]; then
              cat "$SUMMARY_PATH" >> "$GITHUB_STEP_SUMMARY"
            fi
          fi

      - name: Upload autofix logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ci-autofix-\${{ github.event.workflow_run.id }}
          path: ${logRoot}/\${{ github.event.workflow_run.id }}
          if-no-files-found: warn
          retention-days: 30
`;
}

export async function writeWorkflowFile(workflowPath, workflowContent) {
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, workflowContent, "utf8");
}

export async function initProject(repoDir, { force = false } = {}) {
  const repository = await detectRepositorySlug(repoDir);
  const configPath = path.join(repoDir, "ci-autofix.config.json");
  const workflowPath = path.join(repoDir, ".github/workflows/ci-autofix.yml");
  const vendoredRunnerPath = path.join(repoDir, "tools/ci-autofix/run.mjs");

  const config = getDefaultConfig(repository);
  validateConfig(config);

  await mkdir(path.dirname(vendoredRunnerPath), { recursive: true });
  await mkdir(path.dirname(workflowPath), { recursive: true });

  const existingConfig = await fileExists(configPath);
  if (!existingConfig || force) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  await copyFile(
    path.join(TOOLKIT_ROOT, "templates/runner.mjs"),
    vendoredRunnerPath,
  );
  await writeWorkflowFile(workflowPath, renderWorkflow(config));

  return {
    ok: true,
    repository,
    files: {
      configPath,
      workflowPath,
      vendoredRunnerPath,
    },
  };
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath, "utf8");
    return true;
  } catch {
    return false;
  }
}
