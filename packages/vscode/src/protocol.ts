export interface Bounds { left: number; top: number; right: number; bottom: number }
export interface UiNode {
  nodeId: string; parentId: string | null; text: string; hintText: string;
  resourceId: string; className: string; bounds: Bounds;
  enabled: boolean | null; clickable: boolean | null;
}
export interface Snapshot {
  snapshotId: string; width: number; height: number;
  screenshot: { mimeType: 'image/png'; base64: string }; nodes: UiNode[];
}
export interface Connection {
  deviceId: string; appId: string; abilityName: string; moduleName?: string; artifactsDir: string;
}
export type Action =
  | { type: 'launchApp' | 'back' }
  | { type: 'tapOn'; snapshotId: string; nodeId: string }
  | { type: 'tapOn'; snapshotId: string; point: { x: number; y: number } }
  | { type: 'inputText'; text: string }
  | { type: 'swipe'; direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'; duration: number }
  | { type: 'assertVisible'; snapshotId: string; nodeId: string }
  | { type: 'assertVisible'; text: string }
  | { type: 'takeScreenshot'; name: string };
export interface Transport {
  request(method: string, params?: object): Promise<unknown>;
  dispose(): Promise<void>;
  onTerminated?(listener: (error: Error) => void): () => void;
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function string(value: unknown, max = 8192): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0');
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function parseSnapshot(value: unknown): Snapshot {
  if (!object(value) || !string(value.snapshotId, 200) || !value.snapshotId ||
      !Number.isInteger(value.width) || !Number.isInteger(value.height) ||
      (value.width as number) < 1 || (value.height as number) < 1 ||
      (value.width as number) > 32768 || (value.height as number) > 32768 ||
      !object(value.screenshot) || value.screenshot.mimeType !== 'image/png' ||
      !string(value.screenshot.base64, 30 * 1024 * 1024) ||
      !/^iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(value.screenshot.base64) ||
      !Array.isArray(value.nodes) || value.nodes.length > 100000) throw new Error('桥接返回的截图格式无效。');
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!object(node) || !string(node.nodeId, 300) || ids.has(node.nodeId) ||
        !(node.parentId === null || string(node.parentId, 300)) ||
        !['text', 'hintText', 'resourceId', 'className'].every(key => string(node[key], 1024 * 1024)) ||
        !object(node.bounds) || !['left', 'top', 'right', 'bottom'].every(key => finite(node.bounds && (node.bounds as Record<string, unknown>)[key])) ||
        ![true, false, null].includes(node.enabled as boolean | null) ||
        ![true, false, null].includes(node.clickable as boolean | null)) throw new Error('桥接返回的控件树格式无效。');
    ids.add(node.nodeId);
  }
  return value as unknown as Snapshot;
}
export function parseDevices(value: unknown): { id: string }[] {
  if (!object(value) || !Array.isArray(value.devices) || value.devices.length > 1000 ||
      !value.devices.every(device => object(device) && string(device.id, 300) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(device.id))) {
    throw new Error('桥接返回的设备列表无效。');
  }
  return value.devices as { id: string }[];
}
export function validateAction(value: unknown, snapshot: Snapshot | null): Action {
  if (!object(value) || !string(value.type, 30)) throw new Error('无效操作。');
  const exactKeys = (...keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  if (['launchApp', 'back'].includes(value.type) && exactKeys('type')) return value as Action;
  if (value.type === 'inputText' && string(value.text) && exactKeys('type', 'text')) return value as Action;
  if (value.type === 'assertVisible' && string(value.text) && value.text.length > 0 && exactKeys('type', 'text')) return value as Action;
  if (value.type === 'swipe' && ['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(value.direction as string) &&
      Number.isInteger(value.duration) && (value.duration as number) >= 100 && (value.duration as number) <= 10000 &&
      exactKeys('type', 'direction', 'duration')) return value as Action;
  if (value.type === 'takeScreenshot' && string(value.name, 80) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.name) &&
      exactKeys('type', 'name')) return value as Action;
  if (['tapOn', 'assertVisible'].includes(value.type)) {
    if (!snapshot || value.snapshotId !== snapshot.snapshotId) throw new Error('画面已过期，请刷新后重新选择控件。');
    if (string(value.nodeId, 300) && snapshot.nodes.some(node => node.nodeId === value.nodeId) &&
        exactKeys('type', 'snapshotId', 'nodeId')) return value as Action;
    if (value.type === 'tapOn' && object(value.point) && Object.keys(value.point).every(key => ['x', 'y'].includes(key)) &&
        Number.isInteger(value.point.x) && Number.isInteger(value.point.y) && (value.point.x as number) >= 0 &&
        (value.point.y as number) >= 0 && (value.point.x as number) < snapshot.width &&
        (value.point.y as number) < snapshot.height && exactKeys('type', 'snapshotId', 'point')) return value as Action;
  }
  throw new Error('操作参数无效。');
}
export function composeFlow(appId: string, steps: readonly string[]): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(appId)) throw new Error('应用 bundle 名称无效。');
  return `appId: ${JSON.stringify(appId)}\n---\n${steps.map(step => step.trimEnd()).join('\n')}\n`;
}
