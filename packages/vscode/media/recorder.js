(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const element = id => document.getElementById(id);
  let state = { connected: false, busy: false, snapshot: null, steps: [], yaml: '' };
  let selectedNode = null;
  let selectedPoint = null;
  let lastSnapshotId = null;
  let selectorPreview = null;
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const action = data => { if (state.connected && !state.busy) send('action', { action: data }); };
  const selectNode = node => {
    selectedNode = node;
    selectorPreview = null;
    paintSelection(); paintSelectorPreview(); buttons();
    if (node && state.snapshot) send('previewSelector', { snapshotId: state.snapshot.snapshotId, nodeId: node.nodeId });
  };
  function label(node) { return node.resourceId || node.text || node.hintText || node.className || node.nodeId; }
  function buttons() {
    const ready = state.connected && !state.busy;
    element('connect').disabled = state.busy || state.connected;
    for (const id of ['disconnect', 'refresh', 'launch', 'back', 'inputAction', 'assertTextAction', 'swipe', 'screenshot']) element(id).disabled = !ready;
    element('tap').disabled = !ready || !selectedNode || !state.snapshot;
    element('assertNode').disabled = !ready || !selectedNode || !state.snapshot;
    element('coordinate').disabled = !ready || !selectedPoint || !state.snapshot;
    element('copySelector').disabled = !ready || !selectorPreview?.selected?.unique;
    for (const id of ['save', 'replay', 'clear']) element(id).disabled = state.busy || !state.steps.length;
    element('artifacts').disabled = !state.artifactsDir;
    element('replayFailure').hidden = !state.hasReplayFailure;
    element('replayFailure').disabled = state.busy;
    element('stop').disabled = state.run?.active
      ? !state.run.canStop || state.run.status === '正在停止'
      : !state.busy && !state.connected;
    element('runFile').disabled = state.busy;
    element('startTouch').disabled = state.busy;
    element('stopTouch').disabled = !state.touch?.active || state.touch.stopping;
    element('replayTouch').disabled = state.busy || !state.touch?.canReplay;
    element('checkTouchSyntax').disabled = !state.touch?.canReplay;
    element('runArtifacts').disabled = !state.run?.artifacts;
    element('rerun').disabled = state.busy || !state.run?.release;
    element('runPreview').disabled = !state.run?.active || !state.run.canPreview || state.run.status === '正在停止';
    element('runEvidence').hidden = !state.run?.artifacts || state.run.active || state.run.status === '通过';
    element('exportEvidence').hidden = !state.canExportEvidence;
    element('exportEvidence').disabled = state.busy || state.exportingEvidence;
    element('artifacts').disabled = !state.artifactsDir && !state.run?.artifacts;
  }
  function paintRun(run) {
    element('runStatus').textContent = run
      ? run.status + (run.active ? '' : run.release ? ' · 设备已释放' : ' · 设备释放未确认')
      : '尚未运行';
    element('runReason').textContent = run?.status === '失败' ? run.failureReason || '' : '';
    element('runReason').hidden = !element('runReason').textContent;
    element('runPreview').checked = !!run?.preview;
    element('runPreviewStatus').hidden = !run?.preview || !!run.frame;
    element('runFrame').hidden = !run?.preview || !run.frame;
    const src = run?.preview && run.frame ? 'data:image/png;base64,' + run.frame : '';
    if (src && element('runFrame').getAttribute('src') !== src) element('runFrame').src = src;
    if (!src) element('runFrame').removeAttribute('src');
    if (!run) return;
    const flows = element('runFlows'), steps = element('runSteps');
    const key = JSON.stringify([run.progress.flows, run.progress.steps]);
    if (flows.dataset.key === key) return;
    flows.dataset.key = key;
    flows.replaceChildren(); steps.replaceChildren();
    for (const flow of run.progress.flows) {
      const li = document.createElement('li');
      li.textContent = flow.name + ' · ' + flow.state;
      const children = document.createElement('ul');
      for (const step of flow.subflows) {
        const item = document.createElement('li');
        item.textContent = `#${step.sequence + 1} ${step.child || '子 Flow'} · ${step.state}`;
        if (step.tryNo) item.textContent += ` · 第 ${step.tryNo} 次尝试`;
        children.append(item);
      }
      if (children.childElementCount) li.append(children);
      flows.append(li);
    }
    for (const step of run.progress.steps) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'secondary runStep';
      button.textContent = `#${step.sequence + 1} ${step.command.replace(/Command$/, '')} · ${step.state}`;
      if (step.tryNo) button.textContent += ` · 第 ${step.tryNo} 次尝试`;
      button.disabled = !step.source && step.state !== '失败';
      button.addEventListener('click', () => send('runStep', { id: step.id }));
      li.append(button); steps.append(li);
    }
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
    const matches = new Set(selectorPreview?.selected?.matches || []);
    for (const button of element('nodes').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.nodeId === selectedNode?.nodeId));
      button.classList.toggle('selector-match', matches.has(button.dataset.nodeId));
    }
  }
  function paintSelectorPreview() {
    element('selectorPreview').hidden = !selectorPreview || !selectedNode;
    const list = element('selectorCandidates');
    list.replaceChildren();
    if (selectorPreview && !selectorPreview.candidates.length) {
      const item = document.createElement('li');
      item.textContent = '当前控件没有可用的 ID 或文本。';
      list.append(item);
    }
    for (const candidate of selectorPreview?.candidates || []) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = `${candidate.yaml} · 控件树匹配 ${candidate.count} 项`;
      button.setAttribute('aria-pressed', String(candidate === selectorPreview.selected));
      button.addEventListener('click', () => {
        selectorPreview.selected = candidate;
        paintSelection(); paintSelectorPreview(); buttons();
        list.querySelector('[aria-pressed="true"]')?.focus();
      });
      item.append(button); list.append(item);
    }
  }
  element('screen').addEventListener('click', event => {
    if (!state.snapshot || state.busy) return;
    selectedPoint = HarmonyOSGeometry.pointInImage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), state.snapshot.width, state.snapshot.height);
    selectNode(selectedPoint ? HarmonyOSGeometry.nodesAtPoint(state.snapshot.nodes, selectedPoint)[0] || null : null);
  });
  element('copySelector').addEventListener('click', () => {
    if (selectedNode && selectorPreview?.selected?.unique) send('copySelector', {
      snapshotId: state.snapshot?.snapshotId, nodeId: selectedNode.nodeId, yaml: selectorPreview.selected.yaml,
    });
  });
  for (const id of ['connect', 'disconnect', 'refresh', 'save', 'replay', 'replayFailure', 'clear', 'stop', 'artifacts', 'runFile', 'rerun', 'startTouch', 'stopTouch', 'replayTouch', 'checkSyntax', 'checkTouchSyntax']) element(id).addEventListener('click', () => send(id));
  element('runPreview').addEventListener('change', event => send('runPreview', { enabled: event.currentTarget.checked }));
  element('runArtifacts').addEventListener('click', () => send('artifacts'));
  element('runEvidence').addEventListener('click', () => send('replayFailure'));
  element('exportEvidence').addEventListener('click', () => send('exportEvidence'));
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
    if (event.data?.type === 'selectorPreview') {
      const { snapshotId, nodeId, candidates } = event.data;
      if (snapshotId === state.snapshot?.snapshotId && nodeId === selectedNode?.nodeId) {
        selectorPreview = { candidates, selected: candidates.find(candidate => candidate.unique) || candidates[0] };
        paintSelection(); paintSelectorPreview(); buttons();
      }
      return;
    }
    if (event.data?.type === 'clearEvidence' || event.data?.type === 'stepEvidence') {
      const evidence = event.data;
      const panel = element('stepEvidence');
      panel.hidden = evidence.type === 'clearEvidence';
      element('evidenceHeading').textContent = evidence.stepLabel ? `步骤证据 · ${evidence.stepLabel}` : '步骤证据';
      element('evidenceReason').textContent = evidence.reason || (evidence.links?.length ? '' : '本步骤暂无可用产物。');
      const timing = element('evidenceTiming');
      timing.hidden = !Number.isSafeInteger(evidence.elapsedMs);
      timing.textContent = timing.hidden ? '' : `步骤耗时 ${(evidence.elapsedMs / 1000).toFixed(2)} 秒`;
      const waits = element('evidenceWaits');
      waits.replaceChildren();
      for (const wait of evidence.elementWaits || []) {
        const item = document.createElement('li');
        const condition = wait.condition === 'visible' ? '等待控件出现' : '等待控件消失';
        const result = wait.satisfied ? '条件满足' : '条件未满足';
        item.textContent = `${condition} · ${result} · 实际 ${wait.elapsedMs} ms / 查询预算 ${wait.budgetMs} ms`;
        waits.append(item);
      }
      waits.hidden = !waits.childElementCount;
      const faults = element('evidenceFaults');
      faults.replaceChildren();
      for (const fault of evidence.faultSummaries || []) {
        const item = document.createElement('li');
        item.textContent = fault;
        faults.append(item);
      }
      faults.hidden = !faults.childElementCount;
      element('evidenceSource').textContent = evidence.source || '';
      element('evidenceSource').hidden = !evidence.source;
      element('evidenceLog').textContent = evidence.log || '';
      element('evidenceLog').hidden = !evidence.log;
      const gallery = element('evidenceImages');
      gallery.replaceChildren();
      for (const item of evidence.images || []) {
        const frame = document.createElement('figure');
        const image = document.createElement('img');
        image.src = item.image;
        image.alt = item.label;
        const caption = document.createElement('figcaption');
        caption.textContent = item.label;
        frame.append(image, caption);
        gallery.append(frame);
      }
      gallery.hidden = !gallery.childElementCount;
      const links = element('evidenceLinks');
      links.replaceChildren();
      for (const [index, label] of (evidence.links || []).entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = label;
        button.addEventListener('click', () => send('openEvidence', { index, request: evidence.request }));
        links.append(button);
      }
      if (!panel.hidden) panel.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!event.data || event.data.type !== 'state') return;
    state = event.data;
    element('status').textContent = state.message;
    element('touchStatus').textContent = state.touch?.status ?? '';
    element('status').classList.toggle('busy', state.busy);
    element('yaml').value = state.yaml;
    element('stepCount').textContent = `${state.steps.length} 步`;
    element('screen').hidden = !state.snapshot;
    element('empty').hidden = !!state.snapshot;
    element('dimensions').textContent = state.snapshot ? `${state.snapshot.width} × ${state.snapshot.height}` : '';
    if (lastSnapshotId !== state.snapshot?.snapshotId) {
      selectedNode = null; selectedPoint = null; selectorPreview = null;
      paintSelectorPreview();
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
    paintRun(state.run); paintSelection(); buttons();
  });
  buttons(); send('ready');
})();
