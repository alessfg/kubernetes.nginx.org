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

        // Copy buttons on every .comparison-block (clipboard + fallback).
        document.querySelectorAll('.comparison-block').forEach(function(block) {
            let h5 = block.querySelector('h5');
            let pre = block.querySelector('pre');
            if (!h5 || !pre) return;
            if (h5.querySelector('.comparison-copy-btn')) return;
            let btn = document.createElement('button');
            btn.className = 'comparison-copy-btn';
            btn.textContent = 'Copy';
            btn.setAttribute('aria-label', 'Copy code snippet');
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                let code = pre.textContent;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(code).then(function() {
                        btn.textContent = 'Copied!';
                        btn.classList.add('copied');
                        setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
                    }).catch(function() {
                        btn.textContent = 'Failed';
                        setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
                    });
                } else {
                    let textarea = document.createElement('textarea');
                    textarea.value = code;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    try {
                        document.execCommand('copy');
                        btn.textContent = 'Copied!';
                        btn.classList.add('copied');
                    } catch (err) {
                        btn.textContent = 'Failed';
                    } finally {
                        document.body.removeChild(textarea);
                    }
                    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
                }
            });
            h5.appendChild(btn);
        });

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
