import { composeFlow, object } from './protocol';

function coordinate(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,5}$/.test(value))) return;
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0 && number <= 32767) return number;
}

function literalSelector(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return;
  // Maestro matches id and text as regexes. Escaping the braces also keeps
  // recorded text such as ${PRICE} from becoming a Maestro expression.
  return JSON.stringify(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

type Selector = { field: 'id' | 'text'; value: string };
type LayoutNode = { attributes: Record<string, unknown>; parent?: LayoutNode };

function candidates(id: unknown, text: unknown): Selector[] {
  const result: Selector[] = [];
  if (typeof id === 'string' && literalSelector(id) !== undefined) result.push({ field: 'id', value: id });
  if (typeof text === 'string' && literalSelector(text) !== undefined) result.push({ field: 'text', value: text });
  return result;
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

function matches({ field, value }: Selector, { attributes: a }: LayoutNode): boolean {
  if (field === 'id') {
    const id = a.id || a.key;
    return typeof id === 'string' && (id === value || id.split('/').at(-1) === value);
  }
  return [a.text, a.hint, a.accessibilityText, a.error].some(text =>
    typeof text === 'string' && (text === value || text.replace(/\n/g, ' ') === value));
}

function inside(node: LayoutNode, ancestor: LayoutNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

function clickCommand(finger: Record<string, unknown>, x: number, y: number, initialLayout: LayoutNode[]): string {
  const options = candidates(finger.W1_ID, finger.W1_Text);
  const point = `point: "${x},${y}"`;
  const selector = (target: Selector) => `${target.field}: ${literalSelector(target.value)}`;
  const command = (target: string, note?: string) =>
    `${note ? '# ' + note + '\n' : ''}- tapOn:\n    ${target}\n    retryTapIfNoChange: false`;
  if (!options.length) return command(point);
  if (!initialLayout.length) return command(selector(options[0]), '缺少点击前的控件树，请确认选择器只匹配一个控件。');

  const targets = initialLayout.filter(node => node.attributes.hierarchy === finger.W1_HIER &&
    node.attributes.bounds === finger.W1_BOUNDS && options.some(option => matches(option, node)));
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
  return command(point, '找到多个匹配控件，保留坐标。');
}

export function importTouchRecording(appId: string, input: string, initialLayout?: unknown): { yaml: string; steps: number; skipped: number } {
  const commands: string[] = [];
  let skipped = 0;
  let firstEvent = true;
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(raw); }
    catch { throw new Error(`第 ${index + 1} 行不是 UITest JSON。请导入 uiRecord read 的输出。`); }
    const layout = firstEvent ? layoutNodes(initialLayout) : [];
    firstEvent = false;
    if (!object(event) || event.EVENT_TYPE !== 'pointer' ||
        !(event.BUNDLE === '' || event.BUNDLE === appId) ||
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
