import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const username = 'Jeyep18';
const day = 86_400_000;
const graphDays = 31;
const api = 'https://api.github.com';
const calendarUrl = 'https://github.com/users/' + username + '/contributions';
const dateLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
});
const number = new Intl.NumberFormat('en-US');
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 2 });

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
  const heading = html.match(/([\d,]+)\s+contributions?\s+in\s+(?:the (?:last|past) year|\d{4})\b/i);
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

function datedCounts(days, start, end) {
  return Array.from({ length: (end - start) / day + 1 }, (_, index) => {
    const date = start + index * day;
    assert(days.has(date), 'Missing GitHub contribution date: ' + isoDate(date));
    return { date, count: days.get(date) };
  });
}

function recentActivity(days, today) {
  const latest = Math.max(...days.keys());
  assert(latest >= today - day && latest <= today, 'GitHub calendar is stale or ahead of UTC');
  return datedCounts(days, today - graphDays * day, today - day);
}

async function contributionHistory(days, joined, today) {
  const currentYear = new Date(today).getUTCFullYear();
  const firstYear = new Date(joined).getUTCFullYear();
  const history = new Map(days);
  for (let year = firstYear; year < currentYear; year += 1) {
    const response = await get(calendarUrl + '?from=' + year + '-01-01&to=' + year + '-12-31');
    const annual = calendarDays(await response.text());
    const start = Math.max(joined, Date.UTC(year, 0, 1));
    const end = Date.UTC(year, 11, 31);
    for (const { date, count } of datedCounts(annual, start, end)) history.set(date, count);
  }
  return datedCounts(history, joined, history.has(today) ? today : today - day);
}

function streakStats(history, today) {
  let total = 0;
  let active = 0;
  let longest = 0;
  let lastActive;
  let current = 0;
  for (const { date, count } of history) {
    total += count;
    active = count ? active + 1 : 0;
    longest = Math.max(longest, active);
    if (count) {
      lastActive = date;
      current = active;
    }
  }
  return { total, current: lastActive >= today - day ? current : 0, longest };
}

async function profileStats() {
  const response = await get(api + '/users/' + username);
  const profile = await response.json();
  const created = Date.parse(profile.created_at);
  assert(profile.login === username && Number.isSafeInteger(profile.followers) && profile.followers >= 0
    && Number.isFinite(created), 'Invalid GitHub profile metadata');
  return { followers: profile.followers, joined: Date.parse(isoDate(created)) };
}

async function repositoryStats() {
  const repositories = [];
  const seen = new Set();
  let stars = 0;
  for (let page = 1; ; page += 1) {
    const response = await get(api + '/users/' + username + '/repos?type=owner&per_page=100&page=' + page);
    const entries = await response.json();
    assert(Array.isArray(entries), 'Invalid public repository list');
    for (const repo of entries) {
      assert(repo.owner?.login === username && typeof repo.name === 'string', 'Unexpected repository owner or name');
      assert(typeof repo.private === 'boolean' && typeof repo.fork === 'boolean', 'Invalid repository visibility');
      assert(!seen.has(repo.name), 'Duplicate repository in paginated result');
      seen.add(repo.name);
      if (repo.private || repo.fork) continue;
      assert(Number.isSafeInteger(repo.stargazers_count) && repo.stargazers_count >= 0, 'Invalid GitHub star count');
      stars += repo.stargazers_count;
      if (repo.name.toLowerCase() !== username.toLowerCase()) repositories.push(repo.name);
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
  return { stars, languages: languageShares(bytesByLanguage) };
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

function chart(title, height, content, font = '', width = 480) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
    '  <title>' + escapeMarkup(title) + '</title>',
    '  <style>',
    '    svg { --ink: #2e253c; --muted: #625870; --grid: #d9d1e2; --bar: #8a6ac0; --accent: #6d3fc0; --panel: #f6f2fc; }',
    '    @media (prefers-color-scheme: dark) {',
    '      svg { --ink: #eee7f6; --muted: #bfb2d0; --grid: #423b50; --bar: #9d82cc; --accent: #b99bf6; --panel: #211a2d; }',
    '    }',
    '    .ink { fill: var(--ink); } .muted { fill: var(--muted); } .track { fill: var(--grid); }',
    '    .bar { fill: var(--bar); } .accent { fill: var(--accent); }',
    '    .grid { stroke: var(--grid); } .trend { fill: none; stroke: var(--accent); }',
    '    .panel { fill: var(--panel); } .point { fill: var(--panel); stroke: var(--accent); }',
    font,
    '  </style>',
    '  <g class="ink" font-family="system-ui, sans-serif" font-size="20">',
    content,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

function activityChart(activity, monoFont) {
  const maxCount = Math.max(1, ...activity.map(({ count }) => count));
  const tick = Math.max(1, Math.ceil(maxCount / 4));
  const tickCount = Math.ceil(maxCount / tick);
  const plot = { left: 58, right: 688, top: 23, bottom: 182 };
  const yFor = (count) => (plot.bottom - (plot.bottom - plot.top) * count / (tick * tickCount)).toFixed(1);
  const points = activity.map(({ count, date }, index) => ({
    date, x: Number((plot.left + index * (plot.right - plot.left) / (graphDays - 1)).toFixed(1)), y: yFor(count),
  }));
  const horizontal = Array.from({ length: tickCount + 1 }, (_, index) => {
    const count = index * tick;
    const y = yFor(count);
    return '    <path class="grid" d="M58 ' + y + 'H688" stroke-dasharray="2 4"/>\n'
      + '    <text class="muted mono" x="50" y="' + (Number(y) + 6)
      + '" text-anchor="end" font-size="21">' + compactNumber.format(count) + '</text>';
  }).join('\n');
  const dates = points.filter((_, index) => index % 6 === 0).map(({ date, x }) =>
    '    <path class="grid" d="M' + x + ' 23V182" stroke-dasharray="2 4"/>\n'
    + '    <text class="muted mono" x="' + (x === plot.right ? 674 : x) + '" y="209" text-anchor="middle" font-size="20">'
    + dateLabel.format(date) + '</text>').join('\n');
  // Horizontal tangents at the samples soften the joins without overshooting daily values.
  const segments = points.slice(1).map(({ x, y }, index) => {
    const previous = points[index];
    const middle = ((previous.x + x) / 2).toFixed(1);
    return 'C' + middle + ' ' + previous.y + ' ' + middle + ' ' + y + ' ' + x + ' ' + y;
  });
  const curve = 'M' + points[0].x + ' ' + points[0].y + ' ' + segments.join(' ');
  const markers = points.map(({ x, y }) =>
    '    <circle class="point" cx="' + x + '" cy="' + y + '" r="3.6" stroke-width="1.8"/>').join('\n');
  // Upstream IBM/plex 2e90fe3 Latin1 WOFF2, as published. See assets/fonts/IBMPlexMono-OFL.txt.
  const font = '    @font-face { font-family: Profile Mono; src: url(data:font/woff2;base64,'
    + monoFont + ') format("woff2"); font-weight: 400; }\n'
    + '    .mono { font-family: Profile Mono, ui-monospace, monospace; font-synthesis: none; }';
  return chart('Daily GitHub contributions', 239, [
    horizontal,
    dates,
    '    <path class="trend" d="' + curve + '" stroke-width="3" stroke-linecap="round"/>',
    markers,
    '    <text class="muted" x="16" y="102" transform="rotate(-90 16 102)" text-anchor="middle" font-size="20">Contributions</text>',
    '    <text class="muted" x="373" y="232" text-anchor="middle" font-size="19">Date (UTC)</text>',
  ].join('\n'), font, 720);
}

function streakCard({ total, current, longest }) {
  const metrics = [
    [120, total, 'Total contributions'],
    [360, current, 'Current streak'],
    [600, longest, 'Longest streak'],
  ];
  return chart('GitHub contribution streaks', 180, [
    '    <rect class="panel" width="720" height="180" rx="14"/>',
    '    <path class="grid" d="M240 32v116m240-116v116"/>',
    '    <circle class="trend" cx="360" cy="73" r="45" stroke-width="4"/>',
    ...metrics.map(([x, count, label]) =>
      '    <text class="accent" x="' + x + '" y="86" text-anchor="middle" font-size="42" font-weight="700">'
      + compactNumber.format(count) + '</text>\n'
      + '    <text x="' + x + '" y="139" text-anchor="middle" font-size="23">' + label + '</text>'),
    '    <text class="muted" x="120" y="162" text-anchor="middle" font-size="19">Since joining GitHub</text>',
    '    <text class="muted" x="360" y="162" text-anchor="middle" font-size="19">Consecutive days</text>',
    '    <text class="muted" x="600" y="162" text-anchor="middle" font-size="19">Consecutive days</text>',
  ].join('\n'), '', 720);
}

function badge(label, count, icon) {
  const value = compactNumber.format(count);
  const width = Math.max(139, 108 + value.length * 10);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="30" viewBox="0 0 ' + width + ' 30">\n'
    + '  <title>' + label + ': ' + number.format(count) + '</title>\n'
    + '  <rect width="' + width + '" height="30" fill="#6d3fc0"/>\n'
    + '  <path fill="#382654" d="M0 0h99v30H0z"/>\n'
    + '  <path d="' + icon + '" fill="none" stroke="#ffffff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>\n'
    + '  <g fill="#ffffff" font-family="system-ui, sans-serif" font-size="12" font-weight="650">\n'
    + '    <text x="32" y="19.5" letter-spacing="1">' + label + '</text>\n'
    + '    <text x="' + (99 + (width - 99) / 2) + '" y="19.5" text-anchor="middle">' + value + '</text>\n'
    + '  </g>\n</svg>\n';
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

function statsBlock(activity, streak, languages) {
  const end = isoDate(activity.at(-1).date);
  const counts = activity.map(({ date, count }) => dateLabel.format(date) + ' (' + number.format(count) + ')');
  const distribution = languages.map(({ name, share }) => escapeMarkup(name) + ' (' + escapeMarkup(percent(share)) + ')');
  const currentDays = streak.current + (streak.current === 1 ? ' day' : ' days');
  const longestDays = streak.longest + (streak.longest === 1 ? ' day' : ' days');
  const totalContributions = number.format(streak.total) + (streak.total === 1 ? ' contribution' : ' contributions');
  return [
    '### Contribution graph',
    '',
    '![Daily GitHub contributions for 31 complete days through ' + end + ' (UTC). Counts in the breakdown below.](assets/activity.svg)',
    '',
    '### Streak activity',
    '',
    '![GitHub contribution streaks. Total: ' + totalContributions + '. Current: ' + currentDays
      + '. Longest: ' + longestDays + '.](assets/streak.svg)',
    '',
    '<details>',
    '<summary>Daily counts and language breakdown</summary>',
    '',
    '- **Daily contributions (UTC)** · ' + counts.join(', '),
    '- **Streak activity** · ' + totalContributions + ' since joining GitHub. '
      + 'Current streak: ' + currentDays + '. Longest streak: ' + longestDays + '.',
    '- **Language shares** · ' + (distribution.join(', ') || 'No language bytes reported'),
    '',
    '[Live contribution calendar](https://github.com/' + username + ')',
    '',
    '![Programming language shares by repository bytes. Percentages below.](assets/languages.svg)',
    '',
    'Streaks use UTC dates visible in GitHub’s public calendar. A streak active yesterday remains current until today ends. Language shares use GitHub-reported bytes across public non-fork project repositories.',
    'Profile views are proxied badge requests counted by Komarev.',
    '',
    '</details>',
  ].join('\n');
}

function badgesBlock(followers, stars) {
  const followerCount = number.format(followers) + (followers === 1 ? ' GitHub follower' : ' GitHub followers');
  const starCount = number.format(stars) + (stars === 1 ? ' star earned' : ' stars earned');
  return [
    '<p align="center">',
    '  <a href="https://github.com/' + username + '?tab=followers"><img src="assets/follow.svg" height="30" alt="Follow · ' + followerCount + '"></a>',
    '  <a href="https://github.com/' + username + '?tab=repositories&amp;sort=stargazers"><img src="assets/stars.svg" height="30" alt="' + starCount + ' on public non-fork repositories"></a>',
    '  <img src="https://komarev.com/ghpvc/?username=' + username
      + '&amp;color=6d3fc0&amp;style=for-the-badge&amp;label=Profile%20views" height="30" alt="Profile views via Komarev, based on badge requests">',
    '</p>',
  ].join('\n');
}

function updateReadme(readme, section, block) {
  const startMarker = '<!-- profile-' + section + ':start -->';
  const endMarker = '<!-- profile-' + section + ':end -->';
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  assert(start !== -1 && end > start && start === readme.lastIndexOf(startMarker)
    && end === readme.lastIndexOf(endMarker), 'Expected one profile ' + section + ' block in README.md');
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  return readme.slice(0, start + startMarker.length) + newline + newline
    + block.replaceAll('\n', newline) + newline + newline + readme.slice(end);
}

async function generate() {
  const root = new URL('../', import.meta.url);
  const readmeUrl = new URL('README.md', root);
  const [original, response, profile, repositories, monoFont] = await Promise.all([
    readFile(readmeUrl, 'utf8'),
    get(calendarUrl),
    profileStats(),
    repositoryStats(),
    readFile(new URL('assets/fonts/IBMPlexMono-Regular.woff2', root), 'base64'),
  ]);
  const today = Date.parse(isoDate(Date.now()));
  const days = calendarDays(await response.text());
  const activity = recentActivity(days, today);
  assert(profile.joined <= today, 'GitHub join date is in the future');
  const streak = streakStats(await contributionHistory(days, profile.joined, today), today);
  const readme = updateReadme(
    updateReadme(original, 'badges', badgesBlock(profile.followers, repositories.stars)),
    'stats', statsBlock(activity, streak, repositories.languages),
  );
  // Prepare and validate every output before touching the existing snapshot.
  const outputs = [
    [readmeUrl, readme],
    [new URL('assets/activity.svg', root), activityChart(activity, monoFont)],
    [new URL('assets/streak.svg', root), streakCard(streak)],
    [new URL('assets/follow.svg', root), badge('FOLLOW', profile.followers, 'M7 22v-1a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1M15 11a3 3 0 1 1-6 0 3 3 0 1 1 6 0M21 12v6m-3-3h6')],
    [new URL('assets/stars.svg', root), badge('STARS', repositories.stars, 'M15 7l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z')],
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
  const activity = recentActivity(calendarDays(html), today);
  assert.equal(isoDate(activity.at(-1).date), '2026-11-20');
  assert.equal(activity.reduce((sum, sample) => sum + sample.count, 0), 3);
  const graph = activityChart(activity, '');
  assert.equal([...graph.matchAll(/<circle class="point"/g)].length, graphDays);
  assert.match(graph, /<path class="trend" d="M58 182\.0 C/);
  const consecutive = [
    { date: today - 3 * day, count: 1 },
    { date: today - 2 * day, count: 4 },
    { date: today - day, count: 1 },
    { date: today, count: 0 },
  ];
  const streak = streakStats(consecutive, today);
  assert.deepEqual(streak, { total: 6, current: 3, longest: 3 });
  assert.equal(streakStats(consecutive, today + day).current, 0);
  assert.deepEqual(streakStats([], today), { total: 0, current: 0, longest: 0 });
  assert.equal(calendarDays(html.replace('the last year', '2026')).size, 371);
  assert.throws(() => calendarDays(html.replace('3 contributions in', '4 contributions in')), /disagrees/);
  assert.throws(() => calendarDays(html.replace('2025-11-16" id', '2025-11-17" id')), /duplicate/);
  assert.throws(() => recentActivity(calendarDays(html), today + 2 * day), /stale/);

  const languages = languageShares(new Map([['TypeScript', 3], ['CSS', 1]]));
  assert.deepEqual(languages, [{ name: 'TypeScript', share: 0.75 }, { name: 'CSS', share: 0.25 }]);
  const block = statsBlock(activity, streak, languages);
  const readme = updateReadme('<!-- profile-stats:start -->\n<!-- profile-stats:end -->', 'stats', block);
  assert.equal(updateReadme(readme, 'stats', block), readme);
  assert.throws(() => updateReadme('', 'stats', block), /Expected one/);
  await assert.rejects(get('https://github.com/users/' + username + '/contributions',
    async () => new Response('', { status: 429 })), /HTTP 429/);
  console.log('Profile analytics self-check passed');
}

if (process.argv[2] === '--self-check') {
  await selfCheck();
} else {
  await generate();
}
