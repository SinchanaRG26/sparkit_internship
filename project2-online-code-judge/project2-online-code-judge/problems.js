/**
 * Built-in problem set. Expected outputs are produced by a reference solution (solve),
 * so the test data is always consistent. Inputs use a fixed pseudo-random generator, so every
 * install gets exactly the same hidden tests.
 */
let seed = 20261111;
const rnd = (a, b) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return a + Math.floor(seed / 4294967296 * (b - a + 1)); };
const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'level', 'radar', 'madam', 'queue', 'judge', 'stack', 'proxy', 'civic', 'kayak'];

const isPrime = n => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
const fib = n => { let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; };

const PROBLEMS = [
  {
    slug: 'sum-of-two', title: 'Sum of Two Numbers', difficulty: 'Easy', time: 1000,
    statement: 'Read two integers A and B and print their sum.\n\nThis is the warm-up problem: it checks that you can read input and print output.',
    input: 'One line with two integers A and B (-10^9 <= A, B <= 10^9).', output: 'A single integer: A + B.',
    samples: ['3 4', '-5 12'], gen: () => [`${rnd(-1e9, 1e9)} ${rnd(-1e9, 1e9)}`, `${rnd(0, 100)} ${rnd(0, 100)}`, '0 0', '1000000000 1000000000', '-1000000000 -1000000000'],
    solve: s => { const [a, b] = s.split(' ').map(Number); return String(a + b); },
  },
  {
    slug: 'even-or-odd', title: 'Even or Odd', difficulty: 'Easy', time: 1000,
    statement: 'Given an integer N, print "Even" if it is divisible by 2, otherwise print "Odd".',
    input: 'One integer N (-10^9 <= N <= 10^9).', output: 'The word Even or Odd.',
    samples: ['8', '7'], gen: () => ['0', '-3', '1000000000', String(rnd(1, 1e9)), String(-rnd(1, 1e9))],
    solve: s => (Number(s) % 2 === 0 ? 'Even' : 'Odd'),
  },
  {
    slug: 'fizzbuzz', title: 'FizzBuzz', difficulty: 'Easy', time: 1000,
    statement: 'For every number from 1 to N print on its own line:\n- "FizzBuzz" if it is divisible by both 3 and 5,\n- "Fizz" if it is divisible by 3,\n- "Buzz" if it is divisible by 5,\n- the number itself otherwise.',
    input: 'One integer N (1 <= N <= 10000).', output: 'N lines as described.',
    samples: ['5', '15'], gen: () => ['1', '3', '30', '100', String(rnd(1000, 10000))],
    solve: s => Array.from({ length: +s }, (_, i) => { i++; return i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : String(i); }).join('\n'),
  },
  {
    slug: 'reverse-string', title: 'Reverse a String', difficulty: 'Easy', time: 1000,
    statement: 'Read one line of text and print it reversed (the last character first).',
    input: 'One line with 1 to 1000 characters (letters, digits, no spaces at the ends).', output: 'The reversed text.',
    samples: ['hello', 'JudgeLab2026'], gen: () => ['a', 'abcdef', 'racecar', words.join('').slice(0, rnd(20, 60)), 'X1y2Z3'],
    solve: s => [...s].reverse().join(''),
  },
  {
    slug: 'palindrome-check', title: 'Palindrome Check', difficulty: 'Easy', time: 1000,
    statement: 'A palindrome reads the same forwards and backwards. Given a word, print YES if it is a palindrome and NO otherwise. The check is case-sensitive.',
    input: 'One word of 1 to 1000 lowercase or uppercase letters.', output: 'YES or NO.',
    samples: ['level', 'judge'], gen: () => ['a', 'madam', 'Madam', 'abccba', words[rnd(0, words.length - 1)], 'noon', 'abcde'],
    solve: s => ([...s].reverse().join('') === s ? 'YES' : 'NO'),
  },
  {
    slug: 'factorial', title: 'Factorial', difficulty: 'Easy', time: 1000,
    statement: 'Print N! (N factorial), the product of all integers from 1 to N. 0! is 1.\n\nHint: for N = 20 the answer does not fit in a 32-bit integer.',
    input: 'One integer N (0 <= N <= 20).', output: 'N!',
    samples: ['5', '10'], gen: () => ['0', '1', '12', '19', '20'],
    solve: s => { let r = 1n; for (let i = 2n; i <= BigInt(s); i++) r *= i; return String(r); },
  },
  {
    slug: 'fibonacci', title: 'N-th Fibonacci Number', difficulty: 'Medium', time: 1000,
    statement: 'The Fibonacci sequence starts 0, 1, 1, 2, 3, 5, 8, ... (F0 = 0, F1 = 1, Fn = Fn-1 + Fn-2). Print F(N).\n\nA plain recursive solution is too slow for large N: think about a loop.',
    input: 'One integer N (0 <= N <= 80).', output: 'F(N).',
    samples: ['10', '1'], gen: () => ['0', '2', '30', '50', '80'],
    solve: s => String(fib(+s)),
  },
  {
    slug: 'prime-check', title: 'Prime Check', difficulty: 'Medium', time: 1500,
    statement: 'Given T numbers, print for each one YES if it is prime and NO otherwise.',
    input: 'The first line contains T (1 <= T <= 1000). Each of the next T lines has one integer N (1 <= N <= 10^9).', output: 'T lines, each YES or NO.',
    samples: ['3\n2\n15\n97', '2\n1\n1000000007'],
    gen: () => ['1\n1', '5\n2\n3\n4\n5\n6', `4\n999999937\n1000000000\n${rnd(2, 1e6)}\n561`, `8\n${Array.from({ length: 8 }, () => rnd(1, 1e9)).join('\n')}`, `3\n7919\n7921\n104729`],
    solve: s => { const [, ...n] = s.split('\n'); return n.map(x => (isPrime(+x) ? 'YES' : 'NO')).join('\n'); },
  },
  {
    slug: 'maximum-subarray', title: 'Maximum Subarray Sum', difficulty: 'Hard', time: 2000,
    statement: 'Given an array of N integers, find the largest possible sum of a non-empty contiguous subarray.\n\nA solution that tries every subarray takes O(N^2) and is too slow for the largest tests. Can you do it in O(N)?',
    input: 'The first line contains N (1 <= N <= 200000). The second line contains N integers (-10^4 <= value <= 10^4).', output: 'One integer: the maximum subarray sum.',
    samples: ['5\n1 -2 3 4 -1', '3\n-3 -1 -2'],
    gen: () => ['1\n5', '4\n-1 -2 -3 -4', '8\n-2 1 -3 4 -1 2 1 -5', (n => `${n}\n${Array.from({ length: n }, () => rnd(-10000, 10000)).join(' ')}`)(1000), (n => `${n}\n${Array.from({ length: n }, () => rnd(-10000, 10000)).join(' ')}`)(200000)],
    solve: s => { const a = s.split('\n')[1].split(' ').map(Number); let best = -Infinity, cur = 0; for (const x of a) { cur = Math.max(x, cur + x); best = Math.max(best, cur); } return String(best); },
  },
  {
    slug: 'longest-increasing-subsequence', title: 'Longest Increasing Subsequence', difficulty: 'Hard', time: 2000,
    statement: 'Given a sequence of N integers, find the length of its longest strictly increasing subsequence. A subsequence keeps the original order but may skip elements.\n\nThe obvious dynamic programming solution is O(N^2) and is too slow for N = 200000. You need O(N log N), for example with binary search over the smallest possible tail of each length.',
    input: 'The first line contains N (1 <= N <= 200000). The second line contains N integers (-10^9 <= value <= 10^9).', output: 'One integer: the length of the longest strictly increasing subsequence.',
    samples: ['6\n5 2 8 6 3 6', '4\n7 7 7 7'],
    gen: () => {
      const arr = (n, a, b) => `${n}\n${Array.from({ length: n }, () => rnd(a, b)).join(' ')}`;
      const inc = n => `${n}\n${Array.from({ length: n }, (_, i) => i * 3 - 1000).join(' ')}`;
      return ['1\n42', '5\n1 2 3 4 5', '5\n5 4 3 2 1', '10\n10 9 2 5 3 7 101 18 4 20', arr(1000, -1000000000, 1000000000), arr(200000, -1000000000, 1000000000), inc(200000), arr(200000, 1, 50)];
    },
    solve: s => { const a = s.split('\n')[1].split(' ').map(Number); const t = []; for (const x of a) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } t[lo] = x; } return String(t.length); },
  },
];

/** Returns problems with their test cases (first 2 are samples, shown to users). */
function build() {
  return PROBLEMS.map((p, position) => {
    const sampleInputs = p.samples;
    const hidden = p.gen();
    const tests = [...sampleInputs.map(i => ({ input: i + '\n', expected: p.solve(i), sample: 1 })), ...hidden.map(i => ({ input: i + '\n', expected: p.solve(i), sample: 0 }))];
    return { slug: p.slug, title: p.title, difficulty: p.difficulty, statement: p.statement, input_format: p.input, output_format: p.output, time_limit_ms: p.time, memory_mb: 256, position, tests };
  });
}
module.exports = { build };
