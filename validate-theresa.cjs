// scenes-theresa-doctor.json 去AI味改写 + 自校验
// 用法: node validate-theresa.js
// 校验通过才写回文件；任一项失败则退出且不写入。
const fs = require('fs');
const PATH = 'D:/DSH workspace/zcode-video/scenes-theresa-doctor.json';
const raw = fs.readFileSync(PATH, 'utf8');
const before = JSON.parse(raw);
if (!Array.isArray(before) || before.length !== 40) {
  console.error('FAIL: 原文件镜数不是 40，实际=' + (before && before.length));
  process.exit(1);
}

// [分镜title, 原文片段, 改后片段] —— 只动 narration 文风，引语/事实不动
const EDITS = [
  ['最初的托付',
   '她唤醒博士，是为了请他找答案。',
   '她唤醒博士，为的只是这个答案。'],
  ['凯尔希的揭露',
   '还是暴露了。凯尔希告诉特蕾西娅：他在尝试让自己感染矿石病——粉尘吸入，',
   '还是败露了。凯尔希告诉特蕾西娅：他在尝试让自己感染矿石病——吸入粉尘，'],
  ['他在验证什么',
   '不惜伤害自己、也要逼近真相的博士',
   '不惜伤害自己，也要逼近真相的博士'],
  ['战后之约',
   '那座他们诉说的故乡。',
   '那座他们说起过的故乡。'],
  ['选择了阴影',
   '然后，防御系统被解除。没有厮杀，没有宣言，只有一个决定的落下。',
   '然后，他解除了防御系统。没有厮杀，没有宣言，他只是做了一个决定。'],
  ['她的回答',
   '她仍在帮博士，认清他自己。',
   '她仍在帮博士认清他自己。'],
  ['灵魂尽头：名字',
   '是一声对博士名字的呼唤。',
   '是一声呼唤——博士的名字。'],
  ['不原谅，与相信',
   '从此一起，压在博士的肩上。',
   '从此一起压在博士的肩上。'],
  ['孤星：幻影',
   '一个自述“诞生自『辩论』机制的一丝幻影”的她。',
   '她说自己是“诞生自『辩论』机制的一丝幻影”。'],
  ['全新的人',
   '因为博士重新获得了一次，追寻希望的机会——',
   '因为这一次，博士重新获得了追寻希望的机会——'],
  ['尾声：白花',
   '永远停着一声，她的呼唤。',
   '永远停着她的呼唤。'],
];

const after = JSON.parse(raw);
const changed = [];
for (const [title, oldText, newText] of EDITS) {
  const idx = before.findIndex(s => s.title === title);
  if (idx < 0) { console.error('FAIL: 找不到分镜「' + title + '」'); process.exit(1); }
  const occ = after[idx].narration.split(oldText).length - 1;
  if (occ !== 1) {
    console.error('FAIL: 分镜「' + title + '」原片段出现 ' + occ + ' 次（应为 1），原文核对失败');
    process.exit(1);
  }
  after[idx].narration = after[idx].narration.replace(oldText, newText);
  changed.push(idx);
}

// ===== 校验 =====
const problems = [];
const count = s => (s.match(/[\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9]/g) || []).length; // 字数=汉字+字母数字，不含标点
const allChars = s => s.replace(/\s/g, '').length;
const SPLIT = /[，。！？；：、“”‘’「」『』《》（）·…—~～!?,.;:;"'()\-]/;
const quotes = s => ({
  dq: s.match(/“[^”]*”/g) || [],
  cq: s.match(/『[^』]*』/g) || [],
});

if (after.length !== 40) problems.push('改后镜数 ' + after.length + ' != 40');

let quoteTotal = 0;
for (let i = 0; i < 40; i++) {
  const b = before[i], a = after[i];
  for (const k of ['title', 'cite', 'image']) {
    const bv = b.hasOwnProperty(k) ? b[k] : '<无>';
    const av = a.hasOwnProperty(k) ? a[k] : '<无>';
    if (bv !== av) problems.push(`镜${i + 1}(${b.title}) 字段 ${k} 被改动: ${JSON.stringify(bv)} -> ${JSON.stringify(av)}`);
  }
  const qb = quotes(b.narration), qa = quotes(a.narration);
  quoteTotal += qa.dq.length + qa.cq.length;
  if (JSON.stringify(qb) !== JSON.stringify(qa)) {
    problems.push(`镜${i + 1}(${b.title}) 引语被改动: ${JSON.stringify(qb)} -> ${JSON.stringify(qa)}`);
  }
  const n = count(a.narration);
  if (n < 30 || n > 90) problems.push(`镜${i + 1}(${b.title}) 字数 ${n} 超出 30~90`);
  const segs = a.narration.split(SPLIT).map(x => x.trim()).filter(x => count(x) > 0);
  const over = segs.filter(x => count(x) > 18);
  if (over.length) problems.push(`镜${i + 1}(${b.title}) 字幕段超18字: ${JSON.stringify(over)}`);
}

// ===== 报告 =====
const rng = arr => Math.min(...arr.map(s => count(s.narration))) + '~' + Math.max(...arr.map(s => count(s.narration)));
console.log('== 校验结果 ==');
console.log('[1] 镜数: ' + after.length + ' (要求 40)');
console.log('[2] title/cite/image 逐字段与改前一致: ' + (problems.length ? '见下方失败项' : '通过'));
console.log('[3] 引语逐字未动: 共 ' + quoteTotal + ' 段（含“”『』内术语/台词），' + (problems.length ? '见下方' : '通过'));
console.log('[4] 字数区间 30~90: 改前 ' + rng(before) + ' / 改后 ' + rng(after) + '，' + (problems.length ? '见下方' : '通过'));
console.log('[附] 单条字幕切分 <=18 字: ' + (problems.length ? '见下方' : '通过'));
console.log('== 改动分镜 ' + changed.length + '/' + after.length + ' ==');
for (const i of changed) {
  console.log(`镜${i + 1} ${before[i].title}`);
  console.log('  原: ' + before[i].narration);
  console.log('  改: ' + after[i].narration);
}
if (problems.length) {
  console.error('== FAILED，未写回文件 ==');
  console.error(problems.join('\n'));
  process.exit(1);
}
fs.writeFileSync(PATH, JSON.stringify(after, null, 2) + '\n', 'utf8');
// 回读确认落盘文件与校验对象一致
const reread = JSON.parse(fs.readFileSync(PATH, 'utf8'));
if (JSON.stringify(reread) !== JSON.stringify(after)) { console.error('FAIL: 落盘后回读不一致'); process.exit(1); }
console.log('== 通过，文件已更新: ' + PATH + ' ==');
