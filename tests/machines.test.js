// node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/machines.js');

function calc(s) { return M.byId.calculator.run(null, s).out; }
function sh(s) { return M.byId.text.run(null, s).out; }
function kvRun(lines) {
  let st = M.byId.kv.init(); const outs = [];
  for (const l of lines) { const r = M.byId.kv.run(st, l); st = r.state; outs.push(r.out); }
  return outs;
}

test('calculator is exact', () => {
  assert.strictEqual(calc('17 * 23'), '391');
  assert.strictEqual(calc('2^64'), '18446744073709551616');
  assert.strictEqual(calc('987654321 * 123456789'), '121932631112635269');
  assert.strictEqual(calc('0.1 + 0.2'), '0.3');
  assert.strictEqual(calc('1/7'), '0.142857142857...');
  assert.strictEqual(calc('2/3'), '0.666666666667...');
  assert.strictEqual(calc('100/3'), '33.3333333333...');
  assert.strictEqual(calc('1/70'), '0.0142857142857...');
  assert.strictEqual(calc('-2^2'), '-4');
  assert.strictEqual(calc('2^-2'), '0.25');
  assert.strictEqual(calc('2^3^2'), '512');
  assert.strictEqual(calc('5 / 2'), '2.5');
  assert.strictEqual(calc('(3 + 4) / 0'), 'Error: division by zero');
  assert.strictEqual(calc('2^0.5'), 'Error: exponent must be a whole number');
  assert.strictEqual(calc('2 +'), 'Error: syntax error');
  assert.strictEqual(calc('99^99999'), 'Error: number too large');
});

test('calculator accepts equal spellings of exact results only', () => {
  const same = M.byId.calculator.same;
  assert.ok(same('2.5', '2.50'));
  assert.ok(same('391', ' 391 '));
  assert.ok(!same('391', '392'));
  assert.ok(!same('0.142857142857...', '0.142857142857'));
  assert.ok(!same('18446744073709551616', '1.8446744073709552e19'));
});

test('key-value store keeps state', () => {
  assert.deepStrictEqual(kvRun([
    'SET visits 41', 'INCR visits', 'GET visits', 'APPEND visits !', 'INCR visits',
    'SET city "New York"', 'STRLEN city', 'RENAME city town', 'KEYS', 'DEL visits town ghost', 'KEYS',
    'GET nope', 'incrby n 5', 'FOO', 'GET', 'RENAME ghost x'
  ]), [
    'OK', '(integer) 42', '"42"', '(integer) 3', '(error) ERR value is not an integer',
    'OK', '(integer) 8', 'OK', '1) "town"\n2) "visits"', '(integer) 2', '(empty array)',
    '(nil)', '(integer) 5', "(error) ERR unknown command 'FOO'", "(error) ERR wrong number of arguments for 'get' command", '(error) ERR no such key'
  ]);
});

test('key-value judging ignores redis-cli decoration only', () => {
  const same = M.byId.kv.same;
  assert.ok(same('(integer) 42', '42'));
  assert.ok(same('"42"', '42'));
  assert.ok(same('1) "town"\n2) "visits"', 'town\nvisits'));
  assert.ok(same('(error) ERR value is not an integer', 'ERR value is not an integer'));
  assert.ok(!same('(integer) 42', '43'));
  assert.ok(!same('1) "town"\n2) "visits"', '1) "town"'));
  assert.ok(!same('(nil)', '""'));
});

test('text tools match coreutils on sales.txt', () => {
  assert.strictEqual(sh('wc -l sales.txt'), '10 sales.txt');
  assert.strictEqual(sh('cat sales.txt | wc -l'), '10');
  assert.strictEqual(sh('grep -c coffee sales.txt'), '4');
  assert.strictEqual(sh('grep -ic coffee sales.txt'), '5');
  assert.strictEqual(sh("cut -d ' ' -f2 sales.txt | sort | uniq -c"),
    ['      1 Coffee', '      2 bagel', '      4 coffee', '      1 muffin', '      2 tea'].join('\n'));
  assert.strictEqual(sh("cut -d ' ' -f4 sales.txt | sort | uniq -c | sort -rn | head -n 1"), '      3 bob');
  assert.strictEqual(sh('tail -n 2 sales.txt | rev'), 'lorac 05.3 eeffoc 50-11-6202\nevad 01.3 niffum 50-11-6202');
  assert.strictEqual(sh('wc sales.txt'), '10 40 274 sales.txt'); // GNU wc on the same bytes: " 10  40 274 sales.txt"
  assert.strictEqual(sh('grep -n tea sales.txt'), '4:2026-11-02 tea 2.00 carol\n8:2026-11-04 tea 2.00 bob');
  assert.strictEqual(sh('head -3 sales.txt | tail -n 1'), '2026-11-02 coffee 3.50 bob');
  assert.strictEqual(sh('grep x nope.txt'), 'grep: nope.txt: No such file or directory');
  assert.strictEqual(sh('awk 1 sales.txt'), 'sh: awk: command not found');
  assert.strictEqual(sh('sort'), 'sort: missing file operand');
  assert.strictEqual(sh('ls'), 'sales.txt');
});

test('cleanReply strips only a code fence', () => {
  assert.strictEqual(M.cleanReply('```\n391\n```'), '391');
  assert.strictEqual(M.cleanReply('```text\nOK\n```'), 'OK');
  assert.strictEqual(M.cleanReply('  391  \n'), '391');
  assert.strictEqual(M.cleanReply('Count: 10 lines...</think>10 40 276 sales.txt'), '10 40 276 sales.txt');
});
