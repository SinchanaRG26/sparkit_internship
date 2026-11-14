/**
 * Execution engine.
 *
 * Every run happens in a fresh temp directory, in a child process with a clean environment,
 * a wall-clock limit, an output-size limit and (on Linux) a peak-memory limit.
 * Optional stronger isolation: JUDGE_SANDBOX=docker runs everything inside a locked-down container
 * (no network, read-only file system, memory/CPU/process limits).
 *
 * Layers of defence (outermost first):
 *   1. static screening   - rejects obviously dangerous source (process spawning, sockets, file deletion ...)
 *   2. isolated workspace - temp directory per run, secrets removed from the environment, deleted afterwards
 *   3. resource limits    - time, memory, output size, process kill-tree
 *   4. container sandbox  - optional (Docker), the real security boundary for untrusted code
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const MAX_OUT = 1024 * 1024;         // 1 MB of stdout per run
const MAX_ERR = 16 * 1024;
const COMPILE_TIMEOUT = 20000;
const SANDBOX = (process.env.JUDGE_SANDBOX || 'local').toLowerCase();   // local | docker

const has = (cmd, args = ['--version']) => {
  try { const r = spawnSync(cmd, args, { timeout: 8000, windowsHide: true, encoding: 'utf8' }); return !r.error && r.status === 0; }
  catch { return false; }
};

/* ------------------------------------------------------------------ languages */
function detectLanguages() {
  const L = {};
  const exe = '.' + path.sep + 'main' + (IS_WIN ? '.exe' : '');
  if (SANDBOX === 'docker') {
    if (!has('docker', ['version', '--format', '{{.Server.Version}}'])) return { _error: 'JUDGE_SANDBOX=docker but the Docker daemon is not reachable' };
    L.javascript = { label: 'JavaScript (Node.js)', file: 'main.js', image: 'node:22-alpine', run: m => ['node', [`--max-old-space-size=${m}`, 'main.js']], mul: 2 };
    L.python = { label: 'Python 3', file: 'main.py', image: 'python:3.12-alpine', run: () => ['python', ['-B', 'main.py']], mul: 2 };
    L.cpp = { label: 'C++17', file: 'main.cpp', image: 'gcc:13', compile: () => ['g++', ['-O2', '-std=c++17', '-o', 'main', 'main.cpp']], run: () => ['./main', []], mul: 1 };
    L.c = { label: 'C11', file: 'main.c', image: 'gcc:13', compile: () => ['gcc', ['-O2', '-std=c11', '-o', 'main', 'main.c', '-lm']], run: () => ['./main', []], mul: 1 };
    L.java = { label: 'Java 21', file: 'Main.java', image: 'eclipse-temurin:21-jdk', compile: () => ['javac', ['Main.java']], run: m => ['java', [`-Xmx${m}m`, '-Xss64m', 'Main']], mul: 3 };
    L.go = { label: 'Go', file: 'main.go', image: 'golang:1.22-alpine', compile: () => ['go', ['build', '-o', 'main', 'main.go']], run: () => ['./main', []], mul: 1 };
    L.rust = { label: 'Rust', file: 'main.rs', image: 'rust:1-alpine', compile: () => ['rustc', ['-O', '-o', 'main', 'main.rs']], run: () => ['./main', []], mul: 1 };
    L.ruby = { label: 'Ruby', file: 'main.rb', image: 'ruby:3.3-alpine', run: () => ['ruby', ['main.rb']], mul: 3 };
    L.php = { label: 'PHP', file: 'main.php', image: 'php:8.3-cli-alpine', run: m => ['php', ['-d', `memory_limit=${m}M`, 'main.php']], mul: 2 };
    return L;
  }
  L.javascript = { label: 'JavaScript (Node.js)', file: 'main.js', run: m => [process.execPath, [`--max-old-space-size=${m}`, 'main.js']], mul: 2 };
  const py = ['python3', 'python', 'py'].find(c => has(c));
  if (py) L.python = { label: 'Python 3', file: 'main.py', run: () => [py, ['-B', 'main.py']], mul: 2 };
  if (has('g++')) L.cpp = { label: 'C++17', file: 'main.cpp', compile: () => ['g++', ['-O2', '-std=c++17', '-o', 'main', 'main.cpp']], run: () => [exe, []], mul: 1 };
  if (has('gcc')) L.c = { label: 'C11', file: 'main.c', compile: () => ['gcc', ['-O2', '-std=c11', '-o', 'main', 'main.c', '-lm']], run: () => [exe, []], mul: 1 };
  if (has('javac', ['-version']) && has('java', ['-version'])) L.java = { label: 'Java', file: 'Main.java', compile: () => ['javac', ['Main.java']], run: m => ['java', [`-Xmx${m}m`, '-Xss64m', 'Main']], mul: 3 };
  if (has('go', ['version'])) L.go = { label: 'Go', file: 'main.go', compile: () => ['go', ['build', '-o', 'main' + (IS_WIN ? '.exe' : ''), 'main.go']], run: () => [exe, []], mul: 1 };
  if (has('rustc')) L.rust = { label: 'Rust', file: 'main.rs', compile: () => ['rustc', ['-O', '-o', 'main' + (IS_WIN ? '.exe' : ''), 'main.rs']], run: () => [exe, []], mul: 1 };
  if (has('ruby')) L.ruby = { label: 'Ruby', file: 'main.rb', run: () => ['ruby', ['main.rb']], mul: 3 };
  if (has('php')) L.php = { label: 'PHP', file: 'main.php', run: m => ['php', ['-d', `memory_limit=${m}M`, '-d', 'disable_functions=exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec', 'main.php']], mul: 2 };
  return L;
}
const LANGS = detectLanguages();
const sandboxError = LANGS._error; delete LANGS._error;

/* ------------------------------------------------------------------ static screening (layer 1) */
const RULES = {
  javascript: [/child_process/, /require\s*\(\s*['"](?:node:)?(?:net|http|https|http2|dgram|dns|cluster|worker_threads|vm|os|tls|inspector)['"]/, /process\.(?:binding|dlopen|kill|env)/, /\bfs\.(?:write|append|unlink|rm|rmdir|mkdir|rename|copy|chmod|symlink|open)/, /createWriteStream/, /\bimport\s*\(/],
  python: [/^\s*(?:import|from)\s+(?:os|subprocess|socket|shutil|ctypes|multiprocessing|signal|pty|urllib|http|requests|ftplib|smtplib|importlib|builtins|pathlib|tempfile|glob)\b/m, /__import__/, /\bopen\s*\(/, /\b(?:eval|exec|compile)\s*\(/],
  cpp: [/\bsystem\s*\(/, /\b(?:fork|vfork|popen|execv?[lpe]*|socket|connect|ptrace|dlopen|remove|rename|unlink)\s*\(/, /#\s*include\s*<(?:unistd\.h|sys\/[a-z]+\.h|windows\.h|fstream|filesystem|netinet\/[a-z]+\.h|arpa\/[a-z]+\.h)>/, /\bfopen\s*\(/, /\basm\b|__asm__/],
  java: [/\bRuntime\b/, /ProcessBuilder/, /java\.net/, /java\.nio\.file/, /java\.io\.(?:File|FileWriter|FileOutputStream|RandomAccessFile)/, /java\.lang\.reflect/, /System\.(?:load|setSecurityManager|getenv)/],
};
RULES.go = [/"os\/exec"/, /"(?:net|net\/[a-z]+|syscall|unsafe|plugin|runtime\/debug|os\/signal|os\/user)"/, /import\s+"C"/, /\bos\.(?:Remove|RemoveAll|Create|OpenFile|Open|Mkdir|MkdirAll|Rename|WriteFile|ReadFile|Setenv|Getenv|Environ|Exit\s*\(\s*-)/, /\/\/go:/];
RULES.rust = [/std::(?:process|net|fs|env|os|ffi|thread)/, /\bunsafe\b/, /\bextern\b/, /\b(?:include|include_str|include_bytes|asm|global_asm|env|option_env)!/, /#!?\[(?:link|no_mangle|path)/];
RULES.ruby = [/`/, /%x[\[{(<|!\/]/, /\b(?:system|exec|fork|spawn|popen|syscall|eval|instance_eval|class_eval|module_eval|binding|trap|exit!|abort|load|autoload)\b/, /\b(?:File|Dir|IO|Kernel|Process|Socket|TCPSocket|UDPSocket|Open3|FileUtils|ObjectSpace|ENV|Signal|Etc|Marshal|ARGF|DATA)\b/, /\brequire(?:_relative)?\s*\(?\s*['"](?!(?:set|prime|bigdecimal|matrix|json|date|time)['"])/, /\bopen\s*\(?\s*['"]/, /__FILE__|\$0|\$PROGRAM_NAME/];
RULES.php = [/`/, /\b(?:exec|shell_exec|system|passthru|popen|proc_open|proc_\w+|pcntl_\w+|eval|assert|create_function|fopen|fwrite|file_put_contents|file_get_contents|file|readfile|unlink|rmdir|mkdir|rename|copy|tempnam|tmpfile|symlink|link|chmod|chown|touch|fsockopen|pfsockopen|stream_socket_\w+|socket_\w+|curl_\w+|mail|getenv|putenv|ini_set|ini_alter|dl|glob|scandir|opendir|readdir|dir|highlight_file|show_source|phpinfo|call_user_func(?:_array)?|array_map|usort|register_shutdown_function)\s*\(/, /\b(?:include|include_once|require|require_once)\b/, /\$\$|\$_(?:SERVER|ENV|GET|POST|FILES|COOKIE|REQUEST)|\$GLOBALS|php:\/\/|file:\/\/|data:\/\/|expect:\/\//];
RULES.c = RULES.cpp;
function screen(language, code) {
  if (SANDBOX === 'docker') return null;           // the container is the boundary; do not reject valid programs
  for (const re of RULES[language] || []) if (re.test(code)) return `Rejected by the security filter (matched ${re}). This judge does not allow process, network or file-system access.`;
  return null;
}

/* ------------------------------------------------------------------ process helper */
function killTree(child, name) {
  try {
    if (name) spawnSync('docker', ['kill', name], { timeout: 5000, windowsHide: true });
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}
const goEnv = { GOCACHE: path.join(os.tmpdir(), 'judge-gocache'), GOPATH: path.join(os.tmpdir(), 'judge-gopath'), RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'), CARGO_HOME: process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'), GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOFLAGS: '-mod=mod' };
const cleanEnv = () => IS_WIN
  ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), ...goEnv }
  : { PATH: process.env.PATH, HOME: os.tmpdir(), LANG: 'C.UTF-8', ...goEnv };

function runProcess(cmd, args, { cwd, input = '', timeMs, memMb, container }) {
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint();
    let child;
    try { child = spawn(cmd, args, { cwd, env: cleanEnv(), detached: !IS_WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ spawnError: e.message, stdout: '', stderr: '', timeMs: 0 }); }
    const out = [], err = [];
    let outLen = 0, errLen = 0, timedOut = false, ole = false, mle = false, peak = 0, done = false;
    const kill = () => killTree(child, container);
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeMs);
    const mon = (!IS_WIN && !container && memMb) ? setInterval(() => {      // Linux: watch peak RSS of the child
      try {
        const m = /VmHWM:\s+(\d+)/.exec(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8'));
        if (m) { peak = Math.max(peak, +m[1]); if (peak > memMb * 1024) { mle = true; kill(); } }
      } catch { /* process ended */ }
    }, 20) : null;
    const finish = x => {
      if (done) return; done = true; clearTimeout(timer); if (mon) clearInterval(mon);
      resolve({ ...x, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timeMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), timedOut, ole, mle, memKb: peak });
    };
    child.stdout.on('data', d => { outLen += d.length; if (outLen > MAX_OUT) { ole = true; kill(); } else out.push(d); });
    child.stderr.on('data', d => { errLen += d.length; if (errLen <= MAX_ERR) err.push(d); });
    child.on('error', e => finish({ spawnError: e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', () => { /* program may exit before reading input */ });
    child.stdin.end(input);
  });
}

/* ------------------------------------------------------------------ workspace + docker wrapper */
function makeWorkspace(lang, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  fs.writeFileSync(path.join(dir, lang.file), code, 'utf8');
  return dir;
}
function wrap(lang, dir, cmd, args, { memMb, writable, timeMs }) {
  if (SANDBOX !== 'docker') return { cmd, args, container: null };
  const name = 'judge-' + crypto.randomBytes(6).toString('hex');
  const dockerArgs = ['run', '--rm', '-i', '--name', name, '--network', 'none', '--memory', `${memMb}m`, '--memory-swap', `${memMb}m`,
    '--cpus', '1', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,size=32m', '-v', `${dir}:/work${writable ? '' : ':ro'}`, '-w', '/work', '--user', '65534:65534',
    lang.image, cmd, ...args];
  return { cmd: 'docker', args: dockerArgs, container: name };
}
const cleanup = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

async function compile(lang, dir, memMb) {
  if (!lang.compile) return { ok: true, output: '' };
  const [c, a] = lang.compile();
  if (SANDBOX === 'docker') fs.chmodSync(dir, 0o777);
  const w = wrap(lang, dir, c, a, { memMb: 512, writable: true });
  const r = await runProcess(w.cmd, w.args, { cwd: dir, timeMs: COMPILE_TIMEOUT, memMb: 0, container: w.container });
  if (r.spawnError) return { ok: false, output: 'Compiler could not be started: ' + r.spawnError };
  if (r.timedOut) return { ok: false, output: 'Compilation timed out.' };
  return { ok: r.code === 0, output: (r.stderr || r.stdout).slice(0, 4000) };
}
async function execute(lang, dir, input, timeLimitMs, memMb) {
  const [c, a] = lang.run(memMb);
  const w = wrap(lang, dir, c, a, { memMb, writable: false });
  const limit = Math.round(timeLimitMs * lang.mul) + (SANDBOX === 'docker' ? 1500 : 0);
  return runProcess(w.cmd, w.args, { cwd: dir, input, timeMs: limit, memMb, container: w.container });
}

/* ------------------------------------------------------------------ judging */
const norm = s => String(s).replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
const clip = (s, n = 600) => (s.length > n ? s.slice(0, n) + '\n... (truncated)' : s);

function classify(r, memMb) {
  if (r.spawnError) return { status: 'INTERNAL_ERROR', note: r.spawnError };
  if (r.timedOut) return { status: 'TIME_LIMIT_EXCEEDED' };
  if (r.mle) return { status: 'MEMORY_LIMIT_EXCEEDED' };
  if (r.ole) return { status: 'OUTPUT_LIMIT_EXCEEDED' };
  if (r.code !== 0) return { status: 'RUNTIME_ERROR', note: clip(r.stderr, 800) || `exit code ${r.code}${r.signal ? ' (' + r.signal + ')' : ''}` };
  return null;
}

/** Judge a submission against all test cases (stops at the first failure, like most real judges). */
async function judge({ language, code, tests, timeLimitMs, memMb }) {
  const lang = LANGS[language];
  if (!lang) return { status: 'INTERNAL_ERROR', passed: 0, total: tests.length, results: [], message: `Language "${language}" is not available on this server` };
  const rej = screen(language, code);
  if (rej) return { status: 'REJECTED', passed: 0, total: tests.length, results: [], message: rej };

  const dir = makeWorkspace(lang, code);
  try {
    const c = await compile(lang, dir, memMb);
    if (!c.ok) return { status: 'COMPILE_ERROR', passed: 0, total: tests.length, results: [], message: c.output };
    const results = []; let passed = 0, maxTime = 0, maxMem = 0, status = 'ACCEPTED';
    for (const [i, t] of tests.entries()) {
      const r = await execute(lang, dir, t.input, timeLimitMs, memMb);
      maxTime = Math.max(maxTime, r.timeMs); maxMem = Math.max(maxMem, r.memKb || 0);
      const bad = classify(r, memMb);
      let verdict = bad ? bad.status : (norm(r.stdout) === norm(t.expected) ? 'ACCEPTED' : 'WRONG_ANSWER');
      const item = { index: i + 1, status: verdict, timeMs: r.timeMs, sample: !!t.sample };
      if (t.sample || verdict === 'RUNTIME_ERROR') {            // reveal details only for samples (hidden tests stay hidden)
        if (t.sample) Object.assign(item, { input: clip(t.input), expected: clip(t.expected), actual: clip(r.stdout) });
        if (bad && bad.note) item.note = bad.note;
      }
      results.push(item);
      if (verdict === 'ACCEPTED') passed++; else { status = verdict; break; }
    }
    return { status, passed, total: tests.length, results, timeMs: maxTime, memoryKb: maxMem };
  } finally { cleanup(dir); }
}

/** Run once with custom input (the "Run" button); no comparison. */
async function runOnce({ language, code, input, timeLimitMs = 2000, memMb = 256 }) {
  const lang = LANGS[language];
  if (!lang) return { status: 'INTERNAL_ERROR', message: `Language "${language}" is not available on this server` };
  const rej = screen(language, code);
  if (rej) return { status: 'REJECTED', message: rej };
  const dir = makeWorkspace(lang, code);
  try {
    const c = await compile(lang, dir, memMb);
    if (!c.ok) return { status: 'COMPILE_ERROR', message: c.output };
    const r = await execute(lang, dir, input, timeLimitMs, memMb);
    const bad = classify(r, memMb);
    return { status: bad ? bad.status : 'OK', timeMs: r.timeMs, memoryKb: r.memKb || 0, output: clip(r.stdout, 5000), message: bad ? bad.note || '' : clip(r.stderr, 800) };
  } finally { cleanup(dir); }
}

const languages = () => Object.entries(LANGS).map(([id, l]) => ({ id, label: l.label }));
module.exports = { judge, runOnce, languages, LANGS, SANDBOX, sandboxError, screen, norm };
