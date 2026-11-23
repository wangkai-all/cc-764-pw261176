/*
 * 确定性手算核对测试：node tests/run-tests.mjs
 * 每个用例的期望值都由手工推演得出，注释中给出完整时间线。
 */
import engine from '../src/engine.js';
import scenarios from '../src/scenarios.js';

let passed = 0, failed = 0;
function eq(actual, expected, name) {
  const ok = Object.is(actual, expected) ||
    (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-9);
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + '  期望 ' + expected + ' 实际 ' + actual); }
}
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function section(s) { console.log('\n[' + s + ']'); }

const disk = (w, r, sf) => ({ writeMBs: w, readMBs: r, saveFailProb: sf || 0 });

/* ---------- T1/T2：无失败基线 + 保存写开销 ---------- */
section('T1/T2 链式基线与写开销');
{
  const sc = {
    name: 't1', nodes: [
      { id: 'A', duration: 2, size: 0 },
      { id: 'B', duration: 3, size: 4 },
      { id: 'C', duration: 5, size: 0 },
    ], edges: [['A', 'B'], ['B', 'C']], disk: disk(2, 2), maxRetries: 3,
  };
  const ctx = engine.prepare(sc);
  // T1: 无检查点：2+3+5 = 10
  const r1 = engine.simulate(ctx, new Set(), { seed: 1, trace: true });
  eq(r1.totalTime, 10, 'T1 无检查点总耗时 = 10');
  eq(r1.storageUsed, 0, 'T1 存储占用 = 0');
  // T2: 在 B 保存：写 4MB / 2MB/s = 2s => 2+3+2+5 = 12
  const r2 = engine.simulate(ctx, new Set(['B']), { seed: 1, trace: true });
  eq(r2.totalTime, 12, 'T2 保存 B 总耗时 = 12（含 2s 写）');
  eq(r2.storageUsed, 4, 'T2 存储占用 = 4');
  eq(r2.writeTime, 2, 'T2 写时间 = 2');
}

/* ---------- T3：菱形共享上游只重算一次 ---------- */
section('T3 菱形依赖：共享上游不重复计成本');
{
  const ctx = engine.prepare(scenarios.diamond);
  // 无检查点，D 第 1 次尝试失败：
  // 第一趟 A1+B2+C3+D4(败)=10；崩溃全部丢失；重算 A1+B2+C3+D4=10 => 20
  const r = engine.simulate(ctx, new Set(), { seed: 1, trace: true, inject: [{ node: 'D', attempt: 1 }] });
  eq(r.totalTime, 20, 'T3 总耗时 = 20');
  eq(r.attempts.A, 2, 'T3 共享上游 A 只重算 1 次（共 2 次），而非每条路径各算一次');
  eq(r.recomputes, 4, 'T3 重算节点数 = 4（A,B,C,D 各一次）');
}

/* ---------- T4：菱形 + 检查点恢复 ---------- */
section('T4 菱形：从 B/C 检查点恢复');
{
  const ctx = engine.prepare(scenarios.diamond);
  // 保存 B、C（各 2MB，写/读 1MB/s）：
  // 第一趟 A1+B2+写2+C3+写2+D4(败)=14；崩溃后 B、C 在盘上；
  // 恢复：读B2+读C2+D4=8 => 22。A 不重算。
  const r = engine.simulate(ctx, new Set(['B', 'C']), { seed: 1, trace: true, inject: [{ node: 'D', attempt: 1 }] });
  eq(r.totalTime, 22, 'T4 总耗时 = 22');
  eq(r.attempts.A, 1, 'T4 A 不重算');
  eq(r.storageUsed, 4, 'T4 存储占用 = 4');
  const restores = r.events.filter((e) => e.type === 'restore').map((e) => e.node).sort();
  eq(restores.join(','), 'B,C', 'T4 恢复事件为 B、C');
}

/* ---------- T5：连锁失效（检查点因输入改动失效） ---------- */
section('T5 连锁失效：非确定性重算使下游检查点失效');
{
  const ctx = engine.prepare(scenarios.cascade);
  // 保存 B、E；D 第 1 次尝试失败。
  // 第一趟 A1+B2+写2+C3+E5+写2+D4(败)=19；崩溃后 B、E 在盘上，A、C 丢失；
  // 恢复：从 B 恢复(读2)=21，重算 C3=24（新版本），重算 D4=28；
  // E 的检查点记录的是旧 C 版本 => 失效，重算 E5=33 并重存2=35。
  const r = engine.simulate(ctx, new Set(['B', 'E']), { seed: 1, trace: true, inject: [{ node: 'D', attempt: 1 }] });
  eq(r.totalTime, 35, 'T5 非确定性 C：总耗时 = 35');
  eq(r.attempts.A, 1, 'T5 A 被 B 的检查点覆盖，不重算');
  eq(r.attempts.E, 2, 'T5 E 因输入版本改变被连锁重算');
  ok(r.events.some((e) => e.type === 'invalidate' && e.node === 'E'), 'T5 E 的检查点被标记失效');

  // 对照：C 确定性 => 重算 C 版本不变 => E 的检查点仍然有效，直接恢复 E(读2)
  // 19 + 读B2 + C3 + D4 + 读E2 = 30
  const sc2 = JSON.parse(JSON.stringify(scenarios.cascade));
  sc2.nodes.find((n) => n.id === 'C').deterministic = true;
  const ctx2 = engine.prepare(sc2);
  const r2 = engine.simulate(ctx2, new Set(['B', 'E']), { seed: 1, trace: true, inject: [{ node: 'D', attempt: 1 }] });
  eq(r2.totalTime, 30, 'T5 对照（C 确定性）：总耗时 = 30');
  eq(r2.attempts.E, 1, 'T5 对照：E 不重算，直接恢复');
}

/* ---------- T6：磁盘写入失败 ---------- */
section('T6 磁盘写入失败：写时延照付、不留检查点');
{
  const sc = {
    name: 't6', nodes: [
      { id: 'A', duration: 1, size: 0 },
      { id: 'B', duration: 2, size: 2 },
      { id: 'C', duration: 3, size: 0 },
    ], edges: [['A', 'B'], ['B', 'C']], disk: disk(1, 1), maxRetries: 3,
  };
  const ctx = engine.prepare(sc);
  // B 第 1 次保存写盘失败；C 第 1 次尝试失败。
  // 第一趟 A1+B2+写2(败)+C3(败)=8；崩溃后无检查点全部丢失；
  // 第二趟 A1+B2+写2(成)+C3=8 => 16
  const r = engine.simulate(ctx, new Set(['B']), {
    seed: 1, trace: true,
    inject: [{ node: 'C', attempt: 1 }],
    injectSaveFail: [{ node: 'B', occurrence: 1 }],
  });
  eq(r.totalTime, 16, 'T6 总耗时 = 16');
  eq(r.attempts.B, 2, 'T6 B 重算一次（保存失败未留检查点）');
  ok(r.events.some((e) => e.type === 'save-fail' && e.node === 'B'), 'T6 记录写盘失败事件');
  eq(r.storageUsed, 2, 'T6 最终存储 = 2（第二次保存成功）');
}

/* ---------- T7：重试预算 ---------- */
section('T7 重试预算耗尽 => 流水线失败');
{
  const sc = {
    name: 't7', nodes: [{ id: 'A', duration: 1, size: 0 }], edges: [],
    disk: disk(1, 1), maxRetries: 2,
  };
  const ctx = engine.prepare(sc);
  const r = engine.simulate(ctx, new Set(), {
    seed: 1, trace: true,
    inject: [{ node: 'A', attempt: 1 }, { node: 'A', attempt: 2 }, { node: 'A', attempt: 3 }],
  });
  eq(r.ok, false, 'T7 超过 maxRetries=2 后失败');
  eq(r.failures, 3, 'T7 共 3 次失败尝试');
}

/* ---------- T8：配对评估可复现 ---------- */
section('T8 固定种子 => 完全可复现（配对评估基础）');
{
  const ctx = engine.prepare(scenarios.diskfail);
  const seeds = Array.from({ length: 24 }, (_, i) => 100 + i);
  const a = engine.evaluatePolicy(ctx, new Set(['C']), seeds);
  const b = engine.evaluatePolicy(ctx, new Set(['C']), seeds);
  eq(a.mean, b.mean, 'T8 同种子评估结果一致');
  const t1 = engine.simulate(ctx, new Set(['C']), { seed: 7, trace: true });
  const t2 = engine.simulate(ctx, new Set(['C']), { seed: 7, trace: true });
  eq(t1.events.length, t2.events.length, 'T8 同种子事件流一致');
}

/* ---------- T9/T10：优化器（已知最优解 + 上下界 + 存储上限） ---------- */
section('T9 优化器：手算已知最优 {A}，期望 14');
{
  // 链 A(10) -> B(1)，B 失败率 0.5，maxRetries 10，写/读 1MB/s，尺寸均 1。
  // E[空] = 11·E[k] = 22；E[{A}] = 10+1+E[k]+E[k-1]·1 = 14；
  // E[{B}] = 11·E[k]+1 = 23；E[{A,B}] = 15。（k 为 B 的尝试次数，几何分布均值 2）
  const sc = {
    name: 't9', nodes: [
      { id: 'A', duration: 10, size: 1, failProb: 0 },
      { id: 'B', duration: 1, size: 1, failProb: 0.5 },
    ], edges: [['A', 'B']], disk: disk(1, 1), storageCap: 2, maxRetries: 10,
  };
  const ctx = engine.prepare(sc);
  const seeds = Array.from({ length: 400 }, (_, i) => i + 1);
  const exact = engine.optimizeExact(ctx, seeds);
  ok(exact.tractable, 'T9 精确搜索可行');
  eq(exact.bestPolicy.join(','), 'A', 'T9 精确最优策略 = {A}');
  ok(Math.abs(exact.best.mean - 14) < 0.75, 'T9 最优均值 ≈ 14（实际 ' + exact.best.mean.toFixed(2) + '）');

  const greedy = engine.optimizeGreedy(ctx, seeds);
  eq(greedy.optimum, false, 'T9 贪心结果不得标注为最优');
  ok(greedy.best.mean >= exact.best.mean - 1e-9, 'T9 贪心不优于精确最优（上界关系）');

  const lb = engine.lowerBound(ctx, seeds);
  ok(lb.mean <= exact.best.mean + 1e-9, 'T9 松弛下界 ≤ 最优（实际 ' + lb.mean.toFixed(2) + ' ≤ ' + exact.best.mean.toFixed(2) + '）');
  ok(Math.abs(lb.mean - 12) < 0.6, 'T9 松弛下界 ≈ 12（=10+E[k]，实际 ' + lb.mean.toFixed(2) + '）');
}

section('T10 存储上限约束');
{
  const sc = {
    name: 't10', nodes: [
      { id: 'A', duration: 10, size: 1, failProb: 0 },
      { id: 'B', duration: 1, size: 1, failProb: 0.5 },
    ], edges: [['A', 'B']], disk: disk(1, 1), storageCap: 1, maxRetries: 10,
  };
  const ctx = engine.prepare(sc);
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);
  const exact = engine.optimizeExact(ctx, seeds);
  eq(exact.evaluated, 3, 'T10 上限 1 时只评估 3 个可行子集（{}, {A}, {B}）');
  eq(exact.skipped, 1, 'T10 {A,B} 超出存储上限被跳过');
  eq(exact.bestPolicy.join(','), 'A', 'T10 上限下最优仍为 {A}');
  ok(engine.policyStorage(ctx, exact.bestPolicy) <= 1, 'T10 最优策略满足存储上限');
}

/* ---------- T11：随机场景配对评估 + 贪心/精确一致性 ---------- */
section('T11 随机场景：配对评估下贪心 ≥ 精确最优');
{
  const ctx = engine.prepare(scenarios.randomDag(20261124, 8));
  const seeds = Array.from({ length: 32 }, (_, i) => 5000 + i);
  const exact = engine.optimizeExact(ctx, seeds);
  const greedy = engine.optimizeGreedy(ctx, seeds);
  ok(exact.tractable, 'T11 8 节点精确搜索可行');
  ok(greedy.best.mean >= exact.best.mean - 1e-9,
    'T11 贪心(' + greedy.best.mean.toFixed(2) + ') ≥ 精确最优(' + exact.best.mean.toFixed(2) + ')');
  const lb = engine.lowerBound(ctx, seeds);
  ok(lb.mean <= exact.best.mean + 1e-9, 'T11 下界 ≤ 最优');
  ok(engine.policyStorage(ctx, exact.bestPolicy) <= ctx.storageCap, 'T11 最优策略满足存储上限');
}

console.log('\n========================================');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) { console.error('有 ' + failed + ' 项失败'); process.exit(1); }
console.log('全部通过');
