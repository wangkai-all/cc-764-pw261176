/*
 * checkpoint-lab 引擎：任务 DAG 的检查点/重算成本推演。
 *
 * 模型语义（崩溃-恢复）：
 *  - 任务按依赖顺序执行；任务失败视为进程崩溃：所有未保存（无有效检查点）的
 *    完成节点输出丢失，只有磁盘上的有效检查点幸存。
 *  - 恢复时从汇点反向确定"需要集合"：被有效检查点覆盖的子树不重算，共享上游
 *    在整个恢复集合中只执行/恢复一次（并集，而非每条下游路径各算一次）。
 *  - 每个输出带版本。非确定性任务重算产生新版本；确定性任务在输入不变时版本
 *    不变。检查点记录其输入版本，仅当前置输入一致时可复用，否则按依赖失效。
 *  - 保存检查点本身有写入开销，且可能写盘失败（saveFailProb / 注入）。
 *  - 重试预算：每个任务全流水线累计尝试次数上限 maxRetries，超出则流水线失败。
 *
 * 该文件为 UMD：浏览器挂到 window.CkptEngine，Node 直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CkptEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 随机数 ---------------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampleDuration(node, rng) {
    const d = node.duration;
    if (typeof d === 'number') return d;
    if (!d || d.dist === 'fixed') return (d && d.value != null) ? d.value : 0;
    if (d.dist === 'uniform') return d.a + rng() * (d.b - d.a);
    if (d.dist === 'lognormal') {
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.exp(d.mu + d.sigma * z);
    }
    throw new Error('未知耗时分布: ' + JSON.stringify(d));
  }

  function meanDuration(node) {
    const d = node.duration;
    if (typeof d === 'number') return d;
    if (!d || d.dist === 'fixed') return (d && d.value != null) ? d.value : 0;
    if (d.dist === 'uniform') return (d.a + d.b) / 2;
    if (d.dist === 'lognormal') return Math.exp(d.mu + d.sigma * d.sigma / 2);
    return 0;
  }

  /* ---------------- 场景规范化 ---------------- */
  function prepare(scenario) {
    if (!scenario || !Array.isArray(scenario.nodes) || scenario.nodes.length === 0) {
      throw new Error('场景缺少节点');
    }
    const byId = new Map();
    const nodes = scenario.nodes.map((n) => {
      if (!n.id) throw new Error('节点缺少 id');
      if (byId.has(n.id)) throw new Error('节点 id 重复: ' + n.id);
      const node = {
        id: n.id,
        label: n.label || n.id,
        duration: n.duration != null ? n.duration : 1,
        size: n.size != null ? n.size : 0,
        failProb: n.failProb != null ? n.failProb : 0,
        deterministic: !!n.deterministic,
      };
      byId.set(node.id, node);
      return node;
    });
    const parents = new Map(nodes.map((n) => [n.id, []]));
    const children = new Map(nodes.map((n) => [n.id, []]));
    (scenario.edges || []).forEach(([a, b]) => {
      if (!byId.has(a) || !byId.has(b)) throw new Error('边引用了不存在的节点: ' + a + '->' + b);
      parents.get(b).push(a);
      children.get(a).push(b);
    });

    // Kahn 拓扑排序（按声明顺序打破并列）
    const indeg = new Map(nodes.map((n) => [n.id, parents.get(n.id).length]));
    const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(byId.get(id));
      children.get(id).forEach((c) => {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) queue.push(c);
      });
    }
    if (order.length !== nodes.length) throw new Error('依赖图存在环');

    const sinks = scenario.sinks
      ? scenario.sinks.slice()
      : nodes.filter((n) => children.get(n.id).length === 0).map((n) => n.id);
    sinks.forEach((s) => { if (!byId.has(s)) throw new Error('汇点不存在: ' + s); });

    // 相关集合：能到达汇点的节点（其余节点永远不会被执行）
    const relevant = new Set();
    const stack = sinks.slice();
    while (stack.length) {
      const id = stack.pop();
      if (relevant.has(id)) continue;
      relevant.add(id);
      parents.get(id).forEach((p) => stack.push(p));
    }

    const disk = Object.assign({ writeMBs: 10, readMBs: 20, saveFailProb: 0 }, scenario.disk || {});
    return {
      name: scenario.name || 'scenario',
      description: scenario.description || '',
      nodes, byId, parents, children, order, sinks, relevant,
      disk,
      storageCap: scenario.storageCap != null ? scenario.storageCap : Infinity,
      maxRetries: scenario.maxRetries != null ? scenario.maxRetries : 3,
    };
  }

  /* ---------------- 单次模拟 ---------------- */
  /*
   * opts:
   *  seed            随机种子（同一种子 => 完全可复现）
   *  trace           是否记录事件流（逐步查看用；优化器关闭以提速）
   *  relaxed         松弛模式（下界用）：读写零成本、保存必成功
   *  inject          [{node, attempt}] 指定节点第 attempt 次尝试必失败
   *  injectSaveFail  [{node, occurrence}] 指定节点第 occurrence 次保存必写盘失败
   *  maxEvents       事件数安全上限
   */
  function simulate(ctx, policy, opts) {
    opts = opts || {};
    const rng = mulberry32((opts.seed == null ? 1 : opts.seed) >>> 0);
    const relaxed = !!opts.relaxed;
    const trace = !!opts.trace;
    const maxEvents = opts.maxEvents || 20000;
    const policySet = policy instanceof Set ? policy : new Set(policy || []);

    const inject = new Map();
    (opts.inject || []).forEach((j) => {
      if (!inject.has(j.node)) inject.set(j.node, new Set());
      inject.get(j.node).add(j.attempt);
    });
    const injectSave = new Map();
    (opts.injectSaveFail || []).forEach((j) => {
      if (!injectSave.has(j.node)) injectSave.set(j.node, new Set());
      injectSave.get(j.node).add(j.occurrence);
    });

    const st = new Map();
    ctx.nodes.forEach((n) => st.set(n.id, {
      id: n.id, status: 'pending', version: null, inputVersions: null,
      ckpt: null, attempts: 0, runs: 0, saves: 0,
    }));

    let t = 0, computeTime = 0, writeTime = 0, readTime = 0, failures = 0;
    let storage = 0, peakStorage = 0;
    let ok = true, failReason = null;
    const events = [];

    function snapshot() {
      const s = {};
      for (const n of ctx.nodes) {
        const x = st.get(n.id);
        s[n.id] = x.status + (x.ckpt ? '+' : '');
      }
      return s;
    }
    function ev(type, nodeId, data) {
      if (!trace) return;
      events.push(Object.assign(
        { seq: events.length, t, type, node: nodeId || null, state: snapshot() },
        data || {}
      ));
      if (events.length > maxEvents) throw new Error('事件数超过上限（疑似配置错误）');
    }

    function inputsMatch(x) {
      if (!x.inputVersions) return false;
      const ps = ctx.parents.get(x.id);
      for (let i = 0; i < ps.length; i++) {
        if (st.get(ps[i]).version !== x.inputVersions[ps[i]]) return false;
      }
      return true;
    }
    function ckptValid(x) {
      if (!x.ckpt) return false;
      const ps = ctx.parents.get(x.id);
      for (let i = 0; i < ps.length; i++) {
        if (st.get(ps[i]).version !== x.ckpt.inputVersions[ps[i]]) return false;
      }
      return true;
    }
    function dropCkpt(x, why) {
      if (x.ckpt) {
        storage -= x.ckpt.size;
        x.ckpt = null;
        ev('invalidate', x.id, { why });
      }
    }
    function computeVersion(node, x) {
      if (node.deterministic) {
        const pv = ctx.parents.get(node.id).map((p) => st.get(p).version).join('|');
        return 'd:' + node.id + '<' + pv + '>';
      }
      return 'n:' + node.id + '#' + x.runs;
    }

    // 失效传播：任何重算之后，检查所有完成/已存节点的前置一致性。
    // 失效本身不改变版本，单趟拓扑序即可收敛。
    function propagateInvalidation() {
      for (const node of ctx.order) {
        const x = st.get(node.id);
        if (x.status === 'done' && x.inputVersions && !inputsMatch(x)) {
          dropCkpt(x, 'inputs-changed');
          x.status = 'pending';
          ev('stale', x.id, {});
        } else if (x.status === 'stored' && !ckptValid(x)) {
          dropCkpt(x, 'inputs-changed');
          x.status = 'pending';
        }
      }
    }

    function crash() {
      const lost = [];
      for (const n of ctx.nodes) {
        const x = st.get(n.id);
        if (x.status === 'done') {
          if (x.ckpt) x.status = 'stored';
          else { x.status = 'pending'; lost.push(n.id); }
        }
      }
      ev('crash', null, { lost });
    }

    function restore(x) {
      const node = ctx.byId.get(x.id);
      const rt = relaxed ? 0 : node.size / ctx.disk.readMBs;
      t += rt; readTime += rt;
      x.status = 'done';
      x.version = x.ckpt.version;
      x.inputVersions = x.ckpt.inputVersions;
      ev('restore', x.id, { readTime: rt });
    }

    // 返回 'ok' | 'crashed' | 'abort'
    function runNode(node) {
      const x = st.get(node.id);
      x.runs++; x.attempts++;
      const dur = sampleDuration(node, rng);
      t += dur; computeTime += dur;
      ev('start', node.id, { attempt: x.attempts, duration: dur });
      const inj = inject.get(node.id);
      const failed = (inj && inj.has(x.attempts)) || rng() < node.failProb;
      if (failed) {
        failures++;
        ev('fail', node.id, { attempt: x.attempts });
        if (x.attempts > ctx.maxRetries) {
          ok = false; failReason = '重试预算耗尽: ' + node.id;
          ev('abort', node.id, {});
          return 'abort';
        }
        crash();
        return 'crashed';
      }
      // 成功：旧检查点血统作废
      dropCkpt(x, 'recomputed');
      x.version = computeVersion(node, x);
      x.inputVersions = {};
      ctx.parents.get(node.id).forEach((p) => { x.inputVersions[p] = st.get(p).version; });
      x.status = 'done';
      ev('finish', node.id, { attempt: x.attempts });
      if (policySet.has(node.id)) {
        x.saves++;
        const wt = relaxed ? 0 : node.size / ctx.disk.writeMBs;
        t += wt; writeTime += wt;
        const sinj = injectSave.get(node.id);
        const saveFailed = (sinj && sinj.has(x.saves)) || (!relaxed && rng() < ctx.disk.saveFailProb);
        if (saveFailed) {
          ev('save-fail', node.id, { writeTime: wt });
        } else {
          x.ckpt = { version: x.version, inputVersions: Object.assign({}, x.inputVersions), size: node.size };
          storage += node.size;
          if (storage > peakStorage) peakStorage = storage;
          ev('save', node.id, { writeTime: wt, storage });
        }
      }
      return 'ok';
    }

    // 递归保证某节点输出可用；被有效检查点覆盖的子树不重算（共享上游只算一次）。
    function ensureDone(id) {
      const x = st.get(id);
      if (x.status === 'done') return true;
      if (x.status === 'stored') {
        if (ckptValid(x)) { restore(x); return true; }
        dropCkpt(x, 'inputs-changed');
        x.status = 'pending';
      }
      const ps = ctx.parents.get(id);
      for (let i = 0; i < ps.length; i++) ensureDone(ps[i]);
      // 父节点均已 done，执行本节点；失败（崩溃）后重新保证父节点再重试
      for (;;) {
        const r = runNode(ctx.byId.get(id));
        if (r === 'ok') return true;
        if (r === 'abort') return false;
        for (let i = 0; i < ps.length; i++) ensureDone(ps[i]);
      }
    }

    let guard = 0;
    for (;;) {
      propagateInvalidation();
      const remaining = ctx.sinks.filter((s) => st.get(s).status !== 'done');
      if (remaining.length === 0) break;
      for (const s of remaining) {
        if (!ensureDone(s)) break;
      }
      if (!ok) break;
      if (++guard > 1000) throw new Error('调度循环未收敛');
    }

    let recomputes = 0;
    const attempts = {};
    ctx.nodes.forEach((n) => {
      const x = st.get(n.id);
      recomputes += Math.max(0, x.runs - 1);
      attempts[n.id] = x.attempts;
    });

    return {
      ok, failReason,
      totalTime: t, computeTime, writeTime, readTime,
      failures, recomputes, attempts,
      storageUsed: storage, peakStorage,
      events,
    };
  }

  /* ---------------- 策略评估（配对种子） ---------------- */
  function evaluatePolicy(ctx, policy, seeds, opts) {
    opts = opts || {};
    const totals = [];
    let failures = 0, storageSum = 0, peakSum = 0, recomputeSum = 0;
    let writeSum = 0, readSum = 0, computeSum = 0;
    for (const s of seeds) {
      const r = simulate(ctx, policy, { seed: s, relaxed: opts.relaxed, inject: opts.inject, injectSaveFail: opts.injectSaveFail });
      if (!r.ok) failures++;
      totals.push(r.totalTime);
      storageSum += r.storageUsed; peakSum += r.peakStorage; recomputeSum += r.recomputes;
      writeSum += r.writeTime; readSum += r.readTime; computeSum += r.computeTime;
    }
    totals.sort((a, b) => a - b);
    const n = totals.length;
    const mean = totals.reduce((a, b) => a + b, 0) / n;
    const variance = totals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1);
    const std = Math.sqrt(variance);
    const pct = (p) => {
      if (n === 1) return totals[0];
      const idx = (p / 100) * (n - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return totals[lo] + (totals[hi] - totals[lo]) * (idx - lo);
    };
    return {
      mean, std, ci95: 1.96 * std / Math.sqrt(n),
      p50: pct(50), p95: pct(95),
      min: totals[0], max: totals[n - 1],
      totals,
      failureRate: failures / n,
      meanStorage: storageSum / n,
      meanPeakStorage: peakSum / n,
      meanRecomputes: recomputeSum / n,
      meanWriteTime: writeSum / n,
      meanReadTime: readSum / n,
      meanComputeTime: computeSum / n,
      runs: n,
    };
  }

  function policyStorage(ctx, policy) {
    let s = 0;
    for (const id of policy) s += ctx.byId.get(id).size;
    return s;
  }

  function feasible(ctx, policy) {
    return policyStorage(ctx, policy) <= ctx.storageCap + 1e-9;
  }

  /* ---------------- 优化器 ---------------- */
  // 精确搜索：枚举所有满足存储上限的子集。仅适用于小规模（候选节点 ≤ maxNodes）。
  // 返回值即该评估口径下的真实最优（上界=下界=最优均值）。
  function optimizeExact(ctx, seeds, opts) {
    opts = opts || {};
    const maxNodes = opts.maxNodes != null ? opts.maxNodes : 12;
    const cands = ctx.nodes.filter((n) => ctx.relevant.has(n.id)).map((n) => n.id);
    if (cands.length > maxNodes) {
      return { tractable: false, reason: '候选节点 ' + cands.length + ' 超过精确搜索上限 ' + maxNodes, candidates: cands.length };
    }
    const sizes = cands.map((id) => ctx.byId.get(id).size);
    const total = 1 << cands.length;
    let best = null, bestMask = 0, evaluated = 0, skipped = 0;
    const results = [];
    for (let mask = 0; mask < total; mask++) {
      let size = 0;
      for (let i = 0; i < cands.length; i++) if (mask & (1 << i)) size += sizes[i];
      if (size > ctx.storageCap + 1e-9) { skipped++; continue; }
      const policy = new Set();
      for (let i = 0; i < cands.length; i++) if (mask & (1 << i)) policy.add(cands[i]);
      const r = evaluatePolicy(ctx, policy, seeds, opts.evalOpts);
      evaluated++;
      results.push({ policy: Array.from(policy), mean: r.mean, storage: size, result: r });
      if (!best || r.mean < best.mean - 1e-12) { best = r; bestMask = mask; }
    }
    results.sort((a, b) => a.mean - b.mean);
    const bestPolicy = new Set();
    for (let i = 0; i < cands.length; i++) if (bestMask & (1 << i)) bestPolicy.add(cands[i]);
    return {
      tractable: true, optimum: true,
      bestPolicy: Array.from(bestPolicy), best,
      evaluated, skipped,
      top: results.slice(0, 10),
    };
  }

  // 贪心前向选择：每次加入边际收益最大的可行节点，直到无改进。
  // 注意：贪心结果只是可行上界，不保证最优。
  function optimizeGreedy(ctx, seeds, opts) {
    opts = opts || {};
    const cands = ctx.nodes.filter((n) => ctx.relevant.has(n.id)).map((n) => n.id);
    const current = new Set();
    let currentR = evaluatePolicy(ctx, current, seeds, opts.evalOpts);
    const path = [{ policy: [], mean: currentR.mean, added: null }];
    for (;;) {
      let bestId = null, bestR = null;
      for (const id of cands) {
        if (current.has(id)) continue;
        const trial = new Set(current); trial.add(id);
        if (!feasible(ctx, trial)) continue;
        const r = evaluatePolicy(ctx, trial, seeds, opts.evalOpts);
        if (!bestR || r.mean < bestR.mean - 1e-12) { bestR = r; bestId = id; }
      }
      if (bestId == null || bestR.mean >= currentR.mean - 1e-9) break;
      current.add(bestId); currentR = bestR;
      path.push({ policy: Array.from(current), mean: currentR.mean, added: bestId });
    }
    return {
      optimum: false, // 贪心不保证最优
      bestPolicy: Array.from(current), best: currentR, path,
      storage: policyStorage(ctx, current),
    };
  }

  /*
   * 松弛下界（估计）：假设检查点写/读零成本、保存必成功、存储无上限且全部节点
   * 保存。此时任何失败只需重算失败节点本身，是任何真实策略的乐观下界。
   * 与贪心上界配合报告区间，不把任何一端当作精确最优（精确最优由 optimizeExact 给出）。
   */
  function lowerBound(ctx, seeds, opts) {
    opts = opts || {};
    const all = new Set(ctx.nodes.filter((n) => ctx.relevant.has(n.id)).map((n) => n.id));
    const r = evaluatePolicy(ctx, all, seeds, Object.assign({}, opts.evalOpts, { relaxed: true }));
    return { mean: r.mean, result: r, note: '松弛估计：读写零成本 + 全节点保存 + 保存必成功' };
  }

  return {
    prepare, simulate, evaluatePolicy,
    optimizeExact, optimizeGreedy, lowerBound,
    policyStorage, feasible,
    meanDuration,
    _mulberry32: mulberry32,
  };
});
