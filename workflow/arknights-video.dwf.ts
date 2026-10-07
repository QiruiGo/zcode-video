const ROOT = "D:/DSH workspace/zcode-video";
const CORPUS_CLI = ROOT + "/bin/corpus-cli.mjs";
const VIDEO_CLI = ROOT + "/bin/video-cli.mjs";
const COMMON = "工作流根目录 ROOT=" + ROOT + "（Windows，Git Bash）。所有命令一律用绝对路径。如果某个检查根本没法完成，或者你的指令互相矛盾，升级问题并直说，不要绕过去，也不要编造检查结果。";

artifact.board("pipeline", {
  title: "出片流水线",
  key: "stage",
  status: "status",
  columns: ["完成", "有问题"],
  cardTitle: "stage",
  detail: [{ field: "note", label: "说明" }],
});

interface TopicSpec {
  /** 视频主题：讲什么，一句话 */
  subject: string;
  /** 目标时长，如 "1 分钟"、"2~3 分钟" */
  duration: string;
  /** 风格：考据向 / 剧情向 / 科普向 */
  style: string;
  /** 配音方式："edge-tts"（在线配音）或 "none"（无声预览） */
  provider: string;
  /** 用户自备的文案草稿全文；用户没给就留空 */
  userDraft?: string;
}

interface Evidence {
  /** 查证得到的一个事实，一句话 */
  fact: string;
  /** 出处，格式《篇章名》第 N 行；Wiki/时间线内容已用 read 回查过原文 */
  cite: string;
}

interface CgLead {
  /** PRTS 文件名，不含「文件:」前缀，如「头像 敌人 特蕾西娅.png」 */
  file: string;
  /** 对应剧情节点的一句话说明 */
  moment: string;
  /** 出处：关卡码或剧情出处 */
  cite: string;
  /** imageinfo 核到的直链（media.prts.wiki），渲染师直接用它下载 */
  url: string;
  /** 图片像素宽，≥1280 才收录 */
  width: number;
  /** 图片像素高，≥720 才收录 */
  height: number;
}

interface ResearchResult {
  /** 与主题最相关的事实清单，最多 24 条，按相关性排序 */
  evidence: Evidence[];
  /** 语料查不到、用网络补充过的点及其来源 URL */
  webSources: string[];
  /** 想查但语料和网络都没查到的点，如实列出 */
  gaps: string[];
  /** 关键剧情节点的 CG 线索（已在 PRTS 核实存在），最多 12 条；一张都核不出就空数组 */
  cgLeads: CgLead[];
}

interface SpotCheckResult {
  /** 亲自回查了几条引用 */
  checked: number;
  /** 与语料原文对不上的引用及问题 */
  mismatches: { cite: string; problem: string }[];
}

interface SceneRow {
  /** 分镜标题 */
  title: string;
  /** 旁白全文 */
  narration: string;
  /** 出处，《篇章名》第 N 行 */
  cite: string;
  /** 背景配图：PRTS 文件名（只能来自 cgLeads）；没有合适图就留空 */
  image?: string;
}

interface DraftResult {
  /** 成片的视频标题，不超过 20 字，适合 B 站 */
  videoTitle: string;
  /** scenes.json 的绝对路径 */
  scenesFile: string;
  /** 分镜数量 */
  sceneCount: number;
  /** 逐镜内容，与 scenes.json 一致 */
  scenes: SceneRow[];
}

interface ReviewResult {
  /** 用户是否明确通过 */
  approved: boolean;
  /** 用户的意见或用户粘贴的草稿，原样保留 */
  feedback?: string;
}

interface ProjectResult {
  /** 项目 id，create 输出里给出 */
  projectId: string;
  /** 分镜表文本：每镜一行（标题/旁白/出处/预估秒数） */
  sceneTable: string;
  /** 预估成片秒数：引擎输出里有就用，没有按总字数除以 5 估 */
  estimatedSeconds: number;
}

interface ConfirmResult {
  /** 用户是否确认 */
  approved: boolean;
  /** 用户的修改要求或用户自己重排的分镜，原样保留 */
  feedback?: string;
}

interface RenderResult {
  /** 项目 id */
  projectId: string;
  /** 成片绝对路径 output/<id>/episode.mp4 */
  episodePath: string;
  /** 字幕绝对路径 subtitle.srt */
  subtitlePath: string;
  /** project.json 绝对路径 */
  projectPath: string;
  /** 实际使用的配音 provider */
  provider: string;
  /** 配图落地结果，如「成功 9 / 共 10 张」；分镜没有配图则为空 */
  cgNote?: string;
  /** 渲染过程中的警告，例如 edge-tts 限流降级 */
  warnings: string[];
}

interface QaIssue {
  /** 一句话：什么问题 */
  what: string;
  /** 严重程度。high 只留给成片损坏、字幕大面积错位这类交付性问题 */
  severity: "low" | "medium" | "high";
}

interface QaResult {
  /** 一句话验收结论 */
  verdict: string;
  /** 发现的问题清单，没有就空数组 */
  issues: QaIssue[];
}

interface Finding {
  /** 位置：文件路径或阶段名 */
  where: string;
  /** 一句话：什么问题 */
  what: string;
  /** 依据：命令输出或亲眼核对到的证据 */
  evidence: string;
  /** verified = 已被独立手段证实；unconfirmed = 待人工复核 */
  status: "verified" | "unconfirmed";
  /** 严重程度 */
  severity: "low" | "medium" | "high";
}

const findings: Finding[] = [];

function renderScenes(videoTitle: string, scenes: SceneRow[]): string {
  const lines: string[] = ["# 分镜文案：" + videoTitle, ""];
  let i = 0;
  for (const s of scenes) {
    i++;
    lines.push("## 第 " + i + " 镜 · " + s.title, "", s.narration, "", "出处：" + s.cite);
    if (s.image) lines.push("配图（渲染时作为背景）：" + s.image);
    lines.push("");
  }
  return lines.join("\n");
}

phase("G0 定选题");
const gatekeeper = agent("G0 选题把关人", {
  system: "你是视频项目的选题把关人，用户只通过升级问题和你对话，你不查证也不写稿。" + COMMON,
});
const topic = await gatekeeper.ask<TopicSpec>(
  "用升级问题向用户收齐第一期视频的 G0 四项：① 主题（讲什么）② 目标时长 ③ 风格（考据向/剧情向/科普向）④ 配音（edge-tts 在线配音 / none 无声预览）。" +
  "同时明确告诉用户：如果已经有自己写的文案草稿，可以整份直接粘贴，后续撰稿会以它为基准优化，而不是从零写。" +
  "用户给了草稿就原样放进 userDraft；回答不全就再升级追问，最多三次。按用户原话整理返回，不要替用户补创作倾向。"
);
report({ stage: "选题", status: "完成", note: topic.subject }, "pipeline");
log("G0 已定：主题「" + topic.subject + "」，" + topic.duration + "，" + topic.style + "，配音 " + topic.provider + (topic.userDraft ? "；用户自备了草稿" : "；从零撰写"));

phase("语料查证");
const researcher = agent("语料查证员", {
  system: "你是明日方舟考据查证员，只信语料原文，查不到就如实说，绝不编造。" + COMMON,
});
const research = await researcher.ask<ResearchResult>(
  "为第一期视频做语料查证。主题：" + topic.subject + "；风格：" + topic.style + "。\n" +
  "先跑 node \"" + CORPUS_CLI + "\" status 确认语料在位（缺失就升级问题）。\n" +
  "然后组合这些配方多轮查询：\n" +
  "search --query <词> --types character_wiki|story_wiki|dialogue --sections <字段>；\n" +
  "search --speakers <角色> --query <词>（只匹配亲口台词）；\n" +
  "read --activity <活动名> --max-lines 200；read --stage-code <关卡> --part before|after --line 1；\n" +
  "read --title \"<名> / 角色 Wiki\" --section <字段>（需要续读时加 --page）；\n" +
  "timeline --activities <活动> --entities <实体>。\n" +
  (topic.userDraft
    ? "用户已有草稿，查证以支撑草稿里的论断为主：草稿中每个可考据的论断都要找到原文出处。\n"
    : "") +
  "规则：Wiki 和时间线是整理性资料，其中内容必须先用 read 回查官方原文才能收录；" +
  "引用格式一律《篇章名》第 N 行；语料查不到的点可上网补（记 URL），再查不到就进 gaps。\n" +
  "查证完成后另做一轮 CG 素材侦察（本片是剧情向，要用游戏 CG 给分镜当背景）：\n" +
  "① 从语料 read 的输出里收集剧情关键关卡码（形如 0-1、CW-ST-1、8-2 的 stage code）；\n" +
  "② 对每个关卡码列页面图片清单：curl -sG \"https://prts.wiki/api.php\" --data-urlencode \"titles=<关卡码>\" --data \"action=query\" --data \"prop=images\" --data \"imlimit=50\" --data \"format=json\"；\n" +
  "③ 文件名初筛（排除含 头像/图标/半身像/Buff/道具/皮肤/敌人 的），逐个核尺寸并拿直链：curl -sG \"https://prts.wiki/api.php\" --data-urlencode \"titles=File:<文件名>\" --data \"action=query\" --data \"prop=imageinfo\" --data \"iiprop=url|size\" --data \"format=json\"；width≥1280 且 height≥720 才算 CG；\n" +
  "④ 挑 6~12 张覆盖关键剧情节点放 cgLeads（url 直接用 imageinfo 返回的 media.prts.wiki 链接）；一张都核不出来就返回空数组，绝不编造文件名。"
);
log("查证完成：" + research.evidence.length + " 条事实，" + research.gaps.length + " 个查不到的点，" + research.cgLeads.length + " 条 CG 线索");
report({ stage: "查证", status: "完成", note: research.evidence.length + " 条事实，" + research.cgLeads.length + " 条 CG 线索" }, "pipeline");

phase("抽查引用出处");
const spotChecker = agent("引用抽查员", {
  system: "你是引用核查员，只核对不写稿不改文件，结论必须来自你亲自跑的命令。" + COMMON,
});
const spot = await spotChecker.ask<SpotCheckResult>(
  "独立核对下面这批引用是否与语料原文一致（亲自用 read 重查，不要信清单本身）：\n" +
  JSON.stringify(research.evidence, null, 1) + "\n" +
  "抽最多 3 条（挑最可能写进稿子的），用 node \"" + CORPUS_CLI + "\" read ... 回查原文，核对事实与行号，对不上的写进 mismatches。"
);
for (const m of spot.mismatches) {
  report({ stage: "引用抽查", status: "有问题", note: m.cite + "：" + m.problem }, "pipeline");
}
const evLines: string[] = ["# 证据表：" + topic.subject, ""];
for (const e of research.evidence) evLines.push("- " + e.fact + "（" + e.cite + "）");
if (research.webSources.length > 0) {
  evLines.push("", "## 网络补充来源", ...research.webSources.map(s => "- " + s));
}
if (research.gaps.length > 0) {
  evLines.push("", "## 查不到的点（如实列出，不编造）", ...research.gaps.map(g => "- " + g));
}
if (spot.mismatches.length > 0) {
  evLines.push("", "## 引用抽查发现不符（已要求撰稿人修正/弃用）", ...spot.mismatches.map(m => "- " + m.cite + "：" + m.problem));
}
await artifact.markdown("research", evLines.join("\n"), { title: "证据表 · 查证结果" });
log("证据表已发布，共 " + research.evidence.length + " 条");

phase("撰写分镜文案");
const writer = agent("撰稿人", {
  system: "你是明日方舟解说视频撰稿人，尊重用户给出的结构与表达，出处严谨，宁可少写一条也不编造。" + COMMON,
});
const spotNote = spot.mismatches.length > 0
  ? "注意：抽查发现以下引用与原文不符，写稿前先修正或弃用：" + JSON.stringify(spot.mismatches)
  : "引用抽查未发现问题。";
const baseInstruction = topic.userDraft
  ? "用户自备了一份草稿，整份如下。以它为基准产出分镜稿：保留用户的结构、论点与表达习惯，只做三件事——①用语料核证每个论断（查不到的标注或删）②补出处 cite ③满足字数与语速约束。用户草稿：\n" + topic.userDraft + "\n"
  : "从零撰写。";
let draft = await writer.ask<DraftResult>(
  "为第一期视频产出逐分镜文案。" + baseInstruction + "\n" +
  "主题：" + topic.subject + "；时长：" + topic.duration + "；风格：" + topic.style + "。\n" +
  "证据表：" + JSON.stringify(research.evidence) + "\n" +
  "网络补充：" + JSON.stringify(research.webSources) + "\n" +
  "查不到的：" + JSON.stringify(research.gaps) + "\n" +
  spotNote + "\n" +
  "硬约束：1 分钟 ≈ 6-10 镜，按用户时长定分镜数；每镜旁白 30~90 字；单条字幕 ≤18 字（渲染层按标点自动切）；语速 ≤7 字/秒；数字、人名、地名以语料原文为准；每镜 cite 用《篇章名》第 N 行。\n" +
  "配图：给剧情关键分镜配游戏 CG 背景——scene.image 只准填下面 CG 线索里核实过的文件名，高潮节点优先，配图分镜不超过总数一半，没有合适图就留空。CG 线索：" + JSON.stringify(research.cgLeads) + "\n" +
  "把分镜写成 JSON 数组（每项 {title, narration, cite, image?, evidence[]}，evidence 可省）存到 " + ROOT + " 下，文件名用 scenes- 加主题的简短英文或拼音（不含空格和中文）；同时起一个不超过 20 字的视频标题。\n" +
  "本轮只写稿：逐镜内容放进返回值 scenes，不要升级提问。"
);
await artifact.markdown("draft", renderScenes(draft.videoTitle, draft.scenes), { title: "分镜文案 · 待你审阅", description: "看后可回复「通过」、给修改意见，或整份粘贴你自己的版本" });
log("初稿完成：" + draft.sceneCount + " 镜，已发布为卡片，等用户 G1 审阅");

let approved = false;
let feedback = "";
for (let round = 1; round <= 4; round++) {
  phase("G1 文案审阅");
  const review = await writer.ask<ReviewResult>(
    "第 " + round + " 轮 G1 送审。用升级问题请用户审阅当前这版稿子：问题里附逐镜全文（每镜标题+旁白+出处），并明确告知用户三种回应方式——①回复「通过」；②给任意修改意见；③不满意时整份粘贴自己的文案草稿，将以此为准重做。\n" +
    "用户的回答原样放进 feedback（用户粘的草稿注明「用户草稿：」前缀），approved 如实设置。本轮你自己不改稿、不自行优化；用户没回答就等待，绝不替用户做决定。"
  );
  approved = review.approved;
  feedback = review.feedback ?? "";
  if (approved) break;
  phase("按你的意见修订文案");
  const isUserDraft = feedback.includes("用户草稿") || feedback.includes("用户版");
  draft = await writer.ask<DraftResult>(
    (isUserDraft
      ? "用户给出了自己的完整草稿，以它为准重做：保留用户的结构、论点与表达习惯，只做语料核证、出处标注和格式约束优化。用户草稿/意见：" + feedback
      : "按用户意见修订：" + feedback) +
    "\n更新 " + draft.scenesFile + "（JSON 数组与字数约束照旧），返回修订后的逐镜内容 scenes，本轮不要升级提问。"
  );
  await artifact.markdown("draft", renderScenes(draft.videoTitle, draft.scenes), { title: "分镜文案 · 修订版待审" });
  log("第 " + round + " 轮修订完成，已发布修订版，继续送审");
}
if (!approved) {
  findings.push({
    where: draft.scenesFile,
    what: "G1 文案审阅四轮未获明确通过，按设计停在渲染前",
    evidence: "四轮送审均未收到「通过」",
    status: "verified",
    severity: "medium",
  });
  return {
    conclusion: "选题、查证、证据表、初稿与四轮修订都已完成并逐版发你过目，但 G1 始终未获通过，工作流按设计停在渲染之前。最后一版稿子在 " + draft.scenesFile + "，随时可改后重跑或从这里继续。",
    findings,
    verified: ["G0 选题、语料查证、引用抽查、逐版文案均已完成并发布"],
    notCovered: ["建立项目、G2 分镜确认、渲染、配音、成片验收均未开始"],
  };
}
report({ stage: "文案与 G1", status: "完成", note: draft.videoTitle + "，" + draft.sceneCount + " 镜" }, "pipeline");
log("G1 通过：" + draft.videoTitle + "，" + draft.sceneCount + " 镜");

const setup = agent("项目装配员", {
  system: "你负责用 video-cli 建项目、灌分镜、把分镜表交用户做 G2 确认，不改分镜内容。" + COMMON,
});
let approved2 = false;
let fb2 = "";
let project: ProjectResult | undefined;
for (let round = 1; round <= 3; round++) {
  phase("建立项目并生成分镜表");
  const setupAsk = round === 1
    ? "用 node \"" + VIDEO_CLI + "\" create --title \"" + draft.videoTitle + "\" --scenes-file \"" + draft.scenesFile + "\" --provider none 建项目，记下输出的项目 id。然后读引擎输出整理分镜表：每镜一行（标题/旁白/出处/预估秒数，有配图的在行尾注明图名），放进 sceneTable 返回，并给出 estimatedSeconds。本轮不要升级提问。"
    : "分镜文件已按用户的 G2 意见更新（意见：" + fb2 + "）。用 node \"" + VIDEO_CLI + "\" script " + (project?.projectId ?? "") + " --scenes-file \"" + draft.scenesFile + "\" 重新灌入，整理新分镜表放进 sceneTable 返回。本轮不要升级提问。";
  project = await setup.ask<ProjectResult>(setupAsk);
  await artifact.markdown("storyboard", "# 分镜表（待确认）\n\n" + project.sceneTable, { title: "分镜表 · 待你确认", description: "确认后即开始渲染；也可以给出你的重排方案" });
  phase("G2 分镜确认");
  const conf = await setup.ask<ConfirmResult>(
    "用升级问题把当前分镜表交用户确认，明确告知三种回应方式——①回复「通过」；②给修改意见（转告即可，下一轮由撰稿人改）；③想自己重排分镜就整份给出（同样转告）。\n" +
    "用户回答前等待；approved 与 feedback 如实返回，本轮不改任何文件。"
  );
  approved2 = conf.approved;
  fb2 = conf.feedback ?? "";
  if (approved2) break;
  phase("按确认意见修订分镜");
  const isUserLayout = fb2.includes("重排") || fb2.includes("用户版") || fb2.includes("分镜");
  await writer.ask(
    (isUserLayout ? "用户在 G2 给出了自己的分镜安排，以它为准：" : "G2 确认意见：") + fb2 +
    "\n更新 " + draft.scenesFile + "（JSON 数组、字数约束照旧），改完回复改了什么。"
  );
}
if (project === undefined || !approved2) {
  findings.push({
    where: draft.scenesFile,
    what: "G2 分镜确认三轮未通过，停在渲染前",
    evidence: project?.sceneTable.slice(0, 300) ?? "三轮确认均未获通过",
    status: "verified",
    severity: "medium",
  });
  return {
    conclusion: "G1 已通过，但 G2 分镜确认三轮未获通过，工作流停在渲染之前。项目 " + (project?.projectId ?? "未建成") + " 的分镜表已逐版发你过目，按你的意见改完 scenes 文件后可重跑。",
    findings,
    verified: ["G1 文案已通过；项目已建立，分镜表逐版发布"],
    notCovered: ["渲染、配音、成片验收均未开始"],
  };
}
report({ stage: "分镜确认", status: "完成", note: "项目 " + project.projectId + "，约 " + project.estimatedSeconds + " 秒" }, "pipeline");

phase("渲染与配音出片");
const providerFlag = topic.provider === "none" ? "none" : "python-edge-tts";
const renderer = agent("渲染师", {
  system: "你负责跑 video-cli 出片管线，如实报告每一步结果，不跳过失败步骤硬编成功。" + COMMON,
});
const rendered = await renderer.ask<RenderResult>(
  "把项目 " + project.projectId + " 出成片。\n" +
  "1) 先 node \"" + VIDEO_CLI + "\" doctor，环境有问题就升级问题。\n" +
  "2) 配图落地（" + draft.scenesFile + " 里有 scene.image 才做，没有就跳到第 3 步）：收集所有 image 的唯一文件名，逐个下载到 " + ROOT + "/assets/cg/<文件名>。下载用查证员核过的直链：curl -sL -A \"zcode-video-workflow/0.1\" -o \"<目标>\" \"<url>\"（直链清单：" + JSON.stringify(research.cgLeads.map(c => ({ file: c.file, url: c.url }))) + "）；直链失效就用 imageinfo 重查。下载后校验文件头是 PNG（89 50 4E 47）或 JPEG（FF D8）且大于 50KB；失败的记入 warnings 并在渲染副本里去掉该镜的 image。全部处理完后写 " + ROOT + "/scenes-render.json：内容为原分镜数组、仅把 image 换成本地绝对路径、其余字段原样，然后 node \"" + VIDEO_CLI + "\" script " + project.projectId + " --scenes-file " + ROOT + "/scenes-render.json 重新灌入。cgNote 返回「成功 N / 共 M 张」。\n" +
  "3) node \"" + VIDEO_CLI + "\" all " + project.projectId + " --force --provider " + providerFlag +
  (providerFlag === "none"
    ? "（无声预览，时长按 5 字/秒估算）"
    : "（edge-tts 偶发 403/超时：稍等重试，最多两次；仍失败改用 --provider none 重跑，并在 warnings 里注明降级）") +
  "。all 是渲染+配音+合成，可能超过 2 分钟，Bash 超时参数设 600000。\n" +
  "4) 产物在 " + ROOT + "/output/" + project.projectId + "/ 下：episode.mp4、subtitle.srt、project.json，逐个确认存在后把绝对路径返回。\n" +
  "不要改分镜内容。"
);
report({ stage: "出片", status: "完成", note: "provider=" + rendered.provider + (rendered.warnings.length > 0 ? "（有警告）" : "") }, "pipeline");
log("出片完成：" + rendered.episodePath);

phase("成片验收与交付");
const qa = agent("验收员", {
  system: "你是成片验收员，只看不改，结论必须有证据：命令输出或你亲眼看到的画面。" + COMMON,
});
const qaResult = await qa.ask<QaResult>(
  "验收 " + rendered.episodePath + "：\n" +
  "1) ffprobe 读实际时长，与估算值 " + project.estimatedSeconds + " 秒对比，偏差超过 20% 记一条问题；\n" +
  "2) 用 ffmpeg（优先 " + ROOT + "/node_modules 里的 @ffmpeg-installer，其次 PATH）在 25% 和 75% 处各抽一帧 PNG 到系统临时目录，用 Read 亲眼看图：中文渲染是否正常、字幕是否在画面安全区内、排版有无破版；\n" +
  "3) 检查 " + rendered.subtitlePath + " 非空，条数与 " + draft.sceneCount + " 镜的量级一致；\n" +
  (rendered.cgNote
    ? "4) 配图检查：" + rendered.cgNote + "——抽帧里应能看到照片级背景而不是纯渐变底；若 cgNote 显示有成功下载的配图但抽帧全是纯渐变底，记一条问题。\n"
    : "") +
  "不要修改任何项目文件。问题为空就是真没有，不要凑数。"
);
for (const issue of qaResult.issues) {
  report({ stage: "成片验收", status: "有问题", note: issue.what }, "pipeline");
}

const existsCode = "for (const p of process.argv.slice(1)) { console.log(require('fs').existsSync(p)); }";
const exists = await world.run("node", ["-e", existsCode, rendered.episodePath, rendered.subtitlePath, rendered.projectPath]);
const allExist = exists.exitCode === 0 && exists.stdout.trim().split(/\r?\n/).map(s => s.trim()).every(v => v === "true");
const show = await world.run("node", [VIDEO_CLI, "show", rendered.projectId]);
if (!allExist) {
  findings.push({
    where: rendered.episodePath,
    what: "渲染步骤报告完成，但产物文件缺失",
    evidence: "node -e existsSync 校验未全部通过（exit=" + exists.exitCode + "，stdout=" + exists.stdout.trim() + "）",
    status: "verified",
    severity: "high",
  });
}
if (show.exitCode !== 0) {
  findings.push({
    where: "video-cli show " + rendered.projectId,
    what: "引擎状态回读失败",
    evidence: show.stderr.slice(0, 300) || "exit=" + show.exitCode,
    status: "verified",
    severity: "medium",
  });
}
for (const issue of qaResult.issues) {
  findings.push({
    where: rendered.episodePath,
    what: issue.what,
    evidence: "验收员抽帧/ffprobe 目检",
    status: "unconfirmed",
    severity: issue.severity,
  });
}

const relEpisode = "output/" + rendered.projectId + "/episode.mp4";
let episodePublished = false;
try {
  await artifact.file("episode", relEpisode, { title: "第一期成片", description: draft.videoTitle, primary: true });
  episodePublished = true;
} catch {
  try {
    await artifact.file("episode", rendered.episodePath, { title: "第一期成片", description: draft.videoTitle, primary: true });
    episodePublished = true;
  } catch {
    log("成片文件发布失败，路径见交付报告");
  }
}

const reportLines: string[] = [];
reportLines.push("# 交付报告：" + draft.videoTitle, "");
reportLines.push("- 主题：" + topic.subject + "（" + topic.style + "）");
reportLines.push("- 项目 id：" + rendered.projectId);
reportLines.push("- 成片：" + rendered.episodePath + (episodePublished ? "" : "（发布为卡片失败，请直接打开文件）"));
reportLines.push("- 字幕：" + rendered.subtitlePath);
reportLines.push("- 留档：" + rendered.projectPath + "（分镜稿 " + draft.scenesFile + "）");
reportLines.push("- 配音：" + rendered.provider + "；验收结论：" + qaResult.verdict);
if (rendered.cgNote) reportLines.push("- 配图：" + rendered.cgNote + "（CG 素材取自 PRTS wiki，版权归鹰角网络所有，仅用于非官方二创）");
if (rendered.warnings.length > 0) {
  reportLines.push("", "## 警告", ...rendered.warnings.map(w => "- " + w));
}
reportLines.push("", "## 证据表（查证结论）", "");
for (const e of research.evidence) reportLines.push("- " + e.fact + "（" + e.cite + "）");
if (research.webSources.length > 0) {
  reportLines.push("", "## 网络补充来源", ...research.webSources.map(s => "- " + s));
}
reportLines.push("", "## 发布建议", "", "简介固定加一句：本视频为非官方二次创作，与上海鹰角网络科技有限公司无关；《明日方舟》游戏素材版权归鹰角网络所有。");
await artifact.markdown("delivery", reportLines.join("\n"), { title: "交付报告：" + draft.videoTitle });

const notCovered: string[] = [
  "配音音色与成片节奏未经真人完整试听",
  "引用抽查只核了 " + spot.checked + " 条，其余出处靠 G1 人工审阅把关",
  "BGM 未配置（config.json 默认关闭，素材用户自备）",
  "贴纸/表情包层尚未实现（docs/sticker-sources.md 的方案待拍板）",
];
if (providerFlag === "none") notCovered.push("本片为无声预览，edge-tts 配音未跑");

return {
  conclusion: "第一期「" + topic.subject + "」已出片：" + draft.sceneCount + " 镜（文案与分镜均经你逐版审阅通过），成片在 " + rendered.episodePath + "，配音 " + rendered.provider + (allExist ? "，产物存在性已校验" : "，但产物存在性校验未通过") + "。验收发现 " + qaResult.issues.length + " 个问题，详见交付报告。",
  findings,
  verified: [
    "node -e existsSync：episode.mp4 / subtitle.srt / project.json 三个产物逐一确认" + (allExist ? "全部存在" : "未全部存在"),
    "node video-cli show " + rendered.projectId + "：引擎状态回读（exit=" + show.exitCode + "）",
    "验收员 ffprobe 实测时长 + 25%/75% 两处抽帧目检中文渲染与字幕位置",
  ],
  notCovered,
};