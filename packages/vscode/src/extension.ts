import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BridgeClient } from './bridge';
import { createRunDirectory, javaLaunch, replayFlow, stopOwnProcess, ToolSettings } from './launcher';
import { object, parseDevices, string } from './protocol';
import { RecorderSession, OperationStopped, errorMessage } from './session';

let recorder: Recorder | undefined;
export function activate(context: vscode.ExtensionContext): { getStatus(): { panelOpen: boolean; connected: boolean; busy: boolean; steps: number } } {
  recorder = new Recorder(context);
  context.subscriptions.push(recorder);
  for (const [name, action] of Object.entries({ open: () => recorder!.open(), connect: () => recorder!.connect(), save: () => recorder!.save(), replay: () => recorder!.replay(), stop: () => recorder!.stop() })) {
    context.subscriptions.push(vscode.commands.registerCommand(`harmonyosRecorder.${name}`, () => recorder!.handle(action)));
  }
  return { getStatus: () => recorder!.status() };
}
export async function deactivate(): Promise<void> { await recorder?.stop(); recorder = undefined; }

class Recorder implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private bridge: BridgeClient | undefined;
  private replayProcess: ChildProcess | null = null;
  private readonly output = vscode.window.createOutputChannel('HarmonyOS Recorder');
  private readonly session = new RecorderSession(() => this.render());
  private root: string | undefined;
  private connecting = false;
  private connectionAttempt = 0;
  constructor(private readonly context: vscode.ExtensionContext) {}

  status() { return { panelOpen: !!this.panel, connected: this.session.state.connected, busy: this.session.state.busy || this.connecting, steps: this.session.state.steps.length }; }
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
    this.panel.onDidDispose(() => { this.panel = undefined; void this.stop(); });
  }
  private settings(): ToolSettings {
    const config = vscode.workspace.getConfiguration('harmonyosRecorder');
    return { cliDirectory: config.get<string>('cliDirectory', ''), javaPath: config.get<string>('javaPath', ''), hdcPath: config.get<string>('hdcPath', '') };
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
  async connect(): Promise<void> {
    this.open();
    if (this.connecting || this.session.state.busy) throw new Error('请等待当前操作完成。');
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
      const config = vscode.workspace.getConfiguration('harmonyosRecorder');
      const appId = await vscode.window.showInputBox({ title: '测试应用 bundle 名称', value: this.session.state.appId || config.get<string>('appId', ''), ignoreFocusOut: true,
        validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? null : '请输入 bundle 名称，例如 org.example.app' });
      check();
      if (!appId) return;
      const abilityName = await vscode.window.showInputBox({ title: '启动 Ability', value: config.get<string>('abilityName', 'EntryAbility'), ignoreFocusOut: true,
        validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? null : '请输入有效的 Ability 名称' });
      check();
      if (!abilityName) return;
      const moduleName = config.get<string>('moduleName', '').trim() || undefined;
      if (moduleName && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(moduleName)) throw new Error('moduleName 配置无效。');
      const artifactsDir = await createRunDirectory(root, 'capture');
      check();
      await this.session.connect(this.bridge, { deviceId: chosen.label, appId, abilityName, moduleName, artifactsDir });
    } finally {
      if (attempt === this.connectionAttempt) {
        this.connecting = false;
        if (!this.session.state.connected) { const bridge = this.bridge; this.bridge = undefined; await bridge?.dispose(); }
        this.render();
      }
    }
  }
  async save(): Promise<void> {
    if (this.session.state.busy || this.connecting) throw new Error('请等待当前操作完成后保存。');
    if (!this.session.state.steps.length) throw new Error('请先录制至少一个步骤。');
    const root = await this.workspaceRoot();
    const destination = await vscode.window.showSaveDialog({ title: '保存标准 Maestro YAML', defaultUri: vscode.Uri.file(path.join(root, 'recorded-flow.yaml')), filters: { YAML: ['yaml', 'yml'] } });
    if (!destination) return;
    await vscode.workspace.fs.writeFile(destination, Buffer.from(this.session.yaml(), 'utf8'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(destination), { viewColumn: vscode.ViewColumn.Beside });
  }
  async replay(): Promise<void> {
    if (this.connecting) throw new Error('请等待设备连接完成。');
    const attempt = this.connectionAttempt;
    const root = await this.workspaceRoot();
    if (attempt !== this.connectionAttempt) throw new OperationStopped();
    this.output.show(true);
    let currentReplay: ChildProcess | null = null;
    await this.session.replay((connection, yaml, signal) => replayFlow(root, this.settings(), connection, yaml,
      text => this.output.append(text), process => {
        if (process) { currentReplay = process; this.replayProcess = process; }
        else if (this.replayProcess === currentReplay) this.replayProcess = null;
      }, signal));
  }
  async stop(): Promise<void> {
    ++this.connectionAttempt; this.connecting = false;
    const bridge = this.bridge; this.bridge = undefined;
    const process = this.replayProcess; this.replayProcess = null;
    const closingSession = this.session.stop();
    await Promise.all([closingSession, stopOwnProcess(process), bridge?.dispose()]);
  }
  dispose(): void { void this.stop(); this.output.dispose(); }
  private async message(message: unknown): Promise<void> {
    if (!object(message) || !string(message.type, 30)) throw new Error('无效的面板消息。');
    switch (message.type) {
      case 'ready': this.render(); return;
      case 'connect': await this.connect(); return;
      case 'disconnect': await this.session.disconnect(); return;
      case 'refresh': await this.session.refresh(); return;
      case 'action': await this.session.action(message.action); return;
      case 'save': await this.save(); return;
      case 'replay': await this.replay(); return;
      case 'stop': await this.stop(); return;
      case 'clear':
        if (!this.session.state.steps.length || await vscode.window.showWarningMessage('清空当前录制步骤？已保存的 YAML 文件不受影响。', { modal: true }, '清空') === '清空') this.session.clear();
        return;
      case 'artifacts':
        if (this.session.state.artifactsDir) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.session.state.artifactsDir));
        return;
      default: throw new Error('未知面板操作。');
    }
  }
  private render(): void {
    void this.panel?.webview.postMessage({ type: 'state', ...this.session.state, busy: this.session.state.busy || this.connecting, yaml: this.session.yaml() });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'recorder.js'));
    const geometry = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'geometry.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'recorder.css'));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>鸿蒙流程录制</title></head><body>
<header><h1>鸿蒙流程录制</h1><p>在画面中选择控件，再执行操作。成功步骤会写入标准 YAML。</p></header>
<nav aria-label="会话"><button id="connect">连接设备</button><button id="disconnect">断开</button><button id="refresh">刷新画面</button><button id="launch">启动应用</button><button id="back">返回</button><button id="stop" class="secondary">停止任务</button></nav>
<p id="status" role="status" aria-live="polite">连接手机后开始录制。</p><div class="workspace"><section class="device"><h2>设备画面 <span id="dimensions"></span></h2><p id="empty">连接设备后显示截图。每次操作后自动刷新。</p><div id="imageWrap"><img id="screen" alt="当前鸿蒙设备截图" hidden><div id="highlight" hidden></div><div id="point" hidden></div></div></section>
<section class="controls"><h2>选择与操作</h2><p id="selection">尚未选择控件</p><div class="row"><button id="tap">点击控件</button><button id="assertNode">断言控件可见</button><button id="coordinate" class="secondary">按所选坐标点击</button></div>
<label for="input">输入文字（先点击输入框）</label><textarea id="input" rows="2" maxlength="8192" placeholder="要输入的文字"></textarea><button id="inputAction">输入并记录</button>
<label for="assertText">可见文字断言</label><input id="assertText" maxlength="8192" placeholder="预期页面文字"><button id="assertTextAction">检查并记录</button>
<div class="row"><label for="direction">滑动方向</label><select id="direction"><option value="UP">向上</option><option value="DOWN">向下</option><option value="LEFT">向左</option><option value="RIGHT">向右</option></select><button id="swipe">滑动</button></div>
<div class="row"><input id="screenshotName" value="recorded-screen" aria-label="截图名称" maxlength="80"><button id="screenshot">保存截图步骤</button></div>
<details><summary>控件树 <span id="nodeCount"></span></summary><div id="nodes" role="list"></div></details></section></div>
<section class="flow"><div class="row"><h2>已录制流程 <span id="stepCount">0 步</span></h2><button id="save">保存 YAML</button><button id="replay">回放流程</button><button id="clear" class="secondary">新建流程</button><button id="artifacts" class="secondary">打开产物</button></div><textarea id="yaml" readonly rows="10" aria-label="录制的 YAML"></textarea></section><footer>仅记录通过本插件执行的操作。回放期间会释放录制会话；结束后可重新连接。录制不依赖系统视频录屏。</footer><script nonce="${nonce}" src="${geometry}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}
