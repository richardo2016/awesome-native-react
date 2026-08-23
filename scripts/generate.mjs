#!/usr/bin/env node
// Zero-dependency generator for awesome-native-react.
// Usage:
//   node scripts/generate.mjs refresh   # re-check every entry against GitHub + npm, update data/entries.json
//   node scripts/generate.mjs render    # render README.md from data/entries.json
//   node scripts/generate.mjs all       # refresh + render
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dataPath = path.join(root, "data", "entries.json");
const readmePath = path.join(root, "README.md");
const NOW = Date.now();

const CATEGORY_ORDER = [
  "UI", "Navigation", "Deep Linking", "Text & Rich Content", "Analytics",
  "Utils & Infra", "Forms", "Geolocation", "Internationalization",
  "Build & Development", "Styling", "System", "Web", "Media", "Storage",
  "Backend", "Integrations", "Monetization", "Animation", "Extension",
  "Other Platforms", "Utilities", "Seeds", "Libraries", "Frameworks",
  "Open Source Apps",
];

// Curated, high-confidence New Architecture (Fabric/TurboModules) support.
// Only explicitly confirmed libraries earn the badge; absence means "unverified".
const NEW_ARCH = new Set([
  "software-mansion/react-native-reanimated",
  "software-mansion/react-native-gesture-handler",
  "software-mansion/react-native-screens",
  "software-mansion/react-native-svg",
  "shopify/flash-list",
  "shopify/react-native-performance",
  "mrousavy/react-native-vision-camera",
  "mrousavy/react-native-mmkv",
  "expo/expo",
  "expo/router",
  "callstack/react-native-pager-view",
  "react-native-webview/react-native-webview",
  "react-native-async-storage/async-storage",
  "react-native-netinfo/react-native-netinfo",
  "react-native-device-info/react-native-device-info",
  "react-native-picker/picker",
  "react-native-clipboard/clipboard",
  "react-native-datetimepicker/datetimepicker",
  "appandflow/react-native-safe-area-context",
]);

function load() {
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}
function save(db) {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(db, null, 1) + "\n");
}
function run(cmd, args, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { encoding: "utf8" });
    let so = "", se = "";
    p.stdout.on("data", (d) => (so += d));
    p.stderr.on("data", (d) => (se += d));
    if (input !== undefined) { p.stdin.write(input); p.stdin.end(); }
    p.on("close", (code) => resolve({ code, stdout: so, stderr: se }));
  });
}
function ageDays(iso) {
  return Math.floor((NOW - Date.parse(iso)) / 86400e3);
}
function classify(e) {
  if (e.deleted || e.archived) return "dead";
  if (!e.pushedAt) return "dead";
  const d = ageDays(e.pushedAt);
  if (d <= 365) return "active";
  if (d <= 1095) return "stale";
  return "dead";
}
function relTime(iso) {
  const d = ageDays(iso);
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
}
function relTimeLocale(iso, locale) {
  if (locale !== "zh") return relTime(iso);
  const d = ageDays(iso);
  if (d <= 0) return "今天";
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.round(d / 30)} 个月前`;
  return `${(d / 365).toFixed(1)} 年前`;
}
function fmtStars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
function fmtDl(n) {
  if (n === undefined || n === null) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k/wk` : `${n}/wk`;
}

// ---------------------------------------------------------------------------
// Field ownership contract (auto-refresh vs human curation)
//
// Machine-owned (refresh may overwrite):
//   repo, pushedAt, stars, archived, deleted, npmWk, topics
//   desc  — synced from the official repo description, but ONLY when
//           descManual is not set and the API returns a non-empty value
//
// Human-owned (refresh must NEVER touch):
//   category, section, notes, successor, successorNote,
//   addedByAudit, descManual, and anything in the curated badge sets
// ---------------------------------------------------------------------------

const GRAPHQL_BATCH = 50;

async function ghGraphQL(token, query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "user-agent": "awesome-native-react-audit" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data) throw new Error(`GitHub GraphQL error: ${json.errors?.[0]?.message || "unknown"}`);
  return json.data; // NOT_FOUND entries surface as null values + benign errors
}

function repoFragment(alias, repoPath) {
  const [owner, name] = repoPath.split("/");
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner pushedAt stargazerCount isArchived description repositoryTopics(first: 8) { nodes { topic { name } } } }`;
}

async function refreshGithub(db, token) {
  const entries = db.entries;
  let checked = 0;
  let gone = 0;
  for (let i = 0; i < entries.length; i += GRAPHQL_BATCH) {
    const batch = entries.slice(i, i + GRAPHQL_BATCH);
    const query = "query {\n" + batch.map((e, j) => repoFragment(`r${j}`, e.listed)).join("\n") + "\n}";
    const data = await ghGraphQL(token, query);
    for (let j = 0; j < batch.length; j++) {
      const e = batch[j];
      const node = data[`r${j}`];
      if (!node) {
        if (!e.deleted) { e.deleted = true; gone++; }
        continue;
      }
      if (e.deleted) delete e.deleted;
      e.repo = node.nameWithOwner;
      e.pushedAt = node.pushedAt;
      e.stars = node.stargazerCount;
      e.archived = node.isArchived;
      e.topics = node.repositoryTopics.nodes.map((n) => n.topic.name);
      if (!e.descManual && node.description) e.desc = node.description;
    }
    checked += batch.length;
    if (checked % 250 === 0 || checked === entries.length) console.error(`github refresh ${checked}/${entries.length}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`github refresh done: ${checked} checked, ${gone} deleted`);
}

async function refreshNpm(db) {
  const targets = db.entries.filter((e) => !e.deleted && (e.stars >= 800 || e.addedByAudit));
  const queue = [...targets];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const e = queue.shift();
      const pkg = (e.listed.split("/")[1] || "").toLowerCase();
      if (pkg) {
        try {
          const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`, { signal: AbortSignal.timeout(8000) });
          const dl = (await res.json()).downloads;
          if (typeof dl === "number") e.npmWk = dl;
        } catch { /* npm outages never fail the audit */ }
      }
      done++;
      if (done % 100 === 0) console.error(`npm refresh ${done}/${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  console.error(`npm refresh done for ${targets.length} packages`);
}

async function refresh(db) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("refresh requires GH_TOKEN or GITHUB_TOKEN in the environment.");
  await refreshGithub(db, token);
  await refreshNpm(db);
  save(db);
}

function anchor(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cell(text) {
  return String(text || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function libLink(repo, name) {
  return `<a href="https://github.com/${repo}" target="_blank" rel="noopener">${cell(name)}</a>`;
}

const STRINGS = {
  en: {
    file: "README.md",
    switcher: "**Language: English | [简体中文](./README.zh-CN.md)**",
    intro: "The **machine-audited React Native ecosystem index**. Every library is re-verified against GitHub and npm on each audit: maintenance health is measured, not claimed, and dead libraries are moved to the [graveyard](#-graveyard) with a successor when one exists.",
    noPaid: "No badge in this index is paid, requested, or manually overridden.",
    stats: (d) => `> **Last audit:** ${d.date} · **${d.total} libraries** · ✅ ${d.active} active · 🟡 ${d.stale} stale · 💀 ${d.dead} dead/deleted · ✨ ${d.arch} confirmed New Architecture`,
    legendTitle: "| Badge | Meaning |",
    legend: [
      "| ✅ Active | pushed within the last 12 months |",
      "| 🟡 Stale | 1–3 years without a push — use with care |",
      "| 💀 Dead | archived, deleted, or >3 years silent — see the [graveyard](#-graveyard) |",
      "| ✨ New Arch | confirmed React Native New Architecture (Fabric / TurboModules) support |",
    ],
    categories: "## Categories",
    columns: "| Library | Health | Stars | npm/wk | Last push | Notes |",
    builtByUs: "## 🛠 Built by us",
    builtByUsBody: [
      "This index is maintained by a team of heavy React Native users that also builds **first-party libraries to fill the gaps the audit exposes** — dead high-traffic packages, abandoned infrastructure, and missing New Architecture support. Our projects will always be disclosed here, clearly labeled, and never blended into the audited categories above.",
      "",
      "> Nothing published yet — the first library is in development. **Watch this repository** to be notified.",
    ],
    graveyard: "## 💀 Graveyard",
    graveyardIntro: "Popular libraries that are dead, archived, or deleted. **Do not adopt them for new projects.** A successor is listed when one exists.",
    graveyardWarning: (dl) => `> ⚠️ The audit measured **≈${dl} weekly npm downloads** still flowing into dead libraries below. Every one of those installs is a future migration bill.`,
    graveyardColumns: "| Library | Fate | Stars | npm/wk | Last push | Successor | Notes |",
    fate: { deleted: "deleted", archived: "archived", abandoned: "abandoned" },
    method: "## Method",
    methodBody: (n) => [
      `- The index tracks ${n} repositories across the React Native ecosystem; new libraries are added continuously by audit and by pull request.`,
      "- Each refresh re-checks every repository via the GitHub API (existence, last push, stars, archived) and npm weekly downloads for notable packages.",
      "- Objective data (existence, last push, stars, archived state, npm downloads, official descriptions) is auto-refreshed every two days by GitHub Actions. Subjective fields — notes, successors, categories, and New Architecture badges — are human-curated and never overwritten by the automation.",
      "- Health classes: active ≤12 months, stale 12–36 months, dead >36 months / archived / deleted. Dead entries leave their category and appear in the graveyard.",
      `- New Architecture badges are curated from confirmed sources only; an unlisted badge means "unverified", never "incompatible".`,
      "- Regenerate: `node scripts/generate.mjs all`",
    ],
    contribute: "## Contribute",
    contributeBody: [
      "Health data is machine-generated and cannot be edited by hand. But pull requests are very welcome for:",
      "",
      "- adding a missing library (it will be audited automatically on the next refresh)",
      "- improving descriptions",
      "- documenting a successor for a graveyard entry",
      "- confirming or correcting a New Architecture badge (with a link as evidence)",
    ],
    inspiration: "## Inspiration",
    inspirationBody: 'This index started life as a full audit of <a href="https://github.com/jondot/awesome-react-native" target="_blank" rel="noopener">jondot/awesome-react-native</a> — the list that catalogued the ecosystem for years. Thanks to its maintainers for the foundation; everything since the 2021 snapshot is re-measured, re-classified, and continuously refreshed here.',
  },
  zh: {
    file: "README.zh-CN.md",
    switcher: "**语言：[English](./README.md) | 简体中文**",
    intro: "**机器审计的 React Native 生态索引**。每次审计都会对 GitHub 和 npm 重新核验所有库：维护状态靠测量，不靠自称；已死的库会被移入[墓地](#-墓地)，并尽可能标注继任者。",
    noPaid: "本索引中没有任何徽章是付费获得、申请获得或人工覆盖的。",
    stats: (d) => `> **最近审计：** ${d.date} · **${d.total} 个库** · ✅ ${d.active} 活跃 · 🟡 ${d.stale} 老化 · 💀 ${d.dead} 已死/删除 · ✨ ${d.arch} 个确认支持新架构`,
    legendTitle: "| 徽章 | 含义 |",
    legend: [
      "| ✅ 活跃 | 最近 12 个月内有提交 |",
      "| 🟡 老化 | 1–3 年无提交——谨慎使用 |",
      "| 💀 已死 | 已归档、已删除或沉默超过 3 年——见[墓地](#-墓地) |",
      "| ✨ 新架构 | 已确认支持 React Native 新架构（Fabric / TurboModules） |",
    ],
    categories: "## 分类",
    columns: "| 库 | 状态 | Stars | npm/周 | 最近推送 | 备注 |",
    builtByUs: "## 🛠 我们自建",
    builtByUsBody: [
      "本索引由一群重度 React Native 用户维护，我们同时也**自建第一方库来填补审计暴露的空白**——高流量死库、被抛弃的基础设施、缺失的新架构支持。我们的项目会始终在这里披露、明确标注，且永远不会混入上方的审计分类。",
      "",
      "> 尚未发布——第一个库正在开发中。**Watch 本仓库**以获得通知。",
    ],
    graveyard: "## 💀 墓地",
    graveyardIntro: "已死、已归档或已删除的流行库。**请勿在新项目中采用。** 如有继任者，会一并标注。",
    graveyardWarning: (dl) => `> ⚠️ 审计发现，每周仍有 **约 ${dl} 次 npm 下载**流向以下已死库。每一次安装都是未来的迁移账单。`,
    graveyardColumns: "| 库 | 结局 | Stars | npm/周 | 最近推送 | 继任者 | 备注 |",
    fate: { deleted: "已删除", archived: "已归档", abandoned: "已废弃" },
    method: "## 方法",
    methodBody: (n) => [
      `- 索引跟踪 React Native 生态中的 ${n} 个仓库；新库通过审计和 PR 持续加入。`,
      "- 每次刷新都会通过 GitHub API 重新核验每个仓库（存在性、最近推送、stars、归档状态），并查询知名包的 npm 周下载量。",
      "- 客观数据（存在性、最近推送、stars、归档状态、npm 下载、官方描述）由 GitHub Actions 每两天自动刷新。主观字段——备注、继任者、分类、新架构徽章——由人工维护，自动化永不覆盖。",
      "- 健康分级：活跃 ≤12 个月，老化 12–36 个月，已死 >36 个月 / 已归档 / 已删除。已死条目离开原分类，进入墓地。",
      "- 新架构徽章仅根据已确认来源策展；未标注表示“未验证”，绝不表示“不兼容”。",
      "- 重新生成：`node scripts/generate.mjs all`",
    ],
    contribute: "## 参与贡献",
    contributeBody: [
      "健康数据由机器生成，不能手工编辑。但非常欢迎以下类型的 PR：",
      "",
      "- 补充缺失的库（下次刷新时会自动审计）",
      "- 改进描述",
      "- 为墓地条目记录继任者",
      "- 确认或纠正新架构徽章（附证据链接）",
    ],
    inspiration: "## 灵感来源",
    inspirationBody: '本索引起源于对 <a href="https://github.com/jondot/awesome-react-native" target="_blank" rel="noopener">jondot/awesome-react-native</a> 的一次完整审计——这份列表曾为生态编目多年。感谢维护者打下的基础；2021 年快照之后的一切，在这里被重新测量、重新分级并持续刷新。',
  },
};

function renderDoc(db, locale) {
  const t = STRINGS[locale];
  const entries = db.entries.map((e) => ({ ...e, health: classify(e) }));
  const counts = { active: 0, stale: 0, dead: 0 };
  for (const e of entries) counts[e.health]++;
  const graves = entries
    .filter((e) => e.health === "dead" && ((e.stars || 0) >= 1500 || e.deleted))
    .sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const deadDownloads = entries
    .filter((e) => e.health === "dead" && typeof e.npmWk === "number")
    .reduce((sum, e) => sum + e.npmWk, 0);
  const newArchCount = entries.filter((e) => NEW_ARCH.has((e.repo || e.listed).toLowerCase())).length;

  const out = [];
  out.push(`# Awesome Native React`);
  out.push("");
  out.push(t.switcher);
  out.push("");
  out.push(t.intro);
  out.push("");
  out.push(t.noPaid);
  out.push("");
  out.push(t.stats({ date: db.updatedAt.slice(0, 10), total: entries.length, active: counts.active, stale: counts.stale, dead: counts.dead, arch: newArchCount }));
  out.push("");
  out.push(t.legendTitle);
  out.push(`| --- | --- |`);
  out.push(...t.legend);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(t.categories);
  out.push("");

  const byCat = new Map();
  for (const e of entries) {
    if (e.health === "dead") continue;
    const key = CATEGORY_ORDER.includes(e.category) ? e.category : "Misc";
    (byCat.get(key) || byCat.set(key, []).get(key)).push(e);
  }
  const cats = CATEGORY_ORDER.filter((c) => byCat.has(c));
  if (byCat.has("Misc")) cats.push("Misc");

  out.push(cats.map((c) => `[${c}](#${anchor(c)})`).join(" · "));
  out.push("");

  for (const c of cats) {
    const list = byCat.get(c).sort((a, b) => {
      if (a.health !== b.health) return a.health === "active" ? -1 : 1;
      return (b.stars || 0) - (a.stars || 0);
    });
    out.push(`### ${c}`);
    out.push("");
    out.push(t.columns);
    out.push(`| --- | --- | ---: | ---: | --- | --- |`);
    for (const e of list) {
      const icon = e.health === "active" ? "✅" : "🟡";
      const arch = NEW_ARCH.has((e.repo || e.listed).toLowerCase()) ? " ✨" : "";
      const name = (e.listed.split("/")[1] || e.listed);
      const dl = typeof e.npmWk === "number" ? fmtDl(e.npmWk).replace("/wk", "") : "";
      const notes = cell(e.notes || e.desc);
      out.push(`| ${libLink(e.repo || e.listed, name)} | ${icon}${arch} | ${fmtStars(e.stars || 0)} | ${dl} | ${relTimeLocale(e.pushedAt, locale)} | ${notes} |`);
    }
    out.push("");
  }

  out.push(`---`);
  out.push("");
  out.push(t.builtByUs);
  out.push("");
  out.push(...t.builtByUsBody);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(t.graveyard);
  out.push("");
  out.push(t.graveyardIntro);
  out.push("");
  if (deadDownloads > 0) {
    out.push(t.graveyardWarning(fmtDl(deadDownloads).replace("/wk", "")));
    out.push("");
  }
  out.push(t.graveyardColumns);
  out.push(`| --- | --- | ---: | ---: | --- | --- | --- |`);
  for (const e of graves) {
    const name = e.listed.split("/")[1] || e.listed;
    const fateKey = e.deleted ? "deleted" : e.archived ? "archived" : "abandoned";
    const dl = typeof e.npmWk === "number" ? fmtDl(e.npmWk).replace("/wk", "") : "";
    const lastPush = e.deleted || !e.pushedAt ? "—" : relTimeLocale(e.pushedAt, locale);
    let successor = "—";
    if (e.successor) {
      successor = libLink(e.successor, e.successor.split("/")[1]);
      if (e.successorNote) successor += ` (${cell(e.successorNote)})`;
    }
    out.push(`| **${cell(name)}** | 💀 ${t.fate[fateKey]} | ${fmtStars(e.stars || 0)} | ${dl} | ${lastPush} | ${successor} | ${cell(e.desc)} |`);
  }
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(t.method);
  out.push("");
  out.push(...t.methodBody(entries.length));
  out.push("");
  out.push(t.contribute);
  out.push("");
  out.push(...t.contributeBody);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(t.inspiration);
  out.push("");
  out.push(t.inspirationBody);
  out.push("");
  return out.join("\n");
}

function render(db) {
  const entries = db.entries;
  for (const locale of ["en", "zh"]) {
    const t = STRINGS[locale];
    fs.writeFileSync(path.join(root, t.file), renderDoc(db, locale));
  }
  const counts = { active: 0, stale: 0, dead: 0 };
  for (const e of entries) counts[classify(e)]++;
  console.error(`README.md + README.zh-CN.md rendered: ${entries.length} entries (${counts.active}/${counts.stale}/${counts.dead})`);
}

const cmd = process.argv[2] || "all";
const db = load();
if (cmd === "refresh" || cmd === "all") await refresh(db);
if (cmd === "render" || cmd === "all") render(load());
