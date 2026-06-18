/**
 * Dev-only email preview tool. Backs the `/__toil/emails*` endpoints (wired in
 * `plugin.ts`): a standalone page that lists `emails/*.tsx`, renders the selected
 * one through the live Vite SSR server (so edits and imported `client/*` CSS show
 * up), and fills `{{token}}` holes from inputs the same way the edge does at send
 * time. Build-path parity comes from sharing `renderEmailFile` with the codegen
 * pass (`emails.ts`), so what you preview is what gets baked into `server/_emails.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ViteDevServer } from 'vite';

import type { ResolvedToilConfig } from './config.js';
import { type RenderedEmail, renderEmailFile, toPascal } from './emails.js';

/** One discoverable email: its generated `Emails.<name>` and its absolute file. */
export interface EmailListItem {
    name: string;
    /** Absolute path, used for "open in editor" (`/__toil/open?file=`). */
    file: string;
}

/** The `emails/` dir for a project (sibling of `client/` and `server/`). */
export function emailsDir(cfg: ResolvedToilConfig): string {
    return path.join(cfg.root, 'emails');
}

/**
 * A cheap change fingerprint (`<newestMtime>:<fileCount>`) over `emails/*.tsx|jsx`
 * and the project's client CSS, polled by the preview page to detect edits (any
 * save bumps an mtime to ~now; add/remove changes the count). Stat-only, so it is
 * fine to poll ~1/s. Used instead of a long-lived stream, which the buffering wasm
 * dev proxy can't forward.
 */
export function emailsVersion(cfg: ResolvedToilConfig): string {
    let newest = 0;
    let count = 0;
    const CSS = /\.(css|scss|sass|less|styl|pcss|postcss)$/;
    const walk = (dir: string, match: RegExp): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== 'node_modules') walk(full, match);
            } else if (match.test(e.name)) {
                try {
                    const m = fs.statSync(full).mtimeMs;
                    if (m > newest) newest = m;
                    count++;
                } catch {
                    // file vanished between readdir and stat; ignore
                }
            }
        }
    };
    // Email templates and any styles beside them (emails/styles/*), plus client
    // CSS in case an email reuses `client/styles/*`.
    walk(emailsDir(cfg), /\.(tsx|jsx|css|scss|sass|less|styl|pcss|postcss)$/);
    walk(cfg.clientAbsDir, CSS);
    return `${String(newest)}:${String(count)}`;
}

/** List `emails/*.tsx|jsx`, mapped to their generated names. Cheap (no render). */
export function listEmails(cfg: ResolvedToilConfig): EmailListItem[] {
    const dir = emailsDir(cfg);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => /\.(tsx|jsx)$/.test(f))
        .sort()
        .map((f) => ({
            name: toPascal(path.basename(f).replace(/\.(tsx|jsx)$/, '')),
            file: path.join(dir, f),
        }));
}

/**
 * Render the email whose generated name is `name` through the live SSR server,
 * or `null` if there is no such file. Drops the module from the SSR cache first
 * so an edit is reflected on every request (the watcher also invalidates on save;
 * this makes a manual refresh fresh too).
 */
export async function renderEmailByName(
    server: ViteDevServer,
    cfg: ResolvedToilConfig,
    name: string,
): Promise<RenderedEmail | null> {
    const item = listEmails(cfg).find((e) => e.name === name);
    if (!item) return null;
    const node =
        server.moduleGraph.getModuleById(item.file) ??
        (await server.moduleGraph.getModuleByUrl(item.file));
    if (node) server.moduleGraph.invalidateModule(node);
    const { renderToStaticMarkup } = await import('react-dom/server');
    return renderEmailFile(
        server,
        emailsDir(cfg),
        path.basename(item.file),
        renderToStaticMarkup as (el: unknown) => string,
    );
}

/**
 * The self-contained preview page (served at `/__toil/emails`). Plain HTML + a
 * tiny inline script -- no client-runtime dependency, so it works in both the
 * client-only and wasm-server dev modes. Token substitution happens here in the
 * browser (`{{token}}` -> input value), so typing is instant and the iframe shows
 * exactly the edge's hole-fill path.
 */
export function previewShellHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Email preview, toiljs</title>
<style>
  /* Matches the toiljs demo brand (examples/basic/client/styles/main.css). */
  :root {
    color-scheme: dark;
    --bg: #080d11; --surface: #0e1520; --surface2: #131d2e; --border: #1b2330;
    --text: #f5f6fa; --muted: #8b9ab4; --accent: #2563ff; --accent3: #22e3ab;
  }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); }
  #side { width: 248px; flex: 0 0 auto; border-right: 1px solid var(--border); display: flex; flex-direction: column; background: var(--surface); }
  .brand { display: flex; align-items: center; gap: 10px; padding: 15px 16px; font-family: 'Montserrat', system-ui, sans-serif; font-weight: 800; font-size: 15px; letter-spacing: -0.01em; border-bottom: 1px solid var(--border); }
  .brand .mark { width: 26px; height: 26px; flex: 0 0 auto; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; background: linear-gradient(135deg, var(--accent), #7c3aed 55%, var(--accent3)); }
  #list { list-style: none; margin: 0; padding: 8px; overflow: auto; flex: 1; }
  #list li { padding: 8px 11px; border-radius: 8px; cursor: pointer; color: var(--muted); transition: background 150ms, color 150ms; }
  #list li:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  #list li.on { background: rgba(37,99,255,0.14); color: #fff; box-shadow: inset 2px 0 0 var(--accent); }
  #list li.muted, #list li.muted:hover { color: #5d6a82; cursor: default; background: none; }
  .hint { padding: 12px 16px; font-size: 12px; color: #5d6a82; border-top: 1px solid var(--border); }
  .hint code { color: var(--muted); }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .empty { margin: auto; color: #5d6a82; }
  #view { display: flex; flex-direction: column; height: 100%; }
  .bar { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .subj { min-width: 0; flex: 1; display: flex; align-items: baseline; gap: 9px; }
  .subj .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #5d6a82; }
  #subject { font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .seg-btn { background: var(--surface); border: 0; color: var(--muted); font: inherit; padding: 6px 14px; cursor: pointer; transition: color 150ms; }
  .seg-btn:hover { color: var(--text); }
  .seg-btn.on { background: var(--accent); color: #fff; }
  .btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); font: inherit; padding: 6px 13px; border-radius: 8px; cursor: pointer; transition: border-color 150ms, background 150ms; }
  .btn:hover { border-color: var(--accent); background: var(--surface2); }
  .body { display: flex; flex: 1; min-height: 0; }
  .tokens { width: 248px; flex: 0 0 auto; border-right: 1px solid var(--border); padding: 14px; overflow: auto; }
  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 13px; }
  .fname { font-size: 12px; color: var(--muted); }
  .field input { background: var(--bg); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font: inherit; padding: 7px 9px; }
  .field input:focus { outline: none; border-color: var(--accent); }
  .muted { color: #5d6a82; font-size: 12px; }
  .preview { flex: 1; min-width: 0; display: flex; background: var(--bg); padding: 18px; }
  #frame { flex: 1; width: 100%; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
  #text { flex: 1; width: 100%; margin: 0; padding: 18px; overflow: auto; background: var(--surface); color: var(--muted); white-space: pre-wrap; border: 1px solid var(--border); border-radius: 12px; font: 13px/1.6 'SFMono-Regular', Consolas, monospace; }
</style>
</head>
<body>
<aside id="side">
  <div class="brand"><span class="mark">✦</span>Emails</div>
  <ul id="list"></ul>
  <div class="hint">Author in <code>emails/*.tsx</code>; this updates live on save.</div>
</aside>
<main id="main">
  <div id="empty" class="empty">Select an email to preview.</div>
  <section id="view" hidden>
    <header class="bar">
      <div class="subj"><span class="lbl">Subject</span><span id="subject"></span></div>
      <div class="actions">
        <div class="seg"><button id="tab-html" class="seg-btn on">HTML</button><button id="tab-text" class="seg-btn">Text</button></div>
        <button id="open" class="btn">Open in editor</button>
      </div>
    </header>
    <div class="body">
      <div class="tokens" id="tokens"></div>
      <div class="preview"><iframe id="frame" title="email preview"></iframe><pre id="text" hidden></pre></div>
    </div>
  </section>
</main>
<script>
(function () {
  var BASE = '/__toil/emails';
  var listEl = document.getElementById('list');
  var subjectEl = document.getElementById('subject');
  var frame = document.getElementById('frame');
  var textEl = document.getElementById('text');
  var tokensEl = document.getElementById('tokens');
  var emptyEl = document.getElementById('empty');
  var viewEl = document.getElementById('view');
  var tabHtml = document.getElementById('tab-html');
  var tabText = document.getElementById('tab-text');
  var openBtn = document.getElementById('open');
  var current = null, rendered = null, format = 'html', values = {};

  function fill(s) {
    return String(s).replace(/\\{\\{\\s*([A-Za-z_$][\\w$]*)\\s*\\}\\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m;
    });
  }
  function paint() {
    if (!rendered) return;
    subjectEl.textContent = fill(rendered.subject);
    if (format === 'html') {
      frame.hidden = false; textEl.hidden = true;
      // Wrap the email FRAGMENT in a minimal dark document so the iframe doesn't
      // show the browser-default white body/margin around and below the email.
      frame.srcdoc = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#080d11}</style>' + fill(rendered.html);
    } else {
      frame.hidden = true; textEl.hidden = false;
      textEl.textContent = fill(rendered.text);
    }
  }
  function paintTokens() {
    tokensEl.textContent = '';
    if (!rendered.tokens.length) {
      var none = document.createElement('div');
      none.className = 'muted'; none.textContent = 'No {{tokens}} in this email.';
      tokensEl.appendChild(none); return;
    }
    rendered.tokens.forEach(function (t) {
      var row = document.createElement('label'); row.className = 'field';
      var span = document.createElement('span'); span.className = 'fname'; span.textContent = t;
      var inp = document.createElement('input');
      inp.value = values[t] != null ? values[t] : t;
      values[t] = inp.value;
      inp.addEventListener('input', function () { values[t] = inp.value; paint(); });
      row.appendChild(span); row.appendChild(inp); tokensEl.appendChild(row);
    });
  }
  function setFormat(f) {
    format = f;
    tabHtml.classList.toggle('on', f === 'html');
    tabText.classList.toggle('on', f === 'text');
    paint();
  }
  tabHtml.addEventListener('click', function () { setFormat('html'); });
  tabText.addEventListener('click', function () { setFormat('text'); });
  openBtn.addEventListener('click', function () {
    if (current) fetch('/__toil/open?file=' + encodeURIComponent(current.file)).catch(function () {});
  });

  function select(item, keep) {
    current = item;
    Array.prototype.forEach.call(listEl.children, function (li) {
      li.classList.toggle('on', li.getAttribute('data-name') === item.name);
    });
    fetch(BASE + '/render?name=' + encodeURIComponent(item.name)).then(function (r) {
      if (!r.ok) throw new Error('render failed');
      return r.json();
    }).then(function (data) {
      rendered = data;
      if (!keep) values = {};
      emptyEl.hidden = true; viewEl.hidden = false;
      paintTokens(); paint();
    }).catch(function () {
      emptyEl.hidden = false; viewEl.hidden = true;
      emptyEl.textContent = 'Could not render ' + item.name + ' (see dev server logs).';
    });
  }
  function buildList(items) {
    listEl.textContent = '';
    if (!items.length) {
      var li = document.createElement('li');
      li.className = 'muted'; li.textContent = 'No emails/*.tsx found.';
      listEl.appendChild(li); return;
    }
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.setAttribute('data-name', it.name);
      li.textContent = it.name;
      li.classList.toggle('on', !!current && it.name === current.name);
      li.addEventListener('click', function () { select(it, false); });
      listEl.appendChild(li);
    });
  }
  function refresh() {
    fetch(BASE + '/list').then(function (r) { return r.json(); }).then(function (items) {
      buildList(items);
      if (!items.length) {
        current = null; rendered = null;
        emptyEl.hidden = false; viewEl.hidden = true;
        emptyEl.textContent = 'No emails/*.tsx found.';
        return;
      }
      var match = current && items.filter(function (it) { return it.name === current.name; })[0];
      select(match || items[0], !!match);
    }).catch(function () {});
  }
  refresh();
  // Live refresh: poll a cheap mtime fingerprint; re-render when it changes.
  var version = null;
  setInterval(function () {
    fetch(BASE + '/version').then(function (r) { return r.text(); }).then(function (v) {
      if (version === null) { version = v; return; }
      if (v !== version) { version = v; refresh(); }
    }).catch(function () {});
  }, 1000);
})();
</script>
</body>
</html>
`;
}
