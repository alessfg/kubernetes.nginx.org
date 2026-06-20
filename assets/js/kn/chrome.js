/* kn/chrome.js — bespoke chrome behavior that the theme doesn't provide:
   the dark-mode toggle and copy-to-clipboard. Loaded (via a scripts.html
   override) before the per-page script. Classic script: functions stay global
   so kn/site.js and kn/migration.js can call copyToClipboard().

   Dropped vs the old shared.js: the mobile sidebar drawer (the theme owns the
   mobile nav) and the copyright-year updater (the theme footer renders the year). */
'use strict';

/* ── Dark mode ── */
function initDarkMode() {
    // The inline <head> flash-prevention script sets .dark-mode on <html>; mirror it onto <body>.
    if (document.documentElement.classList.contains('dark-mode')) {
        document.body.classList.add('dark-mode');
    }
    updateDarkAriaLabel();
}

function updateDarkAriaLabel() {
    var btn = document.getElementById('darkToggle');
    if (!btn) return;
    var isDark = document.documentElement.classList.contains('dark-mode') || document.body.classList.contains('dark-mode');
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
}

/* ── Copy to clipboard (used by the landing code blocks and the migration tool) ── */
function copyToClipboard(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
            showCopied(btn);
        }).catch(function() {
            fallbackCopy(text, btn);
        });
    } else {
        fallbackCopy(text, btn);
    }
}

function fallbackCopy(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    try {
        ta.select();
        document.execCommand('copy');
        showCopied(btn);
    } catch (e) { /* silent */ }
    finally {
        document.body.removeChild(ta);
    }
}

function showCopied(btn) {
    if (!btn) return;
    if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    var announcer = document.getElementById('page-announce');
    if (announcer) announcer.textContent = 'Code copied to clipboard';
    btn._copyTimeout = setTimeout(function() {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
        if (announcer) announcer.textContent = '';
    }, 2000);
}

/* ── Wiring ── */
document.addEventListener('DOMContentLoaded', function() {
    initDarkMode();

    // This hub's product pages have no doc-tree below the theme's product-selector,
    // so the left rail looks empty with the dropdown collapsed. Open it by default so
    // the product list is always visible as the cross-product nav. (Native <details>.)
    var psel = document.querySelector('details.product-selector__section');
    if (psel) psel.setAttribute('open', '');

    var darkToggle = document.getElementById('darkToggle');
    if (darkToggle) {
        darkToggle.addEventListener('click', function() {
            var isDark = !document.body.classList.contains('dark-mode');
            document.documentElement.classList.toggle('dark-mode', isDark);
            document.body.classList.toggle('dark-mode', isDark);
            try { localStorage.setItem('darkMode', isDark ? '1' : '0'); } catch (e) { /* storage blocked */ }
            updateDarkAriaLabel();
        });
    }
});
