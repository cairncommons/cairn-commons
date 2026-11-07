// cairn_check_dependencies: before an agent adds or upgrades dependencies, tell it per package whether Cairn holds a checked record of a
// problem with that version, what the record says to do (its verdict lines), and how fresh the release is. It never says a version is
// safe: "no record" only means Cairn has not seen a problem. A record older than RECHECK_DAYS is marked for recheck, because a break
// can be fixed by a later release of the other side (a note saying "broken" that is no longer true would send the agent to a needless pin).

type Reader = {read(path: string): Promise<Record<string, unknown>>};
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type Ecosystem = "npm" | "pypi";
export type PackageAsk = {name: string; version?: string};

const RECHECK_DAYS = 14;
const VERDICT = /^(Status|Cause|Fixed in|Workaround|Checked):\s*(.+)$/gm;
const DAY = 86400000;

export function verdictLines(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const head = String(body ?? "").split("\n\n")[0];
  for (const m of head.matchAll(VERDICT)) out[m[1].toLowerCase().replace(" ", "_")] = m[2].trim();
  return out;
}

const PRERELEASE = /(a|b|rc|dev|alpha|beta|pre)\.?\d*$/i;

/**
 * The latest release and the release time of the requested (or latest) version, from the registry. Null when it cannot be read.
 * Only small documents are read, because this also runs in the hosted MCP on Cloudflare Workers: a full npm packument is 15 MB for
 * typescript and 30 MB for next, and PyPI's project JSON is 3 MB for boto3. npm: `/<name>/latest` and `/<name>/<version>` (a few KB)
 * and the search API's publish date of the latest release (npm has no small document with the date of an older version, so that one
 * stays unknown); PyPI: the project's release RSS (latest 40 releases with dates) and `/pypi/<name>/<version>/json`.
 */
export async function registryInfo(ecosystem: Ecosystem, name: string, version: string | undefined, fetcher: Fetcher) {
  const signal = AbortSignal.timeout(5000);
  const headers = {"user-agent": "cairn-mcp/check-dependencies", accept: "application/json"};
  const json = async (url: string) => { const r = await fetcher(url, {headers, signal}); return r.ok ? r.json() as Promise<Record<string, unknown>> : null; };
  if (ecosystem === "pypi") {
    const rss = await fetcher(`https://pypi.org/rss/project/${encodeURIComponent(name)}/releases.xml`, {headers: {...headers, accept: "application/rss+xml"}, signal});
    const items = rss.ok ? [...(await rss.text()).matchAll(/<item>\s*<title>([^<]+)<\/title>[\s\S]*?<pubDate>([^<]+)<\/pubDate>/g)].map((m) => ({version: m[1].trim(), date: new Date(m[2]).toISOString()})) : [];
    const latest = items.find((i) => !PRERELEASE.test(i.version))?.version ?? items[0]?.version ?? null;
    const v = version ?? latest;
    if (!v) return null;
    const d = await json(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(v)}/json`) as {urls?: {upload_time_iso_8601?: string; yanked?: boolean}[]} | null;
    const files = d?.urls ?? [];
    const released = files.map((f) => f.upload_time_iso_8601).filter(Boolean).sort()[0] ?? items.find((i) => i.version === v)?.date ?? null;
    return {latest, version: v, released, exists: Boolean(d), yanked: files.length > 0 && files.every((f) => f.yanked)};
  }
  const enc = name.replace("/", "%2F");
  const latestDoc = await json(`https://registry.npmjs.org/${enc}/latest`) as {version?: string; deprecated?: string} | null;
  if (!latestDoc) return null;
  const latest = latestDoc.version ?? null;
  const v = version ?? latest;
  const doc = v && v !== latest ? await json(`https://registry.npmjs.org/${enc}/${encodeURIComponent(v)}`) as {deprecated?: string} | null : latestDoc;
  let released: string | null = null;
  if (v && v === latest) {
    const s = await json(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`) as {objects?: {package?: {name?: string; version?: string; date?: string}}[]} | null;
    const hit = s?.objects?.find((o) => o.package?.name === name && o.package?.version === v);
    released = hit?.package?.date ?? null;
  }
  return {latest, version: v, released, exists: Boolean(doc), deprecated: doc?.deprecated || null};
}

type Note = {id: string; title: string; version?: string; version_match?: string; evidence_level?: string; outcome?: string; created_at?: string; web_url?: string; glance?: string};

export async function checkDependencies(client: Reader, ecosystem: Ecosystem, packages: PackageAsk[], fetcher: Fetcher = fetch, now = new Date()) {
  const rows = await Promise.all(packages.map(async (ask) => {
    const params = new URLSearchParams({package: ask.name, compact: "1", limit: "5", ...(ask.version ? {version: ask.version} : {})});
    const [search, related, registry] = await Promise.all([
      client.read(`search?${params}`).catch(() => null),
      // Records filed under another package that name this one (a partner that blocks it, or that it blocks).
      client.read(`search?${new URLSearchParams({q: ask.name, compact: "1", limit: "5"})}`).catch(() => null),
      registryInfo(ecosystem, ask.name, ask.version, fetcher).catch(() => null),
    ]);
    const results = ((search?.results as Note[] | undefined) ?? []).filter((r) => r && r.id);
    const rank = (r: Note) => (r.version_match === "same" ? 0 : r.version_match === "other" ? 1 : 2);
    const evidence = (r: Note) => (/^(conditionally_)?reproduced$/.test(r.outcome ?? "") ? 0 : /^not_reproduced/.test(r.outcome ?? "") ? 1 : 2);
    results.sort((a, b) => rank(a) - rank(b) || evidence(a) - evidence(b) || String(b.created_at).localeCompare(String(a.created_at)));
    const lead = results[0];
    let verdict: Record<string, string> = {};
    if (lead) {
      const post = await client.read(`posts/${lead.id}?include_comments=false`).catch(() => null) as {body?: string; post?: {body?: string}} | null;
      verdict = verdictLines(post?.body ?? post?.post?.body);
    }
    const version = ask.version ?? registry?.version ?? null;
    const releasedDays = registry?.released ? Math.floor((now.getTime() - Date.parse(registry.released)) / DAY) : null;
    const noteDays = lead?.created_at ? Math.floor((now.getTime() - Date.parse(lead.created_at)) / DAY) : null;
    const problem = Boolean(lead && evidence(lead) === 0);
    const status = !lead ? "no_cairn_record"
      : problem && lead.version_match === "same" ? "known_problem"
      : problem ? "known_problem_other_version"
      : evidence(lead) === 1 && lead.version_match === "same" ? "checked_no_problem_found"
      : "record_not_tested";
    const advice: string[] = [];
    if (status === "known_problem") advice.push(`Known problem on ${ask.name} ${version}${verdict.workaround ? `; workaround: ${verdict.workaround}` : ""}${verdict.fixed_in && !/not established/i.test(verdict.fixed_in) ? `; fixed in: ${verdict.fixed_in}` : ""}.`);
    if (status === "known_problem_other_version") advice.push(`Cairn has a problem record for ${ask.name} ${lead!.version ?? "another version"}, not ${version ?? "this version"}: read it and check whether it applies.`);
    if (status === "checked_no_problem_found") advice.push("A limited check found no problem; this is not a safety claim.");
    if (status === "record_not_tested") advice.push("Cairn has a record for this package that was not independently tested (source reading only, or another version): read it before relying on it.");
    if (status === "no_cairn_record") advice.push("Cairn has no record for this package and version. That is not a safety claim.");
    if (noteDays !== null && noteDays > RECHECK_DAYS) advice.push(`The record is ${noteDays} days old: a later release of either side may have changed this; check the latest versions before pinning.`);
    if (releasedDays !== null && registry?.released) advice.push(`Released ${registry.released.slice(0, 10)} (${releasedDays} day(s) ago): if that is after your training data, you do not know its breaking changes.`);
    const word = new RegExp(`(^|[^\\w@/-])${ask.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w/-]|$)`, "i");
    const others = ((related?.results as Note[] | undefined) ?? []).filter((r) => r && r.id && !results.some((x) => x.id === r.id) && word.test(r.title ?? "") && r.outcome === "reproduced").slice(0, 3);
    if (others.length) advice.push(`Related checked records that name ${ask.name}: ${others.map((r) => `${r.title} (${r.web_url ?? r.id})`).join("; ")}.`);
    if (registry && registry.exists === false && version) advice.push(`${ask.name} ${version} is not on the ${ecosystem} registry.`);
    if (registry && "deprecated" in registry && registry.deprecated) advice.push(`Deprecated on npm: ${registry.deprecated}`);
    if (registry && "yanked" in registry && registry.yanked) advice.push(`${ask.name} ${version} is yanked on PyPI.`);
    if (registry?.latest && version && registry.latest !== version) advice.push(`Latest release is ${registry.latest}.`);
    return {
      package: ask.name, version, status, released: registry?.released ?? null, released_days_ago: releasedDays, latest: registry?.latest ?? null,
      verdict, advice,
      notes: results.slice(0, 3).map((r) => ({title: r.title, version: r.version ?? null, version_match: r.version_match ?? null, evidence_level: r.evidence_level ?? null, outcome: r.outcome ?? null, checked: r.created_at ?? null, url: r.web_url ?? null})),
    };
  }));
  const problems = rows.filter((r) => r.status === "known_problem").length;
  return {
    ecosystem,
    summary: problems ? `${problems} of ${rows.length} package(s) have a checked problem record for the version asked. Read the verdict and workaround before installing.` : `No checked problem record for the versions asked (${rows.length} package(s)). This is not a safety claim; after installing, check that nothing resolved older than you asked.`,
    packages: rows,
  };
}
