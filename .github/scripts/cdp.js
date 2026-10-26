#!/usr/bin/env node
'use strict';
/* cdp.js — drive headless Chrome over the DevTools protocol, for the visual
   sweeps shot.sh cannot do. No dependencies: Node 22+ has a global WebSocket.

     node .github/scripts/cdp.js shot     'ingress-nginx-migration.html#configmap-mappings'
     node .github/scripts/cdp.js shot     index.html --width 320 --dark
     node .github/scripts/cdp.js overflow ingress-nginx-migration.html --width 320
     node .github/scripts/cdp.js focus    'ingress-nginx-migration.html#reference'
     node .github/scripts/cdp.js measure  index.html --select '.sidebar-link-name'
     node .github/scripts/cdp.js js       index.html --js 'document.title'

   Options: --width N (a TRUE N px viewport, set by Emulation.setDeviceMetricsOverride
   rather than --window-size, which macOS clamps to ~500), --height N, --dark,
   --print, --forced-colors, --reduced-motion, --zoom F, --click SEL (repeatable,
   in order), --scroll SEL, --select SEL, --out FILE, --below N (shot: also
   capture N px under the target, so a heading comes with what it heads).

   Why each piece is the way it is:
   - Navigation goes through about:blank first. A same-document hash change never
     fires Page.loadEventFired, so navigating index.html → index.html#x waits
     forever; a fresh document always fires it.
   - `shot` captures the target's own box (captureBeyondViewport), so a deep link
     to an anchor 15,000px down is a picture of that anchor, not of the band at
     scroll position zero that --screenshot captures — which came back blank.
   - Dark mode is a class this site toggles from localStorage.darkMode, not
     prefers-color-scheme, so --dark seeds the key before any script runs.
   - Exit codes: 0 ok, 1 the sweep found problems, 2 usage, 3 no browser,
     4 the page did not load, 5 the capture is blank.
   Lives under .github/ because GitHub Pages publishes this branch. */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function die(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

function parseArgs(argv) {
    const [command, target, ...rest] = argv;
    const opt = { command, target, width: 1400, height: 900, click: [] };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        const next = () => { if (i + 1 >= rest.length) die(2, a + ' needs a value'); return rest[++i]; };
        if (a === '--width') opt.width = parseInt(next(), 10);
        else if (a === '--height') opt.height = parseInt(next(), 10);
        else if (a === '--dark') opt.dark = true;
        else if (a === '--print') opt.print = true;
        else if (a === '--forced-colors') opt.forcedColors = true;
        else if (a === '--reduced-motion') opt.reducedMotion = true;
        else if (a === '--zoom') opt.zoom = parseFloat(next());
        else if (a === '--click') opt.click.push(next());
        else if (a === '--scroll') opt.scroll = next();
        else if (a === '--select') opt.select = next();
        else if (a === '--js') opt.js = next();
        else if (a === '--out') opt.out = next();
        else if (a === '--below') opt.below = parseInt(next(), 10);
        else die(2, 'unknown option: ' + a);
    }
    if (!['shot', 'overflow', 'focus', 'measure', 'js'].includes(command) || !target) {
        die(2, fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).join('\n'));
    }
    return opt;
}

function findChrome() {
    const candidates = [
        process.env.CHROME,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ];
    return candidates.find((c) => c && fs.existsSync(c));
}

// A static server over the repo, on an ephemeral port: no collision with
// anything else listening, and the page is served exactly as Pages serves it.
function serve() {
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end(); return;
        }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(chrome) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
    const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--user-data-dir=' + dir, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Chrome did not open a DevTools port')), 15000);
        proc.stderr.on('data', (d) => {
            buf += d;
            const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
            if (m) { clearTimeout(timer); resolve(m[1]); }
        });
        proc.on('exit', () => reject(new Error('Chrome exited before it was ready')));
    });
    const close = () => { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ }
        fs.rmSync(dir, { recursive: true, force: true }); };
    return { wsUrl, close };
}

// One page target over one socket, flat session mode.
async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
            listeners.forEach((l) => l(msg));
        }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    const once = (method, ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method)), ms);
        listeners.push(function l(msg) {
            if (msg.method === method && msg.sessionId === sessionId) {
                clearTimeout(timer);
                listeners.splice(listeners.indexOf(l), 1);
                resolve(msg.params);
            }
        });
    });
    return { page, once, close: () => ws.close() };
}

async function evaluate(page, expression) {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
}

async function open(page, once, url, opt) {
    await page('Page.enable');
    await page('Runtime.enable');
    const scale = opt.zoom || 1;
    // The viewport itself, not the window: a true 320px layout at any width.
    await page('Emulation.setDeviceMetricsOverride', {
        width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: opt.width < 600 });
    const features = [];
    if (opt.forcedColors) features.push({ name: 'forced-colors', value: 'active' });
    if (opt.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
    features.push({ name: 'prefers-color-scheme', value: opt.dark ? 'dark' : 'light' });
    await page('Emulation.setEmulatedMedia', { media: opt.print ? 'print' : '', features });
    await page('Page.addScriptToEvaluateOnNewDocument', { source:
        `try{localStorage.setItem('darkMode','${opt.dark ? '1' : '0'}')}catch(e){}` });
    // about:blank first, always: a same-document hash change fires no load event.
    await page('Page.navigate', { url: 'about:blank' });
    const loaded = once('Page.loadEventFired', 20000);
    const nav = await page('Page.navigate', { url });
    if (nav.errorText) throw Object.assign(new Error(nav.errorText), { code: 4 });
    await loaded;
    if (scale !== 1) await evaluate(page, `document.documentElement.style.zoom = ${scale}`);
    await evaluate(page, 'document.fonts.ready.then(() => new Promise(r => setTimeout(r, 400)))');
    for (const sel of opt.click) {
        const ok = await evaluate(page, `(() => { const e = document.querySelector(${JSON.stringify(sel)});
            if (!e) return false; e.click(); return true; })()`);
        if (!ok) throw Object.assign(new Error('--click: nothing matches ' + sel), { code: 1 });
        await evaluate(page, 'new Promise(r => setTimeout(r, 300))');
    }
    if (opt.scroll) {
        await evaluate(page, `document.querySelector(${JSON.stringify(opt.scroll)})?.scrollIntoView()`);
    }
}

// ── Sweeps. Each returns { problems: [...], data } and runs in the page. ──────

const SWEEPS = {
    // Every element whose box extends past the viewport's right edge, and
    // every element clipping its own text. Fixed and visually-hidden elements
    // are skipped: they are positioned on purpose.
    overflow: `(() => {
        const vw = document.documentElement.clientWidth, out = [];
        for (const e of document.querySelectorAll('body *')) {
            const s = getComputedStyle(e);
            if (s.display === 'none' || s.visibility === 'hidden' || s.position === 'fixed') continue;
            if (e.closest('[hidden], .sr-only, .visually-hidden')) continue;
            const r = e.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > vw + 1) out.push({ issue: 'past viewport', el: describe(e), right: Math.round(r.right), vw });
            else if (e.scrollWidth > e.clientWidth + 1 && s.overflowX === 'visible' && e.children.length === 0)
                out.push({ issue: 'text overflows its box', el: describe(e), need: e.scrollWidth, has: e.clientWidth });
        }
        return { problems: out.slice(0, 40), data: { viewport: vw, document: document.documentElement.scrollWidth } };
    })()`,
};

// After each real Tab press: where did focus land, and can the reader see it?
// (WCAG 2.4.11, focus not obscured.) A Tab key, not element.focus(): only a
// keyboard press applies :focus-visible styles — the skip link is off-screen
// until then, and calling focus() reports it as hidden when it is not.
const FOCUS_PROBE = `(() => {
    const e = document.activeElement;
    if (!e || e === document.body) return null;
    const bar = document.querySelector('.topbar');
    const barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
    const r = e.getBoundingClientRect();
    let issue = null;
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
        issue = 'off-screen when focused';
    } else {
        // Hit-test the element's visible centre: something else painted on
        // top of it (the fixed top bar, a sticky header) obscures it, whatever
        // the boxes say. A skip link at z-index 9999 over the bar is fine.
        const x = Math.min(Math.max((r.left + r.right) / 2, 0), innerWidth - 1);
        const y = Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2, 0), innerHeight - 1);
        const hit = document.elementFromPoint(x, y);
        // Only an overlay obscures: a fixed or sticky ancestor of whatever was
        // hit, that the focused element is not itself inside. Neighbours in
        // the same flow (a sibling link's label) are layout, not occlusion.
        let cover = hit;
        while (cover && cover !== document.body && !['fixed', 'sticky'].includes(getComputedStyle(cover).position)) {
            cover = cover.parentElement;
        }
        if (hit && cover && cover !== document.body && !cover.contains(e) && !e.contains(hit)) {
            issue = cover.closest('.topbar') ? 'under the top bar' : 'covered by ' + describe(cover);
        }
    }
    return { el: describe(e), top: Math.round(r.top), barBottom: Math.round(barBottom), issue };
})()`;

async function focusSweep(page, limit = 400) {
    const problems = [], seen = new Set();
    let stops = 0;
    for (let i = 0; i < limit; i++) {
        for (const type of ['keyDown', 'keyUp']) {
            await page('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab',
                windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        }
        // Let a focus transition finish (the skip link slides in) before measuring.
        await evaluate(page, `new Promise(r => requestAnimationFrame(async () => {
            const e = document.activeElement;
            if (e && e.getAnimations) await Promise.all(e.getAnimations().map(a => a.finished.catch(() => {})));
            setTimeout(r, 20); }))`);
        const at = await evaluate(page, FOCUS_PROBE);
        if (!at) continue;
        if (seen.has(at.el + at.top)) break;         // wrapped round to the start
        seen.add(at.el + at.top);
        stops++;
        if (at.issue) problems.push({ issue: at.issue, el: at.el, top: at.top, barBottom: at.barBottom });
    }
    return { problems: problems.slice(0, 40), data: { tabStops: stops } };
}

const DESCRIBE = `function describe(e) {
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    if (e.classList.length) s += '.' + [...e.classList].slice(0, 2).join('.');
    const t = (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return t ? s + ' "' + t + '"' : s;
}`;

function blankPng(buf) {
    // The same exact rule as shot.sh: if every row is one colour, and the same
    // colour as the row above, nothing rendered. Each scanline is checked
    // against what a flat row would encode to under its own PNG filter — an
    // earlier version accepted only two of the five filters, and Chrome picks
    // others for flat rows, so a blank capture passed.
    const zlib = require('node:zlib');
    let pos = 8; const idat = []; let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    while (pos < buf.length) {
        const n = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
        if (type === 'IHDR') {
            w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12);
            depth = buf[pos + 16]; ctype = buf[pos + 17]; interlace = buf[pos + 20];
        }
        if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + n));
        pos += 12 + n;
    }
    const bpp = { 2: 3, 6: 4 }[ctype];
    if (depth !== 8 || !bpp || interlace) return false;      // not a layout Chrome writes
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * bpp;
    let prev = Buffer.alloc(bpp);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const d = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const first = d.subarray(0, bpp);
        // A flat row of colour v encodes its first pixel as v minus the
        // filter's prediction: 0 for None/Sub, prev for Up/Paeth, prev/2 for Average.
        const pred = (i) => (f === 2 || f === 4) ? prev[i] : (f === 3 ? prev[i] >> 1 : 0);
        const v = Buffer.from([...first].map((b, i) => (b + pred(i)) & 255));
        for (let x = 1; x < w; x++) {
            for (let i = 0; i < bpp; i++) {
                const got = d[x * bpp + i];
                const want = f === 0 ? v[i] : f === 2 ? first[i]
                    : f === 3 ? (v[i] - ((v[i] + prev[i]) >> 1)) & 255 : 0;
                if (got !== want) return false;               // this row has content
            }
        }
        prev = v;
    }
    return true;
}

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    const chrome = findChrome();
    if (!chrome) die(3, 'NO-BROWSER: no Chrome or Chromium found (set CHROME=). Say so in your '
        + 'summary; do NOT report the static checks as visual verification.');
    const [file, hash] = opt.target.split('#');
    if (!fs.existsSync(path.join(ROOT, file))) die(2, 'no such page: ' + file);

    const server = await serve();
    const url = `http://127.0.0.1:${server.address().port}/${file}${hash ? '#' + hash : ''}`;
    const browser = await launch(chrome);
    let code = 0;
    try {
        const { page, once, close } = await connect(browser.wsUrl);
        await open(page, once, url, opt);
        await evaluate(page, DESCRIBE.replace('function describe', 'window.describe = function'));

        if (opt.command === 'js') {
            console.log(JSON.stringify(await evaluate(page, opt.js || 'document.title'), null, 1));
        } else if (opt.command === 'measure') {
            const sel = JSON.stringify(opt.select || 'body');
            console.log(JSON.stringify(await evaluate(page, `({ viewport: { w: innerWidth, h: innerHeight },
                overflow: document.documentElement.scrollWidth > innerWidth,
                nodes: [...document.querySelectorAll(${sel})].slice(0, 200).map(e => {
                    const r = e.getBoundingClientRect();
                    return { el: describe(e), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
                             x: +r.left.toFixed(1), y: +r.top.toFixed(1),
                             clipped: e.scrollWidth > Math.ceil(r.width) + 1 };
                }) })`), null, 1));
        } else if (opt.command === 'shot') {
            // The target's own box when there is a hash or --select, else the page.
            const sel = opt.select || (hash ? '#' + hash : null);
            let clip;
            if (sel) {
                clip = await evaluate(page, `(() => { const e = document.querySelector(${JSON.stringify(sel)});
                    if (!e) return null; const r = e.getBoundingClientRect();
                    return { x: r.left + scrollX, y: r.top + scrollY, width: Math.max(r.width, 1),
                             height: Math.min(Math.max(r.height, 1) + ${opt.below || 0}, 8000), scale: 1 }; })()`);
                if (!clip) throw Object.assign(new Error('nothing matches ' + sel), { code: 1 });
            } else {
                const h = await evaluate(page, 'Math.min(document.documentElement.scrollHeight, 8000)');
                clip = { x: 0, y: 0, width: opt.width, height: h, scale: 1 };
            }
            const { data } = await page('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
            const buf = Buffer.from(data, 'base64');
            const out = opt.out || path.join(os.tmpdir(),
                `${path.basename(file, '.html')}${hash ? '-' + hash : ''}${opt.dark ? '-dark' : ''}-${opt.width}.png`);
            fs.writeFileSync(out, buf);
            if (blankPng(buf)) {
                fs.rmSync(out);
                throw Object.assign(new Error(`BLANK: the ${Math.round(clip.width)}x${Math.round(clip.height)} capture `
                    + 'holds one colour. Nothing rendered; do NOT report a visual check.'), { code: 5 });
            }
            console.log(`wrote ${out}  (${Math.round(clip.width)}x${Math.round(clip.height)} of ${sel || 'the page'}, `
                + `viewport ${opt.width}px, ${opt.dark ? 'dark' : 'light'}${opt.print ? ', print' : ''}`
                + `${opt.forcedColors ? ', forced colours' : ''})`);
        } else {
            const result = opt.command === 'focus' ? await focusSweep(page)
                : await evaluate(page, SWEEPS[opt.command]);
            console.log(JSON.stringify(result.data));
            for (const p of result.problems) console.log('  ' + JSON.stringify(p));
            console.log(result.problems.length ? `${result.problems.length} problem(s)` : 'clean');
            code = result.problems.length ? 1 : 0;
        }
        close();
    } catch (err) {
        process.stderr.write((err.message || String(err)) + '\n');
        code = err.code || 4;
    } finally {
        browser.close();
        server.close();
    }
    process.exit(code);
}

main();
