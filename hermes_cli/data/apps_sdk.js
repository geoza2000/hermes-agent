// Hermes Apps runtime, injected into every app page (served as <base>_hermes/sdk.js).
// Kept small and dependency-free: it runs inside every app. Values typed into fields are
// never read unless the owner turned on capture_values for this app.
(() => {
  const script = document.currentScript;
  const cfg = script ? script.dataset : {};
  const base = cfg.hermesBase || './';
  const telemetry = cfg.hermesTelemetry === '1';
  const captureValues = cfg.hermesValues === '1';
  const dataEnabled = cfg.hermesData === '1';
  const session = Math.random().toString(36).slice(2, 12);
  const queue = [];
  let timer = null;

  const send = (events, keepalive) => {
    if (!events.length) return;
    try {
      fetch(base + '_hermes/events', {
        method: 'POST', mode: 'cors', credentials: 'omit', keepalive: Boolean(keepalive),
        headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ events })
      }).catch(() => {});
    } catch (_) {}
  };
  const flush = keepalive => { clearTimeout(timer); timer = null; send(queue.splice(0, 100), keepalive); };
  const push = event => {
    if (!telemetry) return;
    queue.push(Object.assign({ ts: Date.now(), session }, event));
    if (queue.length >= 20) flush(false);
    else if (!timer) timer = setTimeout(() => flush(false), 5000);
  };

  const label = el => {
    if (!el || el.nodeType !== 1) return '';
    const own = el.getAttribute('data-track') || el.getAttribute('aria-label') || el.id || el.getAttribute('name');
    if (own) return String(own).slice(0, 80);
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (text) return tag + ': ' + text;
    }
    return tag;
  };
  const fieldLabel = el => label(el) !== el.tagName.toLowerCase() ? label(el) : (el.getAttribute('placeholder') || label(el));

  document.addEventListener('click', ev => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-track],button,a,[role=button],input[type=checkbox],input[type=radio]') : null;
    if (el) push({ type: 'click', target: label(el) });
  }, true);
  document.addEventListener('change', ev => {
    const el = ev.target;
    if (!el || !el.tagName) return;
    const props = { field: (el.type || el.tagName).toString().toLowerCase() };
    if (captureValues && 'value' in el && el.type !== 'password') props.value = String(el.value).slice(0, 200);
    push({ type: 'change', target: fieldLabel(el), props });
  }, true);
  document.addEventListener('submit', ev => push({ type: 'submit', target: label(ev.target) }), true);
  window.addEventListener('hashchange', () => push({ type: 'navigate', target: location.hash.split('?')[0] || '#' }));
  window.addEventListener('error', ev => push({ type: 'error', target: String(ev.message || 'error').slice(0, 200) }));
  window.addEventListener('unhandledrejection', ev => push({ type: 'error', target: String((ev.reason && ev.reason.message) || ev.reason || 'rejection').slice(0, 200) }));
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.duration > 300) push({ type: 'slow', target: 'longtask', props: { ms: Math.round(entry.duration) } });
    }).observe({ type: 'longtask', buffered: true });
  } catch (_) {}
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', () => flush(true));
  push({ type: 'view', target: location.pathname.split('/').slice(-1)[0] || 'index' });

  const dataUrl = key => base + '_hermes/data/' + encodeURIComponent(key);
  const needData = () => { if (!dataEnabled) throw new Error('App data is not available to this viewer'); };
  const json = async res => {
    if (!res.ok) throw new Error('Hermes app data request failed: ' + res.status);
    return res.json();
  };
  const data = {
    async get(key) { needData(); return (await json(await fetch(dataUrl(key), { credentials: 'omit' }))).value; },
    async set(key, value) {
      needData();
      return (await json(await fetch(dataUrl(key), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(value) }))).value;
    },
    async delete(key) { needData(); return (await json(await fetch(base + '_hermes/data-delete/' + encodeURIComponent(key), { method: 'POST', credentials: 'omit' }))).deleted; },
    async keys() { needData(); return (await json(await fetch(base + '_hermes/data', { credentials: 'omit' }))).keys; }
  };

  // ── Hermes sessions: hand a prompt, files and context to this app's Hermes session ─────────
  const sessionsUrl = base + '_hermes/sessions';
  const call = async (url, opts) => {
    const res = await fetch(url, Object.assign({ credentials: 'omit' }, opts || {}));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || ('Hermes request failed: ' + res.status)), { status: res.status });
    return body;
  };
  const postJson = (url, payload) => call(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  class Job {
    constructor(data) { this._set(data); }
    _set(data) { Object.assign(this, data); return this; }
    get done() { return this.status === 'done' || this.status === 'failed'; }
    async refresh() { return this._set((await call(sessionsUrl + '/' + this.id)).session); }
    async answer(answers) { return this._set((await postJson(sessionsUrl + '/' + this.id + '/answer', { answers })).session); }
    async send(message) { return this._set((await postJson(sessionsUrl + '/' + this.id + '/message', { message })).session); }
    async wait(options) {
      const opts = Object.assign({ interval: 1000, onQuestion: ui.question }, options || {});
      let seen = '';
      let asked = null;
      for (;;) {
        await this.refresh();
        const signature = this.updated_at + ':' + this.status;
        if (signature !== seen) { seen = signature; if (opts.onUpdate) opts.onUpdate(this); }
        if (this.status === 'needs_input' && this.question && this.question.ask_id !== asked && opts.onQuestion) {
          asked = this.question.ask_id;
          const answers = await opts.onQuestion(this.question, this);
          if (answers) await this.answer(answers);
          continue;
        }
        if (this.done) return this;
        await sleep(opts.interval);
      }
    }
  }

  const needOwner = () => { if (!dataEnabled) throw new Error('Hermes sessions are only available to the app owner'); };
  const sessions = {
    available: dataEnabled,
    async start(request) {
      needOwner();
      const r = request || {};
      const files = Array.from(r.files || []);
      if (!files.length) return new Job((await postJson(sessionsUrl, { prompt: r.prompt || '', context: r.context || null })).session);
      const form = new FormData();
      form.append('prompt', r.prompt || '');
      if (r.context) form.append('context', JSON.stringify(r.context));
      files.forEach((file, i) => form.append('files', file, file.name || ('file-' + (i + 1))));
      return new Job((await call(sessionsUrl, { method: 'POST', body: form })).session);
    },
    async run(request, waitOptions) { return (await sessions.start(request)).wait(waitOptions); },
    async get(id) { needOwner(); return new Job((await call(sessionsUrl + '/' + encodeURIComponent(id))).session); },
    async list() { needOwner(); return (await call(sessionsUrl)).sessions.map(item => new Job(item)); }
  };

  // Default question form for session.wait(): one card per question, choices + "Other".
  const ui = {
    question(ask) {
      return new Promise(resolve => {
        const wrap = document.createElement('div');
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.45);display:grid;place-items:center;padding:16px;font:15px/1.4 system-ui,sans-serif';
        const card = document.createElement('form');
        card.style.cssText = 'background:#fff;color:#141a2b;border-radius:16px;max-width:460px;width:100%;max-height:90vh;overflow:auto;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.25)';
        const heading = document.createElement('div');
        heading.textContent = 'Hermes needs your input';
        heading.style.cssText = 'font-weight:700;font-size:17px;margin-bottom:10px';
        card.appendChild(heading);
        const readers = [];
        ask.questions.forEach(q => {
          const box = document.createElement('fieldset');
          box.style.cssText = 'border:0;margin:0 0 14px;padding:0';
          const legend = document.createElement('legend');
          legend.textContent = q.question;
          legend.style.cssText = 'font-weight:600;margin-bottom:6px';
          box.appendChild(legend);
          const other = document.createElement('input');
          other.placeholder = (q.choices && q.choices.length) ? 'Other…' : 'Your answer';
          other.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;border:1px solid #d5ddef;border-radius:10px;font:inherit;min-height:44px;margin-top:4px';
          (q.choices || []).forEach((choice, i) => {
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:8px 2px;min-height:36px';
            const input = document.createElement('input');
            input.type = q.multi_select ? 'checkbox' : 'radio';
            input.name = q.qid;
            input.value = choice;
            if (i === 0 && !q.multi_select) input.checked = true;
            row.appendChild(input);
            row.appendChild(document.createTextNode(choice + (i === 0 && q.choices.length > 1 ? ' (recommended)' : '')));
            box.appendChild(row);
          });
          box.appendChild(other);
          card.appendChild(box);
          readers.push(() => {
            const picked = Array.from(box.querySelectorAll('input[name="' + q.qid + '"]:checked')).map(el => el.value);
            const typed = other.value.trim();
            if (q.multi_select) return [q.qid, typed ? picked.concat([typed]) : picked];
            return [q.qid, typed || picked[0] || null];
          });
        });
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = 'Send';
        submit.style.cssText = 'width:100%;min-height:44px;border:0;border-radius:10px;background:#1540b1;color:#fff;font:inherit;font-weight:600';
        card.appendChild(submit);
        card.addEventListener('submit', ev => { ev.preventDefault(); wrap.remove(); resolve(Object.fromEntries(readers.map(read => read()))); });
        wrap.appendChild(card);
        document.body.appendChild(wrap);
        submit.focus();
      });
    }
  };

  window.hermes = Object.freeze({
    viewer: cfg.hermesViewer || 'owner',
    telemetry,
    track(name, props) { push({ type: 'custom', name: String(name || 'event').slice(0, 60), props: props || {} }); },
    data: Object.freeze(data),
    session: Object.freeze(sessions),
    ui: Object.freeze(ui),
    flush: () => flush(false)
  });
})();
