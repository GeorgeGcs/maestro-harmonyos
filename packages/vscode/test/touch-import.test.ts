import test from 'node:test';
import assert from 'node:assert/strict';
import { importTouchRecording } from '../src/touch-import';

test('imports a physical swipe even when UITest leaves the bundle blank, and skips foreign input', () => {
  const bundle = 'com.example.sample';
  const swipe = { EVENT_TYPE: 'pointer', BUNDLE: '', OP_TYPE: 'swipe', fingerNumber: '1',
    duration: 491924000, fingerList: [{ X_POSI: '704', Y_POSI: '1243', X2_POSI: '718', Y2_POSI: '977' }] };
  const click = { ...swipe, BUNDLE: bundle, OP_TYPE: 'click' };
  const fling = { ...swipe, OP_TYPE: 'fling', duration: 666864000,
    fingerList: [{ X_POSI: '500', Y_POSI: '1000', X2_POSI: '510', Y2_POSI: '760' }] };
  const input = [swipe, fling, { ...click, BUNDLE: 'com.example.other' }, click,
    { ...swipe, fingerNumber: '2' }, { ...click, fingerList: [{ X_POSI: '0,0', Y_POSI: '12' }] }]
    .map(event => JSON.stringify(event)).join('\r\n');
  const result = importTouchRecording(bundle, input);
  assert.equal(result.steps, 3);
  assert.equal(result.skipped, 3);
  assert.match(result.yaml, /start: "704,1243"\n    end: "718,977"\n    duration: 492/);
  assert.match(result.yaml, /start: "500,1000"\n    end: "510,760"\n    duration: 667/);
  assert.match(result.yaml, /tapOn:\n    point: "704,1243"/);
  assert.throws(() => importTouchRecording(bundle, 'console text'), /第 1 行/);
});

test('clicks without layout evidence keep coordinates and escaped selector suggestions', () => {
  const click = {
    EVENT_TYPE: 'pointer', BUNDLE: '', OP_TYPE: 'click', fingerNumber: '1',
  };
  const point = { X_POSI: '41', Y_POSI: '72' };
  const fingers = [
    { ...point, W1_ID: 'app:id/save.button', W1_Text: '保存' },
    { ...point, W1_ID: ' ', W1_Text: '确认 (¥5) "现在" ${PRICE}' },
    { ...point, W1_ID: 3, W1_Text: '\n' },
  ];
  const input = fingers.map(finger => JSON.stringify({ ...click, fingerList: [finger] })).join('\n');
  const { yaml, steps, skipped } = importTouchRecording('com.example.sample', input);
  assert.equal(steps, 3);
  assert.equal(skipped, 0);
  assert.equal(yaml.includes('保存'), false);
  const id = JSON.parse(yaml.match(/^# .*候选 id: (.+)$/m)![1]);
  assert.equal(id, 'app:id/save\\.button');
  const text = JSON.parse(yaml.match(/^# .*候选 text: (.+)$/m)![1]);
  assert.equal(text, '确认 \\(¥5\\) "现在" \\$\\{PRICE\\}');
  assert.match(yaml, /point: "41,72"/);
  assert.equal(yaml.match(/point: "41,72"/g)?.length, 3);
  assert.equal(yaml.match(/retryTapIfNoChange: false/g)?.length, 3);
});

test('scopes a duplicate click to a unique ancestor in the initial layout', () => {
  const bounds = '[0,0][60,100]';
  const click = JSON.stringify({
    EVENT_TYPE: 'pointer', BUNDLE: '', OP_TYPE: 'click', fingerNumber: 1,
    fingerList: [{ X_POSI: 41, Y_POSI: 72, W1_Text: '打开', W1_BOUNDS: bounds, W1_HIER: 'ROOT,1,0' }],
  });
  const node = (attributes: Record<string, unknown>, children: unknown[] = []) => ({ attributes, children });
  const first = node({ id: 'card.alpha' }, [node({ text: '打开', bounds, hierarchy: 'ROOT,1,0' })]);
  const second = node({ id: 'card.beta' }, [node({ text: '打开', bounds, hierarchy: 'ROOT,2,0' })]);
  const tree = node({}, [first, second]);
  const { yaml } = importTouchRecording('com.example.sample', click + '\n' + click, { initial: tree, after: {} });
  assert.match(yaml, /text: "打开"\n    childOf:\n      id: "card\\\\\.alpha"/);
  assert.equal(yaml.match(/childOf:/g)?.length, 1);
  assert.match(yaml, /缺少点击前的控件树/);
  const ambiguous = node({}, [first, node({ id: 'card.alpha' }, second.children)]);
  assert.match(importTouchRecording('com.example.sample', click, { initial: ambiguous, after: {} }).yaml, /point: "41,72"/);
});

test('takes layout evidence from the preceding consecutive action and verifies the new target', () => {
  const bundle = 'com.example.sample';
  const node = (id: string, hierarchy = 'ROOT,1') => ({ attributes: { id, hierarchy, type: 'Button', bounds: '[0,0][60,100]' } });
  const tree = (id: string) => ({ attributes: {}, children: [node(id)] });
  const file = (sequence: number) => `layout_1794600000000000_${sequence}.json`;
  const click = (sequence: number, id: string, owner = bundle, fields = {}) => JSON.stringify({
    EVENT_TYPE: 'pointer', BUNDLE: owner, OP_TYPE: 'click', fingerNumber: 1,
    FILEPAHT: `/data/local/tmp/${file(sequence)}`,
    fingerList: [{ X_POSI: 41, Y_POSI: 72, W1_ID: id, W1_Type: 'Button', W1_BOUNDS: '[0,0][60,100]', W1_HIER: 'ROOT,1', ...fields }],
  });
  const layouts = { initial: tree('start'), after: { [file(1)]: tree('next'), [file(2)]: tree('third'), [file(5)]: tree('leave') } };
  const events = [click(1, 'start'), click(2, 'next'), click(4, 'third'), click(5, 'leave', 'com.example.other'), click(6, 'leave')];
  const result = importTouchRecording(bundle, events.join('\n'), layouts);
  assert.equal(result.steps, 4);
  assert.equal(result.skipped, 1);
  assert.match(result.yaml, /tapOn:\n    id: "start"/);
  assert.match(result.yaml, /tapOn:\n    id: "next"/);
  assert.equal(result.yaml.match(/point: "41,72"/g)?.length, 2);
  const mismatched = click(2, 'next', bundle, { W1_Type: 'Image' });
  assert.match(importTouchRecording(bundle, [events[0], mismatched].join('\n'), layouts).yaml, /point: "41,72"/);
  const outOfBounds = click(1, 'start', bundle, { Y_POSI: 120 });
  assert.match(importTouchRecording(bundle, outOfBounds, layouts).yaml, /point: "41,120"/);
});

test('selects a uniquely identified container only when its center hits the recorded child', () => {
  const click = JSON.stringify({ EVENT_TYPE: 'pointer', BUNDLE: '', OP_TYPE: 'click', fingerNumber: 1,
    fingerList: [{ X_POSI: 45, Y_POSI: 45, W1_BOUNDS: '[30,30][60,60]', W1_HIER: 'ROOT,0,0', W1_Type: 'Image' }] });
  const child = { attributes: { type: 'Image', hierarchy: 'ROOT,0,0', bounds: '[30,30][60,60]' } };
  const tree = (bounds: string) => ({ attributes: { id: 'unique-tab', bounds }, children: [child] });
  const resolved = importTouchRecording('com.example.sample', click, { initial: tree('[10,10][90,90]'), after: {} });
  assert.match(resolved.yaml, /tapOn:\n    id: "unique-tab"/);
  const offset = importTouchRecording('com.example.sample', click, { initial: tree('[0,0][200,200]'), after: {} });
  assert.match(offset.yaml, /point: "45,45"/);
});
