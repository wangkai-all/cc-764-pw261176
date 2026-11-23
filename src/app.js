/* checkpoint-lab UI 主逻辑 */
(function () {
  'use strict';
  const E = window.CkptEngine;
  const SC = window.CkptScenarios;
  const $ = (s) => document.querySelector(s);
  const fmt = (x, d) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(d == null ? 1 : d));

  const state = {
    key: 'diamond',
    ctx: null,
    manual: new Set(),
    inject: [],
    injectSaveFail: [],
    step: null,          // {result, idx, recoveryRanges}
    mc: null,            // 手动策略蒙特卡洛结果
    compare: null,       // [{name, policy, result}]
    opt: { exact: null, greedy: null, lb: null },
    playTimer: null,
  };

  /* ---------------- 场景装载 ---------------- */
  const PRESET = {
    diamond: ['B', 'C'],
    cascade: ['B', 'E'],
    diskfail: ['C'],
    random: [],
  };

  function loadScenario() {
    let raw;
    if (state.key === 'random') {
      const seed = Math.max(1, parseInt($('#inp-random-seed').value, 10) || 1);
      raw = SC.randomDag(seed, 9);
    } else {
      raw = SC[state.key];
    }
    state.ctx = E.prepare(raw);
    state.manual = new Set(PRESET[state.key] || []);
    state.step = null; state.mc = null; state.compare = null;
    state.opt = { exact: null, greedy: null, lb: null };
    stopPlay();

    $('#scenario-desc').textContent = raw.description || '';
    const totalSize = state.ctx.nodes.reduce((s, n) => s + n.size, 0);
    $('#scenario-meta').textContent =
      '节点 ' + state.ctx.nodes.length + ' · 边 ' + (raw.edges || []).length +
      ' · 存储上限 ' + (isFinite(state.ctx.storageCap) ? state.ctx.storageCap + ' MB' : '不限') +
      '（全部输出共 ' + totalSize + ' MB）· 单任务重试预算 ' + state.ctx.maxRetries +
      ' 次 · 写 ' + state.ctx.disk.writeMBs + ' MB/s · 读 ' + state.ctx.disk.readMBs +
      ' MB/s · 保存失败率 ' + (state.ctx.disk.saveFailProb * 100).toFixed(0) + '%';

    // 注入下拉
    const opts = ['<option value="">不注入</option>'].concat(
      state.ctx.nodes.map((n) => '<option value="' + n.id + '">' + n.id + '（第 1 次尝试）</option>')
    );
    $('#sel-inject-node').innerHTML = opts.join('');
    $('#sel-inject-save').innerHTML = opts.join('');
    updateInject();

    // 精确搜索按钮可用性
    const cands = state.ctx.nodes.filter((n) => state.ctx.relevant.has(n.id)).length;
    $('#btn-exact').disabled = cands > 12;
    $('#btn-exact').textContent = cands > 12
      ? '精确搜索（候选 ' + cands + ' > 12，不可用）'
      : '精确搜索（2^' + cands + ' 子集）';

    renderDag();
    renderStorageMeter();
    renderStats(null);
    $('#event-log').innerHTML = '';
    $('#histogram').innerHTML = '';
    $('#compare-time').innerHTML = ''; $('#compare-storage').innerHTML = ''; $('#compare-table').innerHTML = '';
    renderOptimizer();
    setStatus('场景已装载。点击 DAG 节点勾选检查点，然后运行。');
  }

  function seeds() {
    const base = Math.max(0, parseInt($('#inp-seed').value, 10) || 0);
    const n = Math.min(512, Math.max(4, parseInt($('#inp-sims').value, 10) || 64));
    return Array.from({ length: n }, (_, i) => base + i);
  }

  function updateInject() {
    const failNode = $('#sel-inject-node').value;
    const saveNode = $('#sel-inject-save').value;
    state.inject = failNode ? [{ node: failNode, attempt: 1 }] : [];
    state.injectSaveFail = saveNode ? [{ node: saveNode, occurrence: 1 }] : [];
    const parts = [];
    if (failNode) parts.push(failNode + ' 第 1 次尝试必失败');
    if (saveNode) parts.push(saveNode + ' 第 1 次保存必写盘失败');
    $('#chip-inject').hidden = parts.length === 0;
    $('#chip-inject').textContent = parts.join('；');
  }

  function setStatus(s) { $('#run-status').textContent = s; }

  /* ---------------- DAG 渲染 ---------------- */
  const NW = 124, NH = 58, GX = 56, GY = 34;

  function layout(ctx) {
    const depth = new Map();
    ctx.order.forEach((n) => {
      const ps = ctx.parents.get(n.id);
      depth.set(n.id, ps.length ? Math.max.apply(null, ps.map((p) => depth.get(p))) + 1 : 0);
    });
    const layers = new Map();
    ctx.order.forEach((n) => {
      const d = depth.get(n.id);
      if (!layers.has(d)) layers.set(d, []);
      layers.get(d).push(n.id);
    });
    const pos = new Map();
    layers.forEach((ids, d) => ids.forEach((id, i) => pos.set(id, { x: 24 + d * (NW + GX), y: 24 + i * (NH + GY) })));
    const maxD = Math.max.apply(null, Array.from(layers.keys()));
    const maxC = Math.max.apply(null, Array.from(layers.values()).map((a) => a.length));
    return { pos, w: 48 + (maxD + 1) * (NW + GX) - GX, h: 48 + maxC * (NH + GY) - GY };
  }

  let nodeStatus = {}; // id -> css 状态（步进时由事件快照驱动）

  function renderDag() {
    const ctx = state.ctx;
    const lay = layout(ctx);
    const svg = $('#dag');
    svg.setAttribute('width', lay.w);
    svg.setAttribute('height', lay.h);
    svg.setAttribute('viewBox', '0 0 ' + lay.w + ' ' + lay.h);
    const parts = [];
    // 边
    ctx.nodes.forEach((n) => {
      ctx.parents.get(n.id).forEach((p) => {
        const a = lay.pos.get(p), b = lay.pos.get(n.id);
        const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
        const mx = (x1 + x2) / 2;
        parts.push('<path class="edge" d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 + '"/>');
      });
    });
    // 节点
    ctx.nodes.forEach((n) => {
      const p = lay.pos.get(n.id);
      const hasCkpt = state.manual.has(n.id);
      const st = nodeStatus[n.id] || '';
      const cls = ['node', hasCkpt ? 'has-ckpt' : '', st].filter(Boolean).join(' ');
      const dur = E.meanDuration(n);
      parts.push(
        '<g class="' + cls + '" data-id="' + n.id + '" transform="translate(' + p.x + ',' + p.y + ')">' +
        '<rect class="body" width="' + NW + '" height="' + NH + '" rx="8"></rect>' +
        '<text x="10" y="21">' + n.id + (n.deterministic ? ' ≡' : '') + '</text>' +
        '<text class="n-sub" x="10" y="38">耗时~' + fmt(dur, 1) + 's · ' + n.size + 'MB · 败' + (n.failProb * 100).toFixed(0) + '%</text>' +
        '<text class="n-sub" x="10" y="51">' + (n.deterministic ? '确定性：重算版本不变' : '非确定性：重算版本变') + '</text>' +
        '<g class="ckpt-badge" transform="translate(' + (NW - 26) + ',4)">' +
        '<rect width="22" height="14" rx="3" fill="var(--s1)"></rect>' +
        '<text x="3" y="11" style="fill:#fff;font-size:9px">CK</text>' +
        '</g>' +
        '<title>' + n.id + '：点击' + (hasCkpt ? '取消' : '勾选') + '检查点</title>' +
        '</g>'
      );
    });
    svg.innerHTML = parts.join('');
    svg.querySelectorAll('.node').forEach((g) => {
      g.addEventListener('click', () => {
        const id = g.getAttribute('data-id');
        if (state.manual.has(id)) state.manual.delete(id); else state.manual.add(id);
        renderDag(); renderStorageMeter();
      });
    });
    // 图例（颜色 + 文字）
    $('#dag-legend').innerHTML = [
      ['', '待执行'], ['st-done', '已完成'], ['st-stored', '已存检查点'],
      ['st-running', '执行中'], ['st-failed', '失败'], ['st-restored', '已恢复'],
      ['st-stale', '已失效'],
    ].map(([c, t]) => '<span><span class="sw ' + c + '"></span>' + t + '</span>').join('') +
      '<span><span class="sw" style="border-color:var(--s1)"></span>CK = 勾选保存</span>';
  }

  function renderStorageMeter() {
    const used = E.policyStorage(state.ctx, state.manual);
    const cap = state.ctx.storageCap;
    const ratio = isFinite(cap) ? Math.min(1, used / cap) : (used > 0 ? 1 : 0);
    const fill = $('#storage-fill');
    fill.style.width = (ratio * 100).toFixed(1) + '%';
    fill.className = 'meter-fill' + (isFinite(cap) && used > cap ? ' over' : (ratio > 0.8 ? ' warn' : ''));
    $('#storage-text').textContent = used + ' / ' + (isFinite(cap) ? cap : '∞') + ' MB' +
      (isFinite(cap) && used > cap ? '（超出上限，优化器不会采纳）' : '');
  }

  /* ---------------- 单次运行与步进 ---------------- */
  function runSingle() {
    stopPlay();
    const r = E.simulate(state.ctx, state.manual, {
      seed: Math.max(0, parseInt($('#inp-seed').value, 10) || 0),
      trace: true, inject: state.inject, injectSaveFail: state.injectSaveFail,
    });
    // 标注恢复区间（崩溃 => 全部汇点完成）用于高亮重算链
    const ranges = [];
    let open = null;
    r.events.forEach((e, i) => {
      if (e.type === 'crash') open = i;
      if (open != null && i > open && state.ctx.sinks.every((s) => (e.state[s] || '').startsWith('done'))) {
        ranges.push([open, i]); open = null;
      }
    });
    if (open != null) ranges.push([open, r.events.length - 1]);
    state.step = { result: r, idx: -1, ranges };
    renderLog();
    stepTo(0);
    $('#btn-step-prev').disabled = false;
    $('#btn-step-next').disabled = r.events.length <= 1;
    $('#btn-step-play').disabled = r.events.length <= 1;
    renderStats(r);
    setStatus(r.ok
      ? '单次运行完成：总耗时 ' + fmt(r.totalTime) + 's，失败 ' + r.failures + ' 次，重算 ' + r.recomputes + ' 节点次。用"下一步"逐步查看重算链。'
      : '流水线失败：' + r.failReason + '（已耗时 ' + fmt(r.totalTime) + 's）');
  }

  function eventText(e) {
    switch (e.type) {
      case 'start': return '开始执行 ' + e.node + '（第 ' + e.attempt + ' 次尝试，耗时 ' + fmt(e.duration) + 's）';
      case 'finish': return e.node + ' 完成';
      case 'fail': return '✕ ' + e.node + ' 第 ' + e.attempt + ' 次尝试失败';
      case 'crash': return '⛔ 崩溃：未保存节点全部丢失' + (e.lost && e.lost.length ? '（' + e.lost.join(', ') + '）' : '');
      case 'restore': return '↩ 从检查点恢复 ' + e.node + '（读 ' + fmt(e.readTime) + 's）';
      case 'save': return '💾 保存 ' + e.node + '（写 ' + fmt(e.writeTime) + 's，当前存储 ' + fmt(e.storage, 0) + 'MB）';
      case 'save-fail': return '⚠ ' + e.node + ' 检查点写盘失败（写时延 ' + fmt(e.writeTime) + 's 照付）';
      case 'invalidate': return '✕ ' + e.node + ' 的检查点失效（前置输入已改变）';
      case 'stale': return '✕ ' + e.node + ' 的已完成输出过期（前置输入已改变）';
      case 'abort': return '⛔ 重试预算耗尽，流水线失败';
      default: return e.type + ' ' + (e.node || '');
    }
  }

  function renderLog() {
    const ol = $('#event-log');
    const st = state.step;
    ol.innerHTML = st.result.events.map((e, i) => {
      const inRecovery = st.ranges.some(([a, b]) => i >= a && i <= b);
      return '<li data-i="' + i + '" class="ev-' + e.type + (inRecovery ? ' recovery' : '') + '">' +
        '<span class="t">' + fmt(e.t, 1) + 's</span>' + eventText(e) + '</li>';
    }).join('');
    ol.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => stepTo(parseInt(li.getAttribute('data-i'), 10)));
    });
  }

  function stepTo(i) {
    const st = state.step;
    if (!st) return;
    const n = st.result.events.length;
    st.idx = Math.max(0, Math.min(n - 1, i));
    const e = st.result.events[st.idx];
    // 由事件快照驱动 DAG 状态
    nodeStatus = {};
    Object.keys(e.state).forEach((id) => {
      const s = e.state[id];
      nodeStatus[id] = s === 'done' || s === 'done+' ? 'st-done' : s === 'stored+' ? 'st-stored' : '';
    });
    // 当前事件节点强调
    if (e.node) {
      if (e.type === 'start') nodeStatus[e.node] = 'st-running';
      else if (e.type === 'fail' || e.type === 'abort') nodeStatus[e.node] = 'st-failed';
      else if (e.type === 'restore') nodeStatus[e.node] = 'st-restored';
      else if (e.type === 'invalidate' || e.type === 'stale') nodeStatus[e.node] = 'st-stale';
    }
    renderDag();
    $('#event-log').querySelectorAll('li').forEach((li) => {
      li.classList.toggle('cur', parseInt(li.getAttribute('data-i'), 10) === st.idx);
    });
    const cur = $('#event-log li.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    $('#btn-step-prev').disabled = st.idx <= 0;
    $('#btn-step-next').disabled = st.idx >= n - 1;
  }

  function stopPlay() {
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; $('#btn-step-play').textContent = '播放'; }
  }

  /* ---------------- 统计块 ---------------- */
  function renderStats(r) {
    const el = $('#stat-row');
    if (!r) { el.innerHTML = ''; return; }
    const isMC = r.mean != null;
    const items = isMC ? [
      ['平均总耗时', fmt(r.mean) + 's ± ' + fmt(r.ci95)],
      ['p50 / p95', fmt(r.p50) + ' / ' + fmt(r.p95) + 's'],
      ['流水线失败率', (r.failureRate * 100).toFixed(1) + '%'],
      ['平均重算', fmt(r.meanRecomputes) + ' 节点次'],
      ['平均写/读时间', fmt(r.meanWriteTime) + ' / ' + fmt(r.meanReadTime) + 's'],
      ['平均/峰值存储', fmt(r.meanStorage, 0) + ' / ' + fmt(r.meanPeakStorage, 0) + 'MB'],
    ] : [
      ['总耗时', fmt(r.totalTime) + 's'],
      ['计算/写/读', fmt(r.computeTime) + ' / ' + fmt(r.writeTime) + ' / ' + fmt(r.readTime) + 's'],
      ['失败次数', String(r.failures)],
      ['重算', r.recomputes + ' 节点次'],
      ['存储占用', fmt(r.storageUsed, 0) + 'MB（峰值 ' + fmt(r.peakStorage, 0) + '）'],
      ['结果', r.ok ? '成功' : '失败'],
    ];
    el.innerHTML = items.map(([k, v]) =>
      '<div class="stat"><div class="k">' + k + '</div><div class="v' + (String(v).length > 12 ? ' small' : '') + '">' + v + '</div></div>'
    ).join('');
  }

  /* ---------------- 蒙特卡洛 + 直方图 ---------------- */
  function runMC() {
    const r = E.evaluatePolicy(state.ctx, state.manual, seeds(), {
      inject: state.inject, injectSaveFail: state.injectSaveFail,
    });
    state.mc = r;
    renderStats(r);
    renderHistogram(r.totals);
    setStatus('手动策略 [' + Array.from(state.manual).join(', ') + '] 蒙特卡洛完成（' + r.runs + ' 次，种子配对）。');
  }

  function renderHistogram(totals) {
    const host = $('#histogram');
    if (!totals || !totals.length) { host.innerHTML = ''; return; }
    const W = 560, H = 200, PL = 44, PB = 30, PT = 12, PR = 12;
    const min = Math.min.apply(null, totals), max = Math.max.apply(null, totals);
    const span = (max - min) || 1;
    const nb = Math.min(16, Math.max(6, Math.round(Math.sqrt(totals.length))));
    const bins = new Array(nb).fill(0);
    totals.forEach((v) => {
      let k = Math.floor((v - min) / span * nb);
      if (k >= nb) k = nb - 1;
      bins[k]++;
    });
    const bmax = Math.max.apply(null, bins);
    const iw = (W - PL - PR) / nb;
    const y = (c) => H - PB - (c / bmax) * (H - PT - PB);
    const parts = ['<svg width="' + W + '" height="' + H + '" role="img" aria-label="总耗时直方图">'];
    // 网格线 + y 轴刻度（整洁数字）
    const step = Math.max(1, Math.round(bmax / 4));
    for (let c = 0; c <= bmax; c += step) {
      parts.push('<line class="gridline" x1="' + PL + '" y1="' + y(c) + '" x2="' + (W - PR) + '" y2="' + y(c) + '"/>');
      parts.push('<text class="axis-text" x="' + (PL - 6) + '" y="' + (y(c) + 4) + '" text-anchor="end">' + c + '</text>');
    }
    parts.push('<line class="baseline" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '"/>');
    bins.forEach((c, k) => {
      if (c === 0) return;
      const bx = PL + k * iw + 1;           // 相邻柱之间 2px 表面间隙
      const bw = Math.max(2, Math.min(24, iw - 2)); // 柱宽上限 24px
      const cx = bx + (iw - 2 - bw) / 2;
      const by = y(c), bh = H - PB - by;
      const lo = min + k / nb * span, hi = min + (k + 1) / nb * span;
      parts.push('<path class="hbar" data-lo="' + lo.toFixed(1) + '" data-hi="' + hi.toFixed(1) + '" data-c="' + c + '"' +
        ' fill="var(--s1)" d="M' + cx + ' ' + (H - PB) + ' L' + cx + ' ' + (by + 4) +
        ' Q' + cx + ' ' + by + ' ' + (cx + 4) + ' ' + by + ' L' + (cx + bw - 4) + ' ' + by +
        ' Q' + (cx + bw) + ' ' + by + ' ' + (cx + bw) + ' ' + (by + 4) + ' L' + (cx + bw) + ' ' + (H - PB) + ' Z"/>');
    });
    parts.push('<text class="axis-text" x="' + PL + '" y="' + (H - 8) + '">' + fmt(min) + 's</text>');
    parts.push('<text class="axis-text" x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end">' + fmt(max) + 's</text>');
    parts.push('</svg>');
    parts.push('<p class="chart-title">总耗时分布（' + totals.length + ' 次模拟，单系列，悬停查看区间计数）</p>');
    host.innerHTML = parts.join('');
    host.querySelectorAll('.hbar').forEach((b) => {
      b.addEventListener('mousemove', (ev) => {
        showTooltip(ev, '总耗时 ' + b.getAttribute('data-lo') + '–' + b.getAttribute('data-hi') + 's：' + b.getAttribute('data-c') + ' 次');
      });
      b.addEventListener('mouseleave', hideTooltip);
    });
  }

  /* ---------------- 策略配对对比 ---------------- */
  function runCompare() {
    const ss = seeds();
    const list = [
      { name: '无检查点', policy: new Set() },
      { name: '手动策略', policy: new Set(state.manual) },
    ];
    if (state.opt.greedy) list.push({ name: '贪心（上界）', policy: new Set(state.opt.greedy.bestPolicy) });
    if (state.opt.exact && state.opt.exact.tractable) list.push({ name: '精确最优', policy: new Set(state.opt.exact.bestPolicy) });
    state.compare = list.map((it) => ({
      name: it.name,
      policy: Array.from(it.policy).join(', ') || '（空）',
      result: E.evaluatePolicy(state.ctx, it.policy, ss),
    }));
    renderCompare();
    setStatus('配对对比完成：所有策略使用同一组 ' + ss.length + ' 个种子。');
  }

  function barChart(hostId, entries, valueFn, unit, color) {
    const host = $(hostId);
    const W = 560, H = 190, PL = 44, PB = 44, PT = 10, PR = 12;
    const vmax = Math.max.apply(null, entries.map(valueFn)) || 1;
    const iw = (W - PL - PR) / entries.length;
    const y = (v) => H - PB - (v / vmax) * (H - PT - PB);
    const parts = ['<svg width="' + W + '" height="' + H + '">'];
    const step = Math.pow(10, Math.floor(Math.log10(vmax / 3))) ;
    const tstep = (vmax / 4 > step * 2.5) ? step * 5 : (vmax / 4 > step ? step * 2 : step);
    for (let v = 0; v <= vmax * 1.001; v += tstep) {
      parts.push('<line class="gridline" x1="' + PL + '" y1="' + y(v) + '" x2="' + (W - PR) + '" y2="' + y(v) + '"/>');
      parts.push('<text class="axis-text" x="' + (PL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + fmt(v, vmax < 10 ? 1 : 0) + '</text>');
    }
    parts.push('<line class="baseline" x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '"/>');
    entries.forEach((e, i) => {
      const v = valueFn(e);
      const bw = Math.min(24, iw - 2);
      const cx = PL + i * iw + (iw - bw) / 2;
      const by = y(v);
      parts.push('<path class="cbar" data-i="' + i + '" fill="' + color + '" d="M' + cx + ' ' + (H - PB) + ' L' + cx + ' ' + (by + 4) +
        ' Q' + cx + ' ' + by + ' ' + (cx + 4) + ' ' + by + ' L' + (cx + bw - 4) + ' ' + by +
        ' Q' + (cx + bw) + ' ' + by + ' ' + (cx + bw) + ' ' + (by + 4) + ' L' + (cx + bw) + ' ' + (H - PB) + ' Z"/>');
      parts.push('<text class="bar-label" x="' + (cx + bw / 2) + '" y="' + (by - 5) + '" text-anchor="middle">' + fmt(v) + unit + '</text>');
      parts.push('<text class="axis-text" x="' + (PL + i * iw + iw / 2) + '" y="' + (H - PB + 16) + '" text-anchor="middle">' + e.name + '</text>');
    });
    parts.push('</svg>');
    host.innerHTML = parts.join('');
    host.querySelectorAll('.cbar').forEach((b) => {
      const e = entries[parseInt(b.getAttribute('data-i'), 10)];
      b.addEventListener('mousemove', (ev) => showTooltip(ev, e.name + '：' + fmt(valueFn(e)) + unit));
      b.addEventListener('mouseleave', hideTooltip);
    });
  }

  function renderCompare() {
    const rows = state.compare;
    if (!rows) return;
    barChart('#compare-time', rows, (r) => r.result.mean, 's', 'var(--s1)');
    barChart('#compare-storage', rows, (r) => r.result.meanPeakStorage, 'MB', 'var(--s2)');
    $('#compare-table').innerHTML =
      '<table class="data"><thead><tr><th>策略</th><th>检查点</th><th>平均总耗时 (s)</th><th>±95%CI</th><th>p95 (s)</th><th>失败率</th><th>峰值存储 (MB)</th><th>平均重算</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td>' + r.name + '</td><td>' + r.policy + '</td><td>' + fmt(r.result.mean) + '</td><td>' + fmt(r.result.ci95) +
        '</td><td>' + fmt(r.result.p95) + '</td><td>' + (r.result.failureRate * 100).toFixed(1) + '%</td><td>' + fmt(r.result.meanPeakStorage, 0) +
        '</td><td>' + fmt(r.result.meanRecomputes) + '</td></tr>').join('') +
      '</tbody></table>' +
      '<p class="chart-title">左：平均总耗时（越短越好）；右：峰值存储（单位不同，分图展示，不用双轴）。数值同时以表格给出。</p>';
  }

  /* ---------------- 优化器 ---------------- */
  function runExact() {
    setStatus('精确搜索中…');
    setTimeout(() => {
      state.opt.exact = E.optimizeExact(state.ctx, seeds());
      renderOptimizer();
      setStatus(state.opt.exact.tractable
        ? '精确搜索完成：评估 ' + state.opt.exact.evaluated + ' 个可行子集（跳过超上限 ' + state.opt.exact.skipped + ' 个），结果为该口径下的真实最优。'
        : '精确搜索不可行：' + state.opt.exact.reason);
    }, 10);
  }
  function runGreedy() {
    setStatus('贪心搜索中…');
    setTimeout(() => {
      state.opt.greedy = E.optimizeGreedy(state.ctx, seeds());
      renderOptimizer();
      setStatus('贪心完成（注意：贪心是可行上界，不保证最优）。');
    }, 10);
  }
  function runLB() {
    state.opt.lb = E.lowerBound(state.ctx, seeds());
    renderOptimizer();
    setStatus('松弛下界完成：' + state.opt.lb.note + '。');
  }

  function renderOptimizer() {
    const o = state.opt;
    const host = $('#bounds');
    const pts = [];
    if (o.lb) pts.push({ name: '松弛下界', v: o.lb.mean, color: 'var(--s3)' });
    if (o.exact && o.exact.tractable) pts.push({ name: '精确最优', v: o.exact.best.mean, color: 'var(--s1)' });
    if (o.greedy) pts.push({ name: '贪心上界', v: o.greedy.best.mean, color: 'var(--s2)' });
    if (state.mc) pts.push({ name: '手动策略', v: state.mc.mean, color: 'var(--s4)' });

    if (!pts.length) {
      host.innerHTML = '<p class="bounds-note">尚未运行优化。建议顺序：贪心 → 精确（若可用）→ 下界，然后比较区间。</p>';
      $('#optimizer-table').innerHTML = '';
      $('#btn-apply').disabled = true;
      return;
    }
    const lo = Math.min.apply(null, pts.map((p) => p.v));
    const hi = Math.max.apply(null, pts.map((p) => p.v));
    const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;
    const x0 = lo - pad, x1 = hi + pad;
    const W = 560, H = 86, y = 40;
    const X = (v) => 30 + (v - x0) / (x1 - x0) * (W - 60);
    let svg = '<svg width="' + W + '" height="' + H + '">';
    svg += '<line class="baseline" x1="30" y1="' + y + '" x2="' + (W - 30) + '" y2="' + y + '"/>';
    if (o.lb && o.greedy) {
      svg += '<rect x="' + X(o.lb.mean) + '" y="' + (y - 5) + '" width="' + (X(o.greedy.best.mean) - X(o.lb.mean)) + '" height="10" fill="var(--s1)" opacity="0.12"/>';
    }
    pts.forEach((p) => {
      svg += '<circle cx="' + X(p.v) + '" cy="' + y + '" r="6" fill="' + p.color + '" stroke="var(--surface-1)" stroke-width="2"/>';
    });
    svg += '</svg>';
    host.innerHTML = '<div class="bounds-line">' + svg + '</div>' +
      '<div class="legend-chart">' + pts.map((p) =>
        '<span><span class="sw" style="background:' + p.color + '"></span>' + p.name + ' ' + fmt(p.v) + 's</span>').join('') + '</div>' +
      boundsNote();

    // 表格
    const rows = [];
    if (o.exact && o.exact.tractable) {
      o.exact.top.forEach((t, i) => rows.push({
        name: i === 0 ? '精确最优' : '精确 #' + (i + 1), policy: t.policy.join(', ') || '（空）',
        mean: t.mean, storage: t.storage, best: i === 0,
      }));
    }
    if (o.greedy) rows.push({ name: '贪心（上界）', policy: o.greedy.bestPolicy.join(', ') || '（空）', mean: o.greedy.best.mean, storage: o.greedy.storage, best: false });
    if (o.lb) rows.push({ name: '松弛下界（不可达）', policy: '（全部节点，零成本假设）', mean: o.lb.mean, storage: null, best: false });
    $('#optimizer-table').innerHTML =
      '<table class="data"><thead><tr><th>口径</th><th>检查点集合</th><th>平均总耗时 (s)</th><th>存储 (MB)</th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="' + (r.best ? 'best' : '') + '"><td>' + r.name + '</td><td>' + r.policy + '</td><td>' + fmt(r.mean) +
        '</td><td>' + (r.storage == null ? '—' : fmt(r.storage, 0)) + '</td></tr>').join('') +
      '</tbody></table>';
    $('#btn-apply').disabled = !(o.exact && o.exact.tractable) && !o.greedy;
  }

  function boundsNote() {
    const o = state.opt;
    const lb = o.lb ? o.lb.mean : null;
    const ub = o.greedy ? o.greedy.best.mean : null;
    const ex = o.exact && o.exact.tractable ? o.exact.best.mean : null;
    let s = '';
    if (lb != null && ub != null) {
      s += '区间 [' + fmt(lb) + ', ' + fmt(ub) + ']s，相对间隙 ' + (((ub - lb) / lb) * 100).toFixed(1) + '%。';
    }
    if (ex != null) {
      s += ' 精确最优 = ' + fmt(ex) + 's（上界=下界=最优）。';
      if (ub != null) s += ' 贪心与最优差距 ' + (((ub - ex) / ex) * 100).toFixed(1) + '%。';
    } else if (ub != null) {
      s += ' 精确最优未知（未运行或规模超限），贪心仅为上界，不得当作最优。';
    }
    return '<p class="bounds-note">' + s + '</p>';
  }

  /* ---------------- 提示框 ---------------- */
  const tip = () => $('#tooltip');
  function showTooltip(ev, text) {
    const t = tip();
    t.textContent = text;
    t.hidden = false;
    t.style.left = Math.min(window.innerWidth - 280, ev.clientX + 12) + 'px';
    t.style.top = (ev.clientY + 14) + 'px';
  }
  function hideTooltip() { tip().hidden = true; }

  /* ---------------- 事件绑定 ---------------- */
  $('#sel-scenario').addEventListener('change', (e) => {
    state.key = e.target.value;
    $('#lbl-random-seed').hidden = state.key !== 'random';
    loadScenario();
  });
  $('#inp-random-seed').addEventListener('change', loadScenario);
  $('#sel-inject-node').addEventListener('change', updateInject);
  $('#sel-inject-save').addEventListener('change', updateInject);
  $('#btn-single').addEventListener('click', runSingle);
  $('#btn-mc').addEventListener('click', runMC);
  $('#btn-step-prev').addEventListener('click', () => stepTo(state.step.idx - 1));
  $('#btn-step-next').addEventListener('click', () => stepTo(state.step.idx + 1));
  $('#btn-step-play').addEventListener('click', () => {
    if (state.playTimer) { stopPlay(); return; }
    $('#btn-step-play').textContent = '暂停';
    state.playTimer = setInterval(() => {
      if (!state.step || state.step.idx >= state.step.result.events.length - 1) { stopPlay(); return; }
      stepTo(state.step.idx + 1);
    }, 450);
  });
  $('#btn-compare').addEventListener('click', runCompare);
  $('#btn-exact').addEventListener('click', runExact);
  $('#btn-greedy').addEventListener('click', runGreedy);
  $('#btn-lb').addEventListener('click', runLB);
  $('#btn-apply').addEventListener('click', () => {
    const o = state.opt;
    const best = (o.exact && o.exact.tractable) ? o.exact.bestPolicy : (o.greedy ? o.greedy.bestPolicy : null);
    if (!best) return;
    state.manual = new Set(best);
    renderDag(); renderStorageMeter();
    setStatus('已采用推荐策略：[' + best.join(', ') + ']（' + ((o.exact && o.exact.tractable) ? '精确最优' : '贪心上界') + '）。');
  });

  loadScenario();
})();
