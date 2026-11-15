import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('HarmonyPandaWorkshop.maestro-harmonyos-recorder');
  assert.ok(extension, 'Development extension is available');
  const api = await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['open', 'connect', 'save', 'replay', 'stop', 'checkSyntax']) assert.ok(commands.includes(`harmonyosRecorder.${name}`));
  await vscode.commands.executeCommand('harmonyosRecorder.open');
  assert.deepEqual(api.getStatus(), { panelOpen: true, connected: false, busy: false, steps: 0 });
  const yaml = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'appId: org.example.app\n---\n- launchApp\n' });
  assert.equal(yaml.languageId, 'yaml');
  await vscode.commands.executeCommand('harmonyosRecorder.stop');
  assert.equal(api.getStatus().connected, false);
  console.log('PASS: extension activation, command registration, Webview creation, YAML language, and stop. No device operations.');

  const distribution = process.env.MAESTRO_TEST_CLI_DIRECTORY;
  if (!distribution) return;
  const workspace = vscode.workspace.workspaceFolders![0].uri;
  const settings = vscode.workspace.getConfiguration('harmonyosRecorder', workspace);
  const previousCli = settings.inspect<string>('cliDirectory')?.workspaceValue;
  const previousOnSave = settings.inspect<boolean>('checkSyntaxOnSave')?.workspaceValue;
  const file = await fs.mkdtemp(path.join(workspace.fsPath, 'maestro-syntax-'));
  const uri = vscode.Uri.file(path.join(file, 'flow.yaml'));
  try {
    await settings.update('cliDirectory', distribution, vscode.ConfigurationTarget.Workspace);
    await settings.update('checkSyntaxOnSave', true, vscode.ConfigurationTarget.Workspace);
    await fs.writeFile(uri.fsPath, 'appId: org.example.app\n---\n- launchApp\n');
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const replace = async (flow: string) => {
      assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), flow)), true);
    };
    const problems = () => vscode.languages.getDiagnostics(uri).filter(item => item.source === 'Maestro');
    await replace('appId: org.example.app\n---\n- unknownMaestroCommand\n');
    assert.equal(await document.save(), true);
    const deadline = Date.now() + 30000;
    while (!problems().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(problems()[0]?.range.start.line, 2);
    assert.match(problems()[0].message, /unknownMaestroCommand/);

    await replace('appId: org.example.app\n---\n- tap');
    assert.equal(problems().length, 0);
    let items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(2, 5));
    assert.ok(items?.items.some(item => item.label === 'tapOn'));
    await replace('appId: org.example.app\n---\n- tapOn:\n    id: login\n    ');
    items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(4, 4));
    assert.ok(items?.items.some(item => item.label === 'text'));
    assert.ok(!items?.items.some(item => item.label === 'id' && item.detail === 'Maestro'));
    await replace('appId: org.example.app\n---\n- launchApp\n');
    assert.equal(await document.save(), true);
  } finally {
    await settings.update('checkSyntaxOnSave', previousOnSave, vscode.ConfigurationTarget.Workspace);
    await settings.update('cliDirectory', previousCli, vscode.ConfigurationTarget.Workspace);
    await fs.rm(uri.fsPath, { force: true });
    await fs.rmdir(file);
  }
  console.log('PASS: real Maestro CLI syntax diagnostics on save, stale diagnostic removal, and YAML completions.');
}
