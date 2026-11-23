/*
 * UI 冒烟测试：用最小 DOM 桩在 Node 中驱动 app.js 的完整流程
 * （装载场景 → 注入 → 单次运行 → 步进 → 蒙特卡洛 → 优化器 → 对比 → 采用推荐）。
 * node tests/smoke-ui.mjs
 */
import fs from 'node:fs';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

/* ---- 最小 DOM 桩 ---- */
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false,
    style: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(ev || { target: this })); },
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k] != null ? this['attr_' + k] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
  };
}
const els = new Map();
globalThis.document = {
  querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
  querySelectorAll() { return []; },
};
globalThis.window = globalThis;
globalThis.innerWidth = 1280;

const engine = (await import('../src/engine.js')).default;
const scenarios = (await import('../src/scenarios.js')).default;
globalThis.CkptEngine = engine;
globalThis.CkptScenarios = scenarios;

// 输入默认值（模拟浏览器初始 DOM）
const defaults = {
  '#inp-seed': '1', '#inp-sims': '16', '#inp-random-seed': '20261124',
  '#sel-scenario': 'diamond', '#sel-inject-node': '', '#sel-inject-save': '',
};
for (const [k, v] of Object.entries(defaults)) document.querySelector(k).value = v;

// 加载 app.js（IIFE，立即装载场景）
const src = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
(0, eval)(src);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[UI 冒烟]');
ok(document.querySelector('#dag').innerHTML.includes('class="node'), 'DAG 渲染出节点');
ok(document.querySelector('#dag').innerHTML.includes('has-ckpt'), '预设策略节点带检查点标记');
ok(document.querySelector('#scenario-meta').textContent.includes('存储上限'), '场景元信息渲染');

// 注入 D 失败并单次运行
const selFail = document.querySelector('#sel-inject-node');
selFail.value = 'D'; selFail.fire('change');
ok(state_of_inject(), '注入已生效（chip 显示）');
function state_of_inject() {
  return document.querySelector('#chip-inject').hidden === false &&
    document.querySelector('#chip-inject').textContent.includes('D');
}
document.querySelector('#btn-single').fire('click');
const logHtml = document.querySelector('#event-log').innerHTML;
ok(logHtml.includes('崩溃'), '单次运行事件流包含崩溃事件');
ok(logHtml.includes('恢复') || logHtml.includes('开始执行'), '事件流包含恢复/重算');
ok(document.querySelector('#btn-step-next').disabled === false, '步进按钮可用');

// 步进到末尾
for (let i = 0; i < 60; i++) document.querySelector('#btn-step-next').fire('click');
ok(document.querySelector('#btn-step-next').disabled === true, '步进到末尾后下一步禁用');

// 蒙特卡洛
document.querySelector('#btn-mc').fire('click');
ok(document.querySelector('#histogram').innerHTML.includes('<svg'), '直方图渲染');
ok(document.querySelector('#stat-row').innerHTML.includes('平均总耗时'), '统计块渲染');

// 优化器（setTimeout 包裹，需等待）
document.querySelector('#btn-greedy').fire('click');
document.querySelector('#btn-exact').fire('click');
document.querySelector('#btn-lb').fire('click');
await sleep(200);
const optTable = document.querySelector('#optimizer-table').innerHTML;
ok(optTable.includes('精确最优'), '精确搜索结果入表');
ok(optTable.includes('贪心'), '贪心结果入表');
ok(optTable.includes('松弛下界'), '下界入表');
const boundsNote = document.querySelector('#bounds').innerHTML;
ok(boundsNote.includes('区间'), '上下界区间说明渲染');
ok(document.querySelector('#btn-apply').disabled === false, '采用推荐按钮可用');

// 配对对比
document.querySelector('#btn-compare').fire('click');
const cmpTable = document.querySelector('#compare-table').innerHTML;
ok(cmpTable.includes('无检查点') && cmpTable.includes('精确最优'), '对比表包含各策略');
ok(document.querySelector('#compare-time').innerHTML.includes('<svg'), '耗时对比图渲染');
ok(document.querySelector('#compare-storage').innerHTML.includes('<svg'), '存储对比图渲染');

// 采用推荐
document.querySelector('#btn-apply').fire('click');
ok(document.querySelector('#run-status').textContent.includes('已采用推荐策略'), '采用推荐策略');

// 连锁失效场景：E 的检查点失效应出现在事件流
const selSc = document.querySelector('#sel-scenario');
selSc.value = 'cascade'; selSc.fire('change');
const selFail2 = document.querySelector('#sel-inject-node');
selFail2.value = 'D'; selFail2.fire('change');
document.querySelector('#btn-single').fire('click');
const log2 = document.querySelector('#event-log').innerHTML;
ok(log2.includes('检查点失效'), '连锁失效场景事件流包含检查点失效');
ok(document.querySelector('#stat-row').innerHTML.includes('35'), '连锁失效总耗时 35（手算核对）');

// 随机场景可装载
selSc.value = 'random'; selSc.fire('change');
ok(document.querySelector('#dag').innerHTML.includes('T0'), '随机场景渲染');

console.log('\n通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) { process.exit(1); }
console.log('全部通过');
