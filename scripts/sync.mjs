#!/usr/bin/env node
/**
 * Syncs the live Gemini 4 Argon showcase catalog from WorkSkill
 * and generates:
 *   - data/gemini-4-argon.json
 *   - categories/<category>.md
 *   - README.md
 *
 * Usage: node scripts/sync.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API_BASE = "https://workskill.tools/api/ai-videos/feed";
const SITE_GALLERY = "https://workskill.tools/ai-videos/gemini-4-argon";

const CATEGORY_LABELS = {
  "3d-scenes": "3D Scenes & Worlds",
  "interactive-games": "Interactive Games",
  "games": "Interactive Games",
  "web-apps": "Web Apps & UI",
  "ui": "UI & Interfaces",
  "motion": "Motion & Visuals",
  "shaders": "Shaders & Generative Art",
  "simulations": "Physics & Simulations",
  "data-viz": "Data Visualization",
  "creative-coding": "Creative Coding",
  "promo": "Launch & Promo Videos",
  "other": "Other Experiments",
};

function labelFor(cat) {
  if (!cat) return "Uncategorized";
  if (CATEGORY_LABELS[cat]) return CATEGORY_LABELS[cat];
  return cat
    .split(/[-_]/g)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function escapeMd(text) {
  return String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text, max = 120) {
  const clean = escapeMd(text);
  if (!clean) return "—";
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

async function fetchAll() {
  const all = [];
  const pageSize = 48;
  let page = 1;
  let total = Infinity;

  while (all.length < total) {
    const url = `${API_BASE}?model=gemini-4-argon&page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status} for ${url}`);
    const json = await res.json();
    const batch = Array.isArray(json.data) ? json.data : (json.data?.items ?? []);
    if (typeof json.data?.total === "number") total = json.data.total;
    else if (typeof json.total === "number") total = json.total;
    if (!batch.length) break;
    all.push(...batch);
    page += 1;
    if (batch.length < pageSize) break;
  }

  // Deduplicate by slug preserving order
  const seen = new Set();
  return all.filter((item) => {
    if (!item?.slug || seen.has(item.slug)) return false;
    seen.add(item.slug);
    return true;
  });
}

async function main() {
  console.log("Fetching Gemini 4 Argon catalog from WorkSkill...");
  const rawItems = await fetchAll();
  console.log(`Fetched ${rawItems.length} unique demos.`);

  const dataset = rawItems.map((it) => ({
    slug: it.slug,
    title: it.title || it.slug,
    category: it.category || "other",
    authorHandle: it.authorHandle || null,
    authorUrl: it.authorUrl || (it.authorHandle ? `https://x.com/${it.authorHandle}` : null),
    postUrl: it.postUrl || null,
    watchUrl: `${SITE_GALLERY}/${it.slug}`,
    prompt: it.prompt || null,
    notes: it.postText || null,
    techTags: Array.isArray(it.techTags) ? it.techTags : [],
    width: it.width || null,
    height: it.height || null,
    durationSeconds: it.durationSeconds || null,
    postedAt: it.postedAt || null,
  }));

  // Group by category
  const byCategory = new Map();
  for (const item of dataset) {
    const key = item.category || "other";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(item);
  }
  const sortedCategories = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);

  // 1. Write data/gemini-4-argon.json
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(
    join(ROOT, "data", "gemini-4-argon.json"),
    JSON.stringify(
      {
        source: SITE_GALLERY,
        generatedAt: new Date().toISOString().slice(0, 10),
        total: dataset.length,
        categories: Object.fromEntries(sortedCategories.map(([k, v]) => [k, v.length])),
        items: dataset,
      },
      null,
      2,
    ) + "\n",
  );

  // 2. Write categories/<cat>.md
  const catDir = join(ROOT, "categories");
  rmSync(catDir, { recursive: true, force: true });
  mkdirSync(catDir, { recursive: true });

  for (const [cat, items] of sortedCategories) {
    const title = labelFor(cat);
    const rows = items
      .map((it, idx) => {
        const creator = it.authorHandle
          ? `[@${it.authorHandle}](${it.authorUrl})`
          : "—";
        const snippet = clip(it.prompt || it.notes, 110);
        const links = [
          `[▶ Watch](${it.watchUrl})`,
          it.postUrl ? `[Source](${it.postUrl})` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return `| ${idx + 1} | **${escapeMd(it.title)}** | ${creator} | ${formatDuration(it.durationSeconds)} | ${snippet} | ${links} |`;
      })
      .join("\n");

    const md = `# ${title} — Gemini 4 Argon (${items.length} Demos)

[← Back to Awesome Gemini 4 Argon](../README.md) · [▶ Watch all in live waterfall gallery](${SITE_GALLERY})

| # | Demo | Creator | Duration | Prompt / Notes | Links |
| --- | --- | --- | :---: | --- | --- |
${rows}

---

*Curated & hosted live at [WorkSkill — Gemini 4 Argon Gallery](${SITE_GALLERY}).*
`;
    writeFileSync(join(catDir, `${cat}.md`), md);
  }

  // 3. Pick Top 25 Featured Highlights (prefer items with prompt or rich notes + diverse categories)
  const withPrompt = dataset.filter((d) => d.prompt && d.prompt.trim().length > 20);
  const featured = [];
  const picked = new Set();
  for (const list of [withPrompt, dataset]) {
    for (const item of list) {
      if (featured.length >= 25) break;
      if (picked.has(item.slug)) continue;
      picked.add(item.slug);
      featured.push(item);
    }
  }

  const categoryTable = sortedCategories
    .map(
      ([cat, items]) =>
        `| [${labelFor(cat)}](./categories/${cat}.md) | **${items.length}** | [Browse ${cat} →](${SITE_GALLERY}) |`,
    )
    .join("\n");

  const featuredTable = featured
    .map((it, idx) => {
      const creator = it.authorHandle
        ? `[@${it.authorHandle}](${it.authorUrl})`
        : "—";
      const note = clip(it.prompt || it.notes, 95);
      const links = [
        `[▶ Watch](${it.watchUrl})`,
        it.postUrl ? `[Post](${it.postUrl})` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `| ${idx + 1} | **${escapeMd(it.title)}** | \`${it.category}\` | ${creator} | ${note} | ${links} |`;
    })
    .join("\n");

  const promptCount = dataset.filter((d) => d.prompt && d.prompt.trim().length > 0).length;
  const uniqueCreators = new Set(dataset.map((d) => d.authorHandle).filter(Boolean)).size;

  // 4. Write README.md
  const readme = `<p align="center">
  <a href="${SITE_GALLERY}">
    <img src="https://workskill.tools/og-default.png?v=20261124b" alt="WorkSkill — Awesome Gemini 4 Argon" width="100%" />
  </a>
</p>

# Awesome Gemini 4 Argon

> **WorkSkill Open-Source Series:** [Awesome Agent Skills](https://github.com/mailes/awesome-agent-skills) · [Free AI Website Skills](https://github.com/mailes/free-ai-website-skills) · [Awesome Claude 5.5 Videos](https://github.com/mailes/awesome-claude-5-5-videos) · **Awesome Gemini 4 Argon** · [Live Store & MCP](https://workskill.tools)

[![Demos](https://img.shields.io/badge/Demos-${dataset.length}+-111111?style=for-the-badge)](${SITE_GALLERY})
[![Creators](https://img.shields.io/badge/Creators-${uniqueCreators}+-2563eb?style=for-the-badge)](${SITE_GALLERY})
[![Live Gallery](https://img.shields.io/badge/Watch_Live-workskill.tools-10b981?style=for-the-badge)](${SITE_GALLERY})
[![MCP](https://img.shields.io/badge/WorkSkill_MCP-Claude_%7C_Codex_%7C_Cursor-7c3aed?style=for-the-badge)](https://workskill.tools/mcp)

A curated, searchable index of **${dataset.length} real 3D scenes, interactive games, web experiments, shaders, and motion demos** built with **Gemini 4 Argon** — complete with creator credits, original posts, prompts (${promptCount} indexed), and an open JSON dataset.

> **▶ Watch all ${dataset.length} videos live (auto-playing masonry wall + instant search + 1-click prompt copy):**
> **[https://workskill.tools/ai-videos/gemini-4-argon](${SITE_GALLERY})**

---

## Browse by Category

| Category | Demos | Live Gallery |
| --- | :---: | --- |
${categoryTable}

---

## Featured Highlights (Top 25)

| # | Demo | Category | Creator | Prompt / Notes | Links |
| --- | --- | --- | --- | --- | --- |
${featuredTable}

👉 **[Explore all ${dataset.length} demos with instant video playback on WorkSkill →](${SITE_GALLERY})**

---

## Open JSON Dataset

Want to analyze Gemini 4 Argon prompts, build a benchmark, or explore trends? Every entry is available in [\`data/gemini-4-argon.json\`](./data/gemini-4-argon.json):

\`\`\`bash
# Inspect top categories & prompt count
node -e "const d = require('./data/gemini-4-argon.json'); console.log(d.total, d.categories);"
\`\`\`

Each item includes:
- \`slug\`, \`title\`, \`category\`, \`techTags\`
- \`authorHandle\`, \`authorUrl\`, \`postUrl\`
- \`watchUrl\` (direct link to playable video & side-by-side view)
- \`prompt\`, \`notes\`, \`width\`, \`height\`, \`durationSeconds\`, \`postedAt\`

---

## More Free AI Video & Design Galleries

Maintained by **[WorkSkill](https://workskill.tools)** — production-grade Agent Skills, editable templates, and visual inspiration for **Claude Code, Codex, and Cursor**:

| Gallery / Tool | What's Inside | Link |
| --- | --- | --- |
| **Gemini 4 Argon Gallery** | ${dataset.length} 3D scenes, games & interactive demos | [workskill.tools/ai-videos/gemini-4-argon](https://workskill.tools/ai-videos/gemini-4-argon) |
| **Design References Wall** | 1,300+ curated Web, UI, Branding & Motion references (free) | [workskill.tools/ai-videos/design-references](https://workskill.tools/ai-videos/design-references) |
| **Opus 5.5 Showcases** | 500+ viral Claude Opus 5.5 videos & prompts | [workskill.tools/ai-videos/opus-5-5](https://workskill.tools/ai-videos/opus-5-5) |
| **Fable 5.2 Showcases** | 260+ motion & visual demos with prompts | [workskill.tools/ai-videos/fable5-2](https://workskill.tools/ai-videos/fable5-2) |
| **WorkSkill MCP** | Connect Claude Code / Codex / Cursor to pull verified Skills in 1 command | [workskill.tools/mcp](https://workskill.tools/mcp) |

---

## Contributing & Creator Credits

- **Submit a demo**: Open a Pull Request or Issue with the original X/community link and prompt.
- **Keep it fresh**: Run \`node scripts/sync.mjs\` to regenerate the dataset and category tables from the live catalog.
- **Creator attribution & removal**: Every demo credits its original creator (\`@handle\`) and links directly to the original post. No raw third-party video files are stored in this repository. If you are a creator and would like your work updated or removed, please open an issue or contact us via [workskill.tools](https://workskill.tools) and we will handle it promptly.

## License

The repository scripts, index structure, and metadata compilation are released under the [MIT License](./LICENSE). Individual creative works remain the property of their respective creators.
`;

  writeFileSync(join(ROOT, "README.md"), readme);
  console.log(`Generated README.md, data/gemini-4-argon.json, and ${sortedCategories.length} category files.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
