'use strict';

// Sidebar toggle (mobile)
(function() {
    let menuToggle = document.getElementById('menuToggle');
    let sidebar = document.getElementById('sidebar');
    let backdrop = document.getElementById('sidebarBackdrop');
    if (!menuToggle || !sidebar) return;
    function openSidebar() {
        sidebar.classList.add('open');
        if (backdrop) backdrop.classList.add('visible');
        menuToggle.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        if (backdrop) backdrop.classList.remove('visible');
        menuToggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
        menuToggle.focus();
    }
    menuToggle.addEventListener('click', function() {
        if (sidebar.classList.contains('open')) closeSidebar();
        else openSidebar();
    });
    if (backdrop) backdrop.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && sidebar.classList.contains('open')) closeSidebar();
    });
})();

// Dark mode (flash prevention in <head> applies to documentElement; sync body here)
(function() {
    function updateDarkAriaLabel() {
        let btn = document.getElementById('darkToggle');
        if (!btn) return;
        let isDark = document.documentElement.classList.contains('dark-mode') || document.body.classList.contains('dark-mode');
        btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    }
    // Sync body class from documentElement (set by head script)
    if (document.documentElement.classList.contains('dark-mode')) {
        document.body.classList.add('dark-mode');
    }
    updateDarkAriaLabel();
    let darkToggle = document.getElementById('darkToggle');
    if (darkToggle) {
        darkToggle.addEventListener('click', function() {
            let isDark = !document.body.classList.contains('dark-mode');
            document.documentElement.classList.toggle('dark-mode', isDark);
            document.body.classList.toggle('dark-mode', isDark);
            localStorage.setItem('darkMode', isDark ? '1' : '0');
            updateDarkAriaLabel();
        });
    }
})();

// Scroll-to-top button (created dynamically to ensure it exists)
(function() {
    let btn = document.createElement('button');
    btn.className = 'scroll-to-top';
    btn.id = 'scrollTopBtn';
    btn.setAttribute('aria-label', 'Scroll to top');
    let svgNS = 'http://www.w3.org/2000/svg';
    let svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    let polyline = document.createElementNS(svgNS, 'polyline');
    polyline.setAttribute('points', '18 15 12 9 6 15');
    svg.appendChild(polyline);
    btn.appendChild(svg);
    document.body.appendChild(btn);

    window.addEventListener('scroll', function() {
        if (window.scrollY > 400) {
            btn.classList.add('visible');
        } else {
            btn.classList.remove('visible');
        }
    });
    btn.addEventListener('click', function() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
})();

// Migration checklist — toggle items and persist in localStorage
(function() {
    let STORAGE_KEY = 'migrationChecklist';
    let list = document.getElementById('migrationChecklist');
    if (!list) return;
    let items = list.querySelectorAll('li');

    function loadState() {
        try {
            let raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveState(state) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
        catch (e) { /* quota or private browsing */ }
    }

    function toggle(li, index) {
        let state = loadState();
        let isChecked = li.classList.toggle('checked');
        li.setAttribute('aria-checked', isChecked ? 'true' : 'false');
        if (isChecked) { state[index] = true; } else { delete state[index]; }
        saveState(state);
    }

    // Restore saved state
    let state = loadState();
    for (let i = 0; i < items.length; i++) {
        if (state[i]) {
            items[i].classList.add('checked');
            items[i].setAttribute('aria-checked', 'true');
        }
    }

    // Click and keyboard handlers
    list.addEventListener('click', function(e) {
        let li = e.target.closest('li');
        if (!li) return;
        toggle(li, Array.prototype.indexOf.call(items, li));
    });
    list.addEventListener('keydown', function(e) {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        let li = e.target.closest('li');
        if (!li) return;
        e.preventDefault();
        toggle(li, Array.prototype.indexOf.call(items, li));
    });
})();

// ── Reference-table helpers (shared across migration tools) ──
// Layout contract: every migration tool's Reference Guide ships exactly four
// <section> elements with these IDs — #differences, #mappings, #plus-mappings,
// #configmap-mappings. Inside #mappings / #plus-mappings / #configmap-mappings
// the search/filter controls use the IDs and data-filter-source values that
// filterTable() below expects, and category h3 headers carry an id so the
// category dropdown can be populated automatically.

function toggleRow(row) {
    const exampleRow = row.nextElementSibling;
    if (exampleRow && exampleRow.classList.contains('example-row')) {
        row.classList.toggle('expanded');
        exampleRow.classList.toggle('visible');
        let isExpanded = row.classList.contains('expanded');
        row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        exampleRow.setAttribute('aria-hidden', isExpanded ? 'false' : 'true');
    }
}

function switchApproach(btn, type) {
    const container = btn.closest('.example-content');
    if (!container) return;
    container.querySelectorAll('.approach-tab').forEach(function(t) {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
    });
    container.querySelectorAll('.approach-content').forEach(function(c) {
        c.classList.remove('active');
        c.setAttribute('aria-hidden', 'true');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    let panel = container.querySelector('.approach-content[data-approach="' + type + '"]');
    if (panel) {
        panel.classList.add('active');
        panel.setAttribute('aria-hidden', 'false');
    }
}

function expandAllExamples(btn) {
    let scope = btn ? btn.closest('section') : document;
    if (!scope) scope = document;
    scope.querySelectorAll('.expandable').forEach(function(row) {
        row.classList.add('expanded');
        row.setAttribute('aria-expanded', 'true');
        const exampleRow = row.nextElementSibling;
        if (exampleRow && exampleRow.classList.contains('example-row')) {
            exampleRow.classList.add('visible');
            exampleRow.setAttribute('aria-hidden', 'false');
        }
    });
}

function collapseAllExamples(btn) {
    let scope = btn ? btn.closest('section') : document;
    if (!scope) scope = document;
    scope.querySelectorAll('.expandable').forEach(function(row) {
        row.classList.remove('expanded');
        row.setAttribute('aria-expanded', 'false');
        const exampleRow = row.nextElementSibling;
        if (exampleRow && exampleRow.classList.contains('example-row')) {
            exampleRow.classList.remove('visible');
            exampleRow.setAttribute('aria-hidden', 'true');
        }
    });
}

function populateCategoryFilter(filterId, sectionId) {
    let filter = document.getElementById(filterId);
    let section = document.getElementById(sectionId);
    if (filter && section) {
        section.querySelectorAll('h3[id]').forEach(function(h3) {
            let opt = document.createElement('option');
            opt.value = h3.id;
            opt.textContent = h3.textContent;
            filter.appendChild(opt);
        });
    }
}

let _savedExpandedRows = [];
function filterTable(source) {
    let ossInput = document.getElementById('searchInput');
    let plusInput = document.getElementById('searchInputPlus');
    let cmInput = document.getElementById('searchInputConfigMap');
    let catFilter = document.getElementById('categoryFilter');
    let catFilterPlus = document.getElementById('categoryFilterPlus');
    let catFilterCM = document.getElementById('categoryFilterConfigMap');
    if (!ossInput) return;
    // Mirror search input across the three sections.
    if (source === 'plus' && plusInput) ossInput.value = plusInput.value;
    else if (source === 'configmap' && cmInput) ossInput.value = cmInput.value;
    if (plusInput) plusInput.value = ossInput.value;
    if (cmInput) cmInput.value = ossInput.value;
    let term = ossInput.value.toLowerCase();
    let categoryOss = catFilter ? catFilter.value : '';
    let categoryPlus = catFilterPlus ? catFilterPlus.value : '';
    let categoryCM = catFilterCM ? catFilterCM.value : '';
    let anyCategory = categoryOss || categoryPlus || categoryCM;
    if ((term || anyCategory) && _savedExpandedRows.length === 0) {
        document.querySelectorAll('.expandable.expanded').forEach(function(r) { _savedExpandedRows.push(r); });
    }
    let totalVisible = 0;
    let totalRows = 0;
    document.querySelectorAll('.mapping-table').forEach(function(table) {
        let visibleCount = 0;
        let wrapper = table.closest('.table-wrapper');
        // Walk back past any intro <p> between h3 and wrapper.
        let h3 = wrapper ? wrapper.previousElementSibling : null;
        while (h3 && h3.tagName === 'P') h3 = h3.previousElementSibling;
        let tableCategory = (h3 && h3.tagName === 'H3' && h3.id) ? h3.id : '';
        let parentSection = table.closest('section[id]');
        let sectionId = parentSection ? parentSection.id : '';
        let category = '';
        if (sectionId === 'mappings') category = categoryOss;
        else if (sectionId === 'plus-mappings') category = categoryPlus;
        else if (sectionId === 'configmap-mappings') category = categoryCM;
        let categoryMatch = !category || tableCategory === category;
        table.querySelectorAll('tbody tr').forEach(function(row) {
            if (row.classList.contains('example-row')) {
                if (term || category) {
                    row.classList.remove('visible');
                    row.setAttribute('aria-hidden', 'true');
                    let prev = row.previousElementSibling;
                    if (prev) { prev.classList.remove('expanded'); prev.setAttribute('aria-expanded', 'false'); }
                }
                return;
            }
            totalRows++;
            let textMatch = !term || row.textContent.toLowerCase().includes(term);
            let match = textMatch && categoryMatch;
            row.style.display = match ? '' : 'none';
            if (match) visibleCount++;
        });
        totalVisible += visibleCount;
        if (!wrapper) return;
        let hidden = (term || category) && visibleCount === 0;
        wrapper.style.display = hidden ? 'none' : '';
        if (h3 && h3.tagName === 'H3') h3.style.display = hidden ? 'none' : '';
        // Also hide intro <p> if present between h3 and wrapper.
        let pIntro = h3 ? h3.nextElementSibling : null;
        if (pIntro && pIntro.tagName === 'P' && pIntro.nextElementSibling === wrapper) {
            pIntro.style.display = hidden ? 'none' : '';
        }
        let infoBox = wrapper.nextElementSibling;
        if (infoBox && infoBox.classList && infoBox.classList.contains('info-box')) infoBox.style.display = hidden ? 'none' : '';
    });
    let countText = '';
    let noResults = false;
    if (term) {
        countText = totalVisible + ' of ' + totalRows + ' rows';
        noResults = totalVisible === 0;
    }
    let countEl = document.getElementById('searchCount');
    let countElPlus = document.getElementById('searchCountPlus');
    let countElCM = document.getElementById('searchCountConfigMap');
    if (countEl) { countEl.textContent = countText; countEl.className = 'search-count' + (noResults ? ' no-results' : ''); }
    if (countElPlus) { countElPlus.textContent = countText; countElPlus.className = 'search-count' + (noResults ? ' no-results' : ''); }
    if (countElCM) { countElCM.textContent = countText; countElCM.className = 'search-count' + (noResults ? ' no-results' : ''); }
    if (!term && !anyCategory && _savedExpandedRows.length > 0) {
        _savedExpandedRows.forEach(function(r) {
            r.classList.add('expanded');
            r.setAttribute('aria-expanded', 'true');
            let ex = r.nextElementSibling;
            if (ex && ex.classList.contains('example-row')) {
                ex.classList.add('visible');
                ex.setAttribute('aria-hidden', 'false');
            }
        });
        _savedExpandedRows = [];
    }
}

// Extensible action registry. Tools add their own handlers via
// `Object.assign(window.MigrationActions, { ... })` in their inline scripts.
window.MigrationActions = window.MigrationActions || {};
Object.assign(window.MigrationActions, {
    switchApproach: function(el) { switchApproach(el, el.getAttribute('data-approach')); },
    expandAllExamples: function(el) { expandAllExamples(el); },
    collapseAllExamples: function(el) { collapseAllExamples(el); }
});

// Action dispatcher — delegated click + keydown listener for [data-action="..."].
(function() {
    document.addEventListener('click', function(e) {
        let el = e.target.closest('[data-action]');
        if (!el) return;
        let fn = window.MigrationActions[el.getAttribute('data-action')];
        if (fn) {
            if (el.tagName === 'A') e.preventDefault();
            fn(el, e);
        }
    });
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        let el = e.target.closest('[data-action]');
        if (!el || el.tagName === 'BUTTON') return;
        e.preventDefault();
        let fn = window.MigrationActions[el.getAttribute('data-action')];
        if (fn) fn(el, e);
    });
})();

// Reference-table wiring — runs once on DOMContentLoaded.
(function() {
    function init() {
        // Expandable row aria + click/keyboard handlers.
        document.querySelectorAll('.expandable').forEach(function(row, i) {
            row.setAttribute('tabindex', '0');
            row.setAttribute('role', 'button');
            row.setAttribute('aria-expanded', 'false');
            let exampleRow = row.nextElementSibling;
            if (exampleRow && exampleRow.classList.contains('example-row')) {
                if (!exampleRow.id) exampleRow.id = 'example-row-' + i;
                row.setAttribute('aria-controls', exampleRow.id);
                exampleRow.setAttribute('aria-hidden', 'true');
            }
            row.addEventListener('click', function(e) {
                if (e.target.closest('button, a, input, select, textarea, .approach-tab')) return;
                toggleRow(this);
            });
            row.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(this); }
            });
        });
        // Filter input/select handlers (data-filter-source = "oss" | "plus" | "configmap").
        document.querySelectorAll('[data-filter-source]').forEach(function(el) {
            let evt = el.tagName === 'SELECT' ? 'change' : 'input';
            el.addEventListener(evt, function() { filterTable(el.getAttribute('data-filter-source')); });
        });
        // Populate category dropdowns from h3 IDs in each section.
        populateCategoryFilter('categoryFilter', 'mappings');
        populateCategoryFilter('categoryFilterPlus', 'plus-mappings');
        populateCategoryFilter('categoryFilterConfigMap', 'configmap-mappings');
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

// ── YAML syntax highlighter for static example blocks ──

function highlightYaml(text) {
    let frag = document.createDocumentFragment();
    let lines = text.split('\n');
    lines.forEach(function(line, i) {
        if (i > 0) frag.appendChild(document.createTextNode('\n'));
        let trimmed = line.trimStart();
        if (trimmed.startsWith('#')) {
            let indent = document.createTextNode(line.substring(0, line.length - trimmed.length));
            frag.appendChild(indent);
            let commentSpan = document.createElement('span');
            commentSpan.className = 'yaml-comment';
            commentSpan.textContent = trimmed;
            frag.appendChild(commentSpan);
            return;
        }
        if (trimmed === '---') {
            let sepSpan = document.createElement('span');
            sepSpan.className = 'yaml-separator';
            sepSpan.textContent = line;
            frag.appendChild(sepSpan);
            return;
        }
        let kvMatch = line.match(/^(\s*)([-]?\s*)([^\s:#\n]+)(\s*:\s*)(.*)?$/);
        if (kvMatch) {
            frag.appendChild(document.createTextNode(kvMatch[1]));
            if (kvMatch[2]) frag.appendChild(document.createTextNode(kvMatch[2]));
            let keySpan = document.createElement('span');
            keySpan.className = 'yaml-key';
            keySpan.textContent = kvMatch[3];
            frag.appendChild(keySpan);
            let colonSpan = document.createElement('span');
            colonSpan.className = 'yaml-separator';
            colonSpan.textContent = kvMatch[4];
            frag.appendChild(colonSpan);
            if (kvMatch[5] !== undefined && kvMatch[5] !== '') {
                let fullVal = kvMatch[5];
                let commentStart = -1, inQ = false, qc = '';
                for (let ci = 0; ci < fullVal.length; ci++) {
                    let cc = fullVal[ci];
                    if (inQ) { if (cc === qc) inQ = false; }
                    else if (cc === '"' || cc === "'") { inQ = true; qc = cc; }
                    else if (cc === '#' && ci > 0 && fullVal[ci - 1] === ' ') { commentStart = ci; break; }
                }
                let val = commentStart >= 0 ? fullVal.substring(0, commentStart) : fullVal;
                let inlineComment = commentStart >= 0 ? fullVal.substring(commentStart) : '';
                let valSpan = document.createElement('span');
                if (/^(apiVersion|kind|metadata|spec|data)$/.test(kvMatch[3].trim())) {
                    keySpan.className = 'yaml-keyword';
                }
                let valTrimmed = val.trim();
                if (/^["']?(true|false|yes|no|on|off)["']?$/i.test(valTrimmed)) {
                    valSpan.className = 'yaml-bool';
                } else if (/^["']?\d+(\.\d+)?[smhkMG]?["']?$/.test(valTrimmed)) {
                    valSpan.className = 'yaml-number';
                } else if (valTrimmed.startsWith('#')) {
                    valSpan.className = 'yaml-comment';
                } else {
                    valSpan.className = 'yaml-value';
                }
                valSpan.textContent = val;
                frag.appendChild(valSpan);
                if (inlineComment) {
                    let cmSpan = document.createElement('span');
                    cmSpan.className = 'yaml-comment';
                    cmSpan.textContent = inlineComment;
                    frag.appendChild(cmSpan);
                }
            }
            return;
        }
        let listMatch = line.match(/^(\s*)(- )(.*)$/);
        if (listMatch) {
            frag.appendChild(document.createTextNode(listMatch[1]));
            let dashSpan = document.createElement('span');
            dashSpan.className = 'yaml-separator';
            dashSpan.textContent = listMatch[2];
            frag.appendChild(dashSpan);
            let itemSpan = document.createElement('span');
            itemSpan.className = 'yaml-value';
            itemSpan.textContent = listMatch[3];
            frag.appendChild(itemSpan);
            return;
        }
        let fbComment = -1, fbInQ = false, fbQC = '';
        for (let fi = 0; fi < line.length; fi++) {
            let fc = line[fi];
            if (fbInQ) { if (fc === fbQC) fbInQ = false; }
            else if (fc === '"' || fc === "'") { fbInQ = true; fbQC = fc; }
            else if (fc === '#' && fi > 0 && line[fi - 1] === ' ') { fbComment = fi; break; }
        }
        if (fbComment >= 0) {
            frag.appendChild(document.createTextNode(line.substring(0, fbComment)));
            let fbCmSpan = document.createElement('span');
            fbCmSpan.className = 'yaml-comment';
            fbCmSpan.textContent = line.substring(fbComment);
            frag.appendChild(fbCmSpan);
        } else {
            frag.appendChild(document.createTextNode(line));
        }
    });
    return frag;
}

function highlightStaticExamples(root) {
    (root || document).querySelectorAll('pre > code').forEach(function(block) {
        if (block.dataset.highlighted) return;
        try {
            let text = block.textContent;
            let frag = highlightYaml(text);
            block.textContent = '';
            block.appendChild(frag);
            block.dataset.highlighted = '1';
        } catch (e) { /* skip block on error */ }
    });
}

// ── Reference-page enhancement wiring ──
// On DOMContentLoaded: approach-tab ARIA + arrow-key nav, copy buttons on
// .comparison-block, syntax highlighting on all <pre><code>, heading
// permalink anchors. All tool-agnostic — feature-detect and bail when the
// elements aren't present.

(function() {
    function init() {
        // Approach-tab ARIA + arrow-key navigation.
        document.querySelectorAll('.approach-tabs').forEach(function(tabList, i) {
            tabList.setAttribute('role', 'tablist');
            let tabs = tabList.querySelectorAll('.approach-tab');
            tabs.forEach(function(tab) {
                let type = tab.getAttribute('data-approach')
                    || (tab.textContent.toLowerCase().includes('annotation') ? 'annotation' : 'crd');
                let panelId = 'panel-' + i + '-' + type;
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
                tab.setAttribute('aria-controls', panelId);
                tab.id = 'tab-' + i + '-' + type;
            });
            tabList.addEventListener('keydown', function(e) {
                let tabsArr = Array.from(tabs);
                let idx = tabsArr.indexOf(document.activeElement);
                if (idx < 0) return;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    let next = tabsArr[(idx + 1) % tabsArr.length];
                    next.focus();
                    next.click();
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    let prev = tabsArr[(idx - 1 + tabsArr.length) % tabsArr.length];
                    prev.focus();
                    prev.click();
                }
            });
            let container = tabList.closest('.example-content');
            if (container) {
                container.querySelectorAll('.approach-content').forEach(function(panel) {
                    let type = panel.getAttribute('data-approach');
                    panel.setAttribute('role', 'tabpanel');
                    panel.id = 'panel-' + i + '-' + type;
                    panel.setAttribute('aria-labelledby', 'tab-' + i + '-' + type);
                    panel.setAttribute('aria-hidden', panel.classList.contains('active') ? 'false' : 'true');
                });
            }
        });

        // Copy buttons on every static .comparison-block. Dynamic analyzer
        // output uses the same wireCopyButtons() helper post-render.
        wireCopyButtons(document, '.comparison-block', 'comparison-copy-btn');

        // Heading permalink anchors on h2[id] and h3[id].
        document.querySelectorAll('h2[id], h3[id]').forEach(function(heading) {
            if (heading.querySelector('.heading-anchor')) return;
            let anchor = document.createElement('a');
            anchor.className = 'heading-anchor';
            let anchorId = heading.id;
            if (heading.tagName === 'H2') {
                let parentSection = heading.parentElement;
                if (parentSection && parentSection.tagName === 'SECTION' && parentSection.id) anchorId = parentSection.id;
            }
            anchor.href = '#' + anchorId;
            anchor.addEventListener('click', function(e) {
                e.preventDefault();
                history.replaceState(null, '', '#' + anchorId);
                let target = document.getElementById(anchorId);
                if (target) {
                    let y = target.getBoundingClientRect().top + window.pageYOffset - 64;
                    window.scrollTo({ top: y, behavior: 'smooth' });
                }
            });
            anchor.setAttribute('aria-label', 'Permalink: ' + heading.textContent.trim());
            let svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.setAttribute('fill', 'currentColor');
            svg.setAttribute('aria-hidden', 'true');
            let path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z');
            svg.appendChild(path);
            anchor.appendChild(svg);
            heading.appendChild(anchor);
        });

        // Syntax-highlight all static <pre><code> blocks.
        highlightStaticExamples();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();


// ── Analyzer engine helpers (shared across migration tools) ──
// Moved from ingress-nginx-migration.html during Phase 3a. Source-agnostic
// DOM helpers, YAML block builders, and clipboard fallback. Orchestration
// (analyzeYaml, generateMigrationYaml, renderAnalyzerResults) stays
// per-tool until parameterized in Phase 3b.

function detectUnsupportedSyntax(yamlText) {
    let warnings = [];
    // Kustomize manifests (commonAnnotations is applied at build time, not inline)
    if (/^kind:\s*Kustomization\b/m.test(yamlText) || /^commonAnnotations:\s*$/m.test(yamlText)) {
        warnings.push({
            title: 'Kustomize manifest detected',
            message: 'This tool reads inline annotations on Ingress resources. Run `kustomize build` first and paste the rendered Ingress output.'
        });
    }
    // YAML anchors / aliases — we don't expand them, so referenced annotations
    // get silently dropped.
    if (/(^|\s)&[A-Za-z0-9_-]+/m.test(yamlText) || /(:\s|^\s*-\s*)\*[A-Za-z0-9_-]+/m.test(yamlText)) {
        warnings.push({
            title: 'YAML anchors or aliases detected',
            message: 'The analyzer does not expand `&anchor` / `*alias` references. Resolve them (or paste the rendered manifest) for accurate results.'
        });
    }
    // Helm template syntax — also pre-render
    if (/\{\{[^}]+\}\}/.test(yamlText)) {
        warnings.push({
            title: 'Helm template syntax detected',
            message: '`{{ ... }}` placeholders are not evaluated. Run `helm template` and paste the rendered output.'
        });
    }
    return warnings;
}

function unwrapTranslated(result) {
    if (result && typeof result === 'object' && 'value' in result) {
        return { value: result.value, note: result.note || null };
    }
    return { value: result, note: null };
}

function formatYamlKV(indent, key, value) {
    if (value && value.indexOf('|\\n') === 0) {
        let lines = value.substring(3).split('\\n');
        return indent + key + ': |\n' + lines.map(function(l) { return indent + '  ' + l.trim(); }).join('\n');
    }
    let escaped = value ? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : value;
    return indent + key + ': "' + escaped + '"';
}

function parseIngressSpec(yamlText) {
    let specs = [];
    let docs = yamlText.split(/^---\s*$/m);
    docs.forEach(function(doc) {
        let spec = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: null };
        let lines = doc.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let trimmed = line.trim();
            if (trimmed.startsWith('#') || trimmed === '') continue;
            let indent = line.length - line.trimStart().length;
            // Ingress name
            if (/^\s{2}name:\s/.test(line) && indent <= 4 && !spec.ingressName) {
                let m = trimmed.match(/^name:\s*["']?([^"'\s]+)["']?/);
                if (m) spec.ingressName = m[1];
            }
            // Host from rules
            if (/^\s+-?\s*host:\s/.test(line) && !spec.host) {
                let m = trimmed.match(/^-?\s*host:\s*["']?([^"'\s]+)["']?/);
                if (m) spec.host = m[1];
            }
            // Path
            if (/^\s+-?\s*path:\s/.test(line) && !spec.path) {
                let m = trimmed.match(/^-?\s*path:\s*["']?([^"'\s]+)["']?/);
                if (m) spec.path = m[1];
            }
            // Service name (v1 style: backend.service.name)
            if (/^\s+name:\s/.test(line) && indent >= 10 && !spec.serviceName) {
                // Check context: previous non-empty lines should include service: or backend:
                for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
                    let prev = lines[k].trim();
                    if (/^service:/.test(prev) || /^backend:/.test(prev) || /^serviceName:/.test(prev)) {
                        let m = trimmed.match(/^name:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.serviceName = m[1];
                        break;
                    }
                }
            }
            // Service name (legacy style: serviceName)
            if (/^\s+serviceName:\s/.test(line) && !spec.serviceName) {
                let m = trimmed.match(/^serviceName:\s*["']?([^"'\s]+)["']?/);
                if (m) spec.serviceName = m[1];
            }
            // Service port number
            if (/^\s+number:\s/.test(line) && indent >= 12 && !spec.servicePort) {
                let m = trimmed.match(/^number:\s*["']?(\d+)["']?/);
                if (m) spec.servicePort = m[1];
            }
            // Service port (legacy style: servicePort)
            if (/^\s+servicePort:\s/.test(line) && !spec.servicePort) {
                let m = trimmed.match(/^servicePort:\s*["']?(\w+)["']?/);
                if (m) spec.servicePort = m[1];
            }
            // TLS secret
            if (/^\s+secretName:\s/.test(line) && !spec.tlsSecret) {
                let m = trimmed.match(/^secretName:\s*["']?([^"'\s]+)["']?/);
                if (m) spec.tlsSecret = m[1];
            }
        }
        specs.push(spec);
    });
    // Merge all docs into one spec (use first non-null value found)
    let merged = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: null };
    specs.forEach(function(s) {
        Object.keys(merged).forEach(function(k) { if (!merged[k] && s[k]) merged[k] = s[k]; });
    });
    return merged;
}

function getAnnotationValue(foundAnnotations, name) {
    let found = foundAnnotations.find(function(a) { return a.annotation === name; });
    return found ? found.value : null;
}

function specHost(spec) { return (spec && spec.host) || '# TODO: Set your host'; }

function specService(spec) { return (spec && spec.serviceName) || '# TODO: Set your service'; }

function specPort(spec) { return (spec && spec.servicePort) || '80'; }

function specPath(spec) { return (spec && spec.path) || '/'; }

function copyAnalyzerBlock(btn) {
    let pre = btn.parentElement;
    if (!pre) return;
    let text = pre.getAttribute('data-raw') || pre.textContent.replace(/^Copy$|^Copied!$/m, '').trim();
    copyToClipboard(text, btn);
}

// Wire copy buttons onto every block matching `blockSelector` under `root`.
// The factory looks for an `<h5>` header + `<pre>` body shape; both static
// example blocks (.comparison-block) and dynamic analyzer output blocks
// (.analyzer-comparison-block) follow that shape, so this helper handles
// both. Reuses copyToClipboard so the clipboard path is defined once.
function wireCopyButtons(root, blockSelector, btnClassName) {
    blockSelector = blockSelector || '.comparison-block';
    btnClassName = btnClassName || 'comparison-copy-btn';
    root.querySelectorAll(blockSelector).forEach(function(block) {
        let h5 = block.querySelector('h5');
        let pre = block.querySelector('pre');
        if (!h5 || !pre) return;
        if (h5.querySelector('.' + btnClassName)) return;
        let btn = document.createElement('button');
        btn.className = btnClassName;
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code snippet');
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            copyToClipboard(pre.textContent, btn);
        });
        h5.appendChild(btn);
    });
}

// ============================================================
// Shared NIC Policy YAML builders
//
// Used by both source-specific generator suites. Each function emits a
// complete NIC Policy CRD as a YAML string. Callers pass concrete values
// (from source-specific annotation/CRD extraction) or null/undefined to
// get TODO placeholders. `sourceHint` adds a source-aware TODO hint when
// the secret isn't known (e.g. ingress-nginx pulls from auth-secret;
// Traefik points the user at Middleware.basicAuth.secret).
// ============================================================
function buildBasicAuthPolicy(secret, realm, sourceHint) {
    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: basic-auth-policy', 'spec:', '  basicAuth:'];
    lines.push('    secret: ' + (secret || ('# TODO: ' + (sourceHint || 'Set your Kubernetes Secret with htpasswd-formatted entries'))));
    lines.push('    realm: "' + (realm || 'Protected Area') + '"');
    return lines.join('\n');
}

function copyToClipboard(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
            if (btn) {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
            }
        }).catch(function() {
            fallbackCopy(text, btn);
        });
    } else {
        fallbackCopy(text, btn);
    }
}

function fallbackCopy(text, btn) {
    let textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        if (btn) {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
        }
    } catch (err) {
        if (btn) btn.textContent = 'Failed';
    } finally {
        document.body.removeChild(textarea);
    }
    if (btn) setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
}

function renderParserWarnings(container, warnings) {
    warnings.forEach(function(w) {
        let card = document.createElement('div');
        card.className = 'info-box warning analyzer-parser-warning';
        let strong = document.createElement('strong');
        strong.textContent = w.title + ': ';
        card.appendChild(strong);
        card.appendChild(document.createTextNode(w.message));
        container.appendChild(card);
    });
}

function showAnalyzerLoading(container) {
    container.textContent = '';
    let wrap = document.createElement('div');
    wrap.className = 'analyzer-loading';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    let spinner = document.createElement('span');
    spinner.className = 'analyzer-loading-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    wrap.appendChild(spinner);
    wrap.appendChild(document.createTextNode('Analyzing your YAML…'));
    container.appendChild(wrap);
}

function showAnalyzerMessage(container, type, title, message, opts) {
    opts = opts || {};
    let div = document.createElement('div');
    div.className = type === 'error' ? 'analyzer-error' : 'analyzer-info';
    let strong = document.createElement('strong');
    strong.textContent = title;
    div.appendChild(strong);
    div.appendChild(document.createTextNode(' ' + message));
    if (!opts.append) container.textContent = '';
    container.appendChild(div);
}

function buildYamlBlock(text, collapsible) {
    let pre = document.createElement('div');
    pre.className = 'analyzer-yaml-output';
    let copyBtn = document.createElement('button');
    copyBtn.className = 'analyzer-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function() { copyAnalyzerBlock(copyBtn); });
    pre.appendChild(copyBtn);
    pre.appendChild(highlightYaml(text));
    pre.setAttribute('data-raw', text);
    let lineCount = text.split('\n').length;
    if (collapsible && lineCount > 12) {
        pre.classList.add('collapsed');
        let wrapper = document.createDocumentFragment();
        wrapper.appendChild(pre);
        let expandBtn = document.createElement('button');
        expandBtn.className = 'analyzer-yaml-expand';
        expandBtn.textContent = 'Show full YAML (' + lineCount + ' lines)';
        expandBtn.addEventListener('click', function() {
            if (pre.classList.contains('collapsed')) {
                pre.classList.remove('collapsed');
                expandBtn.textContent = 'Collapse';
            } else {
                pre.classList.add('collapsed');
                expandBtn.textContent = 'Show full YAML (' + lineCount + ' lines)';
            }
        });
        wrapper.appendChild(expandBtn);
        return wrapper;
    }
    return pre;
}

function buildDiffYamlBlock(text, diffType) {
    // diffType: 'removed' or 'added' — highlights annotation lines (skips the first 'annotations:' line)
    let pre = document.createElement('div');
    pre.className = 'analyzer-yaml-output';
    let copyBtn = document.createElement('button');
    copyBtn.className = 'analyzer-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function() { copyAnalyzerBlock(copyBtn); });
    pre.appendChild(copyBtn);
    let lines = text.split('\n');
    lines.forEach(function(line, i) {
        if (i > 0) pre.appendChild(document.createTextNode('\n'));
        let isAnnotationLine = i > 0 && line.match(/^\s+\S/);
        if (isAnnotationLine) {
            let wrapper = document.createElement('span');
            wrapper.className = 'yaml-diff-line ' + diffType;
            let frag = highlightYaml(line);
            wrapper.appendChild(frag);
            pre.appendChild(wrapper);
        } else {
            pre.appendChild(highlightYaml(line));
        }
    });
    pre.setAttribute('data-raw', text);
    return pre;
}

function buildInstallBlock(installCmd) {
    let div = document.createElement('div');
    div.className = 'analyzer-install-cmd';
    div.setAttribute('data-raw', installCmd);
    let copyBtn = document.createElement('button');
    copyBtn.className = 'analyzer-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', function() { copyAnalyzerBlock(copyBtn); });
    div.appendChild(copyBtn);
    let code = document.createElement('span');
    code.textContent = installCmd;
    div.appendChild(code);
    return div;
}

function toggleSampleDropdown(e) {
    e.stopPropagation();
    let dropdown = document.getElementById('sampleDropdown');
    let btn = e.target.closest('.sample-dropdown-btn');
    let isVisible = dropdown.classList.toggle('visible');
    if (btn) btn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
    if (isVisible && btn) {
        // Position dropdown up or down based on available space
        let btnRect = btn.getBoundingClientRect();
        let spaceBelow = window.innerHeight - btnRect.bottom;
        let spaceAbove = btnRect.top;
        // Temporarily show to measure height
        dropdown.style.top = ''; dropdown.style.bottom = '';
        let dropH = dropdown.offsetHeight;
        if (spaceAbove > dropH + 6 && spaceBelow < dropH + 6) {
            // Open upward
            dropdown.style.bottom = 'calc(100% + 6px)';
            dropdown.style.top = 'auto';
        } else {
            // Open downward
            dropdown.style.top = 'calc(100% + 6px)';
            dropdown.style.bottom = 'auto';
        }
    }
}

function highlightSection(anchorId) {
    let el = document.getElementById(anchorId);
    if (!el) return;
    // Switch to the correct page if needed
    let sectionLink = document.querySelector('.sidebar-link[data-section="' + anchorId + '"]');
    if (sectionLink) {
        sectionLink.click();
    } else {
        // Fallback: check which page contains the element
        let page = el.closest('.tool-page');
        if (page && !page.classList.contains('active')) {
            let pageId = page.id.replace('page-', '');
            let pageBtn = document.querySelector('.sidebar-link[data-page="' + pageId + '"]');
            if (pageBtn) pageBtn.click();
        }
    }
    requestAnimationFrame(function() {
        el.scrollIntoView({ behavior: 'smooth' });
        el.style.transition = 'background-color 0.3s';
        el.style.backgroundColor = document.documentElement.classList.contains('dark-mode') ? 'rgba(255,249,196,0.1)' : '#fff9c4';
        setTimeout(function() {
            el.style.backgroundColor = '';
            setTimeout(function() { el.style.transition = ''; }, 300);
        }, 2000);
    });
}

function showEmptyState() {
    let resultsDiv = document.getElementById('analyzerResults');
    if (resultsDiv.children.length > 0) return;
    let empty = document.createElement('div');
    empty.className = 'analyzer-empty-state';
    empty.id = 'analyzerEmptyState';
    let svgNS = 'http://www.w3.org/2000/svg';
    let svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '48'); svg.setAttribute('height', '48');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#999'); svg.setAttribute('stroke-width', '1.5');
    let path1 = document.createElementNS(svgNS, 'path');
    path1.setAttribute('d', 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z');
    let polyline = document.createElementNS(svgNS, 'polyline');
    polyline.setAttribute('points', '14 2 14 8 20 8');
    let line1 = document.createElementNS(svgNS, 'line');
    line1.setAttribute('x1', '16'); line1.setAttribute('y1', '13');
    line1.setAttribute('x2', '8'); line1.setAttribute('y2', '13');
    let line2 = document.createElementNS(svgNS, 'line');
    line2.setAttribute('x1', '16'); line2.setAttribute('y1', '17');
    line2.setAttribute('x2', '8'); line2.setAttribute('y2', '17');
    svg.appendChild(path1); svg.appendChild(polyline);
    svg.appendChild(line1); svg.appendChild(line2);
    empty.appendChild(svg);
    let p1 = document.createElement('p');
    p1.textContent = 'Paste your Ingress YAML above and click Analyze';
    empty.appendChild(p1);
    let p2 = document.createElement('p');
    p2.className = 'hint';
    p2.textContent = 'Drag & drop a .yaml file, or try "Load Sample" for an example';
    empty.appendChild(p2);
    resultsDiv.appendChild(empty);
}

function updateInputStatus() {
    let val = document.getElementById('yamlInput').value;
    let lineCount = val ? val.split('\n').length : 0;
    let annotationCount = (val.match(/nginx\.ingress\.kubernetes\.io\//g) || []).length;
    document.getElementById('statusLines').textContent = lineCount + ' line' + (lineCount !== 1 ? 's' : '');
    document.getElementById('statusDot').className = 'status-dot ' + (lineCount > 0 ? 'active' : 'inactive');
    let annStatus = document.getElementById('statusAnnotations');
    if (annotationCount > 0) {
        annStatus.style.display = '';
        document.getElementById('statusAnnotationCount').textContent = annotationCount + ' annotation' + (annotationCount !== 1 ? 's' : '') + ' detected';
    } else {
        annStatus.style.display = 'none';
    }
}

function updateYamlHighlight() {
    let textarea = document.getElementById('yamlInput');
    let highlight = document.getElementById('yamlHighlight');
    highlight.textContent = '';
    if (textarea.value) {
        highlight.appendChild(highlightYaml(textarea.value));
        // Append a trailing newline so the pre height matches textarea with trailing newline
        highlight.appendChild(document.createTextNode('\n'));
    }
}

function syncEditorScroll() {
    let textarea = document.getElementById('yamlInput');
    let highlight = document.getElementById('yamlHighlight');
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
}

// ============================================================
// Analyzer engine: source-agnostic annotation parsing/translation
// ============================================================

// Parse Kubernetes Ingress annotations from raw YAML, keeping only entries
// whose key starts with `prefix`. The returned `annotation` is the bare
// suffix (prefix stripped). docIndex preserves which `---`-separated doc
// the annotation came from. `prefix` is required — pass e.g.
// 'nginx.ingress.kubernetes.io/' for the community controller or
// 'traefik.ingress.kubernetes.io/' for Traefik.
function parseYamlAnnotations(yamlText, prefix) {
    let results = [];
    let docs = yamlText.split(/^---\s*$/m);
    docs.forEach(function(doc, docIndex) {
        let lines = doc.split('\n');
        let inAnnotations = false;
        let annotationIndent = -1;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let trimmed = line.trimStart();
            if (trimmed.startsWith('#') || trimmed === '') continue;
            let currentIndent = line.length - line.trimStart().length;
            if (/^\s*annotations\s*:/.test(line)) {
                let inlineMatch = line.match(/annotations\s*:\s*\{(.+)\}/);
                if (inlineMatch) {
                    let pairRegex = /["']?([^"':,]+(?::\/\/[^"':,]*)*)["']?\s*:\s*["']?([^"',}]*(?:,[^"':},]*)*)["']?/g;
                    let pairMatch;
                    while ((pairMatch = pairRegex.exec(inlineMatch[1])) !== null) {
                        let key = pairMatch[1].trim().replace(/^["']|["']$/g, '');
                        let val = pairMatch[2].trim().replace(/^["']|["']$/g, '');
                        if (key.startsWith(prefix)) {
                            results.push({ annotation: key.slice(prefix.length), value: val, docIndex: docIndex });
                        }
                    }
                    inAnnotations = false;
                    continue;
                }
                inAnnotations = true;
                annotationIndent = currentIndent;
                continue;
            }
            if (inAnnotations) {
                if (currentIndent <= annotationIndent && trimmed !== '') {
                    inAnnotations = false;
                    annotationIndent = -1;
                    continue;
                }
                let kvMatch = trimmed.match(/^["']?([^"':]+)["']?\s*:\s*(.*)$/);
                if (kvMatch) {
                    let key = kvMatch[1].trim().replace(/^["']|["']$/g, '');
                    let val = kvMatch[2].trim().replace(/^["']|["']$/g, '');
                    // Handle pipe (|) and block scalar (>) multi-line values
                    if (/^[|>][+-]?\s*$/.test(val)) {
                        let blockLines = [];
                        let blockIndent = -1;
                        for (let j = i + 1; j < lines.length; j++) {
                            let bLine = lines[j];
                            if (bLine.trim() === '') {
                                // Peek ahead: if next non-empty line has lower indent, end block
                                let peek = j + 1;
                                while (peek < lines.length && lines[peek].trim() === '') peek++;
                                if (peek < lines.length && blockIndent !== -1) {
                                    let peekIndent = lines[peek].length - lines[peek].trimStart().length;
                                    if (peekIndent < blockIndent) break;
                                }
                                blockLines.push('');
                                i = j;
                                continue;
                            }
                            let bIndent = bLine.length - bLine.trimStart().length;
                            if (blockIndent === -1) blockIndent = bIndent;
                            if (bIndent < blockIndent) break;
                            blockLines.push(bLine.substring(blockIndent));
                            i = j;
                        }
                        val = blockLines.join('\n').trim();
                    }
                    if (key.startsWith(prefix)) {
                        results.push({ annotation: key.slice(prefix.length), value: val, docIndex: docIndex });
                    }
                }
            }
        }
    });
    return results;
}

// Source-specific transform registry. Sources extend translateValue by
// assigning into this map, e.g.
//   window.MigrationTransforms.lbMethod = function(value, template) { ... }
// The handler must return a string OR { value, note } shape.
window.MigrationTransforms = window.MigrationTransforms || {};

// Translate a source annotation value to its NIC equivalent. Generic
// transforms live in the switch below; source-specific transforms are
// looked up in MigrationTransforms by name. Returns either a string
// (translated value) or { value, note } when a non-trivial substitution
// applied — call sites should unwrap with unwrapTranslated.
function translateValue(value, transform, template) {
    if (!value && value !== '0') return value;
    switch (transform) {
        case 'direct': return value;
        case 'booleanInvert': return value === 'true' ? 'false' : value === 'false' ? 'true' : value;
        case 'appendRateUnit': return /r\/[sm]$/.test(value) ? value : value + 'r/s';
        case 'appendTimeUnit': return /[smhd]$/.test(value) ? value : value + 's';
        case 'appendBufferSize': return /\s/.test(value) ? value : value + ' 8k';
        case 'snippetWrap': return template ? template.replace('${value}', value) : value;
        case 'booleanOnOffSnippet': return template ? template.replace('${value}', value === 'true' ? 'on' : value === 'false' ? 'off' : value) : value;
        case 'backendProtocol': return value; // key selection handled in source generator
        case 'corsSnippet': return value; // handled specially in source generator
        default:
            if (typeof window.MigrationTransforms[transform] === 'function') {
                return window.MigrationTransforms[transform](value, template);
            }
            return value;
    }
}

// ============================================================
// Source registry + analyzer orchestration shell
// ============================================================

// Each migration tool registers a source descriptor here. Shape:
// {
//   name:                'ingress-nginx' | 'traefik' | ...
//   prefix:              annotation prefix (e.g. 'nginx.ingress.kubernetes.io/')
//   mappings:            array of mapping rows (source-specific)
//   lookup:              Map<bare-annotation-name, index-into-mappings>
//   parseSpec(yaml):     returns the Ingress/Route spec object used by render
//   typeOrder:           { type-name: sort-rank } for grouping in the result list
//   emptyResultMessage:  string shown when no recognized annotations found
//   emptyResultHint:     follow-up explanation shown beneath the message
//   render(container, totalAnnotations, sorted, crdCount, unrecognized, ingressSpec):
//                        source-specific renderer (stays inline per source)
//   parseAnnotations(yaml, prefix)?:
//                        optional override of the default annotation parser
//                        (for sources that need CRD-aware extraction)
// }
window.MigrationSources = window.MigrationSources || {};
// Each HTML file sets window.CURRENT_SOURCE to the key it registered above.

function analyzeYaml() {
    let yamlText = document.getElementById('yamlInput').value.trim();
    let resultsDiv = document.getElementById('analyzerResults');
    if (!yamlText) {
        showAnalyzerMessage(resultsDiv, 'error', 'No input.', 'Paste a Kubernetes YAML manifest to analyze.');
        return;
    }
    // Paint a spinner immediately, then defer the heavy work to the next animation
    // frame so the user sees feedback even on multi-hundred-line inputs.
    showAnalyzerLoading(resultsDiv);
    requestAnimationFrame(function() { setTimeout(runAnalyzeYaml, 0); });
}

function runAnalyzeYaml() {
    let source = window.MigrationSources[window.CURRENT_SOURCE];
    let yamlText = document.getElementById('yamlInput').value.trim();
    let resultsDiv = document.getElementById('analyzerResults');
    if (!yamlText) return;
    try {
        let warnings = detectUnsupportedSyntax(yamlText);
        let annotations = typeof source.parseAnnotations === 'function'
            ? source.parseAnnotations(yamlText, source.prefix)
            : parseYamlAnnotations(yamlText, source.prefix);
        let ingressSpec = source.parseSpec(yamlText);
        if (annotations.length === 0) {
            resultsDiv.textContent = '';
            renderParserWarnings(resultsDiv, warnings);
            showAnalyzerMessage(resultsDiv, 'info', source.emptyResultMessage, source.emptyResultHint, { append: true });
            return;
        }
        let matchedMappings = new Map();
        let unrecognized = [];
        annotations.forEach(function(ann) {
            let idx = source.lookup.get(ann.annotation);
            if (idx !== undefined) {
                if (!matchedMappings.has(idx)) {
                    matchedMappings.set(idx, { mapping: source.mappings[idx], foundAnnotations: [] });
                }
                let entry = matchedMappings.get(idx);
                if (!entry.foundAnnotations.some(function(a) { return a.annotation === ann.annotation; })) {
                    entry.foundAnnotations.push({ annotation: ann.annotation, value: ann.value });
                }
            } else {
                if (!unrecognized.some(function(u) { return u.annotation === ann.annotation; })) {
                    unrecognized.push(ann);
                }
            }
        });
        let typeOrder = source.typeOrder || {};
        let sorted = Array.from(matchedMappings.values()).sort(function(a, b) {
            let ta = typeOrder[a.mapping.type] !== undefined ? typeOrder[a.mapping.type] : 99;
            let tb = typeOrder[b.mapping.type] !== undefined ? typeOrder[b.mapping.type] : 99;
            if (ta !== tb) return ta - tb;
            return a.mapping.category.localeCompare(b.mapping.category);
        });
        let crdCount = sorted.filter(function(e) { return e.mapping.type !== 'annotation' && e.mapping.type !== 'configmap' && e.mapping.type !== 'unsupported'; }).length;
        source.render(resultsDiv, annotations.length, sorted, crdCount, unrecognized, ingressSpec);
        // Prepend any parser warnings inside the renderer's now-populated container.
        if (warnings.length > 0) {
            let firstChild = resultsDiv.firstChild;
            let warningHolder = document.createDocumentFragment();
            renderParserWarnings(warningHolder, warnings);
            resultsDiv.insertBefore(warningHolder, firstChild);
        }
        // Smooth scroll to results
        setTimeout(function() {
            resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } catch (err) {
        showAnalyzerMessage(resultsDiv, 'error', 'Analysis failed.', 'There was an error parsing the YAML. Please check the format and try again.');
    }
}

