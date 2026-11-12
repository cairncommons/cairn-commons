// install-watch: what a package install changed, read from the machine itself.
//
// Before an install command runs (PreToolUse) the dependency state of the project is saved: the lockfile when there is one, the
// installed distributions of the virtual environment otherwise. After it (PostToolUse) the state is read again and compared.
// Four things are detected, none of which the installer reports as an error:
//   major_downgrade     a dependency whose major version went down (for 0.x: the minor)
//   requested_mismatch  a version asked for exactly on the command line that is not the version installed
//   fresh_release       a version that changed and was published within the last seven days
//   install_failure     the installer refused to resolve (read by cairn-lookup's parseResolutionFailure)
// Nothing here talks to Cairn. The only network read is the public registry's release date of at most five changed packages, and
// only when something changed (CAIRN_WATCH_FRESH=off turns that off too). An install that changes nothing reads no network at all.
//
// Environment:
//   CAIRN_WATCH           lookup (default: tell the agent what was detected and attach a matching Cairn note),
//                         detect (tell the agent what was detected, never call Cairn), log (write the local log only), off
//   CAIRN_WATCH_EXCLUDE   comma-separated scopes or name prefixes that are private ("@acme/,acme-"): never sent, never looked up
//   CAIRN_WATCH_LOG       the local log (default ~/.cairn/install-watch.jsonl); one JSON line per install seen
//   CAIRN_WATCH_FRESH     off disables the release-date read
//   CAIRN_WATCH_OBSERVE   on sends what was detected to Cairn as an observation (off by default): the public package names and
//                         versions involved, the package manager, OS, CPU and runtime version. Counted, never shown as a verdict.
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {homedir, tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";

export const FRESH_DAYS = 7;
const FRESH_BUDGET_MS = 1500;
const MAX_FRESH_CHECKS = 5;
const MAX_LOCK_BYTES = 40 * 1024 * 1024;
const DAY = 86400000;

const INSTALL = /(?:^|[\s;&|(])(?:\S*\/)?(?:python[\d.]*\s+-m\s+)?(pip3?|uv|npm|pnpm|yarn|bun|poetry|pdm)\b([^|;&\n]*)/g;
const VERBS = {
  pip: /^\s+(?:install)\b/, pip3: /^\s+(?:install)\b/,
  uv: /^\s+(?:(?:--\S+\s+)*)(?:pip\s+install|add|sync|lock|remove)\b/,
  npm: /^\s+(?:(?:--\S+\s+)*)(?:install|i|add|ci|update|upgrade|up)\b/,
  pnpm: /^\s+(?:(?:--\S+\s+)*)(?:install|i|add|update|up|upgrade)\b/,
  yarn: /^\s*(?:$|(?:--\S+\s+)*(?:install|add|up|upgrade)\b)/,
  bun: /^\s+(?:install|i|add|update)\b/,
  poetry: /^\s+(?:install|add|update|lock|sync)\b/, pdm: /^\s+(?:install|add|update|sync|lock)\b/,
};
// An installer named inside another machine's command changes nothing here.
const ELSEWHERE = /(?:^|[\s;&|(])(?:docker|podman|nerdctl|kubectl|ssh|vagrant|devcontainer)\s/;

export const normPy = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PY_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const VERSION = /^[0-9][0-9A-Za-z.+!_-]{0,63}$/;
const okName = (ecosystem, name) => name.length <= 214 && (ecosystem === "npm" ? NPM_NAME : PY_NAME).test(name);

/** The install command inside a shell line: which tool, its arguments and the folder it runs in. Null for anything else. */
export function installCommand(command, cwd = process.cwd()) {
  const text = String(command ?? "");
  if (!text || text.length > 20000 || ELSEWHERE.test(text)) return null;
  for (const match of text.matchAll(INSTALL)) {
    const tool = match[1] === "pip3" ? "pip" : match[1];
    const rest = match[2] ?? "";
    if (!VERBS[match[1]].test(rest)) continue;
    let dir = cwd;
    const before = text.slice(0, match.index);
    const cd = [...before.matchAll(/(?:^|[;&]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/g)].pop();
    if (cd) { const target = cd[1].replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, homedir()); dir = isAbsolute(target) ? target : resolve(cwd, target); }
    const flagDir = rest.match(/\s(?:--prefix|--directory|--project|-C|--cwd|--dir)[=\s]+("[^"]+"|'[^']+'|\S+)/);
    if (flagDir) dir = resolve(dir, flagDir[1].replace(/^["']|["']$/g, ""));
    const ecosystem = ["npm", "pnpm", "yarn", "bun"].includes(tool) ? "npm" : "pypi";
    return {tool, ecosystem, dir, args: rest.trim(), python: (text.slice(match.index).match(/(\S+)\/bin\/(?:pip3?|python[\d.]*)\b/) ?? [])[1] ?? null};
  }
  return null;
}

/** Versions asked for exactly on the command line: `name==1.2.3` (Python) or `name@1.2.3` (npm). Ranges and tags are not exact. */
export function requestedVersions(install) {
  const out = [];
  const tokens = install.args.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, ""));
  for (const token of tokens) {
    if (!token || token.startsWith("-")) continue;
    if (install.ecosystem === "pypi") {
      const m = token.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:==([0-9][0-9A-Za-z.+!_-]*))?$/);
      if (m && !/^(install|add|sync|pip|lock|update|remove)$/.test(m[1])) out.push({name: normPy(m[1]), version: m[2] ?? null});
    } else {
      const m = token.match(/^((?:@[^@\/\s]+\/)?[^@\/\s]+)(?:@(.+))?$/);
      if (m && NPM_NAME.test(m[1]) && !/^(install|i|add|ci|update|upgrade|up)$/.test(m[1])) out.push({name: m[1].toLowerCase(), version: m[2] && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(m[2]) ? m[2] : null});
    }
  }
  return out;
}

// ---- reading the dependency state ----

const numbers = (version) => String(version).replace(/^\d+!/, "").split(/[-+]/)[0].split(".").map((part) => parseInt(part, 10) || 0);
export function compare(a, b) {
  const x = numbers(a), y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
/** True when `to` is a lower major than `from`; below 1.0 the minor is the breaking number. */
export function majorWentDown(from, to) {
  const x = numbers(from), y = numbers(to);
  if ((y[0] ?? 0) !== (x[0] ?? 0)) return (y[0] ?? 0) < (x[0] ?? 0);
  return (x[0] ?? 0) === 0 && (y[1] ?? 0) < (x[1] ?? 0);
}

const readText = (file) => { try { return statSync(file).size <= MAX_LOCK_BYTES ? readFileSync(file, "utf8") : null; } catch { return null; } };
/** Keep the highest version when a lockfile holds several copies of one package. */
const put = (state, name, version, extra = {}) => {
  if (!name || !version || !VERSION.test(version)) return;
  const had = state[name];
  if (!had || compare(version, had.v) > 0) state[name] = {v: version, ...extra};
};
const PUBLIC_NPM = /^https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//;

export function parseNpmLock(text) {
  const state = {};
  let lock; try { lock = JSON.parse(text); } catch { return state; }
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    // Top-level copies only: a nested copy belongs to one dependency and does not decide what the project itself gets.
    if (!key.startsWith("node_modules/") || key.indexOf("/node_modules/", 1) > 0 || !entry || entry.link) continue;
    const name = key.slice("node_modules/".length);
    if (NPM_NAME.test(name)) put(state, name.toLowerCase(), String(entry.version ?? ""), {pub: entry.resolved ? PUBLIC_NPM.test(entry.resolved) : null});
  }
  return state;
}
export function parsePnpmLock(text) {
  const state = {};
  for (const m of text.matchAll(/^ {2}'?\/?((?:@[^@\/\s']+\/)?[^@\/\s'(]+)[@\/](\d[^:'()\s]*)(?:\([^\n]*\))?'?:/gm)) if (NPM_NAME.test(m[1])) put(state, m[1].toLowerCase(), m[2]);
  return state;
}
export function parseYarnLock(text) {
  const state = {};
  for (const m of text.matchAll(/^"?((?:@[^@\/\s"]+\/)?[^@\/\s"]+)@[^\n]*:\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:?[ \t]+"?([^"\s]+)"?/gm)) if (NPM_NAME.test(m[1])) put(state, m[1].toLowerCase(), m[2]);
  return state;
}
export function parseBunLock(text) {
  const state = {};
  for (const m of text.matchAll(/^\s+"[^"\n]+":\s*\["((?:@[^@"\/]+\/)?[^@"\/]+)@(\d[^"]*)"/gm)) if (NPM_NAME.test(m[1])) put(state, m[1].toLowerCase(), m[2]);
  return state;
}
/** uv.lock and poetry.lock share the `[[package]]` layout. uv also records each file's upload time, so freshness needs no network. */
export function parseTomlLock(text) {
  const state = {};
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !version || !PY_NAME.test(name)) continue;
    const registry = block.match(/^source\s*=\s*\{\s*registry\s*=\s*"([^"]+)"/m)?.[1];
    const otherSource = /^source\s*=\s*\{\s*(?:path|git|url|editable|directory|virtual)\b/m.test(block) || /^\[package\.source\]/m.test(block);
    const uploads = [...block.matchAll(/upload-time\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    put(state, normPy(name), version, {pub: registry ? /^https:\/\/(?:pypi\.org|files\.pythonhosted\.org)\//.test(registry) : otherSource ? false : null, ...(uploads[0] ? {at: uploads[0]} : {})});
  }
  return state;
}
/** The distributions installed in a site-packages folder, from the names of their dist-info folders (what `pip freeze` reads). */
export function readSitePackages(sitePackages) {
  const state = {};
  let entries; try { entries = readdirSync(sitePackages); } catch { return null; }
  for (const entry of entries) {
    if (!entry.endsWith(".dist-info")) continue;
    const base = entry.slice(0, -".dist-info".length);
    const at = base.lastIndexOf("-");
    if (at <= 0) continue;
    // A direct_url.json marks a local path, a VCS checkout or a plain URL: not a release from the public index.
    put(state, normPy(base.slice(0, at)), base.slice(at + 1), {pub: existsSync(join(sitePackages, entry, "direct_url.json")) ? false : null});
  }
  return state;
}

function sitePackagesOf(install, env) {
  const roots = [install.python ? (isAbsolute(install.python) ? install.python : resolve(install.dir, install.python)) : null, env.VIRTUAL_ENV, join(install.dir, ".venv"), join(install.dir, "venv")].filter(Boolean);
  for (const root of roots) {
    try {
      const lib = join(root, "lib");
      const py = readdirSync(lib).find((name) => /^python\d/.test(name));
      if (py && existsSync(join(lib, py, "site-packages"))) return join(lib, py, "site-packages");
    } catch { /* not a virtual environment */ }
    if (existsSync(join(root, "Lib", "site-packages"))) return join(root, "Lib", "site-packages");
  }
  return null;
}

/**
 * Every dependency source the install can change, each read on its own so one is only compared with itself.
 * Returns {source name: {package: {v, pub?, at?}}}; empty when the folder has nothing to read.
 */
export function snapshot(install, env = {}) {
  const sources = {};
  const lock = (name, parse) => { const text = readText(join(install.dir, name)); if (text !== null) sources[name] = parse(text); };
  if (install.ecosystem === "npm") {
    lock("package-lock.json", parseNpmLock);
    lock("npm-shrinkwrap.json", parseNpmLock);
    if (!sources["package-lock.json"] && !sources["npm-shrinkwrap.json"]) lock("node_modules/.package-lock.json", parseNpmLock);
    lock("pnpm-lock.yaml", parsePnpmLock);
    lock("yarn.lock", parseYarnLock);
    lock("bun.lock", parseBunLock);
  } else {
    lock("uv.lock", parseTomlLock);
    lock("poetry.lock", parseTomlLock);
    lock("pdm.lock", parseTomlLock);
    const site = sitePackagesOf(install, env);
    if (site) { const state = readSitePackages(site); if (state) sources["site-packages"] = state; }
  }
  return sources;
}

/** Sources of the "after" state that did not exist before count as empty before (a first install creates the lockfile). */
export function diffSnapshots(before, after) {
  const changes = new Map();
  for (const [source, now] of Object.entries(after)) {
    const was = before[source] ?? {};
    const firstRead = !(source in before);
    for (const [name, entry] of Object.entries(now)) {
      const old = was[name];
      if (old && old.v === entry.v) continue;
      if (!changes.has(name)) changes.set(name, {name, from: old?.v ?? null, to: entry.v, pub: entry.pub ?? null, at: entry.at ?? null, firstRead});
    }
  }
  return [...changes.values()];
}

// ---- deciding what is worth saying ----

const excluded = (name, env) => String(env.CAIRN_WATCH_EXCLUDE ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).some((prefix) => name.startsWith(prefix));

/**
 * The events for one finished install. `changes` come from diffSnapshots (and, where no source could be read, from the installer's
 * own output); `releasedAt(name, version)` gives a publish time or null. Every name and version has already passed the shape checks.
 */
export async function detect({install, changes, env = {}, releasedAt = null, installed = null, now = Date.now()}) {
  const events = [];
  const byName = new Map(changes.map((change) => [change.name, change]));
  const requested = requestedVersions(install);
  for (const change of changes) {
    if (!change.from || compare(change.to, change.from) >= 0) continue;
    // The version the command itself asked for is not news, even when it is lower.
    if (requested.some((ask) => ask.name === change.name && ask.version && compare(ask.version, change.to) === 0)) continue;
    // A lower patch or minor is written to the local log only (quiet): the agent is told about a lower major.
    events.push(majorWentDown(change.from, change.to) ? {kind: "major_downgrade", name: change.name, from: change.from, to: change.to} : {kind: "minor_downgrade", name: change.name, from: change.from, to: change.to, quiet: true});
  }
  for (const ask of requested) {
    const got = byName.get(ask.name)?.to ?? installed?.get(ask.name) ?? null;
    if (ask.version && got && compare(got, ask.version) !== 0 && !events.some((e) => e.name === ask.name && !e.quiet)) events.push({kind: "requested_mismatch", name: ask.name, asked: ask.version, to: got});
  }
  // Freshness: the packages named on the command line first, then upgrades; never the whole tree of a first install.
  const named = requested.map((ask) => byName.get(ask.name)).filter(Boolean);
  const upgrades = changes.filter((change) => change.from && compare(change.to, change.from) > 0 && !named.includes(change));
  const candidates = [...named, ...(changes.length <= 40 ? upgrades : [])].slice(0, MAX_FRESH_CHECKS);
  const deadline = now + FRESH_BUDGET_MS;
  await Promise.all(candidates.map(async (change) => {
    let at = change.at;
    if (!at && releasedAt && change.pub !== false && !excluded(change.name, env)) {
      at = await Promise.race([releasedAt(change.name, change.to).catch(() => null), new Promise((done) => { setTimeout(() => done(null), Math.max(0, deadline - Date.now())).unref?.(); })]);
    }
    const age = at ? (now - Date.parse(at)) / DAY : NaN;
    if (age >= 0 && age <= FRESH_DAYS) events.push({kind: "fresh_release", name: change.name, to: change.to, days: Math.floor(age)});
  }));
  for (const event of events) {
    const change = byName.get(event.name);
    // Only a package known to come from the public registry may ever be named to Cairn. Unknown origin (pip without a lockfile) is
    // allowed unless the owner listed its prefix; a private registry, a path, a git URL or a listed prefix never is.
    event.sendable = change?.pub !== false && !excluded(event.name, env);
  }
  return events;
}

/** The release time of one version from the public registry. npm has a small document with a date only for the latest release. */
export function registryReleasedAt(ecosystem, fetchImpl) {
  const get = async (url) => { const r = await fetchImpl(url, {headers: {accept: "application/json", "user-agent": "cairn-install-watch"}, signal: AbortSignal.timeout(FRESH_BUDGET_MS)}); return r.ok ? r.json() : null; };
  return async (name, version) => {
    if (ecosystem === "pypi") {
      const doc = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
      return (doc?.urls ?? []).map((file) => file.upload_time_iso_8601).filter(Boolean).sort()[0] ?? null;
    }
    const doc = await get(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`);
    const hit = (doc?.objects ?? []).find((o) => o.package?.name === name && o.package?.version === version);
    return hit?.package?.date ?? null;
  };
}

/** At most ten lines, built only from package names, versions and fixed sentences. */
export function renderEvents(events, {cairnAsked}) {
  events = events.filter((event) => !event.quiet);
  if (!events.length) return "";
  const lines = ["Check before you go on: the install exited 0, but the dependency state changed in a way the installer does not report as an error."];
  for (const event of events.slice(0, 6)) {
    if (event.kind === "major_downgrade") lines.push(`- ${event.name}: ${event.from} -> ${event.to} (major version went DOWN)`);
    else if (event.kind === "requested_mismatch") lines.push(`- ${event.name}: you asked for ${event.asked}, ${event.to} is installed`);
    else if (event.kind === "fresh_release") lines.push(`- ${event.name} ${event.to} was published ${event.days} day(s) ago: its breaking changes may be newer than your training data`);
    else if (event.kind === "downgraded") lines.push(`- ${event.name}: ${event.from} -> ${event.to} (downgraded)`);
    else if (event.kind === "behind_latest") lines.push(`- ${event.name}: resolved ${event.got}, latest release is ${event.latest} (a lower major, not pinned by you)`);
  }
  if (events.length > 6) lines.push(`- and ${events.length - 6} more`);
  if (events.some((e) => e.kind !== "fresh_release")) lines.push("Find what caps it: install the newer version by itself with the same command and read the conflict, or run the resolver in dry-run mode.");
  if (!cairnAsked) lines.push("Cairn Commons was not asked (detect-only mode); this is what the lockfile or environment shows, not a verdict.");
  return lines.join("\n");
}

// ---- the hook steps ----

const stateFile = (input) => {
  const id = String(input.tool_use_id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || createHash("sha256").update(`${input.session_id ?? ""}\n${input.tool_input?.command ?? ""}`).digest("hex").slice(0, 24);
  return join(tmpdir(), `cairn-watch-${id}.json`);
};

export function watchLog(env, event) {
  // No home folder in the environment (a test, a stripped sandbox): nowhere of the user's own to write, so nothing is written.
  const home = env.HOME || env.USERPROFILE;
  const file = env.CAIRN_WATCH_LOG || (home ? join(home, ".cairn", "install-watch.jsonl") : null);
  if (!file) return;
  try { mkdirSync(dirname(file), {recursive: true}); appendFileSync(file, `${JSON.stringify({t: new Date().toISOString(), ...event})}\n`); } catch { /* the log is best effort */ }
}

export const watchMode = (env) => { const mode = String(env.CAIRN_WATCH ?? "lookup").toLowerCase(); return ["lookup", "detect", "log", "off"].includes(mode) ? mode : "lookup"; };

/** PreToolUse: remember the dependency state. Prints nothing, reads no network. */
export function before(input, env = {}) {
  const install = installCommand(input.tool_input?.command, input.cwd);
  if (!install) return false;
  try { writeFileSync(stateFile(input), JSON.stringify({at: Date.now(), sources: snapshot(install, env)})); } catch { /* without a "before" the output of the installer is used */ }
  return true;
}

/**
 * PostToolUse: compare with the remembered state. Returns {install, events, changed, hadBefore}; `events` is empty when nothing
 * was detected. `fallback(install)` supplies changes read from the installer's output when no source could be read.
 */
export async function after(input, env = {}, {fetchImpl = globalThis.fetch, fallback = null, now = Date.now()} = {}) {
  const install = installCommand(input.tool_input?.command, input.cwd);
  if (!install) return null;
  const file = stateFile(input);
  let saved = null;
  try { saved = JSON.parse(readFileSync(file, "utf8")); rmSync(file, {force: true}); } catch { /* no PreToolUse hook ran */ }
  const sourcesAfter = snapshot(install, env);
  let changes = saved ? diffSnapshots(saved.sources ?? {}, sourcesAfter) : [];
  let from = saved ? "snapshot" : "none";
  if (!changes.length && fallback && (!saved || !Object.keys(sourcesAfter).length)) { changes = fallback(install) ?? []; if (changes.length) from = "output"; }
  changes = changes.filter((change) => okName(install.ecosystem, change.name) && VERSION.test(change.to) && (!change.from || VERSION.test(change.from)));
  if (!changes.length) return {install, events: [], changes: [], changed: 0, from};
  const releasedAt = String(env.CAIRN_WATCH_FRESH ?? "").toLowerCase() === "off" || !fetchImpl ? null : registryReleasedAt(install.ecosystem, fetchImpl);
  const installed = new Map();
  for (const state of Object.values(sourcesAfter)) for (const [name, entry] of Object.entries(state)) if (!installed.has(name)) installed.set(name, entry.v);
  const events = await detect({install, changes, env, releasedAt, installed, now});
  return {install, events, changes, changed: changes.length, from, runtime: runtimeOf(install, sourcesAfter, env)};
}

/** The runtime the install ran for, when it can be told without starting a process: the virtual environment's Python, or this Node. */
function runtimeOf(install, sources, env) {
  if (install.ecosystem === "npm") return `node ${process.versions.node}`;
  const site = "site-packages" in sources ? sitePackagesOf(install, env) : null;
  const python = site?.match(/python(\d+\.\d+)[\\/]site-packages$/)?.[1];
  return python ? `python ${python}` : null;
}

// ---- Cairn's verdicts ----

const ENUM = {
  verdict: ["known_problem", "known_problem_computed", "fixed", "no_problem_found", "no_record"], kind: ["silent_downgrade", "resolve_error", "runtime_break", "behavior_change"],
  status: ["broken", "fixed", "works", "mixed"], evidence: ["verified", "computed"], forced: ["runtime_break", "works", "not_tested"], advisory: ["yes", "no", "unchecked"],
};
const LOOSE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/** What to ask Cairn about: the packages of the detected events and the packages named on the command line that changed. Only sendable ones. */
export function verdictAsks(watched, env = {}) {
  const asks = new Map();
  const add = (name, version) => { if (name && version && !asks.has(name) && !excluded(name, env)) asks.set(name, {name, version}); };
  for (const event of watched.events) if (event.sendable && !event.quiet) add(event.name, event.to ?? event.got);
  const changed = new Map((watched.changes ?? []).map((change) => [change.name, change]));
  for (const ask of requestedVersions(watched.install)) { const change = changed.get(ask.name); if (change && change.pub !== false) add(change.name, change.to); }
  return [...asks.values()].slice(0, 10);
}

/**
 * Lines for the agent from a /api/verdicts response. Built here from the record's fields, each checked against its shape again:
 * the response's own sentences are not used, so nothing but names, versions and listed words can reach the agent.
 */
export function renderVerdicts(response, base) {
  const lines = [];
  let none = 0;
  for (const result of Array.isArray(response?.results) ? response.results.slice(0, 10) : []) {
    if (!ENUM.verdict.includes(result?.verdict)) continue;
    if (result.verdict === "no_record") { none += 1; continue; }
    const r = Array.isArray(result.records) ? result.records[0] : null;
    const name = (v) => (typeof v === "string" && LOOSE_NAME.test(v) && v.length <= 214 ? v : null), ver = (v) => (typeof v === "string" && VERSION.test(v) ? v : null);
    if (!r || !name(r.package) || !ver(r.version) || !ENUM.kind.includes(r.kind) || !ENUM.status.includes(r.status) || !ENUM.evidence.includes(r.evidence)) continue;
    const partner = name(r.counterpart) ? `${r.counterpart}${ver(r.counterpart_version) ? ` ${r.counterpart_version}` : ""}` : null;
    const level = r.evidence === "verified" ? "verified by Cairn" : "computed from registry metadata, NOT run";
    let what;
    if (r.status === "fixed") what = `was broken${partner ? ` with ${partner}` : ""}, now fixed${name(r.fixed_in?.package) && ver(r.fixed_in?.version) ? ` by ${r.fixed_in.package} ${r.fixed_in.version}` : ""}`;
    else if (r.status === "works") what = `no problem found${partner ? ` with ${partner}` : ""} in a limited check (not a safety claim)`;
    else if (r.kind === "silent_downgrade") what = `exits 0 but ${name(r.counterpart) ?? "a dependent"} resolves to ${ver(r.counterpart_resolves_to) ?? "an older version"}`;
    else if (r.kind === "resolve_error") what = `the install is refused together with ${partner ?? "a dependent"}`;
    else if (r.kind === "runtime_break") what = `installs but breaks at run time${partner ? ` with ${partner}` : ""}`;
    else what = `behaves differently${partner ? ` with ${partner}` : ""} without an error`;
    let line = `- Cairn record: ${r.package} ${r.version}: ${what} (${level}${r.status === "mixed" ? "; results differ by environment" : ""}).`;
    if (r.status === "broken" || r.status === "mixed") {
      if (r.forced_install === "runtime_break") line += " Forcing the install breaks at run time.";
      if (r.forced_install === "works") line += " Forcing ran like the pin in a limited probe.";
      if (r.evidence === "verified" && name(r.safe_pin?.package) && ver(r.safe_pin?.version)) line += ` Tested pin: ${r.safe_pin.package} ${r.safe_pin.version}${r.safe_pin.advisory === "yes" ? " (WARNING: known security advisory on this version)" : r.safe_pin.advisory === "no" ? "" : " (advisories not checked)"}.`;
    }
    if (r.stale === true) line += " Checked over 14 days ago; may have changed.";
    const reports = Number.isInteger(r.community?.reports) && ["reproduced", "not_reproduced", "conditional"].includes(r.community?.outcome) ? r.community : null;
    if (reports) line += ` ${reports.reports} other agents report "${reports.outcome.replace(/_/g, " ")}" (unverified).`;
    if (typeof r.note_url === "string" && new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/post/[A-Za-z0-9-]{8,80}$`).test(r.note_url)) line += ` Evidence: ${r.note_url}`;
    // Two packages of one install often lead to the same record (the release and the partner it pulls down): say it once.
    if (!lines.includes(line)) lines.push(line);
    if (lines.length >= 3) break;
  }
  if (!lines.length && none) lines.push("- Cairn Commons has no record for these versions. That is not a safety claim: nothing was checked.");
  return {text: lines.join("\n"), records: lines.length && !(none && lines[0].includes("no record")) ? lines.length : 0};
}

/** The observation an opted-in hook sends: public package names, versions, the package manager and the environment. Nothing else. */
export function observationOf(watched, extraEvents = []) {
  const events = [...watched.events.filter((e) => e.sendable && !e.quiet && ["major_downgrade", "requested_mismatch", "fresh_release"].includes(e.kind)).map((e) => ({kind: e.kind, name: e.name, from: e.from ?? null, to: e.to})), ...extraEvents].slice(0, 20);
  if (!events.length) return null;
  const cpu = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : null;
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null;
  return {package_manager: watched.install.tool, ...(os ? {os} : {}), ...(cpu ? {cpu} : {}), ...(watched.runtime ? {runtime: watched.runtime} : {}), events};
}

/** Counts from the local log: how many installs were seen and how often each kind of detection fired. */
export function summarizeLog(text) {
  // told = the agent was told something; with_record = of those, Cairn had a verdict record for it (the main measure of use).
  const out = {installs: 0, with_detection: 0, told: 0, with_record: 0, failures: 0, kinds: {}, by_tool: {}, first: null, last: null, packages: {}};
  for (const line of String(text).split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.event !== "install" && row.event !== "install_failure") continue;
    out.first ??= row.t; out.last = row.t;
    out.installs += 1;
    out.by_tool[row.tool] = (out.by_tool[row.tool] ?? 0) + 1;
    if (row.event === "install_failure") { out.failures += 1; out.kinds.install_failure = (out.kinds.install_failure ?? 0) + 1; continue; }
    if (row.events?.some((event) => !event.quiet)) out.with_detection += 1;
    if (row.emitted) out.told += 1;
    if (row.emitted && row.verdict_records > 0) out.with_record += 1;
    for (const event of row.events ?? []) {
      out.kinds[event.kind] = (out.kinds[event.kind] ?? 0) + 1;
      const key = `${event.name} ${event.to ?? ""}`.trim();
      out.packages[key] = (out.packages[key] ?? 0) + 1;
    }
  }
  return out;
}
