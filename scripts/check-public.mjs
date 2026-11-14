#!/usr/bin/env node
/**
 * Public-release lint: tracked files carry no calendar dates, relative dates, epoch timestamps, commit or pull-request
 * references, branch names, pre-release wording, dated file names or media timestamps. The public repository is one
 * commit, so nothing in it may say when or over what period the work was done.
 *
 *   node scripts/check-public.mjs              tracked files in the working tree
 *   node scripts/check-public.mjs --ref <ref>  the tree of <ref> (what scripts/public-snapshot.sh commits)
 *   node scripts/check-public.mjs --summary    counts per rule only
 *
 * Exits 1 on any finding, or on an ALLOW entry that no longer matches anything. ALLOW is the whole allowlist; keep it
 * small and give every entry a reason.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const HEX = '(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]';

/** Text rules: id → patterns. Every match is a finding unless ALLOW covers it. */
const RULES = {
  'iso-date': [/(?<![\w.])(?:19|20)\d\d-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?(?![\d])/g],
  'compact-date': [/(?<![\w.])20[0-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:T\d{4,6}Z?)?(?!\w)/g],
  'month-date': [
    new RegExp(`\\b(?:${MONTH})\\.? (?:\\d{1,2}(?:st|nd|rd|th)?|(?:19|20)\\d\\d)\\b(?![%×:.]\\d|\\s*[%×])`, 'g'),
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:${MONTH})\\b`, 'g'),
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g,
  ],
  'slash-date': [/(?<![\w\/.])(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])\/(?:19|20)?\d\d(?![\w\/])/g, /(?<![\w\/.])(?:1[3-9]|2\d|3[01])\/(?:0?[1-9]|1[0-2])(?![\w\/])/g],
  year: [/(?<![\w.$+\/-])20[1-3]\d(?![\w-]|\.\d)/g],
  'epoch-time': [/(?<![\w.])1[6-9]\d{11}(?!\d)/g],
  'relative-date': [
    /\b(?:yesterday|tomorrow|tonight|today|nowadays|this (?:week|weekend|month|morning|afternoon|evening|year|quarter)|last (?:week|weekend|month|night|year|quarter)|next (?:week|weekend|month|year|quarter)|(?:a|one|two|three|four|a few|few|several) (?:days|weeks|months|years) ago|earlier this (?:week|month|year)|(?:in|since|as of|during|until|by|early|late|mid-?)\s+20[2-3]\d|recently (?:added|changed|fixed|removed|landed|renamed|introduced|updated)|(?:last )?updated on|at the time of writing)\b/gi,
  ],
  'commit-ref': [
    new RegExp(`\`${HEX}{7,40}\``, 'g'),
    new RegExp(`\\b(?:commit|commits|sha|rev|revision|cherry-picked|reverted|merged|master|main|HEAD|at|against|since|before|after)\\s+(?:\`|\\()?${HEX}{7,40}\\b`, 'gi'),
    new RegExp(`(?<![\\w#$\\/.:'"=-])${HEX}{7,12}(?![\\w-])`, 'g'),
    /\bPR ?#\d+|\bpull request #\d+|\/pull\/\d+|\/commit\/[0-9a-f]{7,}|\b(?:fixes|closes|resolves) #\d+/gi,
    /(?<![\w\/.@-])(?:feat|feature|fix|bugfix|hotfix|chore|perf|refactor|wip|exp)\/[a-z0-9][\w.-]*/g,
    /\borigin\/[\w.-]+/g,
    /\bmaster\b/g,
  ],
  prerelease: [
    /\bpre-?release\b/gi,
    /\b(?:public|closed|open|early|private) (?:alpha|beta)\b|\b(?:alpha|beta) (?:release|build|version|testers?|testing|access|stage|period)\b|\bin (?:alpha|beta)\b|\((?:alpha|beta)\)|\bearly access\b/gi,
    /\b\d+\.\d+\.\d+-(?:alpha|beta|rc|pre)\b/gi,
  ],
  history: [/\b[Pp]hases? (?:[A-H]?\d|[A-H]\b)(?![\w-])/g, /\bcheckpoints? [a-h]\d\b/gi, /\bchangelog\b.{0,40}\bdate/gi],
};

/**
 * The whole allowlist. `match` is tested against the matched text, `line` (optional) against its whole line,
 * `path` (optional) against the file path. An entry that allows nothing is reported as stale.
 */
const ALLOW = [
  { rule: 'iso-date', match: /^(?:2025-06-18|2025-11-25|2026-07-28)$/, why: 'MCP protocol revision identifiers (these exact values name nothing else here)' },
  { rule: 'iso-date', match: /^(?:2025-11-20|2026-09-15)$/, line: /mcp-client-/, why: 'Anthropic MCP connector beta header values (`anthropic-beta: mcp-client-…`)' },
  { rule: 'iso-date', match: /^2023-06-01$/, line: /anthropic-version/, why: 'Anthropic API version header value' },
  { rule: 'iso-date', match: /^2025-08-07$/, line: /gpt-5-mini-2025-08-07/, why: 'OpenAI model snapshot id (dated-snapshot price lookup)' },
  { rule: 'iso-date', match: /^2025-09-13$/, line: /quickjs/i, why: 'QuickJS release identifier, part of the policy engine identity and surfaceHash' },
  { rule: 'iso-date', match: /^2020-12$/, line: /JSON Schema|json-schema\.org/i, why: 'JSON Schema draft 2020-12 identifier' },
  { rule: 'iso-date', match: /^(?:2000-0[1-2](?:-\d\d)?|1970-01(?:-\d\d)?|2099-01(?:-\d\d)?)$/, why: 'synthetic timestamps: year 2000 is the fixture epoch, 1970 the Unix epoch, 2099 a far-future expiry' },
  { rule: 'year', match: /^20[1-3]\d$/, line: /\bCopyright\b(?!.*\b20[1-3]\d\b.*\b20[1-3]\d\b)/, why: 'copyright lines, one year' },
  { rule: 'slash-date', match: /^25\/[36]$/, line: /\bTrueSkill\b|deviation 25\/3/, why: 'TrueSkill parameters (25/3, 25/6), not dates' },
];

/** Paths never scanned as text: generated lockfiles, vendored third-party code and licence texts. */
const SKIP_TEXT = [
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)LICENSE[^/]*$/,
  /^tools\/readme-art\/fonts\/OFL-[^/]+\.txt$/,
  /^sdks\/unreal\/Plugins\/PlayerThree\/Source\/PlayerThreeCore\/ThirdParty\//,
];

/** This file names the patterns it rejects. */
const SELF = 'scripts/check-public.mjs';

const MEDIA = /\.(?:png|jpe?g|webp)$/i;

const args = process.argv.slice(2);
const refAt = args.indexOf('--ref');
const ref = refAt >= 0 ? args[refAt + 1] : undefined;
if (refAt >= 0 && !ref) { console.error('--ref needs a ref'); process.exit(2); }
const summary = args.includes('--summary');

/** [path, Buffer][] for every tracked regular file, read from `ref`'s tree or from the working tree. */
function trackedFiles() {
  if (ref) {
    const listing = execFileSync('git', ['ls-tree', '-r', '-z', ref], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0').filter(Boolean)
      .map((row) => { const [meta, path] = row.split('\t'); const [mode, type, sha] = meta.split(' '); return { mode, type, sha, path }; })
      .filter((e) => e.type === 'blob' && e.mode !== '120000');
    const out = spawnSync('git', ['cat-file', '--batch'], { input: listing.map((e) => e.sha).join('\n') + '\n', maxBuffer: 1 << 30 });
    if (out.status !== 0) throw new Error(`git cat-file failed: ${out.stderr}`);
    const buf = out.stdout;
    const files = [];
    let at = 0;
    for (const e of listing) {
      const nl = buf.indexOf(10, at);
      const size = Number(buf.subarray(at, nl).toString().split(' ')[2]);
      files.push([e.path, buf.subarray(nl + 1, nl + 1 + size)]);
      at = nl + 1 + size + 1;
    }
    return files;
  }
  const modes = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  const files = [];
  for (const row of modes) {
    const [meta, path] = row.split('\t');
    const mode = meta.split(' ')[0];
    if (mode === '120000' || mode === '160000') continue;
    let data;
    try { data = readFileSync(path); } catch { continue; } // deleted in the working tree
    files.push([path, data]);
  }
  return files;
}

const used = new Set();
const allowed = (rule, text, line, path) => {
  const index = ALLOW.findIndex((a) => a.rule === rule && a.match.test(text) && (!a.line || a.line.test(line)) && (!a.path || a.path.test(path)));
  if (index >= 0) used.add(index);
  return index >= 0;
};

/** Timestamp-bearing metadata in PNG (tIME, text chunks), JPEG (APP1 Exif/XMP, APP13, COM) and WebP (EXIF, XMP). */
function mediaFindings(path, data) {
  const found = [];
  if (/\.png$/i.test(path)) {
    for (let at = 8; at + 8 <= data.length;) {
      const len = data.readUInt32BE(at);
      const type = data.toString('latin1', at + 4, at + 8);
      if (['tIME', 'tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) found.push(`PNG ${type} chunk`);
      if (type === 'IEND') break;
      at += 12 + len;
    }
  } else if (/\.jpe?g$/i.test(path)) {
    for (let at = 2; at + 4 <= data.length && data[at] === 0xff;) {
      const marker = data[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = data.readUInt16BE(at + 2);
      if (marker === 0xe1 || marker === 0xed || marker === 0xfe) found.push(`JPEG ${marker === 0xe1 ? 'APP1 (Exif/XMP)' : marker === 0xed ? 'APP13' : 'COM'} segment`);
      at += 2 + len;
    }
  } else if (/\.webp$/i.test(path)) {
    for (let at = 12; at + 8 <= data.length;) {
      const type = data.toString('latin1', at, at + 4);
      const len = data.readUInt32LE(at + 4);
      if (type === 'EXIF' || type === 'XMP ') found.push(`WebP ${type.trim()} chunk`);
      at += 8 + len + (len & 1);
    }
  }
  return found;
}

const files = trackedFiles();
const findings = [];
for (const [path, data] of files) {
  for (const re of [RULES['iso-date'][0], RULES['compact-date'][0]]) {
    for (const m of path.matchAll(new RegExp(re.source.replace('(?<![\\w.])', '(?<![\\d.])'), 'g'))) findings.push({ path, line: 0, rule: 'dated-path', text: m[0] });
  }
  if (MEDIA.test(path)) {
    for (const what of mediaFindings(path, data)) findings.push({ path, line: 0, rule: 'media-metadata', text: what });
    continue;
  }
  if (path === SELF || SKIP_TEXT.some((re) => re.test(path)) || data.subarray(0, 8000).includes(0)) continue;
  const lines = data.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [rule, patterns] of Object.entries(RULES)) {
      for (const re of patterns) {
        for (const m of line.matchAll(re)) {
          if (!allowed(rule, m[0], line, path)) findings.push({ path, line: i + 1, rule, text: m[0] });
        }
      }
    }
  });
}
for (const [i, a] of ALLOW.entries()) {
  if (!used.has(i)) findings.push({ path: SELF, line: 0, rule: 'stale-allow', text: `${a.rule} ${a.match} (${a.why})` });
}

const counts = {};
for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
if (!summary) for (const f of findings) console.log(`${f.path}:${f.line}: [${f.rule}] ${f.text}`);
console.log(findings.length
  ? `check-public: ${findings.length} finding(s) in ${files.length} files ${JSON.stringify(counts)}`
  : `check-public: clean (${files.length} files)`);
process.exit(findings.length ? 1 : 0);
