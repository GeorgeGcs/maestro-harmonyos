import * as path from 'node:path';

export interface SyntaxLocation { line: number; column: number; message: string }

export function syntaxLocation(output: string, file: string, cwd: string): SyntaxLocation | undefined {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  const root = path.parse(cwd).root;
  for (const raw of lines) {
    const text = raw.trim();
    const match = /^(.*?) at (.+):(\d+):(\d+)$/.exec(text) ??
      /^(Failed to parse file): (.+):(\d+)$/.exec(text);
    if (!match) continue;
    const [, message, source, lineText, columnText = '1'] = match;
    // The pinned Maestro parser reports command errors against a synthetic root path.
    if (!path.isAbsolute(source) || (path.relative(file, source) !== '' &&
      path.relative(path.join(root, 'syntax-checker'), source) !== '')) continue;
    const line = Number(lineText), column = Number(columnText);
    if (Number.isSafeInteger(line) && line > 0 && Number.isSafeInteger(column) && column > 0) {
      return { line: line - 1, column: column - 1, message };
    }
  }
  return undefined;
}
