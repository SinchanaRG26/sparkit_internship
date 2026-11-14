# Project 2 - Online Code Judge (JudgeLab)

A small online judge: write code in the browser, run it, submit it, and have it checked against hidden test cases. Built for the SPARKIIT internship by Sinchana Ravi Gowda.

## What it does
- Code editor in the browser (line numbers, Tab indent, auto-indent, bracket closing, drafts saved locally)
- Languages: JavaScript, Python, C++17, C11, Java, Go, Rust, Ruby, PHP (a language shows up only if its compiler/interpreter is installed on the machine; JavaScript always works)
- Run with custom input, or Submit against sample + hidden tests
- Submissions go into a SQLite-backed job queue; a worker pool judges them one by one
- Verdicts: Accepted, Wrong Answer, Time Limit, Memory Limit, Output Limit, Runtime Error, Compile Error, Rejected (security filter)
- Submission history with code view, and a leaderboard (solved, then penalty, then last accepted time)
- 10 problems (easy to hard) with generated hidden tests

## Run it (Windows Command Prompt)
Needs Node.js 22.13 or newer.

    cd project2-online-code-judge
    npm install
    npm start

Open http://localhost:3000, create an account and start solving.

## Run the tests
    npm test
(55 end-to-end checks covering every verdict, security rules, queue limits and the leaderboard.)

## Security layers
1. Static source screening per language (blocks things like os.system, child_process, fs access)
2. Fresh temp folder per run and a clean environment (no secrets passed in)
3. Time, memory and output limits with the whole process tree killed on breach
4. Optional Docker mode: `set JUDGE_SANDBOX=docker` (no network, read-only filesystem, memory/CPU/pid limits, non-root). Not tested in the build environment.

Note: the default local mode is not a true sandbox. Use Docker mode before exposing it to untrusted users.

## Structure
    server.js   Express API + static files
    queue.js    job queue and worker pool
    runner.js   compile/run/limits/screening
    problems.js problem set and test generation
    auth.js db.js
    public/     browser UI
    test/e2e.js end-to-end tests

Settings (environment variables): PORT (3000), JUDGE_WORKERS (2), JUDGE_SANDBOX (local|docker), DATA_DIR, JWT_SECRET.
