#!/usr/bin/env node
// "Is My AI App Safe to Ship?" — a free 5-minute check from Ship Kit.
//
// Put this file in your app's main folder and run:   node is-my-app-safe.mjs
//
// What it does: reads your project files on your computer, and asks your own Supabase project for data
// the way a stranger would (read-only, using the public key already in your website).
// Nothing is uploaded anywhere else. Needs Node.js 18+ (free from https://nodejs.org). No installs.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`This check needs Node.js 18 or newer (you have ${process.versions.node}). Install the LTS version from https://nodejs.org and run it again.`);
  process.exit(2);
}

// Where to get the $27 Ship Kit (shown at the end of the results).
const SHIP_KIT_URL = "https://poofylabs.dev/?from=gh-repo#ship-kit";

// ---------- tiny helpers ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const ROOT = path.resolve(option('project') || process.cwd());
const SELF = fs.realpathSync(fileURLToPath(import.meta.url));

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const bold = paint('1');
const dim = paint('2');

const git = (args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.error ? 127 : r.status, out: (r.stdout || '').trim() };
};
const inRepo = () => git(['rev-parse', '--is-inside-work-tree']).out === 'true';

async function ask(question) {
  if (flag('fix')) return 'y';
  if (flag('no-fix') || !process.stdin.isTTY) return 'n';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return a.trim().toLowerCase();
}

const readText = (full) => {
  try {
    const buf = fs.readFileSync(full);
    return buf.includes(0) ? null : buf.toString('utf8');
  } catch {
    return null;
  }
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', '.netlify', '.turbo', '.cache', 'coverage', '.venv', 'venv', '.svelte-kit', '.expo', '.output', '.nuxt', 'vendor', '.supabase', 'ship-kit', 'ship-kit-reports']);
const SKIP_FILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$|\.(png|jpe?g|gif|webp|ico|svg|mp4|mov|woff2?|ttf|otf|pdf|zip|gz|map|wasm)$/i;

function listFiles() {
  const out = [];
  const stack = [ROOT];
  while (stack.length && out.length < 20000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(e.name === '.next' ? path.join(full, 'static') : full);
      } else if (e.isFile() && full !== SELF) {
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (SKIP_FILES.test(rel)) continue;
        try {
          if (fs.statSync(full).size > 2_000_000) continue;
        } catch {
          continue;
        }
        out.push({ full, rel });
      }
    }
  }
  return out;
}

const isEnvName = (n) => /^\.env(\.[\w.-]+)?$/.test(n) && !/\.(example|sample|template)$/i.test(n);
function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}
const jwtRole = (t) => {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).role;
  } catch {
    return null;
  }
};
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PUBLIC_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|EXPO_PUBLIC_|PUBLIC_|NUXT_PUBLIC_|GATSBY_|VUE_APP_)/;
const SECRETS = [
  [/\b[sr]k_live_[A-Za-z0-9]{16,}/g, 'Stripe LIVE secret key'],
  [/\b[sr]k_test_[A-Za-z0-9]{16,}/g, 'Stripe test secret key'],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, 'Stripe webhook secret'],
  [/\bsb_secret_[A-Za-z0-9_-]{16,}/g, 'Supabase secret key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API key'],
  [/\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, 'OpenAI API key'],
];
function secretsIn(text) {
  const hits = [];
  for (const [re, name] of SECRETS) if (new RegExp(re.source).test(text)) hits.push(name);
  for (const m of text.matchAll(JWT)) if (jwtRole(m[0]) === 'service_role') hits.push('Supabase service_role (admin) key');
  return [...new Set(hits)];
}
const isServerFile = (rel) =>
  /(^|\/)(supabase\/functions|server|api|backend|netlify\/functions|functions|scripts)\//.test(rel) || /(^|\/)app\/(.+\/)?route\.[cm]?[jt]s$/.test(rel) || /\.server\./.test(rel);
const isBrowserFile = (rel) => !isServerFile(rel) && (/\.(m?[jt]sx?|vue|svelte|astro|html?)$/.test(rel) || /^(dist|build|out|\.next\/static)\//.test(rel));

// ---------- the five checks ----------

const results = [];
const record = (r) => {
  results.push(r);
  const icon = r.status === 'pass' ? green('✅ PASS') : r.status === 'warn' ? yellow('⚠️  RISK') : r.status === 'fail' ? red('❌ FAIL') : dim('➖ SKIPPED');
  console.log(`\n${icon}  ${bold(r.title)}`);
  for (const line of r.lines || []) console.log(`    ${line}`);
};

async function main() {
  console.log(bold('\nIs My AI App Safe to Ship?  ·  free 5-minute check'));
  console.log(dim(`Checking: ${ROOT}`));

  const files = listFiles();
  const texts = files.map((f) => ({ ...f, text: isEnvName(path.posix.basename(f.rel)) ? null : readText(f.full) })).filter((f) => f.text != null);
  const envFiles = files.filter((f) => isEnvName(path.posix.basename(f.rel)) && !f.rel.includes('/node_modules/')).map((f) => ({ ...f, vars: parseEnv(readText(f.full) || '') }));
  const repo = inRepo();

  // 1. Secret keys inside the website
  const leaks = [];
  for (const f of texts) if (isBrowserFile(f.rel)) for (const name of secretsIn(f.text)) leaks.push(`${name} in ${f.rel}`);
  for (const env of envFiles)
    for (const [name, value] of Object.entries(env.vars)) if (PUBLIC_PREFIX.test(name)) for (const s of secretsIn(value)) leaks.push(`${s} in ${env.rel} as ${name} (that name makes it public)`);
  record(
    leaks.length
      ? {
          status: 'fail',
          title: 'Secret keys are inside your website, where any visitor can copy them',
          lines: [...leaks.slice(0, 6).map((l) => red(`• ${l}`)), 'Anyone can open your site, view the source and use these keys. Move them to server-side secrets and replace them.'],
        }
      : { status: 'pass', title: 'No secret keys found in your website code' },
  );

  // 2. .env files kept out of git (quick fix available)
  const unprotected = [];
  const trackedEnv = [];
  for (const env of envFiles) {
    if (repo) {
      if (git(['ls-files', '--error-unmatch', '--', env.rel]).code === 0) trackedEnv.push(env.rel);
      else if (git(['check-ignore', '-q', '--', env.rel]).code !== 0) unprotected.push(env.rel);
    } else if (!/^\.env/m.test(readText(path.join(ROOT, '.gitignore')) || '')) unprotected.push(env.rel);
  }
  if (!envFiles.length) record({ status: 'pass', title: 'No .env file with keys in this folder' });
  else if (!unprotected.length && !trackedEnv.length) record({ status: 'pass', title: 'Your .env file (your keys) is kept out of git' });
  else {
    const lines = [];
    if (trackedEnv.length) lines.push(red(`• ${trackedEnv.join(', ')} is already saved in your git history. Every key in it should be replaced.`));
    if (unprotected.length) lines.push(red(`• ${unprotected.join(', ')} is not in .gitignore, so your next save could upload your keys.`));
    record({ status: 'fail', title: 'Your keys file (.env) is not protected', lines });
    if ((await ask('    Quick fix: add .env to .gitignore now? (y/n) ')) === 'y') {
      const file = path.join(ROOT, '.gitignore');
      const current = readText(file) || '';
      fs.writeFileSync(file, `${current.replace(/\s*$/, current ? '\n\n' : '')}# Secret keys: never save these\n.env\n.env.*\n!.env.example\n`);
      console.log(green('    ✓ Done. .env is now listed in .gitignore.'));
      if (trackedEnv.length) console.log(yellow(`    Still to do: run  git rm --cached ${trackedEnv[0]}  so git stops tracking it, then replace the keys in it.`));
    }
  }

  // 3. Database readable by strangers
  const found = { url: null, key: null, tables: new Set() };
  for (const env of envFiles)
    for (const [name, v] of Object.entries(env.vars)) {
      if (!found.url && /SUPABASE_URL$/.test(name) && /^https?:\/\//.test(v)) found.url = v;
      if (!found.key && /SUPABASE_(ANON|PUBLISHABLE)(_DEFAULT)?_KEY$|SUPABASE_KEY$/.test(name) && (jwtRole(v) === 'anon' || v.startsWith('sb_publishable_'))) found.key = v;
    }
  for (const f of texts) {
    if (!found.url) found.url = f.text.match(/https:\/\/[a-z0-9]{20}\.supabase\.co\b/)?.[0] || null;
    if (!found.key) found.key = [...f.text.matchAll(JWT)].map((m) => m[0]).find((t) => jwtRole(t) === 'anon') || f.text.match(/\bsb_publishable_[A-Za-z0-9_-]{10,}/)?.[0] || null;
    for (const m of f.text.matchAll(/(?<!(?:storage|Array)\s*)\.from\(\s*['"`]([A-Za-z_]\w*)['"`]\s*\)/g)) found.tables.add(m[1]);
    if (/\.sql$/i.test(f.rel)) for (const m of f.text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(/gi)) found.tables.add(m[1]);
  }
  // Since Oct 30, 2026 Supabase no longer grants new tables to the app automatically. Tables created by migrations dated
  // after that, with no grant anywhere in the setup files, answer "permission denied" (42501) to the app.
  const sqlTexts = texts.filter((f) => /\.sql$/i.test(f.rel));
  const allSql = sqlTexts.map((f) => f.text.replace(/--[^\n]*/g, ' ')).join('\n');
  const blanketGrant = /grant[\s\S]{1,80}?on\s+all\s+tables\s+in\s+schema\s+"?public"?\s+to[^;]*\b(anon|authenticated)\b/i.test(allSql) || /alter\s+default\s+privileges[^;]*\bon\s+tables\s+to[^;]*\b(anon|authenticated)\b/i.test(allSql);
  const ungranted = [];
  for (const f of sqlTexts) {
    const stamp = f.rel.match(/(?:^|\/)migrations\/(\d{8})\d*_[^/]*\.sql$/i)?.[1];
    if (!stamp || stamp < '20261030' || blanketGrant) continue;
    for (const m of f.text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(/gi))
      if (!new RegExp(`grant[^;]+\\bon\\s+(?:table\\s+)?(?:"?public"?\\.)?"?${m[1]}"?\\b[^;]*\\bto[^;]*\\b(anon|authenticated)\\b`, 'i').test(allSql)) ungranted.push(m[1]);
  }
  const grantLines = ungranted.length
    ? [yellow(`• New tables with no access grant: ${ungranted.slice(0, 6).join(', ')}`), 'Since Oct 30, 2026, Supabase no longer gives new tables to your app automatically, so these answer "permission denied" (error 42501). Grant only what each role needs. Never paste "grant all on all tables".']
    : [];
  if (flag('offline') || !found.url || !found.key) {
    if (ungranted.length) record({ status: 'warn', title: 'Your newest tables will answer "permission denied" (42501)', lines: [...grantLines, dim('The live database check was skipped, so whether strangers can read your data is not covered.')] });
    else record({ status: 'skip', title: 'Database check skipped', lines: [flag('offline') ? 'You ran with --offline.' : "Couldn't find your Supabase address and public key in this folder."] });
  } else {
    const base = found.url.replace(/\/+$/, '');
    const headers = { apikey: found.key, ...(found.key.startsWith('eyJ') ? { Authorization: `Bearer ${found.key}` } : {}) };
    const open = [];
    const refused = [];
    let reached = false;
    for (const t of [...found.tables].slice(0, 12)) {
      try {
        const r = await fetch(`${base}/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`, { headers: { ...headers, Prefer: 'count=exact' }, signal: AbortSignal.timeout(10000) });
        reached = true;
        const body = await r.json().catch(() => null);
        if (body?.code === '42501') refused.push(t);
        if (r.ok && Array.isArray(body) && body.length) {
          const total = (r.headers.get('content-range') || '').split('/')[1];
          open.push(`"${t}"${total && total !== '*' ? ` (${total} rows)` : ''}`);
        }
      } catch {}
    }
    if (!reached) record({ status: 'skip', title: "Database check skipped: couldn't reach your Supabase project", lines: ['Check your internet connection and that the project is not paused.'] });
    else if (open.length)
      record({
        status: 'fail',
        title: 'Strangers can read your database',
        lines: [red(`• Readable by anyone with your public key: ${open.join(', ')}`), 'Your public key is inside your website, so "anyone with the key" means anyone.', ...grantLines],
      });
    else if (ungranted.length) record({ status: 'warn', title: 'Your newest tables will answer "permission denied" (42501)', lines: [...grantLines, dim(`Strangers got no data back from the ${found.tables.size} tables we tried.`)] });
    else
      record({
        status: 'pass',
        title: `Strangers got no data back from the ${found.tables.size} tables we tried`,
        lines: refused.length ? [dim(`${refused.join(', ')} answered "permission denied" (42501). That's right if only logged-in users read ${refused.length === 1 ? 'it' : 'them'}. If your app shows that error, the table needs an access grant (Supabase's Oct 30, 2026 change).`)] : [],
      });
  }

  // 4. Stripe webhook signature
  const usesStripe = texts.some((f) => /stripe/i.test(f.text));
  const hooks = texts.filter((f) => /\.(m?[jt]sx?)$/.test(f.rel) && (/stripe/i.test(f.text) || /stripe/i.test(f.rel)) && (/constructEvent|stripe-signature/i.test(f.text) || /webhook/i.test(f.rel)) && !isBrowserFile(f.rel));
  if (!usesStripe) record({ status: 'skip', title: 'Payments check skipped: no Stripe code found' });
  else if (!hooks.length) record({ status: 'warn', title: "You use Stripe but there's no webhook", lines: ["Your app can't find out when someone renews, cancels or gets refunded."] });
  else if (!hooks.some((h) => /constructEvent(Async)?\s*\(/.test(h.text)))
    record({ status: 'fail', title: "Your Stripe webhook doesn't check signatures", lines: [red(`• ${hooks[0].rel}`), 'Anyone who finds the address can fake a "payment succeeded" message and get paid features for free.'] });
  else record({ status: 'pass', title: "Your Stripe webhook checks Stripe's signature" });

  // 5. Doom-loop protection (quick fix available)
  const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', 'GEMINI.md', '.github/copilot-instructions.md'];
  const RULE_DIRS = ['.cursor/rules', '.windsurf/rules'];
  const hasRules = RULE_FILES.some((f) => fs.existsSync(path.join(ROOT, f))) || RULE_DIRS.some((d) => (fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).length > 0 : false));
  if (repo && hasRules) record({ status: 'pass', title: 'You have file history and AI rules (your doom-loop safety net)' });
  else {
    record({
      status: repo || hasRules ? 'warn' : 'fail',
      title: 'Nothing stops the "fix one thing, break two" doom loop',
      lines: [!repo ? yellow('• No file history (git), so there is no undo button for bad AI changes.') : null, !hasRules ? yellow('• No rules file telling your AI to keep changes small.') : null].filter(Boolean),
    });
    if (!hasRules && (await ask('    Quick fix: create a starter AGENTS.md with 3 anti-doom-loop rules? (y/n) ')) === 'y') {
      fs.writeFileSync(
        path.join(ROOT, 'AGENTS.md'),
        '# Rules for AI assistants working on this app\n\n' +
          'Starter rules from the free "Is My AI App Safe to Ship?" check.\n\n' +
          '1. **One problem per change.** Before editing, list the files you will touch. If it is more than 3 files, wait for my "go".\n' +
          '2. **Two strikes, then stop.** If a fix fails twice, undo it and explain the real cause instead of trying a third patch.\n' +
          '3. **No secrets, no open data.** Never put secret keys in frontend code or in VITE_ / NEXT_PUBLIC_ variables, and turn on Row Level Security for every new table.\n',
      );
      console.log(green('    ✓ Created AGENTS.md. Cursor, Codex, Windsurf, Claude Code and most AI agents read it automatically, and so does Lovable once it is on your connected GitHub project.'));
    }
  }

  // ---------- score ----------
  const scored = results.filter((r) => r.status !== 'skip');
  const points = scored.reduce((sum, r) => sum + (r.status === 'pass' ? 20 : r.status === 'warn' ? 10 : 0), 0);
  const score = scored.length ? Math.round((points / (scored.length * 20)) * 100) : 0;
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const verdict = fails
    ? score >= 60
      ? yellow(`Risky: fix the ${fails === 1 ? 'red item' : `${fails} red items`} before taking money`)
      : red('Not safe to take real money yet')
    : warns
      ? yellow(`Nearly there: look at the ${warns === 1 ? 'warning' : `${warns} warnings`} above`)
      : green('Looking good on the basics');
  console.log(`\n${bold('Your score:')} ${bold(String(score))}/100  ·  ${verdict}`);
  if (scored.length < results.length) console.log(dim(`(${results.length - scored.length} check${results.length - scored.length === 1 ? '' : 's'} skipped and not counted)`));
  if (results.some((r) => r.status === 'skip' && r.title.startsWith('Database check skipped')))
    console.log(yellow("Your database wasn't checked, so this score doesn't cover it. Open database tables are the most common leak in AI-built apps."));

  console.log(`\n${bold("What this free check didn't look at:")}`);
  console.log('  • Whether strangers can CHANGE or DELETE your data, not just read it');
  console.log('  • Public storage buckets (uploaded files anyone can download)');
  console.log('  • Fake sign-ups with emails people don\'t own');
  console.log('  • What happens to access on renewals, failed cards, cancellations, refunds and duplicate Stripe events');
  console.log('  • An undo button and full rules for Claude Code, Cursor, Lovable and Windsurf so one AI fix never breaks two features');
  console.log(`\n${bold('The $27 Ship Kit')} checks all of that in one command, then gives you a copy-paste fix prompt for every problem.`);
  console.log(SHIP_KIT_URL ? `Get it here: ${bold(SHIP_KIT_URL)}\n` : dim('Get it from the same page or email where you downloaded this file.\n'));

  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => {
  console.error(red(`Something went wrong while checking: ${e.message}`));
  process.exitCode = 2;
});
