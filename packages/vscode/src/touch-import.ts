import { composeFlow, object } from './protocol';

function coordinate(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,5}$/.test(value))) return;
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0 && number <= 32767) return number;
}

export function importTouchRecording(appId: string, input: string): { yaml: string; steps: number; skipped: number } {
  const commands: string[] = [];
  let skipped = 0;
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(raw); }
    catch { throw new Error(`第 ${index + 1} 行不是 UITest JSON。请导入 uiRecord read 的输出。`); }
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
      commands.push(`- tapOn:\n    point: "${x},${y}"\n    retryTapIfNoChange: false`);
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
