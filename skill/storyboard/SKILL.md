---
name: arknights-storyboard
description: 解说视频的分镜纪律：结构先行、质量门全脚本化、引语逐字对账、配图决策规则。写或改 scenes.json 分镜稿、审分镜表、给分镜管线加校验时使用。提炼自 shuohao-skills novel-storyboard 的门禁方法论，按旁白解说视频（非生成视频）裁剪。
metadata:
  source: 方法论提炼自 eternityspring/shuohao-skills（Apache-2.0）的 novel-storyboard，2026-10 按本项目实战修订
---

# arknights-storyboard：分镜纪律

给旁白解说视频写、改、审分镜（scenes.json）时遵守的纪律与确定性质量门。
适用管线：zcode-video（`bin/video-cli.mjs`），分镜 = 一镜一张卡片（标题 +
旁白 + 出处 + 可选 CG 背景），渲染成片。

## 五条原则

1. **结构先行，分镜只做输出不做新决定。** 叙事结构（起承转合、镜序、
   视频标题）在定稿层一次定死；分镜层及其后的一切阶段（润色、装配、
   渲染）只允许执行，不允许重新决策。标题漂移事故（润色阶段擅改
   videoTitle，2026-10-08）就是违反这条的代价——修正：交付物标题以
   `project.json` 为唯一事实源。
2. **每道门必须脚本能判，不靠自觉。** 「我觉得没问题」不算数；
   `validate-scenes.mjs` 全过 + 退出码 0 才算数。改完就重跑，直到全绿。
3. **引语是引用不是文案。** 旁白里引号内的台词是语料原文，任何阶段
   逐字保留；它与 cite（`《篇章名》第 N 行`）构成对账关系——查证阶段
   抽查、润色阶段锁死、校验脚本把关。
4. **时长预算先算后写。** 动笔前：目标分钟数 × 60 × 5 字/秒 = 总字数
   预算；总字数 ÷ 65 字/镜 ≈ 镜数。写完对账（G6，区间 ±15%）。
   不要写着写着滑出预算再回补。
5. **配图是决策不是装饰。** 场面镜（地点/事件/人物群像）优先配图；
   纯议论、总结、过渡镜不配；同一张图复用必须有呼应关系（如首尾
   扣环）且可解释；文件名必须来自核实过的 CG 线索（imageinfo
   width≥1280 且 height≥720），禁止编造。

## 质量门（validate-scenes.mjs，零依赖 node ≥18）

```bash
# 初稿 / 修订后自检
node skill/storyboard/scripts/validate-scenes.mjs scenes-xxx.json --target "5-10"

# 润色等只动文风的阶段：对照上一版，锁结构 + 锁引语
node skill/storyboard/scripts/validate-scenes.mjs scenes-xxx.json \
  --baseline scenes-xxx.prev.json --target "5-10"

# 全锁（含 narration，用于装配前终检）
node skill/storyboard/scripts/validate-scenes.mjs scenes-xxx.json \
  --baseline scenes-xxx.prev.json --lock-narration --target "5-10"
```

| 门 | 判什么 | 失败典型 |
| --- | --- | --- |
| G1 结构 | 非空数组；每镜 title/narration 齐备 | 缺标题、空旁白 |
| G2 字数 | 每镜旁白 30~90 字（`--min/max-chars` 可调） | 某镜写嗨到 120 字 |
| G3 字幕 | 按标点切分后每段 ≤18 字 | 长句无标点，渲染必折行 |
| G4 出处 | cite 匹配 `《…》第 N 行` | 出处缺行号、写成了散文 |
| G5 配图 | 文件名形态 + 排除词（头像/图标/半身像/道具/皮肤/敌人） | 把头像当 CG 配了 |
| G6 预算 | 估算总时长落在目标区间 ±15% | 5 分钟目标写出了 12 分钟 |
| G7 锁定 | baseline 下镜数 + 逐镜 title/cite/image 全等 | 润色顺手改了标题 |
| G8 引语 | baseline 下引号内文本逐字保留 | 「润」了一句台词 |

WARN（不拦但要看）：冷开场前 2 镜无钩子要素；连续三镜时长几乎相同
（节奏带偏平）。INFO：总时长/字数、配图占比。

## 写稿流程（撰稿人视角）

1. **预算**：按原则 4 算出镜数与字数预算，写在稿头。
2. **结构**：先写一屏大纲（每镜一行：镜号｜一句话内容｜cite｜有无图），
   起承转合与钩子位置在这一层定死，过一遍原则 1 再动笔。
3. **成稿**：逐镜写旁白，边写边自问 G2/G3；引语从语料原文复制，
   不凭记忆敲。
4. **配图**：按原则 5 标 image（只准用核实过的文件名）。
5. **过门**：跑 validate，红了修，绿了才交 G1 审阅。

## 与工作流的关系

- arknights-video 工作流的撰稿阶段在动笔前先读本 skill；
- G1 审阅（用户改稿）后任何文案变更必须带 `--baseline` 过门；
- 装配（建项目）前建议 `--lock-narration` 终检一次。

## 出处与边界

- 门禁方法论（镜头认领节拍、只输出不决策、质量门脚本化）提炼自
  [shuohao-skills/novel-storyboard](https://github.com/eternityspring/shuohao-skills)
  （Apache-2.0）；其生成侧（H3/Seedance 提示词、分镜图、投产包）不适用
  于本管线，未引入。
- 本 skill 不查证事实（那是查证员 + 引用抽查员的活）、不做去 AI 味
  （humanizer-zh 的活）、不做视觉对齐（视觉验收 run 的活）。
