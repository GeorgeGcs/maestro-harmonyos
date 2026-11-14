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

test('recorded clicks prefer an exact ID, then exact text, then the original point', () => {
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
  const id = JSON.parse(yaml.match(/^    id: (.+)$/m)![1]);
  assert.equal(id, 'app:id/save\\.button');
  const text = JSON.parse(yaml.match(/^    text: (.+)$/m)![1]);
  assert.equal(text, '确认 \\(¥5\\) "现在" \\$\\{PRICE\\}');
  assert.match(yaml, /point: "41,72"/);
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
  const { yaml } = importTouchRecording('com.example.sample', click + '\n' + click, tree);
  assert.match(yaml, /text: "打开"\n    childOf:\n      id: "card\\\\\.alpha"/);
  assert.equal(yaml.match(/childOf:/g)?.length, 1);
  assert.match(yaml, /缺少点击前的控件树/);
  const ambiguous = node({}, [first, node({ id: 'card.alpha' }, second.children)]);
  assert.match(importTouchRecording('com.example.sample', click, ambiguous).yaml, /point: "41,72"/);
});
