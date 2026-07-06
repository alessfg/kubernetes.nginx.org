    /* migration-traefik.js — the Traefik SOURCE module for the migration tool.
       Defines window.MIGRATION_SOURCE: the Traefik version, the middleware /
       annotation / CRD mapping data, the analyzer's parseInput/buildPlan hooks
       (multi-document YAML dispatched on kind, incl. a Traefik match-rule
       parser), and the page strings/config the shared engine
       (migration-core.js) reads. Load order matters:
       shared.js → this file → migration-core.js.
       This file must not touch the DOM — the core owns all rendering — and its
       functions may dereference MigrationTool.* at call time only (the core
       defines it after this file has run).
       TRAEFIK_VERSION below is the single source of truth for the Traefik side
       of the Version Reference banners (the NIC side lives in MigrationTool.NIC
       at the top of migration-core.js). Every NIC field/annotation/key in the
       mappings below is verified against nginx/kubernetes-ingress@v5.5.1 and
       every Traefik construct against traefik/traefik@v3.7.6. */
    (function() {
        'use strict';
        // Bump when updating the Version Reference (see the release checklist in CLAUDE.md).
        const TRAEFIK_VERSION = 'v3.7.6';
        const TRAEFIK_RELEASE_URL = 'https://github.com/traefik/traefik/releases/tag/' + TRAEFIK_VERSION;

        // Thin call-time delegates to the shared core utilities — migration-core.js
        // loads after this file, so MigrationTool must only be dereferenced inside
        // function bodies, never at top level.
        function splitDocuments(yamlText) { return MigrationTool.util.splitDocuments(yamlText); }
        function stripInlineComment(s) { return MigrationTool.util.stripInlineComment(s); }
        function formatYamlKV(indent, key, value) { return MigrationTool.util.formatYamlKV(indent, key, value); }

        // --- Minimal YAML subset parser ---------------------------------------
        // Traefik resources are structured CRDs, so unlike the flat annotation
        // scanner in migration-ingress-nginx.js this source needs real nesting.
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

        // --- Traefik match-rule parser -----------------------------------------
        // Parses v3 rule syntax: Host(`a`) && (PathPrefix(`/x`) || Path(`/y`)) && !Header(`k`, `v`)
        // into an AST, then extracts routing facts the generators understand.

        function tokenizeMatch(rule) {
            let tokens = [];
            let i = 0;
            while (i < rule.length) {
                let c = rule[i];
                if (/\s/.test(c)) { i++; continue; }
                if (c === '(' || c === ')' || c === ',') { tokens.push({ t: c }); i++; continue; }
                if (c === '!') { tokens.push({ t: '!' }); i++; continue; }
                if (rule.startsWith('&&', i)) { tokens.push({ t: '&&' }); i += 2; continue; }
                if (rule.startsWith('||', i)) { tokens.push({ t: '||' }); i += 2; continue; }
                if (c === '`' || c === '"' || c === "'") {
                    let end = rule.indexOf(c, i + 1);
                    if (end === -1) throw new Error('unterminated string in rule');
                    tokens.push({ t: 'str', v: rule.slice(i + 1, end) });
                    i = end + 1;
                    continue;
                }
                let m = rule.slice(i).match(/^[A-Za-z][A-Za-z0-9]*/);
                if (m) { tokens.push({ t: 'ident', v: m[0] }); i += m[0].length; continue; }
                throw new Error('unexpected character "' + c + '" in rule');
            }
            return tokens;
        }

        // Grammar: expr := term (('&&'|'||') term)* ; term := '!' term | '(' expr ')' | Fn '(' args ')'
        function parseMatchRule(rule) {
            let tokens = tokenizeMatch(rule);
            let pos = 0;
            function peek() { return tokens[pos]; }
            function next() { return tokens[pos++]; }
            function parseTerm() {
                let tok = peek();
                if (!tok) throw new Error('unexpected end of rule');
                if (tok.t === '!') { next(); return { op: 'not', child: parseTerm() }; }
                if (tok.t === '(') {
                    next();
                    let e = parseExpr();
                    if (!peek() || peek().t !== ')') throw new Error('missing )');
                    next();
                    return e;
                }
                if (tok.t === 'ident') {
                    next();
                    if (!peek() || peek().t !== '(') throw new Error('expected ( after ' + tok.v);
                    next();
                    let args = [];
                    while (peek() && peek().t !== ')') {
                        let a = next();
                        if (a.t === 'str' || a.t === 'ident') args.push(a.v);
                        // commas are skipped implicitly
                    }
                    if (!peek()) throw new Error('missing ) after ' + tok.v);
                    next();
                    return { fn: tok.v, args: args };
                }
                throw new Error('unexpected token in rule');
            }
            function parseExpr() {
                let left = parseTerm();
                while (peek() && (peek().t === '&&' || peek().t === '||')) {
                    let op = next().t === '&&' ? 'and' : 'or';
                    let right = parseTerm();
                    left = { op: op, children: [left, right] };
                }
                return left;
            }
            let ast = parseExpr();
            if (pos !== tokens.length) throw new Error('trailing tokens in rule');
            return ast;
        }

        // Flatten an AST into routing facts. OR/NOT are recorded as flags — NIC
        // conditions within a match are AND-only, so the generators surface those
        // as notes instead of silently mistranslating.
        function extractMatchFacts(ast) {
            let facts = { hosts: [], hostRegexps: [], hostSNIs: [], paths: [], headers: [], methods: [], queries: [], clientIPs: [], unknownMatchers: [], hasOr: false, hasNot: false, negatedUnsupported: [] };
            function walk(node, negated) {
                if (!node) return;
                if (node.op === 'not') { facts.hasNot = true; walk(node.child, !negated); return; }
                if (node.op === 'and' || node.op === 'or') {
                    if (node.op === 'or') facts.hasOr = true;
                    node.children.forEach(function(c) { walk(c, negated); });
                    return;
                }
                let fn = node.fn;
                let args = node.args || [];
                // Host/Path negation can't be expressed in VirtualServer routing —
                // record it instead of silently dropping the "!".
                if (negated && /^(Host|HostRegexp|HostSNI|HostSNIRegexp|Path|PathPrefix|PathRegexp)$/.test(fn)) {
                    facts.negatedUnsupported.push('!' + fn + '(' + args.join(', ') + ')');
                }
                switch (fn) {
                    case 'Host': args.forEach(function(a) { facts.hosts.push(a); }); break;
                    case 'HostRegexp': args.forEach(function(a) { facts.hostRegexps.push(a); }); break;
                    case 'HostSNI': args.forEach(function(a) { facts.hostSNIs.push(a); }); break;
                    case 'HostSNIRegexp': args.forEach(function(a) { facts.hostRegexps.push(a); }); break;
                    case 'Path': args.forEach(function(a) { facts.paths.push({ type: 'exact', value: a }); }); break;
                    case 'PathPrefix': args.forEach(function(a) { facts.paths.push({ type: 'prefix', value: a }); }); break;
                    case 'PathRegexp': args.forEach(function(a) { facts.paths.push({ type: 'regex', value: a }); }); break;
                    case 'Header': facts.headers.push({ name: args[0], value: args[1], regex: false, negated: negated }); break;
                    case 'HeaderRegexp': facts.headers.push({ name: args[0], value: args[1], regex: true, negated: negated }); break;
                    case 'Headers': facts.headers.push({ name: args[0], value: args[1], regex: false, negated: negated }); break;      // v2 alias
                    case 'HeadersRegexp': facts.headers.push({ name: args[0], value: args[1], regex: true, negated: negated }); break; // v2 alias
                    case 'Method': args.forEach(function(a) { facts.methods.push({ value: a, negated: negated }); }); break;
                    case 'Query': facts.queries.push({ name: args[0], value: args[1], regex: false, negated: negated }); break;
                    case 'QueryRegexp': facts.queries.push({ name: args[0], value: args[1], regex: true, negated: negated }); break;
                    case 'ClientIP': args.forEach(function(a) { facts.clientIPs.push({ value: a, negated: negated }); }); break;
                    default: facts.unknownMatchers.push(fn);
                }
            }
            walk(ast, false);
            return facts;
        }

        function parseMatchSafe(rule) {
            try {
                return extractMatchFacts(parseMatchRule(rule));
            } catch (e) {
                return null;
            }
        }
        // --- Input parsing (multi-document, dispatched on kind) ----------------

        const TRAEFIK_ANNOTATION_PREFIX = 'traefik.ingress.kubernetes.io/';

        // Extract host/service/port/path basics from a plain Ingress document
        // (used to give annotation swaps and generated CRDs concrete values).
        function extractIngressBasics(doc) {
            let spec = doc.spec || {};
            let basics = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: (doc.metadata && doc.metadata.name) || null };
            let rules = Array.isArray(spec.rules) ? spec.rules : [];
            if (rules.length > 0 && rules[0]) {
                basics.host = rules[0].host || null;
                let http = rules[0].http || {};
                let paths = Array.isArray(http.paths) ? http.paths : [];
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
            return basics;
        }

        function parseInput(yamlText) {
            let docs = splitDocuments(yamlText);
            let context = {
                middlewares: {},        // name → { type, options, resourceName, raw }
                traefikServices: {},    // name → parsed doc
                ingressRoutes: [],
                ingresses: [],
                firstIngressBasics: null
            };
            let findings = [];
            let warnings = [];
            let sawV2Api = false;
            let sawTraefikResource = false;

            docs.forEach(function(docText, docIndex) {
                let doc;
                try { doc = parseYamlDocument(docText); } catch (e) { doc = null; }
                if (!doc || typeof doc !== 'object' || !doc.kind) return;
                let kind = String(doc.kind);
                let apiVersion = String(doc.apiVersion || '');
                if (apiVersion.indexOf('traefik.containo.us') === 0) sawV2Api = true;
                let isTraefikApi = apiVersion.indexOf('traefik.io') === 0 || apiVersion.indexOf('traefik.containo.us') === 0;
                let name = (doc.metadata && doc.metadata.name) || (kind.toLowerCase() + '-' + (docIndex + 1));
                let raw = docText.replace(/^\n+|\n+$/g, '');
                let spec = doc.spec || {};

                function addFinding(key, label, value, data) {
                    findings.push({ key: key, label: label, value: value != null ? String(value) : '', docIndex: docIndex, resourceName: name, kind: kind, data: data || null, raw: raw });
                }

                switch (kind) {
                    case 'Ingress': {
                        let annotations = (doc.metadata && doc.metadata.annotations) || {};
                        let basics = extractIngressBasics(doc);
                        let found = [];
                        Object.keys(annotations).forEach(function(k) {
                            if (k.indexOf(TRAEFIK_ANNOTATION_PREFIX) === 0) {
                                let suffix = k.substring(TRAEFIK_ANNOTATION_PREFIX.length);
                                found.push({ suffix: suffix, value: annotations[k] });
                            }
                        });
                        // Numbered domain annotations share one mapping row:
                        // router.tls.domains.0.main → router.tls.domains.n.main
                        found.forEach(function(a) {
                            a.lookupSuffix = a.suffix.replace(/^router\.tls\.domains\.\d+\./, 'router.tls.domains.n.');
                        });
                        context.ingresses.push({ name: name, annotations: found, basics: basics, raw: raw });
                        if (!context.firstIngressBasics) context.firstIngressBasics = basics;
                        found.forEach(function(a) {
                            addFinding('annotation:' + a.lookupSuffix, TRAEFIK_ANNOTATION_PREFIX + a.suffix, a.value, { basics: basics });
                        });
                        break;
                    }
                    case 'Middleware': {
                        sawTraefikResource = true;
                        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
                            Object.keys(spec).forEach(function(type) {
                                // First type wins for policy references (a Middleware
                                // normally has exactly one spec key).
                                if (!context.middlewares[name]) context.middlewares[name] = { type: type, options: spec[type], resourceName: name, raw: raw };
                                addFinding('middleware:' + type, 'Middleware ' + name + ' (' + type + ')', '', { options: spec[type], middlewareName: name });
                            });
                        }
                        break;
                    }
                    case 'MiddlewareTCP': {
                        sawTraefikResource = true;
                        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
                            Object.keys(spec).forEach(function(type) {
                                addFinding('middlewaretcp:' + type, 'MiddlewareTCP ' + name + ' (' + type + ')', '', { options: spec[type], middlewareName: name });
                            });
                        }
                        break;
                    }
                    case 'IngressRoute': {
                        sawTraefikResource = true;
                        let routes = Array.isArray(spec.routes) ? spec.routes : [];
                        let parsedRoutes = routes.map(function(r) {
                            r = r || {};
                            return {
                                match: r.match || '',
                                facts: r.match ? parseMatchSafe(String(r.match)) : null,
                                middlewares: Array.isArray(r.middlewares) ? r.middlewares.map(function(mw) { return (mw && mw.name) || String(mw); }) : [],
                                services: Array.isArray(r.services) ? r.services : []
                            };
                        });
                        let ir = { name: name, entryPoints: Array.isArray(spec.entryPoints) ? spec.entryPoints : [], routes: parsedRoutes, tls: spec.tls || null, raw: raw };
                        context.ingressRoutes.push(ir);
                        addFinding('kind:IngressRoute', 'IngressRoute ' + name, '', ir);
                        break;
                    }
                    case 'IngressRouteTCP': {
                        sawTraefikResource = true;
                        let routes = Array.isArray(spec.routes) ? spec.routes : [];
                        let parsedRoutes = routes.map(function(r) {
                            r = r || {};
                            return {
                                match: r.match || '',
                                facts: r.match ? parseMatchSafe(String(r.match)) : null,
                                middlewares: Array.isArray(r.middlewares) ? r.middlewares.map(function(mw) { return (mw && mw.name) || String(mw); }) : [],
                                services: Array.isArray(r.services) ? r.services : []
                            };
                        });
                        let passthrough = !!(spec.tls && spec.tls.passthrough === true);
                        addFinding('kind:IngressRouteTCP', 'IngressRouteTCP ' + name, '', { name: name, entryPoints: Array.isArray(spec.entryPoints) ? spec.entryPoints : [], routes: parsedRoutes, tls: spec.tls || null, passthrough: passthrough });
                        break;
                    }
                    case 'IngressRouteUDP': {
                        sawTraefikResource = true;
                        let routes = Array.isArray(spec.routes) ? spec.routes : [];
                        addFinding('kind:IngressRouteUDP', 'IngressRouteUDP ' + name, '', { name: name, entryPoints: Array.isArray(spec.entryPoints) ? spec.entryPoints : [], routes: routes });
                        break;
                    }
                    case 'TraefikService': {
                        sawTraefikResource = true;
                        context.traefikServices[name] = spec;
                        if (spec.mirroring) {
                            addFinding('traefikservice:mirroring', 'TraefikService ' + name + ' (mirroring)', '', { name: name, mirroring: spec.mirroring });
                        }
                        if (spec.weighted) {
                            addFinding('traefikservice:weighted', 'TraefikService ' + name + ' (weighted)', '', { name: name, weighted: spec.weighted });
                        }
                        if (spec.failover) {
                            addFinding('traefikservice:failover', 'TraefikService ' + name + ' (failover)', '', { name: name, failover: spec.failover });
                        }
                        if (spec.highestRandomWeight) {
                            addFinding('traefikservice:highestRandomWeight', 'TraefikService ' + name + ' (highestRandomWeight)', '', { name: name });
                        }
                        break;
                    }
                    case 'TLSOption': {
                        sawTraefikResource = true;
                        addFinding('kind:TLSOption', 'TLSOption ' + name, '', { name: name, options: spec });
                        break;
                    }
                    case 'TLSStore': {
                        sawTraefikResource = true;
                        addFinding('kind:TLSStore', 'TLSStore ' + name, '', { name: name, options: spec });
                        break;
                    }
                    case 'ServersTransport': {
                        sawTraefikResource = true;
                        addFinding('kind:ServersTransport', 'ServersTransport ' + name, '', { name: name, options: spec });
                        break;
                    }
                    case 'ServersTransportTCP': {
                        sawTraefikResource = true;
                        addFinding('kind:ServersTransportTCP', 'ServersTransportTCP ' + name, '', { name: name, options: spec });
                        break;
                    }
                    default: {
                        // Unknown Traefik CRD kinds surface as unrecognized findings;
                        // non-Traefik resources (Services, Deployments, …) are ignored.
                        if (isTraefikApi) {
                            addFinding('kind:' + kind, kind + ' ' + name, '', null);
                        }
                    }
                }
            });

            if (sawV2Api) {
                warnings.push({
                    title: 'Traefik v2 apiVersion detected',
                    message: 'Resources using `traefik.containo.us/v1alpha1` were parsed, but this tool documents Traefik v3 (`traefik.io/v1alpha1`) semantics — verify renamed options (e.g. ipWhiteList → ipAllowList) before migrating.'
                });
            }

            return {
                findings: findings,
                context: context,
                warnings: warnings,
                foundCount: findings.length,
                sawTraefikResource: sawTraefikResource
            };
        }
        // --- Value conversion helpers ------------------------------------------

        // Traefik TLS version constants → nginx ssl-protocols list (from min up).
        function tlsProtocolsFrom(minVersion, maxVersion) {
            let order = ['VersionTLS10', 'VersionTLS11', 'VersionTLS12', 'VersionTLS13'];
            let names = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
            let lo = order.indexOf(minVersion);
            let hi = maxVersion ? order.indexOf(maxVersion) : names.length - 1;
            if (lo === -1) lo = 2; // Traefik default minVersion is VersionTLS12
            if (hi === -1) hi = names.length - 1;
            return names.slice(lo, hi + 1).join(' ');
        }

        // Byte counts → nginx size strings (1048576 → "1m").
        function bytesToNginxSize(n) {
            n = parseInt(n, 10);
            if (isNaN(n) || n <= 0) return null;
            if (n % 1048576 === 0) return (n / 1048576) + 'm';
            if (n % 1024 === 0) return (n / 1024) + 'k';
            return String(n);
        }

        // Traefik duration ("1s", "1m", "300ms", bare seconds) → seconds (float).
        function durationToSeconds(d) {
            if (d == null || d === '') return null;
            if (typeof d === 'number') return d;
            let m = String(d).match(/^([\d.]+)(ms|s|m|h)?$/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            switch (m[2]) {
                case 'ms': return n / 1000;
                case 'm': return n * 60;
                case 'h': return n * 3600;
                default: return n;
            }
        }

        // Traefik rateLimit {average, period} → nginx rate string ("10r/s" / "300r/m").
        function rateFromAveragePeriod(average, period) {
            let avg = parseInt(average, 10);
            if (isNaN(avg) || avg <= 0) return null;
            let secs = durationToSeconds(period);
            if (secs == null) secs = 1;
            if (secs === 60) return { rate: avg + 'r/m', note: null };
            if (secs === 1) return { rate: avg + 'r/s', note: null };
            let perSec = avg / secs;
            let rounded = Math.max(1, Math.round(perSec));
            return { rate: rounded + 'r/s', note: 'converted from ' + avg + ' per ' + secs + 's' + (perSec !== rounded ? ' (rounded)' : '') };
        }

        // Seconds → nginx duration for sessionCookie expires (3600 → "1h").
        function secondsToNginxTime(secs) {
            secs = parseInt(secs, 10);
            if (isNaN(secs) || secs <= 0) return null;
            if (secs % 3600 === 0) return (secs / 3600) + 'h';
            return secs + 's';
        }

        // Traefik `status` entries ("400", "500-599", arrays, comma lists) → Set of ints.
        function expandStatusCodes(status) {
            let set = new Set();
            let list = Array.isArray(status) ? status : (status != null ? [status] : []);
            list.forEach(function(s) {
                String(s).split(',').forEach(function(part) {
                    part = part.trim();
                    let range = part.match(/^(\d{3})-(\d{3})$/);
                    if (range) {
                        let from = parseInt(range[1], 10), to = parseInt(range[2], 10);
                        for (let c = from; c <= to && c - from <= 200; c++) set.add(c);
                    } else if (/^\d{3}$/.test(part)) {
                        set.add(parseInt(part, 10));
                    }
                });
            });
            return set;
        }

        function yamlQuote(v) {
            return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
        }

        // User-controlled strings interpolated into "# …" YAML comments must never
        // contain newlines (they would break out of the comment).
        function cmt(v) {
            return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
        }

        function sanitizeName(s) {
            return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'app';
        }

        // Normalize Traefik weighted weights to NIC split percentages summing 100.
        function weightsToPercentages(weights) {
            let total = weights.reduce(function(a, b) { return a + b; }, 0);
            if (total <= 0) return weights.map(function() { return Math.floor(100 / weights.length); });
            let pcts = weights.map(function(w) { return Math.round((w / total) * 100); });
            let drift = 100 - pcts.reduce(function(a, b) { return a + b; }, 0);
            pcts[pcts.length - 1] += drift;
            return pcts;
        }

        // Which Middleware types convert to referenceable Policies (VS policies[]).
        let POLICY_MIDDLEWARE_TYPES = { basicAuth: 'basicAuth', forwardAuth: 'externalAuth', ipAllowList: 'accessControl', ipWhiteList: 'accessControl', rateLimit: 'rateLimit' };
        function policyNameFor(middlewareName) { return sanitizeName(middlewareName) + '-policy'; }

        // --- NIC resource generators -------------------------------------------
        // Each generator returns { swaps: [], configMap: [], crds: [{kind, yaml}], notes: [{code, message}] }
        // (all optional). `finding.data` carries the parsed source construct.

        function contribution() { return { swaps: [], configMap: [], crds: [], notes: [] }; }

        let GENERATORS = {

            // -- Middleware: authentication --
            generateBasicAuthPolicy: function(finding, context, strategy) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let secret = opts.secret || '# TODO: Set your htpasswd secret';
                if (strategy === 'annotation' && context.ingresses.length > 0) {
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (basicAuth)', to: 'nginx.org/basic-auth-secret', value: String(secret), note: 'convert the Secret to type nginx.org/htpasswd (key: htpasswd)' });
                    if (opts.realm) out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (basicAuth realm)', to: 'nginx.org/basic-auth-realm', value: String(opts.realm), note: null });
                } else {
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + policyNameFor(mwName), 'spec:', '  basicAuth:', '    secret: ' + secret + '  # must be type nginx.org/htpasswd with the file under key "htpasswd"'];
                    if (opts.realm) lines.push('    realm: ' + yamlQuote(opts.realm));
                    lines.push('', '# Traefik basicAuth Secrets (Opaque, key "users") must be re-created as:', '#   type: nginx.org/htpasswd', '#   data: { htpasswd: <base64 htpasswd file> }', '# Reference from VirtualServer spec.policies (basicAuth is not Ingress-attachable;', '# on Ingress use nginx.org/basic-auth-secret + nginx.org/basic-auth-realm instead).');
                    out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                }
                if (opts.headerField || opts.removeHeader) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (basicAuth)', message: 'headerField and removeHeader have no NIC equivalent — the authenticated user is not forwarded to the backend and the Authorization header passes through unchanged.' });
                }
                return out;
            },

            generateExternalAuthPolicy: function(finding) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let serviceName = '# TODO: Set your auth service (namespace/name)';
                let authURI = '/';
                let ssl = false;
                let port = null;
                let clusterLocal = false;
                if (opts.address) {
                    let m = String(opts.address).match(/^(https?):\/\/([^\/:]+)(?::(\d+))?(\/[^\s]*)?$/);
                    if (m) {
                        ssl = m[1] === 'https';
                        if (m[3]) port = parseInt(m[3], 10);
                        let parts = m[2].split('.');
                        // Cluster-internal "svc.ns.svc.cluster.local" → "ns/svc"; bare host → host.
                        clusterLocal = parts.length >= 2 && parts.indexOf('svc') !== -1;
                        serviceName = clusterLocal ? (parts[1] + '/' + parts[0]) : parts[0];
                        if (m[4]) authURI = m[4];
                    }
                }
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + policyNameFor(mwName), 'spec:', '  externalAuth:', '    authURI: ' + yamlQuote(authURI) + '  # address (path)', '    authServiceName: ' + yamlQuote(serviceName) + '  # address (Kubernetes Service only — arbitrary URLs are not supported)'];
                if (opts.address && !clusterLocal) lines.push('    # ^ verify: the address host does not look like a cluster-local Service — NIC cannot target external auth URLs');
                if (port != null) lines.push('    authServicePorts: [' + port + ']  # address (explicit port)');
                if (ssl) lines.push('    sslEnabled: true  # address used https://');
                if (opts.authSigninURL) {
                    let signinPath = String(opts.authSigninURL).replace(/^https?:\/\/[^\/]+/, '') || '/';
                    lines.push('    authSigninURI: ' + yamlQuote(signinPath) + '  # authSigninURL (path — NIC signin URIs are relative, one per host)');
                }
                if (opts.tls && (opts.tls.caSecret || opts.tls.ca)) {
                    lines.push('    sslVerify: true', '    trustedCertSecret: ' + (opts.tls.caSecret || '# TODO: CA secret (type nginx.org/ca, key ca.crt)') + '  # tls.caSecret');
                }
                if (opts.authResponseHeaders || opts.authResponseHeadersRegex) {
                    lines.push('    # authResponseHeaders: auth_request does not copy auth-server response headers to the', '    # backend request — replicate with authSnippets (auth_request_set + proxy_set_header):', '    # authSnippets: |', '    #   auth_request_set $auth_user $upstream_http_x_user;');
                }
                lines.push('', '# Attach via VirtualServer spec.policies, or on Ingress via nginx.org/policies (v5.5.0+).');
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                let noEquiv = [];
                if (opts.authResponseHeaders || opts.authResponseHeadersRegex) noEquiv.push('authResponseHeaders (auth-server response headers are not copied to the backend request — replicate via authSnippets, see the generated Policy)');
                if (opts.addAuthCookiesToResponse) noEquiv.push('addAuthCookiesToResponse (auth-server Set-Cookie headers are not copied to the client response — replicate via authSnippets: auth_request_set + add_header Set-Cookie, or use authSigninURI/authSigninRedirectBasePath)');
                if (opts.authRequestHeaders) noEquiv.push('authRequestHeaders (NIC always forwards all client request headers)');
                if (opts.forwardBody || opts.maxBodySize != null) noEquiv.push('forwardBody/maxBodySize (NIC never forwards the request body to the auth server)');
                if (opts.trustForwardHeader) noEquiv.push('trustForwardHeader');
                if (opts.tls && (opts.tls.certSecret || opts.tls.cert)) noEquiv.push('tls.certSecret (NIC never presents a client certificate to the auth server)');
                if (opts.headerField) noEquiv.push('headerField');
                if (noEquiv.length > 0) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (forwardAuth)', message: 'No NIC equivalent for: ' + noEquiv.join('; ') + '.' });
                }
                return out;
            },

            // -- Middleware: access control --
            generateAccessControlPolicy: function(finding) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let ranges = Array.isArray(opts.sourceRange) ? opts.sourceRange : [];
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + policyNameFor(mwName), 'spec:', '  accessControl:', '    allow:'];
                if (ranges.length > 0) {
                    ranges.forEach(function(r) { lines.push('      - ' + r + '  # sourceRange'); });
                } else {
                    lines.push('      - # TODO: Set your allowed CIDRs');
                }
                lines.push('', '# Attach via VirtualServer spec.policies, or on Ingress via nginx.org/policies (v5.4.0+).');
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                if (opts.ipStrategy) {
                    out.configMap.push({ fromLabel: 'Middleware ' + mwName + ' (ipAllowList.ipStrategy)', to: 'set-real-ip-from', value: (Array.isArray(opts.ipStrategy.excludedIPs) ? opts.ipStrategy.excludedIPs.join(',') : '# TODO: trusted proxy CIDRs'), note: 'ipStrategy is global in NIC: set-real-ip-from + real-ip-header + real-ip-recursive' });
                }
                if (opts.rejectStatusCode && opts.rejectStatusCode !== 403) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (ipAllowList.rejectStatusCode)', message: 'rejectStatusCode ' + opts.rejectStatusCode + ' has no accessControl Policy equivalent — the rejection status is not configurable.' });
                }
                return out;
            },

            // -- Middleware: rate limiting --
            generateRateLimitPolicy: function(finding, context, strategy) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let conv = rateFromAveragePeriod(opts.average, opts.period) || { rate: '# TODO: Set your rate (e.g. 10r/s)', note: null };
                let burst = opts.burst != null ? parseInt(opts.burst, 10) : 1;
                let key = '${binary_remote_addr}';
                let keyComment = 'sourceCriterion default (client IP)';
                let sc = opts.sourceCriterion || {};
                if (sc.requestHeaderName) { key = '${http_' + String(sc.requestHeaderName).toLowerCase().replace(/-/g, '_') + '}'; keyComment = 'sourceCriterion.requestHeaderName: ' + sc.requestHeaderName; }
                else if (sc.requestHost) { key = '${http_host}'; keyComment = 'sourceCriterion.requestHost (NIC rateLimit keys allow ${http_*} variables, not ${host})'; }
                if (strategy === 'annotation' && context.ingresses.length > 0) {
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (rateLimit)', to: 'nginx.org/limit-req-rate', value: conv.rate, note: conv.note });
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (rateLimit burst)', to: 'nginx.org/limit-req-burst', value: String(isNaN(burst) ? 1 : burst), note: null });
                } else {
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + policyNameFor(mwName), 'spec:', '  rateLimit:', '    rate: ' + conv.rate + (conv.note ? '  # ' + conv.note : '  # average/period'), '    burst: ' + (isNaN(burst) ? 1 : burst) + '  # burst', '    key: ' + key + '  # ' + keyComment, '    zoneSize: 10M', '    rejectCode: 429', '', '# Attach via VirtualServer spec.policies (rateLimit is not Ingress-attachable;', '# on Ingress use nginx.org/limit-req-rate + nginx.org/limit-req-burst instead).'];
                    out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                }
                if (opts.redis) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (rateLimit.redis)', message: 'Redis-backed distributed rate limiting has no NIC OSS equivalent — the cluster-wide analogue is NGINX Plus zone synchronization (ConfigMap zone-sync).' });
                }
                if (sc.ipStrategy) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (rateLimit.sourceCriterion.ipStrategy)', message: 'ipStrategy depth/excludedIPs is global in NIC (ConfigMap set-real-ip-from / real-ip-header / real-ip-recursive), not per-policy.' });
                }
                return out;
            },

            generateInFlightReqNote: function(finding) {
                let out = contribution();
                let opts = finding.data.options || {};
                let amount = opts.amount != null ? opts.amount : 'N';
                out.notes.push({ code: 'Middleware ' + finding.data.middlewareName + ' (inFlightReq)', message: 'No Policy CRD equivalent for concurrent-request limiting — use nginx.org/location-snippets with "limit_conn addr ' + amount + ';" plus "limit_conn_status 429;" (Traefik inFlightReq rejects with HTTP 429; NGINX limit_conn defaults to 503), and a limit_conn_zone in ConfigMap http-snippets. inFlightReq groups by Host by default (its default sourceCriterion is requestHost, unlike rateLimit which defaults to the client remote address), so key the zone on $host ("limit_conn_zone $host zone=addr:10m;") to mirror that default; the ipStrategy/requestHeaderName strategies have no equivalent.' });
                return out;
            },

            // -- Middleware: headers / CORS / HSTS --
            generateHeadersContributions: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let hasCors = !!(opts.accessControlAllowOriginList || opts.accessControlAllowOriginListRegex || opts.accessControlAllowMethods || opts.accessControlAllowHeaders);
                if (hasCors) {
                    let origins = Array.isArray(opts.accessControlAllowOriginList) ? opts.accessControlAllowOriginList : ['*'];
                    let methods = Array.isArray(opts.accessControlAllowMethods) ? opts.accessControlAllowMethods : ['GET', 'POST', 'OPTIONS'];
                    let headers = Array.isArray(opts.accessControlAllowHeaders) ? opts.accessControlAllowHeaders : [];
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + policyNameFor(mwName), 'spec:', '  cors:', '    allowOrigin:'];
                    origins.forEach(function(o) { lines.push('      - ' + yamlQuote(o) + '  # accessControlAllowOriginList'); });
                    lines.push('    allowMethods:');
                    methods.forEach(function(m) { lines.push('      - ' + yamlQuote(m)); });
                    if (headers.length > 0) {
                        lines.push('    allowHeaders:');
                        headers.forEach(function(h) { lines.push('      - ' + yamlQuote(h)); });
                    }
                    if (opts.accessControlAllowCredentials === true) lines.push('    allowCredentials: true');
                    if (Array.isArray(opts.accessControlExposeHeaders) && opts.accessControlExposeHeaders.length > 0) {
                        lines.push('    exposeHeaders:');
                        opts.accessControlExposeHeaders.forEach(function(h) { lines.push('      - ' + yamlQuote(h)); });
                    }
                    if (opts.accessControlMaxAge != null) lines.push('    maxAge: ' + parseInt(opts.accessControlMaxAge, 10));
                    lines.push('', '# Attach via VirtualServer spec.policies, or on Ingress via nginx.org/policies (v5.4.0+).');
                    if (opts.accessControlAllowOriginListRegex) lines.push('# accessControlAllowOriginListRegex has no cors Policy equivalent — list origins explicitly.');
                    out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                }
                // HSTS trio → nginx.org/hsts* annotations
                if (opts.stsSeconds != null && parseInt(opts.stsSeconds, 10) > 0) {
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (headers.stsSeconds)', to: 'nginx.org/hsts', value: 'true', note: null });
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (headers.stsSeconds)', to: 'nginx.org/hsts-max-age', value: String(parseInt(opts.stsSeconds, 10)), note: null });
                    if (opts.stsIncludeSubdomains === true) out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (headers.stsIncludeSubdomains)', to: 'nginx.org/hsts-include-subdomains', value: 'true', note: null });
                    if (opts.stsPreload === true) out.notes.push({ code: 'Middleware ' + mwName + ' (headers.stsPreload)', message: 'NIC includes "preload" in the HSTS header it emits — no separate toggle needed.' });
                }
                // custom request/response headers → VirtualServer proxy header fields
                let reqHeaders = opts.customRequestHeaders && typeof opts.customRequestHeaders === 'object' ? Object.keys(opts.customRequestHeaders) : [];
                let respHeaders = opts.customResponseHeaders && typeof opts.customResponseHeaders === 'object' ? Object.keys(opts.customResponseHeaders) : [];
                if (reqHeaders.length > 0 || respHeaders.length > 0) {
                    let basics = context && context.firstIngressBasics ? context.firstIngressBasics : {};
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        proxy:', '          upstream: backend'];
                    if (reqHeaders.length > 0) {
                        lines.push('          requestHeaders:', '            set:');
                        reqHeaders.forEach(function(h) {
                            let v = opts.customRequestHeaders[h];
                            if (v === '' || v == null) {
                                lines.push('              - name: ' + h, '                value: ""  # empty value removes the header');
                            } else {
                                lines.push('              - name: ' + h + '  # customRequestHeaders', '                value: ' + yamlQuote(v));
                            }
                        });
                    }
                    if (respHeaders.length > 0) {
                        let adds = respHeaders.filter(function(h) { return opts.customResponseHeaders[h] !== '' && opts.customResponseHeaders[h] != null; });
                        let hides = respHeaders.filter(function(h) { return opts.customResponseHeaders[h] === '' || opts.customResponseHeaders[h] == null; });
                        lines.push('          responseHeaders:');
                        if (adds.length > 0) {
                            lines.push('            add:');
                            adds.forEach(function(h) { lines.push('              - name: ' + h + '  # customResponseHeaders', '                value: ' + yamlQuote(opts.customResponseHeaders[h]), '                always: true'); });
                        }
                        if (hides.length > 0) {
                            lines.push('            hide:');
                            hides.forEach(function(h) { lines.push('              - ' + h + '  # empty customResponseHeaders value removes the header'); });
                        }
                    }
                    lines.push('', '# Ingress alternative: nginx.org/proxy-set-headers (request) and nginx.org/add-header (response, v5.5.0+).');
                    out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                }
                // Security headers → add-header
                let securityHeaders = [];
                if (opts.frameDeny === true) securityHeaders.push('X-Frame-Options: DENY');
                if (opts.customFrameOptionsValue) securityHeaders.push('X-Frame-Options: ' + opts.customFrameOptionsValue);
                if (opts.contentTypeNosniff === true) securityHeaders.push('X-Content-Type-Options: nosniff');
                if (opts.customBrowserXSSValue) securityHeaders.push('X-XSS-Protection: ' + opts.customBrowserXSSValue);  // customBrowserXSSValue overrides browserXssFilter
                else if (opts.browserXssFilter === true) securityHeaders.push('X-XSS-Protection: 1; mode=block');
                if (opts.contentSecurityPolicy) securityHeaders.push('Content-Security-Policy: ' + opts.contentSecurityPolicy);
                if (opts.contentSecurityPolicyReportOnly) securityHeaders.push('Content-Security-Policy-Report-Only: ' + opts.contentSecurityPolicyReportOnly);
                if (opts.referrerPolicy) securityHeaders.push('Referrer-Policy: ' + opts.referrerPolicy);
                if (opts.permissionsPolicy) securityHeaders.push('Permissions-Policy: ' + opts.permissionsPolicy);
                if (securityHeaders.length > 0) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (headers security fields)', message: 'Emit via nginx.org/add-header (v5.5.0+) or VirtualServer responseHeaders.add: ' + securityHeaders.join('; ') + '.' });
                }
                return out;
            },

            // -- Middleware: compression --
            generateCompressConfigMap: function(finding) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let min = opts.minResponseBodyBytes != null ? parseInt(opts.minResponseBodyBytes, 10) : 1024;
                let snippet = 'gzip on;\\ngzip_min_length ' + (isNaN(min) ? 1024 : min) + ';\\ngzip_types text/plain text/css application/json application/javascript text/xml;\\ngzip_proxied any;';
                out.configMap.push({ fromLabel: 'Middleware ' + mwName + ' (compress)', to: 'http-snippets', value: '|\\n  ' + snippet.split('\\n').join('\\n  '), note: 'NIC has no compression ConfigMap key — enable gzip via http-snippets (global)' });
                let encodings = Array.isArray(opts.encodings) ? opts.encodings : [];
                if (encodings.indexOf('br') !== -1 || encodings.indexOf('zstd') !== -1) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (compress.encodings)', message: 'Brotli/zstd require extra NGINX modules — verify availability in your NIC image; the http-snippets example enables gzip only.' });
                }
                return out;
            },

            // -- Middleware: rewrites / redirects --
            generateAddPrefixVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let prefix = opts.prefix || '/prefix';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:', '    - path: ~^(?:/(.*))?$', '      action:', '        proxy:', '          upstream: backend', '          rewritePath: ' + prefix + '/$1  # addPrefix.prefix — prepended before proxying'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },

            generateReplacePathVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        proxy:', '          upstream: backend', '          rewritePath: ' + (opts.path || '/') + '  # replacePath.path'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                out.notes.push({ code: 'Middleware ' + mwName + ' (X-Replaced-Path)', message: 'Traefik replacePath also injects the original request path into an X-Replaced-Path request header sent upstream; NIC rewritePath does not reproduce it. If the backend reads X-Replaced-Path, re-add it via action.proxy.requestHeaders.set (name: X-Replaced-Path, value: ${request_uri} or the pre-rewrite path).' });
                return out;
            },

            generateReplacePathRegexVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let regex = opts.regex || '^/old/(.*)';
                let replacement = String(opts.replacement || '/new/$1');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:', '    - path: ~' + regex + '  # replacePathRegex.regex (verify: Traefik uses RE2, NGINX uses PCRE)', '      action:', '        proxy:', '          upstream: backend', '          rewritePath: ' + replacement.replace(/\$\{(\d)\}/g, '$$$1') + '  # replacePathRegex.replacement ($1-$9 captures)'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                out.notes.push({ code: 'Middleware ' + mwName + ' (X-Replaced-Path)', message: 'Traefik replacePathRegex also stores the original request path in an X-Replaced-Path request header sent upstream, which NIC rewritePath does not reproduce. If the backend reads X-Replaced-Path, re-add it via action.proxy.requestHeaders.set (name: X-Replaced-Path, value: ${request_uri}).' });
                return out;
            },

            generateStripPrefixVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let prefixes = Array.isArray(opts.prefixes) ? opts.prefixes : (Array.isArray(opts.regex) ? opts.regex : []);
                let isRegex = !opts.prefixes && Array.isArray(opts.regex);
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:'];
                (prefixes.length > 0 ? prefixes : ['/api']).forEach(function(p) {
                    if (isRegex) {
                        // Don't graft capture groups onto a user-supplied regex — route on it
                        // as-is and leave the rewrite target as an explicit TODO.
                        lines.push('    - path: ~' + cmt(p) + '  # stripPrefixRegex (Traefik RE2 → NGINX PCRE: verify)', '      action:', '        proxy:', '          upstream: backend', '          rewritePath: /  # TODO: stripPrefixRegex removes the matched prefix — add a capture to your regex and reference it here ($1)', '          # requestHeaders:  # Traefik stripPrefixRegex also sends X-Forwarded-Prefix (the stripped prefix); NIC rewritePath does not — uncomment if the backend needs it', '          #   set:', '          #     - name: X-Forwarded-Prefix', '          #       value: # TODO: the stripped prefix');
                    } else {
                        lines.push('    - path: ~^' + cmt(p) + '(?:/(.*))?$  # stripPrefix: ' + cmt(p), '      action:', '        proxy:', '          upstream: backend', '          rewritePath: /$1', '          # requestHeaders:  # Traefik stripPrefix also sends X-Forwarded-Prefix; NIC rewritePath does not — uncomment if the backend needs it', '          #   set:', '          #     - name: X-Forwarded-Prefix', '          #       value: ' + cmt(p));
                    }
                });
                lines.push('', '# Ingress alternative: nginx.org/rewrites: "serviceName=' + (basics.serviceName || '<svc>') + ' rewrite=/" (prefix replacement, no regex).');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                out.notes.push({ code: 'Middleware ' + mwName + ' (X-Forwarded-Prefix)', message: 'Traefik stripPrefix/stripPrefixRegex also store the stripped prefix in an X-Forwarded-Prefix request header sent upstream; NIC rewritePath only rewrites the path and does not set it. If the backend relies on X-Forwarded-Prefix (e.g. to build relative asset URLs), re-add it via action.proxy.requestHeaders.set (see the commented stub).' });
                return out;
            },

            generateRedirectSchemeVS: function(finding, context, strategy) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let permanent = opts.permanent === true;
                // 308 (permanent) / 307 (temporary) preserve the request method, matching
                // Traefik's own method-adaptive codes (301/308 permanent, 302/307 temporary).
                let code = permanent ? '308' : '307';
                if (context.ingresses.length > 0 || strategy === 'annotation') {
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (redirectScheme)', to: 'nginx.org/redirect-to-https', value: 'true', note: null });
                    out.swaps.push({ fromLabel: 'Middleware ' + mwName + ' (redirectScheme.permanent)', to: 'nginx.org/http-redirect-code', value: code, note: permanent ? 'permanent: true — Traefik sends 301 (GET)/308 (other); 308 preserves the method' : 'permanent: false — Traefik sends 302 (GET)/307 (other); 307 preserves the method' });
                } else {
                    let basics = context.firstIngressBasics || {};
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  tls:', '    secret: ' + (basics.tlsSecret || '# TODO: Set your TLS secret'), '    redirect:', '      enable: true  # redirectScheme scheme: https', '      code: ' + code + (permanent ? '  # permanent: true → 308 (method-preserving; Traefik: 301 GET / 308 other)' : '  # permanent: false → 307 (method-preserving; Traefik: 302 GET / 307 other)'), '      basedOn: scheme'];
                    out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                }
                return out;
            },

            generateRedirectRegexVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let hasCaptures = /\$\{?\d/.test(String(opts.replacement || ''));
                let lines;
                if (hasCaptures) {
                    // action.redirect.url takes a static URL — capture groups need a
                    // rewrite directive via snippets, so make that the primary output.
                    let rewriteLine = 'rewrite ' + cmt(opts.regex || '<regex>') + ' ' + cmt(String(opts.replacement).replace(/\$\{(\d)\}/g, '$$$1')) + ' ' + (opts.permanent === true ? 'permanent' : 'redirect') + ';';
                    lines = ['# redirectRegex uses capture groups — VirtualServer action.redirect.url is static,', '# so the redirect must be an NGINX rewrite via snippets (requires -enable-snippets):', 'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', '  annotations:', '    nginx.org/server-snippets: |', '      ' + rewriteLine + '  # redirectRegex.regex → replacement'];
                } else {
                    lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  routes:', '    - path: /', '      action:', '        redirect:', '          url: ' + yamlQuote(opts.replacement || 'https://example.com/  # TODO: Set redirect URL') + '  # redirectRegex.replacement', '          code: ' + (opts.permanent === true ? '308' : '307') + '  # ' + (opts.permanent === true ? 'permanent: true → 308' : 'permanent: false → 307') + ' (method-preserving; Traefik is method-adaptive 301/308·302/307)'];
                }
                out.crds.push({ kind: hasCaptures ? 'Ingress' : 'VirtualServer', yaml: lines.join('\n') });
                out.notes.push({ code: 'Middleware ' + mwName + ' (redirectRegex)', message: 'Traefik redirectRegex matches the full URL (e.g. ^https?://host/path), but ' + (hasCaptures ? 'the NGINX rewrite directive matches the request path only and its "permanent" flag emits 301 (use "return 308 <url>" to preserve non-GET methods)' : 'NGINX routing matches the request path only') + ' — move any scheme/host portion of the regex into the resource host (or drop it) before applying this. Traefik regexes are RE2 while NGINX uses PCRE — verify the pattern.' });
                return out;
            },

            // -- Middleware: resilience --
            generateRetryVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let attempts = opts.attempts != null ? parseInt(opts.attempts, 10) : 3;
                // Traefik retry is network-error-only by default; HTTP-status retry is opt-in via `status`.
                let nginxRetryCodes = [403, 404, 429, 500, 502, 503, 504];  // the only codes NGINX next-upstream accepts
                let conds = [];
                if (opts.disableRetryOnNetworkError !== true) conds.push('error', 'timeout');
                let wanted = expandStatusCodes(opts.status);
                nginxRetryCodes.forEach(function(c) { if (wanted.has(c)) conds.push('http_' + c); });
                if (opts.retryNonIdempotentMethod === true) conds.push('non_idempotent');
                if (conds.length === 0) conds = ['error', 'timeout'];  // never emit an empty next-upstream
                let condComment = opts.status != null ? 'retry.status → NGINX http_* codes (+ network errors)' : 'Traefik retry: network errors only by default';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '      next-upstream: ' + yamlQuote(conds.join(' ')) + '  # ' + condComment, '      next-upstream-tries: ' + (isNaN(attempts) ? 3 : attempts) + '  # retry.attempts'];
                let timeoutSecs = durationToSeconds(opts.timeout);
                if (timeoutSecs) lines.push('      next-upstream-timeout: ' + Math.round(timeoutSecs) + 's  # retry.timeout (overall retry budget)');
                lines.push('  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        pass: backend', '', '# Ingress alternative: nginx.org/proxy-next-upstream + nginx.org/proxy-next-upstream-tries (v5.4.0+).');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                if (opts.initialInterval) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (retry.initialInterval)', message: 'NGINX retries the next upstream immediately — exponential backoff (initialInterval) between attempts has no equivalent.' });
                }
                let hasUnsupported = false;
                wanted.forEach(function(c) { if (nginxRetryCodes.indexOf(c) === -1) hasUnsupported = true; });
                if (hasUnsupported) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (retry.status)', message: 'NGINX next-upstream can only retry on ' + nginxRetryCodes.join(', ') + '; any other code in retry.status (' + (Array.isArray(opts.status) ? opts.status.join(', ') : opts.status) + ') has no next-upstream equivalent.' });
                }
                if (opts.maxRequestBodyBytes != null) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (retry.maxRequestBodyBytes)', message: 'No direct equivalent — NGINX has no per-retry request-body cap (use nginx.org/client-max-body-size for the overall request-body limit).' });
                }
                return out;
            },

            generateCircuitBreakerVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let failTimeout = durationToSeconds(opts.fallbackDuration);
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '      max-fails: 3  # closest passive equivalent — expression "' + cmt(opts.expression || '') + '" cannot be translated', '      fail-timeout: ' + (failTimeout ? Math.round(failTimeout) + 's' : '10s') + (opts.fallbackDuration ? '  # fallbackDuration' : ''), '  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        pass: backend', '', '# NIC has no expression-based circuit breaker: passive health checks (max-fails/fail-timeout)', '# are the OSS approximation; active health checks (upstreams[].healthCheck) require NGINX Plus.'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },

            generateBufferingVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let maxBody = bytesToNginxSize(opts.maxRequestBodyBytes);
                let memBody = bytesToNginxSize(opts.memRequestBodyBytes);
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80')];
                if (maxBody) lines.push('      client-max-body-size: ' + maxBody + '  # maxRequestBodyBytes (' + opts.maxRequestBodyBytes + ' bytes)');
                if (memBody) lines.push('      client-body-buffer-size: ' + memBody + '  # memRequestBodyBytes');
                lines.push('  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        pass: backend');
                let notes = [];
                if (opts.maxResponseBodyBytes != null || opts.memResponseBodyBytes != null) notes.push('# maxResponseBodyBytes/memResponseBodyBytes: no hard response cap — tune nginx.org/proxy-buffering,');
                if (notes.length) lines.push('', notes[0], '# nginx.org/proxy-buffers and nginx.org/proxy-buffer-size instead.');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                if (opts.retryExpression) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (buffering.retryExpression)', message: 'No expression language — approximate with upstreams[].next-upstream conditions plus next-upstream-tries.' });
                }
                return out;
            },

            // -- Middleware: errors --
            generateErrorPagesVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                // Expand Traefik status entries ("500", "500,502", "500-504") to explicit codes.
                let codes = [];
                let truncatedRanges = [];
                let statusList = Array.isArray(opts.status) ? opts.status : (opts.status != null ? [opts.status] : []);
                statusList.forEach(function(s) {
                    String(s).split(',').forEach(function(part) {
                        part = part.trim();
                        let range = part.match(/^(\d{3})-(\d{3})$/);
                        if (range) {
                            let from = parseInt(range[1], 10), to = Math.min(parseInt(range[2], 10), from + 30);
                            for (let c = from; c <= to; c++) codes.push(c);
                            if (parseInt(range[2], 10) > to) truncatedRanges.push(part + ' (shown up to ' + to + ')');
                        } else if (/^\d{3}$/.test(part)) {
                            codes.push(parseInt(part, 10));
                        }
                    });
                });
                if (codes.length === 0) codes = [502, 503];
                // NIC redirect URLs support only ${scheme}, ${host}, ${request_uri}, ${http_x_forwarded_proto}
                // — none carries the response status, so expand Traefik's {status} placeholder per code instead.
                let query = String(opts.query || '/{status}.html');
                let urlExample = 'https://errors.example.com' + query.replace('{status}', String(codes[0]));
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        pass: backend', '      errorPages:', '        - codes: [' + codes.join(', ') + ']  # status (ranges expanded — errorPages codes must be explicit integers)', '          redirect:', '            code: 302', '            url: ' + yamlQuote(urlExample) + '  # query — redirect URLs support ${scheme}/${host}/${request_uri}/${http_x_forwarded_proto} but none carries the status — use one errorPages entry per code for per-status URLs'];
                if (truncatedRanges.length > 0) {
                    lines.push('', '# Range' + (truncatedRanges.length !== 1 ? 's' : '') + ' truncated for readability: ' + truncatedRanges.join(', ') + ' — add the remaining codes explicitly.');
                    out.notes.push({ code: 'Middleware ' + mwName + ' (errors.status)', message: 'Status range' + (truncatedRanges.length !== 1 ? 's' : '') + ' ' + truncatedRanges.join(', ') + ' truncated in the generated errorPages — NIC needs explicit codes; add the rest manually.' });
                }
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                if (opts.service) {
                    out.notes.push({ code: 'Middleware ' + mwName + ' (errors.service)', message: 'NIC errorPages return a canned response or redirect — they cannot proxy the error request to a dedicated error Service. Host the error pages behind their own VirtualServer and redirect to it.' });
                }
                return out;
            },

            // -- Middleware: mTLS pass-through --
            generatePassTLSClientCertVS: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mwName = finding.data.middlewareName;
                let basics = context.firstIngressBasics || {};
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(mwName) + '-app', 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        proxy:', '          upstream: backend', '          requestHeaders:', '            set:'];
                if (opts.pem === true) {
                    lines.push('              - name: X-Forwarded-Tls-Client-Cert  # pem: true', '                value: ${ssl_client_escaped_cert}');
                }
                if (opts.info) {
                    lines.push('              - name: X-Forwarded-Tls-Client-Cert-Info  # info.subject.*', '                value: ${ssl_client_s_dn}', '              - name: X-Forwarded-Tls-Client-Cert-Issuer  # info.issuer.*', '                value: ${ssl_client_i_dn}');
                }
                if (opts.pem !== true && !opts.info) {
                    lines.push('              - name: X-Forwarded-Tls-Client-Cert', '                value: ${ssl_client_escaped_cert}');
                }
                lines.push('', '# Pair with an ingressMTLS Policy to actually request/verify the client certificate.');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },

            // -- Middleware: chain --
            generateChainNote: function(finding, context) {
                let out = contribution();
                let opts = finding.data.options || {};
                let mws = Array.isArray(opts.middlewares) ? opts.middlewares.map(function(m) { return (m && m.name) || String(m); }) : [];
                out.notes.push({ code: 'Middleware ' + finding.data.middlewareName + ' (chain)', message: 'NIC has no chain construct — flatten the chain by listing each converted policy directly in VirtualServer spec.policies / route policies (order of the list is preserved)' + (mws.length ? ': ' + mws.join(' → ') : '') + '. Include each chained Middleware in this analysis to convert it.' });
                return out;
            }
        };
        // --- CRD-level generators (IngressRoute / TCP / UDP / TraefikService / TLS) --

        // Resolve an IngressRoute service entry to concrete upstreams (following
        // TraefikService weighted references when the resource is in the input).
        function resolveServices(services, context) {
            let upstreams = [];   // { name, service, port, weight, comment }
            (services || []).forEach(function(svc) {
                if (!svc || !svc.name) return;
                if (svc.kind === 'TraefikService') {
                    let ts = context.traefikServices[svc.name];
                    if (ts && ts.weighted && Array.isArray(ts.weighted.services)) {
                        ts.weighted.services.forEach(function(ws) {
                            if (!ws || !ws.name) return;
                            upstreams.push({ name: sanitizeName(ws.name), service: ws.name, port: ws.port || 80, weight: ws.weight != null ? ws.weight : 1, comment: 'via TraefikService ' + svc.name + ' (weighted)' });
                        });
                    } else if (ts && ts.mirroring) {
                        let mainName = ts.mirroring.name;
                        if (mainName) upstreams.push({ name: sanitizeName(mainName), service: mainName, port: ts.mirroring.port || 80, weight: 1, comment: 'via TraefikService ' + svc.name + ' (mirroring — mirrors need snippets, see notes)' });
                    } else {
                        upstreams.push({ name: sanitizeName(svc.name), service: '# TODO: resolve TraefikService ' + svc.name, port: svc.port || 80, weight: svc.weight != null ? svc.weight : 1, comment: 'TraefikService not found in input' });
                    }
                } else {
                    upstreams.push({ name: sanitizeName(svc.name), service: svc.name, port: svc.port || 80, weight: svc.weight != null ? svc.weight : 1, comment: null });
                }
            });
            return upstreams;
        }

        function pathFromFacts(facts) {
            if (!facts || facts.paths.length === 0) return { path: '/', extra: [], note: null };
            let first = facts.paths[0];
            let toVs = function(p) {
                if (p.type === 'exact') return '=' + p.value;
                if (p.type === 'regex') return '~' + p.value;
                return p.value;
            };
            return {
                path: toVs(first),
                extra: facts.paths.slice(1).map(toVs),
                note: first.type === 'regex' ? 'PathRegexp: Traefik uses RE2, NGINX uses PCRE — verify the pattern' : null
            };
        }

        function conditionsFromFacts(facts, notes, resourceLabel) {
            let conditions = [];
            // NIC condition values support negation with a leading "!" ("!v" / "!~regex").
            function condValue(negated, regex, value) {
                return (negated ? '!' : '') + (regex ? '~' : '') + (value != null ? value : '');
            }
            (facts.headers || []).forEach(function(h) {
                if (!h.name) return;
                conditions.push({ line: '- header: ' + h.name, value: condValue(h.negated, h.regex, h.value), comment: (h.negated ? '!' : '') + (h.regex ? 'HeaderRegexp' : 'Header') });
            });
            let methods = facts.methods || [];
            if (methods.length > 1) {
                notes.push({ code: resourceLabel, message: 'Multiple Method() matchers combined with || express OR — e.g. Method(`GET`) || Method(`HEAD`) (each Method() matcher takes exactly one method in v3 syntax). Conditions in one NIC match are AND-only, so the generated condition uses the first method — add one matches[] block per additional method: ' + methods.map(function(m) { return m.value; }).join(', ') + '.' });
                methods = [methods[0]];
            }
            methods.forEach(function(m) {
                conditions.push({ line: '- variable: $request_method', value: condValue(m.negated, false, m.value), comment: (m.negated ? '!' : '') + 'Method' });
            });
            (facts.queries || []).forEach(function(q) {
                if (!q.name) return;
                let hasValue = q.value != null;
                conditions.push({ line: '- argument: ' + q.name, value: condValue(q.negated, q.regex, q.value), comment: (q.negated ? '!' : '') + (q.regex ? 'QueryRegexp' : 'Query') + (hasValue ? '' : ' — key-presence check: set the expected value') });
            });
            (facts.clientIPs || []).forEach(function(ip) {
                if (String(ip.value).indexOf('/') !== -1) {
                    notes.push({ code: resourceLabel, message: 'ClientIP(' + ip.value + '): CIDR matching is not possible in VirtualServer matches conditions — use an accessControl Policy for allow/deny by CIDR.' });
                } else {
                    conditions.push({ line: '- variable: $remote_addr', value: condValue(ip.negated, false, ip.value), comment: (ip.negated ? '!' : '') + 'ClientIP' });
                }
            });
            if (facts.negatedUnsupported && facts.negatedUnsupported.length > 0) {
                notes.push({ code: resourceLabel, message: 'Negated host/path matchers cannot be expressed in VirtualServer routing and were ignored: ' + facts.negatedUnsupported.join(', ') + '.' });
            }
            return conditions;
        }

        let GENERATORS_CRD = {

            generateVirtualServerFromIngressRoute: function(finding, context) {
                let out = contribution();
                let ir = finding.data;
                let label = 'IngressRoute ' + ir.name;

                // Host: one VirtualServer per host; collect across routes.
                let hosts = [];
                let hostRegexps = [];
                ir.routes.forEach(function(r) {
                    if (r.facts) {
                        r.facts.hosts.forEach(function(h) { if (hosts.indexOf(h) === -1) hosts.push(h); });
                        r.facts.hostRegexps.forEach(function(h) { if (hostRegexps.indexOf(h) === -1) hostRegexps.push(h); });
                    }
                });
                if (hostRegexps.length > 0) {
                    out.notes.push({ code: label, message: 'HostRegexp(' + hostRegexps.join(', ') + ') has no VirtualServer equivalent — spec.host takes a single exact name or a leading-label wildcard (*.example.com). Create one VirtualServer per concrete host.' });
                }
                let host = hosts[0] || (hostRegexps.length === 0 ? '# TODO: Set your host' : '# TODO: replace HostRegexp with concrete host(s)');
                if (hosts.length > 1) {
                    out.notes.push({ code: label, message: 'Multiple Host() values (' + hosts.join(', ') + ') — NIC allows one host per VirtualServer; this example uses the first, create one VirtualServer per additional host.' });
                }

                // Upstreams across all routes (deduped by service+port).
                let upstreamMap = {};
                let upstreamOrder = [];
                ir.routes.forEach(function(r) {
                    resolveServices(r.services, context).forEach(function(u) {
                        let key = u.service + ':' + u.port;
                        if (!upstreamMap[key]) {
                            // Ensure unique upstream names.
                            let base = u.name, n = 2;
                            while (upstreamOrder.some(function(k) { return upstreamMap[k].name === u.name; })) { u.name = base + '-' + (n++); }
                            upstreamMap[key] = u;
                            upstreamOrder.push(key);
                        }
                    });
                });
                if (upstreamOrder.length === 0) {
                    upstreamMap['# TODO: Set your service:80'] = { name: 'backend', service: '# TODO: Set your service', port: 80, weight: 1, comment: null };
                    upstreamOrder.push('# TODO: Set your service:80');
                }

                // Middlewares → policies refs / inline guidance.
                let policyRefs = [];
                let middlewareNotes = [];
                ir.routes.forEach(function(r) {
                    (r.middlewares || []).forEach(function(mwName) {
                        let mw = context.middlewares[mwName];
                        if (mw && POLICY_MIDDLEWARE_TYPES[mw.type]) {
                            let ref = policyNameFor(mwName);
                            if (policyRefs.indexOf(ref) === -1) policyRefs.push(ref);
                        } else if (mw) {
                            if (middlewareNotes.indexOf(mwName) === -1) middlewareNotes.push(mwName);
                        } else {
                            out.notes.push({ code: label, message: 'Middleware "' + mwName + '" is referenced but not present in the input — include it to convert it.' });
                        }
                    });
                });

                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(ir.name), 'spec:', '  host: ' + host];
                if (ir.tls && ir.tls.secretName) {
                    lines.push('  tls:', '    secret: ' + ir.tls.secretName + '  # tls.secretName');
                } else if (ir.tls && ir.tls.certResolver) {
                    lines.push('  tls:', '    secret: ' + sanitizeName(ir.name) + '-tls  # cert-manager will populate this Secret', '    cert-manager:', '      cluster-issuer: # TODO: your cert-manager ClusterIssuer  # replaces certResolver "' + ir.tls.certResolver + '"');
                } else if (ir.tls) {
                    lines.push('  tls:', '    secret: # TODO: Set your TLS secret  # Traefik used the default certificate store');
                }
                if (policyRefs.length > 0) {
                    lines.push('  policies:');
                    policyRefs.forEach(function(p) { lines.push('    - name: ' + p + '  # from route middlewares'); });
                }
                lines.push('  upstreams:');
                upstreamOrder.forEach(function(key) {
                    let u = upstreamMap[key];
                    lines.push('    - name: ' + u.name + (u.comment ? '  # ' + u.comment : ''), '      service: ' + u.service, '      port: ' + u.port);
                });

                lines.push('  routes:');
                let sawOr = false, sawNot = false;
                let seenPaths = {};
                ir.routes.forEach(function(r) {
                    let facts = r.facts;
                    if (r.match && !facts) {
                        out.notes.push({ code: label, message: 'Could not parse rule "' + cmt(r.match) + '" — the generated route falls back to path "/"; translate this rule manually.' });
                    }
                    if (facts && facts.hasOr) sawOr = true;
                    if (facts && facts.hasNot) sawNot = true;
                    if (facts && facts.unknownMatchers.length > 0) {
                        out.notes.push({ code: label, message: 'Unrecognized matcher(s) in rule "' + cmt(r.match) + '": ' + facts.unknownMatchers.join(', ') + '.' });
                    }
                    let pf = pathFromFacts(facts);
                    if (pf.note) out.notes.push({ code: label, message: pf.note + ' (rule: ' + r.match + ')' });
                    let routeUpstreams = resolveServices(r.services, context).map(function(u) {
                        let key = u.service + ':' + u.port;
                        return { name: (upstreamMap[key] || u).name, weight: u.weight };
                    });
                    if (routeUpstreams.length === 0) routeUpstreams = [{ name: upstreamMap[upstreamOrder[0]].name, weight: 1 }];
                    let conditions = facts ? conditionsFromFacts(facts, out.notes, label) : [];

                    let allPaths = [pf.path].concat(pf.extra).filter(function(p) {
                        // NIC rejects duplicate routes[].path values within one VirtualServer.
                        if (seenPaths[p]) {
                            out.notes.push({ code: label, message: 'Duplicate route path "' + p + '" skipped — merge the overlapping rules into one route.' });
                            return false;
                        }
                        seenPaths[p] = true;
                        return true;
                    });
                    allPaths.forEach(function(p) {
                        lines.push('    - path: ' + p + (r.match ? '  # ' + cmt(r.match) : ''));
                        let indent = '      ';
                        if (conditions.length > 0) {
                            lines.push(indent + 'matches:');
                            lines.push(indent + '  - conditions:');
                            conditions.forEach(function(c) {
                                lines.push(indent + '      ' + c.line + '  # ' + c.comment);
                                lines.push(indent + '        value: ' + yamlQuote(c.value));
                            });
                            if (routeUpstreams.length > 1) {
                                let mPcts = weightsToPercentages(routeUpstreams.map(function(u) { return u.weight; }));
                                lines.push(indent + '    splits:');
                                routeUpstreams.forEach(function(u, i) {
                                    lines.push(indent + '      - weight: ' + mPcts[i] + '  # weight ' + u.weight + ' normalized (splits must sum to 100)');
                                    lines.push(indent + '        action: { pass: ' + u.name + ' }');
                                });
                            } else {
                                lines.push(indent + '    action:');
                                lines.push(indent + '      pass: ' + routeUpstreams[0].name);
                            }
                            lines.push(indent + 'action:');
                            lines.push(indent + '  pass: ' + routeUpstreams[0].name + '  # fallback when conditions do not match — adjust as needed');
                        } else if (routeUpstreams.length > 1) {
                            let pcts = weightsToPercentages(routeUpstreams.map(function(u) { return u.weight; }));
                            lines.push(indent + 'splits:');
                            routeUpstreams.forEach(function(u, i) {
                                lines.push(indent + '  - weight: ' + pcts[i] + '  # weight ' + u.weight + ' normalized (splits must sum to 100)');
                                lines.push(indent + '    action: { pass: ' + u.name + ' }');
                            });
                        } else {
                            lines.push(indent + 'action:');
                            lines.push(indent + '  pass: ' + routeUpstreams[0].name);
                        }
                    });
                });
                if (middlewareNotes.length > 0) {
                    lines.push('', '# Middlewares handled inside the route/action instead of policies: ' + middlewareNotes.join(', '), '# — see each middleware\'s own generated example in this analysis.');
                }
                if (sawOr) out.notes.push({ code: label, message: 'Rule uses "||": VirtualServer match conditions are AND-only — OR requires separate routes/matches (the generated YAML splits paths; review header/query OR combinations manually).' });
                if (sawNot) out.notes.push({ code: label, message: 'Rule uses "!": negated header/method/query/IP matchers were translated to "!"-prefixed condition values — review them; full boolean negation of sub-expressions is not supported.' });
                if (ir.entryPoints.some(function(ep) { return ep !== 'web' && ep !== 'websecure'; })) {
                    out.notes.push({ code: label, message: 'Custom entryPoints (' + ir.entryPoints.join(', ') + '): map non-default ports to GlobalConfiguration HTTP listeners (spec.listeners) and reference them via VirtualServer spec.listener, or use nginx.org/listen-ports on Ingress.' });
                }
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },

            generateTransportServerFromTCP: function(finding) {
                let out = contribution();
                let d = finding.data;
                let label = 'IngressRouteTCP ' + d.name;
                let snis = [];
                d.routes.forEach(function(r) {
                    if (r.facts) r.facts.hostSNIs.forEach(function(h) { if (snis.indexOf(h) === -1) snis.push(h); });
                });
                let concreteSni = snis.filter(function(s) { return s !== '*'; })[0] || null;
                let services = [];
                d.routes.forEach(function(r) { (r.services || []).forEach(function(s) { if (s && s.name) services.push(s); }); });
                let svc = services[0] || { name: '# TODO: Set your service', port: 443 };

                let lines;
                if (d.passthrough) {
                    lines = ['# tls-passthrough is a built-in listener — enable with -enable-tls-passthrough', 'apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + sanitizeName(d.name), 'spec:', '  listener:', '    name: tls-passthrough', '    protocol: TLS_PASSTHROUGH', '  host: ' + (concreteSni || '# TODO: Set your SNI host') + '  # HostSNI', '  upstreams:', '    - name: backend', '      service: ' + svc.name, '      port: ' + (svc.port || 443), '  action:', '    pass: backend'];
                    if (snis.indexOf('*') !== -1) {
                        out.notes.push({ code: label, message: 'HostSNI(`*`) catch-all has no TLS passthrough equivalent — NIC routes passthrough traffic by SNI host only.' });
                    }
                } else {
                    lines = ['apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + sanitizeName(d.name), 'spec:', '  listener:', '    name: ' + (d.entryPoints[0] ? sanitizeName(d.entryPoints[0]) : '# TODO: listener name') + '  # define in GlobalConfiguration (below)', '    protocol: TCP'];
                    if (concreteSni) {
                        lines.push('  host: ' + concreteSni + '  # HostSNI (SNI-based routing)');
                        let secret = (d.tls && d.tls.secretName) || '# TODO: TLS secret (required when host is set)';
                        lines.push('  tls:', '    secret: ' + secret + '  # NIC terminates TLS on this listener');
                    } else if (d.tls) {
                        // Traefik terminated TLS (e.g. HostSNI(`*`) catch-all) — dropping
                        // the tls block would stream raw TLS bytes to a plaintext backend.
                        lines.push('  host: # TODO: concrete SNI host — NIC has no HostSNI(`*`) catch-all for TLS-terminated TCP', '  tls:', '    secret: ' + ((d.tls && d.tls.secretName) || '# TODO: TLS secret') + '  # Traefik terminated TLS on this route — NIC needs host + tls.secret to do the same');
                        out.notes.push({ code: label, message: 'TLS-terminated TCP route without a concrete HostSNI: NIC requires spec.host (with spec.tls.secret) for SNI routing — there is no catch-all equivalent.' });
                    }
                    lines.push('  upstreams:', '    - name: backend', '      service: ' + svc.name, '      port: ' + (svc.port || 9000), '  action:', '    pass: backend');
                    out.crds.push({ kind: 'GlobalConfiguration', yaml: ['# One GlobalConfiguration per cluster (reference with -global-configuration)', 'apiVersion: k8s.nginx.org/v1', 'kind: GlobalConfiguration', 'metadata:', '  name: nginx-configuration', 'spec:', '  listeners:', '    - name: ' + (d.entryPoints[0] ? sanitizeName(d.entryPoints[0]) : 'tcp-listener'), '      port: # TODO: the port entryPoint "' + (d.entryPoints[0] || 'tcp') + '" listened on', '      protocol: TCP'].join('\n') });
                }
                (services.slice(1) || []).forEach(function(s) {
                    out.notes.push({ code: label, message: 'Additional service ' + s.name + ' — TransportServer passes to a single upstream; weighted TCP splits have no equivalent.' });
                });
                if (services.some(function(s) { return s.proxyProtocol; })) {
                    out.notes.push({ code: label, message: 'services[].proxyProtocol has no TransportServer field — add "proxy_protocol on;" via spec.serverSnippets (requires -enable-snippets).' });
                }
                out.crds.unshift({ kind: 'TransportServer', yaml: lines.join('\n') });
                return out;
            },

            generateTransportServerFromUDP: function(finding) {
                let out = contribution();
                let d = finding.data;
                let services = [];
                (d.routes || []).forEach(function(r) { ((r && r.services) || []).forEach(function(s) { if (s && s.name) services.push(s); }); });
                let svc = services[0] || { name: '# TODO: Set your service', port: 53 };
                out.crds.push({ kind: 'TransportServer', yaml: ['apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + sanitizeName(d.name), 'spec:', '  listener:', '    name: ' + (d.entryPoints[0] ? sanitizeName(d.entryPoints[0]) : '# TODO: listener name') + '  # define in GlobalConfiguration (below)', '    protocol: UDP', '  upstreamParameters:', '    udpRequests: 1  # tune for your protocol (client datagrams per session)', '    udpResponses: 1  # tune for your protocol (server datagrams per session)', '  upstreams:', '    - name: backend', '      service: ' + svc.name, '      port: ' + (svc.port || 53), '  action:', '    pass: backend'].join('\n') });
                out.crds.push({ kind: 'GlobalConfiguration', yaml: ['apiVersion: k8s.nginx.org/v1', 'kind: GlobalConfiguration', 'metadata:', '  name: nginx-configuration', 'spec:', '  listeners:', '    - name: ' + (d.entryPoints[0] ? sanitizeName(d.entryPoints[0]) : 'udp-listener'), '      port: # TODO: the port entryPoint "' + (d.entryPoints[0] || 'udp') + '" listened on', '      protocol: UDP'].join('\n') });
                return out;
            },

            generateSplitsFromWeighted: function(finding, context) {
                let out = contribution();
                let d = finding.data;
                let services = (d.weighted && Array.isArray(d.weighted.services)) ? d.weighted.services.filter(function(s) { return s && s.name; }) : [];
                if (services.length === 0) return out;
                // Unique upstream names (duplicate service entries would be rejected).
                let usedNames = {};
                let upstreamNames = services.map(function(s) {
                    let base = sanitizeName(s.name), n = base, k = 2;
                    while (usedNames[n]) n = base + '-' + (k++);
                    usedNames[n] = true;
                    return n;
                });
                let pcts = weightsToPercentages(services.map(function(s) { return s.weight != null ? s.weight : 1; }));
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(d.name), 'spec:', '  host: # TODO: Set your host', '  upstreams:'];
                services.forEach(function(s, i) {
                    lines.push('    - name: ' + upstreamNames[i], '      service: ' + s.name, '      port: ' + (s.port || 80));
                });
                if (services.length === 1) {
                    // NIC requires at least two splits — a one-service weighted TraefikService is a plain pass.
                    lines.push('  routes:', '    - path: /', '      action:', '        pass: ' + upstreamNames[0]);
                    out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                    return out;
                }
                lines.push('  routes:', '    - path: /', '      splits:');
                services.forEach(function(s, i) {
                    lines.push('        - weight: ' + pcts[i] + '  # weight ' + (s.weight != null ? s.weight : 1) + ' normalized (splits must sum to 100)', '          action: { pass: ' + upstreamNames[i] + ' }');
                });
                if (d.weighted && d.weighted.sticky && d.weighted.sticky.cookie) {
                    let c = d.weighted.sticky.cookie;
                    lines.push('', '# weighted.sticky.cookie → add to each upstream:', '#   sessionCookie:', '#     enable: true', '#     name: ' + (c.name || 'sticky'));
                }
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },

            generateMirroringNote: function(finding) {
                let out = contribution();
                let d = finding.data;
                let mirrors = (d.mirroring && Array.isArray(d.mirroring.mirrors)) ? d.mirroring.mirrors : [];
                let mirrorNames = mirrors.map(function(m) { return (m && m.name) || '?'; }).join(', ');
                out.notes.push({ code: 'TraefikService ' + d.name + ' (mirroring)', message: 'No dedicated NIC field — replicate with nginx.org/location-snippets ("mirror /mirror; mirror_request_body ' + ((d.mirroring && d.mirroring.mirrorBody === false) ? 'off' : 'on') + ';") plus an internal /mirror location in nginx.org/server-snippets proxying to ' + (mirrorNames || 'the mirror service') + '. Percent-based sampling (mirrors[].percent) has no equivalent — NGINX mirrors every request.' });
                return out;
            },

            generateFailoverVS: function(finding) {
                let out = contribution();
                let d = finding.data;
                let fo = d.failover || {};
                let main = fo.service || {};
                let fb = fo.fallback || {};
                let mainName = main.name || '# TODO: main service';
                let fbName = fb.name ? sanitizeName(fb.name) + '-external' : '# TODO: fallback ExternalName service';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + sanitizeName(d.name), 'spec:', '  host: # TODO: Set your host', '  upstreams:', '    - name: main', '      service: ' + mainName + '  # failover.service', '      port: ' + (main.port || 80), '      max-fails: 3       # mark the main servers unavailable after 3 failures...', '      fail-timeout: 30s  # ...for 30s — this is what triggers failover to backup', '      backup: ' + fbName + '  # failover.fallback (must be a Service of type ExternalName — NGINX Plus)', '      backupPort: ' + (fb.port || 80), '  routes:', '    - path: /', '      action:', '        pass: main'];
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                let msgs = ['backup/backupPort are a partial equivalent: NIC fails over when the main servers are unavailable (connection failures counted by max-fails/fail-timeout), not on specific HTTP responses'];
                let errs = fo.errors || {};
                if (errs.status != null) msgs.push('failover.errors.status (' + (Array.isArray(errs.status) ? errs.status.join(', ') : errs.status) + ') has no trigger equivalent — NIC cannot fail over on HTTP status codes');
                if (errs.maxRequestBodyBytes != null) msgs.push('failover.errors.maxRequestBodyBytes has no equivalent');
                msgs.push('backup must reference a Service of type ExternalName (NGINX Plus only) and cannot be combined with the random, hash, or ip_hash lb-methods; TransportServer upstreams expose the same fields for TCP');
                out.notes.push({ code: 'TraefikService ' + d.name + ' (failover)', message: msgs.join('. ') + '.' });
                return out;
            },

            generateTLSOptionContributions: function(finding) {
                let out = contribution();
                let o = finding.data.options || {};
                let name = finding.data.name;
                let label = 'TLSOption ' + name;
                if (o.minVersion || o.maxVersion) {
                    out.configMap.push({ fromLabel: label + ' (minVersion/maxVersion)', to: 'ssl-protocols', value: tlsProtocolsFrom(o.minVersion, o.maxVersion), note: 'global — applies to every host, not per-router like TLSOption' });
                }
                if (Array.isArray(o.cipherSuites) && o.cipherSuites.length > 0) {
                    out.configMap.push({ fromLabel: label + ' (cipherSuites)', to: 'ssl-ciphers', value: o.cipherSuites.join(':'), note: 'global; Go cipher names shown — translate to OpenSSL names' });
                }
                if (Array.isArray(o.curvePreferences) && o.curvePreferences.length > 0) {
                    out.configMap.push({ fromLabel: label + ' (curvePreferences)', to: 'http-snippets', value: '|\\n  ssl_ecdh_curve ' + o.curvePreferences.join(':') + ';', note: 'no ssl-ecdh-curve ConfigMap key — set via http-snippets' });
                }
                if (o.clientAuth && (o.clientAuth.secretNames || o.clientAuth.clientAuthType)) {
                    let typeMap = { NoClientCert: 'off', VerifyClientCertIfGiven: 'optional', RequireAndVerifyClientCert: 'on', RequestClientCert: 'optional_no_ca', RequireAnyClientCert: 'optional_no_ca' };
                    let cat = o.clientAuth.clientAuthType || 'RequireAndVerifyClientCert';
                    let verify = typeMap[cat] || 'on';
                    let secrets = Array.isArray(o.clientAuth.secretNames) ? o.clientAuth.secretNames : [];
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + sanitizeName(name) + '-mtls-policy', 'spec:', '  ingressMTLS:', '    clientCertSecret: ' + (secrets[0] || '# TODO: CA secret (type nginx.org/ca, key ca.crt)') + (secrets.length > 1 ? '  # concatenate all clientAuth.secretNames CA bundles into one secret' : '  # clientAuth.secretNames'), '    verifyClient: "' + verify + '"  # clientAuthType: ' + cat, '    verifyDepth: 1', '', '# Attach at VirtualServer spec.policies level (TLS termination required) — unlike TLSOption,', '# this is per-application: an upgrade from Traefik\'s per-entryPoint client auth.'];
                    out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                    if (cat === 'RequestClientCert' || cat === 'RequireAnyClientCert') {
                        out.notes.push({ code: label, message: 'clientAuthType ' + cat + ' has no exact match — optional_no_ca is the closest (requests a certificate without CA verification but does not require one).' });
                    }
                }
                if (o.sniStrict === true) {
                    out.notes.push({ code: label + ' (sniStrict)', message: 'Automatic in NIC: when -default-server-tls-secret is unset and no fallback certificate exists, the default server uses ssl_reject_handshake — there is no user-facing toggle.' });
                }
                if (Array.isArray(o.alpnProtocols) && o.alpnProtocols.length > 0) {
                    out.notes.push({ code: label + ' (alpnProtocols)', message: 'No verified NIC ALPN control exists at v5.5.1 — verify before relying on specific ALPN behavior.' });
                }
                if (o.disableSessionTickets === true) {
                    out.notes.push({ code: label + ' (disableSessionTickets)', message: 'No ConfigMap key — set "ssl_session_tickets off;" via http-snippets if required.' });
                }
                return out;
            },

            generateEgressMTLSFromServersTransport: function(finding) {
                let out = contribution();
                let o = finding.data.options || {};
                let name = finding.data.name;
                let label = 'ServersTransport ' + name;
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + sanitizeName(name) + '-egress-mtls', 'spec:', '  egressMTLS:'];
                let certs = Array.isArray(o.certificatesSecrets) ? o.certificatesSecrets : [];
                if (certs.length > 0) lines.push('    tlsSecret: ' + certs[0] + '  # certificatesSecrets (type kubernetes.io/tls)');
                let roots = [];
                (Array.isArray(o.rootCAs) ? o.rootCAs : []).forEach(function(r) { if (r && r.secret) roots.push(r.secret); else if (r && r.configMap) roots.push('!configmap:' + r.configMap); });
                (Array.isArray(o.rootCAsSecrets) ? o.rootCAsSecrets : []).forEach(function(r) { roots.push(r); });
                let rootSecrets = roots.filter(function(r) { return r.indexOf('!configmap:') !== 0; });
                if (rootSecrets.length > 0) {
                    lines.push('    trustedCertSecret: ' + rootSecrets[0] + '  # rootCAs (re-create as type nginx.org/ca, key ca.crt)', '    verifyServer: true');
                } else if (o.insecureSkipVerify === true) {
                    lines.push('    verifyServer: false  # insecureSkipVerify: true (NIC default is also off)');
                }
                if (o.serverName) lines.push('    sslName: ' + o.serverName + '  # serverName', '    serverName: true  # send SNI');
                if (o.minVersion || o.maxVersion) lines.push('    protocols: ' + yamlQuote(tlsProtocolsFrom(o.minVersion, o.maxVersion)) + '  # minVersion/maxVersion (approximate)');
                if (Array.isArray(o.cipherSuites) && o.cipherSuites.length > 0) lines.push('    ciphers: ' + yamlQuote(o.cipherSuites.join(':')) + '  # cipherSuites (Go names shown — translate to OpenSSL names; NIC does not validate)');
                lines.push('', '# Attach via VirtualServer spec.policies or nginx.org/policies (v5.5.0+). egressMTLS only sets', '# proxy_ssl_* — it never switches the upstream to HTTPS on either path. Set the upstream scheme', '# separately: on VirtualServer add upstreams[].tls.enable: true; on Ingress use nginx.org/ssl-services.');
                out.crds.push({ kind: 'Policy', yaml: lines.join('\n') });
                if (roots.some(function(r) { return r.indexOf('!configmap:') === 0; })) {
                    out.notes.push({ code: label, message: 'ConfigMap-sourced rootCAs are not supported — re-create the CA bundle as a Secret of type nginx.org/ca.' });
                }
                if (o.maxIdleConnsPerHost != null || o.forwardingTimeouts) {
                    let ft = o.forwardingTimeouts || {};
                    let bits = [];
                    if (o.maxIdleConnsPerHost != null) bits.push('maxIdleConnsPerHost → upstreams[].keepalive: ' + o.maxIdleConnsPerHost);
                    if (ft.dialTimeout) bits.push('dialTimeout → connect-timeout: ' + ft.dialTimeout);
                    if (ft.responseHeaderTimeout) bits.push('responseHeaderTimeout → read-timeout: ' + ft.responseHeaderTimeout + ' (closest: nginx times successive reads, not just headers)');
                    if (ft.idleConnTimeout) bits.push('idleConnTimeout → no field');
                    out.notes.push({ code: label + ' (transport tuning)', message: 'Set on VirtualServer upstreams: ' + bits.join('; ') + '.' });
                }
                if (o.disableHTTP2 != null || o.spiffe) {
                    out.notes.push({ code: label, message: 'No equivalent for: ' + [o.disableHTTP2 != null ? 'disableHTTP2 (NGINX proxies backends over HTTP/1.1, gRPC excepted)' : null, o.spiffe ? 'spiffe (NIC SPIFFE integration was Plus + NGINX Service Mesh only, discontinued)' : null].filter(Boolean).join('; ') + '.' });
                }
                return out;
            },

            generateTLSStoreNote: function(finding) {
                let out = contribution();
                let o = finding.data.options || {};
                let name = finding.data.name;
                let msgs = [];
                if (o.defaultCertificate && o.defaultCertificate.secretName) {
                    msgs.push('defaultCertificate.secretName "' + o.defaultCertificate.secretName + '" → start NIC with -default-server-tls-secret <namespace>/' + o.defaultCertificate.secretName + ' (deployment flag, not a resource)');
                }
                if (Array.isArray(o.certificates) && o.certificates.length > 0) {
                    msgs.push('certificates[] → reference each Secret directly from its VirtualServer spec.tls.secret / Ingress spec.tls');
                }
                if (o.defaultGeneratedCert) {
                    msgs.push('defaultGeneratedCert → use cert-manager (VirtualServer tls.cert-manager) — NIC has no built-in ACME');
                }
                if (msgs.length === 0) msgs.push('map default certificates to the -default-server-tls-secret deployment flag and per-app Secrets');
                out.notes.push({ code: 'TLSStore ' + name, message: msgs.join('. ') + '.' });
                return out;
            },

            generateTCPInFlightConnTS: function(finding) {
                let out = contribution();
                let opts = finding.data.options || {};
                let amount = opts.amount != null ? opts.amount : 100;
                out.crds.push({ kind: 'TransportServer', yaml: ['# Closest equivalent: per-upstream-server connection cap (NOT per-client-IP like inFlightConn)', 'apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + sanitizeName(finding.data.middlewareName) + '-ts', 'spec:', '  listener:', '    name: # TODO: your GlobalConfiguration TCP listener', '    protocol: TCP', '  upstreams:', '    - name: backend', '      service: # TODO: Set your service', '      port: # TODO: Set your port', '      maxConns: ' + amount + '  # inFlightConn.amount — per upstream server, not per client IP', '  action:', '    pass: backend'].join('\n') });
                return out;
            },

            generateTCPIpAllowListTS: function(finding) {
                let out = contribution();
                let opts = finding.data.options || {};
                let ranges = Array.isArray(opts.sourceRange) ? opts.sourceRange : [];
                let allowLines = ranges.map(function(r) { return 'allow ' + r + ';'; });
                allowLines.push('deny all;');
                out.crds.push({ kind: 'TransportServer', yaml: ['# TransportServer has no ACL field — use serverSnippets (requires -enable-snippets)', 'apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ' + sanitizeName(finding.data.middlewareName) + '-ts', 'spec:', '  listener:', '    name: # TODO: your GlobalConfiguration TCP listener', '    protocol: TCP', '  serverSnippets: |', allowLines.map(function(l) { return '    ' + l + '  # sourceRange'; }).join('\n'), '  upstreams:', '    - name: backend', '      service: # TODO: Set your service', '      port: # TODO: Set your port', '  action:', '    pass: backend'].join('\n') });
                return out;
            }
        };

        // Merge the CRD generators into the main registry.
        Object.keys(GENERATORS_CRD).forEach(function(k) { GENERATORS[k] = GENERATORS_CRD[k]; });
        // --- Ingress-annotation handlers (grouped per mapping entry) -----------

        function annotationValue(findings, suffix) {
            let f = findings.find(function(x) { return x.key === 'annotation:' + suffix; });
            return f ? f.value : null;
        }

        let GENERATORS_ANNOTATIONS = {
            generateNativeLBSwap: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/use-cluster-ip', value: f.value, note: 'routes to the Service ClusterIP — lb-method/next-upstream become no-ops' });
                });
                return out;
            },
            generateServersSchemeSwap: function(findings, context) {
                let out = contribution();
                let basics = context.firstIngressBasics || {};
                let svc = basics.serviceName || '# TODO: Set your service';
                findings.forEach(function(f) {
                    let v = String(f.value).toLowerCase();
                    if (v === 'https') {
                        out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/ssl-services', value: svc, note: 'proxies to the backend over HTTPS' });
                    } else if (v === 'h2c') {
                        out.swaps.push({ fromKey: f.label, fromValue: f.value, to: 'nginx.org/grpc-services', value: svc, note: 'grpc_pass grpc:// = h2c plaintext; requires the http2 ConfigMap key and TLS-terminated Ingress' });
                    } else {
                        out.notes.push({ code: f.label + ': ' + f.value, message: 'http is the default upstream scheme — remove this annotation, no replacement needed.' });
                    }
                });
                return out;
            },
            generateAccessLogsAnnotation: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (String(f.value) === 'false') {
                        out.configMap.push({ fromLabel: f.label + ': "false"', to: 'access-log-off', value: 'true', note: 'global — NIC has no per-route access-log toggle' });
                    } else {
                        out.notes.push({ code: f.label + ': ' + f.value, message: 'Access logging is on by default in NIC (global). Remove this annotation; per-router toggles have no equivalent.' });
                    }
                });
                return out;
            },
            generateTracingAnnotation: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (f.key === 'annotation:router.observability.tracing' && String(f.value) === 'true') {
                        out.configMap.push({ fromLabel: f.label + ': "true"', to: 'otel-trace-in-http', value: 'true', note: 'global — also set otel-exporter-endpoint (OTLP/gRPC) and otel-service-name' });
                    } else {
                        out.notes.push({ code: f.label + ': ' + f.value, message: 'NIC OpenTelemetry tracing is global (ConfigMap otel-* keys) — per-router toggles and verbosity have no equivalent.' });
                    }
                });
                return out;
            },
            generateStickyCookieVS: function(findings, context) {
                let out = contribution();
                let basics = context.firstIngressBasics || {};
                let get = function(sub) { return annotationValue(findings, 'service.sticky.cookie' + sub); };
                let name = get('.name') || 'sticky';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: ' + (sanitizeName(basics.ingressName || 'sticky-app')), 'spec:', '  host: ' + (basics.host || '# TODO: Set your host'), '  upstreams:', '    - name: backend', '      service: ' + (basics.serviceName || '# TODO: Set your service'), '      port: ' + (basics.servicePort || '80'), '      sessionCookie:', '        enable: true  # service.sticky.cookie', '        name: ' + name + (get('.name') ? '  # service.sticky.cookie.name' : '')];
                let maxage = get('.maxage');
                if (maxage != null) {
                    let expires = secondsToNginxTime(maxage);
                    if (expires) lines.push('        expires: ' + expires + '  # service.sticky.cookie.maxage (' + maxage + 's)');
                }
                let path = get('.path');
                lines.push('        path: ' + (path || '/') + (path ? '  # service.sticky.cookie.path' : ''));
                let domain = get('.domain');
                if (domain) lines.push('        domain: ' + domain + '  # service.sticky.cookie.domain');
                if (get('.secure') === 'true') lines.push('        secure: true  # service.sticky.cookie.secure');
                if (get('.httponly') === 'true') lines.push('        httpOnly: true  # service.sticky.cookie.httponly');
                let samesite = get('.samesite');
                if (samesite) lines.push('        samesite: ' + String(samesite).toLowerCase() + '  # service.sticky.cookie.samesite');
                lines.push('  routes:', '    - path: ' + (basics.path || '/'), '      action:', '        pass: backend');
                out.crds.push({ kind: 'VirtualServer', yaml: lines.join('\n') });
                return out;
            },
            generateEntryPointsNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'Map each entryPoint to its port: default web/websecure ports are NIC\'s defaults (80/443); custom ports go in nginx.org/listen-ports / nginx.org/listen-ports-ssl or GlobalConfiguration HTTP listeners.' });
                });
                return out;
            },
            generateMiddlewaresRefNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'Convert each referenced Middleware (paste its manifest into this analyzer), then attach the generated Policies via nginx.org/policies on the Ingress or VirtualServer spec.policies.' });
                });
                return out;
            },
            generateRouterTLSNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'NIC derives TLS from the Ingress spec.tls block (or VirtualServer spec.tls) — no annotation needed; remove it.' });
                });
                return out;
            },
            generateCertResolverNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'NIC has no built-in ACME — install cert-manager and request the certificate via VirtualServer spec.tls.cert-manager.cluster-issuer (or an Ingress cert-manager.io annotation). Traefik\'s acme.json certificates are not Kubernetes Secrets and must be re-issued.' });
                });
                return out;
            },
            generateTLSDomainsNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'Certificate domains move to the cert-manager Certificate (dnsNames) or VirtualServer tls.cert-manager.common-name — not an NIC routing concern.' });
                });
                return out;
            },
            generateTLSOptionsRefNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'TLS options are global in NIC: ConfigMap ssl-protocols / ssl-ciphers (see the referenced TLSOption resource — paste it here to convert it).' });
                });
                return out;
            },
            generatePathMatcherNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'Choose the VirtualServer path syntax instead: Path → "= /exact", PathPrefix → "/prefix", PathRegexp → "~ regex".' });
                });
                return out;
            },
            generatePassHostHeaderNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    if (String(f.value) === 'false') {
                        out.notes.push({ code: f.label + ': "false"', message: 'NIC sends Host: $host by default (≈ passHostHeader: true). To forward the upstream\'s own name instead, set the Host header via VirtualServer action.proxy.requestHeaders.set — the nginx.org/proxy-set-headers annotation cannot reliably override Host.' });
                    } else {
                        out.notes.push({ code: f.label + ': ' + f.value, message: 'passHostHeader: true matches NIC\'s default behavior (Host: $host) — remove this annotation.' });
                    }
                });
                return out;
            },
            generateServersTransportRefNote: function(findings) {
                let out = contribution();
                findings.forEach(function(f) {
                    out.notes.push({ code: f.label + ': ' + f.value, message: 'Convert the referenced ServersTransport (paste its manifest here): TLS settings become an egressMTLS Policy, timeouts/keepalive become VirtualServer upstream fields.' });
                });
                return out;
            }
        };
        Object.keys(GENERATORS_ANNOTATIONS).forEach(function(k) { GENERATORS[k] = GENERATORS_ANNOTATIONS[k]; });

        // Traefik Hub (commercial) middlewares → NGINX Plus policy pointers.
        GENERATORS.generateHubMiddlewareNote = function(finding) {
            let out = contribution();
            let type = finding.key.replace('middleware:', '');
            if (type === 'apiKey') {
                // The Traefik apiKey middleware is Hub-commercial, but its NIC counterpart —
                // the apiKey Policy — is NOT Plus-gated: it runs on NGINX OSS (auth_request + NJS).
                out.notes.push({ code: finding.label, message: 'Traefik Hub (commercial) middleware — maps to the NIC apiKey Policy, which is available on NGINX OSS (not Plus-gated). See the NGINX Plus Mappings section for the worked example.' });
                return out;
            }
            let plusPolicy = { jwt: 'jwt', oidc: 'oidc', waf: 'waf', distributedRateLimit: 'rateLimit (+ zone-sync ConfigMap keys)' }[type];
            out.notes.push({ code: finding.label, message: 'Traefik Hub middleware — maps to the NGINX Plus ' + plusPolicy + ' Policy. See the NGINX Plus Mappings section for the worked example.' });
            return out;
        };

        // --- Mapping registry ----------------------------------------------------
        // keys: parseInput finding keys. grouped: true = one generator call with all
        // findings of the entry (Ingress annotations); false = one call per finding
        // (each Middleware/CRD instance converts independently).

        const TRAEFIK_MAPPINGS = [
            // Ingress annotations — router.*
            { keys: ['annotation:router.entrypoints'], source: 'router.entrypoints', nic: 'nginx.org/listen-ports, nginx.org/listen-ports-ssl — or — GlobalConfiguration listeners', type: 'annotation', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateEntryPointsNote' },
            { keys: ['annotation:router.middlewares', 'annotation:service.middlewares'], source: 'router.middlewares / service.middlewares', nic: 'nginx.org/policies (converted Policy names) — or — VirtualServer policies[]', type: 'policy', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateMiddlewaresRefNote' },
            { keys: ['annotation:router.pathmatcher'], source: 'router.pathmatcher', nic: 'VirtualServer routes[].path syntax (=, prefix, ~)', type: 'virtualserver', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generatePathMatcherNote' },
            { keys: ['annotation:router.priority'], source: 'router.priority', nic: 'No direct equivalent — NGINX location precedence (exact > longest prefix > regex order) is fixed', type: 'unsupported', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true },
            { keys: ['annotation:router.rulesyntax'], source: 'router.rulesyntax', nic: 'Not applicable — deprecated Traefik v2-syntax toggle; convert v2 matchers (Headers, HeadersRegexp) to their v3 forms during migration', type: 'unsupported', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true },
            { keys: ['annotation:router.tls'], source: 'router.tls', nic: 'Ingress spec.tls / VirtualServer spec.tls.secret', type: 'virtualserver', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateRouterTLSNote' },
            { keys: ['annotation:router.tls.certresolver'], source: 'router.tls.certresolver', nic: 'cert-manager + VirtualServer tls.cert-manager.cluster-issuer', type: 'virtualserver', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateCertResolverNote' },
            { keys: ['annotation:router.tls.domains.n.main', 'annotation:router.tls.domains.n.sans'], source: 'router.tls.domains.n.main / .sans', nic: 'cert-manager Certificate dnsNames', type: 'virtualserver', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateTLSDomainsNote' },
            { keys: ['annotation:router.tls.options'], source: 'router.tls.options', nic: 'ConfigMap ssl-protocols, ssl-ciphers (global)', type: 'configmap', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateTLSOptionsRefNote' },
            { keys: ['annotation:router.observability.accesslogs'], source: 'router.observability.accesslogs', nic: 'ConfigMap access-log-off (global)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateAccessLogsAnnotation' },
            { keys: ['annotation:router.observability.metrics'], source: 'router.observability.metrics', nic: 'No direct equivalent — NIC Prometheus metrics are controller-global (-enable-prometheus-metrics)', type: 'unsupported', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true },
            { keys: ['annotation:router.observability.tracing', 'annotation:router.observability.traceverbosity'], source: 'router.observability.tracing / .traceverbosity', nic: 'ConfigMap otel-trace-in-http + otel-exporter-endpoint (global)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateTracingAnnotation' },
            // Ingress annotations — service.*
            { keys: ['annotation:service.nativelb'], source: 'service.nativelb', nic: 'nginx.org/use-cluster-ip', type: 'annotation', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateNativeLBSwap' },
            { keys: ['annotation:service.nodeportlb'], source: 'service.nodeportlb', nic: 'No direct equivalent — NIC load-balances pod endpoints (or the ClusterIP with use-cluster-ip), never NodePorts', type: 'unsupported', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true },
            { keys: ['annotation:service.passhostheader'], source: 'service.passhostheader', nic: 'Default behavior (Host: $host) — override via VirtualServer requestHeaders.set', type: 'virtualserver', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generatePassHostHeaderNote' },
            { keys: ['annotation:service.serversscheme'], source: 'service.serversscheme', nic: 'nginx.org/ssl-services (https) / nginx.org/grpc-services (h2c)', type: 'annotation', category: 'Ingress Annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateServersSchemeSwap' },
            { keys: ['annotation:service.serverstransport'], source: 'service.serverstransport', nic: 'Policy CRD egressMTLS + VirtualServer upstream tuning', type: 'policy', category: 'Backend Transport', anchor: 'backend-transport', section: 'oss', grouped: true, generator: 'generateServersTransportRefNote' },
            { keys: ['annotation:service.sticky.cookie', 'annotation:service.sticky.cookie.name', 'annotation:service.sticky.cookie.secure', 'annotation:service.sticky.cookie.samesite', 'annotation:service.sticky.cookie.domain', 'annotation:service.sticky.cookie.httponly', 'annotation:service.sticky.cookie.maxage', 'annotation:service.sticky.cookie.path'], source: 'service.sticky.cookie.*', nic: 'VirtualServer upstreams[].sessionCookie', type: 'virtualserver', category: 'Session Affinity', anchor: 'session-affinity', section: 'oss', grouped: true, generator: 'generateStickyCookieVS' },

            // HTTP middlewares
            { keys: ['middleware:addPrefix'], source: 'Middleware addPrefix', nic: 'VirtualServer action.proxy.rewritePath', type: 'virtualserver', category: 'Rewrites', anchor: 'rewrites', section: 'oss', generator: 'generateAddPrefixVS' },
            { keys: ['middleware:basicAuth'], source: 'Middleware basicAuth', nic: 'Policy CRD basicAuth — or — nginx.org/basic-auth-secret + nginx.org/basic-auth-realm', type: 'policy', category: 'Authentication', anchor: 'authentication', section: 'oss', dualApproach: true, generator: 'generateBasicAuthPolicy' },
            { keys: ['middleware:buffering'], source: 'Middleware buffering', nic: 'nginx.org/client-max-body-size — or — VirtualServer upstreams[].client-max-body-size / client-body-buffer-size', type: 'virtualserver', category: 'Buffering & Body Size', anchor: 'buffering', section: 'oss', generator: 'generateBufferingVS' },
            { keys: ['middleware:chain'], source: 'Middleware chain', nic: 'Multiple policies listed in nginx.org/policies / VirtualServer policies[] (order preserved)', type: 'policy', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss', generator: 'generateChainNote' },
            { keys: ['middleware:circuitBreaker'], source: 'Middleware circuitBreaker', nic: 'VirtualServer upstreams[].max-fails + fail-timeout (passive) — Plus: upstreams[].healthCheck (active)', type: 'virtualserver', category: 'Resilience', anchor: 'resilience', section: 'oss', generator: 'generateCircuitBreakerVS' },
            { keys: ['middleware:compress'], source: 'Middleware compress', nic: 'ConfigMap http-snippets (gzip directives — no compression key exists)', type: 'configmap', category: 'Compression', anchor: 'compression', section: 'oss', generator: 'generateCompressConfigMap' },
            { keys: ['middleware:contentType'], source: 'Middleware contentType', nic: 'No direct equivalent — NGINX proxies Content-Type untouched; Traefik-specific auto-detection control', type: 'unsupported', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss' },
            { keys: ['middleware:digestAuth'], source: 'Middleware digestAuth', nic: 'No direct equivalent — NGINX has no digest-auth module; re-issue credentials as htpasswd and use basicAuth', type: 'unsupported', category: 'Authentication', anchor: 'authentication', section: 'oss' },
            { keys: ['middleware:encodedCharacters'], source: 'Middleware encodedCharacters', nic: 'No direct equivalent — NGINX URI normalization is fixed; encoded-character allowances cannot be configured per route', type: 'unsupported', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss' },
            { keys: ['middleware:errors'], source: 'Middleware errors', nic: 'VirtualServer routes[].errorPages', type: 'virtualserver', category: 'Error Handling', anchor: 'error-handling', section: 'oss', generator: 'generateErrorPagesVS' },
            { keys: ['middleware:forwardAuth'], source: 'Middleware forwardAuth', nic: 'Policy CRD externalAuth', type: 'policy', category: 'Authentication', anchor: 'authentication', section: 'oss', generator: 'generateExternalAuthPolicy' },
            { keys: ['middleware:grpcWeb'], source: 'Middleware grpcWeb', nic: 'No direct equivalent — NIC has no gRPC-Web-to-gRPC translation (nginx.org/grpc-services proxies native gRPC only); keep a gRPC-Web proxy in the pod', type: 'unsupported', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss' },
            { keys: ['middleware:headers'], source: 'Middleware headers', nic: 'Policy CRD cors / nginx.org/hsts* / nginx.org/add-header / VirtualServer requestHeaders + responseHeaders', type: 'policy', category: 'CORS & Headers', anchor: 'headers', section: 'oss', generator: 'generateHeadersContributions' },
            { keys: ['middleware:inFlightReq'], source: 'Middleware inFlightReq', nic: 'nginx.org/location-snippets (limit_conn) + ConfigMap http-snippets (limit_conn_zone)', type: 'annotation', category: 'Rate Limiting & Concurrency', anchor: 'rate-limiting', section: 'oss', generator: 'generateInFlightReqNote' },
            { keys: ['middleware:ipAllowList', 'middleware:ipWhiteList'], source: 'Middleware ipAllowList', nic: 'Policy CRD accessControl', type: 'policy', category: 'Access Control', anchor: 'access-control', section: 'oss', generator: 'generateAccessControlPolicy' },
            { keys: ['middleware:passTLSClientCert'], source: 'Middleware passTLSClientCert', nic: 'VirtualServer requestHeaders.set with ${ssl_client_escaped_cert} / ${ssl_client_s_dn} (+ ingressMTLS Policy)', type: 'virtualserver', category: 'Access Control', anchor: 'access-control', section: 'oss', generator: 'generatePassTLSClientCertVS' },
            { keys: ['middleware:rateLimit'], source: 'Middleware rateLimit', nic: 'Policy CRD rateLimit — or — nginx.org/limit-req-rate + nginx.org/limit-req-burst', type: 'policy', category: 'Rate Limiting & Concurrency', anchor: 'rate-limiting', section: 'oss', dualApproach: true, generator: 'generateRateLimitPolicy' },
            { keys: ['middleware:redirectRegex'], source: 'Middleware redirectRegex', nic: 'VirtualServer action.redirect (static URL) / location-snippets rewrite (captures)', type: 'virtualserver', category: 'Redirects', anchor: 'redirects', section: 'oss', generator: 'generateRedirectRegexVS' },
            { keys: ['middleware:redirectScheme'], source: 'Middleware redirectScheme', nic: 'nginx.org/redirect-to-https + nginx.org/http-redirect-code — or — VirtualServer tls.redirect', type: 'virtualserver', category: 'Redirects', anchor: 'redirects', section: 'oss', dualApproach: true, generator: 'generateRedirectSchemeVS' },
            { keys: ['middleware:replacePath'], source: 'Middleware replacePath', nic: 'VirtualServer action.proxy.rewritePath — or — nginx.org/rewrites', type: 'virtualserver', category: 'Rewrites', anchor: 'rewrites', section: 'oss', generator: 'generateReplacePathVS' },
            { keys: ['middleware:replacePathRegex'], source: 'Middleware replacePathRegex', nic: 'VirtualServer regex path (~) + rewritePath with $1–$9 captures', type: 'virtualserver', category: 'Rewrites', anchor: 'rewrites', section: 'oss', generator: 'generateReplacePathRegexVS' },
            { keys: ['middleware:retry'], source: 'Middleware retry', nic: 'VirtualServer upstreams[].next-upstream + next-upstream-tries — or — nginx.org/proxy-next-upstream*', type: 'virtualserver', category: 'Resilience', anchor: 'resilience', section: 'oss', generator: 'generateRetryVS' },
            { keys: ['middleware:stripPrefix', 'middleware:stripPrefixRegex'], source: 'Middleware stripPrefix / stripPrefixRegex', nic: 'VirtualServer regex path + rewritePath — or — nginx.org/rewrites', type: 'virtualserver', category: 'Rewrites', anchor: 'rewrites', section: 'oss', generator: 'generateStripPrefixVS' },

            // TCP middlewares
            { keys: ['middlewaretcp:inFlightConn'], source: 'MiddlewareTCP inFlightConn', nic: 'TransportServer upstreams[].maxConns (per-upstream cap — closest equivalent)', type: 'transportserver', category: 'TCP & UDP', anchor: 'tcp-udp', section: 'oss', generator: 'generateTCPInFlightConnTS' },
            { keys: ['middlewaretcp:ipAllowList', 'middlewaretcp:ipWhiteList'], source: 'MiddlewareTCP ipAllowList', nic: 'TransportServer serverSnippets (allow/deny)', type: 'transportserver', category: 'TCP & UDP', anchor: 'tcp-udp', section: 'oss', generator: 'generateTCPIpAllowListTS' },

            // Traefik CRDs
            { keys: ['kind:IngressRoute'], source: 'IngressRoute', nic: 'VirtualServer CRD', type: 'virtualserver', category: 'Routing (IngressRoute)', anchor: 'routing', section: 'oss', generator: 'generateVirtualServerFromIngressRoute' },
            { keys: ['kind:IngressRouteTCP'], source: 'IngressRouteTCP', nic: 'TransportServer CRD (+ GlobalConfiguration listener)', type: 'transportserver', category: 'TCP & UDP', anchor: 'tcp-udp', section: 'oss', generator: 'generateTransportServerFromTCP' },
            { keys: ['kind:IngressRouteUDP'], source: 'IngressRouteUDP', nic: 'TransportServer CRD (UDP) + GlobalConfiguration listener', type: 'transportserver', category: 'TCP & UDP', anchor: 'tcp-udp', section: 'oss', generator: 'generateTransportServerFromUDP' },
            { keys: ['traefikservice:weighted'], source: 'TraefikService (weighted)', nic: 'VirtualServer routes[].splits', type: 'virtualserver', category: 'Traffic Splitting', anchor: 'traffic-splitting', section: 'oss', generator: 'generateSplitsFromWeighted' },
            { keys: ['traefikservice:mirroring'], source: 'TraefikService (mirroring)', nic: 'nginx.org/location-snippets + nginx.org/server-snippets (mirror directives)', type: 'annotation', category: 'Traffic Splitting', anchor: 'traffic-splitting', section: 'oss', generator: 'generateMirroringNote' },
            { keys: ['traefikservice:failover'], source: 'TraefikService (failover)', nic: 'VirtualServer/VirtualServerRoute upstreams[].backup + backupPort — partial (fires on upstream unavailability, not errors.status; backup must be an ExternalName Service, NGINX Plus)', type: 'virtualserver', category: 'Traffic Splitting', anchor: 'traffic-splitting', section: 'oss', generator: 'generateFailoverVS' },
            { keys: ['traefikservice:highestRandomWeight'], source: 'TraefikService (highestRandomWeight)', nic: 'No direct equivalent — NIC upstreams support round_robin/least_conn/ip_hash/hash/random (least_time on NGINX Plus) lb-methods', type: 'unsupported', category: 'Traffic Splitting', anchor: 'traffic-splitting', section: 'oss' },
            { keys: ['kind:TLSOption'], source: 'TLSOption', nic: 'ConfigMap ssl-protocols / ssl-ciphers + Policy ingressMTLS (clientAuth)', type: 'configmap', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', generator: 'generateTLSOptionContributions' },
            { keys: ['kind:TLSStore'], source: 'TLSStore', nic: '-default-server-tls-secret deployment flag + per-app TLS Secrets', type: 'configmap', category: 'TLS & Certificates', anchor: 'tls-certificates', section: 'oss', generator: 'generateTLSStoreNote' },
            { keys: ['kind:ServersTransport'], source: 'ServersTransport', nic: 'Policy CRD egressMTLS + VirtualServer upstream tuning', type: 'policy', category: 'Backend Transport', anchor: 'backend-transport', section: 'oss', generator: 'generateEgressMTLSFromServersTransport' },
            { keys: ['kind:ServersTransportTCP'], source: 'ServersTransportTCP', nic: 'No direct equivalent — TransportServer has no backend-TLS fields; use serverSnippets/streamSnippets as an escape hatch', type: 'unsupported', category: 'Backend Transport', anchor: 'backend-transport', section: 'oss' },

            // Traefik Hub (commercial) middlewares → NGINX Plus
            { keys: ['middleware:jwt'], source: 'Middleware jwt (Hub)', nic: 'Policy CRD jwt (NGINX Plus)', type: 'policy', category: 'JWT Authentication', anchor: 'jwt-authentication', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:oidc'], source: 'Middleware oidc (Hub)', nic: 'Policy CRD oidc (NGINX Plus)', type: 'policy', category: 'OIDC Authentication', anchor: 'oidc-authentication', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:apiKey'], source: 'Middleware apiKey (Hub)', nic: 'Policy CRD apiKey (NGINX OSS)', type: 'policy', category: 'API Key Authentication', anchor: 'api-key-authentication', section: 'plus', generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:waf'], source: 'Middleware waf (Hub)', nic: 'Policy CRD waf (NGINX Plus, via nginx.com/policies on Ingress)', type: 'policy', category: 'WAF', anchor: 'waf', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:distributedRateLimit'], source: 'Middleware distributedRateLimit (Hub)', nic: 'Policy CRD rateLimit + zone-sync ConfigMap keys (NGINX Plus)', type: 'policy', category: 'Distributed Rate Limiting', anchor: 'distributed-rate-limiting', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:hmac', 'middleware:ldap', 'middleware:oAuth2ClientCredentials', 'middleware:oauth2ClientCredentials', 'middleware:oauth2TokenIntrospection', 'middleware:opa'], source: 'Middleware hmac / ldap / oauth2* / opa (Hub)', nic: 'No direct equivalent — nearest paths: externalAuth Policy fronting an LDAP/OPA auth service, or the oidc Policy for OAuth2 flows', type: 'unsupported', category: 'Other Hub Middlewares', anchor: 'hub-other', section: 'plus' }
        ];

        const TRAEFIK_LOOKUP = new Map();
        TRAEFIK_MAPPINGS.forEach(function(mapping, idx) {
            mapping.keys.forEach(function(key) {
                TRAEFIK_LOOKUP.set(key, idx);
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
            let warnings = [];

            // Match findings against the registry. Grouped entries collect all their
            // findings for one generator call; ungrouped entries convert per finding.
            let matchedEntries = new Map();   // idx → { mapping, findings: [] }
            let unrecognized = [];
            findings.forEach(function(f) {
                let idx = TRAEFIK_LOOKUP.get(f.key);
                if (idx === undefined) {
                    unrecognized.push(f);
                    return;
                }
                if (!matchedEntries.has(idx)) matchedEntries.set(idx, { mapping: TRAEFIK_MAPPINGS[idx], findings: [] });
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

            function annotationsOldYaml(groupFindings) {
                let lines = ['annotations:'];
                groupFindings.forEach(function(f) {
                    if (f.key.indexOf('annotation:') === 0) {
                        lines.push(formatYamlKV('  ', f.label, f.value));
                    } else {
                        lines.push('  # ' + f.label);
                    }
                });
                return lines.join('\n');
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
                        absorb(gen(entry.findings, context, strategy), annotationsOldYaml(entry.findings));
                    } else {
                        entry.findings.forEach(function(f) {
                            absorb(gen(f, context, strategy), truncateYaml(f.raw || ('# ' + f.label), 40));
                        });
                    }
                } catch (e) {
                    console.warn('Traefik generator failed for ' + mapping.source + ':', e);
                }
            });

            // Deduplicate annotation swaps by target key — two middlewares mapping
            // to the same nginx.org annotation would emit duplicate YAML map keys.
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
            pills.push({ cls: 'found', text: totalFindings + ' Traefik item' + (totalFindings !== 1 ? 's' : '') + ' found', scrollTo: null });
            pills.push({ cls: 'paths', text: sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : ''), scrollTo: swaps.length > 0 ? 'analyzer-step-1' : (crdItems.length > 0 ? 'analyzer-step-3' : null) });
            if (crdItems.length > 0) pills.push({ cls: 'crds', text: crdItems.length + ' require CRDs', scrollTo: 'analyzer-step-3' });
            if (unrecognized.length > 0) pills.push({ cls: 'unrecognized', text: unrecognized.length + ' unrecognized', scrollTo: 'analyzer-unrecognized' });

            let liveText = totalFindings + ' Traefik item' + (totalFindings !== 1 ? 's' : '') + ' found, ' + sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : '');
            if (crdItems.length > 0) liveText += ', ' + crdItems.length + ' require CRDs';
            if (unrecognized.length > 0) liveText += ', ' + unrecognized.length + ' unrecognized';

            let stepCount = (swaps.length > 0 ? 1 : 0) + (configMapChanges.length > 0 ? 1 : 0) + (crdItems.length > 0 ? 1 : 0);
            let banner = {
                strongText: totalFindings + ' Traefik items analyzed',
                restText: ', ' + sorted.length + ' migration paths across ' + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + '.',
                complexity: crdItems.length > 0 ? 'advanced' : configMapChanges.length > 0 ? 'moderate' : 'simple'
            };

            let steps = [];

            // Step: Annotation swaps (plain-Ingress annotations + annotation-path middlewares)
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
                        let shortName = (swap.fromKey || swap.fromLabel).replace(TRAEFIK_ANNOTATION_PREFIX, '');
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
                    desc: 'Replace Traefik annotations with their F5 NGINX Ingress Controller equivalents. Copy this annotations block into your Ingress metadata.',
                    blocks: [{
                        type: 'comparison',
                        old: { title: 'Traefik Proxy ', badge: 'current', yaml: oldLines.join('\n') },
                        new: { title: 'F5 NGINX Ingress Controller ', badge: 'migrated', yaml: newLines.join('\n') }
                    }]
                });
            }

            // Step: ConfigMap changes (global settings)
            if (configMapChanges.length > 0) {
                let cmOldLines = ['# Traefik configuration'];
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
                    desc: 'These Traefik settings map to the global NGINX ConfigMap — they apply to every application, not per route. Update your nginx-config ConfigMap with these entries.',
                    blocks: [{
                        type: 'comparison',
                        old: { title: 'Traefik Proxy (current)', badge: null, yaml: cmOldLines.join('\n') },
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
                                old: { title: 'Traefik Proxy (current)', badge: null, yaml: item.oldYaml || '# (source resource not shown)', collapsible: true },
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
                    desc: 'These Traefik features are recognized but have no direct equivalent in the F5 NGINX Ingress Controller. Review each one and take the recommended action.',
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
                    title: 'Unrecognized Traefik Configuration',
                    desc: 'These items were not found in the migration database. They may be custom plugins, Hub features, or not yet mapped.',
                    items: unrecognized.map(function(f) {
                        if (f.key.indexOf('annotation:') === 0) {
                            return { yaml: 'annotations:\n' + formatYamlKV('  ', f.label, f.value) };
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
                    { text: 'Browse all middleware and annotation mappings', anchor: '#mappings' }
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
'apiVersion: traefik.io/v1alpha1\n' +
'kind: IngressRoute\n' +
'metadata:\n' +
'  name: simple-app\n' +
'spec:\n' +
'  entryPoints:\n' +
'    - websecure\n' +
'  routes:\n' +
'    - match: Host(`app.example.com`) && PathPrefix(`/`)\n' +
'      kind: Rule\n' +
'      middlewares:\n' +
'        - name: https-redirect\n' +
'      services:\n' +
'        - name: app-service\n' +
'          port: 80\n' +
'  tls:\n' +
'    secretName: app-tls\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: Middleware\n' +
'metadata:\n' +
'  name: https-redirect\n' +
'spec:\n' +
'  redirectScheme:\n' +
'    scheme: https\n' +
'    permanent: true',
            moderate:
'apiVersion: traefik.io/v1alpha1\n' +
'kind: IngressRoute\n' +
'metadata:\n' +
'  name: production-api\n' +
'spec:\n' +
'  entryPoints:\n' +
'    - websecure\n' +
'  routes:\n' +
'    - match: Host(`api.example.com`) && PathPrefix(`/api`)\n' +
'      kind: Rule\n' +
'      middlewares:\n' +
'        - name: strip-api\n' +
'        - name: api-ratelimit\n' +
'        - name: secure-headers\n' +
'      services:\n' +
'        - name: api-service\n' +
'          port: 8080\n' +
'  tls:\n' +
'    secretName: api-tls\n' +
'    options:\n' +
'      name: modern-tls\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: Middleware\n' +
'metadata:\n' +
'  name: strip-api\n' +
'spec:\n' +
'  stripPrefix:\n' +
'    prefixes:\n' +
'      - /api\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: Middleware\n' +
'metadata:\n' +
'  name: api-ratelimit\n' +
'spec:\n' +
'  rateLimit:\n' +
'    average: 100\n' +
'    burst: 200\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: Middleware\n' +
'metadata:\n' +
'  name: secure-headers\n' +
'spec:\n' +
'  headers:\n' +
'    stsSeconds: 31536000\n' +
'    stsIncludeSubdomains: true\n' +
'    frameDeny: true\n' +
'    contentTypeNosniff: true\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: TLSOption\n' +
'metadata:\n' +
'  name: modern-tls\n' +
'spec:\n' +
'  minVersion: VersionTLS12\n' +
'  cipherSuites:\n' +
'    - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384\n' +
'    - TLS_CHACHA20_POLY1305_SHA256',
            advanced:
'apiVersion: traefik.io/v1alpha1\n' +
'kind: TraefikService\n' +
'metadata:\n' +
'  name: app-canary\n' +
'spec:\n' +
'  weighted:\n' +
'    services:\n' +
'      - name: app-stable\n' +
'        port: 80\n' +
'        weight: 90\n' +
'      - name: app-canary\n' +
'        port: 80\n' +
'        weight: 10\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: IngressRoute\n' +
'metadata:\n' +
'  name: enterprise-app\n' +
'spec:\n' +
'  entryPoints:\n' +
'    - websecure\n' +
'  routes:\n' +
'    - match: Host(`secure.example.com`) && PathPrefix(`/`)\n' +
'      kind: Rule\n' +
'      middlewares:\n' +
'        - name: auth-forward\n' +
'        - name: office-ips\n' +
'      services:\n' +
'        - name: app-canary\n' +
'          kind: TraefikService\n' +
'  tls:\n' +
'    secretName: enterprise-tls\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: Middleware\n' +
'metadata:\n' +
'  name: auth-forward\n' +
'spec:\n' +
'  forwardAuth:\n' +
'    address: http://oauth2-proxy.auth.svc.cluster.local/oauth2/auth\n' +
'    authResponseHeaders:\n' +
'      - X-Auth-User\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: Middleware\n' +
'metadata:\n' +
'  name: office-ips\n' +
'spec:\n' +
'  ipAllowList:\n' +
'    sourceRange:\n' +
'      - 10.0.0.0/8\n' +
'      - 192.168.1.0/24\n' +
'---\n' +
'apiVersion: traefik.io/v1alpha1\n' +
'kind: IngressRouteTCP\n' +
'metadata:\n' +
'  name: mqtt-passthrough\n' +
'spec:\n' +
'  entryPoints:\n' +
'    - mqtt-secure\n' +
'  routes:\n' +
'    - match: HostSNI(`mqtt.example.com`)\n' +
'      services:\n' +
'        - name: mqtt-broker\n' +
'          port: 8883\n' +
'  tls:\n' +
'    passthrough: true'
        };

        // --- Source config consumed by migration-core.js ---
        window.MIGRATION_SOURCE = {
            id: 'traefik',
            strings: {
                analyzeEmpty: { title: 'No input.', message: 'Paste Traefik resources (IngressRoute, Middleware, TraefikService, …) or an annotated Ingress to analyze.' },
                noFindings: { title: 'No Traefik configuration found.', message: 'Make sure your YAML contains Traefik CRDs (IngressRoute, Middleware, TraefikService, …) or Ingress annotations with the traefik.ingress.kubernetes.io/ prefix.' },
                emptyStateLead: 'Paste your Traefik YAML above and click Analyze',
                emptyStateHint: 'Drag & drop a .yaml file, or try "Load Sample" for an example',
                pageNames: { 'getting-started': 'Getting Started', analyzer: 'Config Analyzer', reference: 'Reference Guide' }
            },
            versionBindings: [
                { attr: 'data-traefik-version', text: TRAEFIK_VERSION },
                { attr: 'data-traefik-release-link', href: TRAEFIK_RELEASE_URL }
            ],
            inputStatus: { pattern: /traefik\.ingress\.kubernetes\.io\/|kind:\s*(?:IngressRouteTCP|IngressRouteUDP|IngressRoute|MiddlewareTCP|Middleware|TraefikService|TLSOption|TLSStore|ServersTransportTCP|ServersTransport)\b/g, noun: 'Traefik item' },
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
            storage: { checklist: 'traefikMigrationChecklist' },
            analyzer: {
                strategies: {
                    initial: 'crd',
                    descriptions: {
                        annotation: 'Swap Ingress annotations where possible, use CRDs only when needed',
                        crd: 'Prefer Policy CRDs and VirtualServer — Traefik CRDs always convert to NIC CRDs'
                    }
                },
                samplePresets: SAMPLE_PRESETS,
                defaultPreset: 'moderate',
                parseInput: parseInput,
                buildPlan: buildPlan
            },
            export: {
                filename: 'traefik-nginx-migration.yaml',
                header: '# Traefik to NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/traefik-migration.html'
            }
        };
    })();
