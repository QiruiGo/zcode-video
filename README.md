# zcode-video

明日方舟解说视频工作流（ZCode 版）：**完全脱离 DSH 生态**，在纯 Node + ZCode
会话里完成「语料查证 → 文案 → 分镜 → 渲染 → 字幕 → 成片」，选题与文案由用户
参与审稿（三道门控）。

## 架构

```
ZCode 会话（编排 + 人工介入，流程定义见 arknights-video skill）
 ├─ bin/corpus-cli.mjs   查证节点
 │    └─ 复用 prts-terrarchive（MIT）检索引擎：
 │       CorpusStore / executeSearch / executeRead / executeTimelineSearch
 │       ensureCorpusRelease（下载器：SHA-256 校验 + ModelScope/site 双源回退）
 │    └─ 语料：corpus/releases（独立下载，与 DSH 的资料互不影响）
 └─ bin/video-cli.mjs    出片节点
      └─ 复用 arknights-video 插件（MIT）管线：
         project / render(@napi-rs/canvas 画卡片) / tts(edge-tts) /
         subtitle(libass 烧入) / bgm / ffmpeg(@ffmpeg-installer 随包)
      └─ 项目产物：output/<id>/episode.mp4 + subtitle.srt + project.json
```

两个 CLI 都是**薄适配层**：引擎模块原样 import，不复制不改写；项目文件格式与
DSH 版完全一致，互相可接手。

## 快速开始

```bash
cd "D:\DSH workspace\zcode-video"

# 环境/语料自检
node bin/corpus-cli.mjs status
node bin/video-cli.mjs doctor

# 查证
node bin/corpus-cli.mjs search --query 凯尔希 --types character_wiki --sections 相关活动
node bin/corpus-cli.mjs read --stage-code 0-1 --part before --line 1
node bin/corpus-cli.mjs timeline --activities 孤星

# 出片（无声预览）
node bin/video-cli.mjs create --title "标题" --scenes-file scenes.json --provider none
node bin/video-cli.mjs all <项目id> --force
```

分镜文件格式、检索配方、门控规则见
`~/.zcode/skills/arknights-video/SKILL.md`（复制本目录 `skill/SKILL.md` 后会话内自动可用）。

## 配置（config.json，可省略）

```jsonc
{
  "tts":  { "provider": "python-edge-tts", "voice": "zh-CN-YunxiNeural" },  // none = 无声
  "bgm":  { "enabled": false, "dir": "D:/my-music/arknights", "volume": 0.18 },
  "render": { "subtitleFontFamily": "Microsoft YaHei" }
}
```

相对路径以本目录为基准。BGM 素材用户自备（插件不附带任何音乐）。

## 迁移到另一台设备

本目录**自包含**：引擎源码 vendored 在 `engine/src`，检索引擎来自本目录的
npm 依赖，语料可现下。迁移步骤：

1. **搬运**：把 `zcode-video-portable.zip`（不含 node_modules / 语料 / 产物）
   解压到任意路径，或整目录拷贝；
2. **装依赖**（Node ≥ 22.19）：`npm install` —— 会按新机器平台拉取
   ffmpeg / canvas 二进制；Windows 之外的平台也能装，但字幕字体要改
   `config.json` 的 `render.subtitleFontFamily` 为该系统真实中文字体名；
3. **装语料**（二选一）：直接拷贝旧机的 `corpus/` 目录；或
   `node bin/corpus-cli.mjs download`（ModelScope，约 241MB）；
4. **装 skill**：把 `skill/SKILL.md` 复制到
   `~/.zcode/skills/arknights-video/SKILL.md`；路径不同时可设环境变量
   `ZCODE_VIDEO_HOME` 指向 ROOT；
5. **验证**：`node bin/video-cli.mjs doctor` + `node bin/corpus-cli.mjs status`。

配音：新机器需要 `python -m pip install edge-tts`（或 `tts.provider: "none"`）；
未来接本地开源 TTS 只需新增 provider，见 skill 末节。

## ZCode 节点式工作流（可选）

`workflow/arknights-video.dwf.ts` 是同一条管线的 ZCode 动态工作流版：节点 =
模型驱动的子代理（G0 选题 → 查证+CG 侦察 → 引用抽查 → 写稿 → G1 审阅 → 建项
目 → G2 确认 → 渲染 → 验收），人工门控以「结果发卡片 + 阻塞等待你的意见或自
备草稿」实现。复制到目标机项目的 `.zcode/workflows/` 下即可按名启动；脚本里的
`ROOT` 常量要改成那台机器的实际路径。

## 分镜配图（CG 背景，可选）

scenes.json 的 `image` 字段（本地绝对路径）会让该分镜渲染为「CG 背景 + 压暗
遮罩 + 文字」。素材来源与版权评估见 `docs/sticker-sources.md`：PRTS wiki 提供
关卡剧情 CG（imageinfo 直链下载，Special:FilePath 有重定向循环不可用），素材
版权归鹰角网络，仅限非官方二创用途；商业化（充电/商单）是红线。

## 与 DSH 版的关系

| | DSH 版（插件） | 本工作流 |
| --- | --- | --- |
| 编排 | DSH 预设 + Agent 工具 | ZCode 会话 + skill |
| 检索/出片引擎 | 同一套源码 | 同一套源码（import，不复制） |
| 语料 | `$DSH_HOME/prts-corpus` | `zcode-video/corpus`（各自独立） |
| 项目格式 | project.json v1 | 相同，可互相接手 |

## 版权

两个引擎均为 MIT。语料适用 PRTS.chat 资料集自身的许可（ModelScope 页面标明）。
画面为程序化绘制的信息卡片，不含游戏素材；BGM 用户自备。
非官方社区项目，与游戏开发商/发行商无隶属关系。
