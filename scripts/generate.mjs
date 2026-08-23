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
function fmtStars(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
function fmtDl(n) {
  if (n === undefined || n === null) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k/wk` : `${n}/wk`;
}

async function refresh(db) {
  const live = db.entries.filter((e) => !e.deleted);
  let idx = 0, done = 0, gone = 0;
  async function worker() {
    while (idx < live.length) {
      const e = live[idx++];
      const r = await run("gh", ["api", `repos/${e.listed}`, "--jq", "{full_name,pushed_at,stargazers_count,archived}"]);
      if (r.code === 0) {
        try {
          const d = JSON.parse(r.stdout);
          e.repo = d.full_name; e.pushedAt = d.pushed_at; e.stars = d.stargazers_count; e.archived = d.archived;
          delete e.deleted;
        } catch { /* keep old */ }
      } else if (/404/.test(r.stderr)) {
        e.deleted = true; gone++;
      }
      if (++done % 100 === 0) console.error(`refresh ${done}/${live.length}`);
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  console.error(`github refresh done: ${live.length} checked, ${gone} newly deleted`);

  const targets = db.entries.filter((e) => !e.deleted && (e.stars >= 800 || e.addedByAudit));
  idx = 0;
  async function npmWorker() {
    while (idx < targets.length) {
      const e = targets[idx++];
      const pkg = (e.listed.split("/")[1] || "").toLowerCase();
      if (!pkg) continue;
      const r = await run("curl", ["-s", "-m", "8", `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`]);
      try {
        const dl = JSON.parse(r.stdout).downloads;
        if (typeof dl === "number") e.npmWk = dl;
      } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: 12 }, npmWorker));
  console.error(`npm refresh done for ${targets.length} packages`);
  save(db);
}

function anchor(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function render(db) {
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
  out.push(`The **machine-audited React Native ecosystem index** — the living successor to the classic [awesome-react-native](https://github.com/jondot/awesome-react-native) list, which has been frozen since April 2021.`);
  out.push("");
  out.push(`Every entry is re-verified against GitHub and npm on each audit: maintenance health is measured, not claimed, and dead libraries are moved to the [graveyard](#-graveyard) with a successor when one exists. No badge in this list is paid, requested, or manually overridden.`);
  out.push("");
  out.push(`> **Last audit:** ${db.updatedAt.slice(0, 10)} · **${entries.length} libraries** · ✅ ${counts.active} active · 🟡 ${counts.stale} stale · 💀 ${counts.dead} dead/deleted · ✨ ${newArchCount} confirmed New Architecture`);
  out.push("");
  out.push(`| Badge | Meaning |`);
  out.push(`| --- | --- |`);
  out.push(`| ✅ Active | pushed within the last 12 months |`);
  out.push(`| 🟡 Stale | 1–3 years without a push — use with care |`);
  out.push(`| 💀 Dead | archived, deleted, or >3 years silent — see the [graveyard](#-graveyard) |`);
  out.push(`| ✨ New Arch | confirmed React Native New Architecture (Fabric / TurboModules) support |`);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(`## Categories`);
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
    for (const e of list) {
      const icon = e.health === "active" ? "✅" : "🟡";
      const arch = NEW_ARCH.has((e.repo || e.listed).toLowerCase()) ? " ✨" : "";
      const bits = [`★${fmtStars(e.stars || 0)}`, `pushed ${relTime(e.pushedAt)}`];
      if (e.npmWk) bits.push(`npm ${fmtDl(e.npmWk)}`);
      const desc = e.desc ? ` — ${e.desc}` : "";
      const name = (e.listed.split("/")[1] || e.listed);
      out.push(`- ${icon}${arch} [${name}](https://github.com/${e.repo || e.listed})${desc} · ${bits.join(" · ")}`);
    }
    out.push("");
  }

  out.push(`---`);
  out.push("");
  out.push(`## 🛠 Built by us`);
  out.push("");
  out.push(`This index is maintained by a team of heavy React Native users that also builds **first-party libraries to fill the gaps the audit exposes** — dead high-traffic packages, abandoned infrastructure, and missing New Architecture support. Our projects will always be disclosed here, clearly labeled, and never blended into the audited categories above.`);
  out.push("");
  out.push(`> Nothing published yet — the first library is in development. **Watch this repository** to be notified.`);
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(`## 💀 Graveyard`);
  out.push("");
  out.push(`Popular libraries that are dead, archived, or deleted. **Do not adopt them for new projects.** A successor is listed when one exists.`);
  out.push("");
  if (deadDownloads > 0) {
    out.push(`> ⚠️ The audit measured **≈${fmtDl(deadDownloads).replace("/wk", "")} weekly npm downloads** still flowing into dead libraries below. Every one of those installs is a future migration bill.`);
    out.push("");
  }
  for (const e of graves) {
    const name = e.listed.split("/")[1] || e.listed;
    const status = e.deleted ? "deleted" : e.archived ? "archived" : `last push ${relTime(e.pushedAt)}`;
    const dl = typeof e.npmWk === "number" ? ` · npm ${fmtDl(e.npmWk)}` : "";
    let line = `- 💀 **${name}** · ★${fmtStars(e.stars || 0)} · ${status}${dl}`;
    if (e.desc) line += ` — ${e.desc}`;
    if (e.successor) line += ` → **successor:** [${e.successor.split("/")[1]}](https://github.com/${e.successor})`;
    if (e.successorNote) line += ` (${e.successorNote})`;
    out.push(line);
  }
  out.push("");
  out.push(`---`);
  out.push("");
  out.push(`## Method`);
  out.push("");
  out.push(`- Source corpus: the 1,090 repositories listed in jondot/awesome-react-native (last updated 2021-04), plus notable post-2021 libraries added by the audit.`);
  out.push(`- Each refresh re-checks every repository via the GitHub API (existence, last push, stars, archived) and npm weekly downloads for notable packages.`);
  out.push(`- Health classes: active ≤12 months, stale 12–36 months, dead >36 months / archived / deleted. Dead entries leave their category and appear in the graveyard.`);
  out.push(`- New Architecture badges are curated from confirmed sources only; an unlisted badge means "unverified", never "incompatible".`);
  out.push(`- Regenerate: \`node scripts/generate.mjs all\``);
  out.push("");
  out.push(`## Contribute`);
  out.push("");
  out.push(`Health data is machine-generated and cannot be edited by hand. But pull requests are very welcome for:`);
  out.push("");
  out.push(`- adding a missing library (it will be audited automatically on the next refresh)`);
  out.push(`- improving descriptions`);
  out.push(`- documenting a successor for a graveyard entry`);
  out.push(`- confirming or correcting a New Architecture badge (with a link as evidence)`);
  out.push("");
  fs.writeFileSync(readmePath, out.join("\n"));
  console.error(`README.md rendered: ${entries.length} entries (${counts.active}/${counts.stale}/${counts.dead}, ${newArchCount} new-arch)`);
}

const cmd = process.argv[2] || "all";
const db = load();
if (cmd === "refresh" || cmd === "all") await refresh(db);
if (cmd === "render" || cmd === "all") render(load());
