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

        // Thin call-time delegates to the shared core utilities — migration-core.js
        // loads after this file, so MigrationTool must only be dereferenced inside
        // function bodies, never at top level.
        function splitDocuments(yamlText) { return MigrationTool.util.splitDocuments(yamlText); }
        function stripInlineComment(s) { return MigrationTool.util.stripInlineComment(s); }
        function formatYamlKV(indent, key, value) { return MigrationTool.util.formatYamlKV(indent, key, value); }

        // --- Minimal YAML subset parser ---------------------------------------
        // HAProxy input mixes annotated Ingress/Service objects, the controller
        // ConfigMap, and structured CRDs (Global/Defaults/Backend/Frontend/TCP),
        // so this source needs real nesting (same parser as migration-traefik.js).
        // Supported subset: block maps + sequences by indentation, quoted and
        // plain scalars, inline comments, block scalars (| and >), and simple
        // one-line flow collections ({ k: v }, [a, b]). No anchors/aliases or
        // multi-line flow — the core's generic syntax warnings already tell the
        // user to pre-render those.

        function parseScalar(raw) {
            let s = stripInlineComment(raw).trim();
            if (s === '') return '';
            if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
                return s.slice(1, -1);
            }
            if (s === 'true') return true;
            if (s === 'false') return false;
            if (s === 'null' || s === '~') return null;
            if (/^-?\d+$/.test(s)) return parseInt(s, 10);
            if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
            return s;
        }

        // One-line flow collections: { k: v, k2: v2 } and [a, b, c] (no nesting).
        function parseFlowValue(s) {
            let t = s.trim();
            if (t[0] === '{' && t[t.length - 1] === '}') {
                let obj = {};
                let body = t.slice(1, -1).trim();
                if (body === '') return obj;
                body.split(',').forEach(function(pair) {
                    let ci = pair.indexOf(':');
                    if (ci === -1) return;
                    obj[parseScalar(pair.slice(0, ci))] = parseScalar(pair.slice(ci + 1));
                });
                return obj;
            }
            if (t[0] === '[' && t[t.length - 1] === ']') {
                let body = t.slice(1, -1).trim();
                if (body === '') return [];
                return body.split(',').map(parseScalar);
            }
            return undefined;
        }

        // Collect a | or > block scalar starting after line index i; returns
        // { value, nextIndex }.
        function readBlockScalar(lines, i, keyIndent) {
            let blockLines = [];
            let blockIndent = -1;
            let j = i + 1;
            for (; j < lines.length; j++) {
                let line = lines[j];
                if (line.trim() === '') { blockLines.push(''); continue; }
                let indent = line.length - line.trimStart().length;
                if (blockIndent === -1) {
                    if (indent <= keyIndent) break;
                    blockIndent = indent;
                }
                if (indent < blockIndent) break;
                blockLines.push(line.substring(blockIndent));
            }
            // Trim trailing blank lines the loop may have collected past the block.
            while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
            return { value: blockLines.join('\n'), nextIndex: j - 1 };
        }

        // Parse the block starting at lines[start] where every line of the block
        // has indentation >= indent; returns { value, nextIndex }.
        function parseBlock(lines, start, indent) {
            // Peek at the first content line to decide map vs sequence.
            let i = start;
            while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
            if (i >= lines.length) return { value: null, nextIndex: lines.length - 1 };
            let firstIndent = lines[i].length - lines[i].trimStart().length;
            if (firstIndent < indent) return { value: null, nextIndex: i - 1 };
            let isSeq = lines[i].trimStart().startsWith('- ') || lines[i].trimStart() === '-';
            return isSeq ? parseSequence(lines, i, firstIndent) : parseMap(lines, i, firstIndent);
        }

        function parseMap(lines, start, indent) {
            let obj = {};
            let i = start;
            for (; i < lines.length; i++) {
                let line = lines[i];
                let trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith('#')) continue;
                let curIndent = line.length - line.trimStart().length;
                if (curIndent < indent) { i--; break; }
                if (curIndent > indent) { i--; break; } // malformed deeper line without key — stop
                if (trimmed.startsWith('- ') || trimmed === '-') { i--; break; }
                // A colon only introduces a mapping when followed by whitespace/EOL
                // (plain scalars like IPv6 addresses contain bare colons).
                let m = line.trimStart().match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s][^:]*)\s*:(?:\s+(.*))?$/);
                if (!m) continue;
                let key = parseScalar(m[1]);
                let rest = stripInlineComment(m[2] || '').trim();
                if (rest === '') {
                    // Nested block (map/sequence) or empty value.
                    let nested = parseBlock(lines, i + 1, curIndent + 1);
                    if (nested.value === null) {
                        // kubectl-style zero-indent sequences: items sit at the SAME
                        // indent as their key — accept them when the next content
                        // line is a dash at this indent.
                        let j = i + 1;
                        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
                        if (j < lines.length) {
                            let jIndent = lines[j].length - lines[j].trimStart().length;
                            let jTrim = lines[j].trimStart();
                            if (jIndent === curIndent && (jTrim.startsWith('- ') || jTrim === '-')) {
                                nested = parseSequence(lines, j, curIndent);
                            }
                        }
                    }
                    obj[key] = nested.value;
                    i = nested.nextIndex;
                } else if (/^[|>][+-]?\s*$/.test(m[2].trim())) {
                    let block = readBlockScalar(lines, i, curIndent);
                    obj[key] = block.value;
                    i = block.nextIndex;
                } else {
                    let flow = parseFlowValue(rest);
                    obj[key] = flow !== undefined ? flow : parseScalar(rest);
                }
            }
            return { value: obj, nextIndex: i };
        }

        function parseSequence(lines, start, indent) {
            let arr = [];
            let i = start;
            for (; i < lines.length; i++) {
                let line = lines[i];
                let trimmed = line.trim();
                if (trimmed === '' || trimmed.startsWith('#')) continue;
                let curIndent = line.length - line.trimStart().length;
                if (curIndent < indent) { i--; break; }
                if (curIndent > indent) { i--; break; }
                if (!(trimmed.startsWith('- ') || trimmed === '-')) { i--; break; }
                let rest = trimmed === '-' ? '' : trimmed.substring(2).replace(/^\s+/, '');
                let restStripped = stripInlineComment(rest).trim();
                if (restStripped === '') {
                    let nested = parseBlock(lines, i + 1, curIndent + 1);
                    arr.push(nested.value);
                    i = Math.max(nested.nextIndex, i);
                } else if (/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s][^:]*)\s*:(?:\s|$)/.test(restStripped) && parseFlowValue(restStripped) === undefined) {
                    // "- key: value" — inline first key of a nested map. Re-parse the
                    // item as a map by virtually shifting the dash into indentation.
                    let itemIndent = curIndent + 2;
                    let virtual = lines.slice(0, i).concat([' '.repeat(itemIndent) + rest], lines.slice(i + 1));
                    let nested = parseMap(virtual, i, itemIndent);
                    arr.push(nested.value);
                    // Guarantee forward progress even if the nested parse bails
                    // immediately (malformed input must never loop forever).
                    i = Math.max(nested.nextIndex, i);
                } else {
                    let flow = parseFlowValue(restStripped);
                    arr.push(flow !== undefined ? flow : parseScalar(restStripped));
                }
            }
            return { value: arr, nextIndex: i };
        }

        function parseYamlDocument(docText) {
            let lines = docText.split('\n');
            let hasContent = lines.some(function(l) { let t = l.trim(); return t !== '' && !t.startsWith('#'); });
            if (!hasContent) return null;
            let parsed = parseBlock(lines, 0, 0);
            return (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) ? parsed.value : null;
        }

        // --- Value conversion helpers ------------------------------------------

        // HAProxy time values: bare integers are MILLISECONDS; unit-bearing values
        // (us/ms/s/m/h/d) pass through. NGINX time strings default to seconds, so
        // bare ms counts must be converted explicitly.
        function haproxyTimeToNginx(v) {
            let s = String(v == null ? '' : v).trim();
            let m = s.match(/^(\d+)(us|ms|s|m|h|d)?$/);
            if (!m) return { value: s, note: null };
            let n = parseInt(m[1], 10);
            let unit = m[2];
            if (!unit) return msToNginxTime(n);
            if (unit === 'us') {
                // nginx has no microsecond unit — round up to at least 1ms.
                return { value: Math.max(1, Math.round(n / 1000)) + 'ms', note: 'converted from ' + s + ' (HAProxy microseconds)' };
            }
            return { value: n + unit, note: null };
        }

        // int64 milliseconds (CRD timeout fields, bare-annotation times) → nginx time.
        function msToNginxTime(ms) {
            let n = parseInt(ms, 10);
            if (isNaN(n)) return { value: String(ms), note: null };
            if (n % 3600000 === 0 && n >= 3600000) return { value: (n / 3600000) + 'h', note: 'converted from ' + n + 'ms' };
            if (n % 60000 === 0 && n >= 60000) return { value: (n / 60000) + 'm', note: 'converted from ' + n + 'ms' };
            if (n % 1000 === 0) return { value: (n / 1000) + 's', note: 'converted from ' + n + 'ms' };
            return { value: n + 'ms', note: 'HAProxy bare times are milliseconds' };
        }

        // HAProxy duration → integer seconds (cors-max-age & friends; bare = ms).
        function haproxyTimeToSeconds(v) {
            let s = String(v == null ? '' : v).trim();
            let m = s.match(/^(\d+)(us|ms|s|m|h|d)?$/);
            if (!m) return null;
            let n = parseInt(m[1], 10);
            switch (m[2]) {
                case 'us': return Math.round(n / 1000000);
                case 'ms': case undefined: return Math.round(n / 1000);
                case 's': return n;
                case 'm': return n * 60;
                case 'h': return n * 3600;
                case 'd': return n * 86400;
            }
            return null;
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
        //   rand(100) lt 25                      → percentage split
        //   cookie(NAME) -m str V / req.cook(..) → cookie condition
        //   hdr(NAME) -m str V / req.hdr(..)     → header condition
        //   urlp(NAME) -m str V / url_param(..)  → query-argument condition
        //   method GET / method(GET)             → $request_method condition
        //   src 10.0.0.0/8 192.168.0.0/16        → CIDR list (accessControl Policy)
        function parseRouteACL(value) {
            let s = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
            let m;
            if ((m = s.match(/^rand\((\d+)\)\s+(lt|le|gt|ge)\s+(\d+)$/i))) {
                let base = parseInt(m[1], 10) || 100;
                let n = parseInt(m[3], 10);
                let pct = Math.round((n / base) * 100);
                // gt/ge select the complement of the low range.
                if (/^g/i.test(m[2])) pct = 100 - pct;
                pct = Math.min(100, Math.max(0, pct));
                return { kind: 'rand', pct: pct, raw: s };
            }
            if ((m = s.match(/^(?:req\.cook|cookie)\(([^)]+)\)(?:\s+-m\s+(str|beg|reg)\s+(.+))?$/i))) {
                if (m[2] && m[2].toLowerCase() !== 'str') return { kind: 'untranslatable', raw: s, why: '-m ' + m[2] + ' cookie matching' };
                return { kind: 'cookie', name: m[1].trim(), value: m[3] ? m[3].trim() : null, raw: s };
            }
            if ((m = s.match(/^(?:req\.hdr|hdr)\(([^)]+)\)(?:\s+-m\s+(str|beg|reg)\s+(.+))?$/i))) {
                if (m[2] && m[2].toLowerCase() !== 'str') return { kind: 'untranslatable', raw: s, why: '-m ' + m[2] + ' header matching' };
                return { kind: 'header', name: m[1].trim(), value: m[3] ? m[3].trim() : null, raw: s };
            }
            if ((m = s.match(/^(?:urlp|url_param)\(([^)]+)\)(?:\s+-m\s+(str|beg|reg)\s+(.+))?$/i))) {
                if (m[2] && m[2].toLowerCase() !== 'str') return { kind: 'untranslatable', raw: s, why: '-m ' + m[2] + ' query matching' };
                return { kind: 'arg', name: m[1].trim(), value: m[3] ? m[3].trim() : null, raw: s };
            }
            if ((m = s.match(/^method(?:\(([A-Za-z]+)\)|\s+([A-Za-z]+))$/i))) {
                return { kind: 'method', value: (m[1] || m[2]).toUpperCase(), raw: s };
            }
            if ((m = s.match(/^src\s+(.+)$/i))) {
                let cidrs = m[1].split(/[\s,]+/).filter(function(c) { return c !== ''; });
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
         'global-config-snippet', 'frontend-config-snippet', 'stats-config-snippet'
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

        // Extract host/service/port/path basics plus routing details from a plain
        // Ingress document (drives generated example resources and the pathType /
        // wildcard-host guidance notes).
        function extractIngressBasics(doc) {
            let spec = doc.spec || {};
            let basics = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: (doc.metadata && doc.metadata.name) || null };
            let details = { paths: [], hosts: [], hasDefaultBackend: !!spec.defaultBackend, ingressClassName: spec.ingressClassName || null };
            let rules = Array.isArray(spec.rules) ? spec.rules : [];
            rules.forEach(function(rule) {
                if (!rule) return;
                if (rule.host) details.hosts.push(String(rule.host));
                let paths = (rule.http && Array.isArray(rule.http.paths)) ? rule.http.paths : [];
                paths.forEach(function(p) {
                    if (!p) return;
                    details.paths.push({ path: p.path || '/', pathType: p.pathType || 'ImplementationSpecific' });
                });
            });
            if (rules.length > 0 && rules[0]) {
                basics.host = rules[0].host || null;
                let paths = (rules[0].http && Array.isArray(rules[0].http.paths)) ? rules[0].http.paths : [];
                if (paths.length > 0 && paths[0]) {
                    basics.path = paths[0].path || null;
                    let backend = paths[0].backend || {};
                    let svc = backend.service || {};
                    basics.serviceName = svc.name || backend.serviceName || null;
                    let port = svc.port || {};
                    basics.servicePort = (typeof port === 'object' ? (port.number || port.name) : port) || backend.servicePort || null;
                }
            }
            let tls = Array.isArray(spec.tls) ? spec.tls : [];
            if (tls.length > 0 && tls[0] && tls[0].secretName) basics.tlsSecret = tls[0].secretName;
            return { basics: basics, details: details };
        }

        // A tcp-services ConfigMap entry: "<ns>/<svc>:<port>[:ssl]" keyed by listen port.
        function parseTcpServiceEntry(key, value) {
            if (!/^\d+$/.test(String(key))) return null;
            let m = String(value).trim().match(/^(\S+)\/(\S+):(\d+)(:ssl)?$/);
            if (!m) return null;
            return { listenPort: parseInt(key, 10), namespace: m[1], service: m[2], servicePort: parseInt(m[3], 10), ssl: !!m[4] };
        }

        function parseInput(yamlText) {
            let docs = splitDocuments(yamlText);
            let context = {
                ingresses: [],
                services: [],
                configMaps: [],
                firstIngressBasics: null
            };
            let findings = [];
            let warnings = [];
            let sawV1Api = false;
            let sawServiceScope = false;
            let sawHaproxyResource = false;

            docs.forEach(function(docText, docIndex) {
                let doc;
                try { doc = parseYamlDocument(docText); } catch (e) { doc = null; }
                if (!doc || typeof doc !== 'object' || !doc.kind) return;
                let kind = String(doc.kind);
                let apiVersion = String(doc.apiVersion || '');
                let name = (doc.metadata && doc.metadata.name) || (kind.toLowerCase() + '-' + (docIndex + 1));
                let raw = docText.replace(/^\n+|\n+$/g, '');
                let annotations = (doc.metadata && doc.metadata.annotations) || {};

                function addFinding(key, label, value, data) {
                    findings.push({ key: key, label: label, value: value != null ? String(value) : '', docIndex: docIndex, resourceName: name, kind: kind, data: data || null, raw: raw });
                }

                // Collect haproxy.org/haproxy.com/ingress.kubernetes.io annotations
                // on this object; scope is 'ingress' or 'service'.
                function scanAnnotations(scope, extraData) {
                    let found = [];
                    Object.keys(annotations).forEach(function(k) {
                        let suffix = haproxySuffix(k);
                        if (suffix === null) {
                            // The legacy class annotation is HAProxy-relevant despite
                            // its kubernetes.io prefix.
                            if (k === 'kubernetes.io/ingress.class') suffix = 'ingress.class';
                            else return;
                        }
                        found.push({ suffix: suffix, value: annotations[k], originalKey: k });
                        let data = { scope: scope, value: annotations[k] };
                        for (let dk in extraData) data[dk] = extraData[dk];
                        addFinding(canonicalKey(suffix), k, annotations[k], data);
                        if (scope === 'service') sawServiceScope = true;
                    });
                    if (found.length > 0) sawHaproxyResource = true;
                    return found;
                }

                switch (kind) {
                    case 'Ingress': {
                        let extracted = extractIngressBasics(doc);
                        let found = scanAnnotations('ingress', { basics: extracted.basics });
                        context.ingresses.push({ name: name, annotations: found, basics: extracted.basics, raw: raw });
                        if (!context.firstIngressBasics) context.firstIngressBasics = extracted.basics;
                        // Spec-level guidance (pathType boundary trap, wildcard hosts,
                        // defaultBackend, ingressClassName) only fires when the Ingress
                        // is HAProxy-flavored (annotations or an haproxy class).
                        let cls = extracted.details.ingressClassName || annotations['kubernetes.io/ingress.class'] || '';
                        let isHaproxy = found.length > 0 || /haproxy/i.test(String(cls));
                        if (isHaproxy) {
                            addFinding('kind:Ingress', 'Ingress ' + name + ' (spec)', '', { basics: extracted.basics, details: extracted.details });
                        }
                        break;
                    }
                    case 'Service': {
                        let found = scanAnnotations('service', { serviceName: name });
                        if (found.length > 0) context.services.push({ name: name, annotations: found });
                        break;
                    }
                    case 'ConfigMap': {
                        let data = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : {};
                        let keys = Object.keys(data);
                        let tcpEntries = [];
                        let optionKeys = [];
                        keys.forEach(function(k) {
                            let entry = parseTcpServiceEntry(k, data[k]);
                            if (entry) tcpEntries.push(entry);
                            else optionKeys.push(k);
                        });
                        let recognized = optionKeys.filter(function(k) { return HAPROXY_LOOKUP.has(canonicalKey(k)); });
                        // Only treat the document as HAProxy controller config when it
                        // looks like it (named haproxy-*, tcp-services entries, or
                        // recognized option keys) — arbitrary app ConfigMaps are skipped.
                        let isHaproxyCm = /haproxy/i.test(name) || tcpEntries.length > 0 || recognized.length > 0;
                        if (!isHaproxyCm) return;
                        sawHaproxyResource = true;
                        context.configMaps.push({ name: name, data: data });
                        if (tcpEntries.length > 0) {
                            addFinding('configmap:tcp-services', 'ConfigMap ' + name + ' (tcp-services)', '', { entries: tcpEntries });
                        }
                        optionKeys.forEach(function(k) {
                            addFinding(canonicalKey(k), k, data[k], { scope: 'configmap', value: data[k] });
                        });
                        break;
                    }
                    default: {
                        if (HAPROXY_CRD_API.test(apiVersion)) {
                            sawHaproxyResource = true;
                            let isV1 = apiVersion.indexOf('ingress.v1.') === 0;
                            if (isV1) sawV1Api = true;
                            let spec = doc.spec || {};
                            // v1 wraps the client-native config under spec.config (Global
                            // also spec.log_targets; Backend also spec.acls +
                            // spec.http-requests); v3 inlines fields under spec.
                            let config = spec;
                            if (isV1 && kind !== 'TCP') {
                                config = (spec.config && typeof spec.config === 'object') ? spec.config : {};
                                if (kind === 'Global' && spec.log_targets) config.log_targets = spec.log_targets;
                                if (kind === 'Backend') {
                                    if (spec.acls) config.acl_list = spec.acls;
                                    if (spec['http-requests']) config.http_request_rule_list = spec['http-requests'];
                                }
                            }
                            if (HAPROXY_CRD_KINDS[kind]) {
                                addFinding('kind:' + kind, kind + ' ' + name, '', { name: name, config: config, spec: spec, isV1: isV1 });
                            } else {
                                // Unknown kinds in the haproxy.org API groups surface as
                                // unrecognized findings.
                                addFinding('kind:' + kind, kind + ' ' + name, '', null);
                            }
                        }
                        // Non-HAProxy resources (Deployments, Secrets, …) are ignored.
                    }
                }
            });

            if (sawV1Api) {
                warnings.push({
                    title: 'ingress.v1.haproxy.org apiVersion detected',
                    message: 'Resources using the legacy `ingress.v1.haproxy.org/v1` group were parsed (fields read from `spec.config`), but this tool documents the current `ingress.v3.haproxy.org/v3` shapes — verify field names against your CRD version before migrating.'
                });
            }
            if (sawServiceScope) {
                warnings.push({
                    title: 'Service-scoped annotations detected',
                    message: 'HAProxy reads config annotations from Service objects (highest precedence); the F5 NGINX Ingress Controller does not. The generated migration moves these settings to Ingress annotations, Policies, or the NGINX ConfigMap — review which resource each setting landed on.'
                });
            }

            return {
                findings: findings,
                context: context,
                warnings: warnings,
                foundCount: findings.length,
                sawHaproxyResource: sawHaproxyResource
            };
        }

        // --- NIC resource generators -------------------------------------------
        // Each generator returns { swaps: [], configMap: [], crds: [{kind, yaml}], notes: [{code, message}] }
        // (all optional). Grouped entries get (findings[], context, strategy);
        // ungrouped get (finding, context, strategy).

        function contribution() { return { swaps: [], configMap: [], crds: [], notes: [] }; }

        function findingValue(findings, name) {
            let f = findings.find(function(x) { return x.key === 'annotation:' + name || x.key === 'configmap:' + name; });
            return f ? f.value : null;
        }
        function findingFor(findings, name) {
            return findings.find(function(x) { return x.key === 'annotation:' + name || x.key === 'configmap:' + name; }) || null;
        }
        function specHost(basics) { return (basics && basics.host) || '# TODO: Set your host'; }
        function specService(basics) { return (basics && basics.serviceName) || '# TODO: Set your service'; }
        function specPort(basics) { return (basics && basics.servicePort) || '80'; }
        function specPath(basics) { return (basics && basics.path) || '/'; }
        function basicsOf(finding, context) {
            return (finding && finding.data && finding.data.basics) || context.firstIngressBasics || null;
        }
        // Route a scalar option to the right target for its scope: ConfigMap key
        // when found in the controller ConfigMap, annotation swap otherwise.
        function emitScoped(out, finding, cmKey, annKey, value, note) {
            if (finding.data && finding.data.scope === 'configmap') {
                out.configMap.push({ fromLabel: finding.label + ' (ConfigMap)', to: cmKey, value: value, note: note || null });
            } else {
                out.swaps.push({ fromKey: finding.label, fromValue: finding.value, to: annKey, value: value, note: note || null });
            }
        }
        function policyAttachLines(names) {
            return ['', '# Attach via VirtualServer spec.policies, or on Ingress via:', '#   annotations:', '#     nginx.org/policies: "' + names + '"'];
        }
        function isPatternFileRef(v) { return /^patterns\//.test(String(v == null ? '' : v).trim()); }

        let GENERATORS = {

            // -- Access control & real IP --
            generateAccessControl: function(findings, context) {
                let out = contribution();
                let allowSrc = findingFor(findings, 'allow-list') || findingFor(findings, 'whitelist');
                let denySrc = findingFor(findings, 'deny-list') || findingFor(findings, 'blacklist');
                if (findingFor(findings, 'whitelist')) out.notes.push({ code: 'haproxy.org/whitelist', message: 'whitelist is a deprecated HAProxy alias of allow-list — the generated Policy covers both.' });
                if (findingFor(findings, 'blacklist')) out.notes.push({ code: 'haproxy.org/blacklist', message: 'blacklist is a deprecated HAProxy alias of deny-list — the generated Policy covers both.' });
                function buildPolicy(name, mode, rawValue) {
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + name, 'spec:', '  accessControl:', '    ' + mode + ':'];
                    if (isPatternFileRef(rawValue)) {
                        lines.push('      - # TODO: inline the IPs/CIDRs from ConfigMap pattern file "' + cmt(rawValue) + '"');
                    } else {
                        splitCommaList(rawValue).forEach(function(ip) { lines.push('      - ' + ip); });
                    }
                    return lines;
                }
                let names = [];
                let lines = [];
                if (allowSrc) {
                    lines = lines.concat(buildPolicy('access-control-allow', 'allow', allowSrc.value));
                    names.push('access-control-allow');
                }
                if (denySrc) {
                    // accessControl requires exactly one of allow/deny per Policy —
                    // an Ingress carrying both becomes two Policies.
                    if (lines.length > 0) lines.push('---');
                    lines = lines.concat(buildPolicy('access-control-deny', 'deny', denySrc.value));
                    names.push('access-control-deny');
                }
                if (lines.length === 0) return out;
                lines = lines.concat(policyAttachLines(names.join(',')));
                lines.push('# accessControl matches on $remote_addr — behind another proxy, also set the', '# real-ip ConfigMap keys (set-real-ip-from, real-ip-header, real-ip-recursive).');
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                if ((allowSrc && isPatternFileRef(allowSrc.value)) || (denySrc && isPatternFileRef(denySrc.value))) {
                    out.notes.push({ code: 'patterns/ file reference', message: 'NIC has no pattern-file indirection — copy the lines from the pattern-files ConfigMap into the Policy allow/deny list by hand.' });
                }
                return out;
            },

            generateSrcIpHeader: function(findings, context) {
                let out = contribution();
                let f = findings[0];
                out.configMap.push({ fromLabel: f.label, to: 'real-ip-header', value: f.value || '# TODO: header name', note: null });
                out.configMap.push({ fromLabel: f.label, to: 'set-real-ip-from', value: '# TODO: trusted proxy CIDRs', note: 'required — nginx ignores real-ip-header unless the peer is trusted' });
                out.configMap.push({ fromLabel: f.label, to: 'real-ip-recursive', value: 'True', note: null });
                out.notes.push({ code: 'haproxy.org/src-ip-header', message: 'Real-IP settings are controller-global in NIC (ConfigMap), not per-Ingress — one header applies to all applications.' });
                return out;
            },

            generateProxyProtocol: function(findings, context) {
                let out = contribution();
                let f = findings[0];
                out.configMap.push({ fromLabel: f.label + ' (inbound PROXY accept)', to: 'proxy-protocol', value: 'True', note: null });
                out.configMap.push({ fromLabel: f.label, to: 'set-real-ip-from', value: isPatternFileRef(f.value) ? '# TODO: inline CIDRs from pattern file "' + cmt(f.value) + '"' : (f.value || '# TODO: trusted CIDRs'), note: 'HAProxy CIDR accept-list scopes only real-IP trust here' });
                out.configMap.push({ fromLabel: f.label, to: 'real-ip-header', value: 'proxy_protocol', note: null });
                out.notes.push({ code: 'proxy-protocol (ConfigMap)', message: 'NIC enables PROXY protocol globally for all listeners — it cannot restrict acceptance to specific source IPs (HAProxy rejects non-listed senders with 400). Every connection reaching NGINX must then send a PROXY header.' });
                return out;
            },

            generateForwardedFor: function(findings, context) {
                let out = contribution();
                let f = findings[0];
                if (String(f.value).toLowerCase() === 'false') {
                    // The Ingress template hardcodes its own X-Forwarded-For line AFTER
                    // proxy-set-headers output, so only the VirtualServer override works.
                    out.notes.push({ code: f.label + ': "false"', message: 'NIC always sends X-Forwarded-For ($proxy_add_x_forwarded_for) — there is no disable toggle. Last-resort: override the header to an empty value via VirtualServer requestHeaders.set (the annotation nginx.org/proxy-set-headers CANNOT override it — the template\'s own X-Forwarded-For line renders after it and wins).' });
                } else {
                    out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'X-Forwarded-For is on by default in the F5 NGINX Ingress Controller — remove this annotation, no replacement needed.' });
                }
                return out;
            },

            // -- Authentication (HTTP Basic) --
            generateBasicAuth: function(findings, context, strategy) {
                let out = contribution();
                let secret = findingValue(findings, 'auth-secret');
                let realm = findingValue(findings, 'auth-realm') || 'Protected Content';
                // The Policy Secret must live in the Policy's own namespace — strip
                // an HAProxy <ns>/ prefix and remind the user to copy it over.
                let secretRef = secret ? String(secret) : null;
                let bareSecret = secretRef ? secretRef.replace(/^[^/]+\//, '') : '# TODO: Set your htpasswd secret';
                let crossNs = secretRef && secretRef.indexOf('/') !== -1;
                let conversion = [
                    '# HAProxy auth-secret Secrets store one key per user (value = base64 crypt(3) hash).',
                    '# NIC needs ONE htpasswd file in a Secret of type nginx.org/htpasswd:',
                    '#   type: nginx.org/htpasswd',
                    '#   data:',
                    '#     htpasswd: <base64 of "user1:hash1\\nuser2:hash2" lines>',
                    '# MD5-crypt ($1$) and apr1 ($apr1$) hashes port directly; SHA-crypt ($5$/$6$)',
                    '# works only where the host crypt() supports it.'
                ];
                if (strategy === 'annotation' && context.ingresses.length > 0) {
                    out.swaps.push({ fromLabel: 'haproxy.org/auth-secret' + (secretRef ? ': ' + cmt(secretRef) : ''), to: 'nginx.org/basic-auth-secret', value: bareSecret, note: crossNs ? 'Secret must be in the Ingress namespace — copy it (HAProxy allowed ' + cmt(secretRef) + ')' : 'convert the Secret to type nginx.org/htpasswd (key: htpasswd)' });
                    out.swaps.push({ fromLabel: 'haproxy.org/auth-realm', to: 'nginx.org/basic-auth-realm', value: realm, note: null });
                    out.notes.push({ code: 'auth-secret conversion', message: 'HAProxy auth-secret Secrets store one key per user (value = base64 crypt hash); NIC needs one htpasswd file in a Secret of type nginx.org/htpasswd under the key "htpasswd". MD5-crypt ($1$) and apr1 hashes port directly; SHA-crypt only where the host crypt() supports it.' });
                } else {
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: basic-auth-policy', 'spec:', '  basicAuth:', '    secret: ' + bareSecret + '  # must be type nginx.org/htpasswd, file under key "htpasswd"', '    realm: ' + yamlQuote(realm)];
                    lines = lines.concat(['', '# basicAuth Policies attach to VirtualServer/VirtualServerRoute only (NOT', '# nginx.org/policies on Ingress) — on a plain Ingress use the annotations', '# nginx.org/basic-auth-secret + nginx.org/basic-auth-realm instead.', '']).concat(conversion);
                    if (crossNs) lines.push('# The Secret must be in the same namespace as the Policy (HAProxy referenced ' + cmt(secretRef) + ').');
                    out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                }
                let authType = findingValue(findings, 'auth-type');
                if (authType && String(authType) !== 'basic-auth') {
                    out.notes.push({ code: 'haproxy.org/auth-type: ' + cmt(authType), message: 'Only "basic-auth" exists in HAProxy Kubernetes Ingress Controller — this value is unexpected; the migration assumes HTTP Basic authentication.' });
                }
                return out;
            },

            // -- Client mTLS --
            generateClientMTLS: function(findings, context) {
                let out = contribution();
                let ca = findingValue(findings, 'client-ca');
                let optional = String(findingValue(findings, 'client-crt-optional')).toLowerCase() === 'true';
                let bareSecret = ca ? String(ca).replace(/^[^/]+\//, '') : '# TODO: Set your CA secret';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: client-mtls-policy', 'spec:', '  ingressMTLS:',
                    '    clientCertSecret: ' + bareSecret + '  # re-create as type nginx.org/ca with the CA under key "ca.crt"',
                    // HAProxy verifies against client-ca even when the cert is optional,
                    // so "optional" (not optional_no_ca) preserves CA verification.
                    '    verifyClient: "' + (optional ? 'optional' : 'on') + '"  # client-crt-optional: ' + (optional ? 'true' : 'false (default — cert enforced)'),
                    '    verifyDepth: 1'];
                lines = lines.concat(policyAttachLines('client-mtls-policy'));
                lines.push('# HAProxy client-ca Secrets carry the CA under tls.crt — NIC needs a Secret of',
                    '# type nginx.org/ca with the bundle under ca.crt (optional CRL under ca.crl).',
                    '# Requires TLS termination on the host; failed verification returns HTTP 400.');
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                out.notes.push({ code: 'client-ca (ConfigMap)', message: 'Scope shift: HAProxy client mTLS is controller-global (ConfigMap); NIC ingressMTLS attaches per VirtualServer (spec.policies) or per Ingress (nginx.org/policies) — apply the Policy to every host that needs it. On mergeable Ingresses it must sit on the master.' });
                return out;
            },

            generateClientStrictSni: function(findings) {
                let out = contribution();
                let f = findings[0];
                if (String(f.value).toLowerCase() === 'true') {
                    out.notes.push({ code: f.label + ': "true"', message: 'NIC has no per-resource strict-SNI toggle — rejecting unknown SNI is the side effect of NOT deploying a default server certificate: leave the -default-server-tls-secret flag unset (NGINX then uses ssl_reject_handshake).' });
                } else {
                    out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'To serve a fallback certificate for unknown SNI, deploy one via the -default-server-tls-secret flag.' });
                }
                return out;
            },

            // -- Backend TLS / re-encryption --
            generateBackendMTLS: function(findings, context) {
                let out = contribution();
                let crt = findingValue(findings, 'server-crt');
                let ca = findingValue(findings, 'server-ca');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: backend-tls-policy', 'spec:', '  egressMTLS:'];
                if (crt) {
                    lines.push('    tlsSecret: ' + String(crt).replace(/^[^/]+\//, '') + '  # server-crt (kubernetes.io/tls, same namespace as the Policy)');
                }
                if (ca) {
                    lines.push('    trustedCertSecret: ' + String(ca).replace(/^[^/]+\//, '') + '  # server-ca — re-create as type nginx.org/ca, CA under key "ca.crt"');
                    lines.push('    verifyServer: true  # server-ca implies certificate verification (NIC default is false)');
                }
                if (!crt && !ca) lines.push('    tlsSecret: # TODO: client certificate Secret');
                lines = lines.concat(policyAttachLines('backend-tls-policy'));
                lines.push('# On a plain Ingress, egressMTLS only sets proxy_ssl_* — it does NOT switch the',
                    '# upstream to HTTPS. Always pair it with nginx.org/ssl-services (see the server-ssl row).');
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                return out;
            },

            generateServerSSL: function(findings, context) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (String(f.value).toLowerCase() !== 'true') {
                        out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'server-ssl is disabled — plaintext to the backend is the NIC default, no replacement needed.' });
                        return;
                    }
                    let svc = (f.data && f.data.serviceName) || specService(basicsOf(f, context));
                    out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/ssl-services', value: svc, note: 'proxy_pass https:// to this Service — like HAProxy server-ssl, the upstream certificate is NOT verified unless you add an egressMTLS Policy (server-ca)' });
                });
                return out;
            },

            generateServerProto: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (String(f.value).toLowerCase() === 'h2') {
                        out.notes.push({ code: f.label + ': "h2"', message: 'NIC speaks HTTP/2 to backends only for gRPC (nginx.org/grpc-services → grpc_pass, h2c; requires the http2 ConfigMap key and a TLS-terminated Ingress). Generic HTTP/2-to-backend has no equivalent — non-gRPC upstreams fall back to HTTP/1.1.' });
                    } else {
                        out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'No NIC equivalent for this backend protocol value — upstream connections use HTTP/1.1.' });
                    }
                });
                return out;
            },

            // -- Session persistence --
            generateCookiePersistence: function(findings, context) {
                let out = contribution();
                let dynamic = findingFor(findings, 'cookie-persistence');
                let literal = findingFor(findings, 'cookie-persistence-no-dynamic');
                let f = dynamic || literal;
                let cookieName = f && f.value ? String(f.value) : 'SERVERID';
                let basics = basicsOf(f, context);
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: sticky-app', 'spec:',
                    '  host: ' + specHost(basics), '  upstreams:', '    - name: backend', '      service: ' + specService(basics), '      port: ' + specPort(basics),
                    '      sessionCookie:', '        enable: true', '        name: ' + cookieName + '  # ' + cmt(f.label),
                    // HAProxy inserts a session cookie (no Expires) — omit expires to match.
                    '        path: /',
                    '  routes:', '    - path: ' + specPath(basics), '      action:', '        pass: backend'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                if (literal) {
                    out.notes.push({ code: 'haproxy.org/cookie-persistence-no-dynamic', message: 'HAProxy writes the literal server name as the cookie value; NIC always uses an opaque hashed identifier (functionally equivalent, cross-replica-safe — the raw-name mode is not reproducible).' });
                }
                if (dynamic && dynamic.data && dynamic.data.scope === 'ingress') {
                    out.notes.push({ code: 'cookie-persistence (Ingress scope)', message: 'HAProxy deprecates cookie-persistence at Ingress scope (use Service/ConfigMap) — moot after migrating to the VirtualServer sessionCookie above.' });
                }
                return out;
            },

            // -- Rate limiting --
            generateRateLimit: function(findings, context, strategy) {
                let out = contribution();
                let requests = findingValue(findings, 'rate-limit-requests');
                let period = findingValue(findings, 'rate-limit-period');
                let statusCode = findingValue(findings, 'rate-limit-status-code');
                let size = findingValue(findings, 'rate-limit-size');
                // rate = requests per period; NGINX only has r/s and r/m.
                let secs = period != null ? haproxyTimeToSeconds(period) : 1;
                if (secs == null) secs = 1;
                let reqNum = parseInt(requests, 10);
                let rate, rateNote = null;
                if (isNaN(reqNum)) {
                    rate = '# TODO: Set your rate (e.g. 100r/s)';
                } else if (secs === 60) {
                    rate = reqNum + 'r/m';
                } else if (secs === 1) {
                    rate = reqNum + 'r/s';
                } else if (secs > 0) {
                    rate = Math.max(1, Math.round(reqNum / secs)) + 'r/s';
                    rateNote = 'normalized from ' + reqNum + ' requests per ' + cmt(period) + ' — NGINX rates are per second or per minute only';
                } else {
                    rate = reqNum + 'r/s';
                }
                let reject = statusCode ? String(parseInt(statusCode, 10)) : '403';
                let zone = '10M';
                let zoneNote = size ? 'rate-limit-size counts tracked IPs (' + cmt(size) + '); NIC zoneSize is memory (~16k states per 1M)' : null;
                if (strategy === 'annotation' && context.ingresses.length > 0) {
                    out.swaps.push({ fromLabel: 'haproxy.org/rate-limit-requests' + (period ? ' + rate-limit-period' : ''), to: 'nginx.org/limit-req-rate', value: rate, note: rateNote });
                    out.swaps.push({ fromLabel: 'HAProxy hard-deny (no queue)', to: 'nginx.org/limit-req-burst', value: '0', note: 'stick-table limiting does not queue — burst 0 mimics the hard deny' });
                    out.swaps.push({ fromLabel: 'haproxy.org/rate-limit-status-code', to: 'nginx.org/limit-req-reject-code', value: reject, note: 'HAProxy default 403; NIC default would be 503 — set explicitly' });
                    if (size) out.swaps.push({ fromLabel: 'haproxy.org/rate-limit-size', to: 'nginx.org/limit-req-zone-size', value: zone, note: zoneNote });
                } else {
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: rate-limit-policy', 'spec:', '  rateLimit:',
                        '    rate: ' + rate + (rateNote ? '  # ' + rateNote : '  # rate-limit-requests / rate-limit-period'),
                        '    burst: 0  # HAProxy stick-table limiting hard-denies (no queue)',
                        '    key: ${binary_remote_addr}  # HAProxy tracks src',
                        '    zoneSize: ' + zone + (zoneNote ? '  # ' + zoneNote : ''),
                        '    rejectCode: ' + reject + '  # HAProxy default 403 (NIC default is 503 — always set explicitly)',
                        '', '# rateLimit Policies attach to VirtualServer/VirtualServerRoute only (NOT', '# nginx.org/policies on Ingress) — on a plain Ingress use the annotations', '# nginx.org/limit-req-rate, nginx.org/limit-req-burst, nginx.org/limit-req-reject-code instead.'];
                    out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                }
                out.notes.push({ code: 'rate-limit-* semantics', message: 'HAProxy rate limiting is a sliding-window counter over the period; NGINX limit_req is a leaky bucket. Behavior near the limit differs — validate under load. Cluster-wide aggregation needs NGINX Plus zone-sync (OSS counts per pod).' });
                return out;
            },

            // -- CORS --
            generateCORS: function(findings, context) {
                let out = contribution();
                let enable = findingValue(findings, 'cors-enable');
                let origin = findingValue(findings, 'cors-allow-origin');
                let methods = findingValue(findings, 'cors-allow-methods');
                let headers = findingValue(findings, 'cors-allow-headers');
                let creds = String(findingValue(findings, 'cors-allow-credentials')).toLowerCase() === 'true';
                let maxAge = findingValue(findings, 'cors-max-age');
                if (String(enable).toLowerCase() !== 'true') {
                    out.notes.push({ code: 'cors-* without cors-enable: "true"', message: 'HAProxy only activates CORS when cors-enable is true — these cors-* values are currently inactive. The Policy below is generated anyway; drop it if CORS was intentionally disabled.' });
                }
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: cors-policy', 'spec:', '  cors:', '    allowOrigin:'];
                let originList = origin ? splitCommaList(origin) : ['*'];
                if (creds && originList.indexOf('*') !== -1) {
                    lines.push('      - "# TODO: set explicit origins (\'*\' is invalid with allowCredentials: true)"');
                } else {
                    originList.forEach(function(o) { lines.push('      - ' + yamlQuote(o)); });
                }
                if (origin && /[\\^$|()\[\]+]/.test(origin)) {
                    out.notes.push({ code: 'cors-allow-origin: ' + cmt(origin), message: 'The origin value looks like a regular expression — NIC cors allowOrigin accepts only exact origins, a leading-label wildcard, or "*" (no regex). Enumerate the origins explicitly.' });
                }
                if (methods) {
                    // NIC validates allowMethods against a fixed set — no "*" wildcard,
                    // and HAProxy's CONNECT/TRACE are rejected outright.
                    let NIC_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'];
                    let requested = splitCommaList(methods).map(function(m) { return m.toUpperCase(); });
                    let expanded = requested.indexOf('*') !== -1 ? NIC_METHODS.slice() : requested;
                    let dropped = expanded.filter(function(m) { return NIC_METHODS.indexOf(m) === -1; });
                    expanded = expanded.filter(function(m) { return NIC_METHODS.indexOf(m) !== -1; });
                    if (expanded.length > 0) {
                        lines.push('    allowMethods:' + (requested.indexOf('*') !== -1 ? '  # "*" is not accepted by NIC — enumerated' : ''));
                        expanded.forEach(function(m) { lines.push('      - ' + m); });
                    }
                    if (dropped.length > 0) {
                        out.notes.push({ code: 'cors-allow-methods', message: 'NIC cors allowMethods accepts only GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH — dropped: ' + dropped.join(', ') + '.' });
                    }
                }
                if (headers) {
                    lines.push('    allowHeaders:');
                    splitCommaList(headers).forEach(function(h) { lines.push('      - ' + yamlQuote(h)); });
                }
                if (creds) lines.push('    allowCredentials: true');
                // HAProxy cors-max-age defaults to 5s, NIC maxAge to 86400 — always emit.
                let ageSecs = maxAge != null ? haproxyTimeToSeconds(maxAge) : 5;
                lines.push('    maxAge: ' + (ageSecs == null ? 5 : ageSecs) + '  # HAProxy default 5s (NIC default is 86400 — set explicitly)');
                lines = lines.concat(policyAttachLines('cors-policy'));
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                return out;
            },

            // -- Headers --
            generateHeaders: function(findings, context, strategy) {
                let out = contribution();
                let reqSet = findingFor(findings, 'request-set-header');
                let resSet = findingFor(findings, 'response-set-header');
                let setHost = findingFor(findings, 'set-host');
                function parseHeaderLines(v) {
                    return String(v == null ? '' : v).split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l !== ''; }).map(function(l) {
                        let sp = l.indexOf(' ');
                        return sp === -1 ? { name: l, value: '' } : { name: l.slice(0, sp), value: l.slice(sp + 1).trim() };
                    });
                }
                let reqHeaders = reqSet ? parseHeaderLines(reqSet.value) : [];
                let resHeaders = resSet ? parseHeaderLines(resSet.value) : [];
                if (strategy === 'annotation' && context.ingresses.length > 0) {
                    if (reqHeaders.length > 0) {
                        let val = reqHeaders.map(function(h) { return h.name + (h.value ? ': ' + h.value : ''); }).join(',');
                        out.swaps.push({ fromKey: reqSet.label, fromValue: reqSet.value, to: 'nginx.org/proxy-set-headers', value: val, note: 'runs after routing (HAProxy request-set-header runs before backend selection — routing influence does not port); do not set Host here, use set-host' });
                    }
                    if (resHeaders.length > 0) {
                        let val = resHeaders.map(function(h) { return h.name + ': ' + h.value + ': always'; }).join(',');
                        out.swaps.push({ fromKey: resSet.label, fromValue: resSet.value, to: 'nginx.org/add-header', value: val, note: 'add_header APPENDS — if the upstream also sends this header the response carries both (HAProxy replaced it)' });
                    }
                    if (setHost) {
                        // Host cannot be overridden reliably via proxy-set-headers — always
                        // route set-host through a VirtualServer.
                        let basics = basicsOf(setHost, context);
                        let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: set-host-app', 'spec:',
                            '  host: ' + specHost(basics), '  upstreams:', '    - name: backend', '      service: ' + specService(basics), '      port: ' + specPort(basics),
                            '  routes:', '    - path: ' + specPath(basics), '      action:', '        proxy:', '          upstream: backend',
                            '          requestHeaders:', '            set:', '              - name: Host', '                value: ' + yamlQuote(setHost.value) + '  # set-host (nginx.org/proxy-set-headers cannot override Host reliably)'];
                        out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                    }
                } else if (reqHeaders.length > 0 || resHeaders.length > 0 || setHost) {
                    let basics = basicsOf(reqSet || resSet || setHost, context);
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: headers-app', 'spec:',
                        '  host: ' + specHost(basics), '  upstreams:', '    - name: backend', '      service: ' + specService(basics), '      port: ' + specPort(basics),
                        '  routes:', '    - path: ' + specPath(basics), '      action:', '        proxy:', '          upstream: backend'];
                    if (reqHeaders.length > 0 || setHost) {
                        lines.push('          requestHeaders:', '            set:');
                        reqHeaders.forEach(function(h) { lines.push('              - name: ' + h.name, '                value: ' + yamlQuote(h.value)); });
                        if (setHost) lines.push('              - name: Host', '                value: ' + yamlQuote(setHost.value) + '  # set-host');
                    }
                    if (resHeaders.length > 0) {
                        lines.push('          responseHeaders:', '            add:');
                        resHeaders.forEach(function(h) { lines.push('              - name: ' + h.name, '                value: ' + yamlQuote(h.value), '                always: true'); });
                        lines.push('            # add_header APPENDS — list upstream-sent duplicates under "hide:" for a true replace');
                    }
                    out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                    if (reqHeaders.length > 0) {
                        out.notes.push({ code: 'haproxy.org/request-set-header', message: 'HAProxy sets request headers before backend selection (they can steer routing); NGINX proxy_set_header runs after the route is chosen — header-driven routing must be re-expressed as VirtualServer matches.' });
                    }
                }
                return out;
            },

            generateRequestCapture: function(findings) {
                let out = contribution();
                let vars = [];
                findings.forEach(function(f) {
                    if (f.key === 'annotation:request-capture-len') return;
                    String(f.value).split('\n').forEach(function(expr) {
                        expr = expr.trim();
                        if (expr === '') return;
                        let m;
                        if ((m = expr.match(/^(?:req\.f?hdr|hdr)\(([^)]+)\)/i))) vars.push('$http_' + m[1].trim().toLowerCase().replace(/-/g, '_'));
                        else if ((m = expr.match(/^(?:req\.cook|cookie)\(([^)]+)\)/i))) vars.push('$cookie_' + m[1].trim().toLowerCase().replace(/-/g, '_'));
                        else vars.push('# no nginx variable for: ' + cmt(expr));
                    });
                });
                out.configMap.push({ fromLabel: 'haproxy.org/request-capture', to: 'log-format', value: '$remote_addr - $remote_user [$time_local] "$request" $status ' + vars.filter(function(v) { return v[0] === '$'; }).join(' '), note: 'append the captured values to the ONE global log format (no per-Ingress capture)' });
                vars.filter(function(v) { return v[0] === '#'; }).forEach(function(v) {
                    out.notes.push({ code: 'request-capture', message: 'Capture expression has no nginx log variable: ' + v.replace(/^# no nginx variable for: /, '') });
                });
                if (findingFor(findings, 'request-capture-len')) {
                    out.notes.push({ code: 'haproxy.org/request-capture-len', message: 'nginx log variables have no per-field length cap — the full value is logged. Safe to drop.' });
                }
                out.notes.push({ code: 'haproxy.org/request-capture', message: 'nginx has no per-route capture slots — captured headers/cookies become $http_*/$cookie_* variables appended to the global ConfigMap log-format (set log-format-escaping: json for safe quoting).' });
                return out;
            },

            // -- Logging / observability --
            generateSyslogServer: function(findings) {
                let out = contribution();
                let f = findings[0];
                // Value shape: "address:10.0.0.1, port:514, facility:local0, level:info"
                let fields = {};
                String(f.value).split(',').forEach(function(part) {
                    let ci = part.indexOf(':');
                    if (ci !== -1) fields[part.slice(0, ci).trim().toLowerCase()] = part.slice(ci + 1).trim();
                });
                if ((fields.address || '').toLowerCase() === 'stdout') {
                    out.notes.push({ code: f.label, message: 'HAProxy logs to stdout — that is already the NIC default (/dev/stdout), no ConfigMap change needed.' });
                    return out;
                }
                let dest = 'syslog:server=' + (fields.address || '# TODO: syslog address') + (fields.port ? ':' + fields.port : '');
                if (fields.facility) dest += ',facility=' + fields.facility;
                if (fields.level) dest += ',severity=' + fields.level;
                out.configMap.push({ fromLabel: f.label, to: 'access-log', value: dest, note: 'NIC ignores access-log values that do not start with syslog:' });
                out.notes.push({ code: 'syslog-server', message: 'Only the ACCESS log can go to syslog (single destination — no multi-server fan-out); the NGINX error log stays on stderr with error-log-level controlling verbosity. HAProxy format/length/minlevel fields have no equivalent.' });
                return out;
            },

            generateLogFormat: function(findings) {
                let out = contribution();
                let f = findings[0];
                let isTcp = f.key === 'configmap:log-format-tcp';
                out.configMap.push({
                    fromLabel: f.label,
                    to: isTcp ? 'stream-log-format' : 'log-format',
                    value: isTcp ? '$remote_addr [$time_local] $protocol $status $bytes_sent $bytes_received $session_time  # TODO: hand-translate your HAProxy tcplog tokens' : '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"  # TODO: hand-translate your HAProxy log-format tokens',
                    note: 'HAProxy %-tokens are a different DSL — rewrite by hand ($remote_addr≈%ci, $status≈%ST, $upstream_response_time≈%Tr); several HAProxy timers (%Tw/%Tc/%Ta) have no nginx variable'
                });
                out.notes.push({ code: f.label, message: 'The ' + (isTcp ? 'stream-log-format applies to ALL TransportServer traffic' : 'log-format applies to ALL HTTP traffic') + ' (global, not per-resource).' });
                return out;
            },

            generateLogNoise: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (f.key === 'configmap:dontlognull') {
                        out.notes.push({ code: f.label, message: 'No option dontlognull equivalent — generally moot: the nginx HTTP access log records completed requests only, so connection probes without a request are not logged anyway. Remove.' });
                    } else {
                        out.notes.push({ code: f.label, message: 'No option logasap equivalent — nginx writes the access-log entry when the request completes (long transfers log late). Remove.' });
                    }
                });
                return out;
            },

            // -- Health checks & load balancing --
            generateCheck: function(findings, context) {
                let out = contribution();
                let f = findings[0];
                if (String(f.value).toLowerCase() !== 'true') {
                    out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'Health checking disabled — nothing to migrate.' });
                    return out;
                }
                out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/max-fails', value: '1', note: 'OSS passive health: eject after N failed client requests' });
                out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/fail-timeout', value: '10s', note: 'window + ejection time for passive failures' });
                out.notes.push({ code: 'haproxy.org/check', message: 'HAProxy runs ACTIVE TCP probes; NIC OSS only supports PASSIVE health (failed real requests eject the server — idle backends are never probed). Active probes require NGINX Plus (VirtualServer upstreams[].healthCheck).' });
                return out;
            },

            generateActiveHealthCheck: function(findings, context) {
                let out = contribution();
                let httpCheck = findingValue(findings, 'check-http');
                let interval = findingValue(findings, 'check-interval');
                let checkTimeout = findingValue(findings, 'timeout-check');
                let basics = basicsOf(findings[0], context);
                let path = '/';
                let droppedMethod = null;
                if (httpCheck) {
                    // Value shape: "[METHOD] URI [HTTP/x.y]" — only the URI ports.
                    let parts = String(httpCheck).trim().split(/\s+/);
                    if (parts.length === 1) path = parts[0];
                    else { droppedMethod = parts[0]; path = parts[1]; }
                }
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: health-check-app', 'spec:',
                    '  host: ' + specHost(basics), '  upstreams:', '    - name: backend', '      service: ' + specService(basics), '      port: ' + specPort(basics),
                    '      healthCheck:', '        enable: true  # NGINX Plus only', '        path: ' + path + (httpCheck ? '  # check-http' : '')];
                if (interval) {
                    let t = haproxyTimeToNginx(interval);
                    lines.push('        interval: ' + t.value + (t.note ? '  # ' + t.note : '  # check-interval'));
                }
                if (checkTimeout) {
                    let t = haproxyTimeToNginx(checkTimeout);
                    lines.push('        read-timeout: ' + t.value + '  # timeout-check');
                }
                lines.push('  routes:', '    - path: ' + specPath(basics), '      action:', '        pass: backend');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                if (droppedMethod && droppedMethod.toUpperCase() !== 'GET') {
                    out.notes.push({ code: 'check-http: ' + cmt(httpCheck), message: 'NIC active health checks always probe with GET — the ' + cmt(droppedMethod) + ' method (and any HTTP-version token) does not port.' });
                }
                return out;
            },

            generateLoadBalance: function(findings) {
                let out = contribution();
                let f = findings[0];
                let v = String(f.value || '').trim();
                let first = v.split(/\s+/)[0] || '';
                let m;
                let mapped = null, note = null;
                if (/^roundrobin$/i.test(first)) { mapped = 'round_robin'; }
                else if (/^static-rr$/i.test(first)) { mapped = 'round_robin'; note = 'static-rr loses its static-assignment guarantee (plain round_robin)'; }
                else if (/^leastconn$/i.test(first)) { mapped = 'least_conn'; }
                else if (/^source$/i.test(first)) { mapped = 'ip_hash'; }
                else if (/^uri$/i.test(first)) { mapped = 'hash $request_uri consistent'; note = 'uri sub-options (len/depth) are dropped'; }
                else if (/^url_param$/i.test(first)) {
                    let param = v.split(/\s+/)[1] || 'param';
                    mapped = 'hash $arg_' + param.replace(/-/g, '_') + ' consistent';
                } else if ((m = v.match(/^hdr\(([^)]+)\)/i))) {
                    mapped = 'hash $http_' + m[1].trim().toLowerCase().replace(/-/g, '_') + ' consistent';
                } else if ((m = first.match(/^random(?:\((\d+)\))?$/i))) {
                    mapped = m[1] && parseInt(m[1], 10) >= 2 ? 'random two' : 'random';
                } else if (/^first$/i.test(first)) {
                    out.notes.push({ code: f.label + ': "first"', message: 'No NIC equivalent for balance first (fill servers in order) — choose round_robin or least_conn instead.' });
                    return out;
                } else if (/^rdp-cookie/i.test(first)) {
                    out.notes.push({ code: f.label + ': "' + cmt(v) + '"', message: 'No NIC equivalent for rdp-cookie balancing.' });
                    return out;
                } else {
                    out.notes.push({ code: f.label + ': "' + cmt(v) + '"', message: 'Unrecognized load-balance algorithm — map it manually to one of: round_robin, least_conn, ip_hash, random, random two, hash <key> [consistent] (least_time requires NGINX Plus).' });
                    return out;
                }
                emitScoped(out, f, 'lb-method', 'nginx.org/lb-method', mapped, note);
                return out;
            },

            generateNotApplicable: function(findings, context) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (f.key === 'annotation:scale-server-slots') {
                        out.notes.push({ code: f.label, message: 'Not applicable — NIC has no pre-allocated server slots; it re-resolves endpoints on change (OSS reloads; Plus updates dynamically via API). Remove.' });
                    } else if (f.key === 'annotation:standalone-backend') {
                        out.notes.push({ code: f.label, message: 'Not needed — NIC already generates a separate upstream per Ingress/VirtualServer, so the shared-backend conflict this annotation works around does not exist.' });
                    } else if (f.key === 'annotation:abortonclose') {
                        out.notes.push({ code: f.label, message: 'NGINX already aborts the upstream request when the client disconnects (proxy_ignore_client_abort off is the default) — HAProxy abortonclose behavior matches out of the box. Remove.' });
                    } else if (f.key === 'annotation:clean-certs') {
                        out.notes.push({ code: f.label, message: 'Not applicable — NIC loads certificates from Secrets and manages its own storage. Remove.' });
                    } else {
                        out.notes.push({ code: f.label, message: 'Not applicable on the F5 NGINX Ingress Controller — remove.' });
                    }
                });
                return out;
            },

            // -- Rewrites / redirects --
            generatePathRewrite: function(findings, context) {
                let out = contribution();
                let f = findings[0];
                let ruleLines = String(f.value || '').split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l !== ''; });
                if (ruleLines.length > 1) {
                    out.notes.push({ code: f.label, message: 'Multiple path-rewrite rules found — nginx.org/rewrite-target holds ONE rewrite; express additional rules as separate VirtualServer routes with action.proxy.rewritePath.' });
                }
                let rule = ruleLines[0] || '';
                let parts = rule.split(/\s+/);
                if (parts.length >= 2) {
                    // Two-field form: "<match-regex> <replacement>" (sed-like, \1 captures).
                    let replacement = parts.slice(1).join(' ').replace(/\\(\d)/g, '$$$1');
                    out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/rewrite-target', value: replacement, note: 'capture groups ($1–$9) resolve against the Ingress rule path, not your original regex "' + cmt(parts[0]) + '" — align the rule path or use a VirtualServer regex route' });
                    out.swaps.push({ fromLabel: 'haproxy.org/path-rewrite (regex form)', to: 'nginx.org/path-regex', value: 'case_sensitive', note: 'enables regex path matching so the captures exist' });
                } else if (rule !== '') {
                    // One-field form: replace the whole path.
                    out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/rewrite-target', value: rule, note: 'replaces the matched path when proxying' });
                }
                return out;
            },

            generateRequestRedirect: function(findings, context) {
                let out = contribution();
                let target = findingValue(findings, 'request-redirect');
                let codeRaw = findingValue(findings, 'request-redirect-code');
                let basics = basicsOf(findings[0], context);
                // HAProxy redirects default to 302; NIC ActionRedirect defaults to 301 —
                // the code must always be emitted explicitly.
                let code = 302;
                if (codeRaw != null) {
                    let n = parseInt(codeRaw, 10);
                    if ([301, 302, 307, 308].indexOf(n) !== -1) code = n;
                    else out.notes.push({ code: 'haproxy.org/request-redirect-code: ' + cmt(codeRaw), message: 'NIC redirect codes are limited to 301/302/307/308 — ' + cmt(codeRaw) + ' has no equivalent; falling back to 302.' });
                }
                let hostPart = String(target || '').trim();
                let scheme = '${scheme}';
                let m = hostPart.match(/^(https?):\/\/(.+)$/);
                if (m) { scheme = m[1]; hostPart = m[2]; }
                let url = scheme + '://' + (hostPart || '# TODO: target host') + '${request_uri}';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: redirect-app', 'spec:',
                    '  host: ' + specHost(basics),
                    '  routes:', '    - path: ' + specPath(basics), '      action:', '        redirect:',
                    '          url: ' + yamlQuote(url) + '  # request-redirect (path and query preserved via ${request_uri})',
                    '          code: ' + code + '  # HAProxy default 302 — NIC would default to 301'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },

            generateSSLRedirect: function(findings, context) {
                let out = contribution();
                let enabled = findingValue(findings, 'ssl-redirect');
                let codeRaw = findingValue(findings, 'ssl-redirect-code');
                let f = findingFor(findings, 'ssl-redirect') || findings[0];
                if (enabled != null) {
                    emitScoped(out, f, 'ssl-redirect', 'nginx.org/ssl-redirect', String(enabled).toLowerCase() === 'true' ? 'true' : 'false', 'auto-enabled with spec.tls on both controllers; use nginx.org/redirect-to-https instead when TLS terminates at an external load balancer');
                }
                if (String(enabled).toLowerCase() !== 'false') {
                    // Preserve HAProxy's 302 default — NIC defaults to 301.
                    let code = '302';
                    let note = 'HAProxy default 302; NIC would default to 301 — set explicitly';
                    if (codeRaw != null) {
                        let n = parseInt(codeRaw, 10);
                        if (n === 303) {
                            code = '302';
                            note = '303 is not in the NIC set (301/302/307/308) — 302 is the closest non-permanent, non-method-preserving fallback';
                        } else if ([301, 302, 307, 308].indexOf(n) !== -1) {
                            code = String(n);
                            note = null;
                        }
                    }
                    let cf = findingFor(findings, 'ssl-redirect-code') || f;
                    emitScoped(out, cf, 'http-redirect-code', 'nginx.org/http-redirect-code', code, note);
                }
                return out;
            },

            generateSSLRedirectPort: function(findings) {
                let out = contribution();
                let f = findings[0];
                out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'NIC redirects to its own HTTPS listener port (default 443, -default-https-listener-port) — there is no client-visible-only redirect-port knob. To advertise a different port, bake it into a VirtualServer redirect: action.redirect.url: https://${host}:' + cmt(f.value) + '${request_uri}.' });
                return out;
            },

            // -- Timeouts & connection handling --
            generateTimeout: function(findings, context) {
                let out = contribution();
                findings.forEach(function(f) {
                    let name = f.key.replace(/^(annotation|configmap):/, '');
                    let t = haproxyTimeToNginx(f.value);
                    switch (name) {
                        case 'timeout-connect':
                            emitScoped(out, f, 'proxy-connect-timeout', 'nginx.org/proxy-connect-timeout', t.value, t.note);
                            break;
                        case 'timeout-http-keep-alive':
                            out.configMap.push({ fromLabel: f.label, to: 'keepalive-timeout', value: t.value, note: t.note || 'client keep-alive idle timeout (NIC default 75s); upstream keep-alive is the separate "keepalive" count' });
                            break;
                        case 'timeout-server':
                            // One HAProxy timeout governs both directions — set both NGINX
                            // directives or the unset one silently stays at 60s.
                            emitScoped(out, f, 'proxy-read-timeout', 'nginx.org/proxy-read-timeout', t.value, t.note);
                            emitScoped(out, f, 'proxy-send-timeout', 'nginx.org/proxy-send-timeout', t.value, 'timeout-server covers both directions — set read AND send');
                            break;
                        case 'timeout-tunnel':
                            out.configMap.push({ fromLabel: f.label, to: 'proxy-read-timeout', value: t.value, note: 'no dedicated tunnel timeout — raising proxy timeouts affects ALL upstream traffic' });
                            out.configMap.push({ fromLabel: f.label, to: 'proxy-send-timeout', value: t.value, note: null });
                            out.notes.push({ code: f.label, message: 'WebSocket/long-lived connections: VirtualServer upstreams handle WebSocket automatically; a plain Ingress additionally needs nginx.org/websocket-services naming the Service.' });
                            break;
                        case 'timeout-client':
                        case 'timeout-http-request': {
                            let directives = name === 'timeout-client'
                                ? 'client_body_timeout ' + t.value + ';\\n  client_header_timeout ' + t.value + ';\\n  send_timeout ' + t.value + ';'
                                : 'client_header_timeout ' + t.value + ';';
                            out.configMap.push({ fromLabel: f.label, to: 'http-snippets', value: '|\\n  ' + directives, note: 'no first-class NIC key for client-side timeouts — raw directives (ConfigMap snippets are always enabled)' });
                            out.notes.push({ code: f.label, message: 'NIC has no ConfigMap key for client-side inactivity timeouts — the http-snippets escape hatch above approximates it (' + (name === 'timeout-client' ? 'client_body/header + send timeouts' : 'client_header_timeout is the closest analogue to the whole-request timeout') + ').' });
                            break;
                        }
                        case 'timeout-queue':
                            out.notes.push({ code: f.label, message: 'Request queueing when all servers are saturated exists only in NGINX Plus: VirtualServer upstreams[].queue {size, timeout} paired with max-conns (HAProxy default 5s vs Plus default 60s). OSS has no request queue — requests fail fast instead.' });
                            break;
                        case 'timeout-client-fin':
                        case 'timeout-server-fin':
                            out.notes.push({ code: f.label, message: 'No NGINX knob for half-closed (FIN_WAIT) connection timeouts — remove.' });
                            break;
                        default:
                            out.notes.push({ code: f.label, message: 'Unhandled timeout — check the reference tables.' });
                    }
                });
                return out;
            },

            generateConnectionMode: function(findings) {
                let out = contribution();
                let mode = findingValue(findings, 'http-connection-mode');
                let keepAlive = findingValue(findings, 'http-keep-alive');
                let serverClose = findingValue(findings, 'http-server-close');
                let f = findings[0];
                let effective = mode || (String(keepAlive).toLowerCase() === 'true' ? 'http-keep-alive' : null) || (String(serverClose).toLowerCase() === 'true' ? 'http-server-close' : null);
                if (keepAlive != null || serverClose != null) {
                    out.notes.push({ code: 'http-keep-alive / http-server-close', message: 'Both annotations are deprecated HAProxy aliases of http-connection-mode.' });
                }
                if (effective === 'http-keep-alive') {
                    out.configMap.push({ fromLabel: f.label, to: 'keepalive', value: '64', note: 'UPSTREAM keep-alive is an idle-connection COUNT per worker, off by default in NGINX — 64 is a starting point; client keep-alive is already on (keepalive-timeout 75s)' });
                } else if (effective === 'httpclose') {
                    out.configMap.push({ fromLabel: f.label, to: 'keepalive-timeout', value: '0', note: 'disables client keep-alive (httpclose)' });
                } else if (effective === 'http-server-close') {
                    out.notes.push({ code: f.label + ': "http-server-close"', message: 'Matches the NGINX default (client keep-alive on, no upstream keep-alive) — nothing to emit.' });
                } else if (effective) {
                    out.notes.push({ code: f.label + ': "' + cmt(effective) + '"', message: 'Unrecognized connection mode — NGINX splits this into client keep-alive (keepalive-timeout) and upstream keep-alive (keepalive count).' });
                }
                return out;
            },

            generateWorkerTuning: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    let name = f.key.replace(/^configmap:/, '');
                    if (name === 'maxconn') {
                        out.configMap.push({ fromLabel: f.label, to: 'worker-connections', value: f.value || '1024', note: 'PER-WORKER in NGINX (HAProxy maxconn is process-wide) — divide by worker-processes, and remember it counts client + upstream + internal connections' });
                    } else if (name === 'nbthread') {
                        out.configMap.push({ fromLabel: f.label, to: 'worker-processes', value: f.value || 'auto', note: 'NGINX scales with processes, not threads — the count transfers, the model differs' });
                    }
                });
                return out;
            },

            generatePodMaxconn: function(findings) {
                let out = contribution();
                let f = findings[0];
                out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/max-conns', value: f.value, note: 'HAProxy divides pod-maxconn by the controller instance count automatically; NIC does not — divide by your replica count yourself' });
                return out;
            },

            // -- TLS frontend --
            generateSSLCertificate: function(findings) {
                let out = contribution();
                let f = findings[0];
                out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'The cluster-wide default certificate is a deployment flag in NIC, not an annotation: -default-server-tls-secret ' + cmt(f.value) + ' (unmatched-SNI default server), optionally -wildcard-tls-secret for a per-host fallback. Per-app certs stay on Ingress spec.tls / VirtualServer spec.tls.secret. Multi-algorithm Secrets (rsa.*/ecdsa.*/dsa.* keys) are not supported — one kubernetes.io/tls certificate per Secret.' });
                return out;
            },

            generateSSLPassthrough: function(findings, context) {
                let out = contribution();
                let f = findings[0];
                if (String(f.value).toLowerCase() === 'false') {
                    out.notes.push({ code: f.label + ': "false"', message: 'Passthrough disabled — nothing to migrate.' });
                    return out;
                }
                let basics = basicsOf(f, context);
                let svc = (f.data && f.data.serviceName) || specService(basics);
                let lines = ['# tls-passthrough is a built-in listener — no GlobalConfiguration needed,',
                    '# but the controller must run with -enable-tls-passthrough (default port 443).',
                    'apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ssl-passthrough-app', 'spec:',
                    '  listener:', '    name: tls-passthrough', '    protocol: TLS_PASSTHROUGH',
                    '  host: ' + specHost(basics) + '  # REQUIRED — routed by SNI (no catch-all)',
                    '  upstreams:', '    - name: backend', '      service: ' + svc, '      port: 443',
                    '  action:', '    pass: backend'];
                out.crds.push({ kind: 'TransportServer', yaml: lines.join('\n') });
                out.notes.push({ code: f.label, message: 'On NIC, TLS passthrough is a separate TransportServer resource (SNI-routed, spec.host required, spec.tls forbidden) — HTTP-mode annotations on the original Ingress no longer apply to this traffic.' });
                return out;
            },

            generateTlsAlpn: function(findings) {
                let out = contribution();
                let f = findings[0];
                let protos = splitCommaList(f.value).map(function(p) { return p.toLowerCase(); });
                if (protos.indexOf('h2') !== -1) {
                    out.configMap.push({ fromLabel: f.label, to: 'http2', value: 'True', note: 'HAProxy advertises h2 by default; NIC HTTP/2 is OFF by default — enable explicitly (global, SSL servers only)' });
                } else {
                    out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'This ALPN list omits h2 — leave the NIC http2 ConfigMap key unset (HTTP/2 off is the NIC default).' });
                }
                out.notes.push({ code: 'tls-alpn', message: 'NIC exposes no general ALPN-advertisement control — only the HTTP/2 on/off dimension maps (http2 ConfigMap key). Arbitrary ALPN protocol lists cannot be reproduced.' });
                return out;
            },

            // -- Routing / class / canary --
            generateIngressClass: function(findings) {
                let out = contribution();
                let f = findings[0];
                out.notes.push({ code: f.label + ': "' + cmt(f.value) + '"', message: 'Move the class to spec.ingressClassName (the annotation form is deprecated on both controllers; if present on NIC it takes precedence and logs a warning). NIC requires an IngressClass named after its -ingress-class flag (default "nginx", spec.controller nginx.org/ingress-controller) to exist — it fails to start otherwise — and Ingresses must match it exactly.' });
                return out;
            },

            generateIngressSpecNotes: function(findings, context) {
                let out = contribution();
                findings.forEach(function(f) {
                    let details = (f.data && f.data.details) || {};
                    let paths = details.paths || [];
                    let prefixPaths = paths.filter(function(p) { return p.pathType === 'Prefix' && p.path && p.path !== '/'; });
                    if (prefixPaths.length > 0) {
                        out.notes.push({ code: f.label + ' — pathType: Prefix (' + prefixPaths.map(function(p) { return p.path; }).join(', ') + ')', message: 'On a plain NIC Ingress, Prefix and ImplementationSpecific both render as a raw NGINX prefix location WITHOUT the Kubernetes path-segment boundary (/foo also matches /foobar). To preserve strict Prefix semantics, migrate the path to a VirtualServer route with a regex path like ~^/foo(/.*)?$.' });
                    }
                    (details.hosts || []).forEach(function(h) {
                        if (/^\*\./.test(h)) {
                            out.notes.push({ code: f.label + ' — host: ' + h, message: 'Leading-label wildcards port unchanged. NIC (like HAProxy) does not support mid-label or bare-suffix wildcards.' });
                        }
                    });
                    if (details.hasDefaultBackend) {
                        out.notes.push({ code: f.label + ' — spec.defaultBackend', message: 'spec.defaultBackend is honored by NIC as-is. (There is no --default-backend-service flag equivalent — a cluster-wide fallback needs a host-less catch-all Ingress.)' });
                    }
                });
                return out;
            },

            generateRouteACL: function(findings, context, strategy) {
                let out = contribution();
                findings.forEach(function(f) {
                    let acl = parseRouteACL(f.value);
                    let canarySvc = (f.data && f.data.serviceName) || '# TODO: canary service';
                    let basics = basicsOf(f, context);
                    if (acl.kind === 'rand') {
                        let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: canary-app', 'spec:',
                            '  host: ' + specHost(basics), '  upstreams:',
                            '    - name: main', '      service: ' + specService(basics), '      port: ' + specPort(basics),
                            '    - name: canary', '      service: ' + canarySvc, '      port: ' + specPort(basics),
                            '  routes:', '    - path: ' + specPath(basics), '      splits:',
                            '        - weight: ' + (100 - acl.pct), '          action: { pass: main }',
                            '        - weight: ' + acl.pct + '  # route-acl: ' + cmt(acl.raw),
                            '          action: { pass: canary }'];
                        out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                        out.notes.push({ code: 'route-acl (canary)', message: 'HAProxy route-acl rules fire in config order (first match wins); NIC splits are declarative percentages — the conversion above assumes this is the only routing rule for the path.' });
                    } else if (acl.kind === 'cookie' || acl.kind === 'header' || acl.kind === 'arg' || acl.kind === 'method') {
                        let cond;
                        if (acl.kind === 'cookie') cond = ['            - cookie: ' + acl.name, '              value: ' + yamlQuote(acl.value || 'always')];
                        else if (acl.kind === 'header') cond = ['            - header: ' + acl.name, '              value: ' + yamlQuote(acl.value || 'always')];
                        else if (acl.kind === 'arg') cond = ['            - argument: ' + acl.name, '              value: ' + yamlQuote(acl.value || 'always')];
                        else cond = ['            - variable: $request_method', '              value: ' + yamlQuote(acl.value)];
                        let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: canary-app', 'spec:',
                            '  host: ' + specHost(basics), '  upstreams:',
                            '    - name: main', '      service: ' + specService(basics), '      port: ' + specPort(basics),
                            '    - name: canary', '      service: ' + canarySvc, '      port: ' + specPort(basics),
                            '  routes:', '    - path: ' + specPath(basics),
                            '      matches:', '        - conditions:  # route-acl: ' + cmt(acl.raw)]
                            .concat(cond)
                            .concat(['          action:', '            pass: canary', '      action:', '        pass: main']);
                        out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                    } else if (acl.kind === 'src') {
                        let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: route-acl-allow', 'spec:', '  accessControl:', '    allow:'];
                        acl.cidrs.forEach(function(c) { lines.push('      - ' + c + '  # route-acl: src'); });
                        lines = lines.concat(policyAttachLines('route-acl-allow'));
                        lines.push('# NIC cannot route by source IP (match conditions exclude CIDRs) — an', '# accessControl Policy gates access instead of steering to a different backend.');
                        out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                        out.notes.push({ code: 'route-acl: ' + cmt(acl.raw), message: 'Source-IP routing does not exist in NIC — the generated Policy allows/denies instead of routing. If two backends must serve different CIDRs, split them across hostnames.' });
                    } else {
                        out.notes.push({ code: 'route-acl: ' + cmt(acl.raw), message: 'This ACL is not translatable' + (acl.why ? ' (' + acl.why + ')' : '') + ' — NIC match conditions cover headers, cookies, query arguments, and a fixed set of variables only. Re-express the intent with VirtualServer matches or split hostnames.' });
                    }
                });
                return out;
            },

            // -- Snippets --
            generateBackendSnippet: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    let body = String(f.value || '').trim();
                    let todo = body.split('\n').map(function(l) { return '# TODO rewrite as NGINX: ' + l.trim(); }).join('\\n  ');
                    out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/location-snippets', value: '|\\n  ' + todo, note: 'HAProxy directives are NOT NGINX directives — rewrite each line; requires -enable-snippets' });
                    if (f.data && f.data.scope === 'service') {
                        out.notes.push({ code: f.label + ' (Service scope)', message: 'NIC does not read snippet annotations from Service objects — the location-snippets annotation must sit on the Ingress (or use VirtualServer route location-snippets).' });
                    }
                    if (/stick-table|stick\s+on/i.test(body)) {
                        out.notes.push({ code: 'backend-config-snippet (stick-table)', message: 'Stick-table session persistence should become VirtualServer upstreams[].sessionCookie — NIC has no per-upstream snippet context for stick tables.' });
                    }
                });
                return out;
            },

            generateFrontendSnippet: function(findings) {
                let out = contribution();
                let f = findings[0];
                let todo = String(f.value || '').trim().split('\n').map(function(l) { return '# TODO rewrite as NGINX: ' + l.trim(); }).join('\\n  ');
                out.configMap.push({ fromLabel: f.label, to: 'server-snippets', value: '|\\n  ' + todo, note: 'applies inside EVERY server block; per-app scoping → nginx.org/server-snippets on the Ingress (-enable-snippets)' });
                out.notes.push({ code: f.label, message: 'HAProxy frontend directives (http-request/http-response rules, ACLs) have no 1:1 server-context equivalents — re-express each rule as NGINX config or NIC constructs (Policies, VirtualServer matches).' });
                return out;
            },

            generateGlobalSnippet: function(findings) {
                let out = contribution();
                let f = findings[0];
                let body = String(f.value || '').trim();
                let native = [];
                let leftover = [];
                body.split('\n').forEach(function(l) {
                    let t = l.trim();
                    let m;
                    if ((m = t.match(/^ssl-default-bind-ciphers\s+(.+)$/i))) native.push({ to: 'ssl-ciphers', value: m[1], from: t });
                    else if ((m = t.match(/^ssl-default-bind-options\s+(.+)$/i))) native.push({ to: 'ssl-protocols', value: '# TODO: derive from "' + cmt(m[1]) + '" (e.g. TLSv1.2 TLSv1.3)', from: t });
                    else if ((m = t.match(/^ssl-dh-param-file\s+(.+)$/i))) native.push({ to: 'ssl-dhparam-file', value: m[1], from: t });
                    else if (t !== '') leftover.push(t);
                });
                native.forEach(function(n) {
                    out.configMap.push({ fromLabel: 'global-config-snippet: ' + cmt(n.from), to: n.to, value: n.value, note: 'native ConfigMap key — prefer over a snippet' });
                });
                if (leftover.length > 0) {
                    let todo = leftover.map(function(l) { return '# TODO rewrite as NGINX: ' + l; }).join('\\n  ');
                    out.configMap.push({ fromLabel: f.label, to: 'main-snippets', value: '|\\n  ' + todo, note: 'main-context directives (worker/tuning); use http-snippets for http-context ones — HAProxy directives must be rewritten' });
                }
                return out;
            },

            generateStatsSnippet: function(findings) {
                let out = contribution();
                out.notes.push({ code: findings[0].label, message: 'NIC has no stats frontend to inject config into — the HAProxy stats page itself has no equivalent. Scrape Prometheus metrics (-enable-prometheus-metrics, port 9113) into Grafana instead; the live activity dashboard is an NGINX Plus feature.' });
                return out;
            },

            // -- Enterprise / Plus --
            generateModsecurity: function(findings) {
                let out = contribution();
                let f = findings[0];
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: waf-policy', 'spec:', '  waf:',
                    '    enable: true  # NGINX Plus + App Protect WAF',
                    '    apPolicy: "default/dataguard-alarm"  # TODO: author an APPolicy — ModSecurity/CRS rules are NOT portable',
                    '    securityLog:', '      enable: true', '      apLogConf: "default/logconf"', '      logDest: "syslog:server=127.0.0.1:514"',
                    '', '# Attach via VirtualServer spec.policies, or on Ingress via nginx.com/policies', '# (waf Policies are rejected on nginx.org/policies).'];
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                out.notes.push({ code: f.label, message: 'HAProxy Enterprise ModSecurity rules (SecRule/CRS Secret) cannot be imported — NGINX App Protect uses its own declarative policy model (APPolicy CRD/bundle). Re-author and re-tune the ruleset, and set the enforcement mode explicitly (HAProxy ships detection-only by default). Requires NGINX Plus with App Protect.' });
                return out;
            },

            // -- Global / lifecycle --
            generateHardStopAfter: function(findings) {
                let out = contribution();
                let f = findings[0];
                let t = haproxyTimeToNginx(f.value);
                out.configMap.push({ fromLabel: f.label, to: 'worker-shutdown-timeout', value: t.value, note: (t.note ? t.note + '; ' : '') + 'caps how long an OLD worker may drain after a reload (HAProxy caps whole-process soft-stop) — NIC default is indefinite' });
                return out;
            },

            // -- HAProxy CRDs (Global / Defaults / Backend / Frontend / TCP) --
            // CRD field keys arrive in client-native JSON form (underscores) or
            // hyphenated; normalize before matching.

            generateGlobalCRD: function(finding, context) {
                let out = contribution();
                let config = (finding.data && finding.data.config) || {};
                let label = finding.label;
                let dropped = [];
                let managed = [];
                Object.keys(config).forEach(function(rawKey) {
                    let k = String(rawKey).toLowerCase().replace(/_/g, '-');
                    let v = config[rawKey];
                    switch (k) {
                        case 'maxconn':
                            out.configMap.push({ fromLabel: label + ' maxconn', to: 'worker-connections', value: String(v), note: 'per-worker in NGINX (HAProxy maxconn is process-wide) — divide by worker-processes' });
                            break;
                        case 'nbthread':
                            out.configMap.push({ fromLabel: label + ' nbthread', to: 'worker-processes', value: String(v), note: 'processes, not threads' });
                            break;
                        case 'ulimit-n':
                            out.configMap.push({ fromLabel: label + ' ulimit_n', to: 'worker-rlimit-nofile', value: String(v), note: null });
                            break;
                        case 'hard-stop-after':
                        case 'grace':
                            out.configMap.push({ fromLabel: label + ' ' + rawKey, to: 'worker-shutdown-timeout', value: msToNginxTime(v).value, note: 'old-worker drain cap after reload (approximate analogue)' });
                            break;
                        case 'ssl-default-bind-ciphers':
                            out.configMap.push({ fromLabel: label + ' ssl_default_bind_ciphers', to: 'ssl-ciphers', value: String(v), note: null });
                            break;
                        case 'ssl-default-bind-options':
                            out.configMap.push({ fromLabel: label + ' ssl_default_bind_options', to: 'ssl-protocols', value: '# TODO: derive from "' + cmt(v) + '" (e.g. TLSv1.2 TLSv1.3)', note: 'HAProxy bind options mix protocol floors and flags — map protocols here, ssl-prefer-server-ciphers separately' });
                            break;
                        case 'ssl-dh-param-file':
                            out.configMap.push({ fromLabel: label + ' ssl_dh_param_file', to: 'ssl-dhparam-file', value: String(v), note: null });
                            break;
                        case 'cpu-maps':
                        case 'cpu-set':
                        case 'cpu-policy':
                            out.configMap.push({ fromLabel: label + ' ' + rawKey, to: 'worker-cpu-affinity', value: '# TODO: translate to nginx CPU bitmasks (e.g. "0001 0010")', note: 'mask format differs from HAProxy cpu-map — manual translation' });
                            break;
                        case 'log-targets':
                        case 'log':
                            out.configMap.push({ fromLabel: label + ' log targets', to: 'access-log', value: 'syslog:server=# TODO: address,facility=local0', note: 'access log only; error-log verbosity via error-log-level' });
                            break;
                        case 'daemon': case 'master-worker': case 'pidfile': case 'localpeer':
                        case 'chroot': case 'user': case 'uid': case 'group': case 'gid': case 'default-path':
                            managed.push(rawKey);
                            break;
                        default:
                            dropped.push(rawKey);
                    }
                });
                if (managed.length > 0) {
                    out.notes.push({ code: label + ' (process fields)', message: 'Controller-managed on NIC (nothing to migrate): ' + managed.join(', ') + '.' });
                }
                if (dropped.length > 0) {
                    out.notes.push({ code: label + ' (unmapped fields)', message: 'No NIC ConfigMap key for: ' + dropped.join(', ') + ' — re-express via main-snippets/http-snippets where NGINX has an equivalent directive, otherwise drop (runtime APIs, stats socket, and tune.* knobs have no analogue).' });
                }
                out.notes.push({ code: label, message: 'HAProxy Global CRs replace annotation config outright (CR wins); the NIC ConfigMap instead sets defaults that per-resource annotations override. Also drop the cr-global ConfigMap pointer — NIC has no CR indirection.' });
                return out;
            },

            generateDefaultsCRD: function(finding, context) {
                let out = contribution();
                let config = (finding.data && finding.data.config) || {};
                let label = finding.label;
                let noEquiv = [];
                Object.keys(config).forEach(function(rawKey) {
                    let k = String(rawKey).toLowerCase().replace(/_/g, '-');
                    let v = config[rawKey];
                    switch (k) {
                        case 'server-timeout':
                            out.configMap.push({ fromLabel: label + ' server_timeout', to: 'proxy-read-timeout', value: msToNginxTime(v).value, note: 'CRD timeouts are int64 milliseconds' });
                            out.configMap.push({ fromLabel: label + ' server_timeout', to: 'proxy-send-timeout', value: msToNginxTime(v).value, note: 'one HAProxy timeout covers both directions' });
                            break;
                        case 'connect-timeout':
                            out.configMap.push({ fromLabel: label + ' connect_timeout', to: 'proxy-connect-timeout', value: msToNginxTime(v).value, note: null });
                            break;
                        case 'http-keep-alive-timeout':
                            out.configMap.push({ fromLabel: label + ' http_keep_alive_timeout', to: 'keepalive-timeout', value: msToNginxTime(v).value, note: null });
                            break;
                        case 'client-timeout':
                        case 'http-request-timeout':
                            out.configMap.push({ fromLabel: label + ' ' + rawKey, to: 'http-snippets', value: '|\\n  client_header_timeout ' + msToNginxTime(v).value + ';', note: 'no first-class client-side timeout key — snippet escape hatch' });
                            break;
                        case 'balance': {
                            let algo = (v && typeof v === 'object') ? v.algorithm : v;
                            out.configMap.push({ fromLabel: label + ' balance', to: 'lb-method', value: String(algo || 'round_robin').replace(/^roundrobin$/, 'round_robin').replace(/^leastconn$/, 'least_conn').replace(/^source$/, 'ip_hash'), note: 'see the load-balance row for the full value map (first/rdp-cookie have no equivalent)' });
                            break;
                        }
                        case 'retries':
                            out.notes.push({ code: label + ' retries: ' + cmt(v), message: 'Retries are per-resource in NIC: nginx.org/proxy-next-upstream-tries (or VirtualServer upstreams[].next-upstream-tries) — no global ConfigMap key.' });
                            break;
                        case 'redispatch':
                            out.notes.push({ code: label + ' redispatch', message: 'Retrying on another server is per-resource in NIC: nginx.org/proxy-next-upstream (default "error timeout").' });
                            break;
                        case 'httplog':
                        case 'log-format':
                            out.configMap.push({ fromLabel: label + ' ' + rawKey, to: 'log-format', value: '# TODO: hand-translate the HAProxy log format to nginx $-variables', note: null });
                            break;
                        case 'tcplog':
                            out.configMap.push({ fromLabel: label + ' tcplog', to: 'stream-log-format', value: '# TODO: hand-translate to nginx stream $-variables', note: null });
                            break;
                        case 'forwardfor':
                            out.notes.push({ code: label + ' forwardfor', message: 'X-Forwarded-For is automatic in NIC — drop.' });
                            break;
                        case 'mode':
                            out.notes.push({ code: label + ' mode: ' + cmt(v), message: 'mode is structural on NIC — HTTP traffic uses Ingress/VirtualServer, TCP uses TransportServer; there is no mode key.' });
                            break;
                        default:
                            noEquiv.push(rawKey);
                    }
                });
                if (noEquiv.length > 0) {
                    out.notes.push({ code: label + ' (unmapped fields)', message: 'No NIC equivalent for: ' + noEquiv.join(', ') + ' (queue/tunnel/tarpit/*-fin timeouts, check_timeout on OSS, compression key, error_files — see the reference tables for per-field guidance).' });
                }
                out.notes.push({ code: label, message: 'Drop the cr-defaults ConfigMap pointer — migrate the CR contents into the NIC ConfigMap (defaults that per-resource annotations may override).' });
                return out;
            },

            generateBackendCRD: function(finding, context) {
                let out = contribution();
                let config = (finding.data && finding.data.config) || {};
                let label = finding.label;
                let get = function(names) {
                    for (let i = 0; i < names.length; i++) {
                        for (let key in config) {
                            if (String(key).toLowerCase().replace(/_/g, '-') === names[i]) return config[key];
                        }
                    }
                    return undefined;
                };
                let mode = get(['mode']);
                if (String(mode).toLowerCase() === 'tcp') {
                    out.notes.push({ code: label + ' (mode: tcp)', message: 'TCP-mode Backend settings belong on a TransportServer (upstreams[] with loadBalancingMethod, maxConns, connect/read/send timeouts) — see the TCP rows.' });
                    return out;
                }
                let basics = context.firstIngressBasics;
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: backend-tuned-app', 'spec:',
                    '  host: ' + specHost(basics), '  upstreams:', '    - name: backend', '      service: ' + specService(basics), '      port: ' + specPort(basics)];
                let balance = get(['balance']);
                if (balance !== undefined) {
                    let algo = (balance && typeof balance === 'object') ? balance.algorithm : balance;
                    let mappedAlgo = String(algo || '').replace(/^roundrobin$/, 'round_robin').replace(/^leastconn$/, 'least_conn').replace(/^source$/, 'ip_hash');
                    lines.push('      lb-method: ' + yamlQuote(mappedAlgo) + '  # balance (first/rdp-cookie have no equivalent; least_time = Plus)');
                }
                let ct = get(['connect-timeout']);
                if (ct !== undefined) lines.push('      connect-timeout: ' + msToNginxTime(ct).value + '  # connect_timeout (ms)');
                let st = get(['server-timeout']);
                if (st !== undefined) {
                    lines.push('      read-timeout: ' + msToNginxTime(st).value + '  # server_timeout (ms)');
                    lines.push('      send-timeout: ' + msToNginxTime(st).value + '  # server_timeout covers both directions');
                }
                let retries = get(['retries']);
                if (retries !== undefined) lines.push('      next-upstream-tries: ' + retries + '  # retries');
                let cookie = get(['cookie']);
                if (cookie !== undefined) {
                    let cookieName = (cookie && typeof cookie === 'object') ? cookie.name : cookie;
                    lines.push('      sessionCookie:', '        enable: true', '        name: ' + (cookieName || 'SERVERID') + '  # cookie');
                }
                let ds = get(['default-server']);
                if (ds && typeof ds === 'object' && ds.maxconn !== undefined) {
                    lines.push('      max-conns: ' + ds.maxconn + '  # default_server.maxconn');
                }
                lines.push('  routes:', '    - path: ' + specPath(basics), '      action:', '        pass: backend');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                let check = get(['check', 'httpchk-params', 'adv-check']);
                if (check !== undefined) {
                    out.notes.push({ code: label + ' (health checks)', message: 'Active backend probes (check/httpchk) require NGINX Plus — VirtualServer upstreams[].healthCheck. On OSS, use passive max-fails + fail-timeout.' });
                }
                let rules = ['acl-list', 'http-request-rule-list', 'http-response-rule-list', 'server-switching-rule-list', 'stick-table'].filter(function(n) { return get([n]) !== undefined; });
                if (rules.length > 0) {
                    out.notes.push({ code: label + ' (rule lists)', message: 'ACLs / http-request / http-response / switching rules do not port as data — re-express as VirtualServer matches, Policies, or (last resort) snippets: ' + rules.join(', ') + '. Plain stick-table persistence → sessionCookie; other stick tables have no equivalent.' });
                }
                out.notes.push({ code: label, message: 'Drop the cr-backend annotation/pointer — the CR contents become VirtualServer upstream fields (shown above) or nginx.org/* annotations on the Ingress. If the cr-backend was ConfigMap-scoped, replicate the settings per application.' });
                return out;
            },

            generateFrontendCRD: function(finding, context) {
                let out = contribution();
                let config = (finding.data && finding.data.config) || {};
                let label = finding.label;
                let binds = null;
                for (let key in config) {
                    if (String(key).toLowerCase() === 'binds') binds = config[key];
                }
                let ports = [];
                if (binds && typeof binds === 'object') {
                    let bindList = Array.isArray(binds) ? binds : Object.keys(binds).map(function(k) { return binds[k]; });
                    bindList.forEach(function(b) { if (b && b.port) ports.push(b.port); });
                }
                out.notes.push({ code: label, message: 'There is no single NIC construct that amends a listener — Frontend CRs decompose into: listener ports → -default-http-listener-port/-default-https-listener-port flags or GlobalConfiguration listeners' + (ports.length ? ' (found binds on port ' + ports.join(', ') + ')' : '') + '; accept_proxy → ConfigMap proxy-protocol; log options → ConfigMap log-format/access-log; http-request/response rules → server-snippets (rewrite by hand). ALPN bind options have no NIC control. Test in pre-production first — a misconfigured listener affects every application.' });
                return out;
            },

            generateTCPCRD: function(finding, context) {
                let out = contribution();
                let spec = (finding.data && finding.data.spec) || {};
                let items = Array.isArray(spec) ? spec : [spec];
                let listeners = [];
                let servers = [];
                let droppedRules = [];
                items.forEach(function(item, idx) {
                    if (!item || typeof item !== 'object') return;
                    let name = sanitizeName(item.name || (finding.resourceName + '-' + (idx + 1)));
                    let svc = item.service || {};
                    let frontend = item.frontend || {};
                    let port = null;
                    let ssl = false;
                    let sslCert = null;
                    let binds = frontend.binds;
                    if (binds && typeof binds === 'object') {
                        let bindList = Array.isArray(binds) ? binds : Object.keys(binds).map(function(k) { return binds[k]; });
                        bindList.forEach(function(b) {
                            if (!b) return;
                            if (b.port && port === null) port = b.port;
                            if (b.ssl === true) ssl = true;
                            if (b.ssl_certificate) sslCert = b.ssl_certificate;
                        });
                    }
                    listeners.push({ name: name + '-tcp', port: port || '# TODO: port', protocol: 'TCP' });
                    let ts = ['apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + name, 'spec:',
                        '  listener:', '    name: ' + name + '-tcp', '    protocol: TCP'];
                    if (ssl) {
                        ts.push('  host: # TODO: SNI hostname — NIC TCP TLS termination is SNI-routed (REQUIRED with tls)');
                        ts.push('  tls:', '    secret: ' + (sslCert && String(sslCert).indexOf('/') === -1 ? sslCert : '# TODO: kubernetes.io/tls Secret in this namespace' + (sslCert ? ' (from ' + cmt(sslCert) + ')' : '')));
                    }
                    ts.push('  upstreams:', '    - name: backend', '      service: ' + (svc.name || '# TODO: service'), '      port: ' + (svc.port || '# TODO: port'),
                        '  action:', '    pass: backend');
                    servers.push(ts.join('\n'));
                    ['acls', 'acl_list', 'backend_switching_rule_list', 'tcp_request_rule_list', 'capture_list', 'filter_list', 'log_target_list'].forEach(function(rk) {
                        if (item[rk] !== undefined || (item.frontend && item.frontend[rk] !== undefined)) droppedRules.push(rk);
                    });
                    if (Array.isArray(item.services) && item.services.length > 0) {
                        out.notes.push({ code: finding.label + ' (' + name + ' extra services)', message: 'Additional services on one TCP entry have no routing mechanism in a TransportServer (no L4 content switching) — each backend needs its own listener + TransportServer.' });
                    }
                });
                let gc = ['apiVersion: k8s.nginx.org/v1', 'kind: GlobalConfiguration', 'metadata:', '  name: nginx-configuration', '  namespace: nginx-ingress', 'spec:', '  listeners:'];
                listeners.forEach(function(l) {
                    gc.push('    - name: ' + l.name, '      port: ' + l.port, '      protocol: TCP');
                });
                gc.push('', '# One GlobalConfiguration per controller (-global-configuration <ns>/<name>);', '# merge these listeners into yours, and expose the ports on the controller Service.');
                out.crds.push({ kind: 'GlobalConfiguration', yaml: gc.join('\n') });
                servers.forEach(function(y) { out.crds.push({ kind: 'TransportServer', yaml: y }); });
                if (droppedRules.length > 0) {
                    out.notes.push({ code: finding.label + ' (L4 rules)', message: 'TransportServer has no ACL / content-switching / tcp-request fields — dropped: ' + droppedRules.join(', ') + '. The only escape hatch is spec.streamSnippets (-enable-snippets). Per-service TCP logs collapse into the global stream-log-format.' });
                }
                return out;
            },

            generateTcpServicesCM: function(finding, context) {
                let out = contribution();
                let entries = (finding.data && finding.data.entries) || [];
                let gc = ['apiVersion: k8s.nginx.org/v1', 'kind: GlobalConfiguration', 'metadata:', '  name: nginx-configuration', '  namespace: nginx-ingress', 'spec:', '  listeners:'];
                let servers = [];
                entries.forEach(function(e) {
                    let lname = sanitizeName(e.service) + '-' + e.listenPort + '-tcp';
                    gc.push('    - name: ' + lname, '      port: ' + e.listenPort, '      protocol: TCP');
                    let ts = ['apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + sanitizeName(e.service) + '-' + e.listenPort, '  namespace: ' + e.namespace, 'spec:',
                        '  listener:', '    name: ' + lname, '    protocol: TCP'];
                    if (e.ssl) {
                        ts.push('  host: # TODO: SNI hostname — HAProxy ssl-offload was hostless, but NIC TCP TLS termination is SNI-routed');
                        ts.push('  tls:', '    secret: # TODO: kubernetes.io/tls Secret with the certificate HAProxy used');
                    }
                    ts.push('  upstreams:', '    - name: backend', '      service: ' + e.service, '      port: ' + e.servicePort,
                        '  action:', '    pass: backend');
                    servers.push(ts.join('\n'));
                });
                gc.push('', '# One GlobalConfiguration per controller (-global-configuration <ns>/<name>);', '# merge these listeners into yours, and expose the ports on the controller Service.');
                out.crds.push({ kind: 'GlobalConfiguration', yaml: gc.join('\n') });
                servers.forEach(function(y) { out.crds.push({ kind: 'TransportServer', yaml: y }); });
                if (entries.some(function(e) { return e.ssl; })) {
                    out.notes.push({ code: 'tcp-services :ssl entries', message: 'HAProxy tcp-services SSL offload terminates without a hostname; NIC TransportServer TLS termination is SNI-based — assign each entry an SNI host. Truly hostless TLS-over-TCP is not expressible.' });
                }
                return out;
            }
        };

        // --- Mapping registry ----------------------------------------------------
        // keys: parseInput finding keys (already canonicalized — one key per
        // construct regardless of the scope it was found at). grouped: true = one
        // generator call with all findings of the entry; false = one call per
        // finding (each CRD instance converts independently).

        const HAPROXY_MAPPINGS = [
            // Access control & real IP
            { keys: ['annotation:allow-list', 'annotation:deny-list', 'annotation:blacklist', 'annotation:whitelist'], source: 'allow-list / deny-list (+ deprecated blacklist/whitelist)', nic: 'Policy CRD accessControl allow[]/deny[] (+ nginx.org/policies on Ingress)', type: 'policy', category: 'Access Control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'generateAccessControl' },
            { keys: ['annotation:src-ip-header'], source: 'src-ip-header', nic: 'ConfigMap real-ip-header + set-real-ip-from + real-ip-recursive (global)', type: 'configmap', category: 'Access Control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'generateSrcIpHeader' },
            { keys: ['configmap:proxy-protocol'], source: 'proxy-protocol (inbound)', nic: 'ConfigMap proxy-protocol + set-real-ip-from + real-ip-header: proxy_protocol', type: 'configmap', category: 'Access Control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'generateProxyProtocol' },
            { keys: ['annotation:send-proxy-protocol'], source: 'send-proxy-protocol', nic: 'No direct equivalent — PROXY-to-backend does not exist for HTTP upstreams; TCP/UDP only via TransportServer streamSnippets (proxy_protocol on; sends PROXY v1 only, requires -enable-snippets)', type: 'unsupported', category: 'Access Control', anchor: 'access-control', section: 'oss', grouped: true },
            { keys: ['annotation:forwarded-for'], source: 'forwarded-for', nic: 'Automatic — NIC always sends X-Forwarded-For', type: 'annotation', category: 'Access Control', anchor: 'access-control', section: 'oss', grouped: true, generator: 'generateForwardedFor' },

            // Authentication
            { keys: ['annotation:auth-type', 'annotation:auth-secret', 'annotation:auth-realm'], source: 'auth-type / auth-secret / auth-realm', nic: 'Policy CRD basicAuth — or — nginx.org/basic-auth-secret + nginx.org/basic-auth-realm (Ingress)', type: 'policy', category: 'Authentication', anchor: 'authentication', section: 'oss', grouped: true, dualApproach: true, generator: 'generateBasicAuth' },

            // Client mTLS
            { keys: ['configmap:client-ca', 'configmap:client-crt-optional'], source: 'client-ca / client-crt-optional', nic: 'Policy CRD ingressMTLS (clientCertSecret + verifyClient)', type: 'policy', category: 'Client mTLS', anchor: 'client-mtls', section: 'oss', grouped: true, generator: 'generateClientMTLS' },
            { keys: ['annotation:client-strict-sni'], source: 'client-strict-sni', nic: 'Side effect of the -default-server-tls-secret flag (unset = reject unknown SNI)', type: 'annotation', category: 'Client mTLS', anchor: 'client-mtls', section: 'oss', grouped: true, generator: 'generateClientStrictSni' },

            // Backend TLS
            { keys: ['annotation:server-ca', 'annotation:server-crt'], source: 'server-ca / server-crt', nic: 'Policy CRD egressMTLS (trustedCertSecret + verifyServer / tlsSecret) + nginx.org/ssl-services', type: 'policy', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true, generator: 'generateBackendMTLS' },
            { keys: ['annotation:server-ssl'], source: 'server-ssl', nic: 'nginx.org/ssl-services — or — VirtualServer upstreams[].tls.enable', type: 'annotation', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true, generator: 'generateServerSSL' },
            { keys: ['annotation:server-proto'], source: 'server-proto', nic: 'nginx.org/grpc-services (h2c, gRPC backends only) — generic backend HTTP/2 has no equivalent', type: 'annotation', category: 'Backend TLS', anchor: 'backend-tls', section: 'oss', grouped: true, generator: 'generateServerProto' },

            // Session persistence
            { keys: ['annotation:cookie-persistence', 'annotation:cookie-persistence-no-dynamic'], source: 'cookie-persistence / cookie-persistence-no-dynamic', nic: 'VirtualServer upstreams[].sessionCookie', type: 'virtualserver', category: 'Session Persistence', anchor: 'session-persistence', section: 'oss', grouped: true, generator: 'generateCookiePersistence' },

            // Rate limiting
            { keys: ['annotation:rate-limit-requests', 'annotation:rate-limit-period', 'annotation:rate-limit-size', 'annotation:rate-limit-status-code'], source: 'rate-limit-*', nic: 'Policy CRD rateLimit — or — nginx.org/limit-req-* annotations (Ingress)', type: 'policy', category: 'Rate Limiting', anchor: 'rate-limiting', section: 'oss', grouped: true, dualApproach: true, generator: 'generateRateLimit' },
            { keys: ['annotation:rate-limit-whitelist'], source: 'rate-limit-whitelist', nic: 'No direct equivalent — rateLimit Policy and nginx.org/limit-req-* have no exclusion field; last-resort geo/map snippet blanking the limit key', type: 'unsupported', category: 'Rate Limiting', anchor: 'rate-limiting', section: 'oss', grouped: true },

            // CORS
            { keys: ['annotation:cors-enable', 'annotation:cors-allow-origin', 'annotation:cors-allow-methods', 'annotation:cors-allow-headers', 'annotation:cors-allow-credentials', 'annotation:cors-max-age'], source: 'cors-*', nic: 'Policy CRD cors (+ nginx.org/policies on Ingress)', type: 'policy', category: 'CORS', anchor: 'cors', section: 'oss', grouped: true, generator: 'generateCORS' },
            { keys: ['annotation:cors-respond-to-options'], source: 'cors-respond-to-options', nic: 'No direct equivalent — the NIC cors Policy is header-only (no preflight 204 short-circuit; OPTIONS reaches the backend); last-resort location-snippet returning 204', type: 'unsupported', category: 'CORS', anchor: 'cors', section: 'oss', grouped: true },

            // Headers
            { keys: ['annotation:request-set-header', 'annotation:response-set-header', 'annotation:set-host'], source: 'request-set-header / response-set-header / set-host', nic: 'VirtualServer requestHeaders.set / responseHeaders.add — or — nginx.org/proxy-set-headers + nginx.org/add-header', type: 'virtualserver', category: 'Headers', anchor: 'headers', section: 'oss', grouped: true, dualApproach: true, generator: 'generateHeaders' },

            // Observability
            { keys: ['annotation:request-capture', 'annotation:request-capture-len'], source: 'request-capture (+ -len)', nic: 'ConfigMap log-format with $http_* / $cookie_* variables (global)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateRequestCapture' },
            { keys: ['configmap:syslog-server'], source: 'syslog-server', nic: 'ConfigMap access-log (syslog: destination)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateSyslogServer' },
            { keys: ['configmap:log-format'], source: 'log-format', nic: 'ConfigMap log-format (hand-translated)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateLogFormat' },
            { keys: ['configmap:log-format-tcp'], source: 'log-format-tcp', nic: 'ConfigMap stream-log-format (hand-translated)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateLogFormat' },
            { keys: ['configmap:dontlognull', 'configmap:logasap'], source: 'dontlognull / logasap', nic: 'No direct equivalent (generally moot — see notes)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateLogNoise' },

            // Health checks
            { keys: ['annotation:check'], source: 'check', nic: 'nginx.org/max-fails + nginx.org/fail-timeout (OSS passive) — active probes are NGINX Plus', type: 'annotation', category: 'Health Checks', anchor: 'health-checks', section: 'oss', grouped: true, generator: 'generateCheck' },
            { keys: ['annotation:check-http', 'annotation:check-interval', 'annotation:timeout-check'], source: 'check-http / check-interval / timeout-check', nic: 'VirtualServer upstreams[].healthCheck (NGINX Plus)', type: 'virtualserver', category: 'Health Checks', anchor: 'health-checks', section: 'oss', grouped: true, plusRequired: true, generator: 'generateActiveHealthCheck' },

            // Load balancing
            { keys: ['annotation:load-balance'], source: 'load-balance', nic: 'nginx.org/lb-method / ConfigMap lb-method / VirtualServer upstreams[].lb-method', type: 'annotation', category: 'Load Balancing', anchor: 'load-balancing', section: 'oss', grouped: true, generator: 'generateLoadBalance' },

            // Miscellaneous (not applicable on NIC)
            { keys: ['annotation:scale-server-slots', 'annotation:standalone-backend', 'annotation:abortonclose', 'annotation:clean-certs'], source: 'scale-server-slots / standalone-backend / abortonclose / clean-certs', nic: 'Not applicable — NIC architecture makes these unnecessary (see notes)', type: 'annotation', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss', grouped: true, generator: 'generateNotApplicable' },

            // Rewrites & redirects
            { keys: ['annotation:path-rewrite'], source: 'path-rewrite', nic: 'nginx.org/rewrite-target (+ nginx.org/path-regex) — or — VirtualServer regex path + rewritePath', type: 'annotation', category: 'Rewrites', anchor: 'rewrites', section: 'oss', grouped: true, generator: 'generatePathRewrite' },
            { keys: ['annotation:request-redirect', 'annotation:request-redirect-code'], source: 'request-redirect (+ -code)', nic: 'VirtualServer action.redirect {url, code} (HAProxy default 302)', type: 'virtualserver', category: 'Redirects', anchor: 'redirects', section: 'oss', grouped: true, generator: 'generateRequestRedirect' },
            { keys: ['annotation:ssl-redirect', 'annotation:ssl-redirect-code'], source: 'ssl-redirect (+ -code)', nic: 'nginx.org/ssl-redirect + nginx.org/http-redirect-code (emit 302 explicitly — NIC defaults to 301)', type: 'annotation', category: 'Redirects', anchor: 'redirects', section: 'oss', grouped: true, generator: 'generateSSLRedirect' },
            { keys: ['annotation:ssl-redirect-port'], source: 'ssl-redirect-port', nic: 'No direct equivalent — NIC redirects to its own HTTPS listener port; bake a custom port into a VirtualServer redirect URL', type: 'annotation', category: 'Redirects', anchor: 'redirects', section: 'oss', grouped: true, generator: 'generateSSLRedirectPort' },

            // Timeouts & connection handling
            { keys: ['configmap:timeout-connect', 'configmap:timeout-http-keep-alive', 'annotation:timeout-server', 'configmap:timeout-tunnel', 'configmap:timeout-client', 'configmap:timeout-http-request', 'configmap:timeout-queue'], source: 'timeout-*', nic: 'proxy-connect/read/send-timeout + keepalive-timeout keys/annotations (client-side timeouts: http-snippets; queue: NGINX Plus)', type: 'annotation', category: 'Timeouts', anchor: 'timeouts', section: 'oss', grouped: true, generator: 'generateTimeout' },
            { keys: ['configmap:timeout-client-fin', 'configmap:timeout-server-fin'], source: 'timeout-client-fin / timeout-server-fin', nic: 'No direct equivalent — NGINX has no half-closed (FIN_WAIT) timeout knobs', type: 'unsupported', category: 'Timeouts', anchor: 'timeouts', section: 'oss', grouped: true },
            { keys: ['configmap:http-connection-mode', 'configmap:http-keep-alive', 'configmap:http-server-close'], source: 'http-connection-mode (+ deprecated aliases)', nic: 'Split: ConfigMap keepalive (upstream count) + keepalive-timeout (client)', type: 'configmap', category: 'Connection Handling', anchor: 'connection-handling', section: 'oss', grouped: true, generator: 'generateConnectionMode' },
            { keys: ['configmap:maxconn', 'configmap:nbthread'], source: 'maxconn / nbthread', nic: 'ConfigMap worker-connections / worker-processes (approximate — model differs)', type: 'configmap', category: 'Connection Handling', anchor: 'connection-handling', section: 'oss', grouped: true, generator: 'generateWorkerTuning' },
            { keys: ['annotation:pod-maxconn'], source: 'pod-maxconn', nic: 'nginx.org/max-conns (VirtualServer upstreams[].max-conns)', type: 'annotation', category: 'Connection Handling', anchor: 'connection-handling', section: 'oss', grouped: true, generator: 'generatePodMaxconn' },

            // TLS & certificates
            { keys: ['annotation:ssl-certificate'], source: 'ssl-certificate', nic: '-default-server-tls-secret deployment flag (+ per-app spec.tls)', type: 'annotation', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateSSLCertificate' },
            { keys: ['annotation:ssl-passthrough'], source: 'ssl-passthrough', nic: 'TransportServer TLS_PASSTHROUGH (+ -enable-tls-passthrough flag)', type: 'transportserver', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateSSLPassthrough' },
            { keys: ['annotation:tls-alpn'], source: 'tls-alpn', nic: 'ConfigMap http2 (HTTP/2 on/off only — no general ALPN control)', type: 'configmap', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateTlsAlpn' },
            { keys: ['annotation:generate-certificates-signer'], source: 'generate-certificates-signer', nic: 'No direct equivalent — NIC has no on-the-fly certificate signing; pre-issue certificates via cert-manager', type: 'unsupported', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true },
            { keys: ['annotation:quic-alt-svc-max-age'], source: 'quic-alt-svc-max-age', nic: 'No direct equivalent — NIC v5.5.1 has no QUIC/HTTP-3 support', type: 'unsupported', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true },

            // Routing
            { keys: ['annotation:ingress.class'], source: 'ingress.class (deprecated annotation)', nic: 'Ingress spec.ingressClassName (exact match to -ingress-class; the IngressClass must exist)', type: 'annotation', category: 'Routing', anchor: 'routing', section: 'oss', grouped: true, generator: 'generateIngressClass' },
            { keys: ['kind:Ingress'], source: 'Ingress spec (pathType / wildcard hosts / defaultBackend)', nic: 'Ingress ports as-is — pathType Prefix boundary and class matching need review (see notes)', type: 'annotation', category: 'Routing', anchor: 'routing', section: 'oss', grouped: true, generator: 'generateIngressSpecNotes' },

            // Traffic splitting / canary
            { keys: ['annotation:route-acl'], source: 'route-acl (canary / ACL routing)', nic: 'VirtualServer routes[].splits (rand percentages) / matches[].conditions (cookie, header, argument, method)', type: 'virtualserver', category: 'Traffic Splitting', anchor: 'traffic-splitting', section: 'oss', grouped: true, generator: 'generateRouteACL' },

            // Configuration snippets
            { keys: ['annotation:backend-config-snippet'], source: 'backend-config-snippet', nic: 'nginx.org/location-snippets (content must be rewritten as NGINX directives; -enable-snippets)', type: 'annotation', category: 'Configuration Snippets', anchor: 'configuration-snippets', section: 'oss', grouped: true, generator: 'generateBackendSnippet' },
            { keys: ['configmap:frontend-config-snippet'], source: 'frontend-config-snippet', nic: 'ConfigMap server-snippets (rewritten as NGINX directives)', type: 'configmap', category: 'Configuration Snippets', anchor: 'configuration-snippets', section: 'oss', grouped: true, generator: 'generateFrontendSnippet' },
            { keys: ['configmap:global-config-snippet'], source: 'global-config-snippet', nic: 'ConfigMap main-snippets / http-snippets (native ssl-* keys preferred where they exist)', type: 'configmap', category: 'Configuration Snippets', anchor: 'configuration-snippets', section: 'oss', grouped: true, generator: 'generateGlobalSnippet' },
            { keys: ['configmap:stats-config-snippet'], source: 'stats-config-snippet', nic: 'No stats frontend on NIC — Prometheus /metrics + Grafana instead', type: 'configmap', category: 'Configuration Snippets', anchor: 'configuration-snippets', section: 'oss', grouped: true, generator: 'generateStatsSnippet' },
            { keys: ['kind:ValidationRules'], source: 'ValidationRules CRD (custom annotations)', nic: 'No direct equivalent — NIC has a fixed annotation vocabulary (no CEL/template custom-annotation framework); re-express the intent via native constructs or snippets', type: 'unsupported', category: 'Configuration Snippets', anchor: 'configuration-snippets', section: 'oss' },

            // Global / lifecycle
            { keys: ['configmap:hard-stop-after'], source: 'hard-stop-after', nic: 'ConfigMap worker-shutdown-timeout', type: 'configmap', category: 'Global Settings', anchor: 'global-settings', section: 'oss', grouped: true, generator: 'generateHardStopAfter' },

            // HAProxy CRDs
            { keys: ['kind:Global'], source: 'Global CRD', nic: 'NIC ConfigMap global keys (worker-*, ssl-*)', type: 'configmap', category: 'HAProxy CRDs', anchor: 'haproxy-crds', section: 'oss', generator: 'generateGlobalCRD' },
            { keys: ['kind:Defaults'], source: 'Defaults CRD', nic: 'NIC ConfigMap proxy/keepalive/log keys', type: 'configmap', category: 'HAProxy CRDs', anchor: 'haproxy-crds', section: 'oss', generator: 'generateDefaultsCRD' },
            { keys: ['kind:Backend'], source: 'Backend CRD', nic: 'VirtualServer upstreams[] fields / nginx.org/* annotations', type: 'virtualserver', category: 'HAProxy CRDs', anchor: 'haproxy-crds', section: 'oss', generator: 'generateBackendCRD' },
            { keys: ['kind:Frontend'], source: 'Frontend CRD (v3-only)', nic: 'Split: listener flags/GlobalConfiguration + ConfigMap keys + server-snippets', type: 'globalconfiguration', category: 'HAProxy CRDs', anchor: 'haproxy-crds', section: 'oss', generator: 'generateFrontendCRD' },
            { keys: ['kind:TCP'], source: 'TCP CRD', nic: 'GlobalConfiguration TCP listener + TransportServer per entry', type: 'transportserver', category: 'TCP Services', anchor: 'tcp-services', section: 'oss', generator: 'generateTCPCRD' },
            { keys: ['configmap:tcp-services'], source: 'tcp-services ConfigMap', nic: 'GlobalConfiguration TCP listener + TransportServer per entry', type: 'transportserver', category: 'TCP Services', anchor: 'tcp-services', section: 'oss', generator: 'generateTcpServicesCM' },

            // Enterprise → Plus
            { keys: ['annotation:modsecurity'], source: 'modsecurity (Enterprise WAF)', nic: 'Policy CRD waf (NGINX Plus + App Protect, via nginx.com/policies)', type: 'policy', category: 'WAF', anchor: 'waf', section: 'plus', plusRequired: true, grouped: true, generator: 'generateModsecurity' }
        ];

        const HAPROXY_LOOKUP = new Map();
        HAPROXY_MAPPINGS.forEach(function(mapping, idx) {
            mapping.keys.forEach(function(key) {
                HAPROXY_LOOKUP.set(key, idx);
            });
        });

        // --- MigrationPlan builder ---------------------------------------------

        function truncateYaml(text, maxLines) {
            let lines = String(text).split('\n');
            if (lines.length <= maxLines) return text;
            return lines.slice(0, maxLines).join('\n') + '\n# … (' + (lines.length - maxLines) + ' more lines)';
        }

        function buildPlan(parsed, strategy) {
            let findings = parsed.findings;
            let context = parsed.context;
            let totalFindings = parsed.foundCount;
            let warnings = parsed.warnings ? parsed.warnings.slice() : [];

            // Match findings against the registry. Grouped entries collect all their
            // findings for one generator call; ungrouped entries convert per finding.
            let matchedEntries = new Map();   // idx → { mapping, findings: [] }
            let unrecognized = [];
            findings.forEach(function(f) {
                let idx = HAPROXY_LOOKUP.get(f.key);
                if (idx === undefined) {
                    unrecognized.push(f);
                    return;
                }
                if (!matchedEntries.has(idx)) matchedEntries.set(idx, { mapping: HAPROXY_MAPPINGS[idx], findings: [] });
                matchedEntries.get(idx).findings.push(f);
            });

            let typeOrder = { policy: 0, virtualserver: 1, virtualserverroute: 2, transportserver: 3, globalconfiguration: 4, annotation: 5, configmap: 6, unsupported: 7 };
            let sorted = Array.from(matchedEntries.values()).sort(function(a, b) {
                let ta = typeOrder[a.mapping.type] !== undefined ? typeOrder[a.mapping.type] : 99;
                let tb = typeOrder[b.mapping.type] !== undefined ? typeOrder[b.mapping.type] : 99;
                if (ta !== tb) return ta - tb;
                return a.mapping.category.localeCompare(b.mapping.category);
            });

            // Run generators and aggregate contributions.
            let swaps = [];
            let configMapChanges = [];
            let crdItems = [];        // { kind, yaml, oldYaml, category, plusRequired }
            let infoNotes = [];
            let unsupportedGroups = [];

            // Old-side YAML for a grouped entry: annotations block + ConfigMap data
            // block + comment lines for structural findings.
            function groupOldYaml(groupFindings) {
                let annLines = [];
                let cmLines = [];
                let other = [];
                groupFindings.forEach(function(f) {
                    if (f.key.indexOf('annotation:') === 0 && f.data && f.data.scope !== 'configmap') {
                        annLines.push(formatYamlKV('  ', f.label, f.value) + (f.data && f.data.scope === 'service' ? '  # on Service ' + (f.data.serviceName || '') : ''));
                    } else if (f.key.indexOf('annotation:') === 0 || f.key.indexOf('configmap:') === 0) {
                        cmLines.push(formatYamlKV('  ', f.label.replace(/ \(ConfigMap\)$/, ''), f.value));
                    } else {
                        other.push('# ' + f.label);
                    }
                });
                let parts = [];
                if (annLines.length > 0) parts.push(['annotations:'].concat(annLines).join('\n'));
                if (cmLines.length > 0) parts.push(['data:  # (HAProxy ConfigMap)'].concat(cmLines).join('\n'));
                if (other.length > 0) parts.push(other.join('\n'));
                return parts.join('\n') || '# (source not shown)';
            }

            sorted.forEach(function(entry) {
                let mapping = entry.mapping;
                if (mapping.type === 'unsupported') {
                    unsupportedGroups.push(entry);
                    return;
                }
                let gen = mapping.generator ? GENERATORS[mapping.generator] : null;
                if (!gen) return;
                function absorb(out, oldYaml) {
                    if (!out) return;
                    (out.swaps || []).forEach(function(s) { s.entry = entry; swaps.push(s); });
                    (out.configMap || []).forEach(function(c) { c.entry = entry; configMapChanges.push(c); });
                    (out.crds || []).forEach(function(c) {
                        crdItems.push({ kind: c.kind, yaml: c.yaml, oldYaml: oldYaml, category: mapping.category, plusRequired: !!mapping.plusRequired, entry: entry });
                    });
                    (out.notes || []).forEach(function(n) { infoNotes.push(n); });
                }
                try {
                    if (mapping.grouped) {
                        absorb(gen(entry.findings, context, strategy), groupOldYaml(entry.findings));
                    } else {
                        entry.findings.forEach(function(f) {
                            absorb(gen(f, context, strategy), truncateYaml(f.raw || ('# ' + f.label), 40));
                        });
                    }
                } catch (e) {
                    console.warn('HAProxy generator failed for ' + mapping.source + ':', e);
                }
            });

            // Deduplicate annotation swaps by target key — two sources mapping to
            // the same nginx.org annotation would emit duplicate YAML map keys.
            let seenSwapKeys = {};
            swaps = swaps.filter(function(s) {
                let prev = seenSwapKeys[s.to];
                if (!prev) { seenSwapKeys[s.to] = s; return true; }
                if (s.value !== prev.value) {
                    prev.note = (prev.note ? prev.note + '; ' : '') + 'conflicting value from ' + (s.fromKey || s.fromLabel) + ' ignored';
                }
                return false;
            });

            // Several sources can map to the same ConfigMap key — keep the first
            // occurrence and flag conflicting values.
            let seenCmKeys = {};
            configMapChanges = configMapChanges.filter(function(c) {
                let prev = seenCmKeys[c.to];
                if (!prev) { seenCmKeys[c.to] = c; return true; }
                if (c.value !== prev.value) {
                    prev.note = (prev.note ? prev.note + '; ' : '') + 'conflicting value from ' + c.fromLabel + ' ignored';
                }
                return false;
            });

            // Summary pills
            let pills = [];
            pills.push({ cls: 'found', text: totalFindings + ' HAProxy item' + (totalFindings !== 1 ? 's' : '') + ' found', scrollTo: null });
            pills.push({ cls: 'paths', text: sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : ''), scrollTo: swaps.length > 0 ? 'analyzer-step-1' : (crdItems.length > 0 ? 'analyzer-step-3' : null) });
            if (crdItems.length > 0) pills.push({ cls: 'crds', text: crdItems.length + ' require CRDs', scrollTo: 'analyzer-step-3' });
            if (unrecognized.length > 0) pills.push({ cls: 'unrecognized', text: unrecognized.length + ' unrecognized', scrollTo: 'analyzer-unrecognized' });

            let liveText = totalFindings + ' HAProxy item' + (totalFindings !== 1 ? 's' : '') + ' found, ' + sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : '');
            if (crdItems.length > 0) liveText += ', ' + crdItems.length + ' require CRDs';
            if (unrecognized.length > 0) liveText += ', ' + unrecognized.length + ' unrecognized';

            let stepCount = (swaps.length > 0 ? 1 : 0) + (configMapChanges.length > 0 ? 1 : 0) + (crdItems.length > 0 ? 1 : 0);
            let banner = {
                strongText: totalFindings + ' HAProxy items analyzed',
                restText: ', ' + sorted.length + ' migration paths across ' + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + '.',
                complexity: crdItems.length > 0 ? 'advanced' : configMapChanges.length > 0 ? 'moderate' : 'simple'
            };

            let steps = [];

            // Step: Annotation swaps
            if (swaps.length > 0) {
                let oldLines = ['annotations:'];
                let newLines = ['annotations:'];
                let swapsByCategory = {};
                swaps.forEach(function(swap) {
                    let cat = swap.entry.mapping.category;
                    if (!swapsByCategory[cat]) swapsByCategory[cat] = [];
                    swapsByCategory[cat].push(swap);
                });
                let categoryKeys = Object.keys(swapsByCategory).sort();
                let multiCategory = categoryKeys.length > 1;
                categoryKeys.forEach(function(cat) {
                    if (multiCategory) {
                        oldLines.push('  # ' + cat);
                        newLines.push('  # ' + cat);
                    }
                    swapsByCategory[cat].forEach(function(swap) {
                        if (swap.fromKey) {
                            oldLines.push(formatYamlKV('  ', swap.fromKey, swap.fromValue != null ? swap.fromValue : ''));
                        } else {
                            oldLines.push('  # ' + swap.fromLabel);
                        }
                        let shortName = String(swap.fromKey || swap.fromLabel).replace(/^(haproxy\.org\/|haproxy\.com\/|ingress\.kubernetes\.io\/)/, '');
                        let commentText = shortName + (swap.note ? ' — ' + swap.note : '');
                        let newLine = formatYamlKV('  ', swap.to, swap.value);
                        if (newLine.indexOf(': |\n') !== -1) {
                            newLine = newLine.replace(': |', ': |  # ' + commentText);
                        } else {
                            newLine += '  # ' + commentText;
                        }
                        newLines.push(newLine);
                    });
                });
                steps.push({
                    id: 'analyzer-step-1',
                    title: 'Swap Annotations',
                    countText: swaps.length + ' annotation' + (swaps.length !== 1 ? 's' : ''),
                    countCls: '',
                    desc: 'Replace HAProxy annotations with their F5 NGINX Ingress Controller equivalents. Copy this annotations block into your Ingress metadata (NIC does not read config annotations from Service objects).',
                    blocks: [{
                        type: 'comparison',
                        old: { title: 'HAProxy Kubernetes Ingress Controller ', badge: 'current', yaml: oldLines.join('\n') },
                        new: { title: 'F5 NGINX Ingress Controller ', badge: 'migrated', yaml: newLines.join('\n') }
                    }]
                });
            }

            // Step: ConfigMap changes (global settings)
            if (configMapChanges.length > 0) {
                let cmOldLines = ['# HAProxy configuration'];
                let cmLines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: nginx-config', 'data:'];
                configMapChanges.forEach(function(change) {
                    cmOldLines.push('# ' + change.fromLabel);
                    let cmComment = change.fromLabel + (change.note ? ' — ' + change.note : '');
                    let cmLine = formatYamlKV('  ', change.to, change.value);
                    if (cmLine.indexOf(': |\n') !== -1) {
                        // Keep the comment on the "key: |" line — appending after a block
                        // scalar would make it part of the ConfigMap value.
                        cmLine = cmLine.replace(': |', ': |  # ' + cmComment);
                    } else {
                        cmLine += '  # ' + cmComment;
                    }
                    cmLines.push(cmLine);
                });
                steps.push({
                    id: 'analyzer-step-2',
                    title: 'ConfigMap Changes',
                    countText: configMapChanges.length + ' entr' + (configMapChanges.length !== 1 ? 'ies' : 'y'),
                    countCls: 'configmap',
                    desc: 'These HAProxy settings map to the global NGINX ConfigMap — they apply to every application, not per route. Update your nginx-config ConfigMap with these entries.',
                    blocks: [{
                        type: 'comparison',
                        old: { title: 'HAProxy Kubernetes Ingress Controller (current)', badge: null, yaml: cmOldLines.join('\n') },
                        new: { title: 'F5 NGINX Ingress Controller (migrated)', badge: null, yaml: cmLines.join('\n') }
                    }]
                });
            }

            // Step: CRD resources
            if (crdItems.length > 0) {
                let blocks = [{ type: 'crd-install-note' }];
                let crdGroups = {};
                crdItems.forEach(function(item) {
                    if (!crdGroups[item.kind]) crdGroups[item.kind] = [];
                    crdGroups[item.kind].push(item);
                });
                Object.keys(crdGroups).forEach(function(kind) {
                    let group = crdGroups[kind];
                    blocks.push({
                        type: 'crd-group',
                        kind: kind,
                        countText: group.length + ' resource' + (group.length !== 1 ? 's' : ''),
                        items: group.map(function(item) {
                            return {
                                category: item.category,
                                plusRequired: item.plusRequired,
                                dualSuffix: null,
                                old: { title: 'HAProxy Kubernetes Ingress Controller (current)', badge: null, yaml: item.oldYaml || '# (source resource not shown)', collapsible: true },
                                new: { title: 'F5 NGINX Ingress Controller (migrated)', badge: null, yaml: item.yaml, collapsible: true }
                            };
                        })
                    });
                });
                steps.push({
                    id: 'analyzer-step-3',
                    title: 'CRD Resources',
                    countText: crdItems.length + ' resource' + (crdItems.length !== 1 ? 's' : ''),
                    countCls: 'crd',
                    desc: 'These features convert to Custom Resource Definitions. Install the CRDs first, then apply the generated resources.',
                    blocks: blocks
                });
            }

            // Unsupported features
            let unsupported = null;
            if (unsupportedGroups.length > 0) {
                let unsupCount = 0;
                unsupportedGroups.forEach(function(e) { unsupCount += e.findings.length; });
                unsupported = {
                    title: 'Unsupported Features',
                    countText: unsupCount + ' item' + (unsupCount !== 1 ? 's' : ''),
                    desc: 'These HAProxy features are recognized but have no direct equivalent in the F5 NGINX Ingress Controller. Review each one and take the recommended action.',
                    cards: unsupportedGroups.map(function(entry) {
                        return {
                            title: entry.mapping.source,
                            code: entry.findings.map(function(f) { return f.label; }).join(', '),
                            desc: entry.mapping.nic,
                            anchor: entry.mapping.anchor || null,
                            sidebarSection: entry.mapping.section === 'plus' ? 'plus-mappings' : 'mappings'
                        };
                    })
                };
            }

            // Unrecognized
            let unrecognizedSection = null;
            if (unrecognized.length > 0) {
                unrecognizedSection = {
                    title: 'Unrecognized HAProxy Configuration',
                    desc: 'These items were not found in the migration database. They may be custom annotations (ValidationRules), Enterprise-only, or not yet mapped.',
                    items: unrecognized.map(function(f) {
                        if (f.key.indexOf('annotation:') === 0 || f.key.indexOf('configmap:') === 0) {
                            return { yaml: (f.key.indexOf('configmap:') === 0 ? 'data:\n' : 'annotations:\n') + formatYamlKV('  ', f.label, f.value) };
                        }
                        return { yaml: '# ' + f.label + '\n' + truncateYaml(f.raw || '', 8) };
                    })
                };
            }

            // Export
            let exportData = null;
            if (swaps.length > 0 || configMapChanges.length > 0 || crdItems.length > 0) {
                let allYamlParts = [];
                if (swaps.length > 0) {
                    let swapLines = ['# Step 1: Annotation Swaps', 'annotations:'];
                    swaps.forEach(function(s) { swapLines.push(formatYamlKV('  ', s.to, s.value)); });
                    allYamlParts.push(swapLines.join('\n'));
                }
                if (configMapChanges.length > 0) {
                    let cmParts = ['# Step 2: ConfigMap Changes', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: nginx-config', 'data:'];
                    configMapChanges.forEach(function(c) { cmParts.push(formatYamlKV('  ', c.to, c.value)); });
                    allYamlParts.push(cmParts.join('\n'));
                }
                crdItems.forEach(function(item) {
                    allYamlParts.push('# Step 3: ' + item.category + ' (' + item.kind + ')\n' + item.yaml);
                });
                exportData = { parts: allYamlParts };
            }

            // What's Next?
            let nextItems = null;
            if (sorted.length > 0) {
                nextItems = [
                    { text: 'Review the full Migration Checklist', anchor: '#checklist' },
                    { text: 'Browse all annotation and CRD mappings', anchor: '#mappings' }
                ];
                if (crdItems.length > 0) nextItems.push({ text: 'Install the required CRDs', anchor: '#installation' });
                nextItems.push({ text: 'Check the F5 NGINX Ingress Controller docs', href: 'https://docs.nginx.com/nginx-ingress-controller/', external: true });
            }

            return {
                pills: pills,
                liveText: liveText,
                banner: banner,
                warnings: warnings,
                steps: steps,
                infoNotes: infoNotes,
                unsupported: unsupported,
                unrecognized: unrecognizedSection,
                export: exportData,
                nextItems: nextItems
            };
        }

        // Sample YAML presets
        let SAMPLE_PRESETS = {
            simple:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: simple-app\n' +
'  annotations:\n' +
'    haproxy.org/ssl-redirect: "true"\n' +
'    haproxy.org/ssl-redirect-code: "301"\n' +
'    haproxy.org/timeout-server: "50s"\n' +
'    haproxy.org/load-balance: "leastconn"\n' +
'    haproxy.org/cookie-persistence: "JSESSIONID"\n' +
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
'          - path: /\n' +
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
'  name: api-app\n' +
'  annotations:\n' +
'    haproxy.org/ssl-redirect: "true"\n' +
'    haproxy.org/path-rewrite: "/api/(.*) /\\\\1"\n' +
'    haproxy.org/rate-limit-requests: "100"\n' +
'    haproxy.org/rate-limit-period: "1s"\n' +
'    haproxy.org/rate-limit-status-code: "429"\n' +
'    haproxy.org/cors-enable: "true"\n' +
'    haproxy.org/cors-allow-origin: "https://app.example.com"\n' +
'    haproxy.org/cors-allow-methods: "GET, POST, PUT"\n' +
'    haproxy.org/cors-allow-credentials: "true"\n' +
'    haproxy.org/allow-list: "10.0.0.0/8, 192.168.0.0/16"\n' +
'spec:\n' +
'  ingressClassName: haproxy\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - api.example.com\n' +
'      secretName: api-tls\n' +
'  rules:\n' +
'    - host: api.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /api\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: api-service\n' +
'                port:\n' +
'                  number: 8080\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: Service\n' +
'metadata:\n' +
'  name: api-service\n' +
'  annotations:\n' +
'    haproxy.org/server-ssl: "true"\n' +
'    haproxy.org/check: "true"\n' +
'    haproxy.org/pod-maxconn: "100"\n' +
'spec:\n' +
'  selector:\n' +
'    app: api\n' +
'  ports:\n' +
'    - port: 8080',
            advanced:
'apiVersion: v1\n' +
'kind: Service\n' +
'metadata:\n' +
'  name: canary-service\n' +
'  annotations:\n' +
'    haproxy.org/route-acl: "rand(100) lt 25"\n' +
'spec:\n' +
'  selector:\n' +
'    app: canary\n' +
'  ports:\n' +
'    - port: 80\n' +
'---\n' +
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: enterprise-app\n' +
'  annotations:\n' +
'    haproxy.org/ssl-redirect: "true"\n' +
'    haproxy.org/auth-type: "basic-auth"\n' +
'    haproxy.org/auth-secret: "default/credentials"\n' +
'    haproxy.org/auth-realm: "Restricted"\n' +
'    haproxy.org/backend-config-snippet: |\n' +
'      http-send-name-header X-Backend\n' +
'spec:\n' +
'  ingressClassName: haproxy\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - secure.example.com\n' +
'      secretName: enterprise-tls\n' +
'  rules:\n' +
'    - host: secure.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: web-service\n' +
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
'  syslog-server: "address:10.0.0.5, port:514, facility:local0, level:info"\n' +
'  maxconn: "50000"\n' +
'---\n' +
'apiVersion: v1\n' +
'kind: ConfigMap\n' +
'metadata:\n' +
'  name: tcp-services\n' +
'  namespace: default\n' +
'data:\n' +
'  "5432": "databases/postgres:5432"\n' +
'  "6443": "secure/ldap:636:ssl"\n' +
'---\n' +
'apiVersion: ingress.v3.haproxy.org/v3\n' +
'kind: Defaults\n' +
'metadata:\n' +
'  name: cr-defaults\n' +
'spec:\n' +
'  server_timeout: 60000\n' +
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
                pageNames: { 'getting-started': 'Getting Started', analyzer: 'Config Analyzer', reference: 'Reference Guide' }
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
                    { id: 'configmap-mappings', filterSource: 'configmap', search: 'searchInputConfigMap', category: 'categoryFilterConfigMap', count: 'searchCountConfigMap' }
                ],
                sectionPageMap: {
                    overview: 'getting-started', 'why-migrate': 'getting-started', features: 'getting-started', installation: 'getting-started', checklist: 'getting-started', 'phased-migration': 'getting-started', resources: 'getting-started',
                    differences: 'reference', 'mappings': 'reference', 'plus-mappings': 'reference', 'configmap-mappings': 'reference'
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
                        crd: 'Prefer Policy CRDs and VirtualServer — HAProxy CRs always convert to NIC resources'
                    }
                },
                samplePresets: SAMPLE_PRESETS,
                defaultPreset: 'moderate',
                parseInput: parseInput,
                buildPlan: buildPlan
            },
            export: {
                filename: 'haproxy-nginx-migration.yaml',
                header: '# HAProxy to NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/haproxy-migration.html'
            }
        };
    })();
