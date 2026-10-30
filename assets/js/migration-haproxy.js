    /* migration-haproxy.js — the HAProxy SOURCE module for the migration tool.
       Defines window.MIGRATION_SOURCE: the HAProxy Kubernetes Ingress Controller
       version, the mapping registry, the analyzer's parseInput/buildPlan hooks,
       and the page strings/config the shared engine (migration-core.js) reads.
       Load order matters: shared.js → this file → migration-core.js.
       This file must not touch the DOM — the core owns all rendering — and its
       functions may dereference MigrationTool.* at call time only (the core
       defines it after this file has run).
       HAPROXY_VERSION below is the single source of truth for the source-
       controller side of the Version Reference banners (the NIC side lives in
       MigrationTool.NIC at the top of migration-core.js). */
    (function() {
        'use strict';
        // Bump when updating the Version Reference (see the release checklist in CLAUDE.md).
        const HAPROXY_VERSION = 'v3.2.12';
        const HAPROXY_RELEASE_URL = 'https://github.com/haproxytech/kubernetes-ingress/releases/tag/' + HAPROXY_VERSION;


        // A mapping's `section` names which reference table holds its row, and the
        // "See Reference Guide" link has to open that section in the sidebar. The
        // five ids below are the reference sections declared in SOURCE.reference;
        // anything unrecognised falls back to the OSS table rather than silently
        // producing a dead data-section selector.
        const SECTION_IDS = { oss: 'mappings', plus: 'plus-mappings', configmap: 'configmap-mappings', crd: 'crd-mappings', flags: 'flag-mappings' };
        function sectionIdFor(mapping) {
            return SECTION_IDS[mapping && mapping.section] || 'mappings';
        }

        // --- Value conversion helpers ------------------------------------------

        // An HAProxy time as an NGINX time, or null where HAProxy's ParseTime
        // fails (haproxyTimeMs). A bare integer is milliseconds to HAProxy and
        // seconds to NGINX, so it is converted, and the note says so.
        function haproxyTimeToNginx(v) {
            let s = String(v == null ? '' : v);
            let ms = haproxyTimeMs(s);
            if (ms === null || ms < 0) return null;
            let m = s.match(/^[-+]?\d+(ms|s|m|h|d)?$/);
            if (m[1]) return { value: ms === 0 ? '0s' : msToTime(ms), note: null };
            return { value: msToTime(ms), note: ms % 1000 ? 'HAProxy bare times are milliseconds' : 'converted from ' + ms + 'ms' };
        }

        // int64 milliseconds (CRD timeout fields, which the schema types) → nginx time.
        function msToNginxTime(ms) {
            let n = haproxyInt(ms);
            if (n === null || n < 0) return null;
            return { value: msToTime(n), note: 'converted from ' + n + 'ms' };
        }

        function yamlQuote(v) {
            let s = String(v == null ? '' : v);
            if (s === '' || /[:{}\[\],&*#?|<>=!%@`'"\\\s]/.test(s) || /^(true|false|null|~|-?\d)/i.test(s)) {
                return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
            }
            return s;
        }

        // Short inline-comment sanitizer: keep generated "# from: value" comments
        // single-line so pasted values cannot break out of the comment.
        function cmt(v) {
            return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
        }

        function sanitizeName(s) {
            let n = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
            return n || 'app';
        }

        function splitCommaList(v) {
            return String(v == null ? '' : v).split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s !== ''; });
        }

        // --- route-acl parser ----------------------------------------------------
        // `route-acl` carries one raw HAProxy ACL expression (use_backend condition).
        // Translate the small set of portable primitives; everything else is
        // reported untranslatable. Handled shapes:
        //   rand(100) lt 25                     → percentage split
        //   cookie(NAME) -m str V / req.cook(..) → cookie condition
        //   cookie(NAME) -m found                → cookie present (value "!")
        //   hdr(NAME) -m str V / req.hdr(..)    → header condition
        //   urlp(NAME) -m str V / url_param(..) → query-argument condition
        //   method GET / method(GET)            → $request_method condition
        //   src 10.0.0.0/8 192.168.0.0/16       → reported: a match cannot test
        //                                         the client address
        function parseRouteACL(value) {
            let s = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
            let m;
            if ((m = s.match(/^rand\((\d+)\)\s+(lt|le|gt|ge)\s+(\d+)$/i))) {
                let base = parseInt(m[1], 10) || 100;
                let n = parseInt(m[3], 10);
                // rand(<range>) yields integers 0..range-1 (HAProxy 3.2
                // configuration.txt, fetch methods), so the exact matched counts
                // are: lt N → N; le N → N+1; ge N → range−N; gt N → range−N−1.
                let op = m[2].toLowerCase();
                let matched = op === 'lt' ? n : op === 'le' ? n + 1 : op === 'ge' ? base - n : base - n - 1;
                let pct = Math.min(100, Math.max(0, Math.round((matched / base) * 100)));
                return { kind: 'rand', pct: pct, raw: s };
            }
            // "-m found" tests presence (configuration.txt 7.1); a VirtualServer
            // condition value "!" matches any non-empty value, which is the
            // nearest test. A fetch with no pattern at all is left untranslated.
            let FETCHES = [
                { re: /^(?:req\.cook|cookie)\(([^)]+)\)/i, kind: 'cookie' },
                { re: /^(?:req\.hdr|hdr)\(([^)]+)\)/i, kind: 'header' },
                { re: /^(?:urlp|url_param)\(([^)]+)\)/i, kind: 'arg' }
            ];
            for (let i = 0; i < FETCHES.length; i++) {
                let fm = s.match(FETCHES[i].re);
                if (!fm) continue;
                let rest = s.slice(fm[0].length).trim();
                if (/^-m\s+found$/i.test(rest)) return { kind: FETCHES[i].kind, name: fm[1].trim(), value: null, raw: s };
                let pm = rest.match(/^-m\s+(str|beg|reg|sub|end|dir|dom)\s+(.+)$/i);
                if (pm && pm[1].toLowerCase() === 'str') return { kind: FETCHES[i].kind, name: fm[1].trim(), value: pm[2].trim(), raw: s };
                return { kind: 'untranslatable', raw: s, why: pm ? '-m ' + pm[1] + ' matching' : null };
            }
            if ((m = s.match(/^method(?:\(([A-Za-z]+)\)|\s+([A-Za-z]+))$/i))) {
                return { kind: 'method', value: (m[1] || m[2]).toUpperCase(), raw: s };
            }
            if ((m = s.match(/^src\s+(.+)$/i))) {
                let cidrs = m[1].split(/[\s,]+/).filter(function(c) { return c !== ''; });
                // Every operand must look like an IPv4/IPv6 address or CIDR —
                // otherwise this is a compound ACL ("src A or src B", negation,
                // extra matchers) that must not leak keywords into a Policy list.
                let looksLikeCidr = function(c) { return /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(c) || /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(c) && c.indexOf(':') !== -1; };
                let bad = cidrs.find(function(c) { return !looksLikeCidr(c); });
                if (bad) return { kind: 'untranslatable', raw: s, why: 'unrecognized src operand "' + bad + '" (compound ACLs do not convert)' };
                return { kind: 'src', cidrs: cidrs, raw: s };
            }
            return { kind: 'untranslatable', raw: s, why: null };
        }

        // --- Input parsing (multi-document, dispatched on kind) ----------------
        // HAProxy config annotations are accepted under three interchangeable
        // prefixes and at three scopes (ConfigMap data keys carry the bare name).
        // Precedence on the HAProxy side is default < ConfigMap < Ingress < Service.

        const HAPROXY_PREFIXES = ['haproxy.org/', 'haproxy.com/', 'ingress.kubernetes.io/'];

        // Constructs whose canonical finding key is configmap:<name> (global-only
        // options per the mapping sheet); everything else canonicalizes to
        // annotation:<name> regardless of the scope it was found at.
        const CONFIGMAP_CANONICAL = {};
        ['proxy-protocol', 'client-ca', 'client-crt-optional', 'syslog-server', 'log-format', 'log-format-tcp',
         'dontlognull', 'logasap', 'timeout-client', 'timeout-connect', 'timeout-http-keep-alive',
         'timeout-http-request', 'timeout-queue', 'timeout-tunnel', 'timeout-client-fin', 'timeout-server-fin',
         'http-connection-mode', 'http-keep-alive', 'http-server-close', 'maxconn', 'nbthread', 'hard-stop-after',
         'global-config-snippet', 'frontend-config-snippet', 'stats-config-snippet',
         'client-strict-sni', 'ssl-certificate', 'tls-alpn', 'generate-certificates-signer',
         'quic-alt-svc-max-age', 'clean-certs'
        ].forEach(function(n) { CONFIGMAP_CANONICAL[n] = true; });

        function canonicalKey(name) {
            return (CONFIGMAP_CANONICAL[name] ? 'configmap:' : 'annotation:') + name;
        }

        // Strip a recognized HAProxy prefix; returns null for foreign annotations.
        function haproxySuffix(key) {
            for (let i = 0; i < HAPROXY_PREFIXES.length; i++) {
                if (key.indexOf(HAPROXY_PREFIXES[i]) === 0) return key.substring(HAPROXY_PREFIXES[i].length);
            }
            return null;
        }

        const HAPROXY_CRD_API = /^ingress\.(v1|v3)\.haproxy\.org\//;
        const HAPROXY_CRD_KINDS = { Global: true, Defaults: true, Backend: true, Frontend: true, TCP: true, ValidationRules: true };

        // A tcp-services ConfigMap entry: "<ns>/<svc>:<port>[:ssl]" keyed by listen port.
        function parseTcpServiceEntry(key, value) {
            if (!/^\d+$/.test(String(key))) return null;
            let m = String(value).trim().match(/^(\S+)\/(\S+):(\d+)(:ssl)?$/);
            if (!m) return null;
            return { listenPort: parseInt(key, 10), namespace: m[1], service: m[2], servicePort: parseInt(m[3], 10), ssl: !!m[4] };
        }

        function isPatternFileRef(v) { return /^patterns\//.test(String(v == null ? '' : v).trim()); }
        // Whether IPv4 address or CIDR `inner` lies inside `outer`. Anything it
        // cannot parse (IPv6) counts as inside, so the deny is kept, not lost.
        // The same function as migration-ingress-nginx.js.
        function cidrContains(outer, inner) {
            function parse(c) {
                let m = String(c).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
                if (!m) return null;
                let ip = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4]);
                let bits = m[5] === undefined ? 32 : +m[5];
                return { ip: ip >>> 0, bits: bits };
            }
            let o = parse(outer), i = parse(inner);
            if (!o || !i) return true;
            if (i.bits < o.bits) return false;
            let mask = o.bits === 0 ? 0 : (0xFFFFFFFF << (32 - o.bits)) >>> 0;
            return ((o.ip & mask) >>> 0) === ((i.ip & mask) >>> 0);
        }

        // --- Mapping registry ----------------------------------------------------
        // keys: parseInput finding keys (already canonicalized — one key per
        // construct regardless of the scope it was found at). grouped: true = one
        // generator call with all findings of the entry; false = one call per
        // finding (each CRD instance converts independently).

        const HAPROXY_MAPPINGS = [
            // Access control & real IP
            { keys: ['annotation:allow-list', 'annotation:deny-list', 'annotation:blacklist', 'annotation:whitelist'], source: 'allow-list / deny-list (+ deprecated blacklist/whitelist)', nic: 'Policy CRD accessControl allow[]/deny[] (+ nginx.org/policies on Ingress)', type: 'policy', category: 'Access control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'accessControl' },
            { keys: ['annotation:src-ip-header'], source: 'src-ip-header', nic: 'ConfigMap real-ip-header + set-real-ip-from + real-ip-recursive (global)', type: 'configmap', category: 'Access control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'srcIpHeader' },
            { keys: ['configmap:proxy-protocol'], source: 'proxy-protocol (inbound)', nic: 'ConfigMap proxy-protocol + set-real-ip-from + real-ip-header: proxy_protocol', type: 'configmap', category: 'Client mTLS & PROXY protocol', anchor: 'client-mtls-proxy', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['annotation:send-proxy-protocol'], source: 'send-proxy-protocol', nic: 'No direct equivalent — PROXY-to-backend does not exist for HTTP upstreams; TCP/UDP only via TransportServer streamSnippets (proxy_protocol on; sends PROXY v1 only, requires -enable-snippets)', type: 'unsupported', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true },
            { keys: ['annotation:forwarded-for'], source: 'forwarded-for', nic: 'Automatic — NGINX Ingress Controller sends X-Forwarded-For by default; "false": ConfigMap disable-forwarded-headers (global)', type: 'annotation', category: 'Access control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'forwardedFor' },

            // Authentication
            { keys: ['annotation:auth-type', 'annotation:auth-secret', 'annotation:auth-realm'], source: 'auth-type / auth-secret / auth-realm', nic: 'Policy CRD basicAuth — or — nginx.org/basic-auth-secret + nginx.org/basic-auth-realm (Ingress)', type: 'policy', category: 'Authentication', anchor: 'authentication', section: 'oss', grouped: true, dualApproach: true, generator: 'basicAuth' },

            // Client mTLS
            { keys: ['configmap:client-ca', 'configmap:client-crt-optional'], source: 'client-ca / client-crt-optional', nic: 'Policy CRD ingressMTLS (clientCertSecret + verifyClient)', type: 'policy', category: 'Client mTLS & PROXY protocol', anchor: 'client-mtls-proxy', section: 'configmap', grouped: true, generator: 'clientMTLS' },
            { keys: ['configmap:client-strict-sni'], source: 'client-strict-sni', nic: 'Side effect of the -default-server-tls-secret flag (unset = reject unknown SNI)', type: 'annotation', category: 'Client mTLS & PROXY protocol', anchor: 'client-mtls-proxy', section: 'configmap', grouped: true, generator: 'controller' },

            // Backend TLS
            { keys: ['annotation:server-ca', 'annotation:server-crt'], source: 'server-ca / server-crt', nic: 'Policy CRD egressMTLS (trustedCertSecret + verifyServer / tlsSecret) + nginx.org/ssl-services', type: 'policy', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true, generator: 'backendMTLS' },
            { keys: ['annotation:server-ssl'], source: 'server-ssl', nic: 'VirtualServer upstreams[].tls.enable — or — nginx.org/ssl-services', type: 'annotation', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true, generator: 'serverSSL' },
            { keys: ['annotation:server-proto'], source: 'server-proto', nic: 'VirtualServer upstreams[].proxy-http-version "2" — or — nginx.org/proxy-http-version "2" (gRPC backends: nginx.org/grpc-services)', type: 'annotation', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true, generator: 'serverProto' },

            // Session persistence
            { keys: ['annotation:cookie-persistence', 'annotation:cookie-persistence-no-dynamic'], source: 'cookie-persistence / cookie-persistence-no-dynamic', nic: 'VirtualServer upstreams[].sessionCookie', type: 'virtualserver', category: 'Session persistence', anchor: 'session-persistence', section: 'oss', grouped: true, generator: 'cookiePersistence' },

            // Rate limiting
            { keys: ['annotation:rate-limit-requests', 'annotation:rate-limit-period', 'annotation:rate-limit-size', 'annotation:rate-limit-status-code'], source: 'rate-limit-*', nic: 'Policy CRD rateLimit — or — nginx.org/limit-req-* annotations (Ingress)', type: 'policy', category: 'Rate limiting', anchor: 'rate-limiting', section: 'oss', grouped: true, dualApproach: true, generator: 'rateLimit' },
            { keys: ['annotation:rate-limit-whitelist'], source: 'rate-limit-whitelist', nic: 'No direct equivalent — rateLimit Policy and nginx.org/limit-req-* have no exclusion field; last-resort geo/map snippet blanking the limit key', type: 'unsupported', category: 'Rate limiting', anchor: 'rate-limiting', section: 'oss', grouped: true },

            // CORS
            { keys: ['annotation:cors-enable', 'annotation:cors-allow-origin', 'annotation:cors-allow-methods', 'annotation:cors-allow-headers', 'annotation:cors-allow-credentials', 'annotation:cors-max-age', 'annotation:cors-respond-to-options'], source: 'cors-*', nic: 'Policy CRD cors (+ nginx.org/policies on Ingress)', type: 'policy', category: 'CORS', anchor: 'cors', section: 'oss', grouped: true, generator: 'cors' },

            // Headers
            { keys: ['annotation:request-set-header', 'annotation:response-set-header', 'annotation:set-host'], source: 'request-set-header / response-set-header / set-host', nic: 'VirtualServer requestHeaders.set / responseHeaders.add — or — nginx.org/proxy-set-headers + nginx.org/add-header + nginx.org/upstream-vhost (literal values only)', type: 'virtualserver', category: 'Headers', anchor: 'headers', section: 'oss', grouped: true, dualApproach: true, generator: 'headers' },

            // Observability
            { keys: ['annotation:request-capture', 'annotation:request-capture-len'], source: 'request-capture / request-capture-len', nic: 'ConfigMap log-format with $http_* / $cookie_* variables (global)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'requestCapture' },
            { keys: ['configmap:syslog-server'], source: 'syslog-server', nic: 'ConfigMap access-log (syslog: destination)', type: 'configmap', category: 'Logging', anchor: 'logging', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:log-format'], source: 'log-format', nic: 'ConfigMap log-format (hand-translated)', type: 'configmap', category: 'Logging', anchor: 'logging', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:log-format-tcp'], source: 'log-format-tcp', nic: 'ConfigMap stream-log-format (hand-translated)', type: 'configmap', category: 'Logging', anchor: 'logging', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:dontlognull', 'configmap:logasap'], source: 'dontlognull / logasap', nic: 'No direct equivalent (generally moot — see notes)', type: 'configmap', category: 'Logging', anchor: 'logging', section: 'configmap', grouped: true, generator: 'controller' },

            // Health checks
            { keys: ['annotation:check'], source: 'check', nic: 'nginx.org/max-fails + nginx.org/fail-timeout (OSS passive) — active probes are NGINX Plus', type: 'annotation', category: 'Health checks', anchor: 'health-checks', section: 'oss', grouped: true, generator: 'check' },
            { keys: ['annotation:check-http', 'annotation:check-interval', 'annotation:timeout-check'], source: 'check-http / check-interval / timeout-check', nic: 'VirtualServer upstreams[].healthCheck (NGINX Plus)', type: 'virtualserver', category: 'Active health checks', anchor: 'active-health-checks', section: 'plus', grouped: true, plusRequired: true, generator: 'activeHealthCheck' },

            // Load balancing
            { keys: ['annotation:load-balance'], source: 'load-balance', nic: 'nginx.org/lb-method / ConfigMap lb-method / VirtualServer upstreams[].lb-method', type: 'annotation', category: 'Load balancing', anchor: 'load-balancing', section: 'oss', grouped: true, generator: 'loadBalance' },
            { keys: ['annotation:scale-server-slots'], source: 'scale-server-slots', nic: 'Not applicable — no pre-allocated server slots; NGINX Ingress Controller re-resolves endpoints on change', type: 'annotation', category: 'Load balancing', anchor: 'load-balancing', section: 'oss', grouped: true, generator: 'notApplicable' },
            { keys: ['annotation:standalone-backend'], source: 'standalone-backend', nic: 'Not applicable — NGINX Ingress Controller already generates one upstream per Ingress/VirtualServer', type: 'annotation', category: 'Load balancing', anchor: 'load-balancing', section: 'oss', grouped: true, generator: 'notApplicable' },

            // Miscellaneous (not applicable on NIC)
            { keys: ['annotation:abortonclose', 'configmap:clean-certs'], source: 'abortonclose / clean-certs', nic: 'Not applicable — NGINX Ingress Controller architecture makes these unnecessary (see notes)', type: 'annotation', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss', grouped: true, generator: 'notApplicable' },

            // Rewrites & redirects
            { keys: ['annotation:path-rewrite'], source: 'path-rewrite', nic: 'VirtualServer regex path + rewritePath — or — nginx.org/rewrite-target (+ nginx.org/path-regex)', type: 'annotation', category: 'Rewrites', anchor: 'rewrites', section: 'oss', grouped: true, generator: 'pathRewrite' },
            { keys: ['annotation:request-redirect', 'annotation:request-redirect-code'], source: 'request-redirect (+ -code)', nic: 'VirtualServer action.redirect {url, code} (HAProxy default 302)', type: 'virtualserver', category: 'Redirects', anchor: 'redirects', section: 'oss', grouped: true, generator: 'requestRedirect' },
            { keys: ['annotation:ssl-redirect', 'annotation:ssl-redirect-code'], source: 'ssl-redirect (+ -code)', nic: 'VirtualServer spec.tls.redirect — or — nginx.org/ssl-redirect + nginx.org/http-redirect-code (emit 302 explicitly — NGINX Ingress Controller defaults to 301)', type: 'annotation', category: 'Redirects', anchor: 'redirects', section: 'oss', grouped: true, generator: 'sslRedirect' },
            { keys: ['annotation:ssl-redirect-port'], source: 'ssl-redirect-port', nic: 'No direct equivalent — NGINX Ingress Controller redirects to its own HTTPS listener port; bake a custom port into a VirtualServer redirect URL', type: 'annotation', category: 'Redirects', anchor: 'redirects', section: 'oss', grouped: true, generator: 'sslRedirectPort' },

            // Timeouts & connection handling
            { keys: ['configmap:timeout-connect', 'configmap:timeout-http-keep-alive', 'annotation:timeout-server', 'configmap:timeout-tunnel', 'configmap:timeout-client', 'configmap:timeout-http-request', 'configmap:timeout-queue'], source: 'timeout-*', nic: 'proxy-connect/read/send-timeout + keepalive-timeout keys/annotations (client-side timeouts: http-snippets; queue: NGINX Plus)', type: 'annotation', category: 'Timeouts', anchor: 'static-timeouts', section: 'configmap', grouped: true, generator: 'timeoutServer' },
            { keys: ['configmap:timeout-client-fin', 'configmap:timeout-server-fin'], source: 'timeout-client-fin / timeout-server-fin', nic: 'No direct equivalent — NGINX has no half-closed (FIN_WAIT) timeout knobs', type: 'unsupported', category: 'Timeouts', anchor: 'static-timeouts', section: 'configmap', grouped: true },
            { keys: ['configmap:http-connection-mode', 'configmap:http-keep-alive', 'configmap:http-server-close'], source: 'http-connection-mode (+ deprecated aliases)', nic: 'Split: ConfigMap keepalive (upstream count) + keepalive-timeout (client)', type: 'configmap', category: 'Connection handling', anchor: 'static-connection-handling', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:maxconn', 'configmap:nbthread'], source: 'maxconn / nbthread', nic: 'ConfigMap worker-connections / worker-processes (approximate — model differs)', type: 'configmap', category: 'Connection handling', anchor: 'static-connection-handling', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['annotation:pod-maxconn'], source: 'pod-maxconn', nic: 'nginx.org/max-conns (VirtualServer upstreams[].max-conns)', type: 'annotation', category: 'Connection handling', anchor: 'connection-handling', section: 'oss', grouped: true, generator: 'podMaxconn' },

            // TLS & certificates
            { keys: ['configmap:ssl-certificate'], source: 'ssl-certificate', nic: '-default-server-tls-secret deployment flag (+ per-app spec.tls)', type: 'annotation', category: 'TLS & certificates', anchor: 'static-tls-certificates', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['annotation:ssl-passthrough'], source: 'ssl-passthrough', nic: 'TransportServer TLS_PASSTHROUGH (+ -enable-tls-passthrough flag)', type: 'transportserver', category: 'TLS & certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'sslPassthrough' },
            { keys: ['configmap:tls-alpn'], source: 'tls-alpn', nic: 'ConfigMap http2 (HTTP/2 on/off only — no general ALPN control)', type: 'configmap', category: 'TLS & certificates', anchor: 'static-tls-certificates', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:generate-certificates-signer'], source: 'generate-certificates-signer', nic: 'No direct equivalent — NGINX Ingress Controller has no on-the-fly certificate signing; pre-issue certificates via cert-manager', type: 'unsupported', category: 'TLS & certificates', anchor: 'static-tls-certificates', section: 'configmap', grouped: true },
            { keys: ['configmap:quic-alt-svc-max-age'], source: 'quic-alt-svc-max-age', nic: 'No direct equivalent — NGINX Ingress Controller has no QUIC or HTTP/3 support', type: 'unsupported', category: 'TLS & certificates', anchor: 'static-tls-certificates', section: 'configmap', grouped: true },

            // Routing
            { keys: ['annotation:ingress.class'], source: 'ingress.class (deprecated annotation)', nic: 'Ingress spec.ingressClassName (exact match to -ingress-class; the IngressClass must exist)', type: 'annotation', category: 'Routing', anchor: 'routing', section: 'oss', grouped: true, generator: 'ingressClass' },
            { keys: ['kind:Ingress'], source: 'Ingress spec (pathType / wildcard hosts / defaultBackend)', nic: 'Ingress ports as-is — pathType Prefix boundary and class matching need review (see notes)', type: 'annotation', category: 'Routing', anchor: 'routing', section: 'oss', grouped: true, generator: 'ingressSpec' },

            // Traffic splitting / canary
            { keys: ['annotation:route-acl'], source: 'route-acl (canary / ACL routing)', nic: 'VirtualServer routes[].splits (rand percentages) / matches[].conditions (cookie, header, argument, method)', type: 'virtualserver', category: 'Traffic splitting', anchor: 'traffic-splitting', section: 'oss', grouped: true, generator: 'routeAcl' },

            // Configuration snippets
            { keys: ['annotation:backend-config-snippet'], source: 'backend-config-snippet', nic: 'nginx.org/location-snippets (content must be rewritten as NGINX directives; -enable-snippets)', type: 'annotation', category: 'Configuration snippets', anchor: 'configuration-snippets', section: 'oss', grouped: true, generator: 'backendSnippet' },
            { keys: ['configmap:frontend-config-snippet'], source: 'frontend-config-snippet', nic: 'ConfigMap server-snippets (rewritten as NGINX directives)', type: 'configmap', category: 'Configuration snippets', anchor: 'static-configuration-snippets', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:global-config-snippet'], source: 'global-config-snippet', nic: 'ConfigMap main-snippets / http-snippets (native ssl-* keys preferred where they exist)', type: 'configmap', category: 'Configuration snippets', anchor: 'static-configuration-snippets', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['configmap:stats-config-snippet'], source: 'stats-config-snippet', nic: 'No stats frontend on NGINX Ingress Controller — Prometheus /metrics + Grafana instead', type: 'configmap', category: 'Configuration snippets', anchor: 'static-configuration-snippets', section: 'configmap', grouped: true, generator: 'controller' },
            { keys: ['kind:ValidationRules'], source: 'ValidationRules CRD (custom annotations)', nic: 'No direct equivalent — NGINX Ingress Controller has a fixed annotation vocabulary (no CEL/template custom-annotation framework); re-express the intent via native constructs or snippets', type: 'unsupported', category: 'HAProxy ValidationRules CRD', anchor: 'crd-validationrules', section: 'crd' },

            // Global / lifecycle
            { keys: ['configmap:hard-stop-after'], source: 'hard-stop-after', nic: 'ConfigMap worker-shutdown-timeout', type: 'configmap', category: 'Global & lifecycle', anchor: 'global-lifecycle', section: 'configmap', grouped: true, generator: 'controller' },

            // HAProxy CRDs
            { keys: ['annotation:cr-backend'], source: 'cr-backend (CR pointer)', nic: 'Not applicable — NGINX Ingress Controller has no CR indirection; migrate the referenced Backend CR\'s content', type: 'annotation', category: 'CRD overview', anchor: 'crd-overview', section: 'crd', grouped: true, generator: 'crBackendRef' },
            { keys: ['kind:Global'], source: 'Global CRD', nic: 'NGINX Ingress Controller ConfigMap global keys (worker-*, ssl-*)', type: 'configmap', category: 'CRD overview', anchor: 'crd-overview', section: 'crd', generator: 'controller' },
            { keys: ['kind:Defaults'], source: 'Defaults CRD', nic: 'NGINX Ingress Controller ConfigMap proxy/keepalive/log keys', type: 'configmap', category: 'CRD overview', anchor: 'crd-overview', section: 'crd', generator: 'controller' },
            { keys: ['kind:Backend'], source: 'Backend CRD', nic: 'VirtualServer upstreams[] fields / nginx.org/* annotations', type: 'virtualserver', category: 'CRD overview', anchor: 'crd-overview', section: 'crd', generator: 'controller' },
            { keys: ['kind:Frontend'], source: 'Frontend CRD (v3-only)', nic: 'Split: listener flags/GlobalConfiguration + ConfigMap keys + server-snippets', type: 'globalconfiguration', category: 'CRD overview', anchor: 'crd-overview', section: 'crd', generator: 'controller' },
            { keys: ['kind:TCP'], source: 'TCP CRD', nic: 'GlobalConfiguration TCP listener + TransportServer per entry', type: 'transportserver', category: 'HAProxy TCP CRD', anchor: 'crd-tcp', section: 'crd', generator: 'controller' },
            { keys: ['configmap:tcp-services'], source: 'tcp-services ConfigMap', nic: 'GlobalConfiguration TCP listener + TransportServer per entry', type: 'transportserver', category: 'TCP services', anchor: 'tcp-services', section: 'oss', generator: 'controller' },

            // Enterprise → Plus
            { keys: ['annotation:modsecurity'], source: 'modsecurity (Enterprise WAF)', nic: 'Policy CRD waf (NGINX Plus + F5 WAF for NGINX, via nginx.com/policies)', type: 'policy', category: 'WAF', anchor: 'waf', section: 'plus', plusRequired: true, grouped: true, generator: 'modsecurity' }
        ];

        const HAPROXY_LOOKUP = new Map();
        HAPROXY_MAPPINGS.forEach(function(mapping, idx) {
            mapping.keys.forEach(function(key) {
                HAPROXY_LOOKUP.set(key, idx);
            });
        });

        // --- Input: the run as HAProxy reads it --------------------------------
        // HAProxy keeps one application's settings on four kinds of object, and
        // resolves them per backend (pkg/service/service.go, v3.2.12): a Service's
        // own annotations, then the Ingress routing to it, then the controller
        // ConfigMap, then the built-in default. Frontend settings (auth, CORS,
        // rate limits, redirects, rewrites, headers) are the Ingress's, then the
        // ConfigMap's. route-acl is read from the Service only. A cr-backend
        // Backend CR replaces every backend annotation of the Service it is
        // reached from (getBackendModel). So the analyzer reads the whole paste
        // into one run, and resolves each Ingress against it the same way.

        let NIC_API = 'k8s.nginx.org/v1';
        function isMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
        function str(v) { return v === null || v === undefined ? '' : String(v); }

        // --- Values as HAProxy reads them (v3.2.12) ----------------------------
        // HAProxy never rejects an Ingress over a bad value: the processor logs
        // the error and the setting keeps what it had (annotations.go,
        // ingress.handleAnnotations, service.getBackendModel). What that leaves
        // differs per annotation, so each translator says which; the readers
        // below only parse, the way utils.go does, and return null on an error.
        //
        // Booleans come three ways. utils.GetBoolValue: Go's ParseBool, plus
        // on/enabled and off/disabled in any case (not "yes"). annotations.Bool:
        // GetBoolValue to validate, then true only for the exact string "true"
        // (ssl-passthrough, client-crt-optional, client-strict-sni). CORS reads
        // cors-allow-credentials and cors-respond-to-options as input == "true".
        let GO_TRUE = /^(1|t|T|TRUE|true|True)$/, GO_FALSE = /^(0|f|F|FALSE|false|False)$/;
        function haproxyBool(v) {
            let s = str(v);
            if (GO_TRUE.test(s) || /^(enabled|on)$/i.test(s)) return true;
            if (GO_FALSE.test(s) || /^(disabled|off)$/i.test(s)) return false;
            return null;
        }
        // utils.ParseTime: an int64 with one suffix ms, s, m, h or d; none is
        // milliseconds. No microseconds, no spaces, no compound "1m30s".
        function haproxyTimeMs(v) {
            let m = str(v).match(/^([-+]?\d+)(ms|s|m|h|d)?$/);
            if (!m) return null;
            let n = parseInt(m[1], 10);
            return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]] || 1);
        }
        // strconv.Atoi / ParseInt: a sign and digits, nothing else.
        function haproxyInt(v) { let s = str(v); return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : null; }
        // The note for a value HAProxy could not parse; `kept` is what the
        // setting fell back to, in HAProxy's words.
        function invalidNote(ctx, name, value, what, kept) {
            ctx.note(name, name + ' "' + value + '" is not ' + what + ', so HAProxy logged an error and ' + kept + '. Nothing is migrated for it.', 'warning');
        }
        // A milliseconds count as an NGINX time: the largest exact unit.
        function msToTime(ms) {
            if (ms % 3600000 === 0 && ms >= 3600000) return (ms / 3600000) + 'h';
            if (ms % 60000 === 0 && ms >= 60000) return (ms / 60000) + 'm';
            if (ms % 1000 === 0) return (ms / 1000) + 's';
            return ms + 'ms';
        }
        // net.ParseIP or net.ParseCIDR, as the access-control and rate-limit
        // processors check each address.
        function isAddress(s) {
            let m = str(s).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
            if (m) return [m[1], m[2], m[3], m[4]].every(function(o) { return +o <= 255 && (o === '0' || o[0] !== '0'); }) && (m[5] === undefined || +m[5] <= 32);
            let v6 = str(s).match(/^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/);
            return !!v6 && v6[1].indexOf(':') !== -1 && (v6[2] === undefined || +v6[2] <= 128) && (v6[1].match(/::/g) || []).length <= 1;
        }
        function dnsName(s, fallback) {
            let n = str(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
            return n || fallback || 'app';
        }

        // Annotations under any of the three prefixes, by bare name. HAProxy
        // strips the first prefix that matches (store.cleanAnnotation), so two
        // prefixes on one name are one setting; the first listed wins.
        function haproxyAnnotations(md) {
            let out = {};
            let ann = isMap(md && md.annotations) ? md.annotations : {};
            Object.keys(ann).forEach(function(k) {
                let suffix = haproxySuffix(k);
                if (suffix === null) return;
                if (!Object.prototype.hasOwnProperty.call(out, suffix)) out[suffix] = { value: str(ann[k]), key: k };
            });
            return out;
        }

        function backendOf(b) {
            if (!isMap(b)) return null;
            if (isMap(b.service)) {
                let p = isMap(b.service.port) ? b.service.port : {};
                return { service: b.service.name ? str(b.service.name) : null, port: p.number !== undefined ? p.number : (p.name !== undefined ? str(p.name) : null) };
            }
            if (b.serviceName) return { service: str(b.serviceName), port: b.servicePort !== undefined ? b.servicePort : null };
            if (isMap(b.resource)) return { resource: b.resource };
            return null;
        }

        function ingressModel(doc) {
            let md = isMap(doc.metadata) ? doc.metadata : {};
            let spec = isMap(doc.spec) ? doc.spec : {};
            let annotations = isMap(md.annotations) ? md.annotations : {};
            let tlsByHost = {};
            (Array.isArray(spec.tls) ? spec.tls : []).forEach(function(t) {
                if (!isMap(t)) return;
                (Array.isArray(t.hosts) ? t.hosts : []).forEach(function(h) { tlsByHost[str(h)] = t.secretName ? str(t.secretName) : ''; });
            });
            let hosts = [];
            let hostless = [];
            (Array.isArray(spec.rules) ? spec.rules : []).filter(isMap).forEach(function(r) {
                let paths = ((isMap(r.http) && Array.isArray(r.http.paths)) ? r.http.paths : []).filter(isMap).map(function(p) {
                    return { path: p.path ? str(p.path) : '/', pathType: p.pathType ? str(p.pathType) : 'ImplementationSpecific', backend: backendOf(p.backend) };
                });
                if (!r.host) { hostless.push.apply(hostless, paths); return; }
                let host = str(r.host);
                let existing = hosts.find(function(h) { return h.host === host; });
                if (existing) existing.paths = existing.paths.concat(paths);
                else hosts.push({ host: host, paths: paths, tlsSecret: Object.prototype.hasOwnProperty.call(tlsByHost, host) ? tlsByHost[host] : null });
            });
            return {
                name: md.name ? str(md.name) : null,
                namespace: md.namespace ? str(md.namespace) : null,
                apiVersion: str(doc.apiVersion),
                ingressClassName: spec.ingressClassName ? str(spec.ingressClassName) : (annotations['kubernetes.io/ingress.class'] ? str(annotations['kubernetes.io/ingress.class']) : null),
                annotations: annotations,
                haproxy: haproxyAnnotations(md),
                defaultBackend: backendOf(spec.defaultBackend || spec.backend),
                hosts: hosts,
                hostless: hostless,
                tls: (Array.isArray(spec.tls) ? spec.tls : []).filter(isMap),
                doc: doc
            };
        }

        // The controller ConfigMap: named like one, or carrying keys the mapping
        // database knows. A tcp-services map (numeric keys) is its own thing; an
        // application ConfigMap is neither and is skipped.
        function configMapModel(doc) {
            let md = isMap(doc.metadata) ? doc.metadata : {};
            let data = isMap(doc.data) ? doc.data : {};
            let tcp = [];
            let options = {};
            Object.keys(data).forEach(function(k) {
                let entry = parseTcpServiceEntry(k, data[k]);
                if (entry) tcp.push(entry);
                else options[k] = { value: str(data[k]), key: k };
            });
            let recognised = Object.keys(options).some(function(k) { return HAPROXY_LOOKUP.has(canonicalKey(k)) || /^cr-/.test(k); });
            let name = md.name ? str(md.name) : 'configmap';
            if (!/haproxy/i.test(name) && !tcp.length && !recognised) return null;
            return { name: name, namespace: md.namespace ? str(md.namespace) : null, options: tcp.length && !recognised ? {} : options, tcp: tcp, doc: doc };
        }

        function crModel(doc, docIndex) {
            let md = isMap(doc.metadata) ? doc.metadata : {};
            let apiVersion = str(doc.apiVersion);
            let isV1 = apiVersion.indexOf('ingress.v1.') === 0;
            let kind = str(doc.kind);
            let spec = doc.spec;
            // v1 wraps the client-native config under spec.config (Global also
            // spec.log_targets; Backend also spec.acls + spec.http-requests); v3
            // inlines the fields under spec.
            let config = isMap(spec) ? spec : {};
            if (isV1 && kind !== 'TCP' && isMap(spec)) {
                config = isMap(spec.config) ? Object.assign({}, spec.config) : {};
                if (kind === 'Global' && spec.log_targets) config.log_targets = spec.log_targets;
                if (kind === 'Backend') {
                    if (spec.acls) config.acl_list = spec.acls;
                    if (spec['http-requests']) config.http_request_rule_list = spec['http-requests'];
                }
            }
            return { kind: kind, name: md.name ? str(md.name) : kind.toLowerCase() + '-' + (docIndex + 1), namespace: md.namespace ? str(md.namespace) : null, isV1: isV1, spec: spec, config: config, doc: doc };
        }

        // A run from documents already parsed (nic-migrate parses each file
        // once, with this same parser).
        function runOf(docs) {
            let run = { ingresses: [], services: [], configMaps: [], crs: [], skipped: {} };
            docs.forEach(function(doc, i) { addToRun(run, doc, i); });
            return run;
        }
        function addToRun(run, doc, docIndex) {
            if (!isMap(doc) || !doc.kind) return;
            let kind = str(doc.kind);
            if (kind === 'Ingress') { run.ingresses.push(ingressModel(doc)); return; }
            if (kind === 'Service') {
                let md = isMap(doc.metadata) ? doc.metadata : {};
                run.services.push({ name: str(md.name), namespace: md.namespace ? str(md.namespace) : null, haproxy: haproxyAnnotations(md), ports: (isMap(doc.spec) && Array.isArray(doc.spec.ports) ? doc.spec.ports : []).filter(isMap), doc: doc });
                return;
            }
            if (kind === 'ConfigMap') {
                let cm = configMapModel(doc);
                if (cm) run.configMaps.push(cm); else run.skipped.ConfigMap = (run.skipped.ConfigMap || 0) + 1;
                return;
            }
            if (HAPROXY_CRD_API.test(str(doc.apiVersion))) { run.crs.push(crModel(doc, docIndex)); return; }
            run.skipped[kind] = (run.skipped[kind] || 0) + 1;
        }

        function parseInput(yamlText) {
            let run = { ingresses: [], services: [], configMaps: [], crs: [], skipped: {} };
            let warnings = [];
            let errors = [];
            MigrationTool.yaml.parseDocuments(yamlText).forEach(function(d, docIndex) {
                if (d.error) { errors.push(d.error); return; }
                let items = isMap(d.value) && Array.isArray(d.value.items) && /List$/.test(str(d.value.kind)) ? d.value.items : [d.value];
                items.forEach(function(doc) { addToRun(run, doc, docIndex); });
            });
            errors.forEach(function(e) { warnings.push({ title: 'Could not parse part of the input', message: e + '. That document was skipped; fix it and analyze again.' }); });
            if (run.crs.some(function(c) { return c.isV1; })) {
                warnings.push({
                    title: 'ingress.v1.haproxy.org apiVersion detected',
                    message: 'Resources using the legacy `ingress.v1.haproxy.org/v1` group were parsed (fields read from `spec.config`), but this tool documents the current `ingress.v3.haproxy.org/v3` shapes — verify field names against your CRD version before migrating.'
                });
            }

            // Findings: every HAProxy setting the run carries, one per object it
            // sits on, so the summary counts what the reader pasted.
            let findings = [];
            let add = function(key, label, value, where) { findings.push({ key: key, label: label, value: value, where: where }); };
            run.ingresses.forEach(function(m) { Object.keys(m.haproxy).forEach(function(k) { add(canonicalKey(k), m.haproxy[k].key, m.haproxy[k].value, 'Ingress ' + (m.name || '')); }); });
            run.services.forEach(function(s) { Object.keys(s.haproxy).forEach(function(k) { add(canonicalKey(k), s.haproxy[k].key, s.haproxy[k].value, 'Service ' + s.name); }); });
            run.configMaps.forEach(function(c) {
                Object.keys(c.options).forEach(function(k) { add(canonicalKey(k), k, c.options[k].value, 'ConfigMap ' + c.name); });
                if (c.tcp.length) add('configmap:tcp-services', 'ConfigMap ' + c.name + ' (tcp-services)', '', 'ConfigMap ' + c.name);
            });
            run.crs.forEach(function(c) { add('kind:' + c.kind, c.kind + ' ' + c.name, '', c.kind + ' ' + c.name); });
            if (run.services.some(function(s) { return Object.keys(s.haproxy).length; })) {
                warnings.push({
                    title: 'Service-scoped annotations detected',
                    message: 'HAProxy reads backend annotations from Service objects first (Service, then Ingress, then ConfigMap); NGINX Ingress Controller reads none from Services. Each one is applied to the routes that reach that Service in the migrated resources.'
                });
            }

            let empty = null;
            let skippedKinds = Object.keys(run.skipped);
            if (!findings.length && !run.ingresses.length) {
                if (errors.length && !skippedKinds.length) empty = { title: 'The YAML could not be parsed.', message: errors[0] + '.' };
                else if (skippedKinds.length) empty = { title: 'No HAProxy configuration found.', message: 'The input holds ' + skippedKinds.map(function(k) { return run.skipped[k] + ' ' + k; }).join(', ') + '. Paste an Ingress, the Services it routes to, the controller ConfigMap, or ingress.v3.haproxy.org custom resources.' };
            }
            return {
                findings: findings,
                ingresses: run.ingresses,
                run: run,
                context: run.ingresses[0] || null,
                warnings: warnings,
                foundCount: findings.length,
                skipped: run.skipped,
                empty: empty
            };
        }

        // The controller ConfigMap's options, merged in paste order. HAProxy
        // reads one ConfigMap; two in a paste are reported.
        function controllerOptions(run) {
            let out = {};
            run.configMaps.forEach(function(c) { Object.keys(c.options).forEach(function(k) { if (!(k in out)) out[k] = c.options[k]; }); });
            return out;
        }

        // A Service by namespace/name, as HAProxy looks it up for a backend.
        function findService(run, namespace, name) {
            return run.services.find(function(s) { return s.name === name && (s.namespace || null) === (namespace || null); })
                || run.services.find(function(s) { return s.name === name && (!s.namespace || !namespace); }) || null;
        }

        function findCR(run, kind, ref, defaultNs) {
            let parts = str(ref).split('/');
            let ns = parts.length === 2 ? parts[0] : defaultNs;
            let name = parts[parts.length - 1];
            return run.crs.find(function(c) { return c.kind === kind && c.name === name && (!ns || !c.namespace || c.namespace === ns); }) || null;
        }

        // --- Translators --------------------------------------------------------
        // One per mapping. Each reads the settings resolved for one Ingress (`a`
        // maps bare name → { value, from }, where `from` says which object it was
        // read from) and writes FRAGMENTS onto `f`, the shapes the assembler
        // places on the resources it builds from the real Ingress:
        //   f.upstream[field]      VirtualServer upstream field, every upstream
        //   f.svc[service][field]  an upstream field for one Service's upstreams
        //                          (a backend setting read from that Service)
        //   f.proxy[field]         route action.proxy field (requestHeaders, ...)
        //   f.location / f.server  snippet lines
        //   f.policies             [{ name, spec, onIngress, needsTls, comments, sources }]
        //   f.ann[key]             nginx.org/* annotation on the migrated Ingress
        //   f.rewrite              { rules: [{ re, to }], source }
        //   f.redirect             { url, code, source }
        //   f.tlsRedirect          { code, source } or false
        //   f.passthrough          true
        // Global settings (ConfigMap and CRs) go to the controller pass.
        // A translator marks what it read with ctx.use(); anything a matched
        // mapping leaves unread is reported, never dropped.

        function backendAnn(f, service, key, value, comment) {
            // An annotation that names its Services carries the Service list.
            f.annSvc = f.annSvc || {};
            (f.annSvc[key] = f.annSvc[key] || {})[service] = { value: value, comment: comment };
        }
        function upstreamField(f, service, field, value, comment) {
            if (service) {
                f.svc[service] = f.svc[service] || {};
                f.svc[service][field] = { value: value, comment: comment };
            } else {
                f.upstream[field] = value;
                f.upstreamComments[field] = comment;
            }
        }
        // Where a resolved setting came from, for comments: "load-balance (on
        // Service app-svc)" when HAProxy read it from the Service.
        function src(x, name) { return name + (x && x.from && x.from.kind !== 'Ingress' ? ' (' + x.from.kind + (x.from.name ? ' ' + x.from.name : '') + ')' : ''); }

        // load-balance as service.GetParamsFromInput parses it: the first token,
        // its parentheses split off, names the algorithm, which client-native
        // checks against its enum (case-sensitive: "ROUNDROBIN" is invalid);
        // url_param takes the next token. An invalid value leaves Balance unset,
        // so the backend balances roundrobin, as with no value at all.
        function haproxyLbMethod(v) {
            let s = str(v);
            let tokens = s.split(/\s+/).filter(Boolean);
            if (!tokens.length) return { value: 'round_robin', note: 'empty, so HAProxy used its default roundrobin' };
            let algo = tokens[0].replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
            let name = algo[0], arg = algo[1];
            let invalid = { invalid: 'load-balance "' + s + '" is not an algorithm HAProxy Kubernetes Ingress Controller accepts, so HAProxy logged an error and balanced roundrobin; the migration uses round_robin.', value: 'round_robin' };
            switch (name) {
                case 'roundrobin': return { value: 'round_robin' };
                case 'static-rr': return { value: 'round_robin', note: 'static-rr loses its static-assignment guarantee (plain round_robin)' };
                case 'leastconn': return { value: 'least_conn' };
                case 'source': return { value: 'ip_hash' };
                case 'uri': return { value: 'hash $request_uri consistent', note: tokens.length > 1 ? 'the uri options (' + tokens.slice(1).join(' ') + ') are dropped' : null };
                case 'url_param': return tokens[1] ? { value: 'hash $arg_' + tokens[1].replace(/-/g, '_') + ' consistent' } : invalid;
                case 'hdr': return arg ? { value: 'hash $http_' + arg.toLowerCase().replace(/-/g, '_') + ' consistent' } : invalid;
                // random draws twice unless told otherwise (configuration.txt
                // 3.2, "balance"): random two. NGINX picks the less loaded of
                // exactly two.
                case 'random': {
                    let draws = arg === undefined ? 2 : haproxyInt(arg);
                    if (draws === null) return invalid;
                    if (draws <= 1) return { value: 'random' };
                    return { value: 'random two', note: draws > 2 ? 'random(' + draws + ') becomes two draws, the most NGINX takes' : null };
                }
                case 'first': return { none: 'No NGINX Ingress Controller equivalent for balance first (fill servers in order) — choose round_robin or least_conn instead.' };
                case 'rdp-cookie': return { none: 'No NGINX Ingress Controller equivalent for rdp-cookie balancing.' };
                case 'hash': return { none: 'balance hash takes an HAProxy sample expression; rewrite it as an NGINX hash key (lb-method "hash <key> consistent") by hand.' };
            }
            return invalid;
        }

        // A redirect code as HAProxy took it (hostRedirect.go, httpsRedirect.go):
        // ParseInt, then the rule's code, which must be 301, 302, 303, 307 or
        // 308 — any other, 0 from a value ParseInt rejected included, fails
        // HAProxy's configuration check, so HAProxy Kubernetes Ingress
        // Controller kept its previous configuration for the whole sync (null:
        // nothing to migrate). NGINX has no 303 redirect here; it becomes 302.
        function redirectCode(a, name, ctx) {
            if (!a[name]) return { code: 302, source: 'the HAProxy default 302' };
            let v = str(a[name].value);
            let n = haproxyInt(v);
            if ([301, 302, 307, 308].indexOf(n) !== -1) return { code: n, source: name };
            if (n === 303) { ctx.note(name, 'NGINX Ingress Controller redirects with 301, 302, 307 or 308, so ' + name + ' 303 becomes 302.', 'warning'); return { code: 302, source: name + ' (303 → 302)' }; }
            ctx.note(name, name + ' "' + v + '" is not a redirect code HAProxy accepts (301, 302, 303, 307, 308), so its configuration check failed and HAProxy Kubernetes Ingress Controller kept its previous configuration for that whole sync: this redirect never took effect. Nothing is migrated for it.', 'warning');
            return null;
        }

        // A Backend or Defaults CR's balance object as the annotation would
        // write it: the CR keeps hdr_name, url_param and random_draws apart.
        function balanceString(b) {
            if (!isMap(b)) return str(b);
            let a = str(b.algorithm);
            if (a === 'hdr' && b.hdr_name) return 'hdr(' + b.hdr_name + ')';
            if (a === 'url_param' && b.url_param) return 'url_param ' + b.url_param;
            if (a === 'random' && b.random_draws !== undefined && b.random_draws !== null) return 'random(' + b.random_draws + ')';
            return a;
        }

        // NGINX Ingress Controller takes a session cookie name of letters,
        // digits and underscores only (validation isCookieName, v5.7.0).
        let COOKIE_NAME_RULE = 'NGINX Ingress Controller takes a session cookie name of letters, digits and underscores only (no "-" or "."), so the cookie is not migrated; rename it, and expect clients to lose their pinning once.';
        function cookieNameOk(n) { return /^[_A-Za-z0-9]+$/.test(str(n)); }

        // HAProxy header lines: "Name value" per line.
        // reqSetHdr.go splits each non-empty line at its first space; a line
        // without one is an error that stops the loop, so the lines after it
        // were never set. Returns the lines HAProxy set and the one it
        // stopped at.
        function headerLines(v) {
            let out = [], stop = null;
            let lines = str(v).split('\n');
            for (let i = 0; i < lines.length; i++) {
                let l = lines[i];
                if (l === '') continue;
                let sp = l.indexOf(' ');
                if (sp === -1) { stop = l; break; }
                out.push({ name: l.slice(0, sp), value: l.slice(sp + 1).trim() });
            }
            out.stop = stop;
            return out;
        }
        // A HAProxy log-format/sample-fetch value: %[...] is not NGINX syntax.
        // NGINX Ingress Controller's default access-log formats, as the ConfigMap
        // takes them: parseLogFormat splits on newlines and joins with spaces, so
        // a block reads like the default it starts from (nginx.tmpl, v5.7.0).
        let LOG_FORMAT_HTTP = '$remote_addr - $remote_user [$time_local] "$request"\n$status $body_bytes_sent "$http_referer" "$http_user_agent"\n';
        let LOG_FORMAT_TCP = '$remote_addr [$time_local] $protocol $status\n$bytes_sent $bytes_received $session_time\n';
        let SAMPLE_FETCH = /%\[|%\{|%[A-Za-z]{1,3}\b/;

        let TRANSLATORS = {
            // allow-list / deny-list. HAProxy denies a client outside allow-list
            // OR inside deny-list (reqDeny.go). NGINX Ingress Controller applies
            // only the allow list when a resource references allow and deny
            // Policies (policy.go addAccessControlConfig), so both lists become
            // one allow Policy, and each denied address inside an allowed range a
            // location-snippet deny, which renders before the Policy's allow lines.
            accessControl: function(a, f, ctx) {
                ctx.use('allow-list', 'whitelist', 'deny-list', 'blacklist');
                let allowX = a['allow-list'] || a.whitelist;
                let denyX = a['deny-list'] || a.blacklist;
                if (a.whitelist) ctx.note('whitelist', 'whitelist is a deprecated HAProxy alias of allow-list; the Policy covers both.');
                if (a.blacklist) ctx.note('blacklist', 'blacklist is a deprecated HAProxy alias of deny-list; the Policy covers both.');
                let pattern = function(x) { return x && isPatternFileRef(x.value); };
                let allowName = a['allow-list'] ? 'allow-list' : 'whitelist';
                let denyName = a['deny-list'] ? 'deny-list' : 'blacklist';
                // accessControl.go checks every address before it adds the
                // rule: one that is not an IP or CIDR (net.ParseIP/ParseCIDR,
                // as NGINX Ingress Controller checks a Policy) voids that list.
                let voided = function(x, n) {
                    if (!x || pattern(x)) return false;
                    let bad = splitCommaList(x.value).filter(function(s) { return !isAddress(s); });
                    if (!bad.length) return false;
                    ctx.note(n, n + ' holds "' + bad.join('", "') + '", which is not an IP address or CIDR, so HAProxy logged an error and applied no ' + n + '. Nothing is migrated for it.', 'warning');
                    return true;
                };
                if (voided(allowX, allowName)) allowX = null;
                if (voided(denyX, denyName)) denyX = null;
                if (!allowX && !denyX) return;
                if (pattern(allowX) || pattern(denyX)) {
                    ctx.todo('spec.accessControl', 'inline the addresses from the patterns/ file ' + (pattern(allowX) ? allowX.value : denyX.value) + ' — NGINX Ingress Controller has no pattern-file indirection');
                }
                let allow = allowX && !pattern(allowX) ? splitCommaList(allowX.value) : [];
                let deny = denyX && !pattern(denyX) ? splitCommaList(denyX.value) : [];
                let name = ctx.name('access-control');
                if (allowX) {
                    if (!allow.length && !pattern(allowX)) ctx.todo('spec.accessControl.allow', 'the allowed addresses');
                    // A deny that overlaps an allowed range (inside it, or
                    // holding it) must be checked first; one that misses
                    // every allowed range is already refused by deny all.
                    let overlap = deny.filter(function(d) { return allow.some(function(al) { return cidrContains(al, d) || cidrContains(d, al); }); });
                    let policy = { name: name, spec: { accessControl: { allow: allow.length ? allow : ['10.0.0.0/8'] } }, onIngress: true, comments: { 'spec.accessControl.allow': src(allowX, allowName) } };
                    if (overlap.length) {
                        // NGINX takes the first allow or deny that matches, and
                        // a location with rules of its own inherits none from
                        // its server. A Policy in spec.policies or
                        // nginx.org/policies renders at server level, so a deny
                        // in a location snippet beside it lifts the allow list
                        // (verified on nginx 1.31.7: an address outside the
                        // list got 200). A route's own Policy renders in the
                        // location after its snippets: deny, then allow, then
                        // deny all. An Ingress cannot order a Policy after its
                        // snippet, so it carries the whole list as a snippet.
                        policy.perRoute = true;
                        policy.denyFirst = overlap;
                        policy.denySource = denyName;
                    }
                    f.policies.push(policy);
                    if (deny.length) {
                        ctx.note(denyName, 'NGINX Ingress Controller applies only the allow list when a resource references allow and deny Policies, so the deny list is not a Policy here. '
                            + (overlap.length ? 'The denied addresses that overlap the allowed ranges (' + overlap.join(', ') + ') are denied first in each route, ahead of the allow list: CRD-first references the allow Policy from every route (routes[].policies) beside a location-snippets deny; annotation-first writes the whole ordered list as nginx.org/location-snippets, as an Ingress cannot place a Policy after a snippet.' : 'None of the denied ranges overlaps an allowed one, so allow-only already blocks them.'));
                    }
                } else if (denyX) {
                    f.policies.push({ name: name, spec: { accessControl: { deny: deny.length ? deny : ['192.0.2.1'] } }, onIngress: true, comments: { 'spec.accessControl.deny': src(denyX, denyName) } });
                    if (!deny.length && !pattern(denyX)) ctx.todo('spec.accessControl.deny', 'the denied addresses');
                }
                ctx.note(allowX ? allowName : denyName, 'accessControl matches on $remote_addr: behind another proxy, also set the real-ip ConfigMap keys (set-real-ip-from, real-ip-header).');
            },

            // src-ip-header: global real-IP keys in NGINX Ingress Controller.
            srcIpHeader: function(a, f, ctx) {
                ctx.use('src-ip-header');
                let x = a['src-ip-header'];
                ctx.cm('real-ip-header', x.value || 'X-Forwarded-For', src(x, 'src-ip-header'));
                ctx.cm('set-real-ip-from', '10.0.0.0/8', 'TODO: the proxies you trust (src-ip-header)');
                ctx.todo('configmap.set-real-ip-from', 'the CIDRs of the proxies in front of NGINX Ingress Controller (HAProxy trusted the header from any client)');
                ctx.note('src-ip-header', 'Real-IP settings are global in NGINX Ingress Controller (ConfigMap), so the header applies to every application, not only this Ingress.');
            },

            // backendForwardedFor.go: GetBoolValue; an error leaves the
            // backend's forwardfor as it was, which is on (default "true").
            forwardedFor: function(a, f, ctx) {
                ctx.use('forwarded-for');
                let x = a['forwarded-for'];
                let on = haproxyBool(x.value);
                if (on === null) { invalidNote(ctx, 'forwarded-for', x.value, 'a boolean', 'kept sending X-Forwarded-For, as NGINX Ingress Controller does'); return; }
                if (!on) {
                    // v5.6.0's disable-forwarded-headers removes the template's own
                    // X-Forwarded-* lines; proxy-set-headers cannot, as those render after it.
                    ctx.cm('disable-forwarded-headers', 'true', src(x, 'forwarded-for') + ' "false" — global, and drops X-Forwarded-Host, -Port and -Proto too');
                    ctx.note('forwarded-for', 'disable-forwarded-headers is a global ConfigMap key: it stops NGINX Ingress Controller sending X-Forwarded-For, -Host, -Port and -Proto on every Ingress and VirtualServer, not only this one, it needs -enable-snippets, and it cannot be combined with use-forwarded-headers.', 'warning');
                } else {
                    ctx.note('forwarded-for', 'NGINX Ingress Controller sends X-Forwarded-For by default, so nothing is migrated.');
                }
            },

            // basicAuth.go: auth-type creates the rule, and auth-realm and
            // auth-secret only fill it in, so without auth-type: basic-auth
            // there is no authentication. The realm is the value with its
            // spaces turned to dashes ("Protected-Content" unset).
            basicAuth: function(a, f, ctx) {
                ctx.use('auth-type', 'auth-secret', 'auth-realm');
                let others = ['auth-secret', 'auth-realm'].filter(function(k) { return a[k]; });
                if (!a['auth-type'] || str(a['auth-type'].value) !== 'basic-auth') {
                    let why = a['auth-type'] ? 'auth-type "' + a['auth-type'].value + '" is not basic-auth, the only type HAProxy Kubernetes Ingress Controller accepts, so HAProxy logged an error and' : 'auth-type: basic-auth is not set, so HAProxy';
                    let lead = a['auth-type'] ? 'auth-type' : others[0];
                    ctx.note(lead, why + ' applied no authentication' + (others.length ? ' (' + others.join(' and ') + ' only fill in its rule)' : '') + '. Nothing is migrated.', 'warning');
                    others.filter(function(k) { return k !== lead; }).forEach(function(k) { ctx.note(k, k + ' was inactive, as authentication was off: see ' + lead + '.'); });
                    return;
                }
                let raw = a['auth-secret'] ? str(a['auth-secret'].value) : '';
                let secret = raw.replace(/^[^/]+\//, '');
                let realm = a['auth-realm'] ? str(a['auth-realm'].value).replace(/ /g, '-') : 'Protected-Content';
                let realmSrc = a['auth-realm'] ? src(a['auth-realm'], 'auth-realm') + (/ /.test(a['auth-realm'].value) ? ' (HAProxy turns spaces into dashes)' : '') : 'auth-realm (HAProxy default)';
                ctx.note('auth-secret', 'HAProxy reads one user per key of the Secret (the value a crypt(3) hash); NGINX Ingress Controller reads one htpasswd file from the key htpasswd ("user:hash" per line; the Secret can stay Opaque). MD5-crypt ($1$) and apr1 hashes carry over; SHA-crypt ($5$, $6$) works only where the host crypt() supports it.' + (/\//.test(raw) ? ' NGINX Ingress Controller reads the Secret from the resource\'s own namespace, so the namespace prefix was dropped.' : ''), 'warning');
                if (!secret) ctx.todo('basic-auth secret', 'name the htpasswd Secret (HAProxy, without auth-secret, had no users and refused every request)');
                if (ctx.strategy === 'annotation') {
                    // basicAuth is not among the Policies an Ingress accepts
                    // (IsPolicySupportedOnIngress); the annotations are the Ingress form.
                    f.ann['nginx.org/basic-auth-secret'] = secret || 'basic-auth'; ctx.annComment('nginx.org/basic-auth-secret', src(a['auth-secret'], 'auth-secret'));
                    f.ann['nginx.org/basic-auth-realm'] = realm; ctx.annComment('nginx.org/basic-auth-realm', realmSrc);
                    return;
                }
                f.policies.push({ name: ctx.name('basic-auth'), spec: { basicAuth: { secret: secret || 'basic-auth', realm: realm } }, onIngress: false,
                    comments: { 'spec.basicAuth': src(a['auth-type'], 'auth-type'), 'spec.basicAuth.secret': src(a['auth-secret'], 'auth-secret'), 'spec.basicAuth.realm': realmSrc } });
            },

            // Client mTLS: ConfigMap-only in HAProxy (global); a Policy per host here.
            clientMTLS: function(a, f, ctx) {
                ctx.use('client-ca', 'client-crt-optional');
                // https.go handleClientTLSAuth: no client-ca, no client
                // certificates, whatever client-crt-optional says; and that
                // reads annotations.Bool, true only for the string "true".
                if (!a['client-ca']) { ctx.note('client-crt-optional', 'client-crt-optional only relaxes the client certificate check that client-ca turns on, and client-ca is not set, so HAProxy checked no client certificates. Nothing is migrated.', 'warning'); return; }
                let raw = str(a['client-ca'].value);
                let secret = raw.replace(/^[^/]+\//, '');
                let opt = a['client-crt-optional'] ? str(a['client-crt-optional'].value) : null;
                let optional = opt === 'true';
                if (opt !== null && !optional && opt !== 'false') ctx.note('client-crt-optional', 'HAProxy turns client-crt-optional on only for the exact value "true"' + (haproxyBool(opt) === null ? ' and logged an error for "' + opt + '"' : ', not "' + opt + '"') + ', so client certificates stayed required.', 'warning');
                // HAProxy verifies against client-ca even when the certificate is
                // optional, so "optional" (not optional_no_ca) keeps verification.
                f.policies.push({ name: ctx.name('ingress-mtls'), spec: { ingressMTLS: { clientCertSecret: secret || 'ca-secret', verifyClient: optional ? 'optional' : 'on', verifyDepth: 1 } }, onIngress: true, needsTls: true,
                    comments: { 'spec.ingressMTLS.clientCertSecret': 'client-ca (ConfigMap) — the CA under the key ca.crt', 'spec.ingressMTLS.verifyClient': optional ? 'client-crt-optional (ConfigMap)' : 'client-crt-optional (HAProxy default false: required)' } });
                ctx.note('client-ca', 'HAProxy verified client certificates for every host from the ConfigMap; NGINX Ingress Controller attaches ingressMTLS per resource, so each migrated host references this Policy. HAProxy reads the CA from tls.crt; NGINX Ingress Controller from ca.crt (the Secret can stay Opaque).', 'warning');
            },

            // https.go: annotations.Bool, so strict SNI is on only for "true".
            clientStrictSni: function(a, f, ctx) {
                ctx.use('client-strict-sni');
                let v = str(a['client-strict-sni'].value);
                if (v === 'true') ctx.note('client-strict-sni', 'NGINX Ingress Controller has no per-resource strict-SNI switch: it rejects an unknown SNI when no default certificate is set, so leave the -default-server-tls-secret flag unset (NGINX then uses ssl_reject_handshake).');
                else ctx.note('client-strict-sni', (v !== 'false' ? 'HAProxy turns strict SNI on only for the exact value "true", so "' + v + '" left it off. ' : '') + 'To serve a fallback certificate for an unknown SNI, set one with the -default-server-tls-secret flag.');
            },

            // server-ca / server-crt: backend TLS with verification. HAProxy's
            // server-ca turns TLS on with verify required (service/ca.go), so the
            // upstream needs TLS as well as the egressMTLS Policy.
            backendMTLS: function(a, f, ctx) {
                ctx.use('server-ca', 'server-crt');
                let spec = {};
                let comments = {};
                let crt = a['server-crt'], ca = a['server-ca'];
                if (crt) { spec.tlsSecret = str(crt.value).replace(/^[^/]+\//, ''); comments['spec.egressMTLS.tlsSecret'] = src(crt, 'server-crt'); }
                if (ca) {
                    spec.trustedCertSecret = str(ca.value).replace(/^[^/]+\//, '');
                    spec.verifyServer = true;
                    comments['spec.egressMTLS.trustedCertSecret'] = src(ca, 'server-ca') + ' — the CA under the key ca.crt';
                    comments['spec.egressMTLS.verifyServer'] = 'server-ca (HAProxy verifies with it)';
                    // HAProxy checked the chain only (ca.go: verify required, no
                    // verifyhost). NGINX also checks the name against
                    // proxy_ssl_name, $proxy_host unless sslName is set, and on
                    // a VirtualServer that is the vs_<ns>_<name>_<upstream>
                    // upstream name no certificate carries. The Service's
                    // cluster name is what an Ingress checks
                    // (generateProxySSLName), so both strategies check it.
                    let svcs = ca.from && ca.from.kind === 'Service' ? ca.from.name.split(', ') : ctx.services;
                    if (svcs && svcs.length === 1) {
                        spec.sslName = svcs[0] + '.' + (ctx.namespace || 'default') + '.svc';
                        comments['spec.egressMTLS.sslName'] = 'the name the backend certificate must carry; HAProxy checked no name';
                    }
                    ctx.note('server-ca', 'HAProxy verified the backend certificate\'s chain only. NGINX Ingress Controller also checks its name: against ' + (spec.sslName ? spec.sslName + ' (sslName)' : 'each Service\'s <service>.<namespace>.svc') + ', so the backend certificate must carry that name in its subjectAltName, or every request fails with 502. Set sslName to a name it does carry.', 'warning');
                }
                f.policies.push({ name: ctx.name('egress-mtls'), spec: { egressMTLS: spec }, onIngress: true, comments: comments });
                ctx.backendTls('server-' + (ca ? 'ca' : 'crt'), ca ? ca.from : crt.from);
                ctx.note(ca ? 'server-ca' : 'server-crt', 'egressMTLS sets the certificates; the upstream must also speak TLS, so it gets upstream tls (CRD-first) or nginx.org/ssl-services (annotation-first), as HAProxy turned TLS on with these.');
            },

            // ssl.go: GetBoolValue; an error leaves TLS off.
            serverSSL: function(a, f, ctx) {
                ctx.use('server-ssl');
                let x = a['server-ssl'];
                let on = haproxyBool(x.value);
                if (on === null) { invalidNote(ctx, 'server-ssl', x.value, 'a boolean', 'kept plaintext to the backend'); return; }
                if (!on) { ctx.note('server-ssl', 'server-ssl is off, and plaintext to the backend is the NGINX Ingress Controller default too; nothing to migrate.'); return; }
                ctx.backendTls('server-ssl', x.from);
                ctx.note('server-ssl', 'Like HAProxy server-ssl, NGINX Ingress Controller does not verify the backend certificate unless an egressMTLS Policy sets trustedCertSecret (HAProxy server-ca).');
            },

            // v5.7.0 sets the upstream HTTP version; "2" is h2c with prior
            // knowledge to a plain backend, as HAProxy's server proto h2 is.
            // proto.go: "h2" or "h1", case-sensitive; anything else is logged
            // and leaves the backend speaking HTTP/1.1.
            serverProto: function(a, f, ctx) {
                ctx.use('server-proto');
                let x = a['server-proto'];
                let v = str(x.value);
                if (v === 'h1') { ctx.note('server-proto', 'server-proto h1 is HTTP/1.1 to the backend, which is the NGINX Ingress Controller default; nothing to migrate.'); return; }
                if (v !== 'h2') { invalidNote(ctx, 'server-proto', v, 'h1 or h2', 'kept HTTP/1.1 to the backend'); return; }
                ctx.backend(x, 'proxy-http-version', '2', 'nginx.org/proxy-http-version', '2', 'server-proto h2');
                ctx.note('server-proto', 'NGINX speaks HTTP/2 with prior knowledge to a plain backend and offers only h2 over TLS, so there is no HTTP/1.1 fallback, and WebSocket cannot use an HTTP/2 upstream. For gRPC backends use nginx.org/grpc-services (upstream type: grpc) instead.');
            },

            // cookie.go: both set is an error before the cookie is built, so
            // no cookie at all; the name is the first word of the value.
            cookiePersistence: function(a, f, ctx) {
                ctx.use('cookie-persistence', 'cookie-persistence-no-dynamic');
                let words = function(k) { return a[k] ? str(a[k].value).split(/\s+/).filter(Boolean) : []; };
                if (words('cookie-persistence').length && words('cookie-persistence-no-dynamic').length) {
                    ctx.note('cookie-persistence', 'HAProxy rejects cookie-persistence and cookie-persistence-no-dynamic together: it logged an error and set no cookie, so nothing is migrated. Keep one of them.', 'warning');
                    ctx.note('cookie-persistence-no-dynamic', 'Not migrated: see cookie-persistence.');
                    return;
                }
                let key = words('cookie-persistence').length ? 'cookie-persistence' : 'cookie-persistence-no-dynamic';
                let x = a[key];
                let name = words(key)[0];
                if (!name) { ctx.note(key, key + ' is empty, so HAProxy set no cookie; nothing is migrated.'); return; }
                if (!cookieNameOk(name)) { ctx.note(key, key + ' "' + name + '": ' + COOKIE_NAME_RULE, 'warning'); return; }
                // HAProxy inserts a session cookie (no Expires) — leave expires unset.
                ctx.backend(x, 'sessionCookie', { enable: true, name: name, path: '/' }, 'nginx.org/sticky-cookie-services', name + ' path=/', key);
                if (key === 'cookie-persistence-no-dynamic') ctx.note('cookie-persistence-no-dynamic', 'HAProxy writes the server name as the cookie value; NGINX Ingress Controller always writes an opaque hash of the server, which pins the client the same way.');
                // The other one, set but empty, did nothing.
                ['cookie-persistence', 'cookie-persistence-no-dynamic'].forEach(function(k) { if (k !== key && a[k]) ctx.note(k, k + ' is empty, so HAProxy ignored it.'); });
            },

            // rate-limit-*: HAProxy counts requests per period in a stick table
            // and denies past the limit (reqRateLimit.go: sc0_http_req_rate gt N),
            // so N requests in a period pass and the rest are refused at once.
            // limit_req with burst N-1 and nodelay admits the same N at once.
            // reqRateLimit.go reads each value with ParseInt / ParseTime /
            // ParseSize and keeps what it parsed even on an error: a
            // rate-limit-requests that does not parse is 0, which ReqRateLimit
            // treats as "no limit"; one below 0 makes "rate gt N" always true,
            // so every request is denied. A status code it cannot parse is 0,
            // so the default 403; one HAProxy cannot send fails its
            // configuration check, so no change of that sync takes effect.
            rateLimit: function(a, f, ctx) {
                ctx.use('rate-limit-requests', 'rate-limit-period', 'rate-limit-size', 'rate-limit-status-code', 'rate-limit-whitelist');
                let req = a['rate-limit-requests'];
                if (!req) { Object.keys(a).forEach(function(k) { ctx.note(k, 'HAProxy limits only when rate-limit-requests is set, so ' + k + ' was inactive; nothing is migrated.'); }); return; }
                let others = Object.keys(a).filter(function(k) { return k !== 'rate-limit-requests'; });
                let off = function(why) {
                    ctx.note('rate-limit-requests', why, 'warning');
                    others.forEach(function(k) { ctx.note(k, k + ' was inactive, as nothing was limited: see rate-limit-requests.'); });
                };
                let n = haproxyInt(req.value);
                if (n === null || n === 0) { off('rate-limit-requests "' + req.value + '" ' + (n === 0 ? 'is 0, which HAProxy treats as no limit' : 'is not a whole number, so HAProxy logged an error and read it as 0, no limit') + '. Nothing is migrated.'); return; }
                if (n < 0) { off('rate-limit-requests "' + req.value + '" is below 0, so HAProxy denied every request ("rate gt ' + n + '" is always true). NGINX Ingress Controller cannot limit below one request; nothing is migrated, so fix the value or block the route.'); return; }
                // ParseTime; an error left the 1s default. "rate-limit-period"
                // of 0 counts nothing, so every request past the first is denied.
                let periodMs = 1000, periodSrc = ' (HAProxy default period 1s)';
                if (a['rate-limit-period']) {
                    let p = haproxyTimeMs(a['rate-limit-period'].value);
                    if (p === null || p <= 0) ctx.note('rate-limit-period', 'rate-limit-period "' + a['rate-limit-period'].value + '" is not ' + (p === null ? 'an HAProxy time, so HAProxy logged an error and' : 'a period above 0, so the migration') + ' kept the default 1s.', 'warning');
                    else { periodMs = p; periodSrc = ' / rate-limit-period'; }
                }
                let period = periodMs % 1000 ? periodMs + 'ms' : msToTime(periodMs);
                let rate, rateNote = null;
                if (periodMs === 60000) rate = n + 'r/m';
                else if (periodMs === 1000) rate = n + 'r/s';
                else if (periodMs % 60000 === 0 && n * 60000 % periodMs === 0) { rate = (n * 60000 / periodMs) + 'r/m'; rateNote = 'normalized from ' + n + ' requests per ' + period + ' — NGINX rates are per second or per minute'; }
                else { let perS = n * 1000 / periodMs; rate = (perS >= 1 ? Math.round(perS) + 'r/s' : Math.max(1, Math.round(n * 60000 / periodMs)) + 'r/m'); rateNote = 'normalized from ' + n + ' requests per ' + period + ' — NGINX rates are per second or per minute' + (perS >= 1 ? (perS % 1 ? ', rounded' : '') : ''); }
                let reject = 403, codeSrc = 'the HAProxy default 403 (NGINX Ingress Controller would send 503)';
                if (a['rate-limit-status-code']) {
                    let c = haproxyInt(a['rate-limit-status-code'].value);
                    // deny_status codes HAProxy can send (configuration.txt 3.2,
                    // "return"); a Policy and limit-req-reject-code take 400-599.
                    let sendable = [200, 400, 401, 403, 404, 405, 407, 408, 410, 413, 414, 425, 429, 431, 500, 501, 502, 503, 504];
                    if (c === null || c === 0) ctx.note('rate-limit-status-code', 'rate-limit-status-code "' + a['rate-limit-status-code'].value + '" is not a whole number, so HAProxy logged an error and denied with 403; the migration does too.', 'warning');
                    else if (sendable.indexOf(c) === -1) ctx.note('rate-limit-status-code', 'HAProxy cannot deny with ' + c + ': its configuration check failed, so HAProxy Kubernetes Ingress Controller kept its previous configuration for that whole sync. The migration denies with 403.', 'warning');
                    else if (c < 400) ctx.note('rate-limit-status-code', 'NGINX Ingress Controller rejects with a code from 400 to 599 only, so ' + c + ' becomes 403.', 'warning');
                    else { reject = c; codeSrc = 'rate-limit-status-code'; }
                }
                // limit_req admits rate plus burst at once; HAProxy admits n per
                // period, so burst n − 1. A Policy takes a positive burst only.
                let burst = n - 1;
                let rateSrc = 'rate-limit-requests' + periodSrc + (rateNote ? ' — ' + rateNote : '');
                if (a['rate-limit-whitelist']) {
                    let bad = splitCommaList(a['rate-limit-whitelist'].value).filter(function(s) { return !isPatternFileRef(s) && !isAddress(s); });
                    if (bad.length) ctx.note('rate-limit-whitelist', 'rate-limit-whitelist holds "' + bad.join('", "') + '", which is not an IP address or CIDR, so HAProxy logged an error and exempted nobody.', 'warning');
                    else ctx.note('rate-limit-whitelist', 'NGINX Ingress Controller has no rate-limit exemption list. To keep ' + a['rate-limit-whitelist'].value + ' unlimited, key the limit on a geo map (ConfigMap http-snippets) that yields an empty key for them — NGINX does not count an empty key.', 'warning');
                }
                if (a['rate-limit-size']) ctx.note('rate-limit-size', 'rate-limit-size counts tracked clients; NGINX Ingress Controller sizes the zone in memory (about 16,000 clients per megabyte), so 10M holds roughly 160,000.');
                ctx.note('rate-limit-requests', 'HAProxy counts requests over a sliding period; NGINX limit_req refills at a steady rate, so a client is admitted at the same average but spaced differently near the limit. Each NGINX Ingress Controller pod counts on its own (HAProxy counted per controller too).');
                if (ctx.strategy === 'annotation') {
                    f.ann['nginx.org/limit-req-rate'] = rate; ctx.annComment('nginx.org/limit-req-rate', rateSrc);
                    if (burst > 0) { f.ann['nginx.org/limit-req-burst'] = String(burst); ctx.annComment('nginx.org/limit-req-burst', 'rate-limit-requests − 1, with no-delay'); }
                    f.ann['nginx.org/limit-req-no-delay'] = 'true'; ctx.annComment('nginx.org/limit-req-no-delay', 'HAProxy does not queue');
                    f.ann['nginx.org/limit-req-reject-code'] = String(reject); ctx.annComment('nginx.org/limit-req-reject-code', codeSrc);
                    if (a['rate-limit-size']) { f.ann['nginx.org/limit-req-zone-size'] = '10M'; ctx.annComment('nginx.org/limit-req-zone-size', 'rate-limit-size (clients → memory)'); }
                    return;
                }
                let rl = { rate: rate };
                if (burst > 0) rl.burst = burst;
                Object.assign(rl, { noDelay: true, key: '${binary_remote_addr}', zoneSize: '10M', rejectCode: reject });
                f.policies.push({ name: ctx.name('rate-limit'), onIngress: false,
                    spec: { rateLimit: rl },
                    comments: { 'spec.rateLimit.rate': rateSrc, 'spec.rateLimit.burst': burst > 0 ? 'rate-limit-requests − 1, with noDelay' : null, 'spec.rateLimit.noDelay': 'HAProxy does not queue', 'spec.rateLimit.key': 'HAProxy tracks the client address (src)', 'spec.rateLimit.zoneSize': a['rate-limit-size'] ? 'rate-limit-size (clients → memory)' : null, 'spec.rateLimit.rejectCode': codeSrc } });
            },

            // CORS (resSetCORS.go): headers only when cors-enable is true
            // (GetBoolValue; an error is off); cors-allow-credentials and
            // cors-respond-to-options only for the string "true". The origin is
            // a regex there and an exact list here; methods and headers default
            // to "*", and one method HAProxy does not know voids the methods
            // header. cors-max-age is seconds, truncated.
            cors: function(a, f, ctx) {
                ctx.use('cors-enable', 'cors-allow-origin', 'cors-allow-methods', 'cors-allow-headers', 'cors-allow-credentials', 'cors-max-age', 'cors-respond-to-options');
                let enabled = a['cors-enable'] ? haproxyBool(a['cors-enable'].value) : false;
                if (!enabled) {
                    let why = !a['cors-enable'] ? 'cors-enable is not set' : enabled === null ? 'cors-enable "' + a['cors-enable'].value + '" is not a boolean (HAProxy logged an error)' : 'cors-enable is "' + a['cors-enable'].value + '"';
                    Object.keys(a).forEach(function(k) { ctx.note(k, 'HAProxy sends CORS headers only when cors-enable is true, and ' + why + ', so ' + k + ' was inactive; nothing is migrated.', k === 'cors-enable' && enabled === null ? 'warning' : 'note'); });
                    return;
                }
                let exactTrue = function(k) { return a[k] && str(a[k].value) === 'true'; };
                ['cors-allow-credentials', 'cors-respond-to-options'].forEach(function(k) {
                    if (a[k] && !exactTrue(k) && str(a[k].value) !== 'false') ctx.note(k, 'HAProxy turns ' + k + ' on only for the exact value "true", so "' + a[k].value + '" left it off.', 'warning');
                });
                ctx.note('cors-respond-to-options', exactTrue('cors-respond-to-options')
                    ? 'The cors Policy answers OPTIONS preflights with 204 and the CORS headers itself, as HAProxy did with cors-respond-to-options.'
                    : 'The cors Policy always answers OPTIONS preflights with 204 itself; HAProxy without cors-respond-to-options passed them to the backend, and NGINX Ingress Controller cannot.');
                let creds = exactTrue('cors-allow-credentials');
                let origin = a['cors-allow-origin'] ? str(a['cors-allow-origin'].value) : '*';
                let spec = {};
                let comments = { 'spec.cors': src(a['cors-enable'], 'cors-enable') };
                // HAProxy matches the request's Origin against the value as a
                // regex and echoes it back: "*" is any origin, and a plain
                // origin still matches only itself in practice. A Policy takes
                // exact origins or a leading-label wildcard.
                let exact = origin === '*' || /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(origin);
                if (!exact) {
                    ctx.todo('spec.cors.allowOrigin', 'list the origins the HAProxy regular expression ' + origin + ' matched — allowOrigin takes exact origins (scheme://host[:port]), a leading-label wildcard, or "*"');
                    spec.allowOrigin = ['https://app.example.com'];
                } else if (creds && origin === '*') {
                    ctx.todo('spec.cors.allowOrigin', 'list the origins your clients use — "*" is invalid with allowCredentials');
                    spec.allowOrigin = ['https://app.example.com'];
                } else {
                    spec.allowOrigin = [origin.replace(/\/$/, '')];
                }
                if (exact && origin !== '*') ctx.note('cors-allow-origin', 'HAProxy matched the Origin header against "' + origin + '" as an unanchored regular expression, so it also allowed origins that only contain it (its dots match any character); the cors Policy allows exactly ' + spec.allowOrigin[0] + '.');
                comments['spec.cors.allowOrigin'] = a['cors-allow-origin'] ? src(a['cors-allow-origin'], 'cors-allow-origin') : 'cors-allow-origin (HAProxy default *)';
                // HAProxy's methods; NGINX Ingress Controller's validateCORSMethods
                // takes fewer, no "*", and no HEAD beside GET.
                let HAPROXY_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];
                let ALLOWED = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'];
                let requested = a['cors-allow-methods'] && str(a['cors-allow-methods'].value) !== '*' ? str(a['cors-allow-methods'].value).replace(/\s+/g, '').split(',').map(function(m) { return m.toUpperCase(); }) : ['*'];
                let unknown = requested.filter(function(m) { return m !== '*' && HAPROXY_METHODS.indexOf(m) === -1; });
                if (unknown.length) {
                    ctx.note('cors-allow-methods', 'HAProxy does not know the method "' + unknown.join('", "') + '", so it logged an error and sent no Access-Control-Allow-Methods header. The Policy lists none either: browsers then allow only the simple methods (GET, HEAD, POST).', 'warning');
                } else {
                    let methods = requested[0] === '*' ? ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] : requested;
                    let dropped = methods.filter(function(m) { return ALLOWED.indexOf(m) === -1; });
                    methods = methods.filter(function(m, i) { return ALLOWED.indexOf(m) !== -1 && methods.indexOf(m) === i; });
                    if (methods.indexOf('GET') !== -1) methods = methods.filter(function(m) { return m !== 'HEAD'; });
                    spec.allowMethods = methods;
                    comments['spec.cors.allowMethods'] = (a['cors-allow-methods'] ? 'cors-allow-methods' : 'cors-allow-methods (HAProxy default *)') + (requested[0] === '*' ? ' — "*" enumerated' : '');
                    if (dropped.length) ctx.note('cors-allow-methods', 'NGINX Ingress Controller cors allowMethods accepts only GET, HEAD, POST, PUT, DELETE, OPTIONS and PATCH; dropped: ' + dropped.join(', ') + '.');
                }
                // The Policy refuses a forbidden request header (Cookie, Host,
                // Origin, Proxy-*, Sec-* …) in allowHeaders; browsers never send
                // them on request, so dropping one changes nothing.
                let FORBIDDEN = ['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection', 'content-length', 'cookie', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via'];
                let headers = a['cors-allow-headers'] ? str(a['cors-allow-headers'].value).replace(/\s+/g, '').split(',').filter(Boolean) : ['*'];
                let forbidden = headers.filter(function(h) { let l = h.toLowerCase(); return h !== '*' && (FORBIDDEN.indexOf(l) !== -1 || /^(proxy|sec)-/.test(l)); });
                let badName = headers.filter(function(h) { return h !== '*' && !/^[-A-Za-z0-9]+$/.test(h); });
                headers = headers.filter(function(h) { return forbidden.indexOf(h) === -1 && badName.indexOf(h) === -1; });
                if (forbidden.length) ctx.note('cors-allow-headers', 'NGINX Ingress Controller refuses ' + forbidden.join(', ') + ' in allowHeaders: browsers set those themselves and never ask to send them, so leaving them out changes nothing.');
                if (badName.length) ctx.note('cors-allow-headers', '"' + badName.join('", "') + '" is not a header name, so it is left out.', 'warning');
                if (headers.length) spec.allowHeaders = headers;
                comments['spec.cors.allowHeaders'] = a['cors-allow-headers'] ? 'cors-allow-headers' : 'cors-allow-headers (HAProxy default *)';
                if (creds) { spec.allowCredentials = true; comments['spec.cors.allowCredentials'] = 'cors-allow-credentials'; }
                // ParseTime, then whole seconds; an error or a value below -1
                // sent no Access-Control-Max-Age, which a browser reads as 5s.
                let age = 5, ageSrc = 'cors-max-age (HAProxy default 5s; NGINX Ingress Controller would send 86400)';
                if (a['cors-max-age']) {
                    let ms = haproxyTimeMs(a['cors-max-age'].value);
                    let secs = ms === null ? null : Math.trunc(ms / 1000);
                    if (secs === null || secs < -1) ctx.note('cors-max-age', 'cors-max-age "' + a['cors-max-age'].value + '" is not a duration HAProxy accepts, so it logged an error and sent no Access-Control-Max-Age; browsers then cache a preflight for 5s, which the Policy keeps.', 'warning');
                    else if (secs < 0) { ageSrc = 'cors-max-age -1 (no caching): the Policy\'s minimum is 0'; age = 0; }
                    else { age = secs || 0; ageSrc = 'cors-max-age' + (ms % 1000 ? ' (HAProxy truncates to whole seconds)' : ''); }
                }
                spec.maxAge = age;
                comments['spec.cors.maxAge'] = ageSrc;
                f.policies.push({ name: ctx.name('cors'), spec: { cors: spec }, onIngress: true, comments: comments });
            },

            // request-set-header / response-set-header / set-host.
            headers: function(a, f, ctx) {
                ctx.use('request-set-header', 'response-set-header', 'set-host');
                let req = a['request-set-header'] ? headerLines(a['request-set-header'].value) : [];
                let res = a['response-set-header'] ? headerLines(a['response-set-header'].value) : [];
                [['request-set-header', req], ['response-set-header', res]].forEach(function(p) {
                    if (p[1].stop === null || p[1].stop === undefined) return;
                    ctx.note(p[0], p[0] + ' has the line "' + p[1].stop + '", which is not "Name value", so HAProxy logged an error and set ' + (p[1].length ? 'only the lines before it' : 'none of the headers') + '; the migration does the same.', 'warning');
                });
                // A name NGINX Ingress Controller would refuse (IsHTTPHeaderName).
                let badName = function(list, k) {
                    let bad = list.filter(function(h) { return !/^[-A-Za-z0-9!#$%&'*+.^_`|~]+$/.test(h.name); });
                    if (bad.length) ctx.note(k, '"' + bad.map(function(h) { return h.name; }).join('", "') + '" is not a header name NGINX Ingress Controller accepts, so it is left out.', 'warning');
                    return list.filter(function(h) { return bad.indexOf(h) === -1; });
                };
                req = badName(req, 'request-set-header');
                res = badName(res, 'response-set-header');
                let host = a['set-host'] && str(a['set-host'].value) !== '' ? str(a['set-host'].value).trim() : null;
                if (!req.length && !res.length && !host) {
                    ['request-set-header', 'response-set-header', 'set-host'].forEach(function(k) { if (a[k] && str(a[k].value) === '') ctx.note(k, k + ' is empty, so HAProxy set no header; nothing is migrated.'); });
                    return;
                }
                let dynamic = function(h) { return SAMPLE_FETCH.test(h.value) || /\$/.test(h.value); };
                let fetches = req.concat(res).concat(host ? [{ name: 'Host', value: host }] : []).filter(function(h) { return SAMPLE_FETCH.test(h.value); });
                if (fetches.length) ctx.todo('headers', 'rewrite each HAProxy sample fetch as an NGINX variable (' + fetches.map(function(h) { return h.name; }).join(', ') + '): %[src] is ${remote_addr}, %[req.hdr(x)] is ${http_x}');
                // nginx.org/proxy-set-headers, add-header and upstream-vhost take
                // literal values only; a "$" or a sample fetch needs the
                // VirtualServer, whose header values take NGINX variables.
                let vhostOk = host && host.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(host.toLowerCase());
                if (ctx.strategy === 'annotation' && !req.some(dynamic) && !res.some(dynamic) && (!host || vhostOk)) {
                    if (req.length) { f.ann['nginx.org/proxy-set-headers'] = req.map(function(h) { return h.name + (h.value ? ': ' + h.value : ''); }).join(','); ctx.annComment('nginx.org/proxy-set-headers', src(a['request-set-header'], 'request-set-header')); }
                    if (res.length) {
                        f.ann['nginx.org/proxy-hide-headers'] = res.map(function(h) { return h.name; }).join(','); ctx.annComment('nginx.org/proxy-hide-headers', 'response-set-header (a replace, not an append)');
                        f.ann['nginx.org/add-header'] = res.map(function(h) { return h.name + ': ' + h.value + ': always'; }).join(','); ctx.annComment('nginx.org/add-header', src(a['response-set-header'], 'response-set-header'));
                    }
                    if (host) { f.ann['nginx.org/upstream-vhost'] = host.toLowerCase(); ctx.annComment('nginx.org/upstream-vhost', src(a['set-host'], 'set-host') + (host.toLowerCase() !== host ? ' (lowercased)' : '')); }
                } else {
                    if (ctx.strategy === 'annotation') ctx.note(a['set-host'] && !vhostOk ? 'set-host' : 'request-set-header', 'A header value here is not a literal (or set-host is not a plain hostname), which nginx.org/proxy-set-headers, add-header and upstream-vhost reject. Switch the strategy to CRD-first: VirtualServer requestHeaders and responseHeaders take NGINX variables.', 'warning');
                    let braced = function(v) { return str(v).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '${$1}'); };
                    if (req.length || host) {
                        f.proxy.requestHeaders = { set: req.map(function(h) { return { name: h.name, value: braced(h.value) }; }).concat(host ? [{ name: 'Host', value: braced(host) }] : []) };
                        f.requestHeaderSources = [req.length ? 'request-set-header' : null, host ? 'set-host' : null].filter(Boolean).join(' + ');
                    }
                    if (res.length) {
                        f.proxy.responseHeaders = { hide: res.map(function(h) { return h.name; }), add: res.map(function(h) { return { name: h.name, value: braced(h.value), always: true }; }) };
                        f.responseHeaderNote = 'response-set-header (hide, then add: a replace)';
                    }
                }
                if (req.length) ctx.note('request-set-header', 'HAProxy sets request headers before it picks the backend, so they can steer routing; NGINX sets them after the route is chosen. Routing that depended on them needs VirtualServer matches.');
            },

            requestCapture: function(a, f, ctx) {
                ctx.use('request-capture', 'request-capture-len');
                if (!a['request-capture']) { ctx.note('request-capture-len', 'request-capture-len sizes the captures of request-capture, which is not set, so HAProxy captured nothing; nothing is migrated.'); return; }
                let vars = [];
                str(a['request-capture'].value).split('\n').forEach(function(expr) {
                    expr = expr.trim();
                    if (!expr) return;
                    let m;
                    if ((m = expr.match(/^(?:req\.f?hdr|hdr)\(([^)]+)\)/i))) vars.push('$http_' + m[1].trim().toLowerCase().replace(/-/g, '_'));
                    else if ((m = expr.match(/^(?:req\.cook|cookie)\(([^)]+)\)/i))) vars.push('$cookie_' + m[1].trim().toLowerCase().replace(/-/g, '_'));
                    else ctx.note('request-capture', 'No NGINX log variable for the capture "' + expr + '".', 'warning');
                });
                if (vars.length) {
                    ctx.cm('log-format', LOG_FORMAT_HTTP + vars.join(' ') + '\n', 'request-capture — the global log format, captures appended');
                    ctx.cm('log-format-escaping', 'json', 'request-capture — header and cookie values are quoted safely');
                    ctx.note('request-capture', 'NGINX has no per-route capture slots: the captured headers and cookies are appended to the one global log-format. Set log-format-escaping: json for safe quoting.');
                }
                if (a['request-capture-len']) ctx.note('request-capture-len', haproxyInt(a['request-capture-len'].value) === null
                    ? 'request-capture-len "' + a['request-capture-len'].value + '" is not a whole number, so HAProxy logged an error and kept its default 128; NGINX log variables have no length cap anyway.'
                    : 'NGINX log variables have no length cap; the whole value is logged.', haproxyInt(a['request-capture-len'].value) === null ? 'warning' : 'note');
            },

            // check.go: GetBoolValue, default on; an error is logged and leaves
            // checks on. HAProxy probes actively; OSS has passive health only.
            check: function(a, f, ctx) {
                ctx.use('check');
                let x = a.check;
                let on = haproxyBool(x.value);
                if (on === null && str(x.value) !== '') invalidNote(ctx, 'check', x.value, 'a boolean', 'left health checks on');
                if (on === false) {
                    ctx.note('check', 'HAProxy health checks are off for this backend. NGINX Ingress Controller always marks a server failed after max-fails errors (default 1 in 10s); set max-fails: 0 to match.');
                    ctx.backend(x, 'max-fails', 0, 'nginx.org/max-fails', '0', 'check "' + x.value + '"');
                    return;
                }
                if (on) ctx.note('check', 'HAProxy runs active probes. NGINX Ingress Controller on NGINX Open Source marks a server failed only when real requests fail (max-fails, default 1 in 10s), so an idle backend is never probed. Active probes are NGINX Plus (upstreams[].healthCheck).');
            },

            // checkHTTP.go / checkInter.go / timeoutCheck.go set the probe;
            // with checks off (check "false") nothing probes. An interval or
            // timeout ParseTime rejects is logged and left unset.
            activeHealthCheck: function(a, f, ctx, entry) {
                ctx.use('check-http', 'check-interval', 'timeout-check');
                let check = ctx.backendValue ? ctx.backendValue('check', entry) : null;
                if (check && haproxyBool(check.value) === false) {
                    ['check-http', 'check-interval', 'timeout-check'].forEach(function(k) { if (a[k]) ctx.note(k, 'check is "' + check.value + '", so HAProxy ran no health checks and ' + k + ' was inactive; nothing is migrated.'); });
                    return;
                }
                let x = a['check-http'] || a['check-interval'] || a['timeout-check'];
                let hc = { enable: true };
                if (a['check-http']) {
                    let parts = str(a['check-http'].value).trim().split(/\s+/).filter(Boolean);
                    if (parts.length) {
                        hc.path = parts.length === 1 ? parts[0] : parts[1];
                        if (parts.length > 1 && parts[0].toUpperCase() !== 'GET') ctx.note('check-http', 'NGINX Plus health checks always probe with GET; the ' + parts[0] + ' method does not carry over.');
                    }
                }
                [['check-interval', 'interval'], ['timeout-check', 'read-timeout']].forEach(function(p) {
                    if (!a[p[0]]) return;
                    let t = haproxyTimeToNginx(a[p[0]].value);
                    if (t) hc[p[1]] = t.value;
                    else invalidNote(ctx, p[0], a[p[0]].value, 'an HAProxy time', 'left it unset');
                });
                ctx.backend(x, 'healthCheck', hc, null, null, 'check-http / check-interval / timeout-check — NGINX Plus only');
                ctx.note('check-http', 'Active health checks need NGINX Plus: NGINX Ingress Controller on NGINX Open Source rejects a VirtualServer with upstreams[].healthCheck. On an Ingress they are nginx.com/health-checks, also NGINX Plus.', 'warning');
            },

            loadBalance: function(a, f, ctx) {
                ctx.use('load-balance');
                let x = a['load-balance'];
                let m = haproxyLbMethod(x.value);
                if (m.none) { ctx.note('load-balance', m.none, 'warning'); return; }
                if (m.invalid) ctx.note('load-balance', m.invalid, 'warning');
                ctx.backend(x, 'lb-method', m.value, 'nginx.org/lb-method', m.value, 'load-balance' + (m.invalid ? ' (invalid: HAProxy used roundrobin)' : m.note ? ' — ' + m.note : ''));
            },

            notApplicable: function(a, f, ctx, entry) {
                let NA = {
                    'scale-server-slots': 'NGINX Ingress Controller has no pre-allocated server slots; it updates endpoints on change. Remove.',
                    'standalone-backend': 'NGINX Ingress Controller already builds a separate upstream per resource, so the shared-backend conflict this works around does not exist.',
                    'abortonclose': 'NGINX already aborts the upstream request when the client goes away (proxy_ignore_client_abort off), as abortonclose did. Remove.',
                    'clean-certs': 'NGINX Ingress Controller loads certificates from Secrets and manages its own files. Remove.'
                };
                Object.keys(a).forEach(function(k) { if (entry.names.indexOf(k) !== -1) { ctx.use(k); ctx.note(k, NA[k] || 'Not applicable on NGINX Ingress Controller. Remove.'); } });
            },

            // path-rewrite: HAProxy's replace-path rules run in order on every
            // request of the Ingress, after the backend is chosen, and replace
            // only the path. A VirtualServer route rewrites with
            // rewritePath, which on a regex route renders
            // rewrite "^<re>" "<rewritePath>" break (generateRewrites, v5.7.0).
            // Verified on nginx 1.31.7: the rule's own regex on a regex route
            // gives HAProxy's result, query string kept.
            pathRewrite: function(a, f, ctx) {
                ctx.use('path-rewrite');
                let x = a['path-rewrite'];
                let rules = str(x.value).split('\n').map(function(l) { return l.trim(); }).filter(Boolean).map(function(l) {
                    let p = l.split(/\s+/);
                    if (p.length === 1) return { re: '(.*)', to: p[0], raw: l };
                    if (p.length === 2) return { re: p[0], to: p[1].replace(/\\(\d)/g, '$$$1'), raw: l };
                    return { bad: true, raw: l };
                });
                if (rules.some(function(r) { return r.bad; })) { ctx.note('path-rewrite', 'path-rewrite takes one or two fields per line; HAProxy rejected this value, so nothing is migrated.', 'warning'); return; }
                if (!rules.length) return;
                f.rewrite = { rules: rules, source: src(x, 'path-rewrite') };
            },

            requestRedirect: function(a, f, ctx) {
                ctx.use('request-redirect', 'request-redirect-code');
                // hostRedirect.go applies the code only to a redirect it made.
                if (!a['request-redirect']) { ctx.note('request-redirect-code', 'request-redirect-code sets the code of request-redirect, which is not set, so HAProxy did not redirect; nothing is migrated.'); return; }
                let x = a['request-redirect'];
                let target = str(x.value).trim();
                // hostRedirect.go: http:// unless the value says https://.
                let scheme = 'http';
                let m = target.match(/^(https?):\/\/(.*)$/);
                if (m) { scheme = m[1]; target = m[2]; }
                let code = redirectCode(a, 'request-redirect-code', ctx);
                if (code === null) return;
                f.redirect = { url: scheme + '://' + target + '${request_uri}', code: code.code, source: src(x, 'request-redirect'), codeSource: code.source };
                if (!m) ctx.note('request-redirect', 'HAProxy redirects to http:// when request-redirect names no scheme, whatever the request used; write https:// in the URL to redirect to HTTPS.');
            },

            // httpsRedirect.go: a value GetBoolValue reads as true turns the
            // redirect on; an empty value turns it on when the Ingress has TLS;
            // anything else, an invalid value included, leaves it off. The code
            // and port only change a redirect that is on.
            sslRedirect: function(a, f, ctx) {
                ctx.use('ssl-redirect', 'ssl-redirect-code');
                let v = a['ssl-redirect'] ? str(a['ssl-redirect'].value) : '';
                let on = v === '' ? null : haproxyBool(v);
                if (v !== '' && on === null) ctx.note('ssl-redirect', 'ssl-redirect "' + v + '" is not a boolean, so HAProxy logged an error and did not redirect, TLS or not. The migration does not redirect either.', 'warning');
                if (on === false || (v !== '' && on === null)) {
                    if (a['ssl-redirect-code']) ctx.note('ssl-redirect-code', 'ssl-redirect-code sets the code of a redirect that is off here, so it did nothing.');
                    f.tlsRedirect = false;
                    return;
                }
                // Unset, the redirect is on only for an Ingress with TLS.
                if (!on && !ctx.hasTls) {
                    if (a['ssl-redirect-code']) ctx.note('ssl-redirect-code', 'ssl-redirect-code sets the code of the HTTPS redirect, which HAProxy makes only with ssl-redirect or TLS on the Ingress; this one has neither, so it did nothing.');
                    return;
                }
                let code = a['ssl-redirect-code'] ? redirectCode(a, 'ssl-redirect-code', ctx) : { code: 302, source: 'the HAProxy default 302' };
                if (code === null) { f.tlsRedirect = false; return; }
                f.tlsRedirect = { code: code.code, codeSource: code.source, source: on ? src(a['ssl-redirect'], 'ssl-redirect') : null, explicit: !!on };
            },

            sslRedirectPort: function(a, f, ctx) {
                ctx.use('ssl-redirect-port');
                let v = str(a['ssl-redirect-port'].value);
                if (haproxyInt(v) === null) { invalidNote(ctx, 'ssl-redirect-port', v, 'a port number', 'redirected to its default port 8443'); return; }
                ctx.note('ssl-redirect-port', 'NGINX Ingress Controller redirects to its own HTTPS listener (443 unless -default-https-listener-port moves it) and has no separate port for the redirect. To send clients to ' + v + ', write the redirect yourself: a VirtualServer route with action.redirect.url https://${host}:' + v + '${request_uri}.', 'warning');
            },

            // timeoutServer.go: ParseTime; an error is logged and the
            // backend keeps the server timeout of the defaults section, 50s
            // unless timeout-server in the ConfigMap moved it.
            timeoutServer: function(a, f, ctx) {
                ctx.use('timeout-server');
                let x = a['timeout-server'];
                let t = haproxyTimeToNginx(x.value);
                if (!t) { invalidNote(ctx, 'timeout-server', x.value, 'an HAProxy time', 'kept the default server timeout (50s unless the ConfigMap set one)'); return; }
                let c = 'timeout-server' + (t.note ? ' — ' + t.note : '');
                ctx.backend(x, 'read-timeout', t.value, 'nginx.org/proxy-read-timeout', t.value, c);
                ctx.backend(x, 'send-timeout', t.value, 'nginx.org/proxy-send-timeout', t.value, 'timeout-server');
            },

            // maxconn.go: ParseInt, then divided by the controller replicas.
            podMaxconn: function(a, f, ctx) {
                ctx.use('pod-maxconn');
                let x = a['pod-maxconn'];
                let n = haproxyInt(x.value);
                if (n === null) { invalidNote(ctx, 'pod-maxconn', x.value, 'a whole number', 'set no connection limit'); return; }
                if (n < 0) { ctx.note('pod-maxconn', 'pod-maxconn ' + n + ' is below 0, which NGINX Ingress Controller refuses for max-conns; nothing is migrated.', 'warning'); return; }
                ctx.backend(x, 'max-conns', n, 'nginx.org/max-conns', String(n), 'pod-maxconn');
                ctx.note('pod-maxconn', n === 0 ? 'pod-maxconn 0 is no limit in HAProxy, and max-conns 0 is no limit in NGINX.' : 'HAProxy divides pod-maxconn by the controller replicas itself; NGINX Ingress Controller applies the value per replica, so divide it by your replica count.');
            },

            // ingress.go: annotations.Bool, so passthrough only for "true";
            // GetBoolValue still logs an error for a value it cannot read.
            sslPassthrough: function(a, f, ctx) {
                ctx.use('ssl-passthrough');
                let v = str(a['ssl-passthrough'].value);
                if (v === 'true') { f.passthrough = a['ssl-passthrough']; return; }
                ctx.note('ssl-passthrough', v === 'false' || v === '' ? 'Passthrough is off; nothing to migrate.'
                    : 'HAProxy turns ssl-passthrough on only for the exact value "true"' + (haproxyBool(v) === null ? ' (and logged an error for "' + v + '")' : '') + ', so "' + v + '" left it off; the Ingress migrates as HTTP.', v === 'false' || v === '' ? 'note' : 'warning');
            },

            ingressClass: function(a, f, ctx) {
                ctx.use('ingress.class');
                ctx.note('ingress.class', 'Set spec.ingressClassName instead of the deprecated class annotation; NGINX Ingress Controller reads the annotation first and ignores the field when both are set.');
            },

            backendSnippet: function(a, f, ctx) {
                ctx.use('backend-config-snippet');
                let x = a['backend-config-snippet'];
                str(x.value).split('\n').map(function(l) { return l.trim(); }).filter(Boolean).forEach(function(l) {
                    let line = '# TODO rewrite as NGINX: ' + l;
                    f.location.push(line); ctx.snippetSource(line, 'backend-config-snippet');
                });
                ctx.todo('location-snippets', 'rewrite each backend-config-snippet line as an NGINX directive — HAProxy directives fail the NGINX reload');
                if (/stick-table|stick\s+on/i.test(x.value)) ctx.note('backend-config-snippet', 'A stick table used for persistence becomes upstreams[].sessionCookie; other stick tables have no equivalent.');
            },

            modsecurity: function(a, f, ctx) {
                ctx.use('modsecurity');
                f.policies.push({ name: ctx.name('waf'), spec: { waf: { enable: true, apPolicy: 'default/dataguard-alarm', securityLog: { enable: true, apLogConf: 'default/logconf', logDest: 'syslog:server=127.0.0.1:514' } } }, onIngress: true, plus: true,
                    comments: { 'spec.waf.enable': 'modsecurity — NGINX Plus with F5 WAF for NGINX', 'spec.waf.apPolicy': 'TODO: an APPolicy you author; ModSecurity rules do not carry over' } });
                ctx.todo('spec.waf.apPolicy', 'author an APPolicy — ModSecurity and CRS rules do not carry over');
                ctx.note('modsecurity', 'HAProxy Enterprise ModSecurity rules cannot be imported: F5 WAF for NGINX uses its own policy (APPolicy). Re-author and tune it, and set the enforcement mode (HAProxy ships detection-only). Needs NGINX Plus; on an Ingress, reference the Policy through nginx.com/policies.', 'warning');
            },

            crBackendRef: function(a, f, ctx) {
                ctx.use('cr-backend');
                // Resolved per Service by the assembler; a pointer with no CR in
                // the paste is reported there.
            },

            // Placed by the assembler, not by a translator: route-acl becomes
            // splits and matches (canaryFor), the Ingress spec its resources.
            routeAcl: function(a, f, ctx) { ctx.use('route-acl'); },
            ingressSpec: function() {},
            // Global keys and CRs: the controller pass (migrateController).
            controller: function(a, f, ctx, entry) { entry.names.forEach(function(n) { ctx.use(n); }); }
        };

        // --- Assembly -----------------------------------------------------------
        // One Ingress at a time, resolved against the run: the settings HAProxy
        // would apply, then resources built from the real Ingress — one
        // VirtualServer per host under CRD-first, the migrated Ingress under
        // annotation-first, never both (NGINX Ingress Controller lets one
        // resource own a host). Every route, backend, TLS secret and Policy
        // reference is carried over.

        // Which mapping reads a bare name, and how: the translator key, and
        // whether HAProxy reads it per backend (Service > Ingress > ConfigMap)
        // or per frontend (Ingress > ConfigMap). Scopes from the v3.2.12
        // annotation table and annotations.go Frontend()/Backend().
        let BACKEND_KEYS = ['abortonclose', 'backend-config-snippet', 'check', 'check-http', 'check-interval', 'cookie-persistence', 'cookie-persistence-no-dynamic',
            'forwarded-for', 'load-balance', 'pod-maxconn', 'scale-server-slots', 'send-proxy-protocol', 'server-ca', 'server-crt', 'server-proto', 'server-ssl',
            'standalone-backend', 'timeout-check', 'timeout-server'];
        let FRONTEND_KEYS = ['allow-list', 'whitelist', 'deny-list', 'blacklist', 'src-ip-header', 'auth-type', 'auth-realm', 'auth-secret', 'ssl-redirect', 'ssl-redirect-port',
            'ssl-redirect-code', 'request-redirect', 'request-redirect-code', 'rate-limit-requests', 'rate-limit-period', 'rate-limit-size', 'rate-limit-status-code',
            'rate-limit-whitelist', 'request-capture', 'request-capture-len', 'path-rewrite', 'request-set-header', 'response-set-header', 'set-host',
            'cors-enable', 'cors-allow-origin', 'cors-allow-methods', 'cors-allow-headers', 'cors-max-age', 'cors-allow-credentials', 'cors-respond-to-options',
            'ssl-passthrough', 'modsecurity'];
        // ConfigMap-only keys (handler/https.go reads them once) whose NGINX
        // Ingress Controller form is per resource: every Ingress gets them.
        let PER_RESOURCE_CM = ['client-ca', 'client-crt-optional'];

        let NAME_TO_TRANSLATOR = {};
        HAPROXY_MAPPINGS.forEach(function(m, idx) {
            m.keys.forEach(function(k) { let n = k.split(':')[1]; if (k.indexOf('kind:') !== 0) NAME_TO_TRANSLATOR[n] = idx; });
        });

        function makeCtx(model, strategy) {
            let usedNames = {};
            let ctx = {
                strategy: strategy,
                namespace: model.namespace,
                consumed: {},
                notes: [],
                todos: [],
                snippetSources: [],
                annComments: {},
                cmData: {},
                cmComments: {},
                use: function() { for (let i = 0; i < arguments.length; i++) ctx.consumed[arguments[i]] = true; },
                note: function(name, message, severity) {
                    if (ctx.notes.some(function(n) { return n.name === name && n.message === message; })) return;
                    ctx.notes.push({ name: name, message: message, severity: severity || 'note' });
                },
                todo: function(path, message) {
                    if (ctx.todos.some(function(t) { return t.path === path && t.message === message; })) return;
                    ctx.todos.push({ path: path, message: message });
                },
                annComment: function(key, text) { ctx.annComments[key] = text; },
                snippetSource: function(prefix, text) { ctx.snippetSources.push({ prefix: prefix, text: text }); },
                cm: function(key, value, comment) { ctx.cmData[key] = String(value); ctx.cmComments[key] = comment; },
                name: function(base) {
                    let stem = dnsName((model.name ? model.name + '-' : '') + base);
                    let n = stem;
                    for (let i = 2; usedNames[n]; i++) n = stem + '-' + i;
                    usedNames[n] = true;
                    return n;
                }
            };
            return ctx;
        }

        // The settings HAProxy applies to one Ingress, resolved against the run.
        // Frontend: Ingress, then ConfigMap. Backend: per Service — its own
        // annotations, then the Ingress's, then the ConfigMap's — unless a
        // cr-backend CR replaces them. Returns { frontend, perService }.
        function resolve(model, run) {
            let cm = controllerOptions(run);
            let frontend = {};
            let from = function(kind, name) { return { kind: kind, name: name }; };
            FRONTEND_KEYS.forEach(function(k) {
                if (model.haproxy[k]) frontend[k] = { value: model.haproxy[k].value, from: from('Ingress', model.name) };
                else if (cm[k]) frontend[k] = { value: cm[k].value, from: from('ConfigMap', null) };
            });
            // ingress.go: annotations.Bool, so passthrough only for "true".
            let pt = model.haproxy['ssl-passthrough'] || cm['ssl-passthrough'];
            let passthrough = !!pt && str(pt.value) === 'true';
            if (!passthrough) PER_RESOURCE_CM.forEach(function(k) { if (cm[k]) frontend[k] = { value: cm[k].value, from: from('ConfigMap', null) }; });
            if (model.haproxy['ingress.class']) frontend['ingress.class'] = { value: model.haproxy['ingress.class'].value, from: from('Ingress', model.name) };
            let services = [];
            let seen = {};
            model.hosts.forEach(function(h) { h.paths.forEach(function(p) { if (p.backend && p.backend.service && !seen[p.backend.service]) { seen[p.backend.service] = true; services.push(p.backend.service); } }); });
            if (model.defaultBackend && model.defaultBackend.service && !seen[model.defaultBackend.service]) services.push(model.defaultBackend.service);
            let perService = {};
            services.forEach(function(name) {
                let svc = findService(run, model.namespace, name);
                let s = { service: svc, settings: {}, routeAcl: null, crBackend: null };
                let lookup = function(k) {
                    if (svc && svc.haproxy[k]) return { value: svc.haproxy[k].value, from: from('Service', name) };
                    if (model.haproxy[k]) return { value: model.haproxy[k].value, from: from('Ingress', model.name) };
                    if (cm[k]) return { value: cm[k].value, from: from('ConfigMap', null) };
                    return null;
                };
                let ref = lookup('cr-backend');
                if (ref) {
                    s.crBackendRef = ref;
                    s.crBackend = findCR(run, 'Backend', ref.value, (svc && svc.namespace) || model.namespace);
                }
                // A ConfigMap value whose NGINX Ingress Controller key is global
                // too (CM_GLOBAL) is the controller pass's: every upstream
                // inherits nginx-config, so it is not repeated per upstream.
                if (!s.crBackend) BACKEND_KEYS.forEach(function(k) { let v = lookup(k); if (v && !(v.from.kind === 'ConfigMap' && CM_GLOBAL[k])) s.settings[k] = v; });
                if (svc && svc.haproxy['route-acl']) s.routeAcl = { value: svc.haproxy['route-acl'].value, from: from('Service', name) };
                perService[name] = s;
            });
            return { frontend: frontend, perService: perService, services: services };
        }

        // Backend settings resolved the same for every Service are Ingress-wide
        // (one upstream field for all, or one nginx.org/* annotation); a value
        // that differs between Services is per Service. NGINX Ingress
        // Controller annotations are per Ingress, so a per-Service value has
        // only the VirtualServer form.
        function backendGroups(resolved) {
            let byKey = {};
            resolved.services.forEach(function(name) {
                let s = resolved.perService[name];
                Object.keys(s.settings).forEach(function(k) { (byKey[k] = byKey[k] || {})[name] = s.settings[k]; });
            });
            return byKey;
        }

        function snippetComment(line, ctx) {
            let hit = ctx.snippetSources.find(function(s) { return line.indexOf(s.prefix) === 0; });
            return hit ? hit.text : null;
        }
        function snippetSourcesFor(lines, ctx) {
            let names = [];
            lines.forEach(function(l) { let s = snippetComment(l, ctx); if (s && names.indexOf(s) === -1) names.push(s); });
            return names.join(' + ') || null;
        }
        function snippetBlock(lines) { return lines.length ? lines.join('\n') + '\n' : null; }

        function upstreamName(service, port, taken) {
            let base = dnsName(service, 'backend');
            let name = base;
            for (let n = 2; taken[name] && taken[name] !== service + ':' + port; n++) name = base + '-' + n;
            taken[name] = service + ':' + port;
            return name;
        }
        function upstreamPort(port, ctx, where) {
            if (typeof port === 'number') return port;
            if (/^\d+$/.test(String(port))) return parseInt(port, 10);
            if (port === null || port === undefined || port === '') { ctx.todo(where, 'the Service port (none is set on this backend)'); return 80; }
            ctx.todo(where, 'named Service port "' + port + '" — replace it with the port number; VirtualServer upstreams take numbers');
            return port;
        }
        function resourceName(model, host, options, used) {
            let stem = (model.name || 'my-app') + (options.nameSuffix || '');
            let label = host ? host.replace(/^\*\./, 'wildcard.').split('.')[0] : '';
            let base = model.hosts.length <= 1 || label === model.name ? stem : stem + '-' + label;
            let name = dnsName(base);
            for (let n = 2; used[name]; n++) name = dnsName(base + '-' + n);
            used[name] = true;
            return name;
        }
        function policyDoc(p, model) {
            let md = { name: p.name };
            if (model.namespace) md.namespace = model.namespace;
            return { apiVersion: NIC_API, kind: 'Policy', metadata: md, spec: p.spec };
        }
        function prefixComments(map, prefix) {
            let out = {};
            Object.keys(map || {}).forEach(function(k) { out[prefix + k] = map[k]; });
            return out;
        }
        // NGINX Ingress Controller ignores a resource whose class it does not
        // own (HasCorrectIngressClass), and claims one with none. A class
        // naming HAProxy is never carried over.
        function targetClass(model, options) {
            if (options.ingressClass) return options.ingressClass;
            let c = model.ingressClassName;
            return c && !/haproxy/i.test(c) ? c : null;
        }

        // route-acl → the canary leg of every route on the hosts the canary
        // Service's own path sits on. HAProxy writes "use_backend <canary> if
        // { host } { path } { acl }" ahead of the map lookup (route.go
        // AddCustomRoute), so the canary path itself routes nothing else.
        function canaryFor(model, resolved, ctx) {
            let out = [];
            resolved.services.forEach(function(name) {
                let s = resolved.perService[name];
                if (!s.routeAcl) return;
                let acl = parseRouteACL(s.routeAcl.value);
                let label = 'route-acl (Service ' + name + ')';
                if (acl.kind === 'rand') out.push({ service: name, split: acl.pct, source: label + ': ' + acl.raw });
                else if (acl.kind === 'cookie' || acl.kind === 'header' || acl.kind === 'arg' || acl.kind === 'method' || acl.kind === 'found') out.push({ service: name, match: acl, source: label + ': ' + acl.raw });
                else if (acl.kind === 'src') ctx.note('route-acl', 'Service ' + name + ' routes clients from ' + acl.cidrs.join(', ') + '; a VirtualServer match cannot test a client address, so this canary is not migrated. Give those clients their own host, or match on a header your proxy sets.', 'warning');
                else ctx.note('route-acl', 'Service ' + name + ': the ACL "' + acl.raw + '" does not translate' + (acl.why ? ' (' + acl.why + ')' : '') + '. VirtualServer matches test headers, cookies, query arguments and a fixed set of variables; re-express it with those.', 'warning');
            });
            return out;
        }
        function matchCondition(m) {
            if (m.kind === 'cookie') return { cookie: m.name, value: m.value === null ? '!' : m.value };
            if (m.kind === 'header') return { header: m.name, value: m.value === null ? '!' : m.value };
            if (m.kind === 'arg') return { argument: m.name, value: m.value === null ? '!' : m.value };
            return { variable: '$request_method', value: m.value };
        }

        // Build the resources for one Ingress.
        function migrateIngress(model, run, strategy, options) {
            options = options || {};
            let ctx = makeCtx(model, strategy);
            let resolved = resolve(model, run);
            ctx.services = resolved.services;
            ctx.hasTls = model.tls.length > 0;
            let f = { upstream: {}, upstreamComments: {}, svc: {}, proxy: {}, location: [], server: [], policies: [], ann: {} };
            let backendTlsFrom = {};
            let groups = backendGroups(resolved);
            // A backend setting: one value for every Service is Ingress-wide;
            // different values are per Service, which only a VirtualServer can carry.
            ctx.backend = function(x, field, value, annKey, annValue, comment) {
                let byService = x.byService || null;
                if (!byService) {
                    upstreamField(f, null, field, value, comment);
                    if (annKey) { f.ann[annKey] = annValue; ctx.annComment(annKey, comment); }
                    return;
                }
                let read = x.from && x.from.kind !== 'Service' ? ' (' + x.from.kind + (x.from.name ? ' ' + x.from.name : '') + ')' : ' (Service ' + Object.keys(byService)[0] + ')';
                Object.keys(byService).forEach(function(svc) {
                    upstreamField(f, svc, field, value, comment + read);
                    if (annKey && strategy === 'annotation') backendAnn(f, svc, annKey, annValue, comment + read);
                });
            };
            ctx.backendTls = function(source, from) { backendTlsFrom[source] = from; };
            // Another backend key as HAProxy resolved it for this entry's
            // Service (or every Service, for an Ingress-wide entry), the
            // ConfigMap's included.
            ctx.backendValue = function(k, entry) {
                let svcs = entry && entry.service ? [entry.service] : resolved.services;
                for (let i = 0; i < svcs.length; i++) {
                    let s = resolved.perService[svcs[i]];
                    if (s && s.settings[k]) return s.settings[k];
                }
                let cmv = controllerOptions(run)[k];
                return cmv && svcs.some(function(n) { return !resolved.perService[n].crBackend; }) ? { value: cmv.value, from: { kind: 'ConfigMap', name: null } } : null;
            };

            // Run one translator per mapping, over a settings map built for it.
            let matched = new Map();
            let unrecognised = [];
            let unsupported = [];
            let addSetting = function(name, x, svc) {
                let idx = NAME_TO_TRANSLATOR[name];
                if (idx === undefined) { if (unrecognised.indexOf(name) === -1) unrecognised.push(name); return; }
                let key = idx + (svc ? '|' + svc : '');
                if (!matched.has(key)) matched.set(key, { mapping: HAPROXY_MAPPINGS[idx], a: {}, service: svc || null, names: [] });
                let e = matched.get(key);
                e.a[name] = x;
                if (e.names.indexOf(name) === -1) e.names.push(name);
            };
            Object.keys(resolved.frontend).forEach(function(k) { addSetting(k, resolved.frontend[k]); });
            // Backend settings: Ingress-wide when every Service resolved the
            // same value; else one entry per Service.
            Object.keys(groups).forEach(function(k) {
                let bySvc = groups[k];
                let vals = Object.keys(bySvc).map(function(s) { return bySvc[s].value; });
                let all = resolved.services.every(function(s) { return bySvc[s]; });
                if (all && vals.every(function(v) { return v === vals[0]; })) {
                    let first = bySvc[Object.keys(bySvc)[0]];
                    let fromKinds = Object.keys(bySvc).map(function(s) { return bySvc[s].from.kind; });
                    addSetting(k, { value: first.value, from: fromKinds.every(function(fk) { return fk === fromKinds[0]; }) ? first.from : { kind: 'Service', name: Object.keys(bySvc).join(', ') } });
                } else {
                    Object.keys(bySvc).forEach(function(s) { let x = Object.assign({}, bySvc[s], { byService: {} }); x.byService[s] = true; addSetting(k, x, s); });
                }
            });
            // Annotations on the Ingress that HAProxy reads for no backend and no
            // frontend in this run (Service-only keys, or keys it does not know).
            Object.keys(model.haproxy).forEach(function(k) {
                if (resolved.frontend[k] || groups[k] || k === 'ingress.class' || k === 'cr-backend') return;
                if (k === 'route-acl') { ctx.note('route-acl', 'HAProxy reads route-acl from a Service only, so on this Ingress it did nothing; nothing is migrated.', 'warning'); return; }
                // A backend key that reached no Service: replaced by a cr-backend
                // CR (reported below), or there is no backend to carry it.
                if (BACKEND_KEYS.indexOf(k) !== -1 && resolved.services.some(function(n) { return resolved.perService[n].crBackend; })) return;
                if (BACKEND_KEYS.indexOf(k) !== -1 && !resolved.services.length) {
                    let idx = NAME_TO_TRANSLATOR[k];
                    if (idx !== undefined && HAPROXY_MAPPINGS[idx].type === 'unsupported') { addSetting(k, { value: model.haproxy[k].value, from: { kind: 'Ingress', name: model.name } }); return; }
                    ctx.use(k);
                    ctx.note(k, 'This Ingress routes to no Service, so there is no backend for ' + k + ' to apply to; nothing is migrated.', 'warning');
                    return;
                }
                addSetting(k, { value: model.haproxy[k].value, from: { kind: 'Ingress', name: model.name } });
            });

            let order = ['sslPassthrough'];
            let entries = Array.from(matched.values());
            entries.sort(function(x, y) { return order.indexOf(y.mapping.generator) - order.indexOf(x.mapping.generator); });
            entries.forEach(function(entry) {
                let m = entry.mapping;
                if (m.type === 'unsupported') { unsupported.push(entry); entry.names.forEach(function(n) { ctx.consumed[n] = true; }); return; }
                let tr = TRANSLATORS[m.generator];
                if (!tr) return;
                f.seen = f.seen || {};
                entry.names.forEach(function(n) { f.seen[n] = true; });
                let h = JSON.stringify(f), p = f.policies.length, cmBefore = JSON.stringify(ctx.cmData);
                try { tr(entry.a, f, ctx, entry); }
                catch (e) { console.warn('Translator failed for ' + m.source + ' (' + m.generator + '):', e); }
                entry.toHost = JSON.stringify(Object.assign({}, f, { policies: [] })) !== JSON.stringify(Object.assign(JSON.parse(h), { policies: [] }));
                entry.toConfigMap = JSON.stringify(ctx.cmData) !== cmBefore;
                f.policies.slice(p).forEach(function(pol) { pol.sources = entry.names.map(function(n) { return { name: n, from: entry.a[n].from }; }); });
                entry.toPolicy = f.policies.length > p;
            });
            entries.forEach(function(entry) {
                entry.names.forEach(function(n) { if (!ctx.consumed[n]) ctx.note(n, 'Recognized, but this tool has no translation for it: migrate it by hand (see the reference row).', 'warning'); });
            });

            // cr-backend: the Backend CR replaces every backend annotation.
            resolved.services.forEach(function(name) {
                let s = resolved.perService[name];
                if (!s.crBackendRef) return;
                if (!s.crBackend) { ctx.note('cr-backend', 'Service ' + name + ' takes its backend settings from the Backend ' + s.crBackendRef.value + ', which is not in the paste; paste it too to migrate them.', 'warning'); return; }
                backendCRToUpstream(s.crBackend, name, f, ctx);
                let skipped = BACKEND_KEYS.filter(function(k) { return (s.service && s.service.haproxy[k]) || model.haproxy[k]; });
                if (skipped.length) ctx.note('cr-backend', 'HAProxy ignored ' + skipped.join(', ') + ' for Service ' + name + ', because the Backend ' + s.crBackend.name + ' replaces backend annotations; the migration follows the Backend.', 'warning');
            });

            // Backend TLS: one service or all.
            Object.keys(backendTlsFrom).forEach(function(source) {
                let fr = backendTlsFrom[source];
                let svcs = fr && fr.kind === 'Service' ? fr.name.split(', ') : null;
                if (svcs) svcs.forEach(function(s) { upstreamField(f, s, 'tls', { enable: true }, source + ' (on Service ' + s + ')'); });
                else upstreamField(f, null, 'tls', { enable: true }, source);
                f.sslServices = f.sslServices || [];
                (svcs || resolved.services).forEach(function(s) { if (f.sslServices.indexOf(s) === -1) f.sslServices.push(s); });
                f.sslSource = source;
            });

            f.canary = canaryFor(model, resolved, ctx);

            let out = f.passthrough ? buildPassthrough(model, f, ctx, options)
                : strategy === 'crd' ? buildCrd(model, resolved, f, ctx, options) : buildIngress(model, resolved, f, ctx, options);

            // Every recognised setting must be findable in the output.
            let named = {};
            let addNames = function(text) { String(text || '').split(/[^a-z0-9.-]+/).forEach(function(w) { if (w) named[w] = true; }); };
            (out.comments || []).forEach(function(c) { Object.keys(c).forEach(function(k) { addNames(c[k]); }); });
            Object.keys(ctx.cmComments).forEach(function(k) { addNames(ctx.cmComments[k]); });
            ctx.notes.forEach(function(n) { addNames(n.name); });
            ctx.todos.forEach(function(t) { addNames(t.message); });
            // Only a mapping that wrote something folded anything in. One that
            // wrote nothing was either explained by a note ("cors-enable is not
            // set, so cors-max-age was inactive") or said nothing, which is a
            // lost setting and says so. An empty value is no value to HAProxy:
            // GetValue returns "" and each processor skips it.
            let unnamed = [], lost = [], empty = [];
            let explained = function(name) { return ctx.notes.some(function(n) { return new RegExp('(^|[^a-z-])' + name.replace(/[.]/g, '\\.') + '($|[^a-z-])').test(n.message); }); };
            entries.forEach(function(entry) {
                if (entry.mapping.type === 'unsupported') return;
                let wrote = entry.toHost || entry.toPolicy || entry.toConfigMap;
                entry.names.forEach(function(n) {
                    if (named[n] || !ctx.consumed[n] || ctx.passthroughIdle) return;
                    let list = wrote ? unnamed : explained(n) ? null : str(entry.a[n] && entry.a[n].value).trim() === '' ? empty : lost;
                    if (list && list.indexOf(n) === -1) list.push(n);
                });
            });
            if (empty.length) ctx.note('applied', 'Empty, so HAProxy ignored ' + (empty.length > 1 ? 'them' : 'it') + ': ' + empty.join(', ') + '. Nothing is migrated.');
            if (unnamed.length) ctx.note('applied', (out.docs.length ? 'Also applied, folded into the fields above: ' : 'Not migrated, because no resource was produced: ') + unnamed.join(', ') + '.', out.docs.length ? 'note' : 'warning');
            if (lost.length) ctx.note('applied', 'Recognized but not migrated, and this tool did not say why: ' + lost.join(', ') + '. Check what HAProxy did with ' + (lost.length > 1 ? 'these values' : 'this value') + ' (it logs an error for a value it cannot read and keeps its default) and migrate by hand if it took effect; see the reference rows.', 'warning');

            out.notes = ctx.notes;
            out.todos = ctx.todos;
            out.unsupported = unsupported;
            out.unrecognized = unrecognised;
            out.matched = entries;
            out.configMap = Object.keys(ctx.cmData).length ? { data: ctx.cmData, comments: ctx.cmComments } : null;
            out.sources = out.docs.map(function(d, i) {
                if (d.kind === 'Policy') {
                    let p = f.policies.find(function(x) { return x.name === d.metadata.name; });
                    return p && p.sources ? p.sources.slice() : [];
                }
                let keys = [];
                entries.forEach(function(e) { if (e.toHost && !e.toPolicy) e.names.forEach(function(n) { keys.push({ name: n, from: e.a[n].from }); }); });
                // What the assembler placed itself: the canary Services'
                // route-acl and the Backend CRs of the Services this host reaches.
                let services = ((d.spec && d.spec.upstreams) || []).map(function(u) { return u.service; });
                f.canary.forEach(function(c) { if (services.indexOf(c.service) !== -1) keys.push({ name: 'route-acl', from: { kind: 'Service', name: c.service } }); });
                resolved.services.forEach(function(n) { let s = resolved.perService[n]; if (s.crBackend && (d.kind === 'Ingress' || services.indexOf(n) !== -1)) keys.push({ cr: s.crBackend, name: 'cr-backend', from: { kind: 'Service', name: n } }); });
                return keys;
            });
            return out;
        }

        // A Backend CR's fields, onto the upstreams of the Service it serves.
        function backendCRToUpstream(cr, service, f, ctx) {
            let config = cr.config || {};
            let get = function(names) {
                for (let i = 0; i < names.length; i++) for (let key in config) if (String(key).toLowerCase().replace(/_/g, '-') === names[i]) return config[key];
                return undefined;
            };
            let label = 'Backend ' + cr.name;
            if (String(get(['mode'])).toLowerCase() === 'tcp') { ctx.note('cr-backend', label + ' is in TCP mode; its settings belong on a TransportServer upstream (see the TCP rows).', 'warning'); return; }
            let balance = get(['balance']);
            if (balance !== undefined) {
                let m = haproxyLbMethod(balanceString(balance));
                if (m.value && !m.invalid) upstreamField(f, service, 'lb-method', m.value, label + ' balance' + (m.note ? ' — ' + m.note : ''));
                else ctx.note('cr-backend', label + ' balance: ' + (m.none || m.invalid), 'warning');
            }
            // The CRD types these fields (integer milliseconds, minimum 0), so
            // the API server rejects a bad one before HAProxy reads it.
            let ct = msToNginxTime(get(['connect-timeout']));
            if (ct) upstreamField(f, service, 'connect-timeout', ct.value, label + ' connect_timeout (milliseconds)');
            let st = msToNginxTime(get(['server-timeout']));
            if (st) {
                upstreamField(f, service, 'read-timeout', st.value, label + ' server_timeout (milliseconds)');
                upstreamField(f, service, 'send-timeout', st.value, label + ' server_timeout covers both directions');
            }
            let retries = haproxyInt(get(['retries']));
            if (retries !== null && retries >= 0) upstreamField(f, service, 'next-upstream-tries', retries, label + ' retries');
            let cookie = get(['cookie']);
            let cookieName = cookie === undefined ? null : str((isMap(cookie) ? cookie.name : cookie) || 'SERVERID');
            if (cookieName !== null && cookieNameOk(cookieName)) upstreamField(f, service, 'sessionCookie', { enable: true, name: cookieName, path: '/' }, label + ' cookie');
            else if (cookieName !== null) ctx.note('cr-backend', label + ' cookie "' + cookieName + '": ' + COOKIE_NAME_RULE, 'warning');
            let ds = get(['default-server']);
            let maxconn = isMap(ds) ? haproxyInt(ds.maxconn) : null;
            if (maxconn !== null && maxconn >= 0) upstreamField(f, service, 'max-conns', maxconn, label + ' default_server.maxconn');
            if (get(['check', 'httpchk-params', 'adv-check']) !== undefined) ctx.note('cr-backend', label + ' runs active health checks, which need NGINX Plus (upstreams[].healthCheck); NGINX Open Source marks a server failed only when real requests fail.', 'warning');
            let rules = ['acl-list', 'http-request-rule-list', 'http-response-rule-list', 'server-switching-rule-list', 'stick-table'].filter(function(n) { return get([n]) !== undefined; });
            if (rules.length) ctx.note('cr-backend', label + ': ' + rules.join(', ') + ' do not carry over as data; re-express them as VirtualServer matches, Policies or snippets.', 'warning');
            ctx.consumed['cr-backend'] = true;
        }

        // The routes for one Ingress path under path-rewrite. HAProxy's
        // replace-path searches the path for its regex anywhere and, on a
        // match, replaces the WHOLE path with the format (configuration.txt
        // 3.2, "replace-path"); a request it does not match is passed on as it
        // is. NGINX Ingress Controller renders a regex route's rewritePath as
        // rewrite "^<route regex>" "<rewritePath>" break, after its own set
        // lines (generateRewrites, v5.7.0). So the rule becomes a regex route
        // that matches only what the rule rewrites — the Ingress path as a
        // lookahead, then HAProxy's regex found leftmost — beside the plain
        // route for the rest. Verified on nginx 1.31.7: /app/a/b?q=1 becomes
        // /new/a/b?q=1, /app passes unchanged, /apple is not routed.
        // `others` are the host's other Prefix paths: HAProxy picks the longest
        // matching prefix first (its path map), then rewrites, so a route must
        // not take a request a longer path owns. Verified on nginx 1.31.7 with
        // /api and /: /api/things/42 → api /things/42, /x/api/y → web /y.
        function routeRewrite(p, rewrite, ctx, others) {
            let rules = rewrite.rules;
            if (rules.length !== 1) {
                ctx.note('path-rewrite', 'path-rewrite has ' + rules.length + ' rules, which HAProxy applies in turn; a route rewrites once. The first rule is migrated; fold the others into it by hand.', 'warning');
            }
            let r = rules[0];
            let base = p.pathType === 'Exact' ? escapeRe(p.path) + '$'
                : p.path === '/' ? '/' : escapeRe(p.path.replace(/\/$/, '')) + '(?:/|$)';
            let longer = (others || []).filter(function(o) { return o.pathType !== 'Exact' && o.path !== p.path && o.path.replace(/\/$/, '').indexOf(p.path.replace(/\/$/, '')) === 0 && o.path.length > p.path.length; });
            let exclude = longer.length ? '(?!' + longer.map(function(o) { return escapeRe(o.path.replace(/\/$/, '')) + '(?:/|$)'; }).join('|') + ')' : '';
            // "/" matches every path: no lookahead of its own.
            let guard = (p.path === '/' && p.pathType !== 'Exact' ? '' : '(?=' + base + ')') + exclude;
            if (r.re === '(.*)') return [{ path: '~ ^' + guard + '.*', rewritePath: r.to, rewritten: true }];
            // HAProxy's captures shift by none: the lookahead captures nothing.
            if (/\$\{|"|\\$/.test(r.re) || /\$\d/.test(r.to) && /\(\?[^:=!]/.test(r.re)) {
                ctx.note('path-rewrite', 'The path-rewrite regex "' + r.re + '" cannot be placed in a VirtualServer route as it is; rewrite it by hand.', 'warning');
                return null;
            }
            return [
                { path: '~ ^' + guard + '.*?' + r.re, rewritePath: r.to, rewritten: true },
                { path: p.pathType === 'Exact' ? '=' + p.path : p.path, rewritten: false }
            ];
        }
        function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        // CRD-first: one VirtualServer per host.
        function buildCrd(model, resolved, f, ctx, options) {
            let docs = [];
            let comments = [];
            let used = {};
            let cls = targetClass(model, options);
            f.policies.forEach(function(p) { docs.push(policyDoc(p, model)); comments.push(prefixComments(p.comments, '')); });
            // A per-route Policy (access control with denies first) goes on
            // every route, where it renders after the route's own snippets;
            // the rest stay in spec.policies.
            let policyRefs = f.policies.filter(function(p) { return !p.perRoute; }).map(function(p) { return { name: p.name }; });
            let routePolicies = f.policies.filter(function(p) { return p.perRoute; });
            if (!model.hosts.length) ctx.note('host', 'This Ingress has no rule with a host, and a VirtualServer needs one. Add a host, or keep the Ingress (annotation-first).', 'warning');
            if (Object.keys(f.ann).length) {
                // A setting that became only an annotation has no VirtualServer field.
                Object.keys(f.ann).forEach(function(k) {
                    if (/^nginx\.org\/(basic-auth|limit-req|proxy-set-headers|add-header|proxy-hide-headers|upstream-vhost|lb-method|proxy-http-version|max-fails|max-conns|proxy-(read|send)-timeout|sticky-cookie-services)/.test(k)) return;
                    ctx.note((ctx.annComments[k] || k).split(' ')[0], k + ' has no VirtualServer form; keep an Ingress for it (annotation-first).', 'warning');
                });
            }
            let canaryServices = f.canary.map(function(c) { return c.service; });
            model.hosts.forEach(function(h) {
                let spec = {};
                let c = {};
                if (cls) spec.ingressClassName = cls;
                spec.host = h.host;
                let tlsRedirect = f.tlsRedirect;
                if (h.tlsSecret !== null && h.tlsSecret !== undefined) {
                    spec.tls = {};
                    if (h.tlsSecret) spec.tls.secret = h.tlsSecret;
                    else ctx.note('tls', 'Host ' + h.host + ' is in spec.tls without a secretName; NGINX Ingress Controller then serves it only with a -wildcard-tls-secret.');
                    c['spec.tls'] = 'spec.tls';
                    // HAProxy turns the redirect on by itself when the Ingress has TLS.
                    if (tlsRedirect !== false) {
                        let r = tlsRedirect || { code: 302, codeSource: 'the HAProxy default 302', source: null };
                        spec.tls.redirect = { enable: true, code: r.code };
                        c['spec.tls.redirect'] = r.source || 'ssl-redirect (HAProxy default with TLS)';
                        c['spec.tls.redirect.code'] = r.codeSource;
                    }
                } else if (tlsRedirect && tlsRedirect.explicit) {
                    // ssl-redirect on a host without TLS: TLS ends in front.
                    spec.tls = { redirect: { enable: true, code: tlsRedirect.code } };
                    c['spec.tls.redirect'] = tlsRedirect.source + ' — no secret: TLS ends in front of the controller';
                    c['spec.tls.redirect.code'] = tlsRedirect.codeSource;
                    ctx.note('ssl-redirect', 'Host ' + h.host + ' has no TLS on the Ingress. The VirtualServer redirects every plain-HTTP request, as HAProxy did; if TLS ends at a load balancer in front, set tls.redirect.basedOn: x-forwarded-proto or the redirect loops.', 'warning');
                } else if (tlsRedirect !== false && model.tls.length) {
                    // httpsRedirect.go turns the redirect on for the whole
                    // Ingress once any of its hosts has TLS.
                    ctx.note('ssl-redirect', 'HAProxy redirected ' + h.host + ' to HTTPS too, since the Ingress has TLS for another host, and served it there with its default certificate. The VirtualServer for ' + h.host + ' has no TLS, so it does not redirect: add the host to a TLS entry, or set ssl-redirect: "false" to keep it on HTTP.', 'warning');
                }
                if (policyRefs.length) { spec.policies = policyRefs.slice(); c['spec.policies'] = 'the Policies above'; }
                if (f.policies.some(function(p) { return p.needsTls; }) && !(spec.tls && spec.tls.secret)) ctx.note('client-ca', 'Host ' + h.host + ' does not terminate TLS, so NGINX Ingress Controller answers every request with 500 for the ingressMTLS Policy. Add TLS for it.', 'warning');
                if (f.server.length) { spec['server-snippets'] = snippetBlock(f.server); c['spec.server-snippets'] = snippetSourcesFor(f.server, ctx); }

                let upstreams = [];
                let taken = {};
                let routes = [];
                // A route-acl Service's rule carries only HAProxy's custom route
                // (route.go AddCustomRoute adds no map entry for it). Where
                // another backend serves the same path, that backend is the
                // route and the canary its matches or split; where none does,
                // the route answers 404 — HAProxy's default backend — unless
                // the ACL sends the request to the canary.
                let isCanary = function(p) { return p.backend && canaryServices.indexOf(p.backend.service) !== -1; };
                let paths = h.paths.filter(function(p) { return !isCanary(p); });
                h.paths.filter(isCanary).forEach(function(cp) {
                    if (!paths.some(function(p) { return p.path === cp.path; })) paths.push({ path: cp.path, pathType: cp.pathType, backend: null, canaryOnly: cp });
                });
                let rewritten = [];
                paths.forEach(function(p) {
                    let rws = f.rewrite ? routeRewrite(p, f.rewrite, ctx, paths) : null;
                    if (!rws) { rewritten.push({ p: p, rw: null }); return; }
                    rws.forEach(function(rw) { rewritten.push({ p: p, rw: rw.rewritten ? rw : null, plain: rw.rewritten ? null : rw.path }); });
                });
                // NGINX tries regex locations in order and takes the first match,
                // ahead of any prefix: longest Ingress path first, so "/" does
                // not take /api's requests.
                if (f.rewrite) rewritten.sort(function(x, y) { return (y.rw ? 1 : 0) - (x.rw ? 1 : 0) || y.p.path.length - x.p.path.length; });
                let addUpstream = function(service, port, where) {
                    let up = upstreamName(service, port, taken);
                    if (!upstreams.some(function(u) { return u.name === up; })) {
                        let u = { name: up, service: service, port: upstreamPort(port, ctx, where) };
                        Object.keys(f.upstream).forEach(function(k) { u[k] = f.upstream[k]; });
                        Object.keys(f.svc[service] || {}).forEach(function(k) { u[k] = f.svc[service][k].value; });
                        upstreams.push(u);
                    }
                    return up;
                };
                rewritten.forEach(function(item) {
                    let p = item.p;
                    if (!p.canaryOnly && (!p.backend || p.backend.resource)) { ctx.note('backend', 'Path ' + p.path + ' on ' + h.host + ' has a resource backend, which a VirtualServer cannot route to; it is skipped.', 'warning'); return; }
                    let up = p.canaryOnly ? null : addUpstream(p.backend.service, p.backend.port, 'spec.upstreams.' + upstreams.length + '.port');
                    let route = { path: item.rw ? item.rw.path : item.plain || (p.pathType === 'Exact' ? '=' + p.path : p.path) };
                    let ri = routes.length;
                    let action;
                    if (f.redirect) {
                        action = { redirect: { url: f.redirect.url, code: f.redirect.code } };
                        c['spec.routes.' + ri + '.action.redirect.url'] = f.redirect.source;
                        c['spec.routes.' + ri + '.action.redirect.code'] = f.redirect.codeSource;
                    } else if (p.canaryOnly) {
                        action = { return: { code: 404, type: 'text/plain', body: 'Not Found' } };
                        c['spec.routes.' + ri + '.action'] = 'no backend but the route-acl Service: HAProxy answers 404 otherwise';
                    } else {
                        let proxy = Object.assign({}, f.proxy);
                        if (item.rw) proxy.rewritePath = item.rw.rewritePath;
                        if (Object.keys(proxy).length) {
                            action = { proxy: Object.assign({ upstream: up }, proxy) };
                            if (item.rw) { c['spec.routes.' + ri + '.path'] = f.rewrite.source + ' (its regex)'; c['spec.routes.' + ri + '.action.proxy.rewritePath'] = f.rewrite.source; }
                            if (proxy.requestHeaders) c['spec.routes.' + ri + '.action.proxy.requestHeaders'] = f.requestHeaderSources;
                            if (proxy.responseHeaders) c['spec.routes.' + ri + '.action.proxy.responseHeaders'] = f.responseHeaderNote;
                        } else {
                            action = { pass: up };
                        }
                    }
                    // route-acl canaries on this host: splits and matches.
                    // A leg applies under its own rule's path ({ path -m beg }
                    // in AddCustomRoute): to this route when the route's path
                    // lies under it.
                    let under = function(cp) { return cp.path === '/' || p.path === cp.path || p.path.indexOf(cp.path.replace(/\/$/, '') + '/') === 0; };
                    let legs = f.canary.filter(function(cn) { return h.paths.some(function(x) { return x.backend && x.backend.service === cn.service && under(x); }); });
                    if (legs.length && !f.redirect) {
                        let matches = [];
                        let splitLeg = null;
                        legs.forEach(function(cn) {
                            let cp = h.paths.find(function(x) { return x.backend && x.backend.service === cn.service && under(x); });
                            let cup = addUpstream(cn.service, cp.backend.port, 'spec.upstreams.' + upstreams.length + '.port');
                            if (cn.match) matches.push({ conditions: [matchCondition(cn.match)], action: { pass: cup }, source: cn.source, found: cn.match.value === null });
                            else if (!splitLeg) splitLeg = { up: cup, pct: cn.split, source: cn.source };
                        });
                        if (matches.length) {
                            route.matches = matches.map(function(m) { return { conditions: m.conditions, action: m.action }; });
                            c['spec.routes.' + ri + '.matches'] = matches.map(function(m) { return m.source; }).join(' + ');
                            if (matches.some(function(m) { return m.found; })) ctx.note('route-acl', '-m found matches a cookie or header that is present, even empty; the VirtualServer condition value "!" matches a non-empty one only.');
                        }
                        if (splitLeg && splitLeg.pct > 0 && splitLeg.pct < 100) {
                            route.splits = [{ weight: 100 - splitLeg.pct, action: action }, { weight: splitLeg.pct, action: { pass: splitLeg.up } }];
                            c['spec.routes.' + ri + '.splits'] = splitLeg.source;
                        } else if (splitLeg && splitLeg.pct >= 100) {
                            route.action = { pass: splitLeg.up };
                            c['spec.routes.' + ri + '.action'] = splitLeg.source + ' — every request';
                        }
                        if (!route.splits && !route.action) route.action = action;
                        if (legs.length > 1) ctx.note('route-acl', 'Several route-acl Services share host ' + h.host + '. HAProxy tries them in config order and takes the first match; check that the matches and the split keep that order.', 'warning');
                        if (h.paths.length > 2 || model.hosts.length > 1) ctx.note('route-acl', 'HAProxy applied the route-acl of Service ' + legs.map(function(l) { return l.service; }).join(', ') + ' to every request for the host under its path, ahead of the other paths; each route on ' + h.host + ' now carries it.');
                    } else {
                        route.action = action;
                    }
                    // The route Policy's denies first, then the other snippet
                    // lines: NGINX takes the first allow or deny that matches.
                    let denies = [].concat.apply([], routePolicies.map(function(p) { return p.denyFirst.map(function(d) { return 'deny ' + d + ';'; }); }));
                    let lines = denies.concat(f.location);
                    if (lines.length) {
                        route['location-snippets'] = snippetBlock(lines);
                        c['spec.routes.' + ri + '.location-snippets'] = [routePolicies.length ? routePolicies[0].denySource + ' — checked before the route Policy\'s allow list' : null, snippetSourcesFor(f.location, ctx)].filter(Boolean).join(' + ');
                    }
                    if (routePolicies.length) { route.policies = routePolicies.map(function(p) { return { name: p.name }; }); c['spec.routes.' + ri + '.policies'] = 'the route Policy above: it renders after the snippet, so the denies come first'; }
                    let ordered = { path: route.path };
                    ['policies', 'location-snippets', 'matches', 'splits', 'action'].forEach(function(k) { if (route[k] !== undefined) ordered[k] = route[k]; });
                    routes.push(ordered);
                });
                if (!routes.length) { ctx.note('host', 'Host ' + h.host + ' has no routable path; no VirtualServer is emitted for it.', 'warning'); return; }
                // request-redirect answers every request of the host, so no
                // route passes to an upstream: none is declared.
                let referenced = JSON.stringify(routes);
                upstreams = upstreams.filter(function(u) { return referenced.indexOf('"' + u.name + '"') !== -1; });
                if (upstreams.length) spec.upstreams = upstreams;
                spec.routes = routes;
                upstreams.forEach(function(u, ui) {
                    Object.keys(f.upstreamComments).forEach(function(k) { if (u[k] !== undefined) c['spec.upstreams.' + ui + '.' + k] = f.upstreamComments[k]; });
                    Object.keys(f.svc[u.service] || {}).forEach(function(k) { c['spec.upstreams.' + ui + '.' + k] = f.svc[u.service][k].comment; });
                });
                let md = { name: resourceName(model, h.host, options, used) };
                if (model.namespace) md.namespace = model.namespace;
                docs.push({ apiVersion: NIC_API, kind: 'VirtualServer', metadata: md, spec: spec });
                comments.push(c);
            });
            if (model.hostless.length) ctx.note('host', model.hostless.length + ' path(s) belong to a rule with no host; a VirtualServer needs a host, so they are not migrated.', 'warning');
            if (model.defaultBackend) ctx.note('default-backend', 'spec.defaultBackend has no VirtualServer equivalent; requests for unknown paths get 404. Keep an Ingress for it, or add a catch-all route.', 'warning');
            if (f.policies.some(function(p) { return p.plus; })) ctx.note('modsecurity', 'The waf Policy needs NGINX Plus with F5 WAF for NGINX.', 'warning');
            return { docs: docs, comments: comments };
        }

        // TLS passthrough: a TransportServer per host on the built-in listener.
        function buildPassthrough(model, f, ctx, options) {
            let docs = [];
            let used = {};
            let cls = targetClass(model, options);
            model.hosts.forEach(function(h) {
                let p = h.paths.find(function(x) { return x.backend && x.backend.service; });
                if (!p) return;
                let md = { name: resourceName(model, h.host, options, used) };
                if (model.namespace) md.namespace = model.namespace;
                let spec = {};
                if (cls) spec.ingressClassName = cls;
                spec.listener = { name: 'tls-passthrough', protocol: 'TLS_PASSTHROUGH' };
                spec.host = h.host;
                spec.upstreams = [{ name: dnsName(p.backend.service), service: p.backend.service, port: upstreamPort(p.backend.port, ctx, 'spec.upstreams.0.port') }];
                spec.action = { pass: dnsName(p.backend.service) };
                docs.push({ apiVersion: NIC_API, kind: 'TransportServer', metadata: md, spec: spec });
            });
            ctx.note('ssl-passthrough', 'TLS passthrough is off by default in NGINX Ingress Controller: install with controller.enableTLSPassthrough=true (Helm) or -enable-tls-passthrough. As with HAProxy, the HTTP settings on this Ingress stop applying to it.', 'warning');
            if (ctx.strategy === 'annotation') ctx.note('ssl-passthrough', 'TLS passthrough has no Ingress form in NGINX Ingress Controller; it is a TransportServer under either strategy.');
            // HAProxy hands the TLS stream to the backend; nothing HTTP applies.
            let idle = Object.keys(f.seen || {}).filter(function(k) { return k !== 'ssl-passthrough'; });
            if (idle.length) ctx.note('ssl-passthrough', 'Not migrated, because they never applied to passthrough traffic: ' + idle.join(', ') + '.');
            idle.forEach(function(k) { ctx.consumed[k] = true; ctx.passthroughIdle = true; });
            return { docs: docs, comments: docs.map(function() { return { 'spec.listener': src(f.passthrough, 'ssl-passthrough') }; }) };
        }

        // Annotation-first: the Ingress, every rule and TLS entry kept.
        function buildIngress(model, resolved, f, ctx, options) {
            let docs = [];
            let comments = [];
            // An access-control Policy whose denies must come first cannot be
            // an Ingress Policy: nginx.org/policies renders its allow list at
            // server level, and the location snippet that would hold the
            // denies stops the location inheriting it. The whole ordered list
            // becomes the snippet instead.
            let aclSnippet = [];
            f.policies.filter(function(p) { return p.perRoute && p.onIngress; }).forEach(function(p) {
                p.denyFirst.forEach(function(d) { aclSnippet.push('deny ' + d + ';'); });
                p.spec.accessControl.allow.forEach(function(al) { aclSnippet.push('allow ' + al + ';'); });
                aclSnippet.push('deny all;');
                aclSnippet.forEach(function(l) { ctx.snippetSource(l, p.denySource + ' + ' + (p.comments['spec.accessControl.allow'] || 'allow-list') + ' (ordered: denies first)'); });
            });
            let ingressPolicies = f.policies.filter(function(p) { return p.onIngress && !p.perRoute; });
            ingressPolicies.forEach(function(p) { docs.push(policyDoc(p, model)); comments.push(prefixComments(p.comments, '')); });
            f.policies.filter(function(p) { return !p.onIngress; }).forEach(function(p) {
                ctx.note(Object.keys(p.spec)[0], 'A ' + Object.keys(p.spec)[0] + ' Policy cannot be referenced from an Ingress in NGINX Ingress Controller ' + MigrationTool.NIC.VERSION + '; switch the strategy to CRD-first to use it.', 'warning');
            });
            let ann = {};
            let annComments = {};
            Object.keys(model.annotations).forEach(function(k) {
                if (haproxySuffix(k) !== null || k === 'kubernetes.io/ingress.class') return;
                ann[k] = str(model.annotations[k]);
            });
            Object.keys(f.ann).forEach(function(k) { ann[k] = f.ann[k]; annComments[k] = ctx.annComments[k] || null; });
            // Per-Service backend values: annotations are per Ingress, except the
            // service lists (ssl-services, sticky-cookie-services).
            Object.keys(f.annSvc || {}).forEach(function(k) {
                let bySvc = f.annSvc[k];
                let svcs = Object.keys(bySvc);
                if (k === 'nginx.org/sticky-cookie-services') {
                    ann[k] = svcs.map(function(s) { return 'serviceName=' + s + ' ' + bySvc[s].value; }).join(';');
                    annComments[k] = svcs.map(function(s) { return bySvc[s].comment; }).join(' + ');
                    return;
                }
                ctx.note(k, 'HAProxy applied ' + bySvc[svcs[0]].comment.split(' ')[0] + ' to Service ' + svcs.join(', ') + ' only; ' + k + ' applies to every backend of the Ingress, so it is not set. Switch the strategy to CRD-first for the per-upstream field.', 'warning');
            });
            if (ann['nginx.org/sticky-cookie-services'] && !/serviceName=/.test(ann['nginx.org/sticky-cookie-services'])) {
                ann['nginx.org/sticky-cookie-services'] = resolved.services.map(function(s) { return 'serviceName=' + s + ' ' + f.ann['nginx.org/sticky-cookie-services']; }).join(';');
            }
            if (f.sslServices && f.sslServices.length) { ann['nginx.org/ssl-services'] = f.sslServices.join(','); annComments['nginx.org/ssl-services'] = f.sslSource; }
            let refs = ingressPolicies.filter(function(p) { return !p.plus; }).map(function(p) { return p.name; });
            let plusRefs = ingressPolicies.filter(function(p) { return p.plus; }).map(function(p) { return p.name; });
            if (refs.length) { ann['nginx.org/policies'] = refs.join(','); annComments['nginx.org/policies'] = 'the Policies above'; }
            if (plusRefs.length) { ann['nginx.com/policies'] = plusRefs.join(','); annComments['nginx.com/policies'] = 'the NGINX Plus Policies above'; }
            let locLines = aclSnippet.concat(f.location);
            if (locLines.length) { ann['nginx.org/location-snippets'] = snippetBlock(locLines); annComments['nginx.org/location-snippets'] = snippetSourcesFor(locLines, ctx); }
            if (f.server.length) { ann['nginx.org/server-snippets'] = snippetBlock(f.server); annComments['nginx.org/server-snippets'] = snippetSourcesFor(f.server, ctx); }
            if (f.rewrite) {
                // Without nginx.org/path-regex, NGINX Ingress Controller renders
                // rewrite "<path>" <target> break: every request of a prefix
                // location contains its path, so the whole path is replaced —
                // HAProxy's one-field form (verified on nginx 1.31.7). The
                // two-field form searches for its own regex, which a rule path
                // cannot express, so it stays a CRD-first route.
                let r = f.rewrite.rules[0];
                if (f.rewrite.rules.length > 1) ctx.note('path-rewrite', 'path-rewrite has ' + f.rewrite.rules.length + ' rules; nginx.org/rewrite-target holds one. The first is migrated.', 'warning');
                if (r.re === '(.*)' && !/\$\d/.test(r.to)) {
                    ann['nginx.org/rewrite-target'] = r.to; annComments['nginx.org/rewrite-target'] = f.rewrite.source + ' — replaces the whole path';
                } else {
                    ctx.note('path-rewrite', 'path-rewrite "' + r.raw + '" rewrites only the paths its regex finds, keeping the captures; nginx.org/rewrite-target captures from the Ingress rule path instead. Switch the strategy to CRD-first, which emits a regex route for it.', 'warning');
                }
            }
            // HAProxy redirects plain HTTP with 302 when the Ingress has TLS, or
            // with ssl-redirect; NGINX Ingress Controller with 301 by default.
            if (f.tlsRedirect === false) {
                if (model.tls.length) { ann['nginx.org/ssl-redirect'] = 'false'; annComments['nginx.org/ssl-redirect'] = 'ssl-redirect (off: HAProxy did not redirect)'; }
            } else if (model.tls.length || (f.tlsRedirect && f.tlsRedirect.explicit)) {
                let r = f.tlsRedirect || { code: 302, codeSource: 'the HAProxy default 302' };
                if (!model.tls.length) {
                    ann['nginx.org/redirect-to-https'] = 'true'; annComments['nginx.org/redirect-to-https'] = r.source;
                    ctx.note('ssl-redirect', 'This Ingress has no TLS, so TLS ends in front of the controller: nginx.org/redirect-to-https redirects on X-Forwarded-Proto. NGINX Ingress Controller would send 301 by default; the HAProxy code is kept.');
                } else if (r.source) {
                    // On by default with TLS on both controllers; set, it stays visible.
                    ann['nginx.org/ssl-redirect'] = 'true'; annComments['nginx.org/ssl-redirect'] = r.source;
                }
                ann['nginx.org/http-redirect-code'] = String(r.code); annComments['nginx.org/http-redirect-code'] = r.codeSource;
            }
            if (f.redirect) ctx.note('request-redirect', 'A redirect has no Ingress annotation; switch the strategy to CRD-first, which emits a VirtualServer redirect.', 'warning');
            if (f.canary.length) ctx.note('route-acl', 'Traffic splitting and matches have no Ingress annotation; switch the strategy to CRD-first, which emits VirtualServer splits and matches.', 'warning');
            if (f.upstream.healthCheck || Object.keys(f.svc).some(function(s) { return f.svc[s].healthCheck; })) ctx.note('check-http', 'Active health checks on an Ingress are nginx.com/health-checks, NGINX Plus only, and probe "/" unless the Pod has a readiness probe; switch to CRD-first for the path and interval.', 'warning');
            let spec = JSON.parse(JSON.stringify(model.doc.spec || {}));
            let v1Backend = function(b) {
                if (!isMap(b) || b.service || !b.serviceName) return b;
                let port = /^\d+$/.test(str(b.servicePort)) ? { number: parseInt(b.servicePort, 10) } : { name: str(b.servicePort) };
                return { service: { name: str(b.serviceName), port: port } };
            };
            if (spec.backend && !spec.defaultBackend) { spec.defaultBackend = spec.backend; delete spec.backend; }
            if (spec.defaultBackend) spec.defaultBackend = v1Backend(spec.defaultBackend);
            let canaryServices = f.canary.map(function(c) { return c.service; });
            // A route-acl Service's own rule carried only HAProxy's custom route
            // (route.go AddCustomRoute adds no map entry for it); kept, it
            // would claim the path a second time, and NGINX refuses a duplicate
            // location. An Ingress cannot split, so the canary leg is dropped.
            let dropped = 0;
            (Array.isArray(spec.rules) ? spec.rules : []).forEach(function(r) {
                if (!isMap(r) || !isMap(r.http) || !Array.isArray(r.http.paths)) return;
                r.http.paths = r.http.paths.filter(function(p) {
                    let b = backendOf(p && p.backend);
                    if (b && canaryServices.indexOf(b.service) !== -1) { dropped++; return false; }
                    return true;
                });
                r.http.paths.forEach(function(p) { if (isMap(p)) { p.backend = v1Backend(p.backend); if (!p.pathType) p.pathType = 'ImplementationSpecific'; } });
            });
            if (dropped) ctx.note('route-acl', 'The rule for the canary Service ' + canaryServices.join(', ') + ' is left off the migrated Ingress: HAProxy used it only for the route-acl, and an Ingress cannot split traffic, so every request goes to the main backend. CRD-first keeps the split.', 'warning');
            let cls = targetClass(model, options);
            if (cls) spec.ingressClassName = cls; else delete spec.ingressClassName;
            let md = { name: dnsName((model.name || 'my-app') + (options.nameSuffix || '')) };
            if (model.namespace) md.namespace = model.namespace;
            if (Object.keys(ann).length) md.annotations = ann;
            if (model.apiVersion && model.apiVersion !== 'networking.k8s.io/v1') ctx.note('apiVersion', model.apiVersion + ' Ingresses no longer exist in Kubernetes 1.22+: the migrated Ingress is networking.k8s.io/v1.');
            let ing = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: md };
            if (Object.keys(spec).length) ing.spec = spec;
            let c = {};
            Object.keys(annComments).forEach(function(k) { if (annComments[k]) c['metadata.annotations.' + k] = annComments[k]; });
            docs.push(ing);
            comments.push(c);
            return { docs: docs, comments: comments };
        }

        // --- The controller pass ----------------------------------------------
        // What HAProxy applies to the whole controller: ConfigMap-only keys, the
        // Global/Defaults/Frontend CRs and TCP services. NGINX Ingress
        // Controller's counterparts are global too: nginx-config keys, a
        // GlobalConfiguration and TransportServers. A ConfigMap value of a
        // backend key whose NGINX Ingress Controller key is also global
        // (load-balance → lb-method) goes there rather than onto every upstream:
        // a VirtualServer inherits it (virtualserver.go, v5.7.0).

        function controllerCtx() {
            let g = { cmData: {}, cmComments: {}, notes: [], todos: [], docs: [], comments: [], sources: [], unsupported: [], unrecognised: [], consumed: {}, entries: [] };
            g.cm = function(key, value, comment) { g.cmData[key] = String(value); g.cmComments[key] = comment; };
            g.note = function(name, message, severity) { if (!g.notes.some(function(n) { return n.name === name && n.message === message; })) g.notes.push({ name: name, message: message, severity: severity || 'note' }); };
            g.todo = function(path, message) { g.todos.push({ path: path, message: message }); };
            g.use = function() { for (let i = 0; i < arguments.length; i++) g.consumed[arguments[i]] = true; };
            g.doc = function(doc, comments, source) { g.docs.push(doc); g.comments.push(comments || {}); g.sources.push(source); };
            return g;
        }

        // ConfigMap values HAProxy applies to every backend, whose NGINX Ingress
        // Controller key is global too.
        let CM_GLOBAL = {
            'load-balance': function(x, g) {
                let m = haproxyLbMethod(x.value);
                if (m.none) { g.note('load-balance', m.none, 'warning'); return; }
                if (m.invalid) { g.note('load-balance', m.invalid, 'warning'); }
                g.cm('lb-method', m.value, 'load-balance' + (m.invalid ? ' (invalid: HAProxy used roundrobin)' : m.note ? ' — ' + m.note : ''));
            },
            'timeout-server': function(x, g) {
                let t = haproxyTimeToNginx(x.value);
                if (!t) { invalidNote(g, 'timeout-server', x.value, 'an HAProxy time', 'kept its default 50s'); return; }
                g.cm('proxy-read-timeout', t.value, 'timeout-server' + (t.note ? ' — ' + t.note : ''));
                g.cm('proxy-send-timeout', t.value, 'timeout-server');
            },
            'check': function(x, g) {
                let on = haproxyBool(x.value);
                if (on === null) { invalidNote(g, 'check', x.value, 'a boolean', 'left health checks on'); return; }
                if (!on) { g.cm('max-fails', '0', 'check "' + x.value + '" — NGINX Ingress Controller marks a server failed after 1 error otherwise'); return; }
                g.note('check', 'HAProxy runs active probes. NGINX Ingress Controller on NGINX Open Source marks a server failed only when real requests fail (max-fails, default 1 in 10s), so an idle backend is never probed. Active probes are NGINX Plus (upstreams[].healthCheck).');
            }
        };

        // A ConfigMap time key: the NGINX time, or a note and nothing when
        // HAProxy's ParseTime fails (it logs and keeps its default, `dflt`).
        function cmTime(g, name, x, dflt) {
            let t = haproxyTimeToNginx(x.value);
            if (!t) invalidNote(g, name, x.value, 'an HAProxy time', 'kept its default ' + dflt);
            return t;
        }

        // ConfigMap-only keys (CONFIGMAP_CANONICAL), and the translators that
        // write global keys from wherever HAProxy read them.
        let CONTROLLER = {
            // proxy-protocol.go: the addresses HAProxy takes the header from;
            // one it cannot parse is logged and skipped.
            'proxy-protocol': function(x, g) {
                let pattern = isPatternFileRef(x.value);
                let list = pattern ? [] : splitCommaList(x.value);
                let bad = list.filter(function(s) { return !isAddress(s); });
                let good = list.filter(function(s) { return isAddress(s); });
                if (bad.length) g.note('proxy-protocol', 'proxy-protocol holds "' + bad.join('", "') + '", which is not an IP address or CIDR, so HAProxy logged an error and left it out.', 'warning');
                if (!pattern && !good.length) { g.note('proxy-protocol', 'No address in proxy-protocol was valid, so HAProxy expected the PROXY header from no one; nothing is migrated.', 'warning'); return; }
                g.cm('proxy-protocol', 'true', 'proxy-protocol (inbound PROXY header)');
                g.cm('set-real-ip-from', pattern ? '0.0.0.0/0' : good.join(','), 'proxy-protocol — the addresses HAProxy accepted it from');
                if (pattern) g.todo('configmap.set-real-ip-from', 'inline the CIDRs from the patterns/ file ' + x.value);
                g.cm('real-ip-header', 'proxy_protocol', 'proxy-protocol');
                g.note('proxy-protocol', 'NGINX Ingress Controller accepts the PROXY protocol on every listener and requires it on every connection; HAProxy accepted it only from the listed addresses.', 'warning');
            },
            // syslogServer.go: one target per line, "key:value" pairs; a line
            // without an address, or a pair it does not know, is an error that
            // drops the targets. NGINX Ingress Controller sends to one server.
            'syslog-server': function(x, g) {
                let lines = str(x.value).split('\n').filter(function(l) { return l.trim() !== ''; });
                let targets = [], bad = null;
                lines.forEach(function(line) {
                    let fields = {};
                    line.replace(/\s+/g, '').split(',').filter(Boolean).forEach(function(part) {
                        let kv = part.split(':');
                        if (kv.length !== 2) bad = bad || 'the parameter "' + part + '" is not key:value';
                        else if (['address', 'port', 'length', 'format', 'facility', 'level', 'minlevel'].indexOf(kv[0].toLowerCase()) === -1) bad = bad || 'it does not know the parameter "' + kv[0] + '"';
                        else fields[kv[0].toLowerCase()] = kv[1];
                    });
                    if (!fields.address) bad = bad || 'a line has no address';
                    targets.push(fields);
                });
                if (bad || !targets.length) { g.note('syslog-server', 'syslog-server is not valid for HAProxy (' + (bad || 'it is empty') + '), so HAProxy logged an error and logged to its default target, 127.0.0.1. Nothing is migrated.', 'warning'); return; }
                let t = targets[0];
                if (t.address.toLowerCase() === 'stdout') { g.note('syslog-server', 'HAProxy logs to stdout, which is the NGINX Ingress Controller default too; nothing to migrate.'); return; }
                if (targets.length > 1) g.note('syslog-server', 'HAProxy sent its log to ' + targets.length + ' targets; NGINX Ingress Controller sends the access log to one, so only the first is migrated.', 'warning');
                let dest = 'syslog:server=' + t.address + (t.port ? ':' + t.port : '');
                if (t.facility) dest += ',facility=' + t.facility;
                if (t.level) { let l = t.level.toLowerCase(); dest += ',severity=' + (l === 'err' ? 'error' : l === 'warning' ? 'warn' : l); }
                g.cm('access-log', dest, 'syslog-server (NGINX Ingress Controller reads only values that start with syslog:)');
                g.note('syslog-server', 'Only the access log can go to syslog, to one server; the error log stays on stderr (error-log-level sets its level).');
            },
            'log-format': function(x, g) {
                g.cm('log-format', LOG_FORMAT_HTTP, 'TODO: log-format, in NGINX variables');
                g.todo('configmap.log-format', 'rewrite the HAProxy log-format "' + x.value + '" with NGINX variables (%ci is $remote_addr, %ST is $status, %Tr is $upstream_response_time)');
            },
            'log-format-tcp': function(x, g) {
                g.cm('stream-log-format', LOG_FORMAT_TCP, 'TODO: log-format-tcp');
                g.todo('configmap.stream-log-format', 'rewrite the HAProxy log-format-tcp "' + x.value + '" with NGINX stream variables');
            },
            'dontlognull': function(x, g) { g.note('dontlognull', 'Nothing to migrate: the NGINX access log records requests, so a connection that sends none is not logged.'); },
            'logasap': function(x, g) { g.note('logasap', 'No equivalent: NGINX writes the access-log entry when the request completes, so a long transfer logs late.'); },
            // timeout.go: ParseTime; an error is logged and the defaults
            // section keeps the controller's own value (env.SetDefaults).
            'timeout-connect': function(x, g) { let t = cmTime(g, 'timeout-connect', x, '5s'); if (t) g.cm('proxy-connect-timeout', t.value, 'timeout-connect' + (t.note ? ' — ' + t.note : '')); },
            'timeout-http-keep-alive': function(x, g) { let t = cmTime(g, 'timeout-http-keep-alive', x, '1m'); if (t) g.cm('keepalive-timeout', t.value, 'timeout-http-keep-alive — the client idle timeout' + (t.note ? '; ' + t.note : '')); },
            'timeout-tunnel': function(x, g) {
                let t = cmTime(g, 'timeout-tunnel', x, '1h');
                if (!t) return;
                g.cm('proxy-read-timeout', t.value, 'timeout-tunnel — NGINX has no tunnel-only timeout, so this raises it for all upstream traffic');
                g.cm('proxy-send-timeout', t.value, 'timeout-tunnel');
                g.note('timeout-tunnel', 'NGINX has no separate timeout for WebSocket and other upgraded connections; the proxy timeouts cover them, and every other request too. A VirtualServer upgrades WebSocket by itself; an Ingress needs nginx.org/websocket-services naming the Service.', 'warning');
            },
            // http-snippets reach nginx.conf unchecked: only a time NGINX
            // parses may go in, or the reload fails for every resource.
            'timeout-client': function(x, g) {
                let t = cmTime(g, 'timeout-client', x, '50s');
                if (!t) return;
                g.http('client_body_timeout ' + t.value + ';', 'timeout-client'); g.http('client_header_timeout ' + t.value + ';', 'timeout-client'); g.http('send_timeout ' + t.value + ';', 'timeout-client');
                g.note('timeout-client', 'NGINX Ingress Controller has no ConfigMap key for client-side timeouts; http-snippets sets client_body_timeout, client_header_timeout and send_timeout.');
            },
            'timeout-http-request': function(x, g) {
                let t = cmTime(g, 'timeout-http-request', x, '5s');
                if (!t) return;
                g.http('client_header_timeout ' + t.value + ';', 'timeout-http-request');
                g.note('timeout-http-request', 'client_header_timeout (http-snippets) is the closest NGINX directive: it bounds reading the request headers, where HAProxy bounded the whole request.');
            },
            'timeout-queue': function(x, g) { g.note('timeout-queue', 'Request queueing is NGINX Plus only (VirtualServer upstreams[].queue with max-conns); NGINX Open Source answers at once instead of queueing.', 'warning'); },
            'http-connection-mode': function(x, g) { connectionMode(x.value, g); },
            // connectionMode.go reads the deprecated aliases only when
            // http-connection-mode is unset, with GetBoolValue.
            'http-keep-alive': function(x, g, run) { aliasMode('http-keep-alive', x, g, run); },
            'http-server-close': function(x, g, run) { aliasMode('http-server-close', x, g, run); },
            // maxconn.go / nbthread.go: Atoi; an error is logged and leaves
            // HAProxy's own default (no maxconn, a thread per CPU).
            'maxconn': function(x, g) {
                let n = haproxyInt(x.value);
                if (n === null || n < 0) { invalidNote(g, 'maxconn', x.value, 'a whole number', 'set no global maxconn'); return; }
                g.cm('worker-connections', String(n), 'maxconn — per worker in NGINX (HAProxy counts the whole process): divide by worker-processes');
            },
            'nbthread': function(x, g) {
                let n = haproxyInt(x.value);
                if (n === null || n < 1) { invalidNote(g, 'nbthread', x.value, 'a thread count', 'ran a thread per CPU'); return; }
                g.cm('worker-processes', String(n), 'nbthread — NGINX scales with processes, not threads');
            },
            'hard-stop-after': function(x, g) { let t = cmTime(g, 'hard-stop-after', x, '30m'); if (t) g.cm('worker-shutdown-timeout', t.value, 'hard-stop-after — how long an old worker may drain after a reload'); },
            'global-config-snippet': function(x, g) {
                let left = [];
                str(x.value).split('\n').map(function(l) { return l.trim(); }).filter(Boolean).forEach(function(l) {
                    let m;
                    if ((m = l.match(/^ssl-default-bind-ciphers\s+(.+)$/i))) g.cm('ssl-ciphers', m[1], 'global-config-snippet ssl-default-bind-ciphers');
                    else if ((m = l.match(/^ssl-default-bind-options\s+(.+)$/i))) { g.cm('ssl-protocols', 'TLSv1.2 TLSv1.3', 'global-config-snippet ssl-default-bind-options — TODO: derive the protocols from "' + m[1] + '"'); g.todo('configmap.ssl-protocols', 'derive the protocols from "' + m[1] + '"'); }
                    else left.push(l);
                });
                if (left.length) { g.cm('main-snippets', left.map(function(l) { return '# TODO rewrite as NGINX: ' + l; }).join('\n') + '\n', 'global-config-snippet — HAProxy directives are not NGINX directives'); g.todo('configmap.main-snippets', 'rewrite each global-config-snippet line as an NGINX directive'); }
            },
            'frontend-config-snippet': function(x, g) {
                g.cm('server-snippets', str(x.value).split('\n').map(function(l) { return l.trim(); }).filter(Boolean).map(function(l) { return '# TODO rewrite as NGINX: ' + l; }).join('\n') + '\n', 'frontend-config-snippet — every server block');
                g.todo('configmap.server-snippets', 'rewrite each frontend-config-snippet line as an NGINX directive, or as a Policy or VirtualServer match');
            },
            'stats-config-snippet': function(x, g) { g.note('stats-config-snippet', 'NGINX Ingress Controller has no stats frontend. Scrape its Prometheus metrics (-enable-prometheus-metrics, port 9113) instead; the live dashboard is NGINX Plus.'); },
            'client-strict-sni': function(x, g) { TRANSLATORS.clientStrictSni({ 'client-strict-sni': x }, null, g); },
            'ssl-certificate': function(x, g) { g.note('ssl-certificate', 'The default certificate is a controller flag in NGINX Ingress Controller: -default-server-tls-secret ' + x.value + ' (and -wildcard-tls-secret for a per-host fallback). Each host\'s own certificate stays on its spec.tls.', 'warning'); },
            'tls-alpn': function(x, g) {
                let protos = splitCommaList(x.value).map(function(p) { return p.toLowerCase(); });
                if (protos.indexOf('h2') !== -1) g.cm('http2', 'true', 'tls-alpn lists h2 (HAProxy offers h2 by default; NGINX Ingress Controller has HTTP/2 off)');
                else g.note('tls-alpn', 'This ALPN list leaves out h2, which matches the NGINX Ingress Controller default (HTTP/2 off).');
                g.note('tls-alpn', 'NGINX Ingress Controller controls only whether HTTP/2 is offered (the http2 key, or per host nginx.org/http2 and VirtualServer spec.http2); any other ALPN list cannot be reproduced.');
            },
            'clean-certs': function(x, g) { g.note('clean-certs', 'NGINX Ingress Controller loads certificates from Secrets and manages its own files. Remove.'); },
            'src-ip-header': function(x, g) { TRANSLATORS.srcIpHeader({ 'src-ip-header': x }, null, g); },
            'forwarded-for': function(x, g) { TRANSLATORS.forwardedFor({ 'forwarded-for': x }, null, g); },
            // Applied per Ingress by resolve() (PER_RESOURCE_CM); with no
            // Ingress in the paste, the Policy each host will need is named.
            'client-ca': function(x, g, run) {
                if (run.ingresses.length) return;
                g.note('client-ca', 'HAProxy verifies client certificates for every HTTPS host from the ConfigMap; NGINX Ingress Controller needs an ingressMTLS Policy (clientCertSecret ' + str(x.value).replace(/^[^/]+\//, '') + ', the CA under ca.crt) referenced by each host. Paste the Ingresses with the ConfigMap and the analyzer adds it to each.', 'warning');
            },
            'client-crt-optional': function(x, g, run) {
                if (run.ingresses.length) return;
                g.note('client-crt-optional', 'client-crt-optional sets the ingressMTLS verifyClient (' + (str(x.value) === 'true' ? 'optional' : 'on: HAProxy relaxes it only for the exact value "true"') + ') of the Policy each host references.');
            }
        };

        // connectionMode.go: one of three modes; anything else is logged and
        // the defaults keep http-keep-alive (env.SetDefaults).
        function connectionMode(mode, g, source) {
            let from = source || 'http-connection-mode';
            if (mode === 'http-keep-alive') g.cm('keepalive', '64', from + ' http-keep-alive — idle upstream connections per worker; NGINX Ingress Controller leaves this 0, which closes each VirtualServer upstream connection');
            else if (mode === 'httpclose') g.cm('keepalive-timeout', '0', from + ' httpclose');
            else if (mode === 'http-server-close') g.note(from, 'http-server-close matches the NGINX Ingress Controller default (client keep-alive on, none to the upstream); nothing to migrate.');
            else if (mode === '') g.note(from, 'http-connection-mode is empty, so HAProxy kept its default http-keep-alive; see http-keep-alive.');
            else { g.note(from, 'http-connection-mode "' + mode + '" is not http-keep-alive, http-server-close or httpclose, so HAProxy logged an error and kept http-keep-alive.', 'warning'); connectionMode('http-keep-alive', g, from); }
        }
        // A deprecated alias counts only when http-connection-mode is unset,
        // and only when GetBoolValue reads it as true.
        function aliasMode(name, x, g, run) {
            let cm = controllerOptions(run);
            if (cm['http-connection-mode'] && str(cm['http-connection-mode'].value) !== '') { g.note(name, name + ' is a deprecated HAProxy alias of http-connection-mode, which is set, so HAProxy ignored it.'); return; }
            let on = haproxyBool(x.value);
            g.note(name, name + ' is a deprecated HAProxy alias of http-connection-mode' + (on === null ? '; "' + x.value + '" is not a boolean, so HAProxy logged an error and ignored it.' : on ? '.' : '; false does nothing.'), on === null ? 'warning' : 'note');
            if (on) connectionMode(name, g, name);
        }

        function globalCR(cr, g) {
            let flat = {};
            Object.keys(cr.config || {}).forEach(function(raw) {
                let k = String(raw).toLowerCase().replace(/_/g, '-');
                let v = cr.config[raw];
                if (k === 'performance-options' && isMap(v)) { if (v.maxconn != null) flat.maxconn = v.maxconn; }
                else if (k === 'ssl-options' && isMap(v)) {
                    if (v.default_bind_ciphers != null) flat['ssl-default-bind-ciphers'] = v.default_bind_ciphers;
                    if (v.default_bind_options != null) flat['ssl-default-bind-options'] = v.default_bind_options;
                    if (v.dh_param_file != null) flat['ssl-dh-param-file'] = v.dh_param_file;
                } else if (k === 'log-target-list') flat['log-targets'] = v;
                else flat[k] = v;
            });
            let label = 'Global ' + cr.name;
            let dropped = [], managed = [];
            Object.keys(flat).forEach(function(k) {
                let v = flat[k];
                switch (k) {
                    // The CRD types these as integers; a value that is not one
                    // never reached HAProxy, so it is reported, not written.
                    case 'maxconn': case 'nbthread': case 'ulimit-n': {
                        let n = haproxyInt(v);
                        if (n === null || n < 0) { g.note(label, k + ' "' + v + '" is not a whole number, which the Global CRD refuses; it is not migrated.', 'warning'); break; }
                        if (k === 'maxconn') g.cm('worker-connections', String(n), label + ' maxconn — per worker in NGINX: divide by worker-processes');
                        else if (k === 'nbthread') g.cm('worker-processes', String(n), label + ' nbthread');
                        else g.cm('worker-rlimit-nofile', String(n), label + ' ulimit_n');
                        break;
                    }
                    case 'hard-stop-after': case 'grace': { let t = msToNginxTime(v); if (t) g.cm('worker-shutdown-timeout', t.value, label + ' ' + k + ' (milliseconds)'); else g.note(label, k + ' "' + v + '" is not a count of milliseconds; it is not migrated.', 'warning'); break; }
                    case 'ssl-default-bind-ciphers': g.cm('ssl-ciphers', v, label + ' ssl_default_bind_ciphers'); break;
                    case 'ssl-default-bind-options': g.cm('ssl-protocols', 'TLSv1.2 TLSv1.3', label + ' ssl_default_bind_options — TODO: derive from "' + v + '"'); g.todo('configmap.ssl-protocols', 'derive the protocols from "' + v + '"'); break;
                    // The key holds the DH parameters, not a path
                    // (MainServerSSLDHParamFileContent): NGINX Ingress Controller writes the file.
                    case 'ssl-dh-param-file': g.cm('ssl-dhparam-file', '-----BEGIN DH PARAMETERS-----\n# TODO: paste the contents of ' + v + '\n-----END DH PARAMETERS-----\n', label + ' ssl_dh_param_file — the key takes the PEM content, not a path'); g.todo('configmap.ssl-dhparam-file', 'paste the contents of ' + v); break;
                    case 'cpu-maps': case 'cpu-set': case 'cpu-policy': g.cm('worker-cpu-affinity', 'auto', label + ' ' + k + ' — TODO: translate to NGINX CPU masks'); g.todo('configmap.worker-cpu-affinity', 'translate ' + k + ' to NGINX CPU masks'); break;
                    case 'log-targets': case 'log': g.cm('access-log', 'syslog:server=127.0.0.1:514', label + ' log targets — TODO: the syslog address'); g.todo('configmap.access-log', 'the syslog address from the Global log targets'); break;
                    case 'daemon': case 'master-worker': case 'pidfile': case 'localpeer': case 'chroot': case 'user': case 'uid': case 'group': case 'gid': case 'default-path': managed.push(k); break;
                    default: dropped.push(k);
                }
            });
            if (managed.length) g.note(label, 'NGINX Ingress Controller manages these itself: ' + managed.join(', ') + '.');
            if (dropped.length) g.note(label, 'No NGINX Ingress Controller key for ' + dropped.join(', ') + '; where NGINX has a directive, use main-snippets or http-snippets.', 'warning');
            g.note(label, 'A Global CR replaces HAProxy\'s ConfigMap settings; NGINX Ingress Controller ConfigMap keys are defaults each resource may override. Drop the cr-global pointer.');
        }

        function defaultsCR(cr, g) {
            let label = 'Defaults ' + cr.name;
            let none = [];
            Object.keys(cr.config || {}).forEach(function(raw) {
                let k = String(raw).toLowerCase().replace(/_/g, '-');
                let v = cr.config[raw];
                switch (k) {
                    // Integer milliseconds in the CRD; anything else is reported
                    // rather than written, as http-snippets is not checked.
                    case 'server-timeout': case 'connect-timeout': case 'http-keep-alive-timeout': case 'client-timeout': case 'http-request-timeout': {
                        let t = msToNginxTime(v);
                        if (!t) { g.note(label, raw + ' "' + v + '" is not a count of milliseconds; it is not migrated.', 'warning'); break; }
                        if (k === 'server-timeout') { g.cm('proxy-read-timeout', t.value, label + ' server_timeout (milliseconds)'); g.cm('proxy-send-timeout', t.value, label + ' server_timeout covers both directions'); }
                        else if (k === 'connect-timeout') g.cm('proxy-connect-timeout', t.value, label + ' connect_timeout (milliseconds)');
                        else if (k === 'http-keep-alive-timeout') g.cm('keepalive-timeout', t.value, label + ' http_keep_alive_timeout (milliseconds)');
                        else g.http('client_header_timeout ' + t.value + ';', label + ' ' + raw);
                        break;
                    }
                    case 'balance': { let m = haproxyLbMethod(balanceString(v)); if (m.value && !m.invalid) g.cm('lb-method', m.value, label + ' balance' + (m.note ? ' — ' + m.note : '')); else g.note(label, 'balance: ' + (m.none || m.invalid), 'warning'); break; }
                    case 'retries': g.note(label, 'retries is per resource in NGINX Ingress Controller: nginx.org/proxy-next-upstream-tries, or VirtualServer upstreams[].next-upstream-tries.'); break;
                    case 'redispatch': g.note(label, 'Retrying on another server is per resource in NGINX Ingress Controller: nginx.org/proxy-next-upstream (default "error timeout").'); break;
                    case 'httplog': case 'log-format': g.cm('log-format', LOG_FORMAT_HTTP, label + ' ' + raw + ' — TODO: rewrite as NGINX variables'); g.todo('configmap.log-format', 'rewrite the Defaults log format with NGINX variables'); break;
                    case 'tcplog': g.cm('stream-log-format', LOG_FORMAT_TCP, label + ' tcplog — TODO: rewrite as NGINX stream variables'); break;
                    case 'forwardfor': g.note(label, 'forwardfor: NGINX Ingress Controller sends X-Forwarded-For by default.'); break;
                    case 'mode': g.note(label, 'mode is structural in NGINX Ingress Controller: HTTP is an Ingress or VirtualServer, TCP a TransportServer.'); break;
                    default: none.push(raw);
                }
            });
            if (none.length) g.note(label, 'No NGINX Ingress Controller equivalent for ' + none.join(', ') + ' (see the Defaults rows of the reference guide).', 'warning');
            g.note(label, 'Drop the cr-defaults pointer: the CR\'s settings move into the nginx-config ConfigMap.');
        }

        function tcpListener(g, name, port, service, servicePort, namespace, ssl, secret, source) {
            g.listeners.push({ name: name + '-tcp', port: port, protocol: 'TCP', source: source });
            let md = { name: name };
            if (namespace) md.namespace = namespace;
            let spec = {};
            if (g.ingressClass) spec.ingressClassName = g.ingressClass;
            spec.listener = { name: name + '-tcp', protocol: 'TCP' };
            let c = { 'spec.listener': source };
            if (ssl) {
                spec.tls = { secret: secret || dnsName(service + '-tls') };
                c['spec.tls.secret'] = source + ' :ssl — a kubernetes.io/tls Secret';
                if (!secret) g.todo('TransportServer ' + name + ' spec.tls.secret', 'the kubernetes.io/tls Secret with the certificate HAProxy used');
            }
            spec.upstreams = [{ name: 'backend', service: service, port: servicePort }];
            spec.action = { pass: 'backend' };
            g.doc({ apiVersion: NIC_API, kind: 'TransportServer', metadata: md, spec: spec }, c, source);
        }

        function tcpCR(cr, g) {
            let items = Array.isArray(cr.spec) ? cr.spec : [cr.spec];
            items.forEach(function(item, idx) {
                if (!isMap(item)) return;
                let name = sanitizeName(item.name || (cr.name + '-' + (idx + 1)));
                let svc = isMap(item.service) ? item.service : {};
                let fe = isMap(item.frontend) ? item.frontend : {};
                let port = null, ssl = false, cert = null;
                let binds = fe.binds;
                (Array.isArray(binds) ? binds : isMap(binds) ? Object.keys(binds).map(function(k) { return binds[k]; }) : []).forEach(function(b) {
                    if (!isMap(b)) return;
                    if (b.port && port === null) port = b.port;
                    if (b.ssl === true) ssl = true;
                    if (b.ssl_certificate) cert = b.ssl_certificate;
                });
                if (port === null) g.todo('GlobalConfiguration listener ' + name + '-tcp', 'the port of TCP ' + cr.name + ' ' + name);
                tcpListener(g, name, port || 5000, svc.name || 'service', svc.port || 80, cr.namespace, ssl, cert && String(cert).indexOf('/') === -1 ? cert : null, 'TCP ' + cr.name);
                let rules = ['acls', 'acl_list', 'backend_switching_rule_list', 'tcp_request_rule_list', 'capture_list', 'filter_list', 'log_target_list'].filter(function(rk) { return item[rk] !== undefined || fe[rk] !== undefined; });
                if (rules.length) g.note('TCP ' + cr.name, 'A TransportServer has no ACL, content-switching or tcp-request fields: ' + rules.join(', ') + ' are not migrated (spec.streamSnippets is the escape hatch).', 'warning');
                if (Array.isArray(item.services) && item.services.length) g.note('TCP ' + cr.name, 'A TransportServer routes one listener to one upstream; each extra service needs its own listener.', 'warning');
            });
        }

        // The run's global settings: ConfigMap keys, CRs and TCP services.
        function migrateController(run, options) {
            let g = controllerCtx();
            // A TransportServer with no class is claimed by every NGINX Ingress
            // Controller (HasCorrectIngressClass); one chosen for the run applies.
            g.ingressClass = (options && options.ingressClass) || null;
            let http = [];
            g.http = function(line, source) { if (!http.some(function(h) { return h.line === line; })) http.push({ line: line, source: source }); };
            g.listeners = [];
            let cm = controllerOptions(run);
            if (run.configMaps.filter(function(c) { return Object.keys(c.options).length; }).length > 1) g.note('ConfigMap', 'The paste holds more than one HAProxy ConfigMap; HAProxy reads one. Their keys were merged, the first value kept.', 'warning');
            // controller/global.go: a Global CR named by cr-global replaces the
            // Global keys of the ConfigMap; a Defaults CR named by cr-defaults
            // the Defaults keys. A CR nothing names applies to nothing.
            let globalCRUsed = cm['cr-global'] ? findCR(run, 'Global', cm['cr-global'].value, null) : null;
            let defaultsCRUsed = cm['cr-defaults'] ? findCR(run, 'Defaults', cm['cr-defaults'].value, null) : null;
            let GLOBAL_KEYS = ['syslog-server', 'nbthread', 'maxconn', 'hard-stop-after'];
            let DEFAULTS_KEYS = ['dontlognull', 'logasap', 'timeout-http-request', 'timeout-connect', 'timeout-client', 'timeout-client-fin', 'timeout-queue', 'timeout-server', 'timeout-server-fin', 'timeout-tunnel', 'timeout-http-keep-alive', 'log-format', 'http-connection-mode'];
            if (cm['cr-global'] && !globalCRUsed) g.note('cr-global', 'The ConfigMap names the Global ' + cm['cr-global'].value + ', which is not in the paste; paste it to migrate it.', 'warning');
            if (cm['cr-defaults'] && !defaultsCRUsed) g.note('cr-defaults', 'The ConfigMap names the Defaults ' + cm['cr-defaults'].value + ', which is not in the paste; paste it to migrate it.', 'warning');
            Object.keys(cm).forEach(function(k) {
                let x = { value: cm[k].value, from: { kind: 'ConfigMap', name: null } };
                if ((globalCRUsed && GLOBAL_KEYS.indexOf(k) !== -1) || (defaultsCRUsed && DEFAULTS_KEYS.indexOf(k) !== -1)) {
                    g.note(k, 'HAProxy ignored the ConfigMap\'s ' + k + ', because the ' + (GLOBAL_KEYS.indexOf(k) !== -1 ? 'Global ' + globalCRUsed.name : 'Defaults ' + defaultsCRUsed.name) + ' it names replaces it; the migration follows the CR.');
                    return;
                }
                let idx = HAPROXY_LOOKUP.get(canonicalKey(k));
                let entry = idx !== undefined ? HAPROXY_MAPPINGS[idx] : null;
                if (entry && entry.type === 'unsupported') { g.unsupported.push({ mapping: entry, names: [k] }); return; }
                if (CM_GLOBAL[k]) { CM_GLOBAL[k](x, g); g.entries.push(entry); return; }
                if (CONTROLLER[k]) { try { CONTROLLER[k](x, g, run); } catch (e) { console.warn('Translator failed for ConfigMap ' + k + ':', e); } if (entry) g.entries.push(entry); return; }
                if (/^cr-(global|defaults|frontend-http|frontend-https|frontend-stats|backend)$/.test(k)) return;
                // Frontend and backend keys reach each Ingress through resolve();
                // with no Ingress in the paste, say so.
                if (FRONTEND_KEYS.indexOf(k) !== -1 || BACKEND_KEYS.indexOf(k) !== -1) {
                    if (!run.ingresses.length) g.note(k, 'HAProxy applies ' + k + ' from the ConfigMap to every Ingress; NGINX Ingress Controller has no global form for it, so it is migrated onto each Ingress. Paste the Ingresses with the ConfigMap.', 'warning');
                    return;
                }
                if (!entry) g.unrecognised.push({ name: k, value: cm[k].value, where: 'ConfigMap' });
            });
            run.configMaps.forEach(function(c) {
                if (!c.tcp.length) return;
                c.tcp.forEach(function(e) { tcpListener(g, sanitizeName(e.service) + '-' + e.listenPort, e.listenPort, e.service, e.servicePort, e.namespace, e.ssl, null, 'ConfigMap ' + c.name + ' (tcp-services)'); });
                g.entries.push(HAPROXY_MAPPINGS[HAPROXY_LOOKUP.get('configmap:tcp-services')]);
            });
            run.crs.forEach(function(cr) {
                let idx = HAPROXY_LOOKUP.get('kind:' + cr.kind);
                let entry = idx !== undefined ? HAPROXY_MAPPINGS[idx] : null;
                if (!entry) { g.unrecognised.push({ name: cr.kind + ' ' + cr.name, value: '', where: cr.kind }); return; }
                if (entry.type === 'unsupported') { g.unsupported.push({ mapping: entry, names: [cr.kind + ' ' + cr.name] }); return; }
                g.entries.push(entry);
                try {
                    if (cr.kind === 'Global' || cr.kind === 'Defaults') {
                        if (cr !== (cr.kind === 'Global' ? globalCRUsed : defaultsCRUsed)) {
                            g.note(cr.kind + ' ' + cr.name, 'HAProxy applies a ' + cr.kind + ' only when the controller ConfigMap names it in cr-' + cr.kind.toLowerCase() + ', and ' + (cm['cr-' + cr.kind.toLowerCase()] ? 'it names another' : 'no ConfigMap in the paste does') + ', so this one applied to nothing and is not migrated. Paste the ConfigMap that names it.', 'warning');
                            return;
                        }
                        if (cr.kind === 'Global') globalCR(cr, g); else defaultsCR(cr, g);
                    } else if (cr.kind === 'Frontend') g.note('Frontend ' + cr.name, 'A Frontend CR has no single NGINX Ingress Controller counterpart: its binds are listener flags (-default-http-listener-port, -default-https-listener-port) or GlobalConfiguration listeners, accept_proxy the proxy-protocol key, log options log-format and access-log, and http-request rules server-snippets rewritten by hand. A listener change affects every application; test it first.', 'warning');
                    else if (cr.kind === 'TCP') tcpCR(cr, g);
                    // A Backend CR is migrated where a cr-backend reaches it.
                    else if (cr.kind === 'Backend' && !run.services.some(function(s) { return s.haproxy['cr-backend']; }) && !run.ingresses.some(function(m) { return m.haproxy['cr-backend']; }) && !cm['cr-backend']) {
                        g.note('Backend ' + cr.name, 'No cr-backend in the paste names this Backend, so it reaches no Service; paste the Service or Ingress that points at it.', 'warning');
                    }
                } catch (e) { console.warn('Translator failed for ' + cr.kind + ' ' + cr.name + ':', e); }
            });
            if (g.listeners.length) {
                let gc = { apiVersion: NIC_API, kind: 'GlobalConfiguration', metadata: { name: 'nginx-configuration', namespace: 'nginx-ingress' }, spec: { listeners: g.listeners.map(function(l) { return { name: l.name, port: l.port, protocol: l.protocol }; }) } };
                let c = {};
                g.listeners.forEach(function(l, i) { c['spec.listeners.' + i] = l.source; });
                // GlobalConfiguration first: the TransportServers name its listeners.
                g.docs.unshift(gc); g.comments.unshift(c); g.sources.unshift('TCP services');
                g.note('GlobalConfiguration', 'NGINX Ingress Controller reads one GlobalConfiguration, named by -global-configuration=<namespace>/<name> (Helm controller.globalConfiguration.create). Merge these listeners into it, and expose their ports on the controller Service.', 'warning');
            }
            if (http.length) { g.cm('http-snippets', http.map(function(h) { return h.line; }).join('\n') + '\n', http.map(function(h) { return h.source; }).filter(function(s, i, a) { return a.indexOf(s) === i; }).join(' + ')); }
            // A Service HAProxy reads settings from only when an Ingress routes
            // to it (service.New is called per Ingress path). One that no
            // Ingress in the paste reaches is named, its route-acl checked now.
            run.services.forEach(function(svc) {
                let keys = Object.keys(svc.haproxy);
                if (!keys.length) return;
                let reached = run.ingresses.some(function(m) {
                    return (m.namespace || null) === (svc.namespace || null) && (m.hosts.some(function(h) { return h.paths.some(function(p) { return p.backend && p.backend.service === svc.name; }); }) || (m.defaultBackend && m.defaultBackend.service === svc.name));
                });
                if (reached) return;
                keys.forEach(function(k) {
                    let idx = NAME_TO_TRANSLATOR[k];
                    let entry = idx !== undefined ? HAPROXY_MAPPINGS[idx] : null;
                    if (!entry) g.unrecognised.push({ name: k, value: svc.haproxy[k].value, key: svc.haproxy[k].key, where: 'Service' });
                    else if (entry.type === 'unsupported') g.unsupported.push({ mapping: entry, names: [k] });
                    else g.entries.push(entry);
                });
                if (svc.haproxy['route-acl']) {
                    let acl = parseRouteACL(svc.haproxy['route-acl'].value);
                    if (acl.kind === 'untranslatable' || acl.kind === 'src') g.note('route-acl', 'Service ' + svc.name + ': the ACL "' + acl.raw + '" is not translatable' + (acl.why ? ' (' + acl.why + ')' : '') + '. VirtualServer matches test headers, cookies, query arguments and a fixed set of variables; re-express it with those.', 'warning');
                }
                g.note('Service ' + svc.name, 'No Ingress in the paste routes to this Service, and HAProxy reads ' + keys.join(', ') + ' only for a Service an Ingress path reaches (route-acl too: the canary Service must be on a rule). Paste the Ingress with it to migrate them.', 'warning');
            });
            return g;
        }

        // --- Plan -------------------------------------------------------------

        // A route-acl Ingress whose every path goes to route-acl Services joins
        // the Ingress that serves the same host, as HAProxy routed both from
        // one frontend: its legs land on that Ingress's VirtualServer.
        function pairCanaries(models, run) {
            let pairs = new Map();
            models.forEach(function(m) {
                let paths = [].concat.apply([], m.hosts.map(function(h) { return h.paths; }));
                let canaryOnly = paths.length && paths.every(function(p) {
                    let s = p.backend && p.backend.service ? findService(run, m.namespace, p.backend.service) : null;
                    return s && s.haproxy['route-acl'];
                });
                if (!canaryOnly) return;
                let stable = models.find(function(o) { return o !== m && !pairs.has(o) && (o.namespace || null) === (m.namespace || null) && o.hosts.some(function(h) { return m.hosts.some(function(x) { return x.host === h.host; }); }); });
                if (stable) pairs.set(m, stable);
            });
            return pairs;
        }

        function migrateAll(parsed, strategy, options) {
            options = options || {};
            let run = parsed.run || { ingresses: parsed.ingresses || [], services: [], configMaps: [], crs: [] };
            let models = run.ingresses;
            let pairs = strategy === 'crd' ? pairCanaries(models, run) : new Map();
            let merged = new Map();
            pairs.forEach(function(stable, canary) {
                let base = merged.get(stable) || Object.assign({}, stable, { hosts: stable.hosts.map(function(h) { return Object.assign({}, h, { paths: h.paths.slice() }); }) });
                canary.hosts.forEach(function(ch) { let h = base.hosts.find(function(x) { return x.host === ch.host; }); if (h) h.paths = h.paths.concat(ch.paths); });
                merged.set(stable, base);
            });
            let results = models.map(function(m) {
                if (pairs.has(m)) return { model: m, out: null };
                return { model: m, out: migrateIngress(merged.get(m) || m, run, strategy, options) };
            });
            results.forEach(function(r) {
                if (r.out) return;
                let stable = pairs.get(r.model);
                r.mergedInto = results.find(function(x) { return x.model === stable; });
                r.out = { docs: [], comments: [], notes: [{ name: 'route-acl', message: 'Merged into the VirtualServer of Ingress ' + (stable.name || '') + ', which serves the same host: the route-acl Services of this Ingress become its splits and matches.', severity: 'note' }], todos: [], unsupported: [], unrecognized: [], matched: [], configMap: null, sources: [] };
                if (Object.keys(r.model.haproxy).length) r.out.notes.push({ name: 'route-acl', message: 'This Ingress\'s own annotations (' + Object.keys(r.model.haproxy).join(', ') + ') applied only to its paths, which carry no traffic of their own once merged; they are not migrated.', severity: 'warning' });
            });
            return { results: results, controller: migrateController(run, options) };
        }

        function docYaml(doc, comments) {
            return MigrationTool.yaml.stringify(doc, comments, { quote: function(p) { return /^metadata\.annotations\./.test(p) || /^data\./.test(p); } }).replace(/\n$/, '');
        }

        // The HAProxy objects behind a card: the Ingress with only the
        // annotations that produced the resource beside it, and each Service
        // or ConfigMap a setting was read from. A resource no setting
        // produced shows the Ingress spec.
        function sourceYaml(model, sources, run) {
            let docs = [];
            let byKind = { Ingress: {}, Service: {}, ConfigMap: {} };
            let crs = [];
            (sources || []).forEach(function(s) {
                if (s.cr && crs.indexOf(s.cr) === -1) crs.push(s.cr);
                let kind = s.from ? s.from.kind : 'Ingress';
                let holder = kind === 'Service' ? findService(run, model.namespace, (s.from.name || '').split(', ')[0]) : null;
                if (kind === 'Ingress' && model.haproxy[s.name]) byKind.Ingress[model.haproxy[s.name].key] = model.haproxy[s.name].value;
                else if (kind === 'Service' && holder && holder.haproxy[s.name]) (byKind.Service[holder.name] = byKind.Service[holder.name] || {})[holder.haproxy[s.name].key] = holder.haproxy[s.name].value;
                else if (kind === 'ConfigMap') { let cm = controllerOptions(run); if (cm[s.name]) byKind.ConfigMap[s.name] = cm[s.name].value; }
            });
            let ingMd = { name: model.name || 'my-app' };
            if (model.namespace) ingMd.namespace = model.namespace;
            let ing = { apiVersion: model.apiVersion || 'networking.k8s.io/v1', kind: 'Ingress', metadata: ingMd };
            if (Object.keys(byKind.Ingress).length) ingMd.annotations = byKind.Ingress;
            else if (!Object.keys(byKind.Service).length && !Object.keys(byKind.ConfigMap).length && isMap(model.doc.spec)) ing.spec = model.doc.spec;
            if (Object.keys(byKind.Ingress).length || ing.spec) docs.push(ing);
            Object.keys(byKind.Service).forEach(function(n) { let md = { name: n }; if (model.namespace) md.namespace = model.namespace; md.annotations = byKind.Service[n]; docs.push({ apiVersion: 'v1', kind: 'Service', metadata: md }); });
            if (Object.keys(byKind.ConfigMap).length) docs.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: (run.configMaps.find(function(c) { return Object.keys(c.options).length; }) || { name: 'haproxy-kubernetes-ingress' }).name }, data: byKind.ConfigMap });
            crs.forEach(function(c) { docs.push(c.doc); });
            if (!docs.length) docs.push(ing);
            return docs.map(function(d) { return MigrationTool.yaml.stringify(d, null, { quote: function(p) { return /^metadata\.annotations\./.test(p) || /^data\./.test(p); } }).replace(/\n$/, ''); }).join('\n---\n');
        }

        function rawYaml(doc) { return MigrationTool.yaml.stringify(doc).replace(/\n$/, ''); }

        function buildPlan(parsed, strategy, options) {
            let all = migrateAll(parsed, strategy, options);
            let results = all.results;
            let g = all.controller;
            let run = parsed.run || { ingresses: [], services: [], configMaps: [], crs: [] };
            let warnings = [];
            if (Object.keys(parsed.skipped || {}).length) warnings.push({ title: 'Documents skipped', message: Object.keys(parsed.skipped).map(function(k) { return parsed.skipped[k] + ' ' + k; }).join(', ') + ' — the analyzer reads Ingresses, the Services they route to, the HAProxy ConfigMap and ingress.v3.haproxy.org custom resources.' });
            let infoNotes = [];
            let resources = [];
            let cmAll = { data: {}, comments: {} };
            let unsupportedCards = [];
            let unrecognised = [];
            let paths = {};
            let noteOf = function(prefix, n, model) {
                let code = n.name;
                let hit = model && model.haproxy[n.name];
                if (hit) code = hit.key + ': ' + hit.value;
                else if (!model) { let cm = controllerOptions(run); if (cm[n.name]) code = n.name + ': ' + cm[n.name].value + ' (ConfigMap)'; }
                infoNotes.push({ code: prefix + code, message: n.message, severity: n.severity });
            };
            results.forEach(function(r) {
                let label = results.length > 1 && r.model.name ? r.model.name + ': ' : '';
                r.out.notes.forEach(function(n) { noteOf(label, n, r.model); });
                r.out.todos.forEach(function(t) { infoNotes.push({ code: label + 'TODO ' + t.path, message: 'Fill in: ' + t.message + '.', severity: 'warning' }); });
                if (r.out.configMap) Object.keys(r.out.configMap.data).forEach(function(k) {
                    if (cmAll.data[k] !== undefined && cmAll.data[k] !== r.out.configMap.data[k]) infoNotes.push({ code: 'ConfigMap ' + k, message: 'Ingresses disagree (' + cmAll.data[k] + ' vs ' + r.out.configMap.data[k] + '); the ConfigMap is global, so the first value is kept.', severity: 'warning' });
                    else { cmAll.data[k] = r.out.configMap.data[k]; cmAll.comments[k] = r.out.configMap.comments[k]; }
                });
                r.out.unsupported.forEach(function(e) { unsupportedCards.push({ title: e.mapping.source, code: e.names.join(', '), desc: e.mapping.nic, anchor: e.mapping.anchor || null, sidebarSection: sectionIdFor(e.mapping) }); });
                r.out.unrecognized.forEach(function(k) { if (!unrecognised.some(function(u) { return u.name === k; })) unrecognised.push({ name: k, value: r.model.haproxy[k] ? r.model.haproxy[k].value : '', key: r.model.haproxy[k] ? r.model.haproxy[k].key : 'haproxy.org/' + k, where: 'Ingress' }); });
                r.out.matched.forEach(function(e) { paths[e.mapping.source] = e.mapping; });
                if (!r.mergedInto) r.out.docs.forEach(function(d, i) {
                    let canary = results.filter(function(x) { return x.mergedInto === r; });
                    resources.push({ doc: d, comments: r.out.comments[i], old: sourceYaml(r.model, r.out.sources[i], run) + (d.kind === 'VirtualServer' && canary.length ? canary.map(function(x) { return '\n---\n' + sourceYaml(x.model, [], run); }).join('') : ''), model: r.model });
                });
            });
            // The controller pass.
            g.notes.forEach(function(n) { noteOf('', n); });
            g.todos.forEach(function(t) { infoNotes.push({ code: 'TODO ' + t.path, message: 'Fill in: ' + t.message + '.', severity: 'warning' }); });
            Object.keys(g.cmData).forEach(function(k) {
                if (cmAll.data[k] !== undefined && cmAll.data[k] !== g.cmData[k]) infoNotes.push({ code: 'ConfigMap ' + k, message: 'Two settings write it (' + cmAll.data[k] + ' vs ' + g.cmData[k] + '); the first value is kept.', severity: 'warning' });
                else if (cmAll.data[k] === undefined) { cmAll.data[k] = g.cmData[k]; cmAll.comments[k] = g.cmComments[k]; }
            });
            g.unsupported.forEach(function(e) { unsupportedCards.push({ title: e.mapping.source, code: e.names.join(', '), desc: e.mapping.nic, anchor: e.mapping.anchor || null, sidebarSection: sectionIdFor(e.mapping) }); });
            (g.unrecognised || []).forEach(function(u) { unrecognised.push(u); });
            g.entries.forEach(function(e) { if (e) paths[e.source] = e; });
            g.docs.forEach(function(d, i) {
                let src = g.sources[i];
                let tcpDocs = run.crs.filter(function(c) { return c.kind === 'TCP'; }).map(function(c) { return c.doc; }).concat(run.configMaps.filter(function(c) { return c.tcp.length; }).map(function(c) { return c.doc; }));
                let old = d.kind === 'GlobalConfiguration' ? tcpDocs.map(rawYaml).join('\n---\n')
                    : (tcpDocs.find(function(t) { return src.indexOf(str(t.metadata && t.metadata.name)) !== -1; }) ? rawYaml(tcpDocs.find(function(t) { return src.indexOf(str(t.metadata && t.metadata.name)) !== -1; })) : '# ' + src);
                resources.push({ doc: d, comments: g.comments[i], old: old || '# ' + src, model: null });
            });

            let classNote = 'Set the class NGINX Ingress Controller owns (Helm default "nginx"; to run both controllers side by side, install with --set controller.ingressClass.name=nginx-nic and pass --class to nic-migrate). A class naming HAProxy is left off the migrated resources: NGINX Ingress Controller ignores a resource whose class it does not own, without an error, and claims one with none.';
            if (run.ingresses.length) infoNotes.unshift({ code: 'spec.ingressClassName', message: classNote, severity: 'note' });
            let usesSnippets = resources.some(function(r) {
                let s = r.doc.spec || {};
                let ann = (r.doc.metadata && r.doc.metadata.annotations) || {};
                return s['server-snippets'] || (s.routes || []).some(function(rt) { return rt['location-snippets']; }) || ann['nginx.org/location-snippets'] || ann['nginx.org/server-snippets'];
            });
            if (usesSnippets) infoNotes.unshift({ code: 'snippets', message: 'This output uses snippets, which NGINX Ingress Controller rejects unless NGINX Ingress Controller runs with -enable-snippets (Helm: controller.enableSnippets=true). HAProxy directives are not NGINX directives: every line marked TODO must be rewritten, or the reload fails.', severity: 'warning' });

            let steps = [];
            let ingressDocs = resources.filter(function(r) { return r.doc.kind === 'Ingress'; });
            if (ingressDocs.length) {
                steps.push({
                    id: 'analyzer-step-1', title: 'Migrated Ingress',
                    countText: ingressDocs.length + ' Ingress' + (ingressDocs.length !== 1 ? 'es' : ''), countCls: '',
                    desc: 'Replace the HAProxy annotations with these NGINX Ingress Controller ones. Every rule, TLS entry and backend is kept; settings HAProxy read from a Service or the ConfigMap are applied here too.',
                    blocks: ingressDocs.map(function(r) { return { type: 'comparison', old: { title: 'HAProxy Kubernetes Ingress Controller ', badge: 'current', yaml: r.old }, new: { title: 'NGINX Ingress Controller ', badge: 'migrated', yaml: docYaml(r.doc, r.comments), collapsible: true } }; })
                });
            }
            let cmDoc = Object.keys(cmAll.data).length ? { doc: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nginx-config' }, data: cmAll.data }, comments: prefixComments(cmAll.comments, 'data.') } : null;
            if (cmDoc) {
                let cmSrc = run.configMaps.filter(function(c) { return Object.keys(c.options).length; }).map(function(c) { return rawYaml(c.doc); }).concat(run.crs.filter(function(c) { return c.kind === 'Global' || c.kind === 'Defaults'; }).map(function(c) { return rawYaml(c.doc); }));
                steps.push({
                    id: 'analyzer-step-2', title: 'ConfigMap changes',
                    countText: Object.keys(cmDoc.doc.data).length + ' entr' + (Object.keys(cmDoc.doc.data).length !== 1 ? 'ies' : 'y'), countCls: 'configmap',
                    desc: 'These settings are global in NGINX Ingress Controller: merge them into the nginx-config ConfigMap. They apply to every Ingress and VirtualServer.',
                    blocks: [{ type: 'comparison', old: { title: 'HAProxy Kubernetes Ingress Controller (current)', badge: null, yaml: cmSrc.join('\n---\n') || '# (written by annotations on the resources above)' }, new: { title: 'NGINX Ingress Controller (migrated)', badge: null, yaml: docYaml(cmDoc.doc, cmDoc.comments) } }]
                });
            }
            let crd = resources.filter(function(r) { return r.doc.kind !== 'Ingress'; });
            if (crd.length) {
                let blocks = [{ type: 'crd-install-note' }];
                let byKind = {};
                crd.forEach(function(r) { (byKind[r.doc.kind] = byKind[r.doc.kind] || []).push(r); });
                ['Policy', 'VirtualServer', 'TransportServer', 'GlobalConfiguration'].forEach(function(kind) {
                    let group = byKind[kind];
                    if (!group) return;
                    blocks.push({
                        type: 'crd-group', kind: kind, countText: group.length + ' resource' + (group.length !== 1 ? 's' : ''),
                        items: group.map(function(r) {
                            return {
                                category: r.doc.metadata.name + (r.doc.spec && r.doc.spec.host ? ' — ' + r.doc.spec.host : ''),
                                plusRequired: !!(r.doc.spec && (r.doc.spec.waf || (r.doc.spec.upstreams || []).some(function(u) { return u.healthCheck; }))),
                                dualSuffix: null,
                                old: { title: 'HAProxy Kubernetes Ingress Controller (current)', badge: null, yaml: r.old, collapsible: true },
                                new: { title: 'NGINX Ingress Controller (migrated)', badge: null, yaml: docYaml(r.doc, r.comments), collapsible: true }
                            };
                        })
                    });
                });
                steps.push({
                    id: 'analyzer-step-3', title: 'CRD resources', countText: crd.length + ' resource' + (crd.length !== 1 ? 's' : ''), countCls: 'crd',
                    desc: strategy === 'crd'
                        ? 'One VirtualServer per host replaces the Ingress, with every route, backend and TLS secret, and references the Policies beside it. Install the CRDs, apply these, then delete the HAProxy Ingress.'
                        : 'Policies the migrated Ingress references through nginx.org/policies, and the resources an Ingress cannot express. Install the CRDs and apply them with it.',
                    blocks: blocks
                });
            }

            let total = parsed.foundCount;
            let pathCount = Object.keys(paths).length;
            let pills = [];
            pills.push({ cls: 'found', text: total + ' HAProxy item' + (total !== 1 ? 's' : '') + ' found', scrollTo: null });
            pills.push({ cls: 'paths', text: pathCount + ' migration path' + (pathCount !== 1 ? 's' : ''), scrollTo: steps.length ? steps[0].id : null });
            if (crd.length) pills.push({ cls: 'crds', text: crd.length + ' require CRDs', scrollTo: 'analyzer-step-3' });
            let flagged = infoNotes.filter(function(n) { return n.severity === 'warning'; }).length;
            if (flagged) pills.push({ cls: 'unrecognized', text: flagged + ' need attention', scrollTo: 'analyzer-info-notes' });
            if (unrecognised.length) pills.push({ cls: 'unrecognized', text: unrecognised.length + ' unrecognized', scrollTo: 'analyzer-unrecognized' });
            let ingressCount = run.ingresses.length;
            let banner = {
                strongText: total ? total + ' HAProxy item' + (total !== 1 ? 's' : '') + ' analyzed' : ingressCount + ' Ingress' + (ingressCount !== 1 ? 'es' : '') + ' with no HAProxy settings',
                restText: (total ? ', ' + pathCount + ' migration path' + (pathCount !== 1 ? 's' : '') + ' across ' + steps.length + ' step' + (steps.length !== 1 ? 's' : '') : ' — the resources below still need the NGINX Ingress Controller class') + (flagged ? ' — ' + flagged + ' need' + (flagged === 1 ? 's' : '') + ' attention before you apply.' : '.'),
                complexity: flagged > 2 || unsupportedCards.length ? 'advanced' : (flagged || cmDoc || Object.keys(paths).some(function(k) { let t = paths[k].type; return t === 'policy' || t === 'virtualserver' || t === 'transportserver'; })) ? 'moderate' : 'simple'
            };

            let parts = [];
            ingressDocs.forEach(function(r) { parts.push('# Migrated Ingress\n' + docYaml(r.doc, r.comments)); });
            if (cmDoc) parts.push('# Merge into the nginx-config ConfigMap (global)\n' + docYaml(cmDoc.doc, cmDoc.comments));
            crd.forEach(function(r) { parts.push('# ' + r.doc.kind + '\n' + docYaml(r.doc, r.comments)); });

            let nextItems = [
                { text: 'Review the full migration checklist', anchor: '#checklist' },
                { text: 'Browse all annotation and CRD mappings', anchor: '#mappings' }
            ];
            if (crd.length) nextItems.push({ text: 'Install the required CRDs', anchor: '#installation' });
            nextItems.push({ text: 'Check the NGINX Ingress Controller docs', href: 'https://docs.nginx.com/nginx-ingress-controller/', external: true });

            return {
                pills: pills,
                liveText: pills.map(function(p) { return p.text; }).join(', '),
                banner: banner,
                warnings: warnings,
                steps: steps,
                infoNotes: infoNotes,
                unsupported: unsupportedCards.length ? {
                    title: 'Unsupported features', countText: unsupportedCards.length + ' finding' + (unsupportedCards.length !== 1 ? 's' : ''),
                    desc: 'These HAProxy settings are recognized but have no NGINX Ingress Controller equivalent. Review each one and take the recommended action.',
                    cards: unsupportedCards
                } : null,
                unrecognized: unrecognised.length ? {
                    title: 'Unrecognized HAProxy configuration',
                    desc: 'These settings were not found in the migration database. They may be custom annotations (ValidationRules), HAProxy Enterprise only, or not yet mapped.',
                    items: unrecognised.map(function(u) {
                        if (u.where === 'ConfigMap') return { yaml: MigrationTool.yaml.stringify({ data: { [u.name]: u.value } }, null, { quote: function() { return true; } }).replace(/\n$/, '') };
                        if (u.where === 'Ingress' || u.where === 'Service') return { yaml: (u.where === 'Service' ? '# on a Service\n' : '') + MigrationTool.yaml.stringify({ annotations: { [u.key]: u.value } }, null, { quote: function() { return true; } }).replace(/\n$/, '') };
                        return { yaml: '# ' + u.name };
                    })
                } : null,
                export: parts.length ? { parts: parts } : null,
                nextItems: nextItems,
                // For nic-migrate: the assembled resources, untouched by formatting.
                resources: resources.map(function(r) { return { doc: r.doc, comments: r.comments, ingress: r.model ? r.model.name : null, namespace: r.model ? r.model.namespace : null }; }),
                configMap: cmDoc ? cmDoc.doc : null
            };
        }

        // Sample YAML presets
        let SAMPLE_PRESETS = {
            simple:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: web-app\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    haproxy.org/ssl-redirect: "true"\n' +
'    haproxy.org/load-balance: "roundrobin"\n' +
'    haproxy.org/check: "true"\n' +
'    haproxy.org/path-rewrite: "/app/(.*) /\\\\1"\n' +
'spec:\n' +
'  ingressClassName: haproxy\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /app\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: app-service\n' +
'                port:\n' +
'                  number: 80',
            moderate:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: web-app\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    haproxy.org/ssl-redirect: "true"\n' +
'    haproxy.org/load-balance: "roundrobin"\n' +
'    haproxy.org/check: "true"\n' +
'    haproxy.org/path-rewrite: "/app/(.*) /\\\\1"\n' +
'    haproxy.com/auth-type: "basic-auth"\n' +
'    haproxy.com/auth-secret: "default/app-auth"\n' +
'    haproxy.com/auth-realm: "Restricted Area"\n' +
'    haproxy.org/rate-limit-requests: "100"\n' +
'    haproxy.org/rate-limit-period: "1s"\n' +
'    haproxy.org/rate-limit-status-code: "429"\n' +
'spec:\n' +
'  ingressClassName: haproxy\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /app\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: app-service\n' +
'                port:\n' +
'                  number: 80\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: ConfigMap\n' +
'metadata:\n' +
'  name: haproxy-kubernetes-ingress\n' +
'  namespace: default\n' +
'data:\n' +
'  timeout-connect: "5s"\n' +
'  log-format: "%ci:%cp [%tr] %ft %b/%s %ST %B %tsc %ac/%fc/%bc/%sc"\n' +
'  ssl-redirect: "true"\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Service\n' +
'metadata:\n' +
'  name: app-service\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    ingress.kubernetes.io/check: "true"\n' +
'    ingress.kubernetes.io/cookie-persistence: "JSESSIONID"\n' +
'    haproxy.org/cr-backend: "app-backend"\n' +
'spec:\n' +
'  selector:\n' +
'    app: web\n' +
'  ports:\n' +
'    - port: 80\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Secret\n' +
'metadata:\n' +
'  name: app-auth\n' +
'  namespace: default\n' +
'type: Opaque\n' +
'data:\n' +
'  admin: JDFkYWRtaW5oYXNo\n' +
'  ops: JDFkb3BzaGFzaA==\n' +
'---\n' +
'apiVersion: ingress.v3.haproxy.org/v3\n' +
'kind: Backend\n' +
'metadata:\n' +
'  name: app-backend\n' +
'  namespace: default\n' +
'spec:\n' +
'  mode: http\n' +
'  balance:\n' +
'    algorithm: roundrobin\n' +
'  connect_timeout: 5000\n' +
'  server_timeout: 50000',
            advanced:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: web-app\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    haproxy.org/ssl-redirect: "true"\n' +
'    haproxy.org/load-balance: "roundrobin"\n' +
'    haproxy.org/check: "true"\n' +
'    haproxy.org/path-rewrite: "/app/(.*) /\\\\1"\n' +
'    haproxy.com/auth-type: "basic-auth"\n' +
'    haproxy.com/auth-secret: "default/app-auth"\n' +
'    haproxy.com/auth-realm: "Restricted Area"\n' +
'    haproxy.org/rate-limit-requests: "100"\n' +
'    haproxy.org/rate-limit-period: "1s"\n' +
'    haproxy.org/rate-limit-status-code: "429"\n' +
'    ingress.kubernetes.io/cors-enable: "true"\n' +
'    ingress.kubernetes.io/cors-allow-origin: "https://portal.example.com"\n' +
'    ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT"\n' +
'spec:\n' +
'  ingressClassName: haproxy\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /app\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: app-service\n' +
'                port:\n' +
'                  number: 80\n' +
'          # route-acl on app-canary picks requests for this host and path;\n' +
'          # HAProxy also needs the Service on a rule to route to it at all.\n' +
'          - path: /app\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: app-canary\n' +
'                port:\n' +
'                  number: 80\n' +
'---\n' +
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: passthrough-app\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    haproxy.org/ssl-passthrough: "true"\n' +
'spec:\n' +
'  ingressClassName: haproxy\n' +
'  rules:\n' +
'    - host: secure.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: secure-backend\n' +
'                port:\n' +
'                  number: 8443\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: ConfigMap\n' +
'metadata:\n' +
'  name: haproxy-kubernetes-ingress\n' +
'  namespace: default\n' +
'data:\n' +
'  timeout-connect: "5s"\n' +
'  log-format: "%ci:%cp [%tr] %ft %b/%s %ST %B %tsc %ac/%fc/%bc/%sc"\n' +
'  ssl-redirect: "true"\n' +
'  client-ca: "default/ca-secret"\n' +
'  cr-global: "default/global-config"\n' +
'  cr-defaults: "default/app-defaults"\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: ConfigMap\n' +
'metadata:\n' +
'  name: tcp-services\n' +
'  namespace: default\n' +
'data:\n' +
'  "5432": "databases/postgres:5432"\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Service\n' +
'metadata:\n' +
'  name: app-service\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    ingress.kubernetes.io/check: "true"\n' +
'    ingress.kubernetes.io/cookie-persistence: "JSESSIONID"\n' +
'    haproxy.org/cr-backend: "app-backend"\n' +
'spec:\n' +
'  selector:\n' +
'    app: web\n' +
'  ports:\n' +
'    - port: 80\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Service\n' +
'metadata:\n' +
'  name: app-canary\n' +
'  namespace: default\n' +
'  annotations:\n' +
'    haproxy.org/route-acl: "rand(100) lt 25"\n' +
'spec:\n' +
'  selector:\n' +
'    app: web-canary\n' +
'  ports:\n' +
'    - port: 80\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Secret\n' +
'metadata:\n' +
'  name: app-auth\n' +
'  namespace: default\n' +
'type: Opaque\n' +
'data:\n' +
'  admin: JDFkYWRtaW5oYXNo\n' +
'  ops: JDFkb3BzaGFzaA==\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Secret\n' +
'metadata:\n' +
'  name: ca-secret\n' +
'  namespace: default\n' +
'type: Opaque\n' +
'data:\n' +
'  tls.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t\n' +
'---\n' +
'apiVersion: ingress.v3.haproxy.org/v3\n' +
'kind: Backend\n' +
'metadata:\n' +
'  name: app-backend\n' +
'  namespace: default\n' +
'spec:\n' +
'  mode: http\n' +
'  balance:\n' +
'    algorithm: roundrobin\n' +
'  connect_timeout: 5000\n' +
'  server_timeout: 50000\n' +
'---\n' +
'apiVersion: ingress.v3.haproxy.org/v3\n' +
'kind: TCP\n' +
'metadata:\n' +
'  name: mysql-tcp\n' +
'  namespace: default\n' +
'spec:\n' +
'  - name: mysql\n' +
'    frontend:\n' +
'      name: fe-mysql\n' +
'      binds:\n' +
'        - name: v4\n' +
'          port: 3306\n' +
'    service:\n' +
'      name: mysql\n' +
'      port: 3306\n' +
'---\n' +
'apiVersion: ingress.v3.haproxy.org/v3\n' +
'kind: Global\n' +
'metadata:\n' +
'  name: global-config\n' +
'  namespace: default\n' +
'spec:\n' +
'  maxconn: 60000\n' +
'  nbthread: 4\n' +
'---\n' +
'apiVersion: ingress.v3.haproxy.org/v3\n' +
'kind: Defaults\n' +
'metadata:\n' +
'  name: app-defaults\n' +
'  namespace: default\n' +
'spec:\n' +
'  server_timeout: 50000\n' +
'  connect_timeout: 5000\n' +
'  retries: 3'
        };

        // --- Source config consumed by migration-core.js ---
        window.MIGRATION_SOURCE = {
            id: 'haproxy',
            strings: {
                analyzeEmpty: { title: 'No input.', message: 'Paste HAProxy resources (annotated Ingress/Service, the controller ConfigMap, or Global/Defaults/Backend/TCP CRs) to analyze.' },
                noFindings: { title: 'No HAProxy configuration found.', message: 'Make sure your YAML contains haproxy.org/ annotations (on Ingress or Service objects), the HAProxy controller ConfigMap, or ingress.v1/v3.haproxy.org custom resources.' },
                emptyStateLead: 'Paste your HAProxy YAML above and click Analyze',
                emptyStateHint: 'Drag & drop a .yaml file, or try "Load Sample" for an example',
                pageNames: { 'getting-started': 'Getting started', analyzer: 'Config analyzer', reference: 'Reference guide' }
            },
            versionBindings: [
                { attr: 'data-haproxy-version', text: HAPROXY_VERSION },
                { attr: 'data-haproxy-release-link', href: HAPROXY_RELEASE_URL }
            ],
            inputStatus: { pattern: /haproxy\.org\/|haproxy\.com\/|ingress\.kubernetes\.io\/|ingress\.v[13]\.haproxy\.org/g, noun: 'HAProxy item' },
            reference: {
                sections: [
                    { id: 'mappings', filterSource: 'oss', search: 'searchInput', category: 'categoryFilter', count: 'searchCount' },
                    { id: 'plus-mappings', filterSource: 'plus', search: 'searchInputPlus', category: 'categoryFilterPlus', count: 'searchCountPlus' },
                    { id: 'configmap-mappings', filterSource: 'configmap', search: 'searchInputConfigMap', category: 'categoryFilterConfigMap', count: 'searchCountConfigMap' },
                    { id: 'crd-mappings', filterSource: 'crd', search: 'searchInputCrd', category: 'categoryFilterCrd', count: 'searchCountCrd' },
                    { id: 'flag-mappings', filterSource: 'flags', search: 'searchInputFlags', category: 'categoryFilterFlags', count: 'searchCountFlags' }
                ],
                sectionPageMap: {
                    overview: 'getting-started', 'why-migrate': 'getting-started', features: 'getting-started', installation: 'getting-started', checklist: 'getting-started', 'phased-migration': 'getting-started', cli: 'getting-started', resources: 'getting-started',
                    differences: 'reference', 'mappings': 'reference', 'plus-mappings': 'reference', 'configmap-mappings': 'reference', 'crd-mappings': 'reference', 'flag-mappings': 'reference'
                },
                defaultPage: 'getting-started',
                fallbackPage: 'reference'
            },
            storage: { checklist: 'haproxyMigrationChecklist' },
            analyzer: {
                strategies: {
                    initial: 'crd',
                    descriptions: {
                        annotation: 'Swap to nginx.org/* annotations where possible, use CRDs only when needed',
                        crd: 'Prefer Policy CRDs and VirtualServer — HAProxy CRs always convert to NGINX Ingress Controller resources'
                    }
                },
                samplePresets: SAMPLE_PRESETS,
                defaultPreset: 'moderate',
                parseInput: parseInput,
                buildPlan: buildPlan,
                mappings: HAPROXY_MAPPINGS,
                // The per-Ingress assembler, for nic-migrate: one parsed Ingress
                // in, resolved against the rest of the run (the Services it
                // routes to, the HAProxy ConfigMap, the CRs), its resources and
                // notes out. The page goes through buildPlan.
                migrate: function(doc, strategy, options, runDocs) {
                    let run = runOf(runDocs || [doc]);
                    return migrateIngress(ingressModel(doc), run, strategy, options || {});
                },
                // Every Ingress of a run, and the run's global settings: a
                // route-acl Ingress folds into the VirtualServer of the Ingress
                // that serves its host. Returns [{ doc, out, mergedInto }] and,
                // as .controller, the ConfigMap keys, GlobalConfiguration and
                // TransportServers the run needs.
                migrateMany: function(docs, strategy, options, runDocs) {
                    let run = runOf(runDocs || docs);
                    run.ingresses = docs.map(ingressModel);
                    let all = migrateAll({ run: run }, strategy, options || {});
                    let outs = all.results.map(function(r, i) {
                        return { doc: docs[i], out: r.out, mergedInto: r.mergedInto ? all.results.indexOf(r.mergedInto) : null };
                    });
                    outs.controller = all.controller;
                    return outs;
                }
            },
            export: {
                filename: 'haproxy-nginx-migration.yaml',
                header: '# HAProxy to NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/haproxy-migration.html'
            }
        };
    })();
