/** End-to-end tests: starts the server on a temp database and exercises the whole judge. */
const { spawn } = require('child_process');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3999, BASE = `http://127.0.0.1:${PORT}/api`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  PASS ', name)) : (fail++, console.log('  FAIL ', name, extra)); };

async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function waitFor(id, token, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await call('/submissions/' + id, { token });
    if (r.data.status && !['QUEUED', 'RUNNING'].includes(r.data.status)) return r.data;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('timeout waiting for submission ' + id);
}
const submit = async (token, slug, language, code) => waitFor((await call('/submissions', { method: 'POST', token, body: { slug, language, code } })).data.id, token);

const SOL = {
  sum: {
    python: 'a, b = map(int, input().split())\nprint(a + b)',
    javascript: 'const [a, b] = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconsole.log(a + b);',
    cpp: '#include <iostream>\nint main(){ long long a, b; std::cin >> a >> b; std::cout << a + b << "\\n"; }',
    c: '#include <stdio.h>\nint main(){ long long a, b; scanf("%lld %lld", &a, &b); printf("%lld\\n", a + b); return 0; }',
    java: 'import java.util.*;\npublic class Main { public static void main(String[] x){ Scanner s = new Scanner(System.in); System.out.println(s.nextLong() + s.nextLong()); } }',
    go: 'package main\nimport (\n"bufio"\n"fmt"\n"os"\n)\nfunc main(){ in := bufio.NewReader(os.Stdin); var a, b int64; fmt.Fscan(in, &a, &b); fmt.Println(a + b) }',
    rust: 'use std::io::{self, Read};\nfn main(){ let mut s = String::new(); io::stdin().read_to_string(&mut s).unwrap(); let v: Vec<i64> = s.split_whitespace().map(|x| x.parse().unwrap()).collect(); println!("{}", v[0] + v[1]); }',
    ruby: 'a, b = gets.split.map(&:to_i)\nputs a + b',
    php: '<?php\nfscanf(STDIN, "%d %d", $a, $b);\necho $a + $b, "\\n";',
  },
};

(async () => {
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, SUBMISSIONS_PER_MINUTE: '500' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await call('/health')).data.ok) break; } catch { /* wait */ } await new Promise(r => setTimeout(r, 200)); }
    console.log('\nAccounts');
    ok('health reports problems loaded', (await call('/health')).data.problems === 10);
    const reg = await call('/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
    ok('register works', reg.status === 201 && reg.data.token);
    ok('duplicate username rejected', (await call('/auth/register', { method: 'POST', body: { username: 'ALICE', password: 'secret123' } })).status === 409);
    ok('bad username rejected', (await call('/auth/register', { method: 'POST', body: { username: 'a b', password: 'secret123' } })).status === 400);
    ok('short password rejected', (await call('/auth/register', { method: 'POST', body: { username: 'bob', password: '123' } })).status === 400);
    ok('wrong password rejected', (await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'nope' } })).status === 401);
    const t = (await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret123' } })).data.token;
    const bob = (await call('/auth/register', { method: 'POST', body: { username: 'bob', password: 'secret123' } })).data.token;
    ok('login works', !!t);
    ok('submit needs sign-in', (await call('/submissions', { method: 'POST', body: { slug: 'sum-of-two', language: 'python', code: 'print(1)' } })).status === 401);

    console.log('\nProblems');
    const list = (await call('/problems')).data;
    ok('10 problems listed', list.length === 10);
    const prob = (await call('/problems/sum-of-two')).data;
    ok('problem has samples but hides test data', prob.samples.length === 2 && prob.hiddenTests >= 3 && !JSON.stringify(prob).includes('1000000000 1000000000'));
    ok('unknown problem is 404', (await call('/problems/nope')).status === 404);

    console.log('\nJudging: every language');
    const langs = (await call('/languages')).data.languages.map(l => l.id);
    for (const l of langs) { const r = await submit(t, 'sum-of-two', l, SOL.sum[l]); ok(`${l}: correct solution is ACCEPTED`, r.status === 'ACCEPTED' && r.passed === r.total, r.status + JSON.stringify(r.result?.message)); }

    console.log('\nJudging: verdicts');
    let r = await submit(t, 'sum-of-two', 'python', 'a, b = map(int, input().split())\nprint(a - b)');
    ok('wrong answer detected', r.status === 'WRONG_ANSWER' && r.passed < r.total);
    ok('sample failure shows expected vs actual', r.result.results.some(x => x.sample && x.expected !== undefined && x.actual !== undefined));
    r = await submit(t, 'sum-of-two', 'python', 'a = [x for x in range(3)]\nprint(a[7])');
    ok('runtime error detected', r.status === 'RUNTIME_ERROR');
    r = await submit(t, 'sum-of-two', 'python', 'while True:\n    pass');
    ok('infinite loop -> time limit exceeded', r.status === 'TIME_LIMIT_EXCEEDED' && r.timeMs < 5000, r.status + ' ' + r.timeMs);
    if (process.platform === 'linux') {
      r = await submit(t, 'sum-of-two', 'python', 'x = [0] * (10 ** 9)\nprint(1)');
      ok('huge allocation -> memory limit exceeded', r.status === 'MEMORY_LIMIT_EXCEEDED', r.status);
    }
    r = await submit(t, 'sum-of-two', 'python', 'while True:\n    print("x" * 1000)');
    ok('endless output -> output limit exceeded', r.status === 'OUTPUT_LIMIT_EXCEEDED', r.status);
    r = await submit(t, 'sum-of-two', 'cpp', 'int main( { return 0 }');
    ok('compile error reported with message', r.status === 'COMPILE_ERROR' && /error/i.test(r.result.message));
    r = await submit(t, 'sum-of-two', 'python', 'import os\nos.system("echo hacked")');
    ok('dangerous code rejected by security filter', r.status === 'REJECTED');
    r = await submit(t, 'sum-of-two', 'javascript', 'require("child_process").execSync("whoami")');
    ok('child_process rejected (javascript)', r.status === 'REJECTED');
    const bad = { go: 'package main\nimport "os/exec"\nfunc main(){ exec.Command("ls") }', rust: 'fn main(){ std::process::Command::new("ls"); }', ruby: 'system("ls")', php: '<?php system("ls");' };
    for (const l of langs.filter(x => bad[x])) { r = await submit(t, 'sum-of-two', l, bad[l]); ok(`dangerous ${l} code rejected`, r.status === 'REJECTED', r.status); }
    r = await submit(t, 'sum-of-two', 'cpp', '#include <cstdlib>\nint main(){ system("ls"); }');
    ok('system() rejected (c++)', r.status === 'REJECTED');

    console.log('\nSecurity');
    const secret = path.join(DATA, 'secret.key');
    ok('server secret file exists', fs.existsSync(secret));
    r = await submit(t, 'sum-of-two', 'javascript', 'console.log(process.env.JWT_SECRET || "none"); console.log(Object.keys(process.env).join(","));');
    ok('child process environment is clean', !JSON.stringify(r.result).includes('DATA_DIR'));
    ok('cannot read another user\'s submission', (await call('/submissions/' + r.id, { token: bob })).status === 404);
    ok('oversized code rejected', (await call('/submissions', { method: 'POST', token: t, body: { slug: 'sum-of-two', language: 'python', code: 'x' + ' '.repeat(70000) } })).status === 400);
    ok('unsupported language rejected', (await call('/submissions', { method: 'POST', token: t, body: { slug: 'sum-of-two', language: 'brainfuck', code: '+' } })).status === 400);

    console.log('\nRun with custom input');
    const run = await call('/run', { method: 'POST', token: t, body: { language: 'python', code: 'print(input()[::-1])', input: 'hello\n' } });
    const done = await waitFor(run.data.id, t);
    ok('custom run returns output', done.result.status === 'OK' && done.result.output.trim() === 'olleh');

    console.log('\nQueue');
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await call('/submissions', { method: 'POST', token: bob, body: { slug: 'sum-of-two', language: 'python', code: SOL.sum.python } })).data.id);
    const fifth = await call('/submissions', { method: 'POST', token: bob, body: { slug: 'sum-of-two', language: 'python', code: SOL.sum.python } });
    ok('per-user pending limit enforced (429)', fifth.status === 429);
    const all = await Promise.all(ids.map(id => waitFor(id, bob)));
    ok('queued jobs all finish ACCEPTED', all.every(x => x.status === 'ACCEPTED'));
    ok('queue drains to empty', (await call('/queue')).data.queued === 0);

    console.log('\nHistory and leaderboard');
    const hist = (await call('/submissions', { token: t })).data;
    ok('history lists own submissions, newest first', hist.length > 5 && hist[0].id > hist[1].id);
    ok('history excludes custom runs', hist.every(h => h.kind === 'SUBMIT'));
    const fz = await submit(t, 'even-or-odd', 'python', 'n = int(input())\nprint("Even" if n % 2 == 0 else "Odd")');
    ok('second problem solved', fz.status === 'ACCEPTED');
    const lb = (await call('/leaderboard')).data;
    ok('leaderboard ranks alice first with 2 solved', lb[0].username === 'alice' && lb[0].solved === 2 && lb[0].rank === 1);
    ok('leaderboard includes bob with 1 solved', lb.find(x => x.username === 'bob')?.solved === 1);
    ok('problem list shows my status', (await call('/problems', { token: t })).data.find(p => p.slug === 'sum-of-two').status === 'solved');
    ok('acceptance counters updated', (await call('/problems')).data.find(p => p.slug === 'sum-of-two').accepted >= 6);

    console.log('\nHarder problems (reference solutions)');
    const kad = await submit(t, 'maximum-subarray', 'cpp', '#include <bits/stdc++.h>\nint main(){ int n; scanf("%d",&n); long long best=-1e18,cur=0; for(int i=0;i<n;i++){ long long x; scanf("%lld",&x); cur=std::max(x,cur+x); best=std::max(best,cur);} printf("%lld\\n",best); }');
    ok('maximum-subarray O(n) in C++ accepted', kad.status === 'ACCEPTED', kad.status);
    const slow = await submit(t, 'maximum-subarray', 'python', 'n=int(input())\na=list(map(int,input().split()))\nbest=max(a)\nfor i in range(n):\n    s=0\n    for j in range(i,n):\n        s+=a[j]\n        if s>best: best=s\nprint(best)');
    ok('O(n^2) Python solution times out on the big test', slow.status === 'TIME_LIMIT_EXCEEDED', slow.status);
    const lis = await submit(t, 'longest-increasing-subsequence', 'cpp', '#include <bits/stdc++.h>\nint main(){ int n; scanf("%d",&n); std::vector<long long> t; for(int i=0;i<n;i++){ long long x; scanf("%lld",&x); auto it=std::lower_bound(t.begin(),t.end(),x); if(it==t.end()) t.push_back(x); else *it=x; } printf("%d\\n",(int)t.size()); }');
    ok('hard problem: O(n log n) LIS accepted', lis.status === 'ACCEPTED', lis.status);
    const lisSlow = await submit(t, 'longest-increasing-subsequence', 'python', 'n=int(input())\na=list(map(int,input().split()))\nd=[1]*n\nfor i in range(n):\n    for j in range(i):\n        if a[j]<a[i] and d[j]+1>d[i]: d[i]=d[j]+1\nprint(max(d))');
    ok('hard problem: O(n^2) LIS gets TIME_LIMIT_EXCEEDED', lisSlow.status === 'TIME_LIMIT_EXCEEDED', lisSlow.status);
    const fibo = await submit(t, 'fibonacci', 'javascript', 'const n=Number(require("fs").readFileSync(0,"utf8"));let a=0n,b=1n;for(let i=0;i<n;i++)[a,b]=[b,a+b];console.log(String(a));');
    ok('fibonacci with BigInt accepted', fibo.status === 'ACCEPTED', fibo.status);
  } catch (e) { fail++; console.log('  FAIL  test run crashed:', e.message); }
  finally { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
