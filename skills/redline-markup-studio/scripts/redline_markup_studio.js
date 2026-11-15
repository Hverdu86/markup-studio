#!/usr/bin/env node
/*
 * Redline_markup_studio local helper (no dependencies, Node 18+).
 *
 * Serves the studio page on 127.0.0.1, lets Claude queue images into it, and saves what the
 * user sends back (marked-up PNG, original image, coordinate spec) inside the project folder.
 *
 *   open    [--project DIR] [--image PATH_OR_URL]... [--no-browser] [--port N]   (--image also takes a PDF)
 *   wait    [--project DIR] [--timeout SECONDS]     block until the user presses "Send to Claude"
 *   latest  [--project DIR]                         print the newest markup again
 *   status  [--project DIR]
 *   stop    [--project DIR]
 *   bundle  --out FILE.html [--image PATH_OR_URL]...  single-file studio with images preloaded
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_NAME = 'Redline_markup_studio';
const STATE_DIR = '.redline_markup_studio';
const STUDIO_HTML = path.join(__dirname, '..', 'assets', 'Redline_markup_studio.html');
const PRELOAD_MARK = '<!--REDLINE_MARKUP_STUDIO_PRELOAD-->';
const DEFAULT_PORT = 4747;
const MAX_IMAGE = 60 * 1024 * 1024;
const MAX_BODY = 400 * 1024 * 1024;
const IDLE_EXIT_MS = 12 * 60 * 60 * 1000;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.heic': 'image/heic', '.heif': 'image/heif', '.pdf': 'application/pdf' };
const VENDOR_DIR = path.join(__dirname, '..', 'assets', 'vendor');
const VENDOR = new Set(['pdf.min.js', 'pdf.worker.min.js', 'UTIF.js', 'pako_inflate.min.js']);
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]).reverse());

/* ---------- small helpers ---------- */
function parseArgs(argv) {
  const o = { _: [], image: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--image') o.image.push(argv[++i]);
    else if (a === '--no-browser') o.noBrowser = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}
const die = (msg, code = 1) => { console.error(`${APP_NAME}: ${msg}`); process.exit(code); };
const isUrl = (s) => /^https?:\/\//i.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) => String(s || 'image').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'image';
function paths(project) {
  const root = path.join(path.resolve(project || process.cwd()), STATE_DIR);
  return { project: path.resolve(project || process.cwd()), root, server: path.join(root, 'server.json'), inbox: path.join(root, 'inbox'),
    subs: path.join(root, 'submissions'), cursor: path.join(root, 'last_read'), log: path.join(root, 'server.log') };
}
function ensureDirs(p) {
  for (const d of [p.root, p.inbox, p.subs]) fs.mkdirSync(d, { recursive: true });
  const gi = path.join(p.root, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');   // keep markup sessions out of the user's repository
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const listSubs = (p) => { try { return fs.readdirSync(p.subs).filter((d) => fs.existsSync(path.join(p.subs, d, 'redline-spec.md'))).sort(); } catch { return []; } };

async function fetchImage(url) {
  if (!isUrl(url)) throw new Error('only http(s) image addresses are allowed');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (image fetch)', Accept: 'image/*,*/*;q=0.5' } });
    if (!r.ok) throw new Error(`the site answered ${r.status}`);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('image is larger than 60 MB');
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    const mime = type.startsWith('image/') || type === 'application/pdf' ? type : MIME[ext];
    if (!mime) throw new Error('that address did not return an image or PDF');
    let name = decodeURIComponent(path.basename(new URL(url).pathname)) || 'web-image';
    if (!path.extname(name)) name += EXT[mime] || '.png';
    return { buf, mime, name: safeName(name) };
  } finally { clearTimeout(timer); }
}
function readLocalImage(file) {
  const abs = path.resolve(file), ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) throw new Error(`${path.basename(abs)} is not a supported file (png, jpg, gif, webp, bmp, svg, avif, ico, tif, heic, pdf)`);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  if (st.size > MAX_IMAGE) throw new Error('file is larger than 60 MB');
  return { buf: fs.readFileSync(abs), mime: MIME[ext], name: safeName(path.basename(abs)) };
}

/* ---------- server ---------- */
function serve(opts) {
  const p = paths(opts.project); ensureDirs(p);
  const token = crypto.randomBytes(18).toString('hex');
  const inbox = [];             // { id, name, mime, file }
  let nextInbox = 1, studioSeen = 0, lastHit = Date.now(), waiters = [], port = 0;

  const json = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); res.end(b); };
  const body = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
  function addInbox(img) {
    const id = nextInbox++, file = path.join(p.inbox, `${id}-${img.name}`);
    fs.writeFileSync(file, img.buf); inbox.push({ id, name: img.name, mime: img.mime, file });
    return { id, name: img.name };
  }
  function saveSubmission(data) {
    const images = Array.isArray(data.images) ? data.images : [];
    if (!images.length) throw new Error('nothing to save');
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    let id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    while (fs.existsSync(path.join(p.subs, id))) id += 'x';
    const dir = path.join(p.subs, id); fs.mkdirSync(dir, { recursive: true });
    const decode = (u) => { const m = /^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(u || ''); if (!m) throw new Error('bad image data'); return { mime: m[1], buf: Buffer.from(m[2], 'base64') }; };
    const files = [];
    const meta = { app: APP_NAME, id, created: d.toISOString(), numbered: !!data.numbered, notes: String(data.notes || ''), images: [] };
    images.forEach((im, i) => {
      const ann = decode(im.annotated), org = decode(im.original);
      const annFile = `image-${i + 1}-annotated.png`, orgFile = `image-${i + 1}-original${EXT[org.mime] || '.png'}`;
      fs.writeFileSync(path.join(dir, annFile), ann.buf); fs.writeFileSync(path.join(dir, orgFile), org.buf);
      files.push(annFile, orgFile);
      meta.images.push({ name: String(im.name || ''), width: im.width, height: im.height, rotation_deg: Number(im.rotation_deg) || 0, annotated: annFile, original: orgFile, marks: im.marks || [] });
    });
    fs.writeFileSync(path.join(dir, 'markup.json'), JSON.stringify(meta, null, 2));
    const fileNotes = meta.images.map((im, i) => `- Image ${i + 1} "${im.name}": marked-up = ${im.annotated}, clean original = ${im.original}`).join('\n');
    fs.writeFileSync(path.join(dir, 'redline-spec.md'), `${String(data.spec || '').trimEnd()}\n\nFiles in this folder:\n${fileNotes}\n- markup.json: every mark as structured data (tool, colour, size, pixel coordinates, note)\n`);
    const sub = { id, dir };
    waiters.forEach((w) => w(sub)); waiters = [];
    return sub;
  }

  const server = http.createServer(async (req, res) => {
    lastHit = Date.now();
    try {
      const host = String(req.headers.host || '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: 'bad host' });
      const u = new URL(req.url, `http://${host}`), route = u.pathname;
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        const html = fs.readFileSync(STUDIO_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        return res.end(html);
      }
      if (req.method === 'GET' && route.startsWith('/vendor/') && VENDOR.has(route.slice(8))) {   // decoders for PDF and TIFF files
        const js = fs.readFileSync(path.join(VENDOR_DIR, route.slice(8)));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': js.length, 'Cache-Control': 'max-age=3600' });
        return res.end(js);
      }
      if (!route.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      if (req.headers['x-redline-token'] !== token) return json(res, 401, { error: 'missing or wrong token' });

      if (req.method === 'GET' && route === '/api/state') {
        const subs = listSubs(p);
        return json(res, 200, { app: APP_NAME, project: p.project, studioSeenAgoMs: studioSeen ? Date.now() - studioSeen : null, queued: inbox.length, submissions: subs.length, last: subs[subs.length - 1] || null });
      }
      if (req.method === 'GET' && route === '/api/inbox') {
        studioSeen = Date.now();
        const after = Number(u.searchParams.get('after') || 0);
        return json(res, 200, { items: inbox.filter((i) => i.id > after).map(({ id, name }) => ({ id, name })) });
      }
      if (req.method === 'GET' && route.startsWith('/api/inbox/')) {
        const it = inbox.find((i) => i.id === Number(route.split('/').pop()));
        if (!it) return json(res, 404, { error: 'not found' });
        const buf = fs.readFileSync(it.file);
        res.writeHead(200, { 'Content-Type': it.mime, 'Content-Length': buf.length, 'Cache-Control': 'no-store' }); return res.end(buf);
      }
      if (req.method === 'POST' && route === '/api/inbox') {
        const b = await body(req);
        try { return json(res, 200, addInbox(b.url ? await fetchImage(b.url) : readLocalImage(b.path))); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && route === '/api/fetch') {
        try {
          const img = await fetchImage(u.searchParams.get('url') || '');
          res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': img.buf.length, 'Cache-Control': 'no-store' }); return res.end(img.buf);
        } catch (e) { return json(res, 502, { error: e.message }); }
      }
      if (req.method === 'POST' && route === '/api/submit') {
        try { return json(res, 200, saveSubmission(await body(req))); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && route === '/api/wait') {
        const ms = Math.min(55000, Number(u.searchParams.get('timeout') || 25000));
        let done = false;
        const finish = (sub) => { if (done) return; done = true; clearTimeout(t); json(res, 200, sub ? { submission: sub } : { timeout: true }); };
        const t = setTimeout(() => { waiters = waiters.filter((w) => w !== finish); finish(null); }, ms);
        waiters.push(finish); req.on('close', () => { waiters = waiters.filter((w) => w !== finish); done = true; clearTimeout(t); });
        return;
      }
      if (req.method === 'POST' && route === '/api/stop') { json(res, 200, { stopped: true }); return shutdown(); }
      return json(res, 404, { error: 'not found' });
    } catch (e) { try { json(res, 500, { error: e.message }); } catch { /* socket closed */ } }
  });
  function shutdown() { try { fs.unlinkSync(p.server); } catch { /* already gone */ } server.close(); setTimeout(() => process.exit(0), 150).unref(); }
  const listen = (wanted) => {
    server.once('error', (e) => { if (e.code === 'EADDRINUSE' && wanted !== 0) listen(0); else die(e.message); });
    server.listen(wanted, '127.0.0.1', () => {
      port = server.address().port;
      fs.writeFileSync(p.server, JSON.stringify({ app: APP_NAME, pid: process.pid, port, token, url: `http://127.0.0.1:${port}/?t=${token}`, started: new Date().toISOString() }, null, 2));
    });
  };
  listen(Number(opts.port) || DEFAULT_PORT);
  setInterval(() => { if (Date.now() - lastHit > IDLE_EXIT_MS) shutdown(); }, 60000).unref();
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

/* ---------- client side of the CLI ---------- */
async function call(info, route, opt = {}) {
  const r = await fetch(`http://127.0.0.1:${info.port}${route}`, { ...opt, headers: { 'X-Redline-Token': info.token, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `helper answered ${r.status}`);
  return j;
}
async function running(p) {
  const info = readJson(p.server); if (!info) return null;
  try { const s = await call(info, '/api/state'); return s.app === APP_NAME ? { info, state: s } : null; } catch { return null; }
}
function openBrowser(url) {
  let cmd, args;
  const wsl = process.platform === 'linux' && /microsoft/i.test((() => { try { return fs.readFileSync('/proc/version', 'utf8'); } catch { return ''; } })());
  if (process.platform === 'win32') { cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (wsl) { cmd = 'explorer.exe'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  return new Promise((resolve) => {
    try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', () => resolve(false)); c.unref(); setTimeout(() => resolve(true), 400); }
    catch { resolve(false); }
  });
}
function printSubmission(p, id) {
  const dir = path.join(p.subs, id), meta = readJson(path.join(dir, 'markup.json')) || { images: [] };
  console.log(`${APP_NAME}: markup received`);
  console.log(`Folder: ${dir}`);
  meta.images.forEach((im, i) => {
    console.log(`Image ${i + 1} "${im.name}" (${im.width}x${im.height}), ${im.marks.length} mark(s):`);
    console.log(`  LOOK AT THIS -> ${path.join(dir, im.annotated)}   (the image with the user's redlines drawn on it)`);
    console.log(`  clean original -> ${path.join(dir, im.original)}   (make edits against this, never against the marked-up copy)`);
  });
  console.log(`Structured marks: ${path.join(dir, 'markup.json')}`);
  console.log('\n----- redline-spec.md -----');
  console.log(fs.readFileSync(path.join(dir, 'redline-spec.md'), 'utf8').trimEnd());
  fs.writeFileSync(p.cursor, id);
}

async function cmdOpen(o) {
  const p = paths(o.project); ensureDirs(p);
  let live = await running(p);
  if (!live) {
    const log = fs.openSync(p.log, 'a');
    spawn(process.execPath, [__filename, 'serve', '--project', p.project, ...(o.port ? ['--port', String(o.port)] : [])], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
    for (let i = 0; i < 80 && !live; i++) { await sleep(100); live = await running(p); }
    if (!live) die(`the local helper did not start. See ${p.log}`);
  }
  const { info } = live; let queued = 0;
  for (const img of o.image) {
    try { const r = await call(info, '/api/inbox', { method: 'POST', body: JSON.stringify(isUrl(img) ? { url: img } : { path: path.resolve(img) }) }); queued++; console.log(`Queued image: ${r.name}`); }
    catch (e) { console.log(`Could not queue ${img}: ${e.message}`); }
  }
  const seen = live.state.studioSeenAgoMs;
  let browser = 'already open in a browser tab';
  if (seen === null || seen > 5000) browser = o.noBrowser ? 'not opened (--no-browser)' : (await openBrowser(info.url)) ? 'opened in the default browser' : 'could not be opened automatically';
  console.log(`${APP_NAME} is running for ${p.project}`);
  console.log(`Studio address: ${info.url}`);
  console.log(`Browser: ${browser}`);
  console.log(`Images queued this time: ${queued}. The user can also drop, paste or add images in the studio.`);
  console.log('Next: run the "wait" command to block until the user presses Send to Claude.');
}
async function cmdWait(o) {
  const p = paths(o.project), deadline = Date.now() + (Number(o.timeout) || 1800) * 1000;
  const fresh = () => { const cur = (() => { try { return fs.readFileSync(p.cursor, 'utf8').trim(); } catch { return ''; } })(); return listSubs(p).find((id) => id > cur); };
  for (;;) {
    const id = fresh(); if (id) return printSubmission(p, id);
    const live = await running(p);
    if (!live) die('the studio is not running. Start it with the "open" command first.');
    const left = deadline - Date.now();
    if (left <= 0) { console.log(`${APP_NAME}: no markup was sent yet. The studio is still open at ${live.info.url}; run "wait" again, or "latest" after the user says they pressed Send to Claude.`); process.exit(2); }
    try { await call(live.info, `/api/wait?timeout=${Math.min(25000, left)}`); } catch { await sleep(1000); }
  }
}
function cmdLatest(o) {
  const p = paths(o.project), subs = listSubs(p);
  if (!subs.length) die('no markup has been sent from the studio in this project yet.', 2);
  printSubmission(p, subs[subs.length - 1]);
}
async function cmdStatus(o) {
  const p = paths(o.project), live = await running(p);
  if (!live) return console.log(`${APP_NAME}: not running for ${p.project}. Markups saved so far: ${listSubs(p).length}`);
  const s = live.state;
  console.log(`${APP_NAME}: running at ${live.info.url}`);
  console.log(`Studio tab: ${s.studioSeenAgoMs !== null && s.studioSeenAgoMs < 5000 ? 'open' : 'not open'} | images queued: ${s.queued} | markups saved: ${s.submissions}`);
}
async function cmdStop(o) {
  const live = await running(paths(o.project));
  if (!live) return console.log(`${APP_NAME}: not running.`);
  await call(live.info, '/api/stop', { method: 'POST', body: '{}' }).catch(() => {});
  console.log(`${APP_NAME}: stopped.`);
}
async function cmdBundle(o) {
  if (!o.out) die('bundle needs --out FILE.html');
  const pre = [];
  for (const img of o.image) {
    const r = isUrl(img) ? await fetchImage(img) : readLocalImage(img);
    pre.push({ name: r.name, dataUrl: `data:${r.mime};base64,${r.buf.toString('base64')}` });
  }
  const html = fs.readFileSync(STUDIO_HTML, 'utf8');
  if (!html.includes(PRELOAD_MARK)) die('the studio page is missing its preload marker.');
  const tag = `<script>window.REDLINE_MARKUP_STUDIO_PRELOAD=${JSON.stringify(pre).replace(/</g, '\\u003c')};</script>`;
  fs.writeFileSync(path.resolve(o.out), html.replace(PRELOAD_MARK, () => tag));
  console.log(`${APP_NAME}: wrote ${path.resolve(o.out)} with ${pre.length} image(s) preloaded.`);
}

(async () => {
  if (typeof fetch !== 'function') die('Node.js 18 or newer is required.');
  const o = parseArgs(process.argv.slice(2)), cmd = o._[0];
  try {
    if (cmd === 'serve') serve(o);
    else if (cmd === 'open') await cmdOpen(o);
    else if (cmd === 'wait') await cmdWait(o);
    else if (cmd === 'latest') cmdLatest(o);
    else if (cmd === 'status') await cmdStatus(o);
    else if (cmd === 'stop') await cmdStop(o);
    else if (cmd === 'bundle') await cmdBundle(o);
    else { console.log(`${APP_NAME} helper\nCommands: open | wait | latest | status | stop | bundle   (see the comment at the top of this file)`); process.exit(cmd ? 1 : 0); }
  } catch (e) { die(e.message); }
})();
