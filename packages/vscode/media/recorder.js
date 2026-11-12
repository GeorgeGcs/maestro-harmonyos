(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const element = id => document.getElementById(id);
  let state = { connected: false, busy: false, snapshot: null, steps: [], yaml: '' };
  let selectedNode = null;
  let selectedPoint = null;
  let lastSnapshotId = null;
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const action = data => { if (state.connected && !state.busy) send('action', { action: data }); };
  const selectNode = node => { selectedNode = node; paintSelection(); buttons(); };
  function label(node) { return node.resourceId || node.text || node.hintText || node.className || node.nodeId; }
  function buttons() {
    const ready = state.connected && !state.busy;
    element('connect').disabled = state.busy || state.connected;
    for (const id of ['disconnect', 'refresh', 'launch', 'back', 'inputAction', 'assertTextAction', 'swipe', 'screenshot']) element(id).disabled = !ready;
    element('tap').disabled = !ready || !selectedNode || !state.snapshot;
    element('assertNode').disabled = !ready || !selectedNode || !state.snapshot;
    element('coordinate').disabled = !ready || !selectedPoint || !state.snapshot;
    for (const id of ['save', 'replay', 'clear']) element(id).disabled = state.busy || !state.steps.length;
    element('artifacts').disabled = !state.artifactsDir;
    element('replayFailure').hidden = !state.hasReplayFailure;
    element('replayFailure').disabled = state.busy;
    element('stop').disabled = !state.busy && !state.connected;
  }
  function paintSelection() {
    const highlight = element('highlight');
    const marker = element('point');
    highlight.hidden = !selectedNode || !state.snapshot;
    marker.hidden = !selectedPoint || !state.snapshot;
    if (selectedNode && state.snapshot) {
      const { left, top, right, bottom } = selectedNode.bounds;
      const x = Math.max(0, left), y = Math.max(0, top);
      highlight.style.left = `${100 * x / state.snapshot.width}%`;
      highlight.style.top = `${100 * y / state.snapshot.height}%`;
      highlight.style.width = `${100 * Math.max(0, Math.min(right, state.snapshot.width) - x) / state.snapshot.width}%`;
      highlight.style.height = `${100 * Math.max(0, Math.min(bottom, state.snapshot.height) - y) / state.snapshot.height}%`;
      element('selection').textContent = `${label(selectedNode)} · ${selectedNode.className} · [${left}, ${top}, ${right}, ${bottom}]`;
    } else element('selection').textContent = selectedPoint ? `坐标 (${selectedPoint.x}, ${selectedPoint.y})；此处没有可选控件。` : '尚未选择控件';
    if (selectedPoint && state.snapshot) {
      marker.style.left = `${100 * selectedPoint.x / state.snapshot.width}%`;
      marker.style.top = `${100 * selectedPoint.y / state.snapshot.height}%`;
    }
    for (const button of element('nodes').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.nodeId === selectedNode?.nodeId));
  }
  element('screen').addEventListener('click', event => {
    if (!state.snapshot || state.busy) return;
    selectedPoint = HarmonyOSGeometry.pointInImage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), state.snapshot.width, state.snapshot.height);
    selectedNode = selectedPoint ? HarmonyOSGeometry.nodesAtPoint(state.snapshot.nodes, selectedPoint)[0] || null : null;
    paintSelection(); buttons();
  });
  for (const id of ['connect', 'disconnect', 'refresh', 'save', 'replay', 'replayFailure', 'clear', 'stop', 'artifacts']) element(id).addEventListener('click', () => send(id));
  element('launch').addEventListener('click', () => action({ type: 'launchApp' }));
  element('back').addEventListener('click', () => action({ type: 'back' }));
  element('tap').addEventListener('click', () => { if (selectedNode && state.snapshot) action({ type: 'tapOn', snapshotId: state.snapshot.snapshotId, nodeId: selectedNode.nodeId }); });
  element('assertNode').addEventListener('click', () => { if (selectedNode && state.snapshot) action({ type: 'assertVisible', snapshotId: state.snapshot.snapshotId, nodeId: selectedNode.nodeId }); });
  element('coordinate').addEventListener('click', () => { if (selectedPoint && state.snapshot) action({ type: 'tapOn', snapshotId: state.snapshot.snapshotId, point: selectedPoint }); });
  element('inputAction').addEventListener('click', () => action({ type: 'inputText', text: element('input').value }));
  element('assertTextAction').addEventListener('click', () => action({ type: 'assertVisible', text: element('assertText').value }));
  element('swipe').addEventListener('click', () => action({ type: 'swipe', direction: element('direction').value, duration: 600 }));
  element('screenshot').addEventListener('click', () => action({ type: 'takeScreenshot', name: element('screenshotName').value }));
  window.addEventListener('message', event => {
    if (!event.data || event.data.type !== 'state') return;
    state = event.data;
    element('status').textContent = state.message;
    element('status').classList.toggle('busy', state.busy);
    element('yaml').value = state.yaml;
    element('stepCount').textContent = `${state.steps.length} 步`;
    element('screen').hidden = !state.snapshot;
    element('empty').hidden = !!state.snapshot;
    element('dimensions').textContent = state.snapshot ? `${state.snapshot.width} × ${state.snapshot.height}` : '';
    if (lastSnapshotId !== state.snapshot?.snapshotId) {
      selectedNode = null; selectedPoint = null;
      lastSnapshotId = state.snapshot?.snapshotId;
      element('nodes').replaceChildren();
      if (state.snapshot) {
        element('screen').src = `data:image/png;base64,${state.snapshot.screenshot.base64}`;
        for (const node of state.snapshot.nodes) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'node'; button.dataset.nodeId = node.nodeId;
          button.textContent = `${node.parentId === null ? '' : '↳ '}${label(node)} · ${node.className}`;
          button.title = `ID: ${node.resourceId}\n文字: ${node.text}\n提示: ${node.hintText}`;
          button.addEventListener('click', () => { if (!state.busy) selectNode(node); });
          element('nodes').appendChild(button);
        }
      } else element('screen').removeAttribute('src');
    }
    element('nodeCount').textContent = state.snapshot ? `(${state.snapshot.nodes.length})` : '';
    paintSelection(); buttons();
  });
  buttons(); send('ready');
})();
