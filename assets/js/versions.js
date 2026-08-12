/* versions.js — keep published version numbers current without a build step.
   =========================================================================
   Every `[data-version="<product>.<field>"]` element is filled from the
   GitHub releases API, falling back to the value already in the markup. The
   markup value is therefore the source of truth for anyone without
   JavaScript, and must be kept accurate by hand — it is what search engines
   and no-JS visitors see.

   Two products are deliberately absent from CONFIG:

     BIG-IP Next for Kubernetes  has no public GitHub repository at all. It
       ships as OCI Helm charts from F5's private artifact registry, so its
       version (2.3.2) is hand-maintained in the markup.
     F5 WAF for NGINX            likewise has no public repo, and carries
       three distinct version numbers that must not be conflated: its own
       standalone release, and the different versions pinned into NGINX
       Ingress Controller and NGINX Gateway Fabric.

   Bump CACHE_KEY whenever CONFIG's shape or applyVersions() changes, or
   returning visitors will read a stale cache written by the old code.
   ========================================================================= */
'use strict';

(function () {
    var CACHE_KEY = 'f5k8s_versions_v1';
    var CACHE_TTL = 3600000;   /* one hour */

    var CONFIG = {
        nic: {
            repo: 'nginx/kubernetes-ingress',
            chartPath: 'charts/nginx-ingress',
            fallback: { release: 'v5.5.4', helm: 'v2.6.4' }
        },
        ngf: {
            repo: 'nginx/nginx-gateway-fabric',
            chartPath: 'charts/nginx-gateway-fabric',
            fallback: { release: 'v2.6.7', helm: 'v2.6.7' }
        },
        i2g: {
            repo: 'kubernetes-sigs/ingress2gateway',
            fallback: { release: 'v1.2.0' }
        },
        /* Container Ingress Services. Its Helm charts live in a separate
           gh-pages repository rather than a path inside this one, so there is
           no chartPath and only the release tag is fetched. */
        cis: {
            repo: 'F5Networks/k8s-bigip-ctlr',
            fallback: { release: 'v2.20.4' }
        }
    };

    /* Rejects prefixed tags such as `controller-v1.15.1`. A repository that
       tags that way needs its own parser rather than a looser pattern here —
       a loose pattern would silently publish a wrong number. */
    var TAG = /^v?\d+\.\d+\.\d+$/;

    function readCache() {
        try {
            var raw = localStorage.getItem(CACHE_KEY);
            if (!raw) { return null; }
            var parsed = JSON.parse(raw);
            if (!parsed || Date.now() - parsed.ts > CACHE_TTL) { return null; }
            return parsed.data;
        } catch (e) { return null; }
    }

    function writeCache(data) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
        } catch (e) { /* quota or private browsing — the fetch still worked */ }
    }

    function applyVersions(data) {
        var nodes = document.querySelectorAll('[data-version]');
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var parts = node.getAttribute('data-version').split('.');
            var product = data[parts[0]];
            if (!product) { continue; }
            var value = product[parts[1]];
            if (!value) { continue; }

            var bare = value.replace(/^v/, '');
            node.textContent = node.getAttribute('data-version-format') === 'bare'
                ? bare : 'v' + bare;

            if (node.tagName === 'A') {
                var cfg = CONFIG[parts[0]];
                if (parts[1] === 'release') {
                    node.href = 'https://github.com/' + cfg.repo + '/releases/tag/v' + bare;
                } else if (parts[1] === 'helm' && cfg.chartPath) {
                    node.href = 'https://github.com/' + cfg.repo + '/tree/'
                              + product.release + '/' + cfg.chartPath;
                }
            }
        }
    }

    function fallbacks() {
        var out = {};
        for (var key in CONFIG) {
            if (Object.prototype.hasOwnProperty.call(CONFIG, key)) {
                out[key] = CONFIG[key].fallback;
            }
        }
        return out;
    }

    function fetchChartVersion(cfg, tag) {
        return fetch('https://raw.githubusercontent.com/' + cfg.repo + '/'
                     + tag + '/' + cfg.chartPath + '/Chart.yaml')
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (text) {
                if (!text) { return null; }
                var m = text.match(/^version:\s*["']?(\d+\.\d+\.\d+[^\s"']*)/m);
                return m ? 'v' + m[1] : null;
            })
            .catch(function () { return null; });
    }

    function loadProduct(key) {
        var cfg = CONFIG[key];
        return fetch('https://api.github.com/repos/' + cfg.repo + '/releases/latest')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (json) {
                if (!json || !json.tag_name || !TAG.test(json.tag_name)) {
                    return [key, cfg.fallback];
                }
                var release = 'v' + json.tag_name.replace(/^v/, '');
                if (!cfg.chartPath) { return [key, { release: release }]; }
                return fetchChartVersion(cfg, release).then(function (helm) {
                    return [key, { release: release, helm: helm || cfg.fallback.helm }];
                });
            })
            .catch(function () { return [key, cfg.fallback]; });
    }

    function run() {
        var cached = readCache();
        if (cached) { applyVersions(cached); return; }

        var keys = Object.keys(CONFIG);
        Promise.all(keys.map(loadProduct)).then(function (pairs) {
            var data = {};
            for (var i = 0; i < pairs.length; i++) { data[pairs[i][0]] = pairs[i][1]; }
            writeCache(data);
            applyVersions(data);
        }).catch(function () {
            applyVersions(fallbacks());
        });
    }

    if (!window.fetch || !window.Promise) { return; }   /* markup already correct */
    document.addEventListener('DOMContentLoaded', run);
}());
