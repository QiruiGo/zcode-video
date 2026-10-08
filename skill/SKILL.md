---
name: arknights-video
description: 制作明日方舟相关解说视频的完整工作流：语料查证 → 文案 → 分镜 → 渲染 → 字幕 → 成片，含三道必须等用户确认的审稿门。当用户要做方舟剧情解说、角色介绍、活动回顾、世界观科普等视频时使用。
---

# arknights-video：明日方舟解说视频工作流（ZCode 版）

完全不依赖 DSH 运行时。检索引擎复用 prts-terrarchive（MIT），出片管线复用
arknights-video 插件（MIT），通过两个 CLI 在纯 Node 上驱动。**用户要参与选题
和文案，三道门（G0/G1/G2）必须等用户明确确认后才能往下走，其余步骤可连续执行。**

## 工具与目录

工作流根目录（下称 `ROOT`）：包含 `bin/corpus-cli.mjs` 与 `bin/video-cli.mjs`
的目录，自包含可搬运。本机安装位置：`D:\DSH workspace\zcode-video`。
会话中 ROOT 不明时：先查环境变量 `ZCODE_VIDEO_HOME`，再问用户，不要猜。

| 项 | 位置（相对 ROOT） |
| --- | --- |
| 查证 CLI | `bin/corpus-cli.mjs` |
| 出片 CLI | `bin/video-cli.mjs` |
| 语料 | `corpus/releases`（缺失时 `node bin/corpus-cli.mjs download` 现场下载，约 241MB） |
| 项目产物 | `output\<项目id>\` |
| 出片配置 | `config.json`（可省略，用默认值） |
| 分镜稿 | 每期一个 `scenes.json`（放 ROOT，随项目留档） |

所有命令在 ROOT 下执行。

## 流程

```
G0 选题(用户) → 查证(语料) → G1 文案审阅(用户) → 定稿分镜 → G2 分镜确认(用户)
            → 出片 render/voice/build → 交付 episode.mp4
```

### G0 · 选题（等用户）

让用户给出：**主题**（讲什么）、**时长**（决定分镜数量，1 分钟 ≈ 6-10 个分镜）、
**受众与风格**（考据向 / 剧情向 / 科普向）。用户没说清楚就问，不要自作主张。

### 1 · 查证

```bash
# 角色参加过哪些活动（角色 Wiki 的字段）
node bin/corpus-cli.mjs search --query 凯尔希 --types character_wiki --sections 相关活动

# 活动剧情概况
node bin/corpus-cli.mjs search --query 凯尔希 --types story_wiki --activities 孤星

# 某人亲口说的台词（speakers 只匹配亲口台词）
node bin/corpus-cli.mjs search --speakers 阿米娅 --query 博士

# 读活动原文（整活动连读）；读某关卡剧情；读 Wiki 字段
node bin/corpus-cli.mjs read --activity 孤星 --max-lines 200
node bin/corpus-cli.mjs read --stage-code 0-1 --part before --line 1
node bin/corpus-cli.mjs read --title "凯尔希 / 角色 Wiki" --section 相关活动

# 时间线（泰拉年表）
node bin/corpus-cli.mjs timeline --activities 孤星 --entities 凯尔希
```

规则：
- 引用一律 `《篇章名》第 N 行`；Wiki/时间线是**整理性资料**，其中内容写进稿子前
  必须用 `read` 回查官方原文核验。
- 语料里查不到的（现实考据、词源、其他作品联动）用 `web_search`/`web_fetch` 补充，
  并在证据表里标注来源 URL。
- 每个分镜的证据记入 scenes.json 的 `evidence` 数组，宁可留空也不要编造。

### G1 · 文案审阅（等用户）

把**证据表 + 逐分镜旁白稿**交给用户改稿。展示格式：每个分镜一节——标题、旁白
（含字数）、出处。用户可能只改文字、可能增删分镜、可能推翻重写，都等TA定稿。

写稿约束（写的时候就守住，别等用户来挑）：
- 旁白每镜 30~90 字；单条字幕 ≤ 18 字（渲染层会按标点自动切，超长会折行）。
- 语速不超过 7 字/秒（成片报告里会标黄）。
- 数字、人名、地名、时间以语料原文为准。

### 2 · 定稿分镜 + G2 确认（等用户）

```bash
node bin/video-cli.mjs create --title "标题" --scenes-file scenes.json --provider none
node bin/video-cli.mjs script <项目id> --scenes-file scenes.json --provider none
node bin/video-cli.mjs list
```

scenes.json 每项：`{ title, narration(必填), body(屏显正文，省略用 narration),
cite("《孤星》第 121 行"), image(可选背景图，本地绝对路径；渲染为 CG 背景+压暗遮罩，
素材自备、版权自负), evidence[] }`。
把分镜表展示给用户，确认后进入出片。

### 3 · 出片

```bash
node bin/video-cli.mjs render <id>   # 只出画面，快速预览排版（几秒）
node bin/video-cli.mjs voice  <id>   # 配音+字幕（重改稿后必须重跑）
node bin/video-cli.mjs build  <id> [--force]
node bin/video-cli.mjs all    <id> [--force]
```

- `--provider none`：无声视频（时长按 5 字/秒估算），**只用于定稿前的快速预览**。
- 本机 edge-tts 可用（默认 provider）；**定稿渲染一律真配音——字幕出现与背景切换
  的节奏事实源是实测语音**：voice 阶段逐镜合成并实测音频时长（背景在该镜语音
  结束时切换），镜内字幕用词级时间戳（`subtitle_source: word-boundary`）逐词跟进。
  无声预览的字幕/切镜是文字估算，交付时须注明。
- 配置 BGM：编辑 config.json 的 `bgm` 节（enabled/dir/volume），素材用户自备。
- 成片重复生成要 `--force`；改画面不重配音时只跑 `build`；**改稿（文字/时长）
  必须重跑 `voice`——时间线随语音重建**。

### 4 · 交付

给用户：`output/<id>/episode.mp4` + `subtitle.srt` + `project.json`（出处留档）。
抽 1-2 帧 PNG 自查中文渲染和字幕位置再交付。

## 排错

| 现象 | 处理 |
| --- | --- |
| read 报 DOCUMENT_AMBIGUOUS | 按提示加 `--part before/after` 或用 search 消歧 |
| 画面正常没字幕 | 字幕字体族名不是系统真实字体（默认 Microsoft YaHei 没问题就别动） |
| 配音 403/超时 | edge-tts 限流；改 `--provider none` 出无声，或稍后重试 |
| 改稿后时长不对 | 重跑 voice（时间线重建），再 build |
| 语料更新 | `node bin/corpus-cli.mjs download`（重新拉 current release） |

## 未来：另一台电脑的本地 TTS

设计不变：时间戳唯一入口在 voice 阶段。本地模型（GPT-SoVITS / CosyVoice 2）
出音频后，用 FunASR Paraformer 做字级强制对齐生成与 edge-tts WordBoundary
同构的 boundaries，即可替换 provider——渲染、字幕、合成层零改动。

## 本 skill 的正本

本文件的正本随工作流放在 `ROOT/skill/SKILL.md`；每台设备把它复制（或链接）到
`~/.zcode/skills/arknights-video/SKILL.md` 后即可在会话中使用。改动应先改正本再分发。
