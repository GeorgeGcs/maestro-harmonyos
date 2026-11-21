import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { BridgeClient } from './bridge';
import { checkFlowSyntax, createRunDirectory, javaLaunch, ReplayInput, ToolSettings } from './launcher';
import { object, parseDevices, string } from './protocol';
import { RecorderSession, OperationStopped, errorMessage } from './session';
import { boundedRead, evidenceImage, localFile, logTail, replayEvidence, replayFileHash, ReplayEvidenceLink, verifiedYamlLine } from './replay-evidence';
import { InteractiveRun, RunRequest } from './interactive-run';
import { sourceSnapshot, StepSource } from './live-trace';
import { importTouchRecording, TouchLayouts } from './touch-import';
import { TouchRecording, verifyTouchIdle } from './touch-recording';
import { previewSelectors } from './selector-preview';
import { syntaxLocation } from './syntax-location';
import { registerMaestroCompletion } from './yaml-completion';

let recorder: Recorder | undefined;
export function activate(context: vscode.ExtensionContext): { getStatus(): { panelOpen: boolean; connected: boolean; busy: boolean; steps: number } } {
  recorder = new Recorder(context);
  context.subscriptions.push(recorder, registerMaestroCompletion());
  context.subscriptions.push(vscode.commands.registerCommand('harmonyosRecorder.importTouch', () => recorder!.handle(() => recorder!.pickTouchRecording())));
  context.subscriptions.push(vscode.commands.registerCommand('harmonyosRecorder.checkSyntax', () => recorder!.handle(() => recorder!.checkSyntax())));
  context.subscriptions.push(vscode.commands.registerCommand('harmonyosRecorder.checkReadiness', () => recorder!.handle(() => recorder!.checkReadiness())));
  for (const [name, action] of Object.entries({ open: () => recorder!.open(), connect: () => recorder!.connect(), save: () => recorder!.save(), replay: () => recorder!.replay(), runFile: () => recorder!.pickFlow(), rerun: () => recorder!.rerun(), stop: () => recorder!.stop() })) {
    context.subscriptions.push(vscode.commands.registerCommand(`harmonyosRecorder.${name}`, () => recorder!.handle(action)));
  }
  return { getStatus: () => recorder!.status() };
}
export async function deactivate(): Promise<void> { await recorder?.shutdown(); recorder = undefined; }

class Recorder implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private bridge: BridgeClient | undefined;
  private run?: InteractiveRun;
  private runTask?: Promise<void>;
  private evidenceLinks: ReplayEvidenceLink[] = [];
  private evidenceRequest = 0;
  private touch?: TouchRecording;
  private touchTask?: Promise<void>;
  private touchStopped = false;
  private touchStatus = '在测试设备上打开目标应用，然后开始录制。';
  private touchFlow?: RunRequest;
  private preparingRun = false;
  private preparationCancelled = false;
  private disposed = false;
  private readonly activeLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private highlightRequest = '';
  private readonly syntaxDiagnostics = vscode.languages.createDiagnosticCollection('maestro-syntax');
  private readonly syntaxChecks = new Map<string, AbortController>();
  private readonly editorListeners = [
    vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
    vscode.workspace.onDidChangeTextDocument(() => this.decorate()),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) this.clearSyntax(event.document); }),
    vscode.workspace.onDidCloseTextDocument(document => this.clearSyntax(document)),
    vscode.workspace.onDidSaveTextDocument(document => {
      const root = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!vscode.workspace.isTrusted || !root || document.uri.scheme !== 'file' ||
          !/\.ya?ml$/i.test(document.uri.fsPath) ||
          !vscode.workspace.getConfiguration('harmonyosRecorder', document.uri).get('checkSyntaxOnSave', false) ||
          !/^appId[ \t]*:/m.test(document.getText())) return;
      void this.validateSyntax(document, root.uri.fsPath).catch(error => this.output.appendLine(errorMessage(error)));
    }),
  ];
  private readonly output = vscode.window.createOutputChannel('HarmonyOS Recorder');
  private readonly session = new RecorderSession(() => this.render());
  private root: string | undefined;
  private connecting = false;
  private connectionAttempt = 0;
  constructor(private readonly context: vscode.ExtensionContext) {}

  status() { return { panelOpen: !!this.panel, connected: this.session.state.connected, busy: this.busy, steps: this.session.state.steps.length }; }
  private get busy(): boolean { return this.session.state.busy || this.connecting || this.preparingRun || !!this.run?.active || !!this.touch; }
  private trusted(): void { if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，再运行本地设备工具。'); }
  async handle(action: () => void | Promise<void>): Promise<void> {
    try { this.trusted(); await action(); }
    catch (error) { if (error instanceof OperationStopped) return; this.output.appendLine(errorMessage(error)); await vscode.window.showErrorMessage(errorMessage(error)); this.render(); }
  }
  open(): void {
    this.trusted();
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel('harmonyosRecorder', '鸿蒙流程录制', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(message => { void this.handle(() => this.message(message)); });
    this.panel.onDidChangeViewState(() => { void this.run?.syncPreview().catch(error => this.output.appendLine(errorMessage(error))); this.render(); });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      void this.run?.syncPreview().catch(error => this.output.appendLine(errorMessage(error)));
      if (!this.run?.active) void this.stop().catch(error => this.output.appendLine(errorMessage(error)));
    });
  }
  private settings(uri?: vscode.Uri): ToolSettings {
    const config = vscode.workspace.getConfiguration('harmonyosRecorder', uri);
    return { cliDirectory: config.get<string>('cliDirectory', ''), javaPath: config.get<string>('javaPath', ''),
      hdcPath: config.get<string>('hdcPath', ''), hostRecordingFfmpeg: config.get<string>('hostRecordingFfmpeg', '') };
  }
  async startTouch(): Promise<void> {
    if (this.busy) return;
    await this.prepare(async root => {
      const tools = this.settings();
      const discovery = new BridgeClient(await javaLaunch(root, tools, ['harmonyos-bridge']), text => this.output.append(text));
      let deviceId: string | undefined;
      try {
        const devices = parseDevices(await discovery.request('devices'));
        deviceId = await vscode.window.showQuickPick(devices.map(device => device.id), { placeHolder: '选择录制用的鸿蒙测试设备' });
      } finally { await discovery.dispose(); }
      if (!deviceId || this.preparationCancelled || this.disposed) return;
      if (this.run?.request.connection.deviceId === deviceId && !this.run.releaseConfirmed) {
        throw new Error('上一轮回放未确认释放设备，请先检查设备会话。');
      }
      const config = vscode.workspace.getConfiguration('harmonyosRecorder');
      const appId = await vscode.window.showInputBox({
        title: '确认当前在前台的测试应用包名',
        value: this.session.state.appId || config.get<string>('appId', ''),
        validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? null : '请输入有效的应用包名。',
      });
      if (!appId || this.preparationCancelled || this.disposed) return;
      await this.session.disconnect();
      const bridge = this.bridge;
      this.bridge = undefined;
      await bridge?.dispose();
      if (this.preparationCancelled || this.disposed) return;
      await this.recoverTouch(root, tools, deviceId);
      if (this.preparationCancelled || this.disposed) return;
      const artifactsDir = await createRunDirectory(root, 'touch');
      if (this.preparationCancelled || this.disposed) return;
      const connection = { deviceId, appId, artifactsDir,
        abilityName: config.get<string>('abilityName', '').trim() || undefined, moduleName: config.get<string>('moduleName', '') || undefined };
      this.touchStopped = false;
      this.touchFlow = undefined;
      this.touchStatus = '正在启动录制，请等面板提示。';
      const recorder = new TouchRecording(this.hdc(tools), deviceId, appId,
        () => { if (!this.touchStopped) { this.touchStatus = '正在录制，请在测试应用内点击或滑动。'; this.render(); } },
        count => { if (!this.touchStopped) { this.touchStatus = `正在录制 · 已识别 ${count} 次点击或滑动`; this.render(); } },
        error => this.output.appendLine(errorMessage(error)),
        (events, layouts) => this.archiveTouch(artifactsDir, events, layouts));
      this.touch = recorder;
      this.touchTask = (async () => {
        try {
          const result = await recorder.result;
          if (result.busy) throw new Error('设备已有录制或遗留录制文件，请检查归属后重试。');
          if (!result.released) throw new Error(result.detail ? `设备释放未确认。 ${result.detail}` : '录制进程或文件未确认清理，请检查设备后再试。');
          if (!result.started) throw new Error(result.detail ?? '录制未启动，请检查测试应用是否在前台。');
          let flow: ReturnType<typeof importTouchRecording>;
          try { flow = importTouchRecording(appId, result.events, result.layouts); }
          catch (error) {
            if (result.events.trim()) {
              throw new Error(`${errorMessage(error)} 原始记录已保存到本次产物目录，录制已释放。`);
            }
            throw new Error(`${errorMessage(error)} 录制已释放。`);
          }
          const flowPath = path.join(artifactsDir, 'touch-flow.yaml');
          await fs.writeFile(flowPath, flow.yaml, { encoding: 'utf8', flag: 'wx' });
          this.touchFlow = { root, tools, connection, input: { flowPath } };
          this.touchStatus = `已生成 ${flow.steps} 步，跳过 ${flow.skipped} 条 · 录制已释放`;
          if (!this.disposed && this.panel) await vscode.window.showTextDocument(vscode.Uri.file(flowPath), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        } catch (error) {
          this.touchStatus = errorMessage(error);
        } finally {
          this.touch = undefined;
          this.render();
        }
      })();
    });
  }
  async stopTouch(): Promise<void> {
    const recorder = this.touch;
    if (!recorder || this.touchStopped) return;
    this.touchStopped = true;
    this.touchStatus = '正在停止并读取录制结果。';
    this.render();
    try { await recorder.stop(); }
    catch (error) {
      if (this.touch !== recorder) return;
      this.touchStopped = false;
      this.touchStatus = '停止请求未确认，设备端录制到期后会自动停止。';
      this.render();
      throw error;
    }
  }
  async replayTouch(): Promise<void> {
    const request = this.touchFlow;
    if (!request) return;
    const file = request.input.flowPath;
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.fsPath === file)) {
      throw new Error('请先保存对录制 YAML 的修改。');
    }
    await this.prepare(async () => request);
  }
  private hdc(tools: ToolSettings): string {
    return tools.hdcPath || process.env.MAESTRO_HARMONYOS_HDC || 'hdc';
  }
  private async archiveTouch(directory: string, events: Buffer, layouts: TouchLayouts): Promise<void> {
    await fs.writeFile(path.join(directory, 'uitest-record.log'), events, { flag: 'wx', flush: true });
    if (layouts.initial || Object.keys(layouts.after).length) {
      await fs.writeFile(path.join(directory, 'uitest-layouts.json'), JSON.stringify({
        schemaVersion: 1, recordSha256: replayFileHash(events), layouts,
      }), { flag: 'wx', flush: true });
    }
  }
  private async recoverTouch(root: string, tools: ToolSettings, deviceId: string): Promise<void> {
    let savedFile: string | undefined;
    const result = await verifyTouchIdle(this.hdc(tools), deviceId, async (events, layouts) => {
      const directory = await createRunDirectory(root, 'touch-recovery');
      savedFile = path.join(directory, 'uitest-record.log');
      await this.archiveTouch(directory, events, layouts);
      this.output.appendLine(`恢复的 UITest 记录：${savedFile}`);
    });
    if (!result.recovered) return;
    this.touchStatus = savedFile ? '遗留录制已释放。原始记录已保存，可从命令面板导入。' : '空的遗留录制已清理，设备已释放。';
    this.render();
    if (savedFile) void vscode.window.showInformationMessage(this.touchStatus, '打开记录').then(action => {
      if (action === '打开记录') return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(savedFile!));
    });
  }
  async pickTouchRecording(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      openLabel: '导入 UITest 触摸记录',
      canSelectMany: false,
      filters: { 'UITest JSON Lines': ['jsonl', 'txt', 'log'] },
    });
    if (!files?.[0] || files[0].scheme !== 'file') return;
    const config = vscode.workspace.getConfiguration('harmonyosRecorder');
    const appId = await vscode.window.showInputBox({
      title: '确认录制时操作的测试应用包名',
      value: this.session.state.appId || config.get<string>('appId', ''),
      validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? null : '请输入有效的应用包名。',
    });
    if (!appId) return;
    const data = await boundedRead(files[0].fsPath, 4 * 1024 * 1024);
    let layouts: TouchLayouts | undefined;
    const sidecar = await localFile(path.dirname(files[0].fsPath), 'uitest-layouts.json');
    if (sidecar) {
      try {
        const evidence: unknown = JSON.parse((await boundedRead(sidecar, 9 * 1024 * 1024)).toString('utf8'));
        if (object(evidence) && evidence.schemaVersion === 1 && evidence.recordSha256 === replayFileHash(data) &&
            object(evidence.layouts) && object(evidence.layouts.after)) {
          layouts = { initial: evidence.layouts.initial, after: evidence.layouts.after };
        }
      } catch { /* Events without matching layout evidence are imported as coordinates. */ }
    }
    const result = importTouchRecording(appId, new TextDecoder('utf-8', { fatal: true }).decode(data), layouts);
    const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: result.yaml });
    await vscode.window.showTextDocument(document);
    void vscode.window.showInformationMessage(`已导入 ${result.steps} 步，跳过 ${result.skipped} 条记录。请检查选择器与坐标，再保存并回放。`);
  }
  async checkSyntax(preferred?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor?.document;
    const active = editor?.uri.scheme === 'file' && /\.ya?ml$/i.test(editor.uri.fsPath) ? editor.uri.fsPath : undefined;
    const file = preferred ?? active ?? (await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: '检查 Flow', filters: { YAML: ['yaml', 'yml'] },
    }))?.find(uri => uri.scheme === 'file')?.fsPath;
    if (!file) return;
    if (vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && doc.isDirty && this.matchesSource(doc.uri.fsPath, file))) {
      throw new Error('请先保存当前 YAML，再运行语法检查。');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? await this.workspaceRoot();
    const result = await this.validateSyntax(document, root);
    if (!result) return;
    if (result.valid) void vscode.window.showInformationMessage(`${path.basename(file)} 通过 Maestro 语法检查。`);
    else {
      this.output.show(true);
      void vscode.window.showErrorMessage(`${path.basename(file)} 的语法检查未通过，请查看编辑器标记或 HarmonyOS Recorder 输出。`);
    }
  }
  private clearSyntax(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.syntaxChecks.get(key)?.abort();
    this.syntaxChecks.delete(key);
    this.syntaxDiagnostics.delete(document.uri);
  }
  private async validateSyntax(document: vscode.TextDocument, root: string): Promise<{ valid: boolean } | undefined> {
    if (this.disposed || document.isDirty || document.isClosed) return;
    const key = document.uri.toString();
    this.clearSyntax(document);
    const job = new AbortController();
    this.syntaxChecks.set(key, job);
    try {
      const result = await checkFlowSyntax(root, this.settings(document.uri), document.uri.fsPath, job.signal);
      if (job.signal.aborted || this.disposed || document.isDirty || document.isClosed) return;
      this.output.appendLine(`语法检查 ${path.basename(document.uri.fsPath)}\n${result.output}`);
      const issue = result.valid ? undefined : syntaxLocation(result.output, document.uri.fsPath, root);
      if (issue && issue.line < document.lineCount) {
        const line = document.lineAt(issue.line);
        const start = Math.min(issue.column, line.text.length);
        const range = new vscode.Range(issue.line, start, issue.line, Math.min(start + 1, line.text.length));
        const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'Maestro';
        this.syntaxDiagnostics.set(document.uri, [diagnostic]);
      }
      return result;
    } catch (error) {
      if (!job.signal.aborted) throw error;
    } finally {
      if (this.syntaxChecks.get(key) === job) this.syntaxChecks.delete(key);
    }
  }
  private async workspaceRoot(): Promise<string> {
    if (this.root) return this.root;
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file');
    if (!folders?.length) throw new Error('请先打开本地项目目录。');
    const chosen = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择保存流程产物的项目' });
    if (!chosen || chosen.uri.scheme !== 'file') throw new Error('未选择本地项目。');
    this.root = chosen.uri.fsPath;
    return this.root;
  }
  async checkReadiness(): Promise<void> {
    if (this.busy || this.session.state.connected) throw new Error('请结束当前设备操作后再检查运行环境。');
    const root = await this.workspaceRoot();
    const settings = this.settings();
    const launch = await javaLaunch(root, settings, ['harmonyos-bridge']);
    const bridge = new BridgeClient(launch, text => this.output.append(text), 20_000);
    try {
      await bridge.request('agent.describe');
      const devices = parseDevices(await bridge.request('devices'));
      if (!devices.length) throw new Error('HDC 没有发现设备。请核对 USB 连接、调试开关及设备端授权。');
      const selected = await vscode.window.showQuickPick(devices.map(device => device.id), { placeHolder: '选择要检查的设备' });
      if (!selected) return;
      const config = vscode.workspace.getConfiguration('harmonyosRecorder');
      const app = await vscode.window.showInputBox({ title: '测试应用 bundle 名称', value: config.get<string>('appId', ''),
        validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? null : '请输入有效的应用 bundle 名称' });
      if (!app || this.busy || this.session.state.connected) return;
      const reply = await bridge.request('agent.preflight', {
        deviceId: selected, appId: app, commands: ['launchApp', 'tapOn', 'assertVisible'],
        abilityName: config.get<string>('abilityName', '').trim() || undefined,
        moduleName: config.get<string>('moduleName', '').trim() || undefined,
      });
      if (!object(reply) || reply.protocol !== 'maestro.harmonyos.agent' || reply.schemaVersion !== 1 ||
          reply.kind !== 'preflight' || !object(reply.data) || !Array.isArray(reply.data.checks) ||
          !['ready', 'unknown', 'blocked'].includes(String(reply.data.readiness))) throw new Error('CLI 未返回有效的只读预检结果。');
      this.output.appendLine(`运行预检 · ${reply.data.readiness}`);
      for (const check of reply.data.checks) {
        if (object(check)) this.output.appendLine(`[${check.status}] ${check.name} (${check.code}) ${check.message}`);
      }
      this.output.show(true);
    } finally { await bridge.dispose(); }
  }

  async connect(): Promise<void> {
    this.open();
    if (this.busy) throw new Error('请等待当前操作完成。');
    if (this.session.state.connected) throw new Error('设备已连接，若要切换设备请先断开。');
    const attempt = ++this.connectionAttempt;
    const check = () => { if (attempt !== this.connectionAttempt) throw new OperationStopped(); };
    this.connecting = true; this.render();
    try {
      const root = await this.workspaceRoot();
      check();
      await this.bridge?.dispose();
      check();
      const launch = await javaLaunch(root, this.settings(), ['harmonyos-bridge']);
      check();
      this.bridge = new BridgeClient(launch, text => this.output.append(text));
      const devices = parseDevices(await this.bridge.request('devices'));
      check();
      if (!devices.length) throw new Error('未找到设备，请检查 HDC、USB 调试与手机授权。');
      const chosen = await vscode.window.showQuickPick(devices.map(device => ({ label: device.id })), { placeHolder: '选择本次操作的鸿蒙设备' });
      check();
      if (!chosen) return;
      await this.recoverTouch(root, this.settings(), chosen.label);
      check();
      const config = vscode.workspace.getConfiguration('harmonyosRecorder');
      const appId = await vscode.window.showInputBox({ title: '测试应用 bundle 名称', value: this.session.state.appId || config.get<string>('appId', ''), ignoreFocusOut: true,
        validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? null : '请输入 bundle 名称，例如 org.example.app' });
      check();
      if (!appId) return;
      const abilityName = await vscode.window.showInputBox({ title: '启动 Ability', value: config.get<string>('abilityName', ''), ignoreFocusOut: true,
        placeHolder: '留空自动查找，也可填写 Ability 名称',
        validateInput: value => !value.trim() || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.trim()) ? null : '请输入有效的 Ability 名称' });
      check();
      if (abilityName === undefined) return;
      const moduleName = config.get<string>('moduleName', '').trim() || undefined;
      if (moduleName && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(moduleName)) throw new Error('moduleName 配置无效。');
      const artifactsDir = await createRunDirectory(root, 'capture');
      check();
      await this.session.connect(this.bridge, { deviceId: chosen.label, appId, abilityName: abilityName.trim() || undefined, moduleName, artifactsDir });
    } finally {
      if (attempt === this.connectionAttempt) {
        this.connecting = false;
        if (!this.session.state.connected) { const bridge = this.bridge; this.bridge = undefined; await bridge?.dispose(); }
        this.render();
      }
    }
  }
  async save(): Promise<void> {
    if (this.busy) throw new Error('请等待当前操作完成后保存。');
    if (!this.session.state.steps.length) throw new Error('请先录制至少一个步骤。');
    const root = await this.workspaceRoot();
    const destination = await vscode.window.showSaveDialog({ title: '保存标准 Maestro YAML', defaultUri: vscode.Uri.file(path.join(root, 'recorded-flow.yaml')), filters: { YAML: ['yaml', 'yml'] } });
    if (!destination) return;
    await vscode.workspace.fs.writeFile(destination, Buffer.from(this.session.yaml(), 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(destination), { viewColumn: vscode.ViewColumn.Beside });
  }
  async replay(): Promise<void> {
    const connection = this.session.replayConnection;
    if (!connection || !this.session.state.steps.length) throw new Error('请先录制至少一个步骤。');
    await this.prepare(async root => ({ root, connection, input: { yaml: this.session.yaml() }, tools: this.settings() }));
  }
  async pickFlow(): Promise<void> {
    await this.prepare(async root => {
      const selected = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(root), canSelectFiles: true, canSelectFolders: true, canSelectMany: false,
        filters: { YAML: ['yaml', 'yml'] }, openLabel: '选择 YAML 或套件目录',
      });
      if (selected?.[0]?.scheme !== 'file') return;
      const flowPath = selected[0].fsPath;
      for (const document of vscode.workspace.textDocuments) {
        const relation = path.relative(flowPath, document.uri.fsPath);
        if (document.uri.scheme === 'file' && document.isDirty && (!relation || (!relation.startsWith('..') && !path.isAbsolute(relation)))) {
          throw new Error('请先保存此次运行涉及的 YAML 文件。');
        }
      }
      const tools = this.settings();
      const config = vscode.workspace.getConfiguration('harmonyosRecorder');
      const previous = this.session.state.connected ? this.session.replayConnection : undefined;
      let deviceId = previous?.deviceId;
      if (!deviceId) {
        const discovery = new BridgeClient(await javaLaunch(root, tools, ['harmonyos-bridge']), text => this.output.append(text));
        try {
          const devices = parseDevices(await discovery.request('devices'));
          if (!devices.length) throw new Error('未找到设备，请检查 HDC 和 USB 调试授权。');
          deviceId = (await vscode.window.showQuickPick(devices.map(device => device.id), { placeHolder: '选择运行设备' })) || undefined;
        } finally { await discovery.dispose(); }
      }
      if (!deviceId) return;
      const env = config.get<string[]>('flowEnvironment', []);
      if (!Array.isArray(env) || env.some(entry => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=[^\0]*$/.test(entry))) {
        throw new Error('flowEnvironment 必须是 NAME=VALUE 格式的字符串数组。');
      }
      const connection = previous ?? { deviceId, appId: '', abilityName: config.get<string>('abilityName', '').trim() || undefined,
        moduleName: config.get<string>('moduleName', '') || undefined, artifactsDir: root };
      return { root, tools, connection, input: { flowPath, env: [...env] } };
    });
  }
  async rerun(): Promise<void> {
    if (!this.run?.releaseConfirmed) throw new Error('需要确认上一轮设备释放后才能重跑。');
    const request = this.run.request;
    await this.prepare(async () => request);
  }
  private async prepare(makeRequest: (root: string) => Promise<RunRequest | void>): Promise<void> {
    if (this.busy) throw new Error('请等待当前操作完成。');
    this.open();
    this.preparingRun = true;
    this.preparationCancelled = false;
    this.render();
    try {
      const request = await makeRequest(await this.workspaceRoot());
      if (!request || this.preparationCancelled || this.disposed) return;
      await this.recoverTouch(request.root, request.tools, request.connection.deviceId);
      await this.session.disconnect();
      const bridge = this.bridge;
      this.bridge = undefined;
      await bridge?.dispose();
      if (this.preparationCancelled || this.disposed) return;
      const run = new InteractiveRun(request, () => { this.render(); this.decorate(); }, text => this.output.append(text),
        () => this.panel?.visible === true);
      this.run = run;
      this.clearEvidence();
      this.highlightRequest = '';
      this.runTask = run.execute();
    } finally { this.preparingRun = false; this.render(); }
    await this.touchTask;
    await this.runTask;
  }
  async stop(): Promise<void> {
    if (this.touch) { await this.stopTouch(); return; }
    if (this.run?.active) { await this.run.stop(); return; }
    if (this.preparingRun) { this.preparationCancelled = true; return; }
    ++this.connectionAttempt; this.connecting = false;
    const bridge = this.bridge; this.bridge = undefined;
    const closingSession = this.session.stop();
    await Promise.all([closingSession, bridge?.dispose()]);
  }
  private async showReplayFailure(stepId?: string): Promise<void> {
    const run = this.run;
    const failure = run?.attempt ?? this.session.state.replayFailure;
    if (!failure || this.busy) return;
    const request = ++this.evidenceRequest;
    const legacy = this.session.state.replayFailure;
    const target = stepId ?? run?.failure;
    const selected = run?.progress.steps.find(step => step.id === target);
    const { links, reason, elapsedMs, elementWaits, faultSummaries } = await replayEvidence(failure, target, stepId === undefined);
    const yaml = links.find(link => link.offset !== undefined);
    const before = links.find(link => link.screenshotPhase === 'before');
    const after = links.find(link => link.screenshotPhase === 'failure') ?? links.find(link => link.screenshotPhase === 'after');
    const log = links.find(link => link.label.startsWith('日志')) ?? links.find(link => link.label === '回放控制台日志');
    const [sourceBytes, images, logPreview] = await Promise.all([
      yaml ? boundedRead(yaml.file, 4 * 1024 * 1024).catch(() => undefined) : undefined,
      Promise.all([before, after].map(link => link && evidenceImage(link).catch(() => undefined))),
      log ? logTail(log.file).catch(() => undefined) : undefined,
    ]);
    if (request !== this.evidenceRequest || run !== this.run || (!run && legacy !== this.session.state.replayFailure) || this.busy) return;
    let source: string | undefined;
    if (yaml && sourceBytes && replayFileHash(sourceBytes) === yaml.sha256) {
      const text = sourceBytes.toString('utf8');
      const line = text.slice(0, yaml.offset).split('\n').length;
      source = text.split('\n').slice(Math.max(0, line - 3), line + 3)
        .map((value, index) => {
          const current = Math.max(1, line - 2) + index;
          return `${current === line ? '▶' : ' '} ${current}  ${value}`;
        }).join('\n');
    }
    this.evidenceLinks = links;
    await this.panel?.webview.postMessage({ type: 'stepEvidence', request, source,
      stepLabel: selected ? `第 ${selected.sequence + 1} 步${selected.tryNo ? ` · 第 ${selected.tryNo} 次尝试` : ''}` : undefined,
      reason: reason ?? (!stepId || stepId === run?.failure ? run?.failureReason : undefined), elapsedMs, elementWaits, faultSummaries,
      log: logPreview,
      images: images.filter(Boolean),
      links: links.map(link => link.label) });
  }
  private clearEvidence(): void {
    ++this.evidenceRequest;
    this.evidenceLinks = [];
    void this.panel?.webview.postMessage({ type: 'clearEvidence' });
  }
  private async openEvidence(index: unknown, request: unknown): Promise<void> {
    if (request !== this.evidenceRequest || typeof index !== 'number' || !Number.isInteger(index)) return;
    const picked = this.evidenceLinks[index];
    if (!picked || this.busy) return;
    const uri = vscode.Uri.file(picked.file);
    if (picked.offset === undefined) {
      if (picked.sha256 && replayFileHash(await boundedRead(picked.file, 4 * 1024 * 1024)) !== picked.sha256) {
        throw new Error('运行产物已改变。');
      }
      await vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.Beside);
      return;
    }
    const bytes = await boundedRead(picked.file, 4 * 1024 * 1024);
    const document = await vscode.workspace.openTextDocument(uri);
    const lineNo = picked.sha256 && verifiedYamlLine(bytes, document.getText(), picked.offset, picked.sha256);
    if (typeof lineNo !== 'number') throw new Error('运行时的 YAML 快照已改变。');
    const line = document.lineAt(lineNo);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, selection: line.range });
  }
  async shutdown(): Promise<void> {
    await this.stop().catch(error => this.output.appendLine(errorMessage(error)));
    await this.touchTask;
    await this.runTask;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop().catch(() => undefined);
    this.activeLine.dispose();
    for (const listener of this.editorListeners) listener.dispose();
    for (const job of this.syntaxChecks.values()) job.abort();
    this.syntaxChecks.clear();
    this.syntaxDiagnostics.dispose();
    this.output.dispose();
  }
  private matchesSource(file: string, source: string): boolean {
    return path.relative(source, file) === '';
  }
  private decorate(): void {
    const step = this.run?.active ? this.run.progress.current : undefined;
    const source = step?.source;
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      const snapshot = this.run?.attempt && source ? path.join(this.run.attempt.attemptDir, source.snapshot) : undefined;
      const match = source && document.uri.scheme === 'file' &&
        (this.matchesSource(document.uri.fsPath, source.identity) || (snapshot && this.matchesSource(document.uri.fsPath, snapshot))) &&
        replayFileHash(Buffer.from(document.getText(), 'utf8')) === source.sha256;
      if (match) {
        const line = document.lineAt(document.positionAt(source.offset).line).range;
        editor.setDecorations(this.activeLine, [line]);
        if (this.highlightRequest !== step.id) editor.revealRange(line, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      } else editor.setDecorations(this.activeLine, []);
    }
    if (source && this.highlightRequest !== step.id && this.panel?.visible) {
      this.highlightRequest = step.id;
      if (!vscode.window.visibleTextEditors.some(editor => this.matchesSource(editor.document.uri.fsPath, source.identity) &&
          replayFileHash(Buffer.from(editor.document.getText(), 'utf8')) === source.sha256)) {
        void this.showSource(source, true).catch(error => this.output.appendLine(errorMessage(error)));
      }
    }
  }
  private async showSource(source: StepSource, follow = false): Promise<void> {
    const run = this.run, attempt = run?.attempt;
    if (!attempt) return;
    let file: string | undefined = source.identity;
    try {
      const open = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && this.matchesSource(document.uri.fsPath, source.identity));
      const bytes = open ? Buffer.from(open.getText(), 'utf8') : await boundedRead(file, 4 * 1024 * 1024);
      if (replayFileHash(bytes) !== source.sha256) file = undefined;
    } catch { file = undefined; }
    file ??= await sourceSnapshot(attempt.attemptDir, source);
    if (!file || this.run !== run || (follow && (!run.active || run.progress.current?.source !== source))) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (replayFileHash(Buffer.from(document.getText(), 'utf8')) !== source.sha256) return;
    if (follow && (!run.active || run.progress.current?.source !== source)) return;
    const line = document.lineAt(document.positionAt(source.offset).line).range;
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: follow, preview: follow, selection: line });
    this.decorate();
  }
  private async message(message: unknown): Promise<void> {
    if (!object(message) || !string(message.type, 30)) throw new Error('无效的面板消息。');
    switch (message.type) {
      case 'ready': this.render(); return;
      case 'connect': await this.connect(); return;
      case 'disconnect': await this.session.disconnect(); return;
      case 'refresh': await this.session.refresh(); return;
      case 'action': await this.session.action(message.action); return;
      case 'previewSelector':
      case 'copySelector': {
        const snapshot = this.session.state.snapshot;
        if (this.busy || !snapshot || snapshot.snapshotId !== message.snapshotId) return;
        const node = snapshot.nodes.find(item => item.nodeId === message.nodeId);
        if (!node) return;
        const candidates = previewSelectors(snapshot.nodes, node);
        if (message.type === 'copySelector') {
          const match = candidates.find(candidate => candidate.yaml === message.yaml && candidate.unique);
          if (match) {
            await vscode.env.clipboard.writeText(match.yaml);
            void vscode.window.showInformationMessage('已复制 Maestro 选择器。');
          }
        } else {
          await this.panel?.webview.postMessage({ type: 'selectorPreview', snapshotId: snapshot.snapshotId, nodeId: node.nodeId, candidates });
        }
        return;
      }
      case 'startTouch': await this.startTouch(); return;
      case 'stopTouch': await this.stopTouch(); return;
      case 'replayTouch': await this.replayTouch(); return;
      case 'checkSyntax': await this.checkSyntax(); return;
      case 'checkTouchSyntax': await this.checkSyntax(this.touchFlow?.input.flowPath); return;
      case 'save': await this.save(); return;
      case 'replay': await this.replay(); return;
      case 'runFile': await this.pickFlow(); return;
      case 'rerun': await this.rerun(); return;
      case 'runPreview':
        if (this.run?.active && typeof message.enabled === 'boolean') {
          this.run.previewEnabled = message.enabled;
          await this.run.syncPreview();
          this.render();
        }
        return;
      case 'runStep': {
        const step = this.run?.progress.steps.find(item => item.id === message.id);
        if (step?.source && step.state !== '失败') await this.showSource(step.source);
        if (step && !this.busy) await this.showReplayFailure(step.id);
        return;
      }
      case 'replayFailure': await this.showReplayFailure(); return;
      case 'openEvidence': await this.openEvidence(message.index, message.request); return;
      case 'stop': await this.stop(); return;
      case 'clear':
        if (!this.session.state.steps.length || await vscode.window.showWarningMessage('清空当前录制步骤？已保存的 YAML 文件不受影响。', { modal: true }, '清空') === '清空') this.session.clear();
        return;
      case 'artifacts':
        const directory = this.run?.attempt?.artifactsDir ?? this.session.state.artifactsDir;
        if (directory) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(directory));
        return;
      default: throw new Error('未知面板操作。');
    }
  }
  private render(): void {
    const { replayFailure, ...state } = this.session.state;
    void this.panel?.webview.postMessage({ type: 'state', ...state, hasReplayFailure: !!replayFailure,
      busy: this.busy, yaml: this.session.yaml(),
      touch: { active: !!this.touch, stopping: this.touchStopped, status: this.touchStatus, canReplay: !!this.touchFlow },
      run: this.run ? { status: this.run.status, active: this.run.active, canStop: this.run.status === '正在启动' || this.run.canStop,
        canPreview: this.run.canStop,
        release: this.run.releaseConfirmed, progress: this.run.progress, failure: this.run.failure, failureReason: this.run.failureReason,
        preview: this.run.previewEnabled, artifacts: !!this.run.attempt,
        frame: this.run.previewEnabled && this.panel?.visible ? this.run.frame : undefined } : undefined });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'recorder.js'));
    const geometry = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'geometry.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'recorder.css'));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>鸿蒙流程录制</title></head><body>
<header><h1>鸿蒙流程录制</h1><p>在画面中选择控件，再执行操作。成功步骤会写入标准 YAML。</p></header>
<nav aria-label="会话"><button id="connect">连接设备</button><button id="disconnect">断开</button><button id="refresh">刷新画面</button><button id="launch">启动应用</button><button id="back">返回</button><button id="stop" class="secondary">停止任务</button></nav>
<section class="flow"><h2>真机触摸录制</h2><div class="row"><button id="startTouch">开始录制</button><button id="stopTouch">停止并生成 YAML</button><button id="checkTouchSyntax">检查录制 YAML</button><button id="replayTouch">回放触摸流程</button></div>
<p id="touchStatus" role="status"></p></section>
<section class="flow"><h2>运行与证据</h2><div class="row">
<button id="runFile">运行 YAML 或套件</button><button id="checkSyntax" class="secondary">检查 Flow 语法</button><button id="runArtifacts" class="secondary">打开本轮产物</button><button id="rerun">重跑</button><button id="runEvidence" hidden>查看失败证据</button>
<label><input id="runPreview" type="checkbox"> 预览设备画面</label></div>
<p id="runStatus" role="status">尚未运行</p><p id="runReason" hidden></p><ul id="runFlows"></ul>
<details open><summary>最近步骤</summary><ul id="runSteps"></ul></details>
<section id="stepEvidence" hidden aria-labelledby="evidenceHeading"><h3 id="evidenceHeading">步骤证据</h3><p id="evidenceReason"></p>
<p id="evidenceTiming" hidden></p><ul id="evidenceWaits" hidden></ul><ul id="evidenceFaults" aria-label="系统故障" hidden></ul><pre id="evidenceSource" hidden></pre><div id="evidenceImages" hidden></div><pre id="evidenceLog" aria-label="日志末尾摘要" hidden></pre><div class="row" id="evidenceLinks"></div></section>
<p id="runPreviewStatus" hidden>等待执行过程中的截图。</p><img id="runFrame" alt="最近一次运行截图" hidden></section>
<p id="status" role="status" aria-live="polite">连接手机后开始录制。</p><div class="workspace"><section class="device"><h2>设备画面 <span id="dimensions"></span></h2><p id="empty">连接设备后显示截图。每次操作后自动刷新。</p><div id="imageWrap"><img id="screen" alt="当前鸿蒙设备截图" hidden><div id="highlight" hidden></div><div id="point" hidden></div></div></section>
<section class="controls"><h2>选择与操作</h2><p id="selection">尚未选择控件</p>
<div id="selectorPreview" hidden aria-label="当前控件树中的选择器匹配"><ul id="selectorCandidates"></ul><button id="copySelector" class="secondary" disabled>复制选择器</button></div>
<div class="row"><button id="tap">点击控件</button><button id="assertNode">断言控件可见</button><button id="coordinate" class="secondary">按所选坐标点击</button></div>
<label for="input">输入文字（先点击输入框）</label><textarea id="input" rows="2" maxlength="8192" placeholder="要输入的文字"></textarea><button id="inputAction">输入并记录</button>
<label for="assertText">可见文字断言</label><input id="assertText" maxlength="8192" placeholder="预期页面文字"><button id="assertTextAction">检查并记录</button>
<div class="row"><label for="direction">滑动方向</label><select id="direction"><option value="UP">向上</option><option value="DOWN">向下</option><option value="LEFT">向左</option><option value="RIGHT">向右</option></select><button id="swipe">滑动</button></div>
<div class="row"><input id="screenshotName" value="recorded-screen" aria-label="截图名称" maxlength="80"><button id="screenshot">保存截图步骤</button></div>
<details><summary>控件树 <span id="nodeCount"></span></summary><div id="nodes" role="list"></div></details></section></div>
<section class="flow"><div class="row"><h2>已录制流程 <span id="stepCount">0 步</span></h2><button id="save">保存 YAML</button><button id="replay">回放流程</button><button id="replayFailure" hidden>查看回放失败</button><button id="clear" class="secondary">新建流程</button><button id="artifacts" class="secondary">打开产物</button></div><textarea id="yaml" readonly rows="10" aria-label="录制的 YAML"></textarea></section><footer>仅记录通过本插件执行的操作。回放期间会释放录制会话；结束后可重新连接。录制不依赖系统视频录屏。</footer><script nonce="${nonce}" src="${geometry}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}
