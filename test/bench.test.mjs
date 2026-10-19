import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const references = {
  sum: (x) => x.reduce((a, b) => a + b, 0),
  mean: (x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null),
  unique: (x) => [...new Set(x)],
  median: (x) => {
    if (!x.length) return null;
    const a = [...x].sort((a, b) => a - b),
      i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  },
  clamp: ([x, a, b]) => Math.max(a, Math.min(b, x)),
  factorial: (n) => {
    let x = 1;
    for (let i = 2; i <= n; i++) x *= i;
    return x;
  },
  fibonacci: (n) => {
    let a = 0,
      b = 1;
    for (let i = 0; i < n; i++) [a, b] = [b, a + b];
    return a;
  },
  palindrome: (s) => {
    s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return s === [...s].reverse().join('');
  },
  slug: (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
  chunk: ([a, n]) =>
    Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n)),
  flatten: (a) => a.flat(Infinity),
  intersection: ([a, b]) => [...new Set(a)].filter((x) => b.includes(x)),
  difference: ([a, b]) => a.filter((x) => !b.includes(x)),
  count: (a) =>
    Object.fromEntries([...new Set(a)].map((x) => [x, a.filter((y) => x === y).length])),
  'binary-search': ([a, t]) => a.indexOf(t),
  gcd: ([a, b]) => {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) [a, b] = [b, a % b];
    return a;
  },
  balanced: (s) => {
    const a = [];
    for (const c of s) {
      if ('([{'.includes(c)) a.push(c);
      else if (a.pop() !== { ')': '(', ']': '[', '}': '{' }[c]) return false;
    }
    return !a.length;
  },
  'escape-html': (s) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    ),
  camel: (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
  rotate: ([a, k]) => {
    if (!a.length) return [];
    k = ((k % a.length) + a.length) % a.length;
    return k ? [...a.slice(-k), ...a.slice(0, -k)] : [...a];
  },
  ranges: ([[a, b], [c, d]]) =>
    Math.max(a, c) <= Math.min(b, d) ? [Math.max(a, c), Math.min(b, d)] : null,
  rle: (s) => {
    const a = [];
    for (const c of s) {
      if (a.at(-1)?.[0] === c) a.at(-1)[1]++;
      else a.push([c, 1]);
    }
    return a;
  },
  transpose: (a) => (a.length ? a[0].map((_, i) => a.map((row) => row[i])) : []),
  'numeric-sort': (a) => [...a].sort((a, b) => a - b),
};
const tasks = (await readFile(new URL('../bench/eval-v1.jsonl', import.meta.url), 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse);
for (const task of tasks)
  test(`benchmark oracle ${task.id} accepts reference and rejects supplied defect`, () => {
    const reference = references[task.id];
    assert.equal(task.split, 'eval');
    for (const [input, expected] of task.cases) {
      const copy = structuredClone(input);
      assert.deepEqual(reference(copy), expected);
      assert.deepEqual(copy, input);
    }
    const faulty = new Function(
      task.initial.replace('export const solve =', 'const solve =') + ';return solve;',
    )();
    assert.ok(
      task.cases.some(([input, expected]) => {
        try {
          const copy = structuredClone(input);
          assert.deepEqual(faulty(copy), expected);
          assert.deepEqual(copy, input);
          return false;
        } catch {
          return true;
        }
      }),
    );
  });
