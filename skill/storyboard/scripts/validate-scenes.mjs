#!/usr/bin/env node
/**
 * 分镜质量门：对解说视频的 scenes.json 做全部确定性检查，零依赖（node ≥ 18）。
 * 门是判死刑的（FAIL 退出码 1）；WARN 只提示不拦。
 *
 * 用法：
 *   node validate-scenes.mjs <scenes.json> [--baseline <上一版.json>]
 *        [--target "5-10"]        目标时长区间（分钟），默认 "1-15"
 *        [--min-chars 30] [--max-chars 90]
 *        [--max-sub 18]           单条字幕切分上限（字）
 *        [--lock-narration]       baseline 模式下连 narration 也锁定（全锁）
 *   node validate-scenes.mjs --help
 */
import { readFileSync } from 'node:fs'

const rawArgs = process.argv.slice(2)
if (rawArgs.includes('--help') || rawArgs.length === 0) {
  console.log('用法: node validate-scenes.mjs <scenes.json> [--baseline <prev.json>] [--target "5-10"] [--min-chars 30] [--max-chars 90] [--max-sub 18] [--lock-narration]')
  process.exit(0)
}

function opt(name, fallback) {
  const i = rawArgs.indexOf(name)
  return i >= 0 && rawArgs[i + 1] !== undefined ? rawArgs[i + 1] : fallback
}
const file = rawArgs.find((a) => !a.startsWith('--'))
const baselineFile = opt('--baseline', '')
const minChars = Number(opt('--min-chars', '30'))
const maxChars = Number(opt('--max-chars', '90'))
const maxSub = Number(opt('--max-sub', '18'))
const target = String(opt('--target', '1-15'))
const lockNarration = rawArgs.includes('--lock-narration')

const fails = []
const warns = []
const infos = []
const gate = (id, label, problems) => {
  if (problems.length === 0) console.log(`[PASS] ${id} ${label}`)
  else {
    console.log(`[FAIL] ${id} ${label}`)
    for (const p of problems) { console.log(`       - ${p}`); fails.push(`${id} ${label}: ${p}`) }
  }
}

const scenes = JSON.parse(readFileSync(file, 'utf8'))
const baseline = baselineFile ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null

// G1 结构
{
  const problems = []
  if (!Array.isArray(scenes) || scenes.length === 0) problems.push('不是非空数组')
  scenes.forEach((s, i) => {
    const n = String(s?.narration ?? '').trim()
    if (!n) problems.push(`镜 ${i + 1} narration 为空`)
    else if (n.length > 2000) problems.push(`镜 ${i + 1} narration ${n.length} 字 > 2000`)
    if (!String(s?.title ?? '').trim()) problems.push(`镜 ${i + 1} 缺 title`)
  })
  gate('G1', '结构', problems)
}

// G2 每镜旁白字数区间
{
  const problems = []
  scenes.forEach((s, i) => {
    const len = String(s.narration).trim().length
    if (len < minChars || len > maxChars) problems.push(`镜 ${i + 1}「${s.title}」${len} 字（区间 ${minChars}~${maxChars}）`)
  })
  gate('G2', `旁白字数 ${minChars}~${maxChars}`, problems)
}

// G3 字幕切分：按主要标点切开后每段 ≤ maxSub（与渲染层自动切分的近似对齐）
{
  const problems = []
  const SPLITS = /[,，。！？!?；;：:、…\-—""''「」『』（）()]/u
  scenes.forEach((s, i) => {
    for (const seg of String(s.narration).split(SPLITS)) {
      const t = seg.trim()
      if (t.length > maxSub) problems.push(`镜 ${i + 1} 切段 ${t.length} 字 > ${maxSub}：「${t.slice(0, 24)}…」`)
    }
  })
  gate('G3', `字幕切段 ≤${maxSub} 字`, problems)
}

// G4 出处格式
{
  const problems = []
  scenes.forEach((s, i) => {
    const c = String(s.cite ?? '').trim()
    if (!c) problems.push(`镜 ${i + 1}「${s.title}」缺 cite`)
    else if (!/^《[^》]+》第\s*[0-9０-９\-–—、至\s]+行$/.test(c)) problems.push(`镜 ${i + 1} cite 不合《篇章名》第 N 行：「${c}」`)
  })
  gate('G4', '出处格式', problems)
}

// G5 配图卫生：文件名形态 + PRTS 命名黑名单
{
  const problems = []
  const BAN = /(头像|图标|半身像|道具|皮肤|敌人)/
  scenes.forEach((s, i) => {
    const img = String(s.image ?? '').trim()
    if (!img) return
    if (!/\.(png|jpe?g|webp)$/i.test(img)) problems.push(`镜 ${i + 1} image 非图片文件名：「${img}」`)
    if (/[\\/]/.test(img)) problems.push(`镜 ${i + 1} image 含路径分隔符（只写文件名）：「${img}」`)
    if (BAN.test(img)) problems.push(`镜 ${i + 1} image 命中排除词（${BAN.source}）：「${img}」`)
  })
  gate('G5', '配图卫生', problems)
}

// G6 时长预算：总字数 ÷ 5 字/秒 落在目标区间 ±15%
{
  const [tmin, tmax] = target.split('-').map(Number)
  const total = scenes.reduce((a, s) => a + String(s.narration).trim().length, 0) / 5
  const lo = tmin * 60 * 0.85, hi = tmax * 60 * 1.15
  const problems = total < lo || total > hi
    ? [`估算 ${Math.round(total)}s 不在 [${Math.round(lo)}, ${Math.round(hi)}]（目标 ${tmin}~${tmax} 分钟 ±15%）`]
    : []
  infos.push(`估算总时长 ${Math.round(total)}s（${(total / 60).toFixed(1)} 分钟），旁白共 ${Math.round(total * 5)} 字`)
  gate('G6', `时长预算 ${tmin}~${tmax} 分钟`, problems)
}

// G7 baseline 对账：镜数 + 逐镜 title/cite/image 全等；引语（“”内）逐字保留
if (baseline) {
  {
    const problems = []
    if (baseline.length !== scenes.length) problems.push(`镜数 ${scenes.length} ≠ baseline ${baseline.length}`)
    else {
      scenes.forEach((s, i) => {
        for (const k of ['title', 'cite', 'image']) {
          if (String(s[k] ?? '') !== String(baseline[i][k] ?? '')) {
            problems.push(`镜 ${i + 1} ${k} 变更：「${baseline[i][k] ?? ''}」→「${s[k] ?? ''}」`)
          }
        }
        if (lockNarration && String(s.narration) !== String(baseline[i].narration)) {
          problems.push(`镜 ${i + 1} narration 在 --lock-narration 下被改动`)
        }
      })
    }
    gate('G7', `结构锁定${lockNarration ? '（含 narration）' : ''}`, problems)
  }
  {
    const problems = []
    scenes.forEach((s, i) => {
      const quotes = String(s.narration).match(/“[^”]+”/g) ?? []
      for (const q of quotes) {
        if (!String(baseline[Math.min(i, baseline.length - 1)]?.narration ?? '').includes(q.slice(1, -1))) {
          problems.push(`镜 ${i + 1} 引语被改动或为新增：「${q.slice(0, 20)}…」`)
        }
      }
    })
    gate('G8', '引语逐字保留', problems)
  }
}

// 只提示不拦的报告项
{
  const withImg = scenes.filter((s) => String(s.image ?? '').trim()).length
  infos.push(`配图 ${withImg}/${scenes.length} 镜（占比 ${(withImg / scenes.length * 100).toFixed(0)}%）`)
  const head = scenes.slice(0, 2).map((s) => String(s.narration)).join('')
  if (/[？！]|这是/.test(head)) infos.push('冷开场：前 2 镜检出钩子要素（问句/悬念/指代）')
  else warns.push('冷开场：前 2 镜未见明显钩子要素（问号/叹号/「这是」）——建议人工看一眼')
  for (let i = 2; i < scenes.length; i++) {
    const d = (n) => String(scenes[n].narration).trim().length / 5
    if (Math.abs(d(i) - d(i - 1)) < 0.5 && Math.abs(d(i - 1) - d(i - 2)) < 0.5) {
      warns.push(`镜 ${i - 1}~${i + 1} 连续三镜时长几乎相同（约 ${d(i).toFixed(0)}s），节奏带偏平`)
      break
    }
  }
}

console.log('')
for (const w of warns) console.log(`[WARN] ${w}`)
for (const info of infos) console.log(`[INFO] ${info}`)
console.log('')
if (fails.length > 0) {
  console.log(`结果：${fails.length} 处未过门${warns.length ? `，${warns.length} 处警告` : ''}。逐条修复后重跑。`)
  process.exit(1)
}
console.log(`结果：全部质量门通过${warns.length ? `（${warns.length} 处警告供参考）` : ''}。`)
