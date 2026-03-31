#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const HELP_TEXT = `vendored ci-autofix runner

Environment:
  GITHUB_TOKEN
  CI_AUTOFIX_SOURCE_RUN_ID
  CI_AUTOFIX_CONFIG (default: ci-autofix.config.json)
`;

function parseBoolean(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function sanitizeFileSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function loadProjectConfig() {
  const configPath = path.resolve(
    process.env.CI_AUTOFIX_CONFIG?.trim() || "ci-autofix.config.json",
  );
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);

  if (!config.project?.workflowName || !config.project?.repository) {
    throw new Error("Config needs project.workflowName and project.repository");
  }
  if (!Array.isArray(config.validation) || config.validation.length === 0) {
    throw new Error("Config validation must be a non-empty array");
  }

  return config;
}

function createRecorder(attemptDir) {
  const operationLogPath = path.join(attemptDir, "operation-log.jsonl");
  const summary = {
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    repository: null,
    sourceRunId: null,
    sourceRunUrl: null,
    branch: null,
    headSha: null,
    reason: null,
    attemptCountBeforeRun: 0,
    failingJobs: [],
    validationResults: [],
    codexExitCode: null,
    commitSha: null,
    prComments: [],
  };

  return {
    summary,
    async event(type, message, details = null) {
      console.log(`[ci-autofix] ${message}`);
      await appendFile(
        operationLogPath,
        `${JSON.stringify({ at: nowIso(), type, message, details })}\n`,
        "utf8",
      );
    },
  };
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdinText = "",
    stdoutFile = "",
    stderrFile = "",
    allowFailure = false,
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "pipe" });
    const stdout = [];
    const stderr = [];

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", async (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");

      if (stdoutFile) {
        await writeFile(stdoutFile, out, "utf8");
      }
      if (stderrFile) {
        await writeFile(stderrFile, err, "utf8");
      }

      if (code !== 0 && !allowFailure) {
        reject(
          Object.assign(
            new Error(`Command failed: ${command} ${args.join(" ")} (${code})`),
            { stdout: out, stderr: err, code },
          ),
        );
        return;
      }

      resolve({
        code: code ?? 0,
        stdout: out,
        stderr: err,
      });
    });
  });
}

async function githubRequest(config, pathname, init = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${config.project.repository}${pathname}`,
    {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${getRequiredEnv("GITHUB_TOKEN")}`,
        "User-Agent": "team-ci-autofix",
        ...init.headers,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} ${response.statusText}: ${pathname}\n${body}`,
    );
  }

  return response;
}

function buildPrompt(config, run, failingJobs, attemptDir) {
  const failureSummary = failingJobs
    .map(
      (job) =>
        `## ${job.name}\n- Job id: ${job.id}\n- Log file: ${job.logPath}\n- Failure snippet:\n\`\`\`\n${job.failureSnippet}\n\`\`\``,
    )
    .join("\n\n");
  const validationCommands = config.validation
    .map((item) => `- ${item.command}`)
    .join("\n");
  const appendix = config.codex?.promptAppendix?.trim() || "";

  return `你正在处理一次 GitHub Actions CI 自动修复任务。

仓库信息:
- repository: ${config.project.repository}
- branch: ${run.head_branch}
- failing workflow run id: ${run.id}
- failing workflow url: ${run.html_url}
- failing workflow name: ${run.name}
- target sha: ${run.head_sha}
- audit log directory: ${attemptDir}

要求:
- 只修复当前 CI 失败直接相关的问题。
- 不要提交 commit，也不要 push。
- 不要修改 GitHub secrets、runner、权限策略或与 CI 无关的业务语义。
- 保持修复范围尽量小，不要做无关重构。

当前失败 job:

${failureSummary}

父脚本稍后会统一执行这些验证命令:
${validationCommands}

${appendix}
`;
}

function getFailureSnippet(logText) {
  const lines = logText.split("\n").filter(Boolean);
  const tail = lines.slice(-80).join("\n").trim();
  return tail.length <= 4000 ? tail : tail.slice(tail.length - 4000);
}

function countConsecutiveAutofixCommits(logOutput, commitPrefix) {
  const lines = logOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let count = 0;
  for (const line of lines) {
    if (!line.startsWith(commitPrefix)) {
      break;
    }
    count += 1;
  }
  return count;
}

function buildSummaryMarkdown(summary) {
  const jobs = summary.failingJobs.map((job) => `- ${job.name} (#${job.id})`).join("\n") || "- none";
  const validations =
    summary.validationResults
      .map(
        (item) =>
          `- ${item.name}: ${item.passed ? "passed" : "failed"} (${item.command})`,
      )
      .join("\n") || "- none";

  return `# CI Autofix Summary

- status: ${summary.status}
- repository: ${summary.repository ?? "unknown"}
- source run id: ${summary.sourceRunId ?? "unknown"}
- source run url: ${summary.sourceRunUrl ?? "unknown"}
- branch: ${summary.branch ?? "unknown"}
- head sha: ${summary.headSha ?? "unknown"}
- reason: ${summary.reason ?? "n/a"}
- commit sha: ${summary.commitSha ?? "n/a"}

## Failing Jobs

${jobs}

## Validation Results

${validations}
`;
}

async function postPullRequestComment(config, run, recorder) {
  if (!parseBoolean(String(config.logging?.commentOnPr ?? true), true)) {
    return;
  }

  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  for (const pr of pullRequests) {
    const body = [
      "CI 自动修复任务已执行。",
      "",
      `- 原始 CI Run: ${recorder.summary.sourceRunUrl}`,
      `- 当前结果: ${recorder.summary.status}`,
      `- 原因: ${recorder.summary.reason ?? "n/a"}`,
      `- 提交: ${recorder.summary.commitSha ?? "n/a"}`,
    ].join("\n");

    await githubRequest(config, `/issues/${pr.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    recorder.summary.prComments.push({ number: pr.number, status: "posted" });
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  const config = await loadProjectConfig();
  const sourceRunId = getRequiredEnv("CI_AUTOFIX_SOURCE_RUN_ID");
  const logRoot = path.resolve(
    process.env.CI_AUTOFIX_LOG_ROOT?.trim() ||
      config.logging?.rootDir ||
      "logs/ci-autofix",
  );
  const sourceRunRoot = path.join(logRoot, sourceRunId);
  const attemptDir = path.join(
    sourceRunRoot,
    `autofix-${sanitizeFileSegment(process.env.GITHUB_RUN_ID?.trim() || `local-${Date.now()}`)}`,
  );

  await mkdir(attemptDir, { recursive: true });
  await writeFile(
    path.join(sourceRunRoot, "latest-attempt.txt"),
    `${path.basename(attemptDir)}\n`,
    "utf8",
  );

  const recorder = createRecorder(attemptDir);
  recorder.summary.repository = config.project.repository;
  recorder.summary.sourceRunId = sourceRunId;

  const finalize = async () => {
    recorder.summary.finishedAt = nowIso();
    await writeFile(
      path.join(attemptDir, "summary.json"),
      `${JSON.stringify(recorder.summary, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(attemptDir, "summary.md"),
      buildSummaryMarkdown(recorder.summary),
      "utf8",
    );
  };

  try {
    const run = await (
      await githubRequest(config, `/actions/runs/${sourceRunId}`)
    ).json();
    recorder.summary.sourceRunUrl = run.html_url;
    recorder.summary.branch = run.head_branch;
    recorder.summary.headSha = run.head_sha;
    await writeFile(
      path.join(attemptDir, "workflow-run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
      "utf8",
    );

    if (run.name !== (process.env.CI_AUTOFIX_WORKFLOW_NAME || config.project.workflowName)) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = `workflow name mismatch: ${run.name}`;
      await finalize();
      return;
    }
    if (run.conclusion === "success") {
      recorder.summary.status = "completed";
      recorder.summary.reason = "source CI already passed";
      await finalize();
      return;
    }
    if (run.conclusion !== "failure") {
      recorder.summary.status = "skipped";
      recorder.summary.reason = `unsupported conclusion: ${run.conclusion}`;
      await finalize();
      return;
    }
    if (run.head_repository?.full_name !== config.project.repository) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = "head repository differs from base repository";
      await finalize();
      return;
    }

    const allowed = new RegExp(
      process.env.CI_AUTOFIX_ALLOWED_BRANCH_REGEX ||
        config.git?.allowedBranchRegex ||
        ".*",
    );
    const protectedRegex = new RegExp(
      process.env.CI_AUTOFIX_PROTECTED_BRANCH_REGEX ||
        config.git?.protectedBranchRegex ||
        "^(main|master|release\\/.*)$",
    );

    if (!allowed.test(run.head_branch) || protectedRegex.test(run.head_branch)) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = `branch blocked: ${run.head_branch}`;
      await finalize();
      return;
    }

    await runCommand("git", ["fetch", "origin", run.head_branch, "--prune", "--depth", "20"], {
      stdoutFile: path.join(attemptDir, "git-fetch.stdout.log"),
      stderrFile: path.join(attemptDir, "git-fetch.stderr.log"),
    });
    const remoteHead = (
      await runCommand("git", ["rev-parse", `origin/${run.head_branch}`])
    ).stdout.trim();
    if (remoteHead !== run.head_sha) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = `stale workflow run: ${remoteHead} != ${run.head_sha}`;
      await finalize();
      return;
    }

    const recentSubjects = await runCommand(
      "git",
      [
        "log",
        `origin/${run.head_branch}`,
        "--max-count",
        String((config.git?.maxAttempts ?? 2) + 3),
        "--pretty=%s",
      ],
    );
    recorder.summary.attemptCountBeforeRun = countConsecutiveAutofixCommits(
      recentSubjects.stdout,
      config.git?.commitPrefix || "fix(ci): auto-repair",
    );
    if (recorder.summary.attemptCountBeforeRun >= (config.git?.maxAttempts ?? 2)) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = "reached max autofix attempts";
      await finalize();
      return;
    }

    const jobsPayload = await (
      await githubRequest(config, `/actions/runs/${sourceRunId}/jobs?per_page=100`)
    ).json();
    await writeFile(
      path.join(attemptDir, "jobs.json"),
      `${JSON.stringify(jobsPayload, null, 2)}\n`,
      "utf8",
    );

    const failingJobs = [];
    for (const job of jobsPayload.jobs ?? []) {
      if (job.conclusion !== "failure") {
        continue;
      }
      const logText = await (
        await githubRequest(config, `/actions/jobs/${job.id}/logs`)
      ).text();
      const logPath = path.join(
        attemptDir,
        `job-${job.id}-${sanitizeFileSegment(job.name)}.log`,
      );
      await writeFile(logPath, logText, "utf8");
      const record = {
        id: job.id,
        name: job.name,
        logPath,
        failureSnippet: getFailureSnippet(logText),
      };
      recorder.summary.failingJobs.push({ id: job.id, name: job.name });
      failingJobs.push(record);
    }

    if (failingJobs.length === 0) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = "no failing GitHub Actions jobs found";
      await finalize();
      return;
    }

    await runCommand("git", ["config", "user.name", "github-actions[bot]"]);
    await runCommand("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);

    const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
    if (apiKey) {
      await runCommand(config.codex?.bin || "codex", ["login", "--with-api-key"], {
        stdinText: apiKey,
        stdoutFile: path.join(attemptDir, "codex-login.stdout.log"),
        stderrFile: path.join(attemptDir, "codex-login.stderr.log"),
      });
    }

    const prompt = buildPrompt(config, run, failingJobs, attemptDir);
    await writeFile(path.join(attemptDir, "codex-prompt.md"), prompt, "utf8");

    const codexArgs = [
      "exec",
      "-C",
      process.cwd(),
      "--json",
      "-o",
      path.join(attemptDir, "codex-last-message.md"),
    ];
    if (config.codex?.model) {
      codexArgs.push("-m", config.codex.model);
    }
    if (config.codex?.dangerouslyBypassSandbox ?? true) {
      codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      codexArgs.push("-s", "danger-full-access");
    }
    codexArgs.push("-");

    const codexResult = await runCommand(config.codex?.bin || "codex", codexArgs, {
      stdinText: prompt,
      stdoutFile: path.join(attemptDir, "codex-events.jsonl"),
      stderrFile: path.join(attemptDir, "codex-stderr.log"),
      allowFailure: true,
    });
    recorder.summary.codexExitCode = codexResult.code;
    if (codexResult.code !== 0) {
      recorder.summary.status = "failed";
      recorder.summary.reason = `codex exec exited with code ${codexResult.code}`;
      await finalize();
      return;
    }

    for (const validation of config.validation) {
      const result = await runCommand("zsh", ["-lc", validation.command], {
        stdoutFile: path.join(
          attemptDir,
          `${sanitizeFileSegment(validation.name)}.stdout.log`,
        ),
        stderrFile: path.join(
          attemptDir,
          `${sanitizeFileSegment(validation.name)}.stderr.log`,
        ),
        allowFailure: true,
      });
      const passed = result.code === 0;
      recorder.summary.validationResults.push({
        name: validation.name,
        command: validation.command,
        passed,
      });
      if (!passed) {
        recorder.summary.status = "failed";
        recorder.summary.reason = `validation failed: ${validation.name}`;
        await finalize();
        return;
      }
    }

    const repoStatus = await runCommand("git", ["status", "--porcelain"]);
    if (!repoStatus.stdout.trim()) {
      recorder.summary.status = "completed";
      recorder.summary.reason = "validation passed but no file changes were produced";
      await finalize();
      return;
    }

    const remoteHeadBeforePush = (
      await runCommand("git", ["rev-parse", `origin/${run.head_branch}`])
    ).stdout.trim();
    if (remoteHeadBeforePush !== run.head_sha) {
      recorder.summary.status = "skipped";
      recorder.summary.reason = "branch advanced while autofix was running";
      await finalize();
      return;
    }

    await runCommand("git", ["add", "-A"]);
    await runCommand("git", ["commit", "-m", `${config.git?.commitPrefix || "fix(ci): auto-repair"} run ${sourceRunId}`], {
      stdoutFile: path.join(attemptDir, "git-commit.stdout.log"),
      stderrFile: path.join(attemptDir, "git-commit.stderr.log"),
    });
    recorder.summary.commitSha = (
      await runCommand("git", ["rev-parse", "HEAD"])
    ).stdout.trim();
    await runCommand("git", ["push", "origin", `HEAD:${run.head_branch}`], {
      stdoutFile: path.join(attemptDir, "git-push.stdout.log"),
      stderrFile: path.join(attemptDir, "git-push.stderr.log"),
    });

    recorder.summary.status = "pushed";
    recorder.summary.reason = "autofix commit pushed successfully";
    await postPullRequestComment(config, run, recorder);
    await finalize();
  } catch (error) {
    recorder.summary.status = "failed";
    recorder.summary.reason =
      error instanceof Error ? error.message : "unknown error";
    await finalize();
    process.exitCode = 1;
  }
}

await main();
