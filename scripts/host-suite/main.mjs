import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { preflight, plans, runStep, platformExclusionsFor } from './suite.mjs';

const { values } = parseArgs({ options: Object.fromEntries([
  'project', 'powershell', 'java-home', 'bash', 'cli', 'original-cli', 'gradle-home', 'gradle-user-home', 'simulator-cache',
  'test-temp', 'output', 'code', 'step-timeout-seconds'].map(name => [name, { type: 'string' }]).concat([
    ['group', { type: 'string', multiple: true }], ['check-only', { type: 'boolean' }]])) });
const output = path.resolve(values.output ?? path.join(values.project ?? '.', 'artifacts/host-suite', randomUUID()));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Never overwrite a previous run.
const summaryPath = path.join(output, 'summary.json');
const summary = { protocol: 'maestro.harmonyos.host-suite', schemaVersion: 1, status: 'preflight',
  startedAt: new Date().toISOString(), deviceCommands: false, selectedGroups: values.group ?? ['All'], platformExclusions: [], steps: [], error: null };
async function save() { await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n'); }
await save();
try {
  const config = await preflight({ project: values.project, powershell: values.powershell, groups: values.group,
    javaHome: values['java-home'] ?? process.env.JAVA_HOME, bash: values.bash, cli: values.cli, originalCli: values['original-cli'],
    gradleHome: values['gradle-home'], gradleUserHome: values['gradle-user-home'], simulatorCache: values['simulator-cache'],
    testTemp: values['test-temp'], code: values.code });
  summary.selectedGroups = config.groups; summary.tools = config; summary.plan = await plans(config, output);
  summary.platformExclusions = platformExclusionsFor(config.groups);
  if (values['step-timeout-seconds'] !== undefined) {
    const seconds = Number(values['step-timeout-seconds']);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 7200) throw Error('StepTimeoutSeconds must be 1..7200.');
    for (const step of summary.plan) step.timeoutMs = seconds * 1000;
  }
  for (const step of summary.plan) for (const argument of step.args) {
    if (/\.(?:ps1|java|gradle)$/.test(argument) && !(await fs.stat(argument)).isFile()) throw Error('Missing test source: ' + argument);
  }
  const environment = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_HARMONYOS_HDC: path.join(output, 'no-hdc.exe'), MAESTRO_HARMONYOS_RECORDING: 'off',
    CI_TEST_POWERSHELL: config.powershell, TEST_POWERSHELL_PATH: config.powershell, MAESTRO_TEST_TEMP: config.temp,
    AGENT_BUNDLE_PWSH: config.powershell,
    MAESTRO_TEST_JAVA: config.java ?? '', MAESTRO_TEST_CLI: config.cli ?? '', MAESTRO_TEST_BASH: config.bash ?? '',
    MAESTRO_TEST_ORIGINAL_CLI: config.originalCli ?? '', MAESTRO_TEST_POSIX_SHELL: config.bash ?? '',
    PATH: path.dirname(process.execPath) + path.delimiter + path.dirname(config.powershell) + path.delimiter + process.env.PATH };
  if (config.javaHome) environment.JAVA_HOME = config.javaHome;
  if (config.gradleUserHome) environment.GRADLE_USER_HOME = config.gradleUserHome;
  if (config.code) environment.VSCODE_EXECUTABLE_PATH = config.code;
  await fs.mkdir(config.temp, { recursive: true });
  if (values['check-only']) { summary.status = 'ready'; summary.testsExecuted = false; }
  else {
    summary.status = 'running'; summary.testsExecuted = true; await save();
    for (const step of summary.plan) {
      console.log('Running ' + step.group + ': ' + step.id);
      const result = await runStep(step, output, environment); summary.steps.push(result); await save();
      if (result.status !== 'passed') throw Error('Required step failed or skipped tests: ' + step.id + '. See saved logs.');
    }
    summary.status = 'passed';
  }
} catch (error) { summary.status = 'failed'; summary.error = error.message; process.exitCode = 1; }
finally {
  summary.finishedAt = new Date().toISOString();
  summary.stepCounts = { passed: summary.steps.filter(step => step.status === 'passed').length,
    failed: summary.steps.filter(step => step.status === 'failed').length, notExecuted: (summary.plan?.length ?? 0) - summary.steps.length };
  summary.testCounts = summary.steps.reduce((total, step) => {
    if (step.counts) for (const key of Object.keys(total)) total[key] += step.counts[key]; return total;
  }, { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  summary.testCountScope = 'TAP and JUnit only; PowerShell assertion counts are retained in each step log.';
  await save(); console.log(JSON.stringify({ status: summary.status, stepCounts: summary.stepCounts, testCounts: summary.testCounts, error: summary.error, summaryPath }));
}
