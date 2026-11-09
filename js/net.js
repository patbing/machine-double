/* All network access lives here.
 *   GET  https://gen.pollinations.ai/v1/models            (text models and their per-token prices)
 *   POST https://gen.pollinations.ai/v1/chat/completions  (the model double's reply)
 * The user's sk_ key is passed in as an argument; it is never logged or stored by this app.
 */
(function () {
  'use strict';
  var C = window.MD.config;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function listModels() {
    return fetch(C.API + '/v1/models', { credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var arr = (j && (j.data || j.models)) || [];
      return arr.filter(function (m) {
        var eps = m.supported_endpoints || [];
        var p = m.pricing || {};
        return m.category === 'text' && !m.community && eps.indexOf('/v1/chat/completions') >= 0 &&
          p.completionTextTokens && !(m.health && m.health.status === 'down');
      }).map(function (m) {
        var p = m.pricing;
        return {
          id: m.id, title: m.title || m.id, owner: m.owned_by || '',
          inPrice: num(p.promptTextTokens), outPrice: num(p.completionTextTokens),
          paidOnly: !!m.paid_only,
          effort: (m.supported_parameters || []).indexOf('reasoning_effort') >= 0
        };
      }).sort(function (a, b) { return (a.inPrice + a.outPrice) - (b.inPrice + b.outPrice); });
    });
  }

  function costOf(model, usage) {
    if (!model || !usage) return null;
    var pt = usage.prompt_tokens, ct = usage.completion_tokens;
    if (!Number.isFinite(pt) || !Number.isFinite(ct)) return null;
    return pt * model.inPrice + ct * model.outPrice;
  }

  function once(key, body, signal) {
    var ctrl = new AbortController(), timedOut = false, t0 = Date.now();
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, C.TIMEOUT_MS);
    function stop() { ctrl.abort(); }
    if (signal) signal.addEventListener('abort', stop, { once: true });
    return fetch(C.API + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', signal: ctrl.signal
    }).then(function (res) {
      return res.text().then(function (txt) {
        var j = null; try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
        var ms = Date.now() - t0;
        if (!res.ok) {
          var msg = (j && j.error && (j.error.message || j.error)) || txt.slice(0, 200) || ('HTTP ' + res.status);
          return { ok: false, status: res.status, ms: ms, error: String(msg), retryAfter: num(res.headers.get('Retry-After')) };
        }
        var choice = j && j.choices && j.choices[0];
        var text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
        return { ok: true, status: res.status, ms: ms, text: text, usage: j && j.usage, finish: choice && choice.finish_reason };
      });
    }).catch(function (e) {
      var ms = Date.now() - t0;
      if (signal && signal.aborted) return { ok: false, status: 0, ms: ms, error: 'cancelled', cancelled: true };
      return { ok: false, status: 0, ms: ms, error: timedOut ? 'timed out' : String((e && e.message) || e) };
    }).then(function (r) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      return r;
    });
  }

  // One retry for network errors, timeouts, 429 and 5xx.
  function ask(key, model, messages, signal) {
    var body = { model: model.id, messages: messages, max_tokens: C.MAX_TOKENS };
    if (model.effort) body.reasoning_effort = 'low';
    return once(key, body, signal).then(function (r) {
      var retry = !r.ok && !r.cancelled && (r.status === 0 || r.status === 429 || r.status >= 500);
      if (!retry) return r;
      var wait = r.status === 429 ? Math.min((r.retryAfter || 3) * 1000, 15000) : 1500;
      return new Promise(function (ok) { setTimeout(ok, wait); }).then(function () { return once(key, body, signal); });
    }).then(function (r) {
      if (r.ok) r.cost = costOf(model, r.usage);
      return r;
    });
  }

  window.MD.net = { listModels: listModels, ask: ask, costOf: costOf };
})();
