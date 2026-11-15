import { UiNode } from './protocol';

export type Selector = { field: 'id' | 'text'; value: string };

export function literalSelector(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return;
  // Escape the regex operators and the braces used in Maestro expressions.
  return JSON.stringify(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export function selectorCandidates(id: unknown, ...labels: unknown[]): Selector[] {
  const result: Selector[] = [];
  if (typeof id === 'string' && literalSelector(id) !== undefined) result.push({ field: 'id', value: id });
  for (const label of new Set(labels)) {
    if (typeof label === 'string' && literalSelector(label) !== undefined) result.push({ field: 'text', value: label });
  }
  return result;
}

export function matchesSelector({ field, value }: Selector, id: unknown, ...labels: unknown[]): boolean {
  if (field === 'id') return typeof id === 'string' && (id === value || id.split('/').at(-1) === value);
  return labels.some(label => typeof label === 'string' && (label === value || label.replace(/\n/g, ' ') === value));
}

export function previewSelectors(nodes: readonly UiNode[], target: UiNode) {
  return selectorCandidates(target.resourceId, target.text, target.hintText).map(selector => {
    const matched = nodes.filter(node => matchesSelector(selector, node.resourceId, node.text, node.hintText));
    return {
      yaml: `${selector.field}: ${literalSelector(selector.value)}`,
      count: matched.length,
      unique: matched.length === 1 && matched[0].nodeId === target.nodeId,
      matches: matched.slice(0, 200).map(node => node.nodeId),
    };
  });
}
