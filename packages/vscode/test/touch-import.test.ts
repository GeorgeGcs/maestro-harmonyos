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
