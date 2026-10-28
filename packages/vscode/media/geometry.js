(function (root) {
  'use strict';
  function pointInImage(x, y, display, width, height) {
    if (![x, y, display.left, display.top, display.right, display.bottom, width, height].every(Number.isFinite) ||
        display.right <= display.left || display.bottom <= display.top || width <= 0 || height <= 0 ||
        x < display.left || x >= display.right || y < display.top || y >= display.bottom) return null;
    return { x: Math.floor((x - display.left) * width / (display.right - display.left)),
      y: Math.floor((y - display.top) * height / (display.bottom - display.top)) };
  }
  function nodesAtPoint(nodes, point) {
    return nodes.filter(node => node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top &&
      point.x >= node.bounds.left && point.x < node.bounds.right && point.y >= node.bounds.top && point.y < node.bounds.bottom)
      .sort((a, b) => (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top) -
        (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top));
  }
  const api = { pointInImage, nodesAtPoint };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HarmonyOSGeometry = api;
})(typeof globalThis === 'object' ? globalThis : this);
