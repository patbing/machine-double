/* Machine Double UI. Model text is only ever placed with textContent. */
(function () {
  'use strict';
  var C = MD.config, M = MD.machines, N = MD.net;
  var PROMPTS = { calculator: '>', kv: 'kv>', text: '$' };

  var app = {
    machine: M.list[0], key: null, models: [], byId: {}, picked: [], mode: 'dream',
    sessions: {}, busy: false, ctrl: null, spent: 0, tapes: null, playing: null,
    connectUnavailable: false, histPos: null, modelsError: false
  };
  MD.app = app; // handy in the console

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (k) { if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return e;
  }
  function sess(id) {
    id = id || app.machine.id;
    return app.sessions[id] || (app.sessions[id] = { state: M.byId[id].init(), steps: [], recorded: null });
  }
  function fmtP(p) { return p == null ? '' : (p < 0.01 ? p.toFixed(6).replace(/0+$/, '') : p.toFixed(4)) + ' P'; }
  function titleOf(id) { var m = app.byId[id]; return m ? m.title : id; }

  // ---------- connect ----------
  (function () {
    var c = $('connect');
    c.setAttribute('app-key', C.APP_KEY);
    c.setAttribute('menu-links', JSON.stringify([{ label: 'Source code', href: C.REPO_URL }]));
  })();
  function readKey(c, e) {
    var k = (c && c.apiKey) || (e && e.detail && (e.detail.apiKey || e.detail.key)) || null;
    return typeof k === 'string' && k ? k : null;
  }
  function wireConnect() {
    var c = $('connect');
    Promise.race([customElements.whenDefined('polli-connect'), new Promise(function (r) { setTimeout(r, 8000); })]).then(function () {
      if (!customElements.get('polli-connect')) { app.connectUnavailable = true; c.hidden = true; $('connect-fallback').hidden = false; }
      onKey(readKey(c));
    });
    c.addEventListener('change', function (e) { onKey(readKey(c, e)); });
  }
  function onKey(k) {
    if (k === app.key) return;
    app.key = k;
    if (!k && app.ctrl) app.ctrl.abort();
    if (k && !app.picked.length) pickDefaults();
    render();
  }
  function pickDefaults() {
    var ids = C.DEFAULT_MODELS.filter(function (id) { return app.byId[id]; });
    if (!ids.length) ids = app.models.filter(function (m) { return !m.paidOnly; }).slice(0, C.MAX_DOUBLES).map(function (m) { return m.id; });
    app.picked = ids.slice(0, C.MAX_DOUBLES);
  }

  // ---------- running a line ----------
  function historyFor(id, steps) {
    return steps.map(function (st) {
      var r = st.replies[id];
      return { input: st.input, real: st.real, reply: r && r.status === 'ok' ? r.text : null };
    });
  }
  function run(input) {
    input = String(input || '').trim();
    if (!input || app.busy || app.playing) return;
    var s = sess(), mc = app.machine;
    if (s.recorded) { s.steps = []; s.state = mc.init(); s.recorded = null; }
    var real = M.runReal(mc, s.state, input);
    s.state = real.state;
    var prior = s.steps.slice();
    var step = { input: input, real: real.out, replies: {}, doubles: app.key ? app.picked.slice() : [] };
    s.steps.push(step);
    app.histPos = null;
    if (!step.doubles.length) { render(); return; }
    app.busy = true;
    app.ctrl = new AbortController();
    var signal = app.ctrl.signal;
    step.doubles.forEach(function (id) { step.replies[id] = { status: 'pending' }; });
    render();
    Promise.all(step.doubles.map(function (id) {
      var model = app.byId[id];
      var msgs = M.buildMessages(mc, historyFor(id, prior), app.mode, input);
      return N.ask(app.key, model, msgs, signal).then(function (r) {
        var cell = { ms: r.ms, cost: r.cost == null ? null : r.cost };
        if (r.ok) {
          var text = M.cleanReply(r.text);
          if (!text) { cell.status = 'error'; cell.error = r.finish === 'length' ? 'empty reply (ran out of tokens)' : 'empty reply'; }
          else { cell.status = 'ok'; cell.text = text; cell.match = mc.same(step.real, text); }
        } else {
          cell.status = r.cancelled ? 'cancelled' : 'error';
          cell.error = r.status === 402 || /balance|insufficient|budget/i.test(r.error) ? 'out of Pollen for this key (' + r.error + ')' : r.error;
        }
        if (cell.cost) app.spent += cell.cost;
        step.replies[id] = cell;
        renderLedger(); renderScore(); renderTop();
      });
    })).then(function () {
      app.busy = false; app.ctrl = null;
      render();
      $('cmd').focus();
    });
  }

  // ---------- recordings ----------
  function loadTapes() {
    if (location.protocol === 'file:') { app.tapes = []; return Promise.resolve(); }
    return fetch('recordings/tapes.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        app.tapes = (j && j.app === 'machine-double' && j.tapes) || [];
        app.tapes.forEach(function (t) { t.recordedAt = t.recordedAt || j.recordedAt || ''; });
      })
      .catch(function () { app.tapes = []; });
  }
  function tapeFor(machineId) { return (app.tapes || []).filter(function (t) { return t.machine === machineId; })[0] || null; }
  function play() {
    if (app.playing) { stopPlay(); return; }
    var t = tapeFor(app.machine.id);
    if (!t || app.busy) return;
    var mc = app.machine, s = sess();
    s.steps = []; s.state = mc.init(); s.recorded = t;
    t.models.forEach(function (m) { if (!app.byId[m.id]) app.byId[m.id] = { id: m.id, title: m.title }; });
    var i = 0;
    app.playing = setInterval(function () {
      if (i >= t.steps.length) { stopPlay(); return; }
      var ts = t.steps[i++];
      var real = M.runReal(mc, s.state, ts.input); // re-run: the referee is live code, not a recording
      s.state = real.state;
      var step = { input: ts.input, real: real.out, replies: {}, doubles: t.models.map(function (m) { return m.id; }) };
      step.doubles.forEach(function (id) {
        var r = ts.replies[id];
        if (!r) return;
        var txt = r.text != null ? M.cleanReply(r.text) : null;
        step.replies[id] = txt ? { status: 'ok', text: txt, ms: r.ms, cost: r.cost, match: mc.same(real.out, txt) } : { status: 'error', error: r.error || 'no reply', ms: r.ms };
      });
      s.steps.push(step);
      render();
    }, 650);
    render();
  }
  function stopPlay() { clearInterval(app.playing); app.playing = null; render(); }

  // ---------- rendering ----------
  function renderTop() {
    var sp = $('spent');
    sp.hidden = !app.spent;
    sp.textContent = 'Spent ' + fmtP(app.spent);
  }
  function renderMachines() {
    var nav = $('machines'); nav.textContent = '';
    M.list.forEach(function (m) {
      nav.appendChild(el('button', {
        type: 'button', class: 'mtab' + (m === app.machine ? ' on' : ''), 'aria-pressed': m === app.machine ? 'true' : 'false',
        onclick: function () { if (app.busy) return; if (app.playing) stopPlay(); app.machine = m; app.histPos = null; render(); $('cmd').focus(); }
      }, [el('span', { class: 'mname', text: m.name }), el('span', { class: 'mtag', text: m.tagline })]));
    });
  }
  function renderSetup() {
    var box = $('picked'); box.textContent = '';
    app.picked.forEach(function (id) {
      box.appendChild(el('span', { class: 'chip model' }, [titleOf(id), el('button', {
        type: 'button', class: 'x', 'aria-label': 'Remove ' + titleOf(id), disabled: app.busy,
        onclick: function () { app.picked = app.picked.filter(function (x) { return x !== id; }); render(); }
      }, ['×'])]));
    });
    if (!app.picked.length) box.appendChild(el('span', { class: 'muted', text: app.key ? 'none: only the real machine will answer' : 'connect to bring models' }));
    var sel = $('add-model'); sel.textContent = '';
    var full = app.picked.length >= C.MAX_DOUBLES;
    sel.appendChild(el('option', { value: '', text: full ? 'Up to ' + C.MAX_DOUBLES + ' models' : app.modelsError ? 'Model list unavailable' : '+ Add a model' }));
    app.models.forEach(function (m) {
      if (app.picked.indexOf(m.id) >= 0) return;
      var per = (1500 * m.inPrice + 60 * m.outPrice);
      sel.appendChild(el('option', { value: m.id, text: m.title + ' · ~' + fmtP(per) + '/line' + (m.paidOnly ? ' · paid Pollen only' : '') }));
    });
    sel.disabled = full || app.busy || !app.models.length;
    document.querySelectorAll('input[name=mode]').forEach(function (r) { r.checked = r.value === app.mode; r.disabled = app.busy; });
    var t = tapeFor(app.machine.id);
    var pb = $('play');
    pb.hidden = !t;
    pb.textContent = app.playing ? 'Stop' : 'Play a recording';
    pb.disabled = app.busy;
    $('reset').disabled = app.busy;

    var n = $('notice'), s = sess();
    if (s.recorded) n.textContent = 'Recorded run from ' + s.recorded.recordedAt.slice(0, 10) + ': real replies from ' + s.recorded.models.length + ' models, ' + (s.recorded.mode === 'coached' ? 'Coached' : 'Dream') + ' memory. The real machine re-runs every line live. Nothing is charged.';
    else if (app.connectUnavailable) n.textContent = 'Sign-in did not load. You can still type into the real machine and play recordings.';
    else if (!app.key) n.textContent = 'Not connected: the real machine answers alone. Connect to bring model doubles (you pay with your own Pollen), or play a recording for free.';
    else n.textContent = '';
    n.hidden = !n.textContent;
  }
  function scoreOf(steps, id) {
    var sc = { n: 0, hit: 0, slip: null, err: 0, cost: 0 };
    steps.forEach(function (st, i) {
      var r = st.replies[id];
      if (!r) return;
      if (r.cost) sc.cost += r.cost;
      if (r.status === 'error') sc.err++;
      if (r.status !== 'ok') return;
      sc.n++;
      if (r.match) sc.hit++; else if (sc.slip === null) sc.slip = i + 1;
    });
    return sc;
  }
  function renderScore() {
    var box = $('score'); box.textContent = '';
    var s = sess();
    var ids = [];
    s.steps.forEach(function (st) { st.doubles.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
    box.hidden = !ids.length;
    ids.forEach(function (id) {
      var sc = scoreOf(s.steps, id);
      var pct = sc.n ? Math.round(100 * sc.hit / sc.n) : 0;
      box.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'cname', text: titleOf(id) }),
        el('div', { class: 'big' }, [el('b', { text: sc.hit + '/' + sc.n }), ' lines right']),
        el('div', { class: 'bar', role: 'img', 'aria-label': pct + '% right' }, [el('i', { style: 'width:' + pct + '%' })]),
        el('div', { class: 'small', text: (sc.slip ? 'First slip at line ' + sc.slip : sc.n ? 'No slips yet' : 'Waiting') + (sc.err ? ' · ' + sc.err + ' failed' : '') + (sc.cost ? ' · ' + fmtP(sc.cost) : '') })
      ]));
    });
  }
  function outBlock(text, badLines) {
    var pre = el('pre', { class: 'out' });
    String(text).split('\n').forEach(function (line, i, arr) {
      var span = el('span', { class: badLines && badLines.indexOf(i) >= 0 ? 'bad' : null, text: line });
      pre.appendChild(span);
      if (i < arr.length - 1) pre.appendChild(document.createTextNode('\n'));
    });
    return pre;
  }
  function badIndexes(real, text) {
    // Map normalised line differences back to the raw lines of the reply.
    var d = M.diffLines(real, text, app.machine.canon), raw = String(text).split('\n'), out = [], k = 0;
    raw.forEach(function (l, i) { if (l.trim() === '' && (k === 0 || k >= d.doubleLines.length)) return; if (d.bad.indexOf(k) >= 0) out.push(i); k++; });
    return { idx: out, missing: d.missing };
  }
  function renderLedger() {
    var box = $('ledger'), s = sess(), mc = app.machine;
    box.textContent = '';
    if (!s.steps.length) {
      box.appendChild(el('div', { class: 'empty' }, [
        el('p', { class: 'big', text: mc.name + ': ' + mc.tagline }),
        el('p', { text: 'Type a line below or pick one under "Try". The real machine answers on the left; each model double answers next to it and every line it gets wrong is marked.' })
      ]));
      return;
    }
    s.steps.forEach(function (st, i) {
      var cols = [el('section', { class: 'col real' }, [el('h4', { text: 'Real machine' }), outBlock(st.real)])];
      st.doubles.forEach(function (id) {
        var r = st.replies[id] || { status: 'missing' };
        var cls = 'col dbl ' + (r.status === 'ok' ? (r.match ? 'hit' : 'miss') : r.status);
        var verdict = r.status === 'ok' ? (r.match ? 'same' : 'slipped') : r.status === 'pending' ? 'thinking' : r.status === 'cancelled' ? 'cancelled' : 'no answer';
        var body;
        if (r.status === 'ok') { var b = badIndexes(st.real, r.text); body = [outBlock(r.text, r.match ? null : b.idx), b.missing && !r.match ? el('p', { class: 'missing', text: b.missing + ' line' + (b.missing > 1 ? 's' : '') + ' missing' }) : null]; }
        else if (r.status === 'pending') body = [el('pre', { class: 'out pending', text: '…' })];
        else body = [el('p', { class: 'err', text: r.error || 'no reply' })];
        var meta = [r.ms ? (r.ms / 1000).toFixed(1) + ' s' : '', r.cost ? fmtP(r.cost) : ''].filter(Boolean).join(' · ');
        cols.push(el('section', { class: cls }, [
          el('h4', null, [el('span', { class: 'who', text: titleOf(id) }), el('span', { class: 'verdict', text: verdict })])
        ].concat(body, [meta ? el('p', { class: 'meta', text: meta }) : null])));
      });
      box.appendChild(el('article', { class: 'step' }, [
        el('header', null, [el('span', { class: 'n', text: '#' + (i + 1) }), el('code', { class: 'cmd', text: PROMPTS[mc.id] + ' ' + st.input })]),
        el('div', { class: 'cols', style: '--n:' + cols.length }, cols)
      ]));
    });
    box.scrollTop = box.scrollHeight; // scroll the ledger only, never the page
  }
  function renderSide() {
    var mc = app.machine;
    $('spec').textContent = M.buildMessages(mc, [], app.mode, '')[0].content;
    $('file-box').hidden = !mc.file;
    if (mc.file) $('file').textContent = mc.file.text;
    $('prompt').textContent = PROMPTS[mc.id];
    var pr = $('probes'); pr.textContent = '';
    mc.probes.forEach(function (p) {
      pr.appendChild(el('button', { type: 'button', class: 'chip probe', disabled: app.busy || !!app.playing, text: p, onclick: function () { run(p); } }));
    });
    var busy = app.busy || !!app.playing;
    $('cmd').disabled = busy; $('run').disabled = busy;
    $('run').textContent = app.busy ? 'Waiting' : 'Run';
    // Rough price of the next line: the whole session is resent each time.
    var est = $('estimate');
    if (app.key && app.picked.length) {
      var chars = M.buildMessages(mc, historyFor('', sess().steps), app.mode, 'x').reduce(function (a, m) { return a + m.content.length; }, 0);
      var p = app.picked.reduce(function (a, id) { var m = app.byId[id]; return a + (m && m.inPrice != null ? (chars / 3.5) * m.inPrice + 80 * m.outPrice : 0); }, 0);
      est.textContent = 'Next line ≈ ' + fmtP(p) + ' for ' + app.picked.length + ' model' + (app.picked.length > 1 ? 's' : '') + ' (your Pollen). The session so far is sent each time.';
    } else est.textContent = '';
  }
  function render() { renderTop(); renderMachines(); renderSetup(); renderScore(); renderLedger(); renderSide(); }

  // ---------- events ----------
  $('cmdform').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('cmd').value;
    if (!v.trim()) return;
    $('cmd').value = '';
    run(v);
  });
  $('cmd').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    var past = sess().steps.map(function (s) { return s.input; });
    if (!past.length) return;
    e.preventDefault();
    if (app.histPos === null) app.histPos = past.length;
    app.histPos = Math.max(0, Math.min(past.length, app.histPos + (e.key === 'ArrowUp' ? -1 : 1)));
    e.target.value = past[app.histPos] || '';
  });
  $('add-model').addEventListener('change', function (e) {
    var id = e.target.value;
    if (id && app.picked.length < C.MAX_DOUBLES && app.picked.indexOf(id) < 0) app.picked.push(id);
    render();
  });
  document.querySelectorAll('input[name=mode]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) { app.mode = r.value; render(); } });
  });
  $('play').addEventListener('click', play);
  $('reset').addEventListener('click', function () {
    if (app.playing) stopPlay();
    app.sessions[app.machine.id] = null; render(); $('cmd').focus();
  });

  // ---------- start ----------
  var q = new URLSearchParams(location.search);
  if (q.get('machine') && M.byId[q.get('machine')]) app.machine = M.byId[q.get('machine')];
  render();
  N.listModels().then(function (list) {
    app.models = list;
    list.forEach(function (m) { app.byId[m.id] = m; });
    if (app.key && !app.picked.length) pickDefaults();
    render();
  }).catch(function () { app.modelsError = true; render(); });
  loadTapes().then(function () {
    render();
    if (q.get('play') === '1' && !app.key) play();
  });
  if (typeof customElements !== 'undefined') wireConnect(); else { app.connectUnavailable = true; render(); }
})();
