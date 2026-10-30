import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, canonical, hashFile, key, requireValue, samePath } from './io.mjs';
import { readMetadata } from '../ci/snapshot-build.mjs';

const execute = promisify(execFile);

export async function javaExecutable(environment) {
  if (environment.JAVA_HOME) return path.resolve(environment.JAVA_HOME, 'bin/java.exe');
  const { stdout } = await execute('where.exe', ['java.exe'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  const file = stdout.trim().split(/\r?\n/)[0];
  requireValue(file && path.isAbsolute(file), 'A direct JDK 17+ Java executable is required; configure JAVA_HOME.');
  return file;
}

/** Parse frozen Flow inputs with the installed Maestro reader without executing commands or scripts. */
export async function inspectFlows(projectRoot, sourceRoot, flows, sources, outputDirectory, environment = process.env) {
  const java = await javaExecutable(environment), library = path.join(projectRoot, '.upstream/maestro/maestro-cli/build/install/maestro/lib');
  const helper = path.join(projectRoot, 'scripts/ci/InspectFlows.java');
  const classpath = (await fs.readdir(library)).filter(name => /\.jar$/i.test(name)).sort().map(name => path.join(library, name));
  const files = [];
  for (const file of [java, helper, ...classpath]) files.push({ path: file, sha256: await hashFile(file) });
  const requestPath = path.join(outputDirectory, 'static-request.json'), responsePath = path.join(outputDirectory, 'static-flows.json');
  await atomicJson(requestPath, { schemaVersion: 1, sourceRoot, flows: flows.map(({ path, name }) => ({ path, name })), sources }, true);
  let stdout = '', stderr = '', failure = null;
  try {
    ({ stdout, stderr } = await execute(java, ['-Dfile.encoding=UTF-8', '--class-path', path.join(library, '*'), helper, requestPath, responsePath],
      { cwd: projectRoot, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; failure = error; }
  const stdoutPath = path.join(outputDirectory, 'static-parser.stdout.log'), stderrPath = path.join(outputDirectory, 'static-parser.stderr.log');
  await fs.writeFile(stdoutPath, stdout, { flag: 'wx' }); await fs.writeFile(stderrPath, stderr, { flag: 'wx' });
  requireValue(!failure, 'Static Maestro parsing failed before dispatch; see static-parser.stderr.log. ' + (failure?.message ?? ''));
  const parsed = await readMetadata(responsePath), value = parsed.value, sourceMap = new Map(sources.map(file => [key(file.path), file.sha256]));
  requireValue(value.protocol === 'maestro.harmonyos.ci-static-flows' && value.schemaVersion === 1 &&
    canonical(value.flows?.map(flow => ({ path: key(flow.path), name: flow.name }))) === canonical(flows.map(flow => ({ path: key(flow.path), name: flow.name }))) &&
    Array.isArray(value.dependencies), 'Static parser returned another Flow set.');
  for (const dependency of value.dependencies) requireValue(typeof dependency.path === 'string' &&
    sourceMap.get(key(dependency.path)) === dependency.sha256 && ['yaml', 'script'].includes(dependency.kind), 'A parsed dependency is outside the frozen YAML/JS source set.');
  for (const flow of flows) requireValue(value.dependencies.some(dependency => samePath(dependency.path, flow.path)), 'Static parser omitted a top-level source.');
  for (const file of files) requireValue(await hashFile(file.path) === file.sha256, 'Static parser implementation changed while reading inputs.');
  return { javaPath: java, libraryDirectory: library, classpath, implementationFiles: files,
    evidenceFiles: await Promise.all([requestPath, responsePath, stdoutPath, stderrPath].map(async file => ({ path: file, sha256: await hashFile(file) }))),
    dependencies: value.dependencies, scriptsExecuted: false };
}
