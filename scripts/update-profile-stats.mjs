import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const username = 'Jeyep18';
const day = 86_400_000;
const weekCount = 12;
const dateLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
});
const number = new Intl.NumberFormat('en-US');
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 2 });
const startMarker = '<!-- profile-stats:start -->';
const endMarker = '<!-- profile-stats:end -->';

async function get(url, fetcher = fetch) {
  const headers = { 'Accept-Language': 'en-US', 'User-Agent': 'Jeyep18-profile-stats' };
  if (url.startsWith('https://api.github.com/')) {
    headers.Accept = 'application/vnd.github+json';
    const token = process.env.GITHUB_ACTIONS === 'true' && process.env.PROFILE_STATS_GITHUB_TOKEN;
    if (token) headers.Authorization = 'Bearer ' + token;
  }
  const response = await fetcher(url, {
    headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(new URL(url).pathname + ' returned HTTP ' + response.status);
  }
  return response;
}

// GitHub's public contribution fragment pairs each calendar cell with a tooltip.
function calendarDays(html) {
  const heading = html.match(/([\d,]+)\s+contributions?\s+in the (?:last|past) year/i);
  assert(heading, 'Missing GitHub contribution total');

  const cellTags = /<td\b[^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*\bid="(contribution-day-component-[^"]+)"[^>]*>/gi;
  const tooltipTags = /<tool-tip\b[^>]*\bfor="(contribution-day-component-[^"]+)"[^>]*>\s*(No|[\d,]+) contributions? on [^<]+<\/tool-tip>/gi;
  const cells = [...html.matchAll(cellTags)];
  const tooltips = [...html.matchAll(tooltipTags)];
  const counts = new Map(tooltips.map(([, id, count]) => [
    id, count.toLowerCase() === 'no' ? 0 : Number(count.replaceAll(',', '')),
  ]));
  assert(cells.length >= 365 && cells.length <= 372, 'Unexpected calendar size');
  assert(tooltips.length === cells.length && counts.size === cells.length, 'Missing or duplicate tooltips');

  const seenIds = new Set();
  const days = new Map();
  for (const [, date, id] of cells) {
    const at = Date.parse(date);
    assert(Number.isFinite(at) && isoDate(at) === date, 'Invalid calendar date');
    const count = counts.get(id);
    assert(Number.isSafeInteger(count) && !seenIds.has(id) && !days.has(at), 'Invalid or duplicate calendar cell');
    seenIds.add(id);
    days.set(at, count);
  }

  const orderedDates = [...days.keys()].sort((a, b) => a - b);
  assert(orderedDates.at(-1) - orderedDates[0] === (days.size - 1) * day, 'Calendar has gaps');
  const sum = [...days.values()].reduce((total, count) => total + count, 0);
  assert.equal(sum, Number(heading[1].replaceAll(',', '')), 'Calendar disagrees with GitHub total');
  return days;
}

function isoDate(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function completeWeeks(days, now) {
  const today = Date.parse(isoDate(now));
  const latest = Math.max(...days.keys());
  assert(latest >= today - day && latest <= today, 'GitHub calendar is stale or ahead of UTC');
  const startOfThisWeek = today - new Date(today).getUTCDay() * day;
  return Array.from({ length: weekCount }, (_, index) => {
    const start = startOfThisWeek - (weekCount - index) * 7 * day;
    let total = 0;
    for (let date = start; date < start + 7 * day; date += day) {
      assert(days.has(date), 'Missing day in chart window');
      total += days.get(date);
    }
    return { start, end: start + 6 * day, total };
  });
}

async function repositoryStats() {
  const api = 'https://api.github.com';
  const repositories = [];
  const seen = new Set();
  for (let page = 1; ; page += 1) {
    const response = await get(api + '/users/' + username + '/repos?type=owner&per_page=100&page=' + page);
    const entries = await response.json();
    assert(Array.isArray(entries), 'Invalid public repository list');
    for (const repo of entries) {
      assert(repo.owner?.login === username && typeof repo.name === 'string', 'Unexpected repository owner or name');
      assert(typeof repo.private === 'boolean' && typeof repo.fork === 'boolean', 'Invalid repository visibility');
      assert(!seen.has(repo.name), 'Duplicate repository in paginated result');
      seen.add(repo.name);
      if (!repo.private && !repo.fork && repo.name.toLowerCase() !== username.toLowerCase()) {
        repositories.push(repo.name);
      }
    }
    if (!response.headers.get('link')?.includes('rel="next"')) break;
  }

  const bytesByLanguage = new Map();
  for (const repo of repositories) {
    const response = await get(api + '/repos/' + username + '/' + encodeURIComponent(repo) + '/languages');
    const languages = await response.json();
    assert(languages && typeof languages === 'object' && !Array.isArray(languages), 'Invalid language response');
    for (const [name, bytes] of Object.entries(languages)) {
      assert(name.length > 0 && !/[\r\n<>|]/.test(name) && Number.isSafeInteger(bytes) && bytes >= 0,
        'Invalid language entry');
      if (bytes > 0) bytesByLanguage.set(name, (bytesByLanguage.get(name) ?? 0) + bytes);
    }
  }
  return { repositoryCount: repositories.length, languages: languageShares(bytesByLanguage) };
}

function languageShares(bytesByLanguage) {
  const sorted = [...bytesByLanguage].sort(([nameA, bytesA], [nameB, bytesB]) =>
    bytesB - bytesA || nameA.localeCompare(nameB, 'en'));
  const total = sorted.reduce((sum, [, bytes]) => sum + bytes, 0);
  const rows = sorted.slice(0, 5);
  if (sorted.length > 5) {
    rows.push(['Other languages', sorted.slice(5).reduce((sum, [, bytes]) => sum + bytes, 0)]);
  }
  return rows.map(([name, bytes]) => ({ name, share: bytes / total }));
}

function escapeMarkup(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function percent(share) {
  return share > 0 && share < 0.001 ? '<0.1%' : (share * 100).toFixed(1) + '%';
}

function chart(title, height, content, font = '') {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="' + height + '" viewBox="0 0 480 ' + height + '">',
    '  <title>' + escapeMarkup(title) + '</title>',
    '  <style>',
    '    svg { --ink: #2e253c; --muted: #625870; --grid: #d9d1e2; --bar: #8a6ac0; --accent: #6d3fc0; }',
    '    @media (prefers-color-scheme: dark) {',
    '      svg { --ink: #eee7f6; --muted: #bfb2d0; --grid: #423b50; --bar: #9d82cc; --accent: #b99bf6; }',
    '    }',
    '    .ink { fill: var(--ink); } .muted { fill: var(--muted); } .track { fill: var(--grid); }',
    '    .bar { fill: var(--bar); } .point { fill: var(--accent); }',
    '    .grid { stroke: var(--grid); }',
    font,
    '  </style>',
    '  <g class="ink" font-family="system-ui, sans-serif" font-size="20">',
    content,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

function activityChart(weeks, monoFont) {
  const maximum = Math.max(1, ...weeks.map(({ total }) => total));
  const points = weeks.map(({ total }, index) => ({
    total,
    x: (24 + index * 432 / (weekCount - 1)).toFixed(1),
    y: (94 - 63 * total / maximum).toFixed(1),
  }));
  const latest = points.at(-1);
  const markers = points.map(({ total, x, y }) => {
    const point = '      <circle class="point" cx="' + x + '" cy="' + y + '" r="' + (total ? 3.8 : 2.6) + '"/>';
    if (!total) return point;
    const label = total < 1000 ? number.format(total) : compactNumber.format(total);
    return point + '\n      <text x="' + x + '" y="' + (Number(y) - 11)
      + '" text-anchor="middle" font-size="' + (label.length > 3 ? 15 : 18) + '">' + label + '</text>';
  }).join('\n');
  const startLabel = dateLabel.format(weeks[0].start);
  const endLabel = dateLabel.format(weeks.at(-1).end);
  // Upstream IBM/plex 2e90fe3 Latin1 WOFF2, as published. See assets/fonts/IBMPlexMono-OFL.txt.
  const font = '    @font-face { font-family: Profile Mono; src: url(data:font/woff2;base64,'
    + monoFont + ') format("woff2"); font-weight: 400; }\n'
    + '    .mono { font-family: Profile Mono, ui-monospace, monospace; font-synthesis: none; }\n'
    + '    .trend { fill: none; stroke: var(--accent); }';
  return chart('GitHub contributions by week', 125, [
    '    <path class="grid" d="M2 63.5h476" stroke-dasharray="2 5"/>',
    '    <path class="grid" d="M2 95.5h476"/>',
    '    <g class="mono" font-size="17">',
    '      <polyline class="trend" points="' + points.map(({ x, y }) => x + ',' + y).join(' ')
      + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    markers,
    '      <circle class="trend" cx="' + latest.x + '" cy="' + latest.y + '" r="6.9" stroke-width="1.2"/>',
    '      <text class="muted" x="2" y="117">' + startLabel + '</text>',
    '      <text class="muted" x="478" y="117" text-anchor="end">' + endLabel + '</text>',
    '    </g>',
  ].join('\n'), font);
}

function languageCard(languages) {
  const rows = languages.map(({ name, share }, index) => {
    const y = 20 + index * 32;
    return [
      '    <text x="2" y="' + y + '">' + escapeMarkup(name) + '</text>',
      '    <rect class="track" x="218" y="' + (y - 11) + '" width="165" height="7" rx="2"/>',
      '    <rect class="bar" x="218" y="' + (y - 11) + '" width="' + Math.max(1, 165 * share).toFixed(1)
        + '" height="7" rx="2"/>',
      '    <text class="muted" x="478" y="' + y + '" text-anchor="end">' + escapeMarkup(percent(share)) + '</text>',
    ].join('\n');
  });
  return chart('Languages by repository bytes', 32 * Math.max(1, rows.length),
    rows.length ? rows.join('\n') : '    <text class="muted" x="2" y="20">No language bytes reported</text>');
}

function statsBlock(weeks, { repositoryCount, languages }) {
  const total = weeks.reduce((sum, week) => sum + week.total, 0);
  const activity = weeks.map(({ start, total }) => dateLabel.format(start) + ' (' + number.format(total) + ')');
  const distribution = languages.map(({ name, share }) => escapeMarkup(name) + ' (' + escapeMarkup(percent(share)) + ')');
  const repositories = repositoryCount === 1 ? ' repository' : ' repositories';
  const contributions = total === 1 ? ' contribution' : ' contributions';
  return [
    '**' + number.format(total) + contributions + '** over 12 weeks · **'
      + number.format(repositoryCount) + ' public project' + repositories + '**',
    '',
    '![GitHub contributions by week through ' + isoDate(weeks.at(-1).end) + ' (UTC). Counts in the breakdown below.](assets/activity.svg)',
    '',
    '[Live contribution calendar](https://github.com/' + username + ')',
    '',
    '<details>',
    '<summary>Language breakdown and weekly counts</summary>',
    '',
    '![Programming language shares by repository bytes. Percentages below.](assets/languages.svg)',
    '',
    '- **Language shares** · ' + (distribution.join(', ') || 'No language bytes reported'),
    '- **Weekly counts by start date (UTC)** · ' + activity.join(', '),
    '',
    'Activity uses GitHub’s public calendar. Repository totals exclude forks and this profile repo. Language shares use GitHub-reported bytes and don’t measure proficiency.',
    '',
    '</details>',
  ].join('\n');
}

function updateReadme(readme, block) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  assert(start !== -1 && end > start && start === readme.lastIndexOf(startMarker)
    && end === readme.lastIndexOf(endMarker), 'Expected one profile stats block in README.md');
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  return readme.slice(0, start + startMarker.length) + newline + newline
    + block.replaceAll('\n', newline) + newline + newline + readme.slice(end);
}

async function generate() {
  const root = new URL('../', import.meta.url);
  const readmeUrl = new URL('README.md', root);
  const [original, response, repositories, monoFont] = await Promise.all([
    readFile(readmeUrl, 'utf8'),
    get('https://github.com/users/' + username + '/contributions'),
    repositoryStats(),
    readFile(new URL('assets/fonts/IBMPlexMono-Regular.woff2', root), 'base64'),
  ]);
  const weeks = completeWeeks(calendarDays(await response.text()), Date.now());
  // Prepare and validate every output before touching the existing snapshot.
  const outputs = [
    [readmeUrl, updateReadme(original, statsBlock(weeks, repositories))],
    [new URL('assets/activity.svg', root), activityChart(weeks, monoFont)],
    [new URL('assets/languages.svg', root), languageCard(repositories.languages)],
  ];
  await Promise.all(outputs.map(([file, content]) => writeFile(file, content)));
}

async function selfCheck() {
  const today = Date.parse('2026-11-21');
  const cells = Array.from({ length: 371 }, (_, index) => {
    const id = 'contribution-day-component-' + index;
    const date = isoDate(today - (370 - index) * day);
    const count = date === '2026-11-08' ? '3 contributions' : 'No contributions';
    return '<td data-date="' + date + '" id="' + id + '"></td>'
      + '<tool-tip for="' + id + '">' + count + ' on ' + date + '</tool-tip>';
  }).join('\n');
  const html = '<h2>3 contributions in the last year</h2>' + cells;
  const weeks = completeWeeks(calendarDays(html), today);
  assert.equal(isoDate(weeks.at(-1).end), '2026-11-14');
  assert.equal(weeks.at(-1).total, 3);
  const activity = activityChart(weeks, '');
  assert.equal([...activity.matchAll(/<circle class="point"/g)].length, weekCount);
  assert.match(activity, /<polyline class="trend" points="24\.0,94\.0 [^"]+ 456\.0,31\.0"/);
  assert.throws(() => calendarDays(html.replace('3 contributions in', '4 contributions in')), /disagrees/);
  assert.throws(() => calendarDays(html.replace('2025-11-16" id', '2025-11-17" id')), /duplicate/);
  assert.throws(() => completeWeeks(calendarDays(html), today + 2 * day), /stale/);

  const languages = languageShares(new Map([['TypeScript', 3], ['CSS', 1]]));
  assert.deepEqual(languages, [{ name: 'TypeScript', share: 0.75 }, { name: 'CSS', share: 0.25 }]);
  const block = statsBlock(weeks, { repositoryCount: 1, languages });
  const readme = updateReadme(startMarker + '\n' + endMarker, block);
  assert.equal(updateReadme(readme, block), readme);
  assert.throws(() => updateReadme(endMarker, block), /Expected one/);
  await assert.rejects(get('https://github.com/users/' + username + '/contributions',
    async () => new Response('', { status: 429 })), /HTTP 429/);
  console.log('Profile analytics self-check passed');
}

if (process.argv[2] === '--self-check') {
  await selfCheck();
} else {
  await generate();
}
