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
import { renderEmailFile, toPascal, type RenderedEmail } from './emails.js';

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
<title>Email preview · toiljs</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0c0c11; color: #e7e9f0; }
  #side { width: 240px; flex: 0 0 auto; border-right: 1px solid #23232e; display: flex; flex-direction: column; background: #101016; }
  .brand { padding: 14px 16px; font-weight: 600; border-bottom: 1px solid #23232e; }
  #list { list-style: none; margin: 0; padding: 6px; overflow: auto; flex: 1; }
  #list li { padding: 8px 10px; border-radius: 8px; cursor: pointer; color: #c8cee0; }
  #list li:hover { background: #181820; }
  #list li.on { background: #1d1d6b33; color: #fff; }
  #list li.muted { color: #6b7080; cursor: default; }
  .hint { padding: 10px 16px; font-size: 12px; color: #6b7080; border-top: 1px solid #23232e; }
  .hint code { color: #9aa1b8; }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .empty { margin: auto; color: #6b7080; }
  #view { display: flex; flex-direction: column; height: 100%; }
  .bar { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-bottom: 1px solid #23232e; }
  .subj { min-width: 0; flex: 1; display: flex; align-items: baseline; gap: 8px; }
  .subj .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7080; }
  #subject { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
  .seg { display: flex; border: 1px solid #2c2c38; border-radius: 8px; overflow: hidden; }
  .seg-btn { background: #15151c; border: 0; color: #8b90a4; font: inherit; padding: 6px 12px; cursor: pointer; }
  .seg-btn.on { background: #2563ff; color: #fff; }
  .btn { background: #15151c; border: 1px solid #2c2c38; color: #c8cee0; font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
  .btn:hover { color: #fff; border-color: #3a3a48; }
  .body { display: flex; flex: 1; min-height: 0; }
  .tokens { width: 240px; flex: 0 0 auto; border-right: 1px solid #23232e; padding: 12px; overflow: auto; }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .fname { font-size: 12px; color: #9aa1b8; }
  .field input { background: #0c0c11; border: 1px solid #2c2c38; border-radius: 6px; color: #e7e9f0; font: inherit; padding: 6px 8px; }
  .field input:focus { outline: none; border-color: #2563ff; }
  .muted { color: #6b7080; font-size: 12px; }
  .preview { flex: 1; min-width: 0; background: #f6f7f9; }
  #frame { width: 100%; height: 100%; border: 0; background: #fff; }
  #text { width: 100%; height: 100%; margin: 0; padding: 16px; overflow: auto; background: #0c0c11; color: #c8cee0; white-space: pre-wrap; }
</style>
</head>
<body>
<aside id="side">
  <div class="brand">✉ Emails</div>
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
      frame.srcdoc = fill(rendered.html);
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
