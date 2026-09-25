#!/usr/bin/env node
// Renders the dynamic profile cards (overview.svg, languages.svg) from the
// GitHub GraphQL API. Runs daily in .github/workflows/profile.yml and needs
// nothing but Node 18+ and a token (the workflow's GITHUB_TOKEN is enough).
//
//   GITHUB_TOKEN=... node .github/scripts/profile-cards.mjs [outDir]
//
// Icons: Octicons by GitHub (MIT).

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOGIN = process.env.PROFILE_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || 'nSQUICK';
// Languages to leave out of the languages card, e.g. ['Jupyter Notebook', 'HTML'].
const HIDDEN_LANGUAGES = [];
const MAX_LANGUAGES = 6;

// ---------------------------------------------------------------- data

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('\n'));
  return json.data;
}

export const PROFILE_QUERY = `
  query ($login: String!, $after: String) {
    user(login: $login) {
      login
      createdAt
      followers { totalCount }
      pullRequests { totalCount }
      issues { totalCount }
      contributionsCollection { contributionYears }
      publicRepos: repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
      repositories(first: 100, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          stargazerCount
          languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`;

// One aliased contributionsCollection per year: the API caps each window at a year.
export function yearsQuery(years) {
  const fields = years
    .map((y) => `
      y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
        totalCommitContributions
        contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      }`)
    .join('');
  return `query ($login: String!) { user(login: $login) { ${fields} } }`;
}

async function fetchProfile(login) {
  let after = null;
  let user;
  const repos = [];
  do {
    const data = await graphql(PROFILE_QUERY, { login, after });
    if (!data.user) throw new Error(`GitHub user "${login}" not found`);
    user ??= data.user;
    repos.push(...data.user.repositories.nodes.filter(Boolean));
    const page = data.user.repositories.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);

  const years = [...user.contributionsCollection.contributionYears].sort((a, b) => a - b);
  const byYear = years.length ? (await graphql(yearsQuery(years), { login })).user : {};
  return { user, repos, years: years.map((y) => byYear[`y${y}`]) };
}

// ---------------------------------------------------------------- stats

const isoDay = (d) => d.toISOString().slice(0, 10);

export function computeStats({ user, repos, years }, now = new Date()) {
  const days = new Map();
  for (const y of years) {
    for (const w of y.contributionCalendar.weeks) {
      for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
    }
  }
  const count = (date) => days.get(date) ?? 0;
  const shift = (date, n) => isoDay(new Date(Date.parse(date) + n * 864e5));

  // Years without contributions are missing from the data, so a run only
  // continues across consecutive dates.
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const date of [...days.keys()].sort()) {
    if (prev && date !== shift(prev, 1)) run = 0;
    run = count(date) > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
    prev = date;
  }

  // Calendar dates follow the user's time zone, which may already be a day
  // ahead of UTC; and a quiet "today" doesn't break the streak yet.
  const today = isoDay(now);
  let day = count(shift(today, 1)) > 0 ? shift(today, 1) : today;
  if (count(day) === 0) day = shift(day, -1);
  let current = 0;
  for (; count(day) > 0; day = shift(day, -1)) current++;

  const langs = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages?.edges ?? []) {
      if (HIDDEN_LANGUAGES.includes(node.name)) continue;
      const entry = langs.get(node.name) ?? { name: node.name, color: node.color, size: 0 };
      entry.size += size;
      langs.set(node.name, entry);
    }
  }
  const ranked = [...langs.values()].sort((a, b) => b.size - a.size);
  const total = ranked.reduce((sum, l) => sum + l.size, 0);
  let top = ranked;
  if (ranked.length > MAX_LANGUAGES) {
    top = ranked.slice(0, MAX_LANGUAGES - 1);
    const rest = ranked.slice(MAX_LANGUAGES - 1).reduce((sum, l) => sum + l.size, 0);
    top.push({ name: 'Other', color: null, size: rest });
  }

  return {
    login: user.login,
    since: new Date(user.createdAt).getUTCFullYear(),
    contributions: years.reduce((sum, y) => sum + y.contributionCalendar.totalContributions, 0),
    commits: years.reduce((sum, y) => sum + y.totalCommitContributions, 0),
    stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    pullRequests: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    publicRepos: user.publicRepos.totalCount,
    followers: user.followers.totalCount,
    currentStreak: current,
    longestStreak: longest,
    languageCount: ranked.length,
    languages: top.map((l) => ({ ...l, share: total ? l.size / total : 0 })),
  };
}

// ---------------------------------------------------------------- render

const W = 480;
const H = 210;
const C = {
  bg: '#0a0d18', text: '#e6edf3', soft: '#c9d1d9', dim: '#7d8590',
  cyan: '#67e8f9', indigo: '#818cf8', pink: '#f0abfc', flame: '#fb923c', gold: '#fcd34d',
};
const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;
const FALLBACK_COLORS = ['#67e8f9', '#818cf8', '#f0abfc', '#fcd34d', '#86efac', '#fda4af'];

const ICONS = {
  star: '<path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z"/>',
  commit: '<path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>',
  pr: '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>',
  issue: '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>',
  repo: '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>',
  people: '<path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"/>',
  flame: '<path d="M9.533.753V.752c.217 2.385 1.463 3.626 2.653 4.81C13.37 6.74 14.498 7.863 14.498 10c0 3.5-3 6-6.5 6S1.5 13.512 1.5 10c0-1.298.536-2.56 1.425-3.286.376-.308.862 0 1.035.454C4.46 8.487 5.581 8.419 6 8c.282-.282.341-.811-.003-1.5C4.34 3.187 7.035.75 8.77.146c.39-.137.726.194.763.607ZM7.998 14.5c2.832 0 5-1.98 5-4.5 0-1.463-.68-2.19-1.879-3.383l-.036-.037c-1.013-1.008-2.3-2.29-2.834-4.434-.322.256-.63.579-.864.953-.432.696-.621 1.58-.046 2.73.473.947.67 2.284-.278 3.232-.61.61-1.545.84-2.403.633a2.79 2.79 0 0 1-1.436-.874A3.198 3.198 0 0 0 3 10c0 2.53 2.164 4.5 4.998 4.5Z"/>',
  trophy: '<path d="M3.217 6.962A3.75 3.75 0 0 1 0 3.25v-.5C0 1.784.784 1 1.75 1h1.356c.228-.585.796-1 1.462-1h6.864c.647 0 1.227.397 1.462 1h1.356c.966 0 1.75.784 1.75 1.75v.5a3.75 3.75 0 0 1-3.217 3.712 5.014 5.014 0 0 1-2.771 3.117l.144 1.446c.005.05.03.12.114.204.086.087.217.17.373.227.283.103.618.274.89.568.285.31.467.723.467 1.226v.75h1.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H4v-.75c0-.503.182-.916.468-1.226.27-.294.606-.465.889-.568.139-.048.266-.126.373-.227.084-.085.109-.153.114-.204l.144-1.446a5.015 5.015 0 0 1-2.77-3.117ZM4.5 1.568V5.5a3.5 3.5 0 1 0 7 0V1.568a.068.068 0 0 0-.068-.068H4.568a.068.068 0 0 0-.068.068Zm2.957 8.902-.12 1.204c-.093.925-.858 1.47-1.467 1.691a.766.766 0 0 0-.3.176c-.037.04-.07.093-.07.21v.75h5v-.75c0-.117-.033-.17-.07-.21a.766.766 0 0 0-.3-.176c-.609-.221-1.374-.766-1.466-1.69l-.12-1.204a5.064 5.064 0 0 1-1.087 0ZM13 2.5v2.872a2.25 2.25 0 0 0 1.5-2.122v-.5a.25.25 0 0 0-.25-.25H13Zm-10 0H1.75a.25.25 0 0 0-.25.25v.5c0 .98.626 1.813 1.5 2.122Z"/>',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = (n) => (n >= 1e5 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString('en-US'));
const icon = (name, x, y, fill, size = 16) =>
  `<g transform="translate(${x} ${y}) scale(${size / 16})" fill="${fill}">${ICONS[name]}</g>`;

function card({ title, aside = '', label, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
<title id="title">${esc(label)}</title>
<style>
  .t{font:600 15px ${MONO};fill:${C.text}}
  .p{font:700 15px ${MONO};fill:${C.cyan}}
  .aside{font:12px ${MONO};fill:${C.dim}}
  .label{font:12px ${MONO};fill:${C.dim}}
  .row{font:13.5px ${SANS};fill:${C.soft}}
  .val{font:700 14px ${SANS};fill:${C.text};font-variant-numeric:tabular-nums}
  .big{font:800 40px ${SANS};letter-spacing:-1px}
  .mid{font:700 19px ${SANS};fill:${C.text}}
  .unit{font:12px ${MONO};fill:${C.dim}}
  .in{opacity:0;animation:in .7s ease-out forwards}
  @keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .grow{transform-box:fill-box;transform-origin:left;animation:grow 1s cubic-bezier(.2,.8,.2,1) both}
  @keyframes grow{from{transform:scaleX(0)}}
  .arc{animation:draw 1.1s cubic-bezier(.3,.7,.2,1) both}
  @keyframes draw{from{stroke-dasharray:0 1000}}
  @media (prefers-reduced-motion:reduce){.in,.grow,.arc{animation:none;opacity:1}}
</style>
<defs>
  <clipPath id="clip"><rect width="${W}" height="${H}" rx="16"/></clipPath>
  <linearGradient id="brand" x1="0" x2="1"><stop offset="0" stop-color="${C.cyan}"/><stop offset=".55" stop-color="${C.indigo}"/><stop offset="1" stop-color="${C.pink}"/></linearGradient>
  <linearGradient id="border" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".4"/><stop offset=".5" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="${C.pink}" stop-opacity=".4"/></linearGradient>
  <radialGradient id="glowA"><stop offset="0" stop-color="#22d3ee" stop-opacity=".16"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient>
  <radialGradient id="glowB"><stop offset="0" stop-color="#f472b6" stop-opacity=".13"/><stop offset="1" stop-color="#f472b6" stop-opacity="0"/></radialGradient>
</defs>
<g clip-path="url(#clip)">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <ellipse cx="40" cy="20" rx="260" ry="150" fill="url(#glowA)"/>
  <ellipse cx="${W - 20}" cy="${H}" rx="260" ry="150" fill="url(#glowB)"/>
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="15.5" fill="none" stroke="url(#border)"/>
<text x="24" y="40" class="p">›</text><text x="40" y="40" class="t">${esc(title)}</text>
${aside ? `<text x="${W - 24}" y="40" class="aside" text-anchor="end">${esc(aside)}</text>` : ''}
${body}
</svg>
`;
}

export function renderOverview(s) {
  const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;
  // Zero counters make a card look empty, so only non-zero ones are listed.
  const rows = [
    ['star', 'Stars earned', s.stars],
    ['commit', 'Commits', s.commits],
    ['pr', 'Pull requests', s.pullRequests],
    ['issue', 'Issues', s.issues],
    ['repo', 'Public repos', s.publicRepos],
    ['people', 'Followers', s.followers],
  ].filter(([, , v]) => v > 0).slice(0, 5);

  const panelX = 250;
  const panelY = 58;
  const panelH = 134;
  const step = 25;
  const startY = panelY + (panelH - rows.length * step) / 2 + 17;
  const list = rows
    .map(([ic, label, v], i) => {
      const y = startY + i * step;
      return `<g class="in" style="animation-delay:${0.25 + i * 0.08}s">
    ${icon(ic, panelX + 16, y - 12, C.dim, 15)}
    <text x="${panelX + 42}" y="${y}" class="row">${label}</text>
    <text x="${W - 40}" y="${y}" class="val" text-anchor="end">${num(v)}</text>
  </g>`;
    })
    .join('\n  ');

  const body = `
<g class="in">
  <text x="22" y="104" class="big" fill="url(#brand)">${num(s.contributions)}</text>
  <text x="24" y="126" class="label">${plural(s.contributions, 'contribution')} since ${s.since}</text>
</g>
<rect x="24" y="142" width="202" height="1" fill="#fff" opacity=".08"/>
<g class="in" style="animation-delay:.15s">
  ${icon('flame', 24, 157, C.flame)}
  <text x="46" y="171" class="mid">${num(s.currentStreak)}<tspan class="unit"> ${plural(s.currentStreak, 'day')}</tspan></text>
  <text x="24" y="190" class="label">current streak</text>
</g>
<g class="in" style="animation-delay:.25s">
  ${icon('trophy', 136, 157, C.gold)}
  <text x="158" y="171" class="mid">${num(s.longestStreak)}<tspan class="unit"> ${plural(s.longestStreak, 'day')}</tspan></text>
  <text x="136" y="190" class="label">best streak</text>
</g>
<rect x="${panelX}" y="${panelY}" width="${W - panelX - 24}" height="${panelH}" rx="12" fill="#fff" fill-opacity=".03" stroke="#fff" stroke-opacity=".06"/>
${list}`;

  return card({
    title: 'activity',
    aside: `@${s.login}`,
    label: `${s.login}'s GitHub activity: ${s.contributions} contributions, current streak ${s.currentStreak} days, longest streak ${s.longestStreak} days`,
    body,
  });
}

export function renderLanguages(s) {
  const cx = 104;
  const cy = 128;
  const r = 52;
  const circ = 2 * Math.PI * r;
  const gap = s.languages.length > 1 ? 3 : 0;
  const colorOf = (l, i) => (l.name === 'Other' ? '#484f58' : l.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length]);

  let offset = 0;
  const arcs = s.languages
    .map((l, i) => {
      const len = Math.max(l.share * circ - gap, 0.5);
      const arc = `<circle class="arc" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorOf(l, i)}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" style="animation-delay:${i * 0.12}s"/>`;
      offset += l.share * circ;
      return arc;
    })
    .join('\n');

  const top = s.languages[0]?.share || 1;
  const legendX = 200;
  const trackW = W - 24 - legendX - 18;
  const rowH = 22;
  const startY = 76 + ((MAX_LANGUAGES - s.languages.length) * rowH) / 2;
  const legend = s.languages
    .map((l, i) => {
      const y = startY + i * rowH;
      const name = l.name.length > 22 ? `${l.name.slice(0, 21)}…` : l.name;
      const barW = Math.max((l.share / top) * trackW, 2);
      return `<g class="in" style="animation-delay:${0.2 + i * 0.08}s">
    <circle cx="${legendX + 5}" cy="${y - 4.5}" r="5" fill="${colorOf(l, i)}"/>
    <text x="${legendX + 18}" y="${y}" class="row">${esc(name)}</text>
    <text x="${W - 24}" y="${y}" class="label" text-anchor="end">${(l.share * 100).toFixed(1)}%</text>
    <rect x="${legendX + 18}" y="${y + 6}" width="${trackW}" height="3" rx="1.5" fill="#fff" fill-opacity=".06"/>
    <rect class="grow" x="${legendX + 18}" y="${y + 6}" width="${barW.toFixed(1)}" height="3" rx="1.5" fill="${colorOf(l, i)}" style="animation-delay:${0.3 + i * 0.08}s"/>
  </g>`;
    })
    .join('\n  ');

  const body = s.languages.length
    ? `
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-opacity=".05" stroke-width="14"/>
${arcs}
<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="mid" style="font-size:24px">${s.languageCount}</text>
<text x="${cx}" y="${cy + 22}" text-anchor="middle" class="label" style="font-size:11px">${s.languageCount === 1 ? 'language' : 'languages'}</text>
${legend}`
    : `<text x="${W / 2}" y="${H / 2 + 20}" text-anchor="middle" class="label">no public code yet — stay tuned</text>`;

  return card({
    title: 'languages',
    aside: 'by code size',
    label: `Most used languages: ${s.languages.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', ')}`,
    body,
  });
}

// ---------------------------------------------------------------- main

async function main() {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  const outDir = process.argv[2] || 'dist';
  const stats = computeStats(await fetchProfile(LOGIN));
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'overview.svg'), renderOverview(stats));
  await fs.writeFile(path.join(outDir, 'languages.svg'), renderLanguages(stats));
  const { languages, ...summary } = stats;
  console.log(summary, languages.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', '));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
