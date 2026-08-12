/* chrome.js — shared behaviour for the app shell.
   =========================================================================
   Loaded with `defer` on every page, before any page-specific script.
   Exposes a small set of globals that page scripts call: announce(),
   copyToClipboard(), openNav(), closeNav().

   Everything here is defensive about missing elements — the same script runs
   on ten pages and not all of them carry every control.
   ========================================================================= */
'use strict';

/* ── Theme ────────────────────────────────────────────────────────────────
   The `dark` class is set on <html> by a tiny inline script in each page's
   <head>, before first paint, so the theme never flashes. This function only
   handles the toggle afterwards. */

function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    document.body.classList.toggle('dark', isDark);

    var meta = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < meta.length; i++) {
        meta[i].setAttribute('content', isDark ? '#0B1640' : '#FFFFFF');
    }

    var toggle = document.getElementById('themeToggle');
    if (toggle) {
        toggle.setAttribute('aria-pressed', isDark ? 'true' : 'false');
        var on = toggle.querySelector('.theme-icon-dark');
        var off = toggle.querySelector('.theme-icon-light');
        if (on) { on.hidden = !isDark; }
        if (off) { off.hidden = isDark; }
    }
}

function initTheme() {
    applyTheme(document.documentElement.classList.contains('dark'));

    var toggle = document.getElementById('themeToggle');
    if (!toggle) { return; }

    toggle.addEventListener('click', function () {
        var next = !document.documentElement.classList.contains('dark');
        applyTheme(next);
        try {
            localStorage.setItem('theme', next ? 'dark' : 'light');
        } catch (e) { /* private browsing — the toggle still works this session */ }
        announce(next ? 'Dark theme on' : 'Light theme on');
    });
}

/* ── Live region ──────────────────────────────────────────────────────────
   One writer for the whole site. Clearing before writing forces assistive
   technology to re-announce an identical message. */

var _announceTimer = null;

function announce(text) {
    var region = document.getElementById('announce');
    if (!region) { return; }
    region.textContent = '';
    clearTimeout(_announceTimer);
    _announceTimer = setTimeout(function () { region.textContent = text; }, 50);
}

/* ── Navigation drawer ────────────────────────────────────────────────────
   Below 900px the navigation is an off-canvas drawer. `inert` on <main> keeps
   the tab order inside the drawer while it is open; the CSS uses visibility
   so the panel is unreachable when closed even without inert support. */

function navIsOpen() {
    var nav = document.getElementById('nav');
    return !!(nav && nav.classList.contains('is-open'));
}

function openNav() {
    var nav = document.getElementById('nav');
    var backdrop = document.getElementById('navBackdrop');
    var main = document.querySelector('.main');
    var toggle = document.getElementById('menuToggle');
    if (!nav) { return; }

    nav.classList.add('is-open');
    if (backdrop) { backdrop.classList.add('is-visible'); }
    if (main) { main.inert = true; }
    if (toggle) { toggle.setAttribute('aria-expanded', 'true'); }
    document.body.style.overflow = 'hidden';

    var first = nav.querySelector('a, button');
    if (first) { first.focus(); }
}

function closeNav() {
    var nav = document.getElementById('nav');
    if (!navIsOpen()) { return; }

    var backdrop = document.getElementById('navBackdrop');
    var main = document.querySelector('.main');
    var toggle = document.getElementById('menuToggle');

    nav.classList.remove('is-open');
    if (backdrop) { backdrop.classList.remove('is-visible'); }
    if (main) { main.inert = false; }
    if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
    }
    document.body.style.overflow = '';
}

function initNav() {
    var toggle = document.getElementById('menuToggle');
    var backdrop = document.getElementById('navBackdrop');

    if (toggle) {
        toggle.addEventListener('click', function () {
            if (navIsOpen()) { closeNav(); } else { openNav(); }
        });
    }
    if (backdrop) { backdrop.addEventListener('click', closeNav); }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && navIsOpen()) { closeNav(); }
    });

    /* Force the drawer shut when the viewport grows past the breakpoint —
       otherwise `inert` and the scroll lock survive into the desktop layout. */
    var wide = window.matchMedia('(min-width: 901px)');
    var onChange = function (e) { if (e.matches) { closeNav(); } };
    if (wide.addEventListener) {
        wide.addEventListener('change', onChange);
    } else if (wide.addListener) {
        wide.addListener(onChange);       /* Safari < 14 */
    }
}

/* ── Current page marking ─────────────────────────────────────────────────
   Each page's nav is identical markup, so the active item is resolved at
   runtime from the URL rather than hand-marked per page. That keeps the
   chrome block byte-identical across all pages, which scripts/check-chrome-
   sync.py depends on. */

function normalisePath(path) {
    var out = path.replace(/index\.html$/, '');
    if (out.charAt(out.length - 1) !== '/') { out += '/'; }
    return out;
}

function initActiveNav() {
    var here = normalisePath(window.location.pathname);

    var links = document.querySelectorAll('.nav-link');
    var best = null;
    var bestLen = -1;

    for (var i = 0; i < links.length; i++) {
        /* Read .pathname rather than the href attribute. Navigation hrefs are
           depth-relative ("../../products/…") so the site works at a domain
           root, under a GitHub Pages project subpath, and over file://. The
           property gives the browser's resolved absolute path, which is what
           we can actually compare against location. */
        var path = normalisePath(links[i].pathname);
        /* Longest matching prefix wins, so /products/nginx-ingress-controller/
           beats the site root, which also technically matches. */
        if (here.indexOf(path) === 0 && path.length > bestLen) {
            best = links[i];
            bestLen = path.length;
        }
    }
    if (best) { best.setAttribute('aria-current', 'page'); }
}

/* ── Copy to clipboard ────────────────────────────────────────────────────── */

function showCopyResult(btn, ok) {
    if (!btn) { return; }
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = ok ? 'Copied' : 'Failed';
    btn.classList.toggle('is-copied', ok);
    setTimeout(function () {
        btn.textContent = btn.getAttribute('data-label');
        btn.classList.remove('is-copied');
    }, 2000);
}

function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    /* Off-screen rather than hidden: a display:none element cannot be selected. */
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
}

function copyToClipboard(text, btn) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(
            function () { showCopyResult(btn, true); announce('Copied to clipboard'); },
            function () { showCopyResult(btn, fallbackCopy(text)); }
        );
        return;
    }
    var ok = fallbackCopy(text);
    showCopyResult(btn, ok);
    if (ok) { announce('Copied to clipboard'); }
}

/* Every .code-block gets a copy button injected, so pages never hand-write
   one and it can never drift out of sync with the block it belongs to. */
function initCopyButtons() {
    var blocks = document.querySelectorAll('.code-block');
    for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        var code = block.querySelector('code');
        if (!code || block.querySelector('.copy-btn')) { continue; }

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-xs copy-btn';
        btn.textContent = 'Copy';
        var label = block.getAttribute('data-copy-label');
        btn.setAttribute('aria-label', label ? 'Copy ' + label : 'Copy code');
        block.appendChild(btn);

        btn.addEventListener('click', (function (c, b) {
            return function () { copyToClipboard(c.textContent, b); };
        }(code, btn)));
    }
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initNav();
    initActiveNav();
    initCopyButtons();

    var year = document.getElementById('year');
    if (year) { year.textContent = String(new Date().getFullYear()); }
});
