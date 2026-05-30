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
