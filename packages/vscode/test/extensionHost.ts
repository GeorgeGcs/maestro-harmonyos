import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('HarmonyPandaWorkshop.maestro-harmonyos-recorder');
  assert.ok(extension, 'Development extension is available');
  const api = await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['open', 'connect', 'save', 'replay', 'stop']) assert.ok(commands.includes(`harmonyosRecorder.${name}`));
  await vscode.commands.executeCommand('harmonyosRecorder.open');
  assert.deepEqual(api.getStatus(), { panelOpen: true, connected: false, busy: false, steps: 0 });
  const yaml = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'appId: org.example.app\n---\n- launchApp\n' });
  assert.equal(yaml.languageId, 'yaml');
  await vscode.commands.executeCommand('harmonyosRecorder.stop');
  assert.equal(api.getStatus().connected, false);
  console.log('PASS: extension activation, command registration, Webview creation, YAML language, and stop. No device operations.');
}
