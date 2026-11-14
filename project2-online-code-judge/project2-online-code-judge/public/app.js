/* JudgeLab front end: hash-routed single-page app, no dependencies. */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };
let token = store.get('jl_token'), user = (() => { try { return JSON.parse(store.get('jl_user') || 'null'); } catch { return null; } })();
let langs = [], sandbox = 'local', pollTimer = null;

const VERDICT = {
  ACCEPTED: ['Accepted', 'ok'], OK: ['Ran successfully', 'ok'], WRONG_ANSWER: ['Wrong Answer', 'bad'], TIME_LIMIT_EXCEEDED: ['Time Limit Exceeded', 'warn'],
  MEMORY_LIMIT_EXCEEDED: ['Memory Limit Exceeded', 'warn'], OUTPUT_LIMIT_EXCEEDED: ['Output Limit Exceeded', 'warn'], RUNTIME_ERROR: ['Runtime Error', 'bad'],
  COMPILE_ERROR: ['Compilation Error', 'bad'], REJECTED: ['Rejected by security filter', 'bad'], INTERNAL_ERROR: ['Judge error', 'bad'], QUEUED: ['In queue', 'info'], RUNNING: ['Running', 'info'],
};
const verdict = s => VERDICT[s] || [s, ''];
const tagFor = s => { const [l, c] = verdict(s); return `<span class="tag ${c}">${esc(l)}</span>`; };
const ago = ms => { const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(ms).toLocaleDateString('en-IN'); };
const langLabel = id => (langs.find(l => l.id === id) || { label: id }).label;

function toast(msg, type) { const t = document.createElement('div'); t.className = 'toast ' + (type === 'error' ? 'error' : ''); t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 3500); }
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { setSession(null); location.hash = '#/login'; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function setSession(d) { user = d ? d.user : null; token = d ? d.token : null; store.set('jl_user', d ? JSON.stringify(d.user) : null); store.set('jl_token', token); renderNav(); }

function renderNav() {
  const h = location.hash || '#/';
  const a = (href, label) => `<a href="${href}" class="${(href === '#/' ? h === '#/' || h.startsWith('#/problem') : h.startsWith(href)) ? 'active' : ''}">${label}</a>`;
  $('#nav').innerHTML = a('#/', 'Problems') + a('#/leaderboard', 'Leaderboard') + (user ? a('#/submissions', 'My submissions') + `<button class="linklike" data-act="logout">Sign out (${esc(user.username)})</button>` : a('#/login', 'Sign in') + '<a class="cta" href="#/register">Join</a>');
}

/* ---------- router ---------- */
const routes = []; const route = (re, fn) => routes.push([re, fn]);
let navId = 0;
async function router() {
  clearTimeout(pollTimer);
  const hash = location.hash.slice(1) || '/'; renderNav();
  const my = ++navId;
  for (const [re, fn] of routes) {
    const m = hash.match(re); if (!m) continue;
    try { const html = await fn(m.slice(1)); if (my === navId && typeof html === 'string') app.innerHTML = html; if (my === navId && fn.after) fn.after(); }
    catch (e) { if (my === navId) app.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a href="#/">Back to problems</a></div>`; }
    window.scrollTo(0, 0); return;
  }
  app.innerHTML = '<div class="card empty"><h2>Page not found</h2><a href="#/">Back to problems</a></div>';
}
const needLogin = () => { if (!user) { location.hash = '#/login'; return true; } return false; };

/* ---------- problems ---------- */
route(/^\/$/, async () => {
  const list = await api('/problems');
  const solved = list.filter(p => p.status === 'solved').length;
  return `<div class="hero"><div><h1>Problems</h1><span class="muted">Write a solution, submit it, and the judge runs it against hidden test cases.</span></div>
    <div class="stats"><div class="stat"><b>${list.length}</b><span class="muted small">problems</span></div>${user ? `<div class="stat"><b>${solved}</b><span class="muted small">solved by you</span></div>` : ''}
    <div class="stat"><b>${langs.length}</b><span class="muted small">languages</span></div></div></div>
    ${user ? '' : '<div class="note" style="margin-bottom:14px"><a href="#/register">Create a free account</a> to run code, submit solutions and appear on the leaderboard.</div>'}
    <div class="card tablewrap"><table><thead><tr><th></th><th>Title</th><th>Difficulty</th><th>Acceptance</th><th>Limits</th></tr></thead><tbody>
    ${list.map((p, i) => `<tr class="link" data-go="#/problem/${esc(p.slug)}"><td class="nowrap"><span class="dot ${p.status}" title="${p.status}"></span>${i + 1}</td><td><a href="#/problem/${esc(p.slug)}"><b>${esc(p.title)}</b></a></td>
      <td><span class="tag ${p.difficulty}">${p.difficulty}</span></td><td>${p.total ? Math.round(p.accepted / p.total * 100) + '%' : '-'} <span class="muted small">(${p.accepted}/${p.total})</span></td><td class="muted small nowrap">${p.timeLimitMs / 1000}s &middot; ${p.memoryMb} MB</td></tr>`).join('')}</tbody></table></div>`;
});

const TEMPLATES = {
  python: '# Read input with input(); print the answer.\n\ndef main():\n    pass\n\nmain()\n',
  javascript: '// Read all input, then print the answer.\nconst lines = require("fs").readFileSync(0, "utf8").split("\\n");\n\nconsole.log("");\n',
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    return 0;\n}\n',
  c: '#include <stdio.h>\n\nint main(void) {\n\n    return 0;\n}\n',
  go: 'package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tin := bufio.NewReader(os.Stdin)\n\tvar a, b int64\n\tfmt.Fscan(in, &a, &b)\n\tfmt.Println()\n}\n',
  rust: 'use std::io::{self, Read};\n\nfn main() {\n    let mut s = String::new();\n    io::stdin().read_to_string(&mut s).unwrap();\n    let mut it = s.split_whitespace();\n\n    println!();\n}\n',
  ruby: '# Read input with gets or STDIN.read; print the answer.\nline = gets.to_s.strip\n\nputs\n',
  php: '<?php\n// Read input with fgets(STDIN) or fscanf(STDIN, ...); print the answer.\n$line = trim(fgets(STDIN));\n\necho "\\n";\n',
  java: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n\n    }\n}\n',
};
let current = null;      // state of the open problem page

route(/^\/problem\/([\w-]+)$/, async ([slug]) => {
  const [p, subs] = await Promise.all([api('/problems/' + slug), user ? api('/submissions?problem=' + slug + '&limit=8') : Promise.resolve([])]);
  const savedLang = store.get('jl_lang');
  const lang = langs.find(l => l.id === savedLang) ? savedLang : (langs[0] || {}).id;
  current = { slug, lang, p, busy: false, tab: 'result' };
  const io = (label, text) => `<div><div class="io-label"><span>${label}</span><button class="sm" data-copy="${esc(text)}">Copy</button></div><pre class="io">${esc(text)}</pre></div>`;
  return `<p class="small" style="margin-top:0"><a href="#/">&larr; All problems</a></p>
  <div class="split">
    <section class="card statement"><div class="row between wrapflex"><h1>${esc(p.title)}</h1><span class="tag ${p.difficulty}">${p.difficulty}</span></div>
      <div class="limits"><span class="tag">Time ${p.timeLimitMs / 1000}s</span><span class="tag">Memory ${p.memoryMb} MB</span><span class="tag">${p.samples.length} sample + ${p.hiddenTests} hidden tests</span></div>
      ${p.statement.split('\n\n').map(x => `<p>${esc(x)}</p>`).join('')}
      <h3>Input</h3><p>${esc(p.inputFormat)}</p><h3>Output</h3><p>${esc(p.outputFormat)}</p><h3>Examples</h3>
      ${p.samples.map((s, i) => `<div class="sample">${io('Input ' + (i + 1), s.input)}${io('Output ' + (i + 1), s.expected)}</div>`).join('')}
      <div id="mysubs">${subsBlock(subs)}</div></section>
    <section class="card editor-card">
      <div class="ed-head"><div class="row"><label for="lang" style="margin:0">Language</label><select id="lang" class="inline">${langs.map(l => `<option value="${l.id}" ${l.id === lang ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select></div>
        <span class="muted small">Tab = indent &middot; Ctrl+Enter = Run &middot; Ctrl+Shift+Enter = Submit</span></div>
      <div class="editor"><div class="gutter" id="gutter">1</div><textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Code editor"></textarea></div>
      <div class="ed-foot"><span class="muted small" id="pos">Line 1, Col 1</span><div class="row"><button id="runBtn" data-act="run">Run</button><button id="subBtn" class="primary" data-act="submit">Submit</button></div></div>
      <div class="panel-tabs"><button data-tab="result" class="on">Result</button><button data-tab="input">Custom input</button></div>
      <div class="out-area" id="out"><span class="muted">Run your code with your own input, or Submit it to be judged against all test cases.</span></div>
      <div class="out-area" id="inputArea" hidden><label for="stdin">Standard input for "Run"</label><textarea id="stdin" spellcheck="false">${esc(p.samples[0] ? p.samples[0].input : '')}</textarea></div>
    </section></div>`;
});
Object.assign(routes[routes.length - 1][1], { after: setupEditor });

function subsBlock(subs) {
  if (!user) return '<h3>Your submissions</h3><p class="muted small">Sign in to see your submissions for this problem.</p>';
  if (!subs.length) return '<h3>Your submissions</h3><p class="muted small">None yet.</p>';
  return `<h3>Your recent submissions</h3><table><tbody>${subs.map(s => `<tr class="link" data-go="#/submission/${s.id}"><td>#${s.id}</td><td>${tagFor(s.status)}</td><td class="small">${esc(langLabel(s.language))}</td><td class="small muted">${ago(s.createdAt)}</td></tr>`).join('')}</tbody></table>`;
}

function draftKey() { return `jl_draft_${current.slug}_${current.lang}`; }
function setupEditor() {
  const ta = $('#code'); if (!ta || !current) return;
  const load = () => { ta.value = store.get(draftKey()) ?? TEMPLATES[current.lang] ?? ''; refresh(); };
  const refresh = () => {
    const n = ta.value.split('\n').length; $('#gutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    const before = ta.value.slice(0, ta.selectionStart).split('\n'); $('#pos').textContent = `Line ${before.length}, Col ${before[before.length - 1].length + 1}`;
    $('#gutter').scrollTop = ta.scrollTop;
  };
  load();
  ta.addEventListener('input', () => { store.set(draftKey(), ta.value); refresh(); });
  ta.addEventListener('scroll', () => { $('#gutter').scrollTop = ta.scrollTop; });
  ta.addEventListener('keyup', refresh); ta.addEventListener('click', refresh);
  ta.addEventListener('keydown', e => {
    const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value, edit = (text, from, to, caret) => { ta.setRangeText(text, from, to, 'end'); ta.selectionStart = ta.selectionEnd = caret; ta.dispatchEvent(new Event('input')); };
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); act(e.shiftKey ? 'submit' : 'run'); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s !== en && v.slice(s, en).includes('\n')) {            // indent / outdent a block
        const start = v.lastIndexOf('\n', s - 1) + 1, block = v.slice(start, en), lines = block.split('\n');
        const out = (e.shiftKey ? lines.map(l => l.replace(/^( {1,4}|\t)/, '')) : lines.map(l => '    ' + l)).join('\n');
        ta.setRangeText(out, start, en, 'select'); ta.dispatchEvent(new Event('input'));
      } else if (e.shiftKey) { const ls = v.lastIndexOf('\n', s - 1) + 1, m = /^( {1,4}|\t)/.exec(v.slice(ls)); if (m) edit('', ls, ls + m[0].length, Math.max(ls, s - m[0].length)); }
      else edit('    ', s, en, s + 4);
    } else if (e.key === 'Enter') {                                  // keep indentation, add a level after { ( [ :
      e.preventDefault();
      const ls = v.lastIndexOf('\n', s - 1) + 1, line = v.slice(ls, s), indent = /^\s*/.exec(line)[0], opens = /[{(\[:]\s*$/.test(line), closes = /^[}\])]/.test(v[en] || '');
      const ins = '\n' + indent + (opens ? '    ' : '') + (opens && closes ? '\n' + indent : '');
      edit(ins, s, en, s + 1 + indent.length + (opens ? 4 : 0));
    } else if ('([{"\''.includes(e.key) && !e.ctrlKey && !e.metaKey && s === en && !/\w/.test(v[s] || ' ')) {   // auto-close pairs
      const close = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }[e.key];
      if ((e.key === '"' || e.key === "'") && /\w/.test(v[s - 1] || '')) return;
      e.preventDefault(); edit(e.key + close, s, en, s + 1);
    } else if (')]}"\''.includes(e.key) && s === en && v[s] === e.key) { e.preventDefault(); ta.selectionStart = ta.selectionEnd = s + 1; refresh(); }
  });
  $('#lang').addEventListener('change', e => { current.lang = e.target.value; store.set('jl_lang', current.lang); load(); });
}

/* ---------- run / submit ---------- */
function setOut(html) { $('#out').innerHTML = html; showTab('result'); }
function showTab(t) { current.tab = t; document.querySelectorAll('.panel-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); $('#out').hidden = t !== 'result'; $('#inputArea').hidden = t !== 'input'; }
const waiting = (what, extra = '') => setOut(`<span class="spinner"></span><b>${what}</b> <span class="muted small">${extra}</span>`);

async function act(kind) {
  if (!current || current.busy) return;
  if (!user) { toast('Sign in to run or submit code', 'error'); location.hash = '#/login'; return; }
  const code = $('#code').value;
  if (!code.trim()) { toast('Write some code first', 'error'); return; }
  current.busy = true; $('#runBtn').disabled = $('#subBtn').disabled = true;
  try {
    const body = kind === 'run' ? { language: current.lang, code, input: $('#stdin').value } : { slug: current.slug, language: current.lang, code };
    const r = await api(kind === 'run' ? '/run' : '/submissions', { method: 'POST', body });
    waiting('Waiting in queue...', r.queue ? `${r.queue.queued} waiting, ${r.queue.running} running` : '');
    await poll(r.id, kind);
  } catch (e) { setOut(`<div class="err">${esc(e.message)}</div>`); }
  finally { current.busy = false; const a = $('#runBtn'), b = $('#subBtn'); if (a) a.disabled = b.disabled = false; }
}
function poll(id, kind) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const step = async () => {
      if (!$('#out') || !current) return resolve();
      try {
        const s = await api('/submissions/' + id);
        if (s.status === 'QUEUED') waiting('Waiting in queue...', 'a worker will pick it up shortly');
        else if (s.status === 'RUNNING') waiting('Judging...', kind === 'run' ? 'running your code' : 'running test cases');
        else { setOut(kind === 'run' ? renderRun(s) : renderVerdict(s)); if (kind === 'submit') refreshMine(); return resolve(); }
        if (Date.now() - started > 90000) return reject(new Error('Timed out waiting for the judge'));
        pollTimer = setTimeout(step, 400);
      } catch (e) { reject(e); }
    };
    step();
  });
}
async function refreshMine() { try { const el = $('#mysubs'); if (el && current) el.innerHTML = subsBlock(await api('/submissions?problem=' + current.slug + '&limit=8')); } catch { /* ignore */ } }

function renderRun(s) {
  const r = s.result || {}, [label, cls] = verdict(r.status || s.status);
  return `<div class="verdict"><span class="big ${cls}">${label}</span><span class="muted small">${r.timeMs ?? s.timeMs ?? '-'} ms</span></div>
    ${r.output ? `<div class="io-label"><span>Output</span></div><pre class="out">${esc(r.output)}</pre>` : ''}
    ${r.message ? `<div class="io-label" style="margin-top:8px"><span>${r.status === 'OK' ? 'Messages (stderr)' : 'Details'}</span></div><pre class="out ${r.status === 'OK' ? '' : 'err'}">${esc(r.message)}</pre>` : ''}
    ${!r.output && !r.message ? '<span class="muted">The program printed nothing.</span>' : ''}`;
}
function renderVerdict(s) {
  const [label, cls] = verdict(s.status), res = (s.result && s.result.results) || [];
  const first = res.find(x => x.status !== 'ACCEPTED');
  return `<div class="verdict"><span class="big ${cls}">${label}</span><span class="tag">${s.passed}/${s.total} tests passed</span>
      ${s.timeMs != null ? `<span class="muted small">Time ${s.timeMs} ms</span>` : ''}${s.memoryKb ? `<span class="muted small">Memory ${(s.memoryKb / 1024).toFixed(1)} MB</span>` : ''}${s.waitMs != null ? `<span class="muted small">Queue wait ${s.waitMs} ms</span>` : ''}</div>
    ${s.total ? `<div class="chips">${Array.from({ length: s.total }, (_, i) => { const r = res[i]; return `<span class="chip ${r ? (r.status === 'ACCEPTED' ? 'ok' : 'bad') : ''}" title="${r ? esc(verdict(r.status)[0]) : 'not run'}">${i + 1}</span>`; }).join('')}</div>` : ''}
    ${s.result && s.result.message ? `<pre class="out err">${esc(s.result.message)}</pre>` : ''}
    ${first ? `<p class="small muted" style="margin:6px 0">Test ${first.index}: ${esc(verdict(first.status)[0])}${first.sample ? '' : ' (hidden test: details are not shown)'}</p>` : ''}
    ${first && first.sample && first.expected !== undefined ? `<div class="sample"><div><div class="io-label">Expected</div><pre class="out">${esc(first.expected)}</pre></div><div><div class="io-label">Your output</div><pre class="out">${esc(first.actual)}</pre></div></div>` : ''}
    ${first && first.note ? `<pre class="out err">${esc(first.note)}</pre>` : ''}
    ${s.status === 'ACCEPTED' ? '<p style="margin:6px 0 0">Well done! <a href="#/leaderboard">See the leaderboard</a></p>' : ''}`;
}

/* ---------- submissions ---------- */
route(/^\/submissions$/, async () => {
  if (needLogin()) return;
  const list = await api('/submissions?limit=100');
  if (!list.length) return '<div class="card empty"><h2>No submissions yet</h2><p>Solve a problem and your attempts will appear here.</p><a href="#/">Browse problems</a></div>';
  return `<div class="hero"><div><h1>My submissions</h1><span class="muted">Your last ${list.length} judged attempts, newest first.</span></div></div>
    <div class="card tablewrap"><table><thead><tr><th>#</th><th>Problem</th><th>Language</th><th>Verdict</th><th>Tests</th><th>Time</th><th>Memory</th><th>When</th></tr></thead><tbody>
    ${list.map(s => `<tr class="link" data-go="#/submission/${s.id}"><td>${s.id}</td><td><a href="#/problem/${esc(s.problem?.slug)}">${esc(s.problem?.title)}</a></td><td class="small">${esc(langLabel(s.language))}</td><td>${tagFor(s.status)}</td>
      <td>${s.passed}/${s.total}</td><td class="small">${s.timeMs ?? '-'} ms</td><td class="small">${s.memoryKb ? (s.memoryKb / 1024).toFixed(1) + ' MB' : '-'}</td><td class="muted small nowrap">${ago(s.createdAt)}</td></tr>`).join('')}</tbody></table></div>`;
});
route(/^\/submission\/(\d+)$/, async ([id]) => {
  if (needLogin()) return;
  const s = await api('/submissions/' + id);
  const nums = s.code.split('\n').map((_, i) => i + 1).join('\n');
  return `<p class="small" style="margin-top:0"><a href="#/submissions">&larr; My submissions</a></p>
    <div class="row between wrapflex" style="margin-bottom:14px"><div><h1>Submission #${s.id}</h1><span class="muted">${s.problem ? `<a href="#/problem/${esc(s.problem.slug)}">${esc(s.problem.title)}</a> &middot; ` : ''}${esc(langLabel(s.language))} &middot; ${new Date(s.createdAt).toLocaleString('en-IN')}</span></div></div>
    <div class="split"><section class="card"><h2>Verdict</h2>${renderVerdict(s)}</section>
    <section class="card"><div class="row between"><h2>Code</h2><button class="sm" data-copy="${esc(s.code)}">Copy</button></div><div class="code-view"><div class="gutter">${nums}</div><pre>${esc(s.code)}</pre></div></section></div>`;
});

/* ---------- leaderboard ---------- */
route(/^\/leaderboard$/, async () => {
  const rows = await api('/leaderboard');
  return `<div class="hero"><div><h1>Leaderboard</h1><span class="muted">Ranked by problems solved, then by penalty: minutes from first attempt to first accepted answer, plus 20 minutes for each wrong attempt before it.</span></div></div>
    ${rows.length ? `<div class="card tablewrap"><table><thead><tr><th>Rank</th><th>User</th><th>Solved</th><th>Penalty</th><th>Submissions</th><th>Best language</th><th>Last accepted</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="${user && r.username === user.username ? 'me' : ''}"><td class="medal rank${r.rank}">${r.rank <= 3 ? ['\u{1F947}', '\u{1F948}', '\u{1F949}'][r.rank - 1] : r.rank}</td><td><b>${esc(r.username)}</b>${user && r.username === user.username ? ' <span class="tag">you</span>' : ''}</td>
      <td><b>${r.solved}</b></td><td>${r.penalty} min</td><td>${r.submissions}</td><td class="small">${r.favourite ? esc(langLabel(r.favourite)) : '-'}</td><td class="muted small">${r.lastAc ? ago(r.lastAc) : '-'}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="card empty"><h2>No one on the board yet</h2><p>Be the first to solve a problem.</p><a href="#/">Browse problems</a></div>'}`;
});

/* ---------- auth pages ---------- */
const authForm = reg => `<form class="card" data-form="${reg ? 'register' : 'login'}" style="max-width:420px;margin:20px auto"><h1>${reg ? 'Create account' : 'Sign in'}</h1><p class="muted">${reg ? 'Pick a username for the leaderboard.' : 'Welcome back.'}</p><div id="msg"></div>
  <div class="field"><label for="u">Username</label><input id="u" name="username" required minlength="3" maxlength="20" autocomplete="username"></div>
  <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"></div>
  <button class="primary" style="width:100%">${reg ? 'Create account' : 'Sign in'}</button><p class="small muted">${reg ? 'Already registered? <a href="#/login">Sign in</a>' : 'New here? <a href="#/register">Create an account</a>'}</p></form>`;
route(/^\/login$/, async () => authForm(false));
route(/^\/register$/, async () => authForm(true));

/* ---------- events ---------- */
document.addEventListener('submit', async ev => {
  const f = ev.target.closest('form[data-form]'); if (!f) return; ev.preventDefault();
  const btn = f.querySelector('button'); btn.disabled = true;
  try { const r = await api('/auth/' + f.dataset.form, { method: 'POST', body: Object.fromEntries(new FormData(f)) }); setSession(r); toast('Welcome, ' + r.user.username); location.hash = '#/'; }
  catch (e) { $('#msg', f).innerHTML = `<div class="err">${esc(e.message)}</div>`; btn.disabled = false; }
});
document.addEventListener('click', ev => {
  const t = ev.target, b = t.closest('[data-act],[data-tab],[data-copy]');
  if (b) {
    if (b.dataset.act === 'logout') { setSession(null); toast('Signed out'); location.hash = '#/'; }
    else if (b.dataset.act === 'run' || b.dataset.act === 'submit') act(b.dataset.act);
    else if (b.dataset.tab) showTab(b.dataset.tab);
    else if (b.dataset.copy != null) { (navigator.clipboard ? navigator.clipboard.writeText(b.dataset.copy) : Promise.reject()).then(() => toast('Copied'), () => toast('Copy not available', 'error')); }
    return;
  }
  const row = t.closest('tr[data-go]'); if (row && !t.closest('a')) location.hash = row.dataset.go;
});

async function queueStatus() {
  const el = $('#qstat');
  try { const q = await (await fetch('/api/queue')).json(); el.className = 'qstat' + (q.queued + q.running ? ' busy' : ''); el.textContent = `queue: ${q.queued} waiting, ${q.running}/${q.workers} running | sandbox: ${q.sandbox}`; }
  catch { el.className = 'qstat down'; el.textContent = 'judge unreachable'; }
}
(async () => {
  try { const l = await (await fetch('/api/languages')).json(); langs = l.languages; sandbox = l.sandbox; if (l.warning) toast(l.warning, 'error'); } catch { /* offline */ }
  window.addEventListener('hashchange', router); router(); queueStatus(); setInterval(queueStatus, 5000);
})();
