#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestName = '.maestro-source.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(cwd, args, binary = false) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: binary ? undefined : 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Cannot run Git: ${result.error.message}`);
  if (result.status !== 0) {
    // Do not include repository contents or credentials from Git's output.
    throw new Error(`Git ${args[0]} failed (exit ${result.status ?? 'interrupted'}). Check Git access and the pinned source; the existing directory was preserved.`);
  }
  return binary ? result.stdout : result.stdout.trim();
}

function childPath(directory, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..') ||
      /^[A-Za-z]:|^\//.test(relative)) {
    throw new Error('Source metadata contains an unsafe relative path.');
  }
  return path.join(directory, ...relative.split('/'));
}

function readSpec(directory) {
  const spec = JSON.parse(readFileSync(path.join(directory, 'source.json'), 'utf8'));
  if (spec.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(spec.commit) ||
      spec.repository !== 'https://gitcode.com/HarmonyOS_Samples/sample_in_harmonyos.git' ||
      !/^[a-f0-9]{64}$/.test(spec.licenseSha256) || spec.license !== 'Apache-2.0' ||
      !/^[a-f0-9]{64}$/.test(spec.patch?.sha256)) {
    throw new Error('source.json must identify the pinned official repository and Apache-2.0 license.');
  }
  childPath(directory, spec.licenseFile);
  childPath(directory, spec.patch?.file);
  childPath(directory, spec.patch?.target);
  return spec;
}

function inspectPinnedTree(directory, spec) {
  const entries = git(directory, ['ls-tree', '-r', '-z', spec.commit]).split('\0').filter(Boolean);
  const profiles = [];
  for (const entry of entries) {
    const match = /^(\d+) blob [a-f0-9]+\t(.+)$/.exec(entry);
    if (!match || !['100644', '100755'].includes(match[1])) {
      throw new Error('The pinned tree contains a symlink, submodule, or unsupported entry.');
    }
    const name = match[2];
    childPath(directory, name);
    if (/(^|\/)(\.git|\.idea|\.hvigor|\.ohpm|node_modules|oh_modules|build|dist)(\/|$)/i.test(name) ||
        /(^|\/)(local\.properties|\.npmrc|\.ohpmrc|\.gitmodules|\.gitattributes|\.env(?:\..*)?)$/i.test(name) ||
        /\.(p12|pfx|pem|key|cer|crt|p7b|keystore|jks)$/i.test(name)) {
      throw new Error(`The pinned tree contains a local configuration or signing file: ${name}`);
    }
    if (/(^|\/)build-profile\.json5$/.test(name)) profiles.push(name);
  }
  for (const profile of profiles) {
    const content = git(directory, ['show', `${spec.commit}:${profile}`]);
    const configs = [...content.matchAll(/["']?signingConfigs["']?\s*:\s*\[([^\]]*)\]/g)];
    if (configs.some((match) => match[1].trim() !== '') ||
        (/signingConfigs/.test(content) && configs.length !== 1) ||
        /(?:storePassword|keyPassword|storeFile|certpath)\s*["']?\s*:/i.test(content) ||
        /[A-Za-z]:[\\/]/.test(content)) {
      throw new Error(`The pinned build profile contains signing data or a developer path: ${profile}`);
    }
    if (profile === 'build-profile.json5' && configs.length !== 1) {
      throw new Error('The root build profile must have an explicit empty signingConfigs array.');
    }
  }
  if (!profiles.includes('build-profile.json5')) throw new Error('The pinned tree has no root build profile.');
  const license = git(directory, ['show', `${spec.commit}:${spec.licenseFile}`], true);
  if (sha256(license) !== spec.licenseSha256) throw new Error('The upstream license does not match source.json.');
}

function checkPrepared(directory, spec, patchFile, patchHash) {
  if (!existsSync(path.join(directory, manifestName))) {
    throw new Error('No preparation record found. Keep this directory for inspection, then move it aside before preparing a fresh app.');
  }
  const record = JSON.parse(readFileSync(path.join(directory, manifestName), 'utf8'));
  if (git(directory, ['rev-parse', 'HEAD']) !== spec.commit ||
      record.schemaVersion !== 1 || record.repository !== spec.repository || record.commit !== spec.commit ||
      record.patch?.file !== spec.patch.file || record.patch?.sha256 !== patchHash ||
      record.patch?.target !== spec.patch.target || record.licenseSha256 !== spec.licenseSha256) {
    throw new Error('The app revision or preparation record does not match the pinned source and patch.');
  }
  if (sha256(readFileSync(childPath(directory, spec.licenseFile))) !== spec.licenseSha256 ||
      sha256(readFileSync(childPath(directory, spec.patch.target))) !== record.patch.targetSha256) {
    throw new Error('The license or patched EntryAbility changed after preparation. Inspect local edits before using these example Flows.');
  }
  git(directory, ['apply', '--reverse', '--check', patchFile]);
  return { directory, commit: spec.commit, patchSha256: patchHash, checkedOnly: true };
}

// Exported for local fixture tests; the CLI always uses the adjacent source.json.
export function prepareSample({ sampleDirectory = here, localSource, checkOnly = false } = {}) {
  const directory = path.join(path.resolve(sampleDirectory), 'app');
  const spec = readSpec(sampleDirectory);
  const patchFile = childPath(path.resolve(sampleDirectory), spec.patch.file);
  const patchHash = sha256(readFileSync(patchFile));
  if (patchHash !== spec.patch.sha256) throw new Error('The local patch does not match the SHA-256 recorded in source.json.');
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new Error('app is a symbolic link. Use a regular, dedicated sample directory.');
  }
  if (checkOnly) {
    if (localSource) throw new Error('--check-only does not accept --source and never fetches files.');
    if (!existsSync(directory)) throw new Error('app does not exist. Run prepare.mjs first.');
    return checkPrepared(directory, spec, patchFile, patchHash);
  }
  if (existsSync(directory)) {
    throw new Error(`app already exists: ${directory}. Run node prepare.mjs --check-only to inspect it. To prepare again, preserve your signing settings and move app aside first; this script never overwrites it.`);
  }
  let source = spec.repository;
  if (localSource) {
    source = path.resolve(localSource);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error('--source must be a local Git checkout directory.');
    if (git(source, ['rev-parse', '--verify', `${spec.commit}^{commit}`]) !== spec.commit) {
      throw new Error('The local source does not contain the pinned commit.');
    }
  }
  mkdirSync(directory);
  // Fetch Git objects only: dirty worktree files, signing settings and local IDE state are not copied.
  git(directory, ['init', '--quiet', '--template=']);
  git(directory, ['config', 'core.autocrlf', 'false']);
  git(directory, ['config', 'core.hooksPath', '.git/disabled-hooks']);
  git(directory, ['fetch', '--quiet', '--no-tags', '--depth=1', source, spec.commit]);
  if (git(directory, ['rev-parse', 'FETCH_HEAD']) !== spec.commit) throw new Error('Fetched commit differs from the pinned revision.');
  inspectPinnedTree(directory, spec);
  git(directory, ['checkout', '--quiet', '--detach', spec.commit]);
  const patchFiles = git(directory, ['apply', '--numstat', patchFile]).split('\n');
  if (patchFiles.length !== 1 || patchFiles[0].split('\t').slice(2).join('\t') !== spec.patch.target) {
    throw new Error('The local patch must only change the declared EntryAbility.');
  }
  git(directory, ['apply', '--check', patchFile]);
  git(directory, ['apply', patchFile]);
  if (git(directory, ['diff', '--no-ext-diff', '--name-only', 'HEAD']) !== spec.patch.target) {
    throw new Error('The local patch changed files outside the declared EntryAbility.');
  }
  const record = {
    schemaVersion: 1,
    repository: spec.repository,
    commit: spec.commit,
    acquisition: localSource ? 'local-git-objects' : 'official-git-fetch',
    licenseSha256: spec.licenseSha256,
    patch: {
      file: spec.patch.file,
      sha256: patchHash,
      target: spec.patch.target,
      targetSha256: sha256(readFileSync(childPath(directory, spec.patch.target))),
    },
  };
  writeFileSync(path.join(directory, manifestName), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  const result = checkPrepared(directory, spec, patchFile, patchHash);
  return { ...result, checkedOnly: false };
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check-only') options.checkOnly = true;
    else if (argv[i] === '--source' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.localSource = argv[++i];
    else if (argv[i] === '--help') {
      console.log('Usage: node examples/hmos-code-lab/prepare.mjs [--source <local-checkout> | --check-only]\nFetches the pinned source and applies the foreground keep-awake patch. No build, signing, SDK download or device operation.');
      return;
    } else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  const result = prepareSample(options);
  console.log(`${result.checkedOnly ? 'Checked' : 'Prepared'} HMOS code lab at ${result.commit}\n${result.directory}\nOpen this project in DevEco Studio and select the phone run configuration. Device validation is still required.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`HMOS sample setup: ${error.message}`); process.exitCode = 1; }
}
