import * as vscode from 'vscode';

const commands: Record<string, string> = {
  launchApp: '', tapOn: ':', assertVisible: ':', assertNotVisible: ':', inputText: ': ',
  swipe: ':', scrollUntilVisible: ':', takeScreenshot: ': ', runFlow: ': ', back: '',
  waitForAnimationToEnd: '',
};
const parameters: Record<string, readonly string[]> = {
  tapOn: ['id', 'text', 'point', 'index', 'optional'],
  assertVisible: ['id', 'text', 'index', 'optional'],
  assertNotVisible: ['id', 'text', 'index', 'optional'],
  swipe: ['direction', 'start', 'end', 'duration'],
  scrollUntilVisible: ['element', 'direction', 'timeout'],
  runFlow: ['file', 'when', 'env'],
};

export function registerMaestroCompletion(): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider({ language: 'yaml', scheme: 'file' }, {
    provideCompletionItems(document, position) {
      const line = document.lineAt(position.line).text;
      const prefix = line.slice(0, position.character);
      const command = /^-\s+([A-Za-z]*)$/.exec(prefix);
      const parameter = /^( {2,})([A-Za-z]*)$/.exec(prefix);
      if ((!command && !parameter) || line.slice(position.character).trim()) return;
      const source = document.getText(new vscode.Range(0, 0, position.line, 0));
      const separator = /^---[ \t]*(?:#.*)?\r?$/m.exec(source);
      if (!separator || !/^appId[ \t]*:/m.test(source.slice(0, separator.index))) return;

      const word = command?.[1] ?? parameter?.[2] ?? '';
      const range = new vscode.Range(position.translate(0, -word.length), position);
      const names = command ? Object.keys(commands) : parameterNames(source, parameter![1].length);
      return names.filter(name => name.toLowerCase().startsWith(word.toLowerCase())).map(name => {
        const item = new vscode.CompletionItem(name, command ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Property);
        item.range = range;
        item.insertText = command ? name + commands[name] : `${name}: `;
        item.detail = 'Maestro';
        return item;
      });
    },
  }, ' ', '-');
}

function parameterNames(source: string, indent: number): string[] {
  const lines = source.split(/\r?\n/);
  const present = new Set<string>();
  while (lines.length && !lines.at(-1)?.startsWith('- ')) {
    const line = lines.pop()!;
    if (line.trim() && !line.startsWith(' ')) return [];
    // An empty mapping key opens a nested block. Offer no step parameters inside it.
    if (/^ +[\w]+:\s*(?:#.*)?$/.test(line) && line.length - line.trimStart().length < indent) return [];
    const key = /^( +)([A-Za-z]+):/.exec(line);
    if (key && key[1].length === indent) present.add(key[2]);
  }
  const step = /^- ([A-Za-z]+):\s*(?:#.*)?$/.exec(lines.at(-1) ?? '');
  if (!step) return [];
  const options = parameters[step[1]] ?? [];
  return options.filter(name => !present.has(name));
}
