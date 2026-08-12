/* migration-core.js — the migration tool's UI layer.
   =========================================================================
   REWRITTEN for the rebuild. This file owns rendering, navigation, filtering
   and the checklist; it holds no mapping data of its own.

   It reads window.MIGRATION_SOURCE, whose contract is UNCHANGED from before
   the rebuild. That is deliberate: the ingress-nginx source module is carried
   verbatim, and keeping the contract stable also means the Traefik and HAProxy
   source modules on their own branches still work against this engine.

   Load order (see migration-util.js for why):
     chrome.js -> migration-util.js -> migration-<source>.js -> migration-core.js

   ── Why there is no innerHTML with plan data ──────────────────────────────
   The analyzer renders text that originates in YAML the visitor pasted. Two
   plan fields carry it verbatim: infoNotes[].code is built as
   'nginx.ingress.kubernetes.io/' + annotation + ': ' + value, and
   unsupported.cards[].code joins the annotation names found in the input. An
   earlier draft of this file interpolated both into innerHTML, which made
   pasting an annotation value like <img src=x onerror=...> execute it.
   Everything derived from a plan is therefore set with textContent or built as
   element nodes. innerHTML appears only where the string is a literal in this
   file, and those sites are marked.

   ── Three silent-failure paths, made loud ────────────────────────────────
   1. buildPlan runs each CRD generator inside a try/catch that only warns, so
      a broken generator DROPS ITS RESOURCE rather than throwing. Counting
      console.warn is the only way to detect it — see the Node recipe in
      CLAUDE.md.
   2. renderBlock warns and skips any block.type it does not recognise. The
      type strings come from the source module, so they can drift on one side.
   3. Copy buttons attach to 344 comparison blocks by matching structure. The
      pre-rebuild code bailed out silently when the structure did not match;
      this version counts and warns, because losing all 344 was invisible.
   ========================================================================= */
'use strict';

(function () {
    var SOURCE = window.MIGRATION_SOURCE;
    if (!SOURCE) {
        console.error('migration-core.js: window.MIGRATION_SOURCE is missing. '
            + 'The source module must load before this file.');
        return;
    }
    var MT = window.MigrationTool;
    if (!MT || !MT.NIC || !MT.util) {
        console.error('migration-core.js: window.MigrationTool is missing. '
            + 'migration-util.js must load before this file.');
        return;
    }
    var NIC = MT.NIC;
    var util = MT.util;

    var $ = function (id) { return document.getElementById(id); };
    var $$ = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };

    /* ── Safe DOM helpers ─────────────────────────────────────────────────
       el() sets textContent, never innerHTML, so it is safe with any string.
       literal() exists for the handful of places that need real markup, and
       its name is the reminder that its argument must be a literal in this
       file rather than anything derived from a plan. */

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text != null) { node.textContent = String(text); }
        return node;
    }

    function literal(tag, className, trustedHtml) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        node.innerHTML = trustedHtml;
        return node;
    }

    /* A plan may supply a link target. Anything but http(s), a relative path or
       a fragment is dropped — a javascript: URL from plan data would be an
       execution path even with textContent everywhere else. */
    function safeHref(value) {
        var href = String(value || '').trim();
        if (/^(https?:\/\/|\/|#|\.\/|\.\.\/)/i.test(href) && !/^javascript:/i.test(href)) {
            return href;
        }
        return null;
    }

    function link(href, text, external) {
        var safe = safeHref(href);
        if (!safe) { return el('span', null, text); }
        var a = el('a', null, text);
        a.href = safe;
        if (external) {
            a.target = '_blank';
            a.rel = 'noopener';
        }
        return a;
    }

    /* ── Version bindings ─────────────────────────────────────────────────
       Both sides of the migration are stamped into the markup here rather than
       hard-coded in the HTML, so a version bump is one constant rather than a
       search and replace. The markup still carries correct values for readers
       without JavaScript. */

    function applyVersionBindings() {
        var bindings = (SOURCE.versionBindings || []).concat([
            { attr: 'data-nic-version', text: NIC.VERSION },
            { attr: 'data-nic-release-link', href: NIC.RELEASE_URL },
            { attr: 'data-nic-crd-install', text: NIC.CRD_INSTALL_CMD },
            { attr: 'data-nic-helm-install', text: NIC.HELM_INSTALL_CMD }
        ]);
        bindings.forEach(function (b) {
            $$('[' + b.attr + ']').forEach(function (node) {
                if (b.text != null) { node.textContent = b.text; }
                if (b.href != null) { node.href = b.href; }
            });
        });
    }

    /* ── View switching ───────────────────────────────────────────────────
       The tool's three views are same-hierarchy content, so they are Tabs.
       Inactive views keep hidden="until-found" rather than display:none, so
       find-in-page can still reach a mapping row in a view the reader is not
       looking at — which matters when the reference view holds thousands. */

    var pageNames = SOURCE.strings.pageNames;
    var sectionPageMap = SOURCE.reference.sectionPageMap || {};
    var currentPage = SOURCE.reference.defaultPage;

    function isPage(id) {
        return Object.prototype.hasOwnProperty.call(pageNames, id);
    }

    function showPage(id, opts) {
        opts = opts || {};
        if (!isPage(id)) { return; }

        $$('.tool-page').forEach(function (page) {
            if (page.id === 'page-' + id) {
                page.removeAttribute('hidden');
            } else {
                page.setAttribute('hidden', 'until-found');
            }
        });
        $$('.tab[data-page]').forEach(function (tab) {
            tab.setAttribute('aria-selected',
                tab.getAttribute('data-page') === id ? 'true' : 'false');
        });

        var changed = currentPage !== id;
        currentPage = id;

        if (opts.updateHash !== false && window.location.hash !== '#' + id) {
            history.pushState(null, '', '#' + id);
        }
        if (!opts.silent) { announce('Showing ' + pageNames[id]); }
        if (changed && !opts.skipScroll) { window.scrollTo(0, 0); }
    }

    /* The sticky filter bar overlaps an anchor target, so scrolling to a
       heading has to clear both the top bar and, on desktop, the controls. */
    function scrollOffsetFor(target) {
        var offset = 72;
        var page = target.closest ? target.closest('.tool-page') : null;
        var controls = page ? page.querySelector('.controls') : null;
        if (controls && window.innerWidth > 900) {
            offset += controls.getBoundingClientRect().height;
        }
        return offset;
    }

    function scrollToId(id) {
        var target = $(id);
        if (!target) { return false; }
        var owner = sectionPageMap[id];
        if (!owner) {
            var page = target.closest('.tool-page');
            owner = page ? page.id.replace(/^page-/, '') : null;
        }
        if (owner && owner !== currentPage) {
            showPage(owner, { updateHash: false, skipScroll: true, silent: true });
        }
        var top = target.getBoundingClientRect().top + window.pageYOffset - scrollOffsetFor(target);
        window.scrollTo({ top: top, behavior: 'smooth' });
        return true;
    }

    function navigateFromHash() {
        var hash = window.location.hash.slice(1);
        if (!hash) {
            showPage(SOURCE.reference.defaultPage, { updateHash: false, silent: true });
            return;
        }
        if (!/^[\w-]+$/.test(hash)) { return; }
        if (isPage(hash)) {
            showPage(hash, { updateHash: false });
            return;
        }
        scrollToId(hash);
    }

    function initNavigation() {
        $$('.tab[data-page]').forEach(function (tab) {
            tab.addEventListener('click', function () {
                showPage(this.getAttribute('data-page'));
            });
        });

        /* Chromium reveals a hidden="until-found" view when find-in-page
           matches inside it; without this the tab strip would keep claiming a
           different view was active. */
        $$('.tool-page').forEach(function (page) {
            page.addEventListener('beforematch', function () {
                showPage(this.id.replace(/^page-/, ''),
                    { updateHash: false, skipScroll: true, silent: true });
            });
        });

        document.addEventListener('click', function (e) {
            var anchor = e.target.closest ? e.target.closest('a[href^="#"]') : null;
            if (!anchor) { return; }
            var id = anchor.getAttribute('href').slice(1);
            if (!id || !/^[\w-]+$/.test(id)) { return; }
            if (isPage(id)) {
                e.preventDefault();
                showPage(id);
            } else if (scrollToId(id)) {
                e.preventDefault();
                history.pushState(null, '', '#' + id);
            }
        });

        window.addEventListener('hashchange', navigateFromHash);
    }

    /* ── Reference table filtering ────────────────────────────────────────
       One search box and one category select per reference section. Matching is
       plain substring over the row's text, which is what a reader typing an
       annotation name expects; anything cleverer surprises them. */

    function filterSection(section) {
        var input = $(section.search);
        var select = $(section.category);
        var counter = $(section.count);
        var root = $(section.id);
        if (!root) { return; }

        var query = input ? input.value.trim().toLowerCase() : '';
        var category = select ? select.value.toLowerCase() : '';
        var shown = 0;
        var total = 0;

        $$('.table-wrapper', root).forEach(function (wrapper) {
            var heading = wrapper.previousElementSibling;
            while (heading && heading.tagName !== 'H3') {
                heading = heading.previousElementSibling;
            }
            var headingText = heading ? heading.textContent.toLowerCase() : '';
            var categoryHit = !category || headingText.indexOf(category) !== -1;
            var wrapperShown = 0;

            $$('tr.expandable', wrapper).forEach(function (row) {
                total++;
                var example = row.nextElementSibling;
                var hit = categoryHit
                    && (!query || row.textContent.toLowerCase().indexOf(query) !== -1);

                row.style.display = hit ? '' : 'none';
                if (example && example.classList.contains('example-row')) {
                    /* Keep an expanded panel open across a filter change, so
                       refining a search does not collapse what you were reading. */
                    example.style.display =
                        hit && row.classList.contains('expanded') ? 'table-row' : 'none';
                }
                if (hit) { wrapperShown++; shown++; }
            });

            /* Hide an emptied table along with its heading and any note that
               belongs to it — otherwise a filtered view shows a heading and a
               caveat above nothing. */
            var empty = wrapperShown === 0;
            wrapper.style.display = empty ? 'none' : '';
            if (heading) { heading.style.display = empty ? 'none' : ''; }
            var sibling = wrapper.previousElementSibling;
            while (sibling && sibling !== heading) {
                if (sibling.classList && sibling.classList.contains('info-box')) {
                    sibling.style.display = empty ? 'none' : '';
                }
                sibling = sibling.previousElementSibling;
            }
        });

        if (counter) {
            var filtering = !!(query || category);
            counter.textContent = filtering
                ? shown + ' of ' + total + ' shown'
                : total + ' mappings';
            counter.classList.toggle('no-results', filtering && shown === 0);
        }
    }

    function initFiltering() {
        (SOURCE.reference.sections || []).forEach(function (section) {
            var run = function () { filterSection(section); };
            var input = $(section.search);
            var select = $(section.category);
            if (input) { input.addEventListener('input', run); }
            if (select) { select.addEventListener('change', run); }
            run();
        });
    }

    /* ── Disclosure rows ─────────────────────────────────────────────────── */

    function toggleRow(row) {
        var example = row.nextElementSibling;
        if (!example || !example.classList.contains('example-row')) { return; }
        var open = row.classList.toggle('expanded');
        row.setAttribute('aria-expanded', open ? 'true' : 'false');
        example.classList.toggle('visible', open);
        example.style.display = open ? 'table-row' : 'none';
        if (open) { highlightWithin(example); }
    }

    function initExpandableRows() {
        var rows = $$('tr.expandable');
        rows.forEach(function (row) {
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.setAttribute('aria-expanded', 'false');
            row.addEventListener('click', function (e) {
                /* Let a link or a copy button inside the row do its own job. */
                if (e.target.closest('a, button')) { return; }
                toggleRow(this);
            });
            row.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleRow(this);
                }
            });
        });
        return rows.length;
    }

    /* ── Approach tabs ───────────────────────────────────────────────────── */

    function initApproachTabs() {
        $$('.approach-tabs').forEach(function (strip) {
            var tabs = $$('.approach-tab', strip);
            var panel = strip.parentElement;
            strip.setAttribute('role', 'tablist');

            function select(index) {
                tabs.forEach(function (tab, j) {
                    var on = j === index;
                    tab.classList.toggle('active', on);
                    tab.setAttribute('aria-selected', on ? 'true' : 'false');
                    tab.setAttribute('tabindex', on ? '0' : '-1');
                });
                var wanted = tabs[index].getAttribute('data-approach');
                $$('.approach-content', panel).forEach(function (content) {
                    var on = content.getAttribute('data-approach') === wanted;
                    content.classList.toggle('active', on);
                    if (on) { highlightWithin(content); }
                });
            }

            tabs.forEach(function (tab, i) {
                tab.setAttribute('role', 'tab');
                tab.setAttribute('type', 'button');
                var active = tab.classList.contains('active');
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
                tab.setAttribute('tabindex', active ? '0' : '-1');

                tab.addEventListener('click', function () { select(i); });
                tab.addEventListener('keydown', function (e) {
                    var next = null;
                    if (e.key === 'ArrowRight') { next = (i + 1) % tabs.length; }
                    else if (e.key === 'ArrowLeft') { next = (i - 1 + tabs.length) % tabs.length; }
                    else if (e.key === 'Home') { next = 0; }
                    else if (e.key === 'End') { next = tabs.length - 1; }
                    if (next !== null) {
                        e.preventDefault();
                        select(next);
                        tabs[next].focus();
                    }
                });
            });
        });
    }

    /* ── Copy buttons on comparison blocks ───────────────────────────────── */

    function attachCopyButton(block, code, label) {
        var btn = el('button', 'btn btn-xs comparison-copy-btn', 'Copy');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Copy ' + label);
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            copyToClipboard(code.textContent, btn);
        });
        block.appendChild(btn);
    }

    function initComparisonCopy() {
        var blocks = $$('.comparison-block');
        var attached = 0;
        blocks.forEach(function (block) {
            var heading = block.querySelector('h4');
            var code = block.querySelector('pre code');
            if (!heading || !code) { return; }
            attachCopyButton(block, code, heading.textContent.trim() + ' example');
            attached++;
        });

        /* Loud on purpose. The pre-rebuild version returned silently here, so a
           structural change to .comparison-block could remove every copy button
           on the page without a single console message. */
        if (blocks.length && attached !== blocks.length) {
            console.warn('migration-core.js: attached ' + attached + ' copy buttons to '
                + blocks.length + ' comparison blocks. The rest are missing an <h4> or '
                + 'a <pre><code>; check .comparison-block structure.');
        }
        return attached;
    }

    /* ── YAML highlighting ───────────────────────────────────────────────────
       Deferred: highlighting 349 blocks up front costs more than it is worth
       when nearly all of them sit inside collapsed rows. Blocks are done when
       revealed, when the browser is idle, and unconditionally before printing. */

    var DONE = 'data-highlighted';

    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* Returns an HTML string. Every interpolation passes through esc() first,
       which is what makes it safe to assign — the input is arbitrary YAML. */
    function highlightLine(line) {
        if (/^\s*#/.test(line)) {
            return '<span class="yaml-comment">' + esc(line) + '</span>';
        }
        if (/^---\s*$/.test(line)) {
            return '<span class="yaml-separator">' + esc(line) + '</span>';
        }

        /* Split a trailing inline comment off first so it is not styled as a
           value. Only outside quotes. */
        var comment = '';
        var hash = line.indexOf(' #');
        if (hash !== -1 && (line.slice(0, hash).match(/"/g) || []).length % 2 === 0) {
            comment = '<span class="yaml-comment">' + esc(line.slice(hash)) + '</span>';
            line = line.slice(0, hash);
        }

        var m = line.match(/^(\s*-?\s*)([\w.\/-]+)(:)(\s*)(.*)$/);
        if (!m) { return esc(line) + comment; }

        var value = m[5];
        var cls = 'yaml-value';
        if (/^(true|false|on|off|yes|no|null|~)$/i.test(value.trim())) { cls = 'yaml-bool'; }
        else if (/^-?\d+(\.\d+)?[a-zA-Z%]*$/.test(value.trim())) { cls = 'yaml-number'; }

        return esc(m[1])
            + '<span class="yaml-key">' + esc(m[2]) + '</span>'
            + esc(m[3]) + esc(m[4])
            + (value ? '<span class="' + cls + '">' + esc(value) + '</span>' : '')
            + comment;
    }

    function highlightYaml(code) {
        if (code.getAttribute(DONE)) { return; }
        code.setAttribute(DONE, '1');
        /* Safe: every segment of the result is esc()aped inside highlightLine. */
        code.innerHTML = code.textContent.split('\n').map(highlightLine).join('\n');
    }

    function highlightWithin(root) {
        $$('pre code', root).forEach(highlightYaml);
    }

    function initHighlighting() {
        var pending = $$('.comparison-block pre code');
        var index = 0;

        function chunk(deadline) {
            var budget = 0;
            while (index < pending.length && budget < 40) {
                if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 4) { break; }
                highlightYaml(pending[index++]);
                budget++;
            }
            if (index < pending.length) { schedule(); }
        }

        function schedule() {
            if (window.requestIdleCallback) {
                window.requestIdleCallback(chunk, { timeout: 2000 });
            } else {
                setTimeout(function () { chunk(null); }, 50);
            }
        }
        schedule();

        /* A print must not lose highlighting on blocks the idle pass has not
           reached yet. */
        window.addEventListener('beforeprint', function () {
            pending.forEach(highlightYaml);
        });
    }

    /* ── Analyzer input ──────────────────────────────────────────────────── */

    var strategy = (SOURCE.analyzer.strategies && SOURCE.analyzer.strategies.initial) || 'crd';

    function syncEditor() {
        var input = $('yamlInput');
        var layer = $('yamlHighlight');
        if (!input || !layer) { return; }
        var text = input.value;

        /* Safe: highlightLine escapes every segment. */
        layer.innerHTML = text ? text.split('\n').map(highlightLine).join('\n') : '';
        layer.scrollTop = input.scrollTop;
        layer.scrollLeft = input.scrollLeft;

        var dot = $('statusDot');
        if (dot) {
            dot.className = 'status-dot '
                + (text.trim() ? 'status-dot-positive' : 'status-dot-inactive');
        }
        var lineEl = $('statusLines');
        if (lineEl) {
            var lines = text ? text.split('\n').length : 0;
            lineEl.textContent = lines + (lines === 1 ? ' line' : ' lines');
        }

        var pattern = SOURCE.inputStatus && SOURCE.inputStatus.pattern;
        var matchEl = $('statusMatches');
        if (pattern && matchEl) {
            pattern.lastIndex = 0;
            var count = (text.match(pattern) || []).length;
            matchEl.textContent = count + ' ' + SOURCE.inputStatus.noun + (count === 1 ? '' : 's');
        }
    }

    function initEditor() {
        var input = $('yamlInput');
        if (!input) { return; }

        input.addEventListener('input', syncEditor);
        input.addEventListener('scroll', function () {
            var layer = $('yamlHighlight');
            if (layer) {
                layer.scrollTop = input.scrollTop;
                layer.scrollLeft = input.scrollLeft;
            }
        });

        var zone = $('dropZone');
        if (zone) {
            ['dragenter', 'dragover'].forEach(function (type) {
                zone.addEventListener(type, function (e) {
                    e.preventDefault();
                    zone.classList.add('dragging');
                });
            });
            zone.addEventListener('dragleave', function (e) {
                if (!zone.contains(e.relatedTarget)) { zone.classList.remove('dragging'); }
            });
            zone.addEventListener('drop', function (e) {
                e.preventDefault();
                zone.classList.remove('dragging');
                var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (!file) { return; }
                var reader = new FileReader();
                reader.onload = function () {
                    input.value = String(reader.result);
                    syncEditor();
                    announce('Loaded ' + file.name);
                };
                reader.readAsText(file);
            });
        }

        var options = $$('.strategy-option');
        var descriptions = (SOURCE.analyzer.strategies || {}).descriptions || {};

        function paintStrategy() {
            options.forEach(function (option) {
                var on = option.getAttribute('data-strategy') === strategy;
                option.classList.toggle('active', on);
                option.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            var desc = $('strategyDesc');
            if (desc && descriptions[strategy]) { desc.textContent = descriptions[strategy]; }
        }

        options.forEach(function (option) {
            option.addEventListener('click', function () {
                strategy = this.getAttribute('data-strategy');
                paintStrategy();
            });
        });
        paintStrategy();
        syncEditor();
    }

    /* ── Sample presets ──────────────────────────────────────────────────── */

    function closeSampleMenu() {
        var menu = $('sampleMenu');
        var btn = $('sampleBtn');
        if (menu) { menu.classList.remove('visible'); }
        if (btn) { btn.setAttribute('aria-expanded', 'false'); }
    }

    function initSamples() {
        var btn = $('sampleBtn');
        var menu = $('sampleMenu');
        if (!btn || !menu) { return; }

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var open = menu.classList.toggle('visible');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        $$('[data-preset]', menu).forEach(function (item) {
            item.addEventListener('click', function () {
                var name = this.getAttribute('data-preset');
                var presets = SOURCE.analyzer.samplePresets || {};
                var yaml = presets[name] || presets[SOURCE.analyzer.defaultPreset];
                var input = $('yamlInput');
                if (!yaml || !input) { return; }
                input.value = yaml;
                syncEditor();
                closeSampleMenu();
                announce('Loaded the ' + name + ' sample');
            });
        });

        document.addEventListener('click', function (e) {
            if (!menu.contains(e.target) && e.target !== btn) { closeSampleMenu(); }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { closeSampleMenu(); }
        });
    }

    /* ── Analyze ─────────────────────────────────────────────────────────── */

    /* title and message come from SOURCE.strings, which are literals in the
       source module — but they are still built as nodes rather than markup, so
       this stays safe if a future source module interpolates into them. */
    function noticeBox(kind, title, message) {
        var box = el('div', 'info-box ' + kind);
        box.appendChild(el('strong', null, title));
        box.appendChild(document.createTextNode(' ' + message));
        return box;
    }

    function analyzerNotice(kind, title, message) {
        var results = $('analyzerResults');
        if (!results) { return; }
        results.textContent = '';
        results.appendChild(noticeBox(kind, title, message));
    }

    function renderWarnings(warnings) {
        var results = $('analyzerResults');
        if (!results || !warnings || !warnings.length) { return; }
        var frag = document.createDocumentFragment();
        warnings.forEach(function (w) {
            frag.appendChild(noticeBox('warning', w.title, w.message));
        });
        results.insertBefore(frag, results.firstChild);
    }

    function runAnalyze() {
        var input = $('yamlInput');
        var results = $('analyzerResults');
        if (!input || !results) { return; }
        var yamlText = input.value;

        if (!yamlText.trim()) {
            analyzerNotice('warning', SOURCE.strings.analyzeEmpty.title,
                SOURCE.strings.analyzeEmpty.message);
            return;
        }

        try {
            var warnings = util.detectGenericSyntaxWarnings(yamlText);
            var parsed = SOURCE.analyzer.parseInput(yamlText);
            warnings = warnings.concat(parsed.warnings || []);

            if (!parsed.findings || !parsed.findings.length) {
                analyzerNotice('note', SOURCE.strings.noFindings.title,
                    SOURCE.strings.noFindings.message);
                renderWarnings(warnings);
                return;
            }

            var plan = SOURCE.analyzer.buildPlan(parsed, strategy);
            renderPlan(results, plan);
            renderWarnings((plan.warnings || []).concat(warnings));
            results.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            console.error('migration-core.js: analysis failed', err);
            analyzerNotice('warning', 'Analysis failed.',
                'Something went wrong reading that manifest. The browser console has the details.');
        }
    }

    function analyzeYaml() {
        var results = $('analyzerResults');
        var btn = document.querySelector('[data-action="analyzeYaml"]');
        if (!results) { return; }

        results.textContent = '';
        var loading = el('div', 'analyzer-loading');
        loading.appendChild(literal('span', 'analyzer-spinner', ''));
        loading.appendChild(document.createTextNode('Analyzing…'));
        results.appendChild(loading);
        if (btn) { btn.disabled = true; }

        /* Two frames, so the spinner actually paints before the synchronous
           parse blocks the main thread. */
        requestAnimationFrame(function () {
            setTimeout(function () {
                runAnalyze();
                if (btn) { btn.disabled = false; }
            }, 0);
        });
    }

    function clearAnalyzer() {
        var input = $('yamlInput');
        if (input) { input.value = ''; }
        syncEditor();
        var results = $('analyzerResults');
        if (results) {
            results.textContent = '';
            var empty = el('div', 'analyzer-empty');
            empty.appendChild(el('p', null, SOURCE.strings.emptyStateLead));
            empty.appendChild(el('p', null, SOURCE.strings.emptyStateHint));
            results.appendChild(empty);
        }
    }

    /* ── Plan rendering ──────────────────────────────────────────────────────
       Everything below builds nodes. Nothing derived from a plan reaches
       innerHTML; see the note at the top of this file for why that matters. */

    var CRD_BADGE = {
        Policy: 'badge-policy',
        VirtualServer: 'badge-virtualserver',
        VirtualServerRoute: 'badge-virtualserverroute',
        TransportServer: 'badge-transportserver',
        GlobalConfiguration: 'badge-globalconfiguration'
    };

    function comparisonBlock(side, spec) {
        spec = spec || {};
        var block = el('div', 'comparison-block ' + side);

        var heading = el('h4', null, spec.title || '');
        if (spec.badge) { heading.appendChild(el('span', 'badge', spec.badge)); }
        block.appendChild(heading);

        var pre = el('pre');
        var code = el('code', null, spec.yaml || '');
        pre.appendChild(code);
        block.appendChild(pre);

        attachCopyButton(block, code, (spec.title || 'this') + ' example');
        highlightYaml(code);
        return block;
    }

    function comparisonPair(spec) {
        var wrap = el('div', 'comparison');
        wrap.appendChild(comparisonBlock('old', spec.old));
        wrap.appendChild(comparisonBlock('new', spec.new));
        return wrap;
    }

    function renderBlock(block) {
        if (block.type === 'comparison') { return comparisonPair(block); }

        if (block.type === 'dual-note') {
            return el('p', 'analyzer-dual-note', block.text);
        }

        if (block.type === 'crd-install-note') {
            /* Literal markup: no plan data is interpolated. */
            return literal('div', 'info-box note',
                'These resources need the NGINX Ingress Controller custom resource '
                + 'definitions installed. See <a href="#installation">Installing CRDs</a>.');
        }

        if (block.type === 'crd-group') {
            var group = el('div', 'analyzer-crd-group');
            var title = el('p', 'analyzer-crd-title');
            title.appendChild(el('span',
                'badge ' + (CRD_BADGE[block.kind] || 'badge-virtualserver'), block.kind));
            if (block.countText) {
                title.appendChild(el('span', 'analyzer-step-count crd', block.countText));
            }
            group.appendChild(title);
            (block.items || []).forEach(function (item) {
                if (item.dualSuffix) {
                    group.appendChild(el('p', 'analyzer-dual-note', item.dualSuffix));
                }
                group.appendChild(comparisonPair(item));
            });
            return group;
        }

        /* Unknown type. The strings come from the source module, so this is the
           drift detector between the two halves of the tool. */
        console.warn('migration-core.js: unrecognised plan block type "' + block.type
            + '" — skipped. Does the source module emit a type this renderer '
            + 'does not handle?');
        return null;
    }

    function renderPills(plan, container) {
        if (!plan.pills || !plan.pills.length) { return; }
        var summary = el('div', 'analyzer-summary');
        plan.pills.forEach(function (pill) {
            var node;
            if (pill.scrollTo) {
                node = el('button', 'analyzer-pill ' + (pill.cls || ''), pill.text);
                node.type = 'button';
                node.addEventListener('click', function () { scrollToId(pill.scrollTo); });
            } else {
                node = el('span', 'analyzer-pill ' + (pill.cls || ''), pill.text);
            }
            summary.appendChild(node);
        });
        container.appendChild(summary);
    }

    function renderBanner(plan, container) {
        if (!plan.banner) { return; }
        var banner = el('div', 'analyzer-banner');
        var text = el('span');
        text.appendChild(el('strong', null, plan.banner.strongText || ''));
        text.appendChild(document.createTextNode(plan.banner.restText || ''));
        banner.appendChild(text);

        if (plan.banner.complexity) {
            var levels = { simple: 1, moderate: 2, advanced: 3 };
            var filled = levels[plan.banner.complexity] || 1;
            var wrap = el('span', 'analyzer-complexity',
                plan.banner.complexity.charAt(0).toUpperCase() + plan.banner.complexity.slice(1));
            var dots = el('span', 'analyzer-dots');
            for (var i = 1; i <= 3; i++) {
                dots.appendChild(el('span', i <= filled ? 'filled' : null));
            }
            wrap.appendChild(dots);
            banner.appendChild(wrap);
        }
        container.appendChild(banner);
    }

    function renderSteps(plan, container) {
        (plan.steps || []).forEach(function (step, index) {
            var section = el('section', 'analyzer-step');
            if (step.id) { section.id = step.id; }

            var header = el('div', 'analyzer-step-header');
            header.appendChild(el('span',
                'analyzer-step-number' + (step.countCls === 'unsupported' ? ' warning' : ''),
                String(index + 1)));
            header.appendChild(el('h3', 'analyzer-step-title', step.title));
            if (step.countText) {
                header.appendChild(el('span',
                    'analyzer-step-count ' + (step.countCls || ''), step.countText));
            }
            section.appendChild(header);

            if (step.desc) { section.appendChild(el('p', 'analyzer-step-desc', step.desc)); }
            (step.blocks || []).forEach(function (block) {
                var node = renderBlock(block);
                if (node) { section.appendChild(node); }
            });
            container.appendChild(section);
        });
    }

    /* note.code carries the visitor's own annotation name AND its value. It is
       a text node inside <code>, never markup. */
    function renderInfoNotes(plan, container) {
        (plan.infoNotes || []).forEach(function (note) {
            var box = el('div', 'info-box note');
            if (note.code) {
                box.appendChild(el('code', null, note.code));
                box.appendChild(document.createTextNode(' '));
            }
            box.appendChild(document.createTextNode(note.message || ''));
            container.appendChild(box);
        });
    }

    /* card.code is a join of the visitor's annotation names — same rule. */
    function renderUnsupported(plan, container) {
        if (!plan.unsupported) { return; }
        var section = el('section', 'analyzer-step');
        var header = el('div', 'analyzer-step-header');
        header.appendChild(el('h3', 'analyzer-step-title', plan.unsupported.title));
        if (plan.unsupported.countText) {
            header.appendChild(el('span', 'analyzer-step-count unsupported',
                plan.unsupported.countText));
        }
        section.appendChild(header);
        if (plan.unsupported.desc) {
            section.appendChild(el('p', 'analyzer-step-desc', plan.unsupported.desc));
        }

        (plan.unsupported.cards || []).forEach(function (card) {
            var node = el('div', 'analyzer-card unrecognized');
            var title = el('p', 'analyzer-card-title');
            if (card.code) {
                title.appendChild(el('code', null, card.code));
                title.appendChild(document.createTextNode(' '));
            }
            title.appendChild(document.createTextNode(card.title || ''));
            node.appendChild(title);
            if (card.desc) { node.appendChild(el('p', null, card.desc)); }
            if (card.anchor && /^[\w-]+$/.test(card.anchor)) {
                var a = el('a', 'link-arrow', 'See the reference ›');
                a.href = '#' + card.anchor;
                node.appendChild(a);
            }
            section.appendChild(node);
        });
        container.appendChild(section);
    }

    function renderUnrecognized(plan, container) {
        if (!plan.unrecognized) { return; }
        var section = el('section', 'analyzer-step');
        section.appendChild(el('h3', 'analyzer-step-title', plan.unrecognized.title));
        if (plan.unrecognized.desc) {
            section.appendChild(el('p', 'analyzer-step-desc', plan.unrecognized.desc));
        }
        (plan.unrecognized.items || []).forEach(function (item) {
            var card = el('div', 'analyzer-card unrecognized');
            var pre = el('pre');
            pre.appendChild(el('code', null, item.yaml || ''));
            card.appendChild(pre);
            section.appendChild(card);
        });
        /* Literal markup: no plan data. */
        section.appendChild(literal('p', null,
            'Spotted a mapping that should be here? '
            + '<a href="https://github.com/nginx/kubernetes.nginx.org/issues/new" '
            + 'target="_blank" rel="noopener">Open an issue</a>.'));
        container.appendChild(section);
    }

    function renderExport(plan, container) {
        if (!plan.export || !plan.export.parts || !plan.export.parts.length) { return; }
        var yaml = plan.export.parts.join('\n---\n');
        var actions = el('div', 'analyzer-export');

        var copyAll = el('button', 'btn btn-primary', 'Copy All Migration YAML');
        copyAll.type = 'button';
        copyAll.addEventListener('click', function () { copyToClipboard(yaml, copyAll); });
        actions.appendChild(copyAll);

        var download = el('button', 'btn btn-secondary', 'Download YAML');
        download.type = 'button';
        download.addEventListener('click', function () {
            var stamp = new Date().toISOString().slice(0, 10);
            var body = SOURCE.export.header + '\n# Generated: ' + stamp + '\n\n' + yaml;
            var blob = new Blob([body], { type: 'text/yaml' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = SOURCE.export.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            announce('Downloaded ' + SOURCE.export.filename);
        });
        actions.appendChild(download);

        var edit = el('button', 'btn btn-secondary', 'Edit YAML and Re-analyze');
        edit.type = 'button';
        edit.addEventListener('click', function () {
            var input = $('yamlInput');
            if (input) {
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                input.focus();
            }
        });
        actions.appendChild(edit);
        container.appendChild(actions);
    }

    function renderNextItems(plan, container) {
        if (!plan.nextItems || !plan.nextItems.length) { return; }
        var section = el('section', 'analyzer-next');
        section.appendChild(el('h3', 'analyzer-step-title', 'What next?'));
        var list = el('ul');
        plan.nextItems.forEach(function (item) {
            var li = el('li');
            if (item.href) {
                li.appendChild(link(item.href, item.text, item.external));
            } else if (item.anchor && /^[\w-]+$/.test(item.anchor)) {
                li.appendChild(link('#' + item.anchor, item.text, false));
            } else {
                li.textContent = item.text;
            }
            list.appendChild(li);
        });
        section.appendChild(list);
        container.appendChild(section);
    }

    function renderPlan(container, plan) {
        container.textContent = '';
        renderPills(plan, container);

        var live = $('analyzerLive');
        if (live && plan.liveText) { live.textContent = plan.liveText; }

        renderBanner(plan, container);
        renderSteps(plan, container);
        renderInfoNotes(plan, container);
        renderUnsupported(plan, container);
        renderUnrecognized(plan, container);
        renderExport(plan, container);
        renderNextItems(plan, container);
    }

    /* ── Checklist ───────────────────────────────────────────────────────────
       Keyed by each item's data-id, not its index, so reordering the list does
       not shuffle what a returning visitor has ticked. The storage key predates
       the core/source split and must not be renamed. */

    function initChecklist() {
        var list = $('migrationChecklist');
        if (!list) { return; }
        var items = $$('li', list);
        var key = SOURCE.storage.checklist;
        var state = {};

        try {
            state = JSON.parse(localStorage.getItem(key) || '{}') || {};
        } catch (e) { state = {}; }

        function save() {
            try { localStorage.setItem(key, JSON.stringify(state)); }
            catch (e) { /* quota or private browsing — the session still works */ }
        }

        function idFor(item, index) {
            return item.getAttribute('data-id') || String(index);
        }

        function paint() {
            var done = 0;
            items.forEach(function (item, index) {
                var on = !!state[idFor(item, index)];
                item.setAttribute('aria-checked', on ? 'true' : 'false');
                if (on) { done++; }
            });
            var progress = $('checklistProgress');
            if (progress) {
                progress.textContent = done + ' of ' + items.length + ' complete';
            }
        }

        items.forEach(function (item, index) {
            function toggle() {
                var id = idFor(item, index);
                state[id] = !state[id];
                save();
                paint();
            }
            item.addEventListener('click', toggle);
            item.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            });
        });

        var reset = $('checklistReset');
        if (reset) {
            reset.addEventListener('click', function () {
                state = {};
                save();
                paint();
                announce('Checklist reset');
            });
        }
        paint();
    }

    /* ── End-of-maintenance banner ───────────────────────────────────────────
       Unmissable the first time, collapsible after that, remembered. */

    function initEolBanner() {
        var banners = $$('.eol-warning');
        if (!banners.length || !SOURCE.eolCompact) { return; }
        var key = SOURCE.storage.eolCollapsed;
        var collapsed = false;
        try { collapsed = localStorage.getItem(key) === '1'; } catch (e) { collapsed = false; }

        banners.forEach(function (banner) {
            var compact = el('div', 'info-box warning eol-compact');
            compact.appendChild(el('strong', null, SOURCE.eolCompact.strongText));
            compact.appendChild(document.createTextNode(SOURCE.eolCompact.restText));
            var expand = el('button', 'btn btn-tertiary eol-toggle', 'Details');
            expand.type = 'button';
            compact.appendChild(expand);
            banner.parentNode.insertBefore(compact, banner);

            var hide = el('button', 'btn btn-tertiary eol-toggle', 'Hide');
            hide.type = 'button';
            banner.appendChild(hide);

            function apply(next) {
                collapsed = next;
                banner.style.display = collapsed ? 'none' : '';
                compact.classList.toggle('visible', collapsed);
                try { localStorage.setItem(key, collapsed ? '1' : '0'); }
                catch (e) { /* ignore */ }
            }
            hide.addEventListener('click', function () { apply(true); });
            expand.addEventListener('click', function () { apply(false); });
            apply(collapsed);
        });
    }

    /* ── Scroll to top ───────────────────────────────────────────────────── */

    function initScrollTop() {
        var btn = literal('button', 'scroll-to-top',
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" '
            + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
            + 'stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Scroll to top');
        btn.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        document.body.appendChild(btn);

        var ticking = false;
        window.addEventListener('scroll', function () {
            if (ticking) { return; }
            ticking = true;
            requestAnimationFrame(function () {
                btn.classList.toggle('visible', window.pageYOffset > 600);
                ticking = false;
            });
        }, { passive: true });
    }

    /* ── Heading anchors ─────────────────────────────────────────────────── */

    function initHeadingAnchors() {
        $$('.tool-page h2[id], .tool-page h3[id]').forEach(function (heading) {
            var a = el('a', 'heading-anchor', '#');
            a.href = '#' + heading.id;
            a.setAttribute('aria-label', 'Link to ' + heading.textContent.trim());
            heading.appendChild(a);
        });
    }

    /* ── Delegated actions ───────────────────────────────────────────────── */

    var ACTIONS = {
        analyzeYaml: analyzeYaml,
        clearAnalyzer: clearAnalyzer
    };

    function initActions() {
        document.addEventListener('click', function (e) {
            var trigger = e.target.closest ? e.target.closest('[data-action]') : null;
            if (!trigger) { return; }
            var action = ACTIONS[trigger.getAttribute('data-action')];
            if (action) {
                e.preventDefault();
                action();
            }
        });
    }

    /* ── Boot ────────────────────────────────────────────────────────────── */

    document.addEventListener('DOMContentLoaded', function () {
        applyVersionBindings();
        initNavigation();
        initHeadingAnchors();
        var rows = initExpandableRows();
        initApproachTabs();
        var copies = initComparisonCopy();
        initFiltering();
        initHighlighting();
        initEditor();
        initSamples();
        initActions();
        initChecklist();
        initEolBanner();
        initScrollTop();
        clearAnalyzer();
        navigateFromHash();

        if (!rows || !copies) {
            console.warn('migration-core.js: wired ' + rows + ' expandable rows and '
                + copies + ' copy buttons. A zero here means the reference tables '
                + 'did not load as expected.');
        }
    });
}());
