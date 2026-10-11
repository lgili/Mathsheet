'use strict';
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const palette = ['#54c88c', '#f2b84b', '#70a8ff', '#d38cf1', '#ed8975', '#9cd35e'];
  function svg(tag, attributes = {}, label) {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (label !== undefined) element.textContent = label;
    return element;
  }
  function label(value) {
    if (Math.abs(value) < 1e-10) return '0';
    return Number(value.toPrecision(3)).toString();
  }
  function render(container, result) {
    container.replaceChildren();
    if (!result) return;
    if (result.status === 'error') {
      const message = document.createElement('p');
      message.className = 'plot-error';
      message.textContent = result.message;
      container.append(message);
      return;
    }
    const values = result.series.flatMap(series => series.points.map(point => point.y).filter(Number.isFinite));
    let ymin = Math.min(...values, 0);
    let ymax = Math.max(...values, 0);
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const pad = (ymax - ymin) * 0.08;
    ymin -= pad; ymax += pad;
    const width = 620, height = 320;
    const left = 61, right = 20, top = 18, bottom = 38;
    const pw = width - left - right, ph = height - top - bottom;
    const px = x => left + (x - result.min) / (result.max - result.min) * pw;
    const py = y => top + (ymax - y) / (ymax - ymin) * ph;
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Plot of ' + result.series.map(series => series.name).join(', ') });
    chart.append(svg('rect', { x: left, y: top, width: pw, height: ph, class: 'plot-frame' }));
    for (let i = 0; i <= 4; i++) {
      const x = result.min + (result.max - result.min) * i / 4;
      const y = ymin + (ymax - ymin) * i / 4;
      chart.append(svg('line', { x1: px(x), y1: top, x2: px(x), y2: top + ph, class: 'plot-grid' }));
      chart.append(svg('line', { x1: left, y1: py(y), x2: left + pw, y2: py(y), class: 'plot-grid' }));
      chart.append(svg('text', { x: px(x), y: height - 10, class: 'plot-tick', 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, label(x)));
      chart.append(svg('text', { x: left - 7, y: py(y) + 4, class: 'plot-tick', 'text-anchor': 'end' }, label(y)));
    }
    if (result.min <= 0 && result.max >= 0) chart.append(svg('line', { x1: px(0), y1: top, x2: px(0), y2: top + ph, class: 'plot-axis' }));
    if (ymin <= 0 && ymax >= 0) chart.append(svg('line', { x1: left, y1: py(0), x2: left + pw, y2: py(0), class: 'plot-axis' }));
    result.series.forEach((series, index) => {
      let path = '';
      let open = false;
      for (const point of series.points) {
        if (point.y === null) { open = false; continue; }
        path += (open ? 'L' : 'M') + px(point.x).toFixed(2) + ' ' + py(point.y).toFixed(2) + ' ';
        open = true;
      }
      chart.append(svg('path', { d: path, fill: 'none', stroke: palette[index % palette.length], 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }));
    });
    container.append(chart);
    const legend = document.createElement('div');
    legend.className = 'plot-legend';
    result.series.forEach((series, index) => {
      const item = document.createElement('span');
      item.style.color = palette[index % palette.length];
      item.textContent = '● ' + series.name;
      legend.append(item);
    });
    container.append(legend);
  }
  globalThis.MathPlot = { render };
})();
