/* kn/site.js — landing-page behavior (home + product pages): runtime version
   auto-fetch from GitHub, YouTube poster→iframe activation, code-block copy
   buttons, and a redirect shim for old #product deep links.

   Dropped vs the old index.js: the SPA router (showProductFn/handleHash/PRODUCTS),
   entrance animations, sidebar/brand handlers, and the project-card data-navigate
   interception — the 5 SPA views are now real Hugo pages with the theme nav. */
(function() {
    'use strict';

    /* ── Redirect shim for old hash-routed deep links ──
       Old links like https://kubernetes.nginx.org/#nginx-ingress-controller now map
       to the real page. Runs only on the home page. Paths are relative so they work
       under a custom domain or a project-subpath (fork Pages) baseURL. */
    var HASH_REDIRECTS = {
        'nginx-ingress-controller': 'nginx-ingress-controller/',
        'nginx-gateway-fabric': 'nginx-gateway-fabric/',
        'migration-tool': 'migration-tool/',
        'ingress2gateway': 'ingress2gateway/'
    };
    (function redirectOldHash() {
        if (!document.body || document.body.getAttribute('data-kn-home') !== 'true') return;
        var hash = location.hash.replace(/^#/, '');
        if (HASH_REDIRECTS.hasOwnProperty(hash)) {
            location.replace(HASH_REDIRECTS[hash]);
        }
    })();

    /* ── Auto-fetch versions ── */
    var VERSION_CONFIG = {
        nic: { repo: 'nginx/kubernetes-ingress',        fallback: { release: 'v5.5.1', helm: 'v2.6.1' } },
        ngf: { repo: 'nginx/nginx-gateway-fabric',      fallback: { release: 'v2.6.5', helm: 'v2.6.5' } },
        i2g: { repo: 'kubernetes-sigs/ingress2gateway',  fallback: { release: 'v1.1.0' } }
    };
    // Fallbacks can be overridden at build time via window.NGINX_K8S_VERSIONS (see Phase 4).
    if (window.NGINX_K8S_VERSIONS) {
        try {
            ['nic', 'ngf', 'i2g'].forEach(function(k) {
                var v = window.NGINX_K8S_VERSIONS[k];
                if (v && VERSION_CONFIG[k]) {
                    if (v.release) VERSION_CONFIG[k].fallback.release = v.release;
                    if (v.helm) VERSION_CONFIG[k].fallback.helm = v.helm;
                }
            });
        } catch (e) { /* ignore malformed injection */ }
    }
    var VERSION_CACHE_KEY = 'nginx_k8s_versions_v2';
    var VERSION_CACHE_TTL = 3600000; // 1 hour

    function readVersionCache() {
        try {
            var raw = localStorage.getItem(VERSION_CACHE_KEY);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (obj && obj.ts && (Date.now() - obj.ts < VERSION_CACHE_TTL)) return obj.data;
        } catch (e) { /* corrupt or private browsing */ }
        return null;
    }

    function writeVersionCache(data) {
        try { localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data })); }
        catch (e) { /* quota or private browsing */ }
    }

    function applyVersions(data) {
        var els = document.querySelectorAll('[data-version]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var parts = el.getAttribute('data-version').split('.');
            var product = parts[0], field = parts[1];
            if (data[product] && data[product][field]) {
                var ver = data[product][field];
                var fmt = el.getAttribute('data-version-format');
                var vTag = ver.charAt(0) === 'v' ? ver : 'v' + ver;
                if (fmt === 'bare') {
                    el.textContent = ver.replace(/^v/, '');
                } else if (fmt === 'atv') {
                    el.textContent = '@' + vTag;
                } else {
                    el.textContent = vTag;
                }
                if (el.tagName === 'A' && field === 'release' && VERSION_CONFIG[product]) {
                    el.href = 'https://github.com/' + VERSION_CONFIG[product].repo + '/releases/tag/' + vTag;
                }
            }
        }
    }

    // Read the chart `version:` from a project's Helm chart at a specific tag.
    function fetchChartVersion(repo, chartPath, tag) {
        var url = 'https://raw.githubusercontent.com/' + repo + '/' + tag + '/' + chartPath + '/Chart.yaml';
        return fetch(url).then(function(res) {
            if (!res.ok) return null;
            return res.text();
        }).then(function(text) {
            if (!text) return null;
            var m = text.match(/^version:\s*["']?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)["']?/m);
            return m ? 'v' + m[1] : null;
        }).catch(function() { return null; });
    }

    function fetchVersions() {
        var cached = readVersionCache();
        if (cached) { applyVersions(cached); return; }

        var data = {};

        function applyFallback(key) {
            data[key] = {};
            var fb = VERSION_CONFIG[key].fallback;
            for (var f in fb) { if (fb.hasOwnProperty(f)) data[key][f] = fb[f]; }
        }

        function loadProduct(key) {
            var cfg = VERSION_CONFIG[key];
            data[key] = {};
            return fetch('https://api.github.com/repos/' + cfg.repo + '/releases/latest')
                .then(function(res) {
                    if (!res.ok) throw new Error(res.status);
                    return res.json();
                })
                .then(function(json) {
                    var tag = json.tag_name;
                    if (!tag || !/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error('bad tag');
                    var vTag = tag.charAt(0) === 'v' ? tag : 'v' + tag;
                    data[key].release = vTag;

                    if (key === 'nic') {
                        return fetchChartVersion(cfg.repo, 'charts/nginx-ingress', vTag).then(function(helm) {
                            data[key].helm = helm || cfg.fallback.helm || cfg.fallback.release;
                        });
                    }
                    if (key === 'ngf') {
                        data[key].helm = vTag;
                    }
                })
                .catch(function() { applyFallback(key); });
        }

        Promise.all(Object.keys(VERSION_CONFIG).map(loadProduct)).then(function() {
            writeVersionCache(data);
            applyVersions(data);
        });
    }

    /* ── Code-block copy buttons ── */
    function copyCodeBlock(btn) {
        var block = btn.closest('.code-block');
        if (!block) return;
        var code = block.querySelector('code');
        if (!code) return;
        copyToClipboard(code.textContent, btn);
    }

    document.addEventListener('DOMContentLoaded', function() {
        // YouTube poster click-to-play — swaps the poster for the real iframe on first activation.
        document.querySelectorAll('.feature-card[data-yt-id]').forEach(function(card) {
            var poster = card.querySelector('.video-poster');
            if (!poster) return;
            function activate() {
                var id = card.getAttribute('data-yt-id');
                var title = card.getAttribute('data-yt-title') || 'YouTube video';
                var iframe = document.createElement('iframe');
                iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1';
                iframe.title = title;
                iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
                iframe.allowFullscreen = true;
                poster.replaceWith(iframe);
            }
            poster.addEventListener('click', activate);
            poster.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
            });
        });

        // Copy buttons on code blocks.
        document.querySelectorAll('.copy-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { copyCodeBlock(this); });
        });

        // Fetch latest versions from GitHub (falls back to build-time values).
        fetchVersions();
    });
})();
