/*
 * 示例场景：菱形依赖 / 连锁失效 / 磁盘写入失败 / 固定种子随机图。
 * UMD：浏览器 window.CkptScenarios，Node require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CkptScenarios = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 菱形依赖：共享上游 A 不能在 B、C 两条下游路径里重复计成本。
  const diamond = {
    name: 'diamond',
    title: '菱形依赖（共享上游）',
    description: 'A 为共享上游，B/C 并行分支，D 汇合。失败恢复时 A 只重算一次。固定耗时便于手算核对；注入 D 的失败可观察恢复集合。',
    nodes: [
      { id: 'A', duration: 1, size: 2, failProb: 0 },
      { id: 'B', duration: 2, size: 2, failProb: 0 },
      { id: 'C', duration: 3, size: 2, failProb: 0 },
      { id: 'D', duration: 4, size: 2, failProb: 0 },
    ],
    edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']],
    disk: { writeMBs: 1, readMBs: 1, saveFailProb: 0 },
    storageCap: 6,
    maxRetries: 3,
  };

  // 连锁失效：C 被重算（非确定性）后，侧支 E 上已保存的检查点因输入版本
  // 不一致而失效，必须一并重算。把 C 改为 deterministic 可看到 E 被保留。
  const cascade = {
    name: 'cascade',
    title: '连锁失效（输入改动使检查点失效）',
    description: 'C→D 与 C→E 两支。D 失败崩溃后从 B 的检查点恢复并重算 C；C 非确定性 => E 的旧检查点失效，需连锁重算。固定耗时，可手算核对（总耗时 35；C 确定性时为 30）。',
    nodes: [
      { id: 'A', duration: 1, size: 2, failProb: 0 },
      { id: 'B', duration: 2, size: 2, failProb: 0 },
      { id: 'C', duration: 3, size: 2, failProb: 0, deterministic: false },
      { id: 'E', duration: 5, size: 2, failProb: 0 },
      { id: 'D', duration: 4, size: 2, failProb: 0 },
    ],
    edges: [['A', 'B'], ['B', 'C'], ['C', 'E'], ['C', 'D']],
    // 汇点顺序即执行顺序：E 先完成并保存，D 后失败 => 才能观察到 E 的检查点失效
    sinks: ['E', 'D'],
    disk: { writeMBs: 1, readMBs: 1, saveFailProb: 0 },
    storageCap: 6,
    maxRetries: 3,
  };

  // 磁盘写入失败：保存本身可能失败（写时延照付但不留检查点），
  // 且重算后需要重新保存。高 saveFailProb 下"全都存"未必划算。
  const diskfail = {
    name: 'diskfail',
    title: '磁盘写入失败（保存开销与失败）',
    description: '链式 5 节点，保存失败率 25%。写入时间照付但不产生检查点；存储上限紧张，需在写开销、恢复时间与存储之间权衡。',
    nodes: [
      { id: 'A', duration: { dist: 'lognormal', mu: Math.log(6), sigma: 0.25 }, size: 8, failProb: 0.05 },
      { id: 'B', duration: { dist: 'lognormal', mu: Math.log(4), sigma: 0.25 }, size: 12, failProb: 0.06 },
      { id: 'C', duration: { dist: 'lognormal', mu: Math.log(8), sigma: 0.3 }, size: 6, failProb: 0.08 },
      { id: 'D', duration: { dist: 'lognormal', mu: Math.log(5), sigma: 0.25 }, size: 10, failProb: 0.06 },
      { id: 'E', duration: { dist: 'lognormal', mu: Math.log(7), sigma: 0.3 }, size: 4, failProb: 0.05 },
    ],
    edges: [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']],
    disk: { writeMBs: 2, readMBs: 8, saveFailProb: 0.25 },
    storageCap: 24,
    maxRetries: 4,
  };

  // 固定种子随机图：同一种子 => 同一拓扑与参数，用于跨策略配对评估。
  function randomDag(seed, n) {
    n = n || 9;
    let a = (seed >>> 0) || 42;
    const rnd = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const nodes = [];
    const edges = [];
    for (let i = 0; i < n; i++) {
      nodes.push({
        id: 'T' + i,
        duration: { dist: 'lognormal', mu: Math.log(2 + rnd() * 8), sigma: 0.2 + rnd() * 0.2 },
        size: Math.round(2 + rnd() * 18),
        failProb: 0.02 + rnd() * 0.1,
        deterministic: rnd() < 0.3,
      });
    }
    // 分层随机边：每层节点以一定概率连向前层
    for (let j = 1; j < n; j++) {
      const k = 1 + Math.floor(rnd() * Math.min(2, j));
      const preds = new Set();
      while (preds.size < k) preds.add(Math.floor(rnd() * j));
      preds.forEach((p) => edges.push(['T' + p, 'T' + j]));
    }
    const totalSize = nodes.reduce((s, x) => s + x.size, 0);
    return {
      name: 'random-' + seed,
      title: '随机场景（种子 ' + seed + '）',
      description: '固定种子生成的随机 DAG，用于配对评估：所有策略共用同一组模拟种子。',
      nodes, edges,
      disk: { writeMBs: 4, readMBs: 12, saveFailProb: 0.05 },
      storageCap: Math.round(totalSize * 0.45),
      maxRetries: 3,
    };
  }

  return {
    list: [diamond, cascade, diskfail],
    diamond, cascade, diskfail, randomDag,
  };
});
