import { composeFlow, object } from './protocol';
import { literalSelector, matchesSelector, selectorCandidates as candidates, Selector } from './selector-preview';

function coordinate(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,5}$/.test(value))) return;
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0 && number <= 32767) return number;
}

type LayoutNode = { attributes: Record<string, unknown>; parent?: LayoutNode };
export interface TouchLayouts { initial?: unknown; after: Record<string, unknown> }
const layoutPath = /^\/data\/local\/tmp\/(layout_\d{10,20}_\d{1,6}\.json)$/;

export function touchLayoutName(path: unknown): string | undefined {
  return typeof path === 'string' ? layoutPath.exec(path)?.[1] : undefined;
}

function layoutNodes(tree: unknown): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  const pending: { tree: unknown; parent?: LayoutNode }[] = [{ tree }];
  while (pending.length) {
    const { tree: node, parent } = pending.pop()!;
    if (!object(node) || !object(node.attributes)) continue;
    const entry = { attributes: node.attributes, parent };
    nodes.push(entry);
    if (Array.isArray(node.children)) for (const child of node.children) pending.push({ tree: child, parent: entry });
  }
  return nodes;
}

function matches(selector: Selector, { attributes: a }: LayoutNode): boolean {
  return matchesSelector(selector, a.id || a.key, a.text, a.hint, a.accessibilityText, a.error);
}

function inside(node: LayoutNode, ancestor: LayoutNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

function readBounds(value: unknown): number[] | undefined {
  const match = typeof value === 'string' && /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(value);
  if (match) return match.slice(1).map(Number);
}

function contains(area: number[], x: number, y: number): boolean {
  return x >= area[0] && x < area[2] && y >= area[1] && y < area[3];
}

function clickCommand(finger: Record<string, unknown>, x: number, y: number, initialLayout: LayoutNode[]): string {
  const options = candidates(finger.W1_ID, finger.W1_Text);
  const point = `point: "${x},${y}"`;
  const selector = (target: Selector) => `${target.field}: ${literalSelector(target.value)}`;
  const command = (target: string, note?: string) =>
    `${note ? '# ' + note + '\n' : ''}- tapOn:\n    ${target}\n    retryTapIfNoChange: false`;
  if (!initialLayout.length) return command(point, options.length ? `缺少点击前的控件树，使用坐标。候选 ${selector(options[0])}` : undefined);

  const hit = readBounds(finger.W1_BOUNDS);
  const targets = hit && contains(hit, x, y) &&
    typeof finger.W1_HIER === 'string' && finger.W1_HIER.length > 0 ? initialLayout.filter(node =>
      node.attributes.hierarchy === finger.W1_HIER && node.attributes.bounds === finger.W1_BOUNDS &&
      (typeof finger.W1_Type !== 'string' || !finger.W1_Type || node.attributes.type === finger.W1_Type) &&
      options.every(option => matches(option, node))) : [];
  if (targets.length !== 1) return command(point, '点击目标无法和录制前的控件树对应，保留坐标。');
  const [target] = targets;
  for (const option of options) {
    const matching = initialLayout.filter(node => matches(option, node));
    if (matching.length === 1 && matching[0] === target) return command(selector(option));
    if (!matching.includes(target)) continue;
    for (let parent = target.parent; parent; parent = parent.parent) {
      const ancestor = parent;
      for (const scope of candidates(parent.attributes.id || parent.attributes.key, parent.attributes.text)) {
        const parents = initialLayout.filter(node => matches(scope, node));
        const children = matching.filter(node => inside(node, ancestor));
        if (parents.length === 1 && parents[0] === parent && children.length === 1 && children[0] === target) {
          return command(`${selector(option)}\n    childOf:\n      ${selector(scope)}`);
        }
      }
    }
  }
  // The center of a selected container must still hit the recorded child.
  for (let parent = target.parent; parent; parent = parent.parent) {
    const area = readBounds(parent.attributes.bounds);
    if (!area || !hit || !contains(hit, Math.floor((area[0] + area[2]) / 2), Math.floor((area[1] + area[3]) / 2))) continue;
    for (const option of candidates(parent.attributes.id || parent.attributes.key, parent.attributes.text)) {
      const matching = initialLayout.filter(node => matches(option, node));
      if (matching.length === 1 && matching[0] === parent) return command(selector(option));
    }
  }
  return command(point, options.length ? '找到多个匹配控件，保留坐标。' : '点击的控件没有可验证的选择器，保留坐标。');
}

export function importTouchRecording(appId: string, input: string, layouts?: TouchLayouts): { yaml: string; steps: number; skipped: number } {
  const commands: string[] = [];
  let skipped = 0;
  let before = layouts?.initial;
  let previousLayout: string | undefined;
  let firstEvent = true;
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(raw); }
    catch { throw new Error(`第 ${index + 1} 行不是 UITest JSON。请导入 uiRecord read 的输出。`); }
    const name = object(event) ? touchLayoutName(event.FILEPAHT) : undefined;
    const sameApp = object(event) && (event.BUNDLE === '' || event.BUNDLE === appId);
    const consecutive = previousLayout && name && previousLayout.slice(0, previousLayout.lastIndexOf('_')) === name.slice(0, name.lastIndexOf('_')) &&
      Number.parseInt(name.slice(name.lastIndexOf('_') + 1), 10) === Number.parseInt(previousLayout.slice(previousLayout.lastIndexOf('_') + 1), 10) + 1;
    const layout = firstEvent || consecutive ? layoutNodes(before) : [];
    before = sameApp && name && Object.hasOwn(layouts?.after ?? {}, name) ? layouts!.after[name] : undefined;
    previousLayout = sameApp ? name : undefined;
    firstEvent = false;
    if (!object(event) || event.EVENT_TYPE !== 'pointer' ||
        !sameApp ||
        ![1, '1'].includes(event.fingerNumber as string | number) ||
        !Array.isArray(event.fingerList) || event.fingerList.length !== 1 || !object(event.fingerList[0])) {
      skipped++;
      continue;
    }
    const finger = event.fingerList[0];
    const x = coordinate(finger.X_POSI), y = coordinate(finger.Y_POSI);
    if (x !== undefined && y !== undefined && event.OP_TYPE === 'click') {
      commands.push(clickCommand(finger, x, y, layout));
      continue;
    }
    const endX = coordinate(finger.X2_POSI), endY = coordinate(finger.Y2_POSI);
    const duration = typeof event.duration === 'number' ? Math.round(event.duration / 1_000_000) : 0;
    if (x !== undefined && y !== undefined && endX !== undefined && endY !== undefined &&
        (x !== endX || y !== endY) && (event.OP_TYPE === 'swipe' || event.OP_TYPE === 'fling') &&
        duration >= 1 && duration <= 10000) {
      commands.push(`- swipe:\n    start: "${x},${y}"\n    end: "${endX},${endY}"\n    duration: ${duration}`);
      continue;
    }
    skipped++;
  }
  if (!commands.length) throw new Error('录制中没有可导入的单指点击或滑动。');
  return { yaml: composeFlow(appId, commands), steps: commands.length, skipped };
}
