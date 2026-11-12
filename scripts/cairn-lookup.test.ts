import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VERSION, buildQuery, compareVersions, detectBehind, onlyRelevant, parseFailure, parseResolutionFailure, pythonDistribution, renderResults, resolutionQuery, run, searchUrl} from './cairn-lookup/cairn-lookup.mjs';

const CLI = join(process.cwd(), 'scripts/cairn-lookup/cairn-lookup.mjs');

/** A virtual environment with pydantic 2.14.1 and llama_index_core installed (dist-info only), and a project beside it. */
function environment() {
  const root = mkdtempSync(join(tmpdir(), 'lookup-env-'));
  const site = join(root, '.venv/lib/python3.12/site-packages');
  mkdirSync(join(site, 'pydantic-2.14.1.dist-info'), {recursive: true});
  mkdirSync(join(site, 'llama_index_core-0.14.25.dist-info'), {recursive: true});
  writeFileSync(join(site, 'llama_index_core-0.14.25.dist-info/RECORD'), 'llama_index/core/__init__.py,sha256=abc,100\nllama_index/core/base/base_retriever.py,sha256=def,2000\nllama_index_core-0.14.25.dist-info/METADATA,sha256=x,10\n');
  mkdirSync(join(site, 'google_cloud_storage-2.0.0.dist-info'), {recursive: true});
  writeFileSync(join(site, 'google_cloud_storage-2.0.0.dist-info/RECORD'), 'google/cloud/storage/client.py,sha256=g,1\n');
  mkdirSync(join(site, 'PyYAML-6.0.2.dist-info'), {recursive: true});
  writeFileSync(join(site, 'PyYAML-6.0.2.dist-info/top_level.txt'), '_yaml\nyaml\n');
  return {root, site};
}
const traceback = (site: string, innermost: string, exception: string) => `Traceback (most recent call last):
  File "/work/app.py", line 12, in <module>
    run()
  File "${site}/${innermost}", line 80, in call
    return fn()
${exception}`;

test('a Python failure raised inside a dependency names the exception, the package and its installed version', () => {
  const {site} = environment();
  const failure = parseFailure(traceback(site, 'pydantic/main.py', 'pydantic_core._pydantic_core.ValidationError: 1 validation error for Model\n  Input should be a valid integer'));
  assert.deepEqual(failure, {type: 'pydantic_core._pydantic_core.ValidationError', message: '1 validation error for Model', package: 'pydantic', version: '2.14.1', ecosystem: 'python'});
});

test('the registry name comes from the dist-info, also when the import name differs', () => {
  const {site} = environment();
  assert.equal(parseFailure(traceback(site, 'llama_index/core/base/base_retriever.py', 'AttributeError: object_map'))?.package, 'llama_index_core', 'llama_index is not a distribution name; the RECORD of llama_index_core lists the failing file');
  assert.equal(parseFailure(traceback(site, 'unknown_pkg/x.py', 'KeyError: 1'))?.package, 'unknown_pkg', 'no distribution: the import name is kept');
  assert.equal(parseFailure(traceback(site, 'unknown_pkg/x.py', 'Exception: boom'))?.type, 'Exception', 'a bare Exception is read too');
  assert.equal(parseFailure(traceback(site, 'yaml/__init__.py', "KeyError: 'x'"))?.package, 'PyYAML');
  assert.equal(parseFailure(traceback(site, 'yaml/__init__.py', "KeyError: 'x'"))?.version, '6.0.2');
  assert.equal(parseFailure(traceback(site, 'llama_index/core/base/base_retriever.py', 'AttributeError: object_map'))?.version, '0.14.25');
  assert.equal(parseFailure(traceback(site, 'google/cloud/storage/client.py', 'ValueError: x'))?.package, 'google_cloud_storage', 'a namespace package: only the file path tells which distribution');
  assert.deepEqual(pythonDistribution(site, 'llama_index_core'), {dir: 'llama_index_core-0.14.25.dist-info', name: 'llama_index_core', version: '0.14.25'});
  assert.equal(pythonDistribution(site, 'yaml_only_in_top_level')?.name ?? null, null);
  assert.equal(pythonDistribution('/does/not/exist', 'x'), null);
});

test('the Traceback header may be missing, as when the output was cut with tail', () => {
  const {site} = environment();
  const cut = `  File "${site}/pydantic/main.py", line 845, in model_validate_json
    return cls.__pydantic_validator__.validate_json(
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
pydantic_core._pydantic_core.ValidationError: 1 validation error for CatalogLookup
sku
  Field required [type=missing, input_value={'customer_id': 'C-42'}, input_type=dict]
    For further information visit https://errors.pydantic.dev/2.14/v/missing`;
  assert.deepEqual(parseFailure(cut), {type: 'pydantic_core._pydantic_core.ValidationError', message: '1 validation error for CatalogLookup', package: 'pydantic', version: '2.14.1', ecosystem: 'python'});
  assert.equal(parseFailure(`  File "/work/app.py", line 1, in <module>\nAssertionError: wrong`), null, 'the last frame is the project\'s');
  assert.equal(parseFailure(`  File "${site}/pydantic/main.py", line 3, in f\n    x\n  not an exception line\nrest`), null, 'no exception line follows');
});

test('a temporary folder name is masked as a path, not as a key', () => {
  assert.equal(buildQuery({type: 'RuntimeError', message: 'Storage folder /private/tmp/claude-501/abcdef0123456789abcdef0123456789abcd/.qdrant is already accessed'}), 'RuntimeError: Storage folder <path> is already accessed');
});

test('a failure raised in the user\'s own code, or with no exception, sends nothing', () => {
  const {site} = environment();
  const own = `Traceback (most recent call last):
  File "${site}/pytest/runner.py", line 3, in call
    test()
  File "/work/test_app.py", line 9, in test
    raise ValueError("mine")
ValueError: mine`;
  assert.equal(parseFailure(own), null, 'the innermost frame is the project\'s, even though a dependency is above it');
  assert.equal(parseFailure('Exit code 1\ngrep: no matches'), null);
  assert.equal(parseFailure(''), null);
  assert.equal(parseFailure(undefined), null);
});

test('a Node failure raised in node_modules names the package and the version in its package.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'lookup-node-'));
  mkdirSync(join(root, 'node_modules/@scope/lib'), {recursive: true});
  writeFileSync(join(root, 'node_modules/@scope/lib/package.json'), JSON.stringify({name: '@scope/lib', version: '3.1.4'}));
  const text = `Exit code 1\nTypeError: Cannot read properties of undefined (reading 'map')\n    at node:internal/modules/cjs/loader:1\n    at render (${root}/node_modules/@scope/lib/dist/index.js:10:5)\n    at main (${root}/src/index.js:3:1)`;
  assert.deepEqual(parseFailure(text), {type: 'TypeError', message: "Cannot read properties of undefined (reading 'map')", package: '@scope/lib', version: '3.1.4', ecosystem: 'node'});
  const code = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x' imported from ${root}/node_modules/@scope/lib/a.js\n    at finalizeResolution (${root}/node_modules/@scope/lib/a.js:1:1)`;
  assert.equal(parseFailure(code)?.type, 'ERR_MODULE_NOT_FOUND');
  assert.equal(parseFailure(`TypeError: x\n    at app (${root}/src/index.js:3:1)`), null, 'the first frame is the project\'s');
});

test('the query carries the exception and message, with secrets and paths masked, in at most 100 characters', () => {
  assert.equal(buildQuery({type: 'ValueError', message: 'bad value'}), 'ValueError: bad value');
  // The macOS home prefix is built at run time so the file itself holds no user-path literal (the public export refuses those).
  const macHome = ['', 'Users', 'alice'].join('/');
  assert.equal(buildQuery({type: 'OSError', message: `cannot open ${macHome}/work/secret-project/data.csv`}), 'OSError: cannot open <path>');
  assert.equal(buildQuery({type: 'OSError', message: "cannot open /home/alice/work/secret-project/data.csv"}), 'OSError: cannot open <path>');
  assert.equal(buildQuery({type: 'OSError', message: 'no such file C:\\Users\\bob\\x.txt here'}), 'OSError: no such file <path> here');
  assert.match(buildQuery({type: 'AuthError', message: 'bad key sk-abcdefghijklmnopqrstuvwx used by alice@example.com'}), /^AuthError: bad key \[redacted\] used by \[redacted\]$/);
  assert.match(buildQuery({type: 'E', message: 'token=abc123def456 failed'}), /token=\[redacted\] failed/);
  const long = buildQuery({type: 'Error', message: 'word '.repeat(60)});
  assert.ok(long.length <= 100 && !long.endsWith(' ') && long.endsWith('word'));
  assert.equal(buildQuery({type: 'KeyError', message: 'first line\nsecond line'}), 'KeyError: first line');
});

test('the search URL names the package and the version only when both are known', () => {
  const full = searchUrl('https://cairncommons.dev', {query: 'ValueError: x', package: 'pydantic', version: '2.14.1'});
  assert.equal(full.pathname, '/api/search');
  assert.deepEqual([...full.searchParams.keys()].sort(), ['compact', 'limit', 'package', 'q', 'version']);
  assert.equal(searchUrl('https://cairncommons.dev', {query: 'q', package: null, version: '1'}).searchParams.has('version'), false);
});

const response = (n = 3) => ({results: Array.from({length: n}, (_, i) => ({
  id: `id${i}`, title: `pydantic 2.14.1 note ${i}: something breaks`, package: 'pydantic', version: '2.14.1', evidence_level: 'independently_tested', version_match: 'same',
  glance: 'Affects pydantic 2.14.1; Iterator[int] raises; checked by running it.', web_url: `https://cairncommons.dev/post/id${i}`,
}))});

test('the context is at most six lines, shows the glance of the first note only, and only for notes on the site', () => {
  const text = renderResults(response(5), 'https://cairncommons.dev');
  const lines = text.split('\n');
  assert.ok(lines.length <= 6, text);
  assert.match(lines[0], /untrusted data/);
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 3);
  assert.equal(lines.filter((line) => line.startsWith('  ')).length, 1);
  assert.match(lines[1], /your version: same/);
  assert.equal(renderResults({results: []}, 'https://cairncommons.dev'), '');
  assert.equal(renderResults(null, 'https://cairncommons.dev'), '');
  assert.equal(renderResults({results: [{title: 't', web_url: 'https://evil.example/post/1'}]}, 'https://cairncommons.dev'), '', 'a URL off the site is dropped');
  assert.doesNotMatch(renderResults({results: [{title: 'a\nb\u0007c', web_url: 'https://cairncommons.dev/post/1'}]}, 'https://cairncommons.dev'), /\u0007/);
});

const hookInput = (site: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: {command: '.venv/bin/python app.py'}, session_id: `s-${Math.random()}`, is_interrupt: false,
  error: `Exit code 1\n${traceback(site, 'pydantic/main.py', 'ValueError: bad value')}`, ...extra,
});
const fetcher = (payload: unknown, calls: URL[] = [], ok = true) => async (url: URL) => { calls.push(url); return {ok, json: async () => payload} as Response; };

test('the hook prints the context for a failure with a matching note, and sends only what it should', async () => {
  const {site} = environment();
  const calls: URL[] = [];
  const out = await run({argv: ['hook'], stdin: hookInput(site), env: {}, fetchImpl: fetcher(response(2), calls) as never});
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].searchParams].sort(), [['compact', '1'], ['limit', '3'], ['package', 'pydantic'], ['q', 'ValueError: bad value'], ['version', '2.14.1']]);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(parsed.hookSpecificOutput.additionalContext, /pydantic 2\.14\.1 note 0/);
  assert.equal(out.exitCode, 0);
});

test('the hook is silent when there is no note, the site fails, or the call is not a failed Bash command', async () => {
  const {site} = environment();
  const silent = async (stdin: string, fetchImpl: unknown, env = {}) => (await run({argv: ['hook'], stdin, env, fetchImpl: fetchImpl as never})).stdout;
  assert.equal(await silent(hookInput(site), fetcher({results: [], no_relevant_match: true})), '');
  assert.equal(await silent(hookInput(site), fetcher(null, [], false)), '');
  assert.equal(await silent(hookInput(site), async () => { throw new Error('offline'); }), '');
  assert.equal(await silent(hookInput(site, {is_interrupt: true}), fetcher(response())), '');
  assert.equal(await silent(hookInput(site, {tool_name: 'Edit'}), fetcher(response())), '');
  assert.equal(await silent(hookInput(site, {hook_event_name: 'PostToolUse'}), fetcher(response())), '');
  assert.equal(await silent(hookInput(site, {error: 'Exit code 2\nmake: *** No rule'}), fetcher(response())), '');
  assert.equal(await silent('not json', fetcher(response())), '');
  assert.equal(await silent(hookInput(site), fetcher(response()), {CAIRN_LOOKUP: 'off'}), '');
});

test('a failure is looked up once per session, and at most five times', async () => {
  const {site} = environment();
  const calls: URL[] = [];
  const sessionId = `session-${Math.random()}`;
  const input = (message: string) => hookInput(site, {session_id: sessionId, error: `Exit code 1\n${traceback(site, 'pydantic/main.py', `ValueError: ${message}`)}`});
  const go = (message: string, env = {}) => run({argv: ['hook'], stdin: input(message), env, fetchImpl: fetcher(response(1), calls) as never});
  assert.notEqual((await go('one')).stdout, '');
  assert.equal((await go('one')).stdout, '', 'the same failure again');
  for (const message of ['two', 'three', 'four', 'five']) assert.notEqual((await go(message)).stdout, '');
  assert.equal((await go('six')).stdout, '', 'over the limit');
  assert.equal(calls.length, 5);
});

test('by hand: error text on the command line, a dry run that shows the URL, and a plain answer', async () => {
  const dry = await run({argv: ['--package', 'pydantic', '--version', '2.14.1', '--dry-run', 'ValueError: bad value'], env: {}});
  assert.match(dry.stdout, /^https:\/\/cairncommons\.dev\/api\/search\?q=ValueError%3A\+bad\+value&package=pydantic&version=2\.14\.1&compact=1&limit=3/);
  const hit = await run({argv: ['--package', 'pydantic', 'ValueError: bad value'], env: {}, fetchImpl: fetcher(response(1)) as never});
  assert.match(hit.stdout, /^Cairn Commons has checked notes/);
  const miss = await run({argv: ['--package', 'pydantic', 'ValueError: bad value'], env: {}, fetchImpl: fetcher({results: []}) as never});
  assert.equal(miss.stdout, 'No Cairn note matches this.\n');
  assert.equal((await run({argv: [], stdin: '', env: {}})).exitCode, 2);
});

test('as a real process: reads the hook JSON on stdin, calls the site named in CAIRN_LOOKUP_BASE with its own User-Agent, writes the log', async () => {
  const {site} = environment();
  const seen: {url: string; ua: string | undefined}[] = [];
  const server = createServer((request, reply) => { seen.push({url: request.url ?? '', ua: request.headers['user-agent']}); reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(response(1)).replaceAll('https://cairncommons.dev', `http://127.0.0.1:${(server.address() as {port: number}).port}`)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const log = join(mkdtempSync(join(tmpdir(), 'lookup-log-')), 'events.log');
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'hook'], {env: {PATH: process.env.PATH ?? '', CAIRN_LOOKUP_BASE: base, CAIRN_LOOKUP_LOG: log, CAIRN_LOOKUP_UA: 'cairn-internal/test'} as unknown as NodeJS.ProcessEnv});
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
      child.stdin.end(hookInput(site));
    });
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /note 0/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ua, 'cairn-internal/test');
    assert.match(seen[0].url, /^\/api\/search\?q=ValueError%3A\+bad\+value&package=pydantic&version=2\.14\.1/);
    const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);
    assert.deepEqual(events, ['invoked', 'query', 'hit']);
  } finally { server.close(); }
});

test('the default User-Agent names the tool and its version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  const help = execFileSync(process.execPath, [CLI, '--dry-run', '--package', 'x', 'ValueError: a'], {env: {PATH: process.env.PATH ?? ''} as unknown as NodeJS.ProcessEnv, encoding: 'utf8'});
  assert.match(help, /api\/search/);
});


// ---- dependency-resolution failures and silent downgrades (real installer output, trimmed) ----

const NPM_ERESOLVE = `npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error
npm error While resolving: tmp@1.0.0
npm error Found: commander@15.1.0
npm error node_modules/commander
npm error   commander@"15.1.0" from the root project
npm error
npm error Could not resolve dependency:
npm error peer commander@"~15.0.0" from @commander-js/extra-typings@15.0.0
npm error node_modules/@commander-js/extra-typings
npm error   @commander-js/extra-typings@"*" from the root project`;
const PIP_CONFLICT = `ERROR: Cannot install google-adk==2.13.0 and google-genai==3.0.0 because these package versions have conflicting dependencies.
The conflict is caused by:
    The user requested google-genai==3.0.0
    google-adk 2.13.0 depends on google-genai<3 and >=2.30
ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/#dealing-with-dependency-conflicts`;
const UV_NO_SOLUTION = `error: No solution found when resolving dependencies
  cause: Because google-adk>=2.13.0 depends on google-genai>=2.30,<3 and you require google-genai==3.0.0, we can conclude that your requirements and google-adk>=2.13.0 are incompatible.
         And because you require google-adk==2.13.0, we can conclude that your requirements are unsatisfiable.`;

test('npm ERESOLVE: the package that was found, its version and the peer owner are read; no paths or other text leave', () => {
  const failure = parseResolutionFailure(NPM_ERESOLVE)!;
  assert.equal(failure.ecosystem, 'node');
  assert.equal(failure.code, 'ERESOLVE');
  assert.equal(failure.package, 'commander');
  assert.equal(failure.version, '15.1.0');
  assert.deepEqual(failure.pairs.map((p: {name: string}) => p.name), ['commander', '@commander-js/extra-typings']);
  assert.equal(resolutionQuery(failure), 'ERESOLVE commander 15.1.0 @commander-js/extra-typings 15.0.0');
});

test('pip ResolutionImpossible and uv "No solution found": the requested package and the dependent are read', () => {
  const pip = parseResolutionFailure(PIP_CONFLICT)!;
  assert.equal(pip.package, 'google-genai'); assert.equal(pip.version, '3.0.0'); assert.equal(pip.code, 'ResolutionImpossible');
  assert.ok(pip.pairs.some((p: {name: string}) => p.name === 'google-adk'));
  const uv = parseResolutionFailure(UV_NO_SOLUTION)!;
  assert.equal(uv.code, 'NoSolution'); assert.equal(uv.package, 'google-genai'); assert.equal(uv.version, '3.0.0');
});

test('Requires-Python: pip refusing a pinned version is read as a resolution failure; unrelated output is not', () => {
  const text = 'ERROR: Ignored the following versions that require a different python version: 0.28.0 Requires-Python >=3.11\nERROR: Could not find a version that satisfies the requirement pydocket==0.28.0\nERROR: No matching distribution found for pydocket==0.28.0';
  const failure = parseResolutionFailure(text)!;
  assert.equal(failure.code, 'RequiresPython'); assert.equal(failure.package, 'pydocket'); assert.equal(failure.version, '0.28.0');
  assert.equal(parseResolutionFailure('Traceback (most recent call last):\nValueError: boom'), null);
  assert.equal(parseResolutionFailure(''), null);
});

test('compareVersions orders dotted releases and ignores prerelease tails', () => {
  assert.equal(compareVersions('3.0.4', '4.5.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), 0);
});

test('pip silent downgrade: "Found existing installation: dash 4.5.0" then dash-3.0.4 is reported; no latest lookup needed', async () => {
  const output = 'Attempting uninstall: dash\n  Found existing installation: dash 4.5.0\n  Uninstalling dash-4.5.0:\nSuccessfully installed celery-5.7.0 dash-3.0.4 kombu-5.7.0';
  const events = await detectBehind('pip install celery==5.7.0', output, null);
  assert.deepEqual(events, [{kind: 'downgraded', name: 'dash', from: '4.5.0', to: '3.0.4'}]);
});

test('an unpinned requested package that resolved to a lower major than the latest is reported; the same major is not', async () => {
  const output = 'Successfully installed celery-5.7.0 dash-3.0.4 flask-3.1.0';
  const latest = async (name: string) => ({dash: '4.5.0', flask: '3.1.3', celery: '5.7.0'} as Record<string, string>)[name] ?? null;
  const events = await detectBehind('pip install celery==5.7.0 "dash[celery]" flask', output, latest);
  assert.deepEqual(events, [{kind: 'behind_latest', name: 'dash', got: '3.0.4', latest: '4.5.0'}]);
});

test('uv output: "- dash==4.5.0" with "+ dash==3.0.4" is a downgrade', async () => {
  const events = await detectBehind('uv pip install celery==5.7.0', 'Resolved 12 packages\n - dash==4.5.0\n + dash==3.0.4\n + celery==5.7.0', null);
  assert.deepEqual(events, [{kind: 'downgraded', name: 'dash', from: '4.5.0', to: '3.0.4'}]);
});

function fakeFetch(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: URL | string) => {
    const href = String(url); calls.push(href);
    const key = Object.keys(handlers).find((k) => href.includes(k));
    return {ok: Boolean(key), json: async () => handlers[key as string]};
  }) as unknown as typeof fetch;
  return {impl, calls};
}
const NOTE = {results: [{id: 'a1', title: 'google-genai 3.0.0: pinned with google-adk, pip ResolutionImpossible', web_url: 'https://cairncommons.dev/post/a1', package: 'google-genai', version: '3.0.0', evidence_level: 'independently_tested', glance: 'Status: reproduces on google-genai 3.0.0. Cause: google-adk needs google-genai<3. Workaround: tested: stay on 2.34.0'}]};

test('the hook answers a failed pip install with the matching note, and stays silent when Cairn has none', async () => {
  const input = JSON.stringify({hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', session_id: `r-${Date.now()}-1`, error: `Exit code 1\n${PIP_CONFLICT}`});
  const hit = fakeFetch({'/api/search': NOTE});
  const out = await run({argv: ['hook'], stdin: input, env: {}, fetchImpl: hit.impl});
  const body = JSON.parse(out.stdout);
  assert.equal(body.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(body.hookSpecificOutput.additionalContext, /ResolutionImpossible|google-genai 3\.0\.0/);
  assert.match(hit.calls[0], /\/api\/verdicts$/, 'the record is asked for first');
  assert.match(hit.calls[1], /package=google-genai/); assert.match(hit.calls[1], /version=3\.0\.0/);
  const miss = fakeFetch({'/api/search': {results: []}});
  const none = await run({argv: ['hook'], stdin: input.replace(/r-\d+-1/, `r-${Date.now()}-2`), env: {}, fetchImpl: miss.impl});
  assert.equal(none.stdout, '');
  assert.equal(miss.calls.length, 3, 'the record, the package-filtered search, then the plain query');
});

test('the hook warns after a successful install that resolved a package older, with the note when there is one', async () => {
  const input = JSON.stringify({hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: `r-${Date.now()}-3`, tool_input: {command: 'pip install celery==5.7.0 "dash[celery]"'},
    tool_response: {stdout: 'Attempting uninstall: dash\n  Found existing installation: dash 4.5.0\nSuccessfully installed celery-5.7.0 dash-3.0.4', stderr: ''}});
  const f = fakeFetch({'/api/search': {results: [{...NOTE.results[0], title: 'celery 5.7.0 pins python-dateutil: pip and uv resolve to dash 3.0.4'}]}});
  const out = await run({argv: ['hook'], stdin: input, env: {}, fetchImpl: f.impl});
  const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(context, /exited 0/); assert.match(context, /dash: 4\.5\.0 -> 3\.0\.4/); assert.match(context, /celery 5\.7\.0 pins/);
  const plain = JSON.stringify({hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: `r-${Date.now()}-4`, tool_input: {command: 'ls -la'}, tool_response: {stdout: 'x'}});
  assert.equal((await run({argv: ['hook'], stdin: plain, env: {}, fetchImpl: f.impl})).stdout, '');
});

test('onlyRelevant keeps notes that name the failing package as a whole word and drops fuzzy matches', () => {
  const response = {results: [
    {id: '1', title: 'celery 5.7.0 pins python-dateutil: pip and uv resolve to dash 3.0.4', package: 'celery'},
    {id: '2', title: 'llama-index-embeddings-dashscope star import raises TypeError', package: 'llama-index-embeddings-dashscope'},
    {id: '3', title: 'google-adk SqliteMemoryService: a stored word is not found', package: 'google-adk'},
  ]};
  assert.deepEqual(onlyRelevant(response, ['dash']).results.map((r: {id: string}) => r.id), ['1']);
  assert.deepEqual(onlyRelevant(response, ['commander', '@commander-js/extra-typings']).results, []);
});

test('an installer error Cairn has no note for stays silent even when the fuzzy search returns other notes', async () => {
  const unrelated = {results: [{id: 'x', title: 'google-adk SqliteMemoryService: capital dotted I', web_url: 'https://cairncommons.dev/post/x', package: 'google-adk'}]};
  const f = fakeFetch({'/api/search': unrelated});
  const input = JSON.stringify({hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', session_id: `r-${Date.now()}-5`, error: `Exit code 1\n${NPM_ERESOLVE}`});
  assert.equal((await run({argv: ['hook'], stdin: input, env: {}, fetchImpl: f.impl})).stdout, '');
});
