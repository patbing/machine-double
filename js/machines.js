/* The three real machines. Pure functions, no DOM, no network.
 * Each machine: { id, name, tagline, file?, spec, probes[], init() -> state, run(state, line) -> { out, state }, same(real, double) -> bool }
 * Loaded as a classic script in the page (window.MD.machines) and with require() in tests and tools.
 */
(function (root) {
  'use strict';

  // ---------- shared helpers ----------
  // canon: optional per-line function so a machine can ignore presentation-only differences.
  function normLines(s, canon) {
    var lines = String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n').map(function (l) {
      l = l.replace(/\s+/g, ' ').trim();
      return canon ? canon(l) : l;
    });
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    while (lines.length && lines[0] === '') lines.shift();
    return lines;
  }
  function sameLines(a, b, canon) {
    var x = normLines(a, canon), y = normLines(b, canon);
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  function sameText(a, b) { return sameLines(a, b); }
  // Which lines of `double` differ from `real` (by index), for highlighting.
  function diffLines(real, dbl, canon) {
    var x = normLines(real, canon), y = normLines(dbl, canon), bad = [];
    for (var i = 0; i < y.length; i++) if (x[i] !== y[i]) bad.push(i);
    return { realLines: x, doubleLines: y, bad: bad, missing: Math.max(0, x.length - y.length) };
  }
  // Models sometimes wrap the answer in a code fence or echo a prompt. Strip only that wrapping.
  function cleanReply(s) {
    var t = String(s == null ? '' : s).replace(/\r\n?/g, '\n');
    var think = t.lastIndexOf('</think>'); // some models leak their reasoning into the content; the answer is what follows
    if (think >= 0) t = t.slice(think + 8);
    t = t.trim();
    var m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (m) t = m[1];
    return t.replace(/\s+$/, '');
  }

  // ---------- 1. Calculator: exact rational arithmetic on BigInt ----------
  var BIG_DIGITS = 400;
  function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { var t = a % b; a = b; b = t; } return a; }
  function rat(n, d) {
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) { n = -n; d = -d; }
    var g = gcd(n, d) || 1n;
    var r = { n: n / g, d: d / g };
    if (r.n.toString().length > BIG_DIGITS || r.d.toString().length > BIG_DIGITS) throw new Error('number too large');
    return r;
  }
  function parseDecimal(s) {
    var m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
    if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
    var frac = m[3] || '';
    var n = BigInt((m[2] || '0') + frac), d = 10n ** BigInt(frac.length);
    var e = m[4] ? Number(m[4]) : 0;
    if (Math.abs(e) > BIG_DIGITS) return null;
    if (e > 0) n *= 10n ** BigInt(e); else if (e < 0) d *= 10n ** BigInt(-e);
    if (m[1] === '-') n = -n;
    return rat(n, d);
  }
  function calcEval(src) {
    var toks = [], i = 0, s = String(src);
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
        var num = parseDecimal(s.slice(i, j));
        if (!num) throw new Error('syntax error');
        toks.push({ t: 'num', v: num }); i = j; continue;
      }
      if ('+-*/^()'.indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
      if (c === '×') { toks.push({ t: '*' }); i++; continue; }
      if (c === '÷') { toks.push({ t: '/' }); i++; continue; }
      throw new Error('syntax error');
    }
    var p = 0;
    function peek() { return toks[p] && toks[p].t; }
    function expr() {
      var v = term();
      while (peek() === '+' || peek() === '-') {
        var op = toks[p++].t, w = term();
        v = op === '+' ? rat(v.n * w.d + w.n * v.d, v.d * w.d) : rat(v.n * w.d - w.n * v.d, v.d * w.d);
      }
      return v;
    }
    function term() {
      var v = unary();
      while (peek() === '*' || peek() === '/') {
        var op = toks[p++].t, w = unary();
        if (op === '*') v = rat(v.n * w.n, v.d * w.d);
        else { if (w.n === 0n) throw new Error('division by zero'); v = rat(v.n * w.d, v.d * w.n); }
      }
      return v;
    }
    function unary() {
      if (peek() === '-') { p++; var v = unary(); return rat(-v.n, v.d); }
      if (peek() === '+') { p++; return unary(); }
      return power();
    }
    function power() {
      var b = primary();
      if (peek() === '^') {
        p++;
        var e = unary();
        if (e.d !== 1n) throw new Error('exponent must be a whole number');
        var k = e.n < 0n ? -e.n : e.n;
        var bits = Math.max(b.n.toString().length, b.d.toString().length);
        if (k > 10000n || (bits > 1 && Number(k) * bits > BIG_DIGITS * 1.2) ) throw new Error('number too large');
        var r = rat(b.n ** k, b.d ** k);
        if (e.n < 0n) { if (r.n === 0n) throw new Error('division by zero'); r = rat(r.d, r.n); }
        return r;
      }
      return b;
    }
    function primary() {
      var t = toks[p];
      if (!t) throw new Error('syntax error');
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === '(') { p++; var v = expr(); if (peek() !== ')') throw new Error('syntax error'); p++; return v; }
      throw new Error('syntax error');
    }
    if (!toks.length) throw new Error('syntax error');
    var out = expr();
    if (p !== toks.length) throw new Error('syntax error');
    return out;
  }
  function terminates(d) { while (d % 2n === 0n) d /= 2n; while (d % 5n === 0n) d /= 5n; return d === 1n; }
  // Exact decimal when it terminates, else 12 significant digits (rounded half up) followed by "...".
  function formatRat(r) {
    var neg = r.n < 0n, n = neg ? -r.n : r.n, d = r.d;
    var sign = neg ? '-' : '';
    if (terminates(d)) {
      var k = 0, dd = d; while (dd !== 1n) { dd = (dd % 2n === 0n) ? dd / 2n : dd / 5n; k++; }
      var scaled = n * (10n ** BigInt(k)) / d, s = scaled.toString();
      if (k === 0) return sign + s;
      while (s.length <= k) s = '0' + s;
      var ip = s.slice(0, s.length - k), fp = s.slice(s.length - k).replace(/0+$/, '');
      return sign + ip + (fp ? '.' + fp : '');
    }
    // 12 significant digits
    var intDigits = (n / d).toString();
    var lead = intDigits === '0' ? 0 : intDigits.length;
    var shift = 12 - lead;
    if (lead === 0) { var q = n; while (q * 10n < d) { q *= 10n; shift++; } }
    var sc = shift >= 0 ? n * 10n ** BigInt(shift) : n;
    var dv = shift >= 0 ? d : d * 10n ** BigInt(-shift);
    var digits = (sc * 2n + dv) / (2n * dv);
    var str = digits.toString();
    if (shift <= 0) return sign + str + '0'.repeat(-shift) + '...';
    while (str.length <= shift) str = '0' + str;
    var a = str.slice(0, str.length - shift), b = str.slice(str.length - shift).replace(/0+$/, '');
    return sign + a + (b ? '.' + b : '') + '...';
  }
  var calculator = {
    id: 'calculator',
    name: 'Calculator',
    tagline: 'Exact arithmetic. Every digit counts.',
    spec: [
      'You are an exact desk calculator. The user types one arithmetic expression per line.',
      'Operators: + - * / ^ (power) and parentheses. ^ binds tighter than unary minus, so -2^2 = -4. Powers take whole-number exponents.',
      'Reply with the result only: no words, no "=", no thousands separators, no scientific notation, no rounding.',
      'Integers and terminating decimals are shown with every digit, with no trailing zeros after the point (2.50 -> 2.5).',
      'A non-terminating result is shown with 12 significant digits, rounded, then "..." (1/3 -> 0.333333333333...).',
      'Errors are printed exactly as: Error: division by zero | Error: syntax error | Error: exponent must be a whole number | Error: number too large'
    ].join('\n'),
    probes: ['17 * 23', '2^64', '987654321 * 123456789', '1/7', '0.1 + 0.2', '-2^2', '(3 + 4) / 0', '99999999999 * 99999999999', '2^0.5'],
    init: function () { return null; },
    run: function (state, line) {
      var out;
      try { out = formatRat(calcEval(line)); } catch (e) { out = 'Error: ' + e.message; }
      return { out: out, state: state };
    },
    same: function (real, dbl) {
      var a = normLines(real).join(' '), b = normLines(dbl).join(' ');
      if (a === b) return true;
      // Accept a numerically equal spelling of an exact result (e.g. "2.50" for "2.5", "-0" for "0").
      if (/^Error|\.\.\.$/.test(a)) return false;
      var x = parseDecimal(a), y = parseDecimal(b);
      return !!(x && y && x.n === y.n && x.d === y.d);
    }
  };

  // ---------- 2. Key-value store (a small Redis-like database) ----------
  function kvTokens(line) {
    var out = [], re = /"([^"]*)"|(\S+)/g, m;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }
  function q(s) { return '"' + s + '"'; }
  function isInt(s) { return /^-?\d+$/.test(s) && s.length <= 18; }
  var KV_ARITY = { SET: [2, 2], GET: [1, 1], DEL: [1, 99], EXISTS: [1, 1], INCR: [1, 1], DECR: [1, 1], INCRBY: [2, 2], APPEND: [2, 2], STRLEN: [1, 1], KEYS: [0, 0], RENAME: [2, 2], FLUSHALL: [0, 0] };
  var kv = {
    id: 'kv',
    name: 'Key-value store',
    tagline: 'A tiny database. Does the model remember what you stored?',
    spec: [
      'You are a small in-memory key-value database with a redis-cli style prompt. The user types one command per line.',
      'Keys and values are strings. A value with spaces is written in double quotes: SET greeting "hello world". Command names are case-insensitive.',
      'Commands and replies:',
      'SET key value -> OK',
      'GET key -> "value" (in double quotes), or (nil) if missing',
      'DEL key [key ...] -> (integer) N, the number of keys that existed and were removed',
      'EXISTS key -> (integer) 1 or (integer) 0',
      'INCR key / DECR key / INCRBY key n -> (integer) new value; a missing key counts as 0; a value that is not an integer -> (error) ERR value is not an integer',
      'APPEND key value -> (integer) length of the new value (a missing key starts empty)',
      'STRLEN key -> (integer) length, 0 if missing',
      'KEYS -> every key in alphabetical order, one per line as 1) "a" 2) "b" ..., or (empty array) when there are none',
      'RENAME old new -> OK, or (error) ERR no such key',
      'FLUSHALL -> OK and the database is empty',
      'An unknown command -> (error) ERR unknown command \'NAME\' (NAME as typed). Wrong number of arguments -> (error) ERR wrong number of arguments for \'name\' command (name in lower case).',
      'The database starts empty and keeps its contents between commands. Reply with exactly what the database prints, nothing else.'
    ].join('\n'),
    probes: ['SET visits 41', 'INCR visits', 'GET visits', 'APPEND visits !', 'INCR visits', 'SET city "New York"', 'STRLEN city', 'RENAME city town', 'KEYS', 'DEL visits town ghost', 'KEYS'],
    init: function () { return {}; },
    run: function (state, line) {
      var db = Object.assign({}, state), t = kvTokens(line), out;
      if (!t.length) return { out: '', state: db };
      var cmd = t[0].toUpperCase(), a = t.slice(1);
      var ar = KV_ARITY[cmd];
      if (!ar) return { out: "(error) ERR unknown command '" + t[0] + "'", state: db };
      if (a.length < ar[0] || a.length > ar[1]) return { out: "(error) ERR wrong number of arguments for '" + cmd.toLowerCase() + "' command", state: db };
      var has = function (k) { return Object.prototype.hasOwnProperty.call(db, k); };
      switch (cmd) {
        case 'SET': db[a[0]] = a[1]; out = 'OK'; break;
        case 'GET': out = has(a[0]) ? q(db[a[0]]) : '(nil)'; break;
        case 'DEL': var n = 0; a.forEach(function (k) { if (has(k)) { delete db[k]; n++; } }); out = '(integer) ' + n; break;
        case 'EXISTS': out = '(integer) ' + (has(a[0]) ? 1 : 0); break;
        case 'INCR': case 'DECR': case 'INCRBY':
          var by = cmd === 'INCR' ? 1n : cmd === 'DECR' ? -1n : null;
          if (cmd === 'INCRBY') { if (!isInt(a[1])) { out = '(error) ERR value is not an integer'; break; } by = BigInt(a[1]); }
          var cur = has(a[0]) ? db[a[0]] : '0';
          if (!isInt(cur)) { out = '(error) ERR value is not an integer'; break; }
          var v = (BigInt(cur) + by).toString(); db[a[0]] = v; out = '(integer) ' + v; break;
        case 'APPEND': db[a[0]] = (has(a[0]) ? db[a[0]] : '') + a[1]; out = '(integer) ' + db[a[0]].length; break;
        case 'STRLEN': out = '(integer) ' + (has(a[0]) ? db[a[0]].length : 0); break;
        case 'KEYS':
          var ks = Object.keys(db).sort();
          out = ks.length ? ks.map(function (k, i) { return (i + 1) + ') ' + q(k); }).join('\n') : '(empty array)'; break;
        case 'RENAME':
          if (!has(a[0])) { out = '(error) ERR no such key'; break; }
          var val = db[a[0]]; delete db[a[0]]; db[a[1]] = val; out = 'OK'; break;
        case 'FLUSHALL': db = {}; out = 'OK'; break;
      }
      return { out: out, state: db };
    },
    // Judge the database's answer, not redis-cli's decoration: "(integer) 42" = "42", '1) "a"' = "a", "(error) ERR x" = "ERR x".
    canon: function (l) { return l.replace(/^\((integer|error)\) /i, '').replace(/^\d+\) /, '').replace(/^"(.*)"$/, '$1'); },
    same: function (real, dbl) { return sameLines(real, dbl, kv.canon); }
  };

  // ---------- 3. Text tools over one fixed file ----------
  var SALES = [
    '2026-11-01 coffee 3.50 alice',
    '2026-11-01 bagel 2.25 bob',
    '2026-11-02 coffee 3.50 bob',
    '2026-11-02 tea 2.00 carol',
    '2026-11-03 coffee 3.50 alice',
    '2026-11-03 Coffee 4.75 dave',
    '2026-11-04 bagel 2.25 alice',
    '2026-11-04 tea 2.00 bob',
    '2026-11-05 coffee 3.50 carol',
    '2026-11-05 muffin 3.10 dave'
  ];
  var FILES = { 'sales.txt': SALES.join('\n') + '\n' };
  function shWords(seg) {
    var out = [], re = /'([^']*)'|"([^"]*)"|(\S+)/g, m;
    while ((m = re.exec(seg))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    return out;
  }
  // Split a command line on | outside quotes.
  function splitPipes(line) {
    var parts = [], cur = '', quote = null;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (quote) { if (c === quote) quote = null; cur += c; continue; }
      if (c === "'" || c === '"') { quote = c; cur += c; continue; }
      if (c === '|') { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts.map(function (s) { return s.trim(); });
  }
  function toLines(text) { var l = text.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }
  function fromLines(l) { return l.length ? l.join('\n') + '\n' : ''; }
  function cmpBytes(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function leadNum(s) { var m = /^\s*(-?\d+(?:\.\d+)?)/.exec(s); return m ? Number(m[1]) : 0; }
  function ShErr(msg) { this.msg = msg; }
  // Parse flags like -n 3, -n3, -3 (head/tail), -rn (combined)
  function runTool(words, input, hasInput) {
    var name = words[0], args = words.slice(1), flags = {}, rest = [], i;
    function needFile() {
      if (rest.length > 1) throw new ShErr(name + ': only one file is supported');
      if (rest.length === 1) {
        if (!Object.prototype.hasOwnProperty.call(FILES, rest[0])) throw new ShErr(name + ': ' + rest[0] + ': No such file or directory');
        return { text: FILES[rest[0]], file: rest[0] };
      }
      if (!hasInput) throw new ShErr(name + ': missing file operand');
      return { text: input, file: null };
    }
    var takesValue = { head: 'n', tail: 'n', cut: 'df' }[name] || '';
    for (i = 0; i < args.length; i++) {
      var a = args[i];
      if (/^-\d+$/.test(a) && (name === 'head' || name === 'tail')) { flags.n = a.slice(1); continue; }
      if (a.length > 1 && a[0] === '-' && rest.length === 0) {
        for (var k = 1; k < a.length; k++) {
          var f = a[k];
          if (takesValue.indexOf(f) >= 0) {
            var v = a.slice(k + 1);
            if (v === '') { i++; v = args[i]; }
            if (v === undefined) throw new ShErr(name + ': option requires an argument -- \'' + f + '\'');
            flags[f] = v; break;
          }
          flags[f] = true;
        }
        continue;
      }
      rest.push(a);
    }
    function onlyFlags(ok) { Object.keys(flags).forEach(function (f) { if (ok.indexOf(f) < 0) throw new ShErr(name + ": invalid option -- '" + f + "'"); }); }
    var src, lines, n;
    switch (name) {
      case 'cat': onlyFlags(''); src = needFile(); return src.text;
      case 'head': case 'tail':
        onlyFlags('n'); src = needFile(); lines = toLines(src.text);
        n = flags.n === undefined ? 10 : Number(flags.n);
        if (!isFinite(n) || n < 0 || String(flags.n === undefined ? 10 : flags.n).indexOf('.') >= 0) throw new ShErr(name + ": invalid number of lines: '" + flags.n + "'");
        return fromLines(name === 'head' ? lines.slice(0, n) : (n === 0 ? [] : lines.slice(-n)));
      case 'grep':
        onlyFlags('ivcn');
        if (!rest.length) throw new ShErr('grep: missing pattern');
        var pat = rest.shift(); src = needFile(); lines = toLines(src.text);
        var hit = [];
        lines.forEach(function (l, idx) {
          var m = flags.i ? l.toLowerCase().indexOf(pat.toLowerCase()) >= 0 : l.indexOf(pat) >= 0;
          if (flags.v ? !m : m) hit.push(flags.n ? (idx + 1) + ':' + l : l);
        });
        return flags.c ? hit.length + '\n' : fromLines(hit);
      case 'sort':
        onlyFlags('rnu'); src = needFile(); lines = toLines(src.text).slice();
        lines.sort(function (x, y) { return flags.n ? (leadNum(x) - leadNum(y) || cmpBytes(x, y)) : cmpBytes(x, y); });
        if (flags.r) lines.reverse();
        if (flags.u) lines = lines.filter(function (l, idx) { return idx === 0 || (flags.n ? leadNum(l) !== leadNum(lines[idx - 1]) : l !== lines[idx - 1]); });
        return fromLines(lines);
      case 'uniq':
        onlyFlags('c'); src = needFile(); lines = toLines(src.text);
        var groups = [];
        lines.forEach(function (l) { var g = groups[groups.length - 1]; if (g && g.l === l) g.c++; else groups.push({ l: l, c: 1 }); });
        return fromLines(groups.map(function (g) { return flags.c ? ('      ' + g.c).slice(-7) + ' ' + g.l : g.l; }));
      case 'wc':
        onlyFlags('lwc'); src = needFile();
        var cnt = { l: (src.text.match(/\n/g) || []).length, w: (src.text.match(/\S+/g) || []).length, c: src.text.length };
        var pick = ['l', 'w', 'c'].filter(function (f) { return flags[f]; });
        if (!pick.length) pick = ['l', 'w', 'c'];
        var nums = pick.map(function (f) { return String(cnt[f]); });
        return nums.join(' ') + (src.file ? ' ' + src.file : '') + '\n';
      case 'cut':
        onlyFlags('df');
        if (flags.f === undefined) throw new ShErr('cut: you must specify a list of fields');
        var delim = flags.d === undefined ? '\t' : flags.d;
        if (delim.length !== 1) throw new ShErr('cut: the delimiter must be a single character');
        var fields = String(flags.f).split(',').map(Number);
        if (fields.some(function (x) { return !Number.isInteger(x) || x < 1; })) throw new ShErr('cut: invalid field value');
        src = needFile();
        return fromLines(toLines(src.text).map(function (l) {
          if (l.indexOf(delim) < 0) return l;
          var parts = l.split(delim);
          return fields.slice().sort(function (x, y) { return x - y; }).filter(function (f) { return f <= parts.length; }).map(function (f) { return parts[f - 1]; }).join(delim);
        }));
      case 'rev': onlyFlags(''); src = needFile(); return fromLines(toLines(src.text).map(function (l) { return l.split('').reverse().join(''); }));
      case 'ls': onlyFlags('') ; return Object.keys(FILES).join('\n') + '\n';
      default: throw new ShErr('sh: ' + name + ': command not found');
    }
  }
  var textTools = {
    id: 'text',
    name: 'Text tools',
    tagline: 'A shell with one file. Can the model count?',
    file: { name: 'sales.txt', text: FILES['sales.txt'] },
    spec: [
      'You are a POSIX shell in a directory that holds exactly one file, sales.txt. The user types one command line; you print exactly what it outputs, nothing else.',
      'sales.txt is fixed and cannot change. Its exact content (10 lines, each ending in a newline):',
      SALES.join('\n'),
      'Available commands: ls, cat, head [-n N], tail [-n N], grep [-i] [-v] [-c] [-n] PATTERN, sort [-r] [-n] [-u], uniq [-c], wc [-l] [-w] [-c], cut -d CHAR -f LIST, rev. Commands can be joined with |.',
      'Rules: grep PATTERN is a plain substring, not a regular expression. sort compares bytes (uppercase sorts before lowercase). uniq -c prints the count right-aligned in 7 columns, a space, then the line. wc prints its numbers separated by spaces, then the file name if a file was named.',
      'Errors look like GNU coreutils, for example: grep: nope.txt: No such file or directory, or sh: foo: command not found.'
    ].join('\n'),
    probes: ['wc -l sales.txt', 'grep -c coffee sales.txt', 'grep -ic coffee sales.txt', "cut -d ' ' -f2 sales.txt | sort | uniq -c", "cut -d ' ' -f4 sales.txt | sort | uniq -c | sort -rn | head -n 1", 'sort -r sales.txt | head -n 3', 'tail -n 2 sales.txt | rev', 'wc sales.txt', "grep -v coffee sales.txt | cut -d ' ' -f3"],
    init: function () { return null; },
    run: function (state, line) {
      var input = '', hasInput = false, out;
      try {
        var segs = splitPipes(line);
        if (segs.some(function (s) { return !s; })) throw new ShErr('sh: syntax error near unexpected token `|\'');
        segs.forEach(function (seg) {
          var w = shWords(seg);
          input = runTool(w, input, hasInput); hasInput = true;
        });
        out = input.replace(/\n$/, '');
      } catch (e) {
        if (!(e instanceof ShErr)) throw e;
        out = e.msg;
      }
      return { out: out, state: state };
    },
    same: sameText
  };

  var NO_OUTPUT = '(no output)';
  var RULES = 'Reply with exactly what the machine prints for the last line and nothing else: no explanation, no prompt, no code fence. If it prints nothing, reply exactly: ' + NO_OUTPUT;

  // Run one line on the real machine. Empty output is shown as NO_OUTPUT, the same token the double is told to use.
  function runReal(machine, state, line) {
    var r = machine.run(state, line);
    return { out: r.out === '' ? NO_OUTPUT : r.out, state: r.state };
  }

  // Chat messages for one model. steps: [{ input, real, reply }] already played.
  // mode 'dream': the double sees its own earlier replies (its own world).
  // mode 'coached': it sees what the real machine printed instead.
  function buildMessages(machine, steps, mode, input) {
    var msgs = [{ role: 'system', content: machine.spec + '\n\n' + RULES }];
    steps.forEach(function (s) {
      msgs.push({ role: 'user', content: s.input });
      var mine = s.reply == null || s.reply === '' ? s.real : s.reply;
      msgs.push({ role: 'assistant', content: mode === 'coached' ? s.real : mine });
    });
    msgs.push({ role: 'user', content: input });
    return msgs;
  }

  var api = {
    NO_OUTPUT: NO_OUTPUT,
    runReal: runReal,
    buildMessages: buildMessages,
    list: [calculator, kv, textTools],
    byId: { calculator: calculator, kv: kv, text: textTools },
    cleanReply: cleanReply,
    diffLines: diffLines,
    normLines: normLines,
    _calcEval: calcEval, _formatRat: formatRat
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MD = root.MD || {}; root.MD.machines = api; }
})(typeof window !== 'undefined' ? window : this);
