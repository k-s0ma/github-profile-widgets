// github-profile-widgets — minimal SVG widgets for GitHub profile READMEs
// Usage: node src/widgets.mjs   (all settings are optional environment variables)
//   GH_USER         target user            default: $GITHUB_REPOSITORY_OWNER
//   KEY_COLOR       key color  (data, name, numbers)        default #1f2328
//   SUB_COLOR       sub color  (ticks, labels, empty cells) default #8c959f
//   KEY_COLOR_DARK  key color in dark mode                  default #e6edf3
//   SUB_COLOR_DARK  sub color in dark mode                  default #6e7681
//   TIMEZONE        IANA time zone for the clock            default Asia/Tokyo
//   CLOCK_TICKS     clock ticks        hour | 15m           default 15m
//   CLOCK_SHADE     clock cell size    hour | 15m           default 15m
//   WEEK_START      first day of week  sun | mon            default sun
//   ANIMATION       play once on load  on | off             default on
//   OUT_DIR         output directory                        default assets
//   GITHUB_TOKEN    used for the GraphQL contribution calendar if present
import { readFile, writeFile, mkdir } from "node:fs/promises";
import subsetFont from "subset-font";

const env = process.env;
const USER = env.GH_USER || env.GITHUB_REPOSITORY_OWNER;
if (!USER) throw new Error("Set GH_USER. / GH_USER を指定してください。");
const TZ = env.TIMEZONE || "Asia/Tokyo";
const option = (name, choices, fallback) => {
  const v = env[name] || fallback;
  if (!choices.includes(v)) throw new Error(`${name} must be one of ${choices.join(" / ")} (got: ${v}). / ${name} は ${choices.join(" / ")} のどれかを指定してください。`);
  return v;
};
const PER_HOUR = { hour: 1, "15m": 4 }; // 1時間あたりの区切り数
const CLOCK_TICKS = PER_HOUR[option("CLOCK_TICKS", ["hour", "15m"], "15m")];
const CLOCK_SHADE = PER_HOUR[option("CLOCK_SHADE", ["hour", "15m"], "15m")];
const WEEK_START = option("WEEK_START", ["sun", "mon"], "sun");
const ANIMATION = option("ANIMATION", ["on", "off"], "on") === "on";
const OUT_DIR = env.OUT_DIR || "assets";
const COLOR = {
  key: env.KEY_COLOR || "#1f2328",
  sub: env.SUB_COLOR || "#8c959f",
  keyDark: env.KEY_COLOR_DARK || "#e6edf3",
  subDark: env.SUB_COLOR_DARK || "#6e7681",
};
const token = env.GITHUB_TOKEN;

const headers = {
  "User-Agent": "github-profile-widgets",
  Accept: "application/vnd.github+json",
  ...(token && { Authorization: `Bearer ${token}` }),
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// ---- data ----

// [{ date: "YYYY-MM-DD", count }] を日付順で返す
async function contributionDays() {
  if (token) {
    const query = `query { user(login: "${USER}") { contributionsCollection { contributionCalendar {
      weeks { contributionDays { date contributionCount } } } } } }`;
    const res = await fetch("https://api.github.com/graphql", { method: "POST", headers, body: JSON.stringify({ query }) });
    const weeks = (await res.json()).data.user.contributionsCollection.contributionCalendar.weeks;
    return weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
  }
  // トークンが無いときは公開ページから読む
  const html = await (await fetch(`https://github.com/users/${USER}/contributions`)).text();
  const counts = {};
  for (const [, id, text] of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    counts[id] = Number(text.match(/^(\d+) contribution/)?.[1] ?? 0);
  }
  const days = [];
  for (const [tag] of html.matchAll(/<td[^>]*ContributionCalendar-day[^>]*>/g)) {
    const date = tag.match(/data-date="([^"]+)"/)?.[1];
    const id = tag.match(/id="([^"]+)"/)?.[1];
    if (date) days.push({ date, count: counts[id] ?? 0 });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

const user = await api(`/users/${USER}`);
const repos = (await api(`/users/${USER}/repos?per_page=100&type=owner`))
  .filter((r) => !r.fork && r.name !== USER && r.size > 0); // フォーク・プロフィール用・空のリポジトリは除外

const days = await contributionDays();
const weeks = [];
for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
const weekTotals = weeks.map((w) => w.reduce((s, d) => s + d.count, 0));
const yearTotal = days.reduce((s, d) => s + d.count, 0);

// コミット時刻を TZ の「曜日・時・分」に変換して集計
const local = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
const WEEKDAYS = WEEK_START === "sun"
  ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = Array(24).fill(0);
const minutesOfDay = []; // 0〜1439
const punch = WEEKDAYS.map(() => Array(24).fill(0)); // [曜日][時]
for (const repo of repos) {
  for (const c of await api(`/repos/${USER}/${repo.name}/commits?author=${USER}&per_page=100`)) {
    const p = Object.fromEntries(local.formatToParts(new Date(c.commit.author.date)).map((x) => [x.type, x.value]));
    const h = Number(p.hour);
    hours[h]++;
    minutesOfDay.push(h * 60 + Number(p.minute));
    punch[WEEKDAYS.indexOf(p.weekday)][h]++;
  }
}

const langBytes = {};
for (const repo of repos) {
  for (const [lang, bytes] of Object.entries(await api(`/repos/${USER}/${repo.name}/languages`))) {
    langBytes[lang] = (langBytes[lang] ?? 0) + bytes;
  }
}
const langTotal = Object.values(langBytes).reduce((a, b) => a + b, 0);
const langs = Object.entries(langBytes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 4)
  .map(([name, bytes]) => ({ name, ratio: langTotal ? bytes / langTotal : 0 }));

// ---- svg helpers ----

const W = 480; // 全パーツ共通の横幅
const FONT = `"Widgets Sans", "DIN Next", "DIN Pro", "DIN 2014", Bahnschrift, "Noto Sans JP", "Noto Sans", sans-serif`;
const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const f = (n) => Number(n.toFixed(1));

// .key / .sub で塗り、.key-s / .sub-s で線を引く
const svg = (h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">
  <style>
    text { font-family: ${FONT}; }
    .key { fill: ${COLOR.key}; } .sub { fill: ${COLOR.sub}; }
    .key-s { stroke: ${COLOR.key}; fill: none; } .sub-s { stroke: ${COLOR.sub}; fill: none; }
    .name { font-size: 26px; font-weight: 400; letter-spacing: 0.04em; }
    .num { font-size: 28px; font-weight: 300; }
    .label { font-size: 11px; letter-spacing: 0.08em; }
    @media (prefers-color-scheme: dark) {
      .key { fill: ${COLOR.keyDark}; } .sub { fill: ${COLOR.subDark}; }
      .key-s { stroke: ${COLOR.keyDark}; } .sub-s { stroke: ${COLOR.subDark}; }
    }${ANIMATION ? `
    @keyframes fade { from { opacity: 0; } }
    @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
    @keyframes grow { from { transform: scaleX(0); } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }` : ""}
  </style>
${body}
</svg>
`;

// 値が 0 ならサブカラーの薄い点、それ以外はキーカラーで濃淡
const mark = (v, max) => (v === 0 ? `class="sub" opacity="0.35"` : `class="key" opacity="${(0.35 + 0.65 * (v / max)).toFixed(2)}"`);

// 最初の1回だけ再生するアニメーション。kind = fade | rise | grow、delay = 開始までの ms
const anim = (kind, delay = 0, duration = 500) => {
  if (!ANIMATION) return "";
  const extra = kind === "grow" ? " transform-box: fill-box; transform-origin: left center;" : "";
  return ` style="animation: ${kind} ${duration}ms cubic-bezier(.2,.7,.2,1) ${Math.round(delay)}ms both;${extra}"`;
};

// 中心 (cx, cy) の円環を a0〜a1 で切り出した形（角度はラジアン、0 = 12時方向）
// 始点側・終点側の隙間 g0 / g1(px) は内側・外側とも同じ幅になるようにする
function sector(cx, cy, r0, r1, a0, a1, g0, g1) {
  const pt = (r, a) => `${f(cx + r * Math.sin(a))} ${f(cy - r * Math.cos(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${pt(r1, a0 + g0 / 2 / r1)} A ${r1} ${r1} 0 ${large} 1 ${pt(r1, a1 - g1 / 2 / r1)} L ${pt(r0, a1 - g1 / 2 / r0)} A ${r0} ${r0} 0 ${large} 0 ${pt(r0, a0 + g0 / 2 / r0)} Z`;
}

// アナログ時計の文字盤。sub = 1時間あたりの目盛り数（1: 時のみ / 4: 15分）
function dial(cx, cy, R, sub) {
  const out = [];
  const n = 12 * sub;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const hour = i % sub === 0;
    const r0 = R - (hour ? 7 : 3);
    out.push(`  <line x1="${f(cx + r0 * Math.sin(a))}" y1="${f(cy - r0 * Math.cos(a))}" x2="${f(cx + R * Math.sin(a))}" y2="${f(cy - R * Math.cos(a))}" class="sub-s" stroke-width="${hour ? 1 : 0.5}"/>`);
  }
  for (const [label, pos] of [[12, 0], [3, 3], [6, 6], [9, 9]]) {
    const a = (pos / 12) * 2 * Math.PI, r = R + 12;
    out.push(`  <text x="${f(cx + r * Math.sin(a))}" y="${f(cy - r * Math.cos(a) + 4)}" class="label sub" text-anchor="middle">${label}</text>`);
  }
  return out;
}

// 12時間分の活動を円環上に並べる。values.length = 12 * sub
// 時の区切りは 3px、分の区切りは 1px の隙間。start 〜 start + span(ms) で時計回りに灯る
function ring(cx, cy, r0, r1, values, max, sub, start, span) {
  const n = values.length;
  return values.map((v, i) => {
    const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
    const g0 = i % sub === 0 ? 3 : 1, g1 = (i + 1) % sub === 0 ? 3 : 1;
    return `  <path d="${sector(cx, cy, r0, r1, a0, a1, g0, g1)}" ${mark(v, max)}${anim("fade", start + (i / n) * span, 300)}/>`;
  });
}

// 1日を 24 * sub 個に区切ってコミット数を数える
function bins(sub) {
  const out = Array(24 * sub).fill(0);
  for (const m of minutesOfDay) out[Math.floor(m / (60 / sub))]++;
  return out;
}

// ---- parts ----

const parts = {};

// 名前（GitHub の表示名）
parts["name"] = svg(36, `  <text x="0" y="28" class="name key"${anim("fade", 0, 900)}>${escape(user.name ?? user.login)}</text>`);

// ① 52週のドット 1行
{
  const max = Math.max(1, ...weekTotals);
  const gap = W / weekTotals.length;
  parts["dots-line"] = svg(12, weekTotals
    .map((v, i) => `  <circle cx="${f((i + 0.5) * gap)}" cy="6" r="2" ${mark(v, max)}${anim("fade", i * 16)}/>`)
    .join("\n"));
}

// ② 7×52 の極小ドット
{
  const max = Math.max(1, ...days.map((d) => d.count));
  const gap = W / weeks.length;
  parts["dots-grid"] = svg(Math.ceil(7 * gap), weeks
    .flatMap((w, x) => w.map((d, y) => `  <circle cx="${f((x + 0.5) * gap)}" cy="${f((y + 0.5) * gap)}" r="1.8" ${mark(d.count, max)}${anim("fade", x * 16 + y * 10)}/>`))
    .join("\n"));
}

// ④ 時計: AM / PM の2つの文字盤（目盛りと濃淡の細かさは設定で選ぶ）
{
  const R = 78, cy = 104;
  const values = bins(CLOCK_SHADE);
  const max = Math.max(1, ...values);
  const half = values.length / 2;
  const clock = (cx, vals, label, start) => [
    ...dial(cx, cy, R, CLOCK_TICKS),
    ...ring(cx, cy, R - 30, R - 12, vals, max, CLOCK_SHADE, start, 600),
    `  <text x="${cx}" y="${cy + R + 36}" class="label sub" text-anchor="middle">${label}</text>`,
  ];
  // AM → PM の順に、12時から時計回りに灯る
  parts["clock"] = svg(232, [
    ...clock(W / 4, values.slice(0, half), "AM", 0),
    ...clock((W * 3) / 4, values.slice(half), "PM", 600),
  ].join("\n"));
}

// ④ 曜日×時間のドット
{
  const max = Math.max(1, ...punch.flat());
  const left = 36, gap = (W - left) / 24, row = 16;
  const dots = punch.flatMap((r, d) => r.map((v, h) =>
    `  <circle cx="${f(left + (h + 0.5) * gap)}" cy="${d * row + 8}" r="${v ? f(1.8 + 4 * (v / max)) : 1.5}" ${mark(v, max)}${anim("fade", h * 40 + d * 12)}/>`));
  const dayLabels = WEEKDAYS.map((t, d) => `  <text x="0" y="${d * row + 12}" class="label sub">${t}</text>`);
  const hourLabels = [0, 6, 12, 18].map((h) => `  <text x="${f(left + (h + 0.5) * gap)}" y="${7 * row + 14}" class="label sub" text-anchor="middle">${h}</text>`);
  parts["hours-punch"] = svg(7 * row + 18, [...dots, ...dayLabels, ...hourLabels].join("\n"));
}

// ⑩ 数字
{
  const items = [
    ["repos", repos.length.toLocaleString("en-US")],
    ["stars", repos.reduce((s, r) => s + r.stargazers_count, 0).toLocaleString("en-US")],
    ["followers", user.followers.toLocaleString("en-US")],
    ["contribs / yr", yearTotal.toLocaleString("en-US")],
    ["since", new Date(user.created_at).getFullYear()],
  ];
  const colW = W / items.length;
  parts["numbers"] = svg(62, items
    .map(([label, v], i) => `  <text x="${i * colW}" y="30" class="num key"${anim("rise", i * 120, 700)}>${escape(v)}</text>
  <text x="${i * colW}" y="54" class="label sub"${anim("fade", i * 120 + 200, 700)}>${escape(label)}</text>`)
    .join("\n"));
}

// ⑪ 言語の割合
{
  // 左から順に線が伸びる
  let x = 0;
  const bar = langs.map(({ ratio }, i) => {
    const w = W * ratio;
    const seg = `  <rect x="${f(x)}" y="4" width="${f(Math.max(w - 2, 0))}" height="1.5" class="key" opacity="${1 - i * 0.2}"${anim("grow", (x / W) * 900, ratio * 900 + 100)}/>`;
    x += w;
    return seg;
  });
  const label = `  <text x="0" y="26" class="label sub"${anim("fade", 700, 700)}>${escape(langs.map((l) => `${l.name} ${Math.round(l.ratio * 100)}%`).join("   ·   "))}</text>`;
  parts["languages"] = svg(32, [...bar, label].join("\n"));
}

// D-DIN（SIL OFL）を、その SVG で使う文字だけに絞って埋め込む
// 改変版（サブセット）になるため、予約フォント名 "D-DIN" は使わず別名で登録する
const din = await readFile(new URL("../fonts/D-DIN.otf", import.meta.url));
async function embedFont(content) {
  const chars = [...content.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join("");
  if (!chars) return content;
  const woff2 = await subsetFont(din, chars, { targetFormat: "woff2" });
  const face = `@font-face { font-family: "Widgets Sans"; font-weight: 100 900; src: url(data:font/woff2;base64,${woff2.toString("base64")}) format("woff2"); }`;
  return content.replace("<style>", `<style>
    ${face}`);
}

await mkdir(OUT_DIR, { recursive: true });
for (const [name, content] of Object.entries(parts)) await writeFile(`${OUT_DIR}/${name}.svg`, await embedFont(content));
console.log("wrote", Object.keys(parts).map((n) => `${OUT_DIR}/${n}.svg`).join(", "));
