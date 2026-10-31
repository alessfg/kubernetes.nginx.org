    /* migration-traefik.js — the Traefik SOURCE module for the migration tool.
       Defines window.MIGRATION_SOURCE: the Traefik version, the mapping data,
       the analyzer (parseInput / buildPlan, and migrate / migrateMany for
       nic-migrate) and the page strings the shared engine (migration-core.js)
       reads. Load order matters: shared.js → this file → migration-core.js.
       This file must not touch the DOM — the core owns all rendering — and it
       dereferences MigrationTool.* at call time only (the core defines it
       after this file has run).

       The analyzer works on the whole run, as the ingress-nginx and HAProxy
       modules do: every document is parsed with MigrationTool.yaml, each
       IngressRoute and annotated Ingress is resolved against the Middlewares,
       TraefikServices, TLSOptions and Services beside it, translators write
       fragments, and the assembler builds one VirtualServer per host (several
       IngressRoutes on one host merge into it) or, for an annotated Ingress
       under annotation-first, the migrated Ingress. Every value is read the way
       Traefik reads it (paerser: strconv.ParseBool, ParseInt, types.Duration),
       and a middleware Traefik would refuse to build fails its whole router:
       the route served 404, so nothing is migrated for it.

       TRAEFIK_VERSION is the single source of truth for the Traefik side of the
       Version Reference banners (the NGINX Ingress Controller side lives in
       MigrationTool.NIC in migration-core.js). */
    (function() {
        'use strict';
        // Bump when updating the Version Reference (the release-update skill).
        const TRAEFIK_VERSION = 'v3.7.17';
        const TRAEFIK_RELEASE_URL = 'https://github.com/traefik/traefik/releases/tag/' + TRAEFIK_VERSION;

        // The reference sections an unsupported card's "See Reference Guide"
        // opens; anything unrecognised falls back to the OSS table.
        const SECTION_IDS = { oss: 'mappings', plus: 'plus-mappings', configmap: 'configmap-mappings' };
        function sectionIdFor(mapping) { return SECTION_IDS[mapping && mapping.section] || 'mappings'; }

        let NIC_API = 'k8s.nginx.org/v1';
        function isMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
        function str(v) { return v === null || v === undefined ? '' : String(v); }
        function list(v) { return Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]); }
        function cmt(v) { return str(v).replace(/[\r\n]+/g, ' '); }
        function dnsName(s, fallback) {
            let n = str(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
            return n || fallback || 'app';
        }

        // --- Values as Traefik reads them (v3.7.17) ----------------------------
        // CRD fields arrive typed from the API server (a bool is a bool), but an
        // Ingress or Service annotation is a string that github.com/traefik/paerser
        // decodes: strconv.ParseBool, strconv.ParseInt, and types.Duration (a bare
        // integer is seconds, anything else time.ParseDuration). A value paerser
        // cannot decode fails the whole annotation set (parseRouterConfig /
        // parseServiceConfig), so the readers return null and the caller decides.
        let GO_TRUE = /^(1|t|T|TRUE|true|True)$/, GO_FALSE = /^(0|f|F|FALSE|false|False)$/;
        function goBool(v) {
            if (v === true || v === false) return v;
            let s = str(v);
            if (GO_TRUE.test(s)) return true;
            if (GO_FALSE.test(s)) return false;
            return null;
        }
        function goInt(v) {
            if (typeof v === 'number') return Number.isInteger(v) ? v : null;
            let s = str(v);
            return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : null;
        }
        // time.ParseDuration: a sequence of decimal numbers with units ns, us,
        // \u00b5s, \u03bcs, ms, s, m, h ("1m30s", "1.5h", "300ms"); types.Duration adds a
        // bare integer as seconds. Returns seconds (a float), or null.
        let GO_UNITS = { ns: 1e-9, us: 1e-6, '\u00b5s': 1e-6, '\u03bcs': 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
        function goDurationSeconds(v) {
            if (typeof v === 'number') return Number.isInteger(v) ? v : null;
            let s = str(v).trim();
            if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
            let m = s.match(/^([-+]?)((?:\d*\.?\d+(?:ns|us|\u00b5s|\u03bcs|ms|s|m|h))+)$/);
            if (!m) return s === '0' ? 0 : null;
            let total = 0;
            m[2].replace(/(\d*\.?\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/g, function(_, n, u) { total += parseFloat(n) * GO_UNITS[u]; return ''; });
            return m[1] === '-' ? -total : total;
        }
        // Seconds as an NGINX time, compound as NGINX Ingress Controller's
        // ParseTime takes it (\d+h \d+m \d+s \d+ms, whole numbers only): 90 → 1m30s.
        function nginxTime(secs) {
            if (secs === null || secs === undefined || secs < 0) return null;
            let ms = Math.round(secs * 1000);
            if (ms === 0) return '0s';
            let out = '';
            [['h', 3600000], ['m', 60000], ['s', 1000], ['ms', 1]].forEach(function(u) {
                let n = Math.floor(ms / u[1]);
                if (n) { out += n + u[0]; ms -= n * u[1]; }
            });
            return out;
        }
        // A byte count as an NGINX size ("1048576" → "1m").
        function nginxSize(n) {
            let v = goInt(n);
            if (v === null || v <= 0) return null;
            if (v % 1048576 === 0) return (v / 1048576) + 'm';
            if (v % 1024 === 0) return (v / 1024) + 'k';
            return String(v);
        }
        // An IPv4/IPv6 address or CIDR, as ip.NewChecker parses them
        // (net.ParseCIDR, else net.ParseIP).
        function isAddress(s) {
            let m = str(s).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
            if (m) return [m[1], m[2], m[3], m[4]].every(function(o) { return +o <= 255; }) && (m[5] === undefined || +m[5] <= 32);
            let v6 = str(s).match(/^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/);
            return !!v6 && v6[1].indexOf(':') !== -1 && (v6[2] === undefined || +v6[2] <= 128) && (v6[1].match(/::/g) || []).length <= 1;
        }
        // An HTTP status code net/http knows (http.StatusText is non-empty).
        let KNOWN_STATUS = [100, 101, 102, 103, 200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305, 307, 308,
            400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429,
            431, 451, 500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511];
        // Traefik status lists ("500", "500-504", lists, comma lists) as codes;
        // null when an entry does not parse (types.NewHTTPCodeRanges errors).
        function statusCodes(status, cap) {
            let out = [];
            let ok = true;
            list(status).forEach(function(s) {
                str(s).split(',').forEach(function(part) {
                    part = part.trim();
                    if (!part) return;
                    let range = part.match(/^(\d{3})-(\d{3})$/);
                    if (range) {
                        let from = +range[1], to = +range[2];
                        if (from > to) { ok = false; return; }
                        for (let c = from; c <= to && out.length < (cap || 1000); c++) out.push(c);
                    } else if (/^\d{3}$/.test(part)) out.push(+part);
                    else ok = false;
                });
            });
            return ok ? out : null;
        }
        // A header value NGINX Ingress Controller's annotations cannot carry:
        // add-header and proxy-set-headers split on a comma and read a colon as
        // a separator, so such a value needs the VirtualServer form.
        function annotationSafe(v) { return !/[,:"$\n]/.test(str(v)); }
        function cookieNameOk(n) { return /^[_A-Za-z0-9]+$/.test(str(n)); }
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

        // --- Input: the run as Traefik reads it --------------------------------
        // Two providers feed Traefik here. The CRD provider reads IngressRoute
        // (one router per route), Middleware, TraefikService, TLSOption, TLSStore,
        // ServersTransport and their TCP/UDP siblings, all under traefik.io (or
        // the Traefik v2 group traefik.containo.us). The Ingress provider reads a
        // Kubernetes Ingress: router.* annotations from the Ingress itself
        // (parseRouterConfig), service.* annotations from the Kubernetes Service
        // its backend names (parseServiceConfig(service.Annotations),
        // kubernetes.go) — on an Ingress, a service.* annotation does nothing.

        const TRAEFIK_ANNOTATION_PREFIX = 'traefik.ingress.kubernetes.io/';
        const TRAEFIK_CRD_API = /^traefik\.(io|containo\.us)\//;
        const TRAEFIK_KINDS = { IngressRoute: true, IngressRouteTCP: true, IngressRouteUDP: true, Middleware: true, MiddlewareTCP: true,
            TraefikService: true, TLSOption: true, TLSStore: true, ServersTransport: true, ServersTransportTCP: true };

        // Traefik annotations by suffix. The numbered TLS-domain annotations
        // share one mapping row (router.tls.domains.0.main → .n.main).
        function traefikAnnotations(md) {
            let out = {};
            let ann = isMap(md && md.annotations) ? md.annotations : {};
            Object.keys(ann).forEach(function(k) {
                if (k.indexOf(TRAEFIK_ANNOTATION_PREFIX) !== 0) return;
                let suffix = k.slice(TRAEFIK_ANNOTATION_PREFIX.length);
                out[suffix] = { value: str(ann[k]), key: k, lookup: suffix.replace(/^router\.tls\.domains\.\d+\./, 'router.tls.domains.n.') };
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
            let tlsByHost = {};
            list(spec.tls).filter(isMap).forEach(function(t) {
                list(t.hosts).forEach(function(h) { tlsByHost[str(h)] = t.secretName ? str(t.secretName) : ''; });
            });
            let hosts = [];
            let hostless = [];
            list(spec.rules).filter(isMap).forEach(function(r) {
                let paths = list(isMap(r.http) ? r.http.paths : null).filter(isMap).map(function(p) {
                    return { path: p.path ? str(p.path) : '/', pathType: p.pathType ? str(p.pathType) : 'ImplementationSpecific', backend: backendOf(p.backend) };
                });
                if (!r.host) { hostless.push.apply(hostless, paths); return; }
                let host = str(r.host);
                let existing = hosts.find(function(h) { return h.host === host; });
                if (existing) existing.paths = existing.paths.concat(paths);
                else hosts.push({ host: host, paths: paths, tlsSecret: Object.prototype.hasOwnProperty.call(tlsByHost, host) ? tlsByHost[host] : null });
            });
            let ann = isMap(md.annotations) ? md.annotations : {};
            return {
                kind: 'Ingress',
                name: md.name ? str(md.name) : null,
                namespace: md.namespace ? str(md.namespace) : null,
                apiVersion: str(doc.apiVersion),
                ingressClassName: spec.ingressClassName ? str(spec.ingressClassName) : (ann['kubernetes.io/ingress.class'] ? str(ann['kubernetes.io/ingress.class']) : null),
                traefik: traefikAnnotations(md),
                defaultBackend: backendOf(spec.defaultBackend || spec.backend),
                hosts: hosts,
                hostless: hostless,
                tls: list(spec.tls).filter(isMap),
                doc: doc
            };
        }

        // A middleware reference as the CRD provider resolves it (makeMiddlewareKeys):
        // a name, in the route's namespace unless the reference names another.
        // "name@provider" points outside the CRD provider (a file-provider middleware).
        function mwRef(ref, namespace) {
            let name = isMap(ref) ? str(ref.name) : str(ref);
            let ns = isMap(ref) && ref.namespace ? str(ref.namespace) : namespace;
            let at = name.indexOf('@');
            return { name: at === -1 ? name : name.slice(0, at), provider: at === -1 ? null : name.slice(at + 1), namespace: ns || null, raw: name };
        }

        function routeModel(r, namespace) {
            r = isMap(r) ? r : {};
            return {
                match: str(r.match),
                kind: r.kind === undefined ? 'Rule' : str(r.kind),
                priority: goInt(r.priority),
                facts: r.match ? parseMatchSafe(str(r.match)) : null,
                middlewares: list(r.middlewares).map(function(m) { return mwRef(m, namespace); }),
                services: list(r.services).filter(isMap)
            };
        }

        function crModel(doc, docIndex) {
            let md = isMap(doc.metadata) ? doc.metadata : {};
            let kind = str(doc.kind);
            let ns = md.namespace ? str(md.namespace) : null;
            let spec = isMap(doc.spec) ? doc.spec : {};
            let m = { kind: kind, name: md.name ? str(md.name) : kind.toLowerCase() + '-' + (docIndex + 1), namespace: ns, spec: spec, v2: /^traefik\.containo\.us\//.test(str(doc.apiVersion)), doc: doc };
            if (kind === 'IngressRoute' || kind === 'IngressRouteTCP' || kind === 'IngressRouteUDP') {
                m.entryPoints = list(spec.entryPoints).map(str);
                m.routes = list(spec.routes).map(function(r) { return routeModel(r, ns); });
                m.tls = isMap(spec.tls) ? spec.tls : null;
                m.ingressClassName = spec.ingressClassName ? str(spec.ingressClassName) : null;
            }
            if (kind === 'Middleware' || kind === 'MiddlewareTCP') {
                // A Middleware holds exactly one type; more than one is a CRD
                // error the API server would refuse, so the first is read.
                let types = Object.keys(spec).filter(function(k) { return spec[k] !== null && spec[k] !== undefined; });
                m.type = types[0] || null;
                m.extraTypes = types.slice(1);
                m.options = m.type && isMap(spec[m.type]) ? spec[m.type] : (m.type ? {} : null);
            }
            return m;
        }

        function emptyRun() {
            return { ingressRoutes: [], ingressRoutesTCP: [], ingressRoutesUDP: [], ingresses: [], middlewares: [], middlewaresTCP: [],
                traefikServices: [], tlsOptions: [], tlsStores: [], serversTransports: [], serversTransportsTCP: [], services: [], unknown: [], skipped: {} };
        }
        let KIND_BUCKET = { IngressRoute: 'ingressRoutes', IngressRouteTCP: 'ingressRoutesTCP', IngressRouteUDP: 'ingressRoutesUDP', Middleware: 'middlewares',
            MiddlewareTCP: 'middlewaresTCP', TraefikService: 'traefikServices', TLSOption: 'tlsOptions', TLSStore: 'tlsStores',
            ServersTransport: 'serversTransports', ServersTransportTCP: 'serversTransportsTCP' };

        function addToRun(run, doc, docIndex) {
            if (!isMap(doc) || !doc.kind) return;
            let kind = str(doc.kind);
            if (kind === 'Ingress') { run.ingresses.push(ingressModel(doc)); return; }
            if (kind === 'Service') {
                let md = isMap(doc.metadata) ? doc.metadata : {};
                run.services.push({ name: str(md.name), namespace: md.namespace ? str(md.namespace) : null, traefik: traefikAnnotations(md),
                    type: isMap(doc.spec) ? str(doc.spec.type) : '', ports: list(isMap(doc.spec) ? doc.spec.ports : null).filter(isMap), doc: doc });
                return;
            }
            if (TRAEFIK_CRD_API.test(str(doc.apiVersion))) {
                if (KIND_BUCKET[kind]) run[KIND_BUCKET[kind]].push(crModel(doc, docIndex));
                else run.unknown.push(crModel(doc, docIndex));
                return;
            }
            run.skipped[kind] = (run.skipped[kind] || 0) + 1;
        }
        function runOf(docs) {
            let run = emptyRun();
            docs.forEach(function(doc, i) { addToRun(run, doc, i); });
            return run;
        }

        function findService(run, namespace, name) {
            return run.services.find(function(s) { return s.name === name && (s.namespace || null) === (namespace || null); })
                || run.services.find(function(s) { return s.name === name && (!s.namespace || !namespace); }) || null;
        }
        function findNamed(listOf, name, namespace) {
            return listOf.find(function(x) { return x.name === name && (!namespace || !x.namespace || x.namespace === namespace); }) || null;
        }

        function parseInput(yamlText) {
            let run = emptyRun();
            let warnings = [];
            let errors = [];
            MigrationTool.yaml.parseDocuments(yamlText).forEach(function(d, docIndex) {
                if (d.error) { errors.push(d.error); return; }
                let items = isMap(d.value) && Array.isArray(d.value.items) && /List$/.test(str(d.value.kind)) ? d.value.items : [d.value];
                items.forEach(function(doc) { addToRun(run, doc, docIndex); });
            });
            errors.forEach(function(e) { warnings.push({ title: 'Could not parse part of the input', message: e + '. That document was skipped; fix it and analyze again.' }); });
            let all = [].concat(run.ingressRoutes, run.ingressRoutesTCP, run.ingressRoutesUDP, run.middlewares, run.middlewaresTCP, run.traefikServices,
                run.tlsOptions, run.tlsStores, run.serversTransports, run.serversTransportsTCP, run.unknown);
            if (all.some(function(c) { return c.v2; })) {
                warnings.push({ title: 'Traefik v2 apiVersion detected', message: 'Resources using `traefik.containo.us/v1alpha1` were read as Traefik v3 resources. Check renamed options (ipWhiteList → ipAllowList) and the v3 rule syntax before migrating.' });
            }
            // Findings: one per Traefik setting the run carries, so the summary
            // counts what the reader pasted.
            let findings = [];
            let add = function(key, label, value, where) { findings.push({ key: key, label: label, value: value, where: where }); };
            run.ingresses.forEach(function(m) { Object.keys(m.traefik).forEach(function(k) { add('annotation:' + m.traefik[k].lookup, m.traefik[k].key, m.traefik[k].value, 'Ingress ' + (m.name || '')); }); });
            run.services.forEach(function(s) { Object.keys(s.traefik).forEach(function(k) { add('annotation:' + s.traefik[k].lookup, s.traefik[k].key, s.traefik[k].value, 'Service ' + s.name); }); });
            run.middlewares.forEach(function(m) { if (m.type) add('middleware:' + m.type, 'Middleware ' + m.name + ' (' + m.type + ')', '', 'Middleware ' + m.name); });
            run.middlewaresTCP.forEach(function(m) { if (m.type) add('middlewaretcp:' + m.type, 'MiddlewareTCP ' + m.name + ' (' + m.type + ')', '', 'MiddlewareTCP ' + m.name); });
            run.traefikServices.forEach(function(t) {
                ['weighted', 'mirroring', 'failover', 'highestRandomWeight'].forEach(function(k) { if (t.spec[k] !== undefined) add('traefikservice:' + k, 'TraefikService ' + t.name + ' (' + k + ')', '', 'TraefikService ' + t.name); });
            });
            [['ingressRoutes', 'IngressRoute'], ['ingressRoutesTCP', 'IngressRouteTCP'], ['ingressRoutesUDP', 'IngressRouteUDP'], ['tlsOptions', 'TLSOption'],
                ['tlsStores', 'TLSStore'], ['serversTransports', 'ServersTransport'], ['serversTransportsTCP', 'ServersTransportTCP']].forEach(function(p) {
                run[p[0]].forEach(function(c) { add('kind:' + p[1], p[1] + ' ' + c.name, '', p[1] + ' ' + c.name); });
            });
            run.unknown.forEach(function(c) { add('kind:' + c.kind, c.kind + ' ' + c.name, '', c.kind + ' ' + c.name); });
            if (run.services.some(function(s) { return Object.keys(s.traefik).length; })) {
                warnings.push({ title: 'Service annotations detected', message: 'Traefik reads its service.* annotations from the Service an Ingress routes to, not from the Ingress; NGINX Ingress Controller reads none from Services. Each one is applied to the routes that reach that Service in the migrated resources.' });
            }
            let empty = null;
            let skippedKinds = Object.keys(run.skipped);
            if (!findings.length && !run.ingresses.length) {
                if (errors.length && !skippedKinds.length) empty = { title: 'The YAML could not be parsed.', message: errors[0] + '.' };
                else if (skippedKinds.length) empty = { title: 'No Traefik configuration found.', message: 'The input holds ' + skippedKinds.map(function(k) { return run.skipped[k] + ' ' + k; }).join(', ') + '. Paste IngressRoutes, Middlewares and the other traefik.io resources, or an Ingress with traefik.ingress.kubernetes.io/ annotations and the Services it routes to.' };
            }
            return { findings: findings, ingresses: run.ingresses, run: run, warnings: warnings, foundCount: findings.length, skipped: run.skipped, empty: empty };
        }

        // --- Middlewares Traefik refuses to build -------------------------------
        // A middleware whose New() returns an error fails its whole router
        // (pkg/server/router/router.go: buildRouterHandler → AddError,
        // continue): the rule's traffic falls through to the entry point's
        // default handler, 404. So a route carrying one served nothing, and is
        // migrated as nothing, with the reason. Each check below is the
        // middleware's own New() at v3.7.17. A RE2 regex is checked with the
        // browser's engine, which accepts a superset; a pattern RE2 refuses
        // (lookarounds, backreferences) is caught by the RE2_ONLY test.
        let RE2_REFUSES = /\(\?[=!<]|\\[1-9]|\(\?P?<[A-Za-z]/;
        function badRegex(re) {
            if (RE2_REFUSES.test(str(re))) return 'uses a lookaround or backreference, which Traefik\'s RE2 refuses';
            try { new RegExp(str(re)); return null; } catch (e) { return 'is not a valid regular expression'; }
        }
        let REFUSED = {
            addPrefix: function(o) { return str(o.prefix) ? null : 'prefix is empty'; },
            basicAuth: function(o) { return list(o.users).length || o.secret || o.usersFile ? null : 'has no users (users, secret or usersFile)'; },
            digestAuth: function(o) { return list(o.users).length || o.secret || o.usersFile ? null : 'has no users'; },
            compress: function(o) {
                if (list(o.excludedContentTypes).length && list(o.includedContentTypes).length) return 'sets excludedContentTypes and includedContentTypes, which are mutually exclusive';
                if (o.encodings !== undefined && !list(o.encodings).length) return 'lists no encoding';
                let bad = list(o.encodings).filter(function(e) { return ['gzip', 'br', 'zstd', 'identity'].indexOf(str(e)) === -1; });
                return bad.length ? 'names an unsupported encoding (' + bad.join(', ') + ')' : null;
            },
            errors: function(o) { return statusCodes(o.status) === null ? 'has a status entry that is not a code or range' : (o.service ? null : 'names no service'); },
            // An empty address builds (NewForward does not check it); only a bad
            // authResponseHeadersRegex is refused.
            forwardAuth: function(o) { return o.authResponseHeadersRegex ? badRegex(o.authResponseHeadersRegex) && 'authResponseHeadersRegex ' + badRegex(o.authResponseHeadersRegex) : null; },
            headers: function(o) { return Object.keys(o).some(function(k) { let v = o[k]; return v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length) && !(isMap(v) && !Object.keys(v).length); }) ? null : 'sets no header (headers configuration not valid)'; },
            ipAllowList: function(o) {
                let ranges = list(o.sourceRange);
                if (!ranges.length) return 'has an empty sourceRange';
                let bad = ranges.filter(function(r) { return !isAddress(r); });
                if (bad.length) return 'has "' + bad.join('", "') + '" in sourceRange, which is not an IP address or CIDR';
                if (o.rejectStatusCode !== undefined && KNOWN_STATUS.indexOf(goInt(o.rejectStatusCode)) === -1 && goInt(o.rejectStatusCode) !== 0) return 'has rejectStatusCode ' + o.rejectStatusCode + ', not an HTTP status';
                return null;
            },
            ipWhiteList: function(o) { return REFUSED.ipAllowList(o); },
            rateLimit: function(o) {
                let p = o.period === undefined ? 0 : goDurationSeconds(o.period);
                if (p === null) return 'has a period that is not a duration';
                return p < 0 ? 'has a negative period' : null;
            },
            redirectRegex: function(o) { return badRegex(o.regex) && 'regex ' + badRegex(o.regex); },
            redirectScheme: function(o) { return str(o.scheme) ? null : 'names no target scheme'; },
            replacePathRegex: function(o) { return badRegex(o.regex) && 'regex ' + badRegex(o.regex); },
            retry: function(o) {
                let n = goInt(o.attempts);
                if (n === null || n <= 0) return 'has attempts ' + (o.attempts === undefined ? 'unset' : o.attempts) + '; Traefik needs at least 1';
                if (o.disableRetryOnNetworkError === true && !list(o.status).length) return 'retries on neither network errors nor status codes';
                if (o.status !== undefined && statusCodes(o.status) === null) return 'has a status entry that is not a code or range';
                return null;
            },
            stripPrefixRegex: function(o) { let bad = list(o.regex).map(badRegex).filter(Boolean); return bad.length ? 'regex ' + bad[0] : null; }
        };
        function refusedBecause(mw) {
            if (!mw || !mw.type) return null;
            let check = REFUSED[mw.type];
            return check ? check(isMap(mw.options) ? mw.options : {}) : null;
        }

        // --- Translators -------------------------------------------------------
        // One per middleware type. Each reads one Middleware's options and writes
        // fragments onto f, the bundle the assembler places on every route that
        // lists the middleware (Traefik applies a middleware to the routers that
        // name it, in list order):
        //   f.upstream[field]   VirtualServer upstream field for the route's upstreams
        //   f.proxy             route action.proxy fields (requestHeaders, responseHeaders, rewritePath)
        //   f.redirect          { url, code } — the route redirects instead of proxying
        //   f.errorPages        routes[].errorPages entries
        //   f.location          location-snippets lines
        //   f.policies          [{ name, spec, ingress: 'nginx.org/policies'|'nginx.com/policies'|null, comments, plus }]
        //   f.ann               nginx.org/* annotation for the migrated Ingress (annotation-first)
        //   f.http              ConfigMap http-snippets lines (global)
        //   f.cm                ConfigMap keys (global)
        // ctx.note(code, message, severity) explains; ctx.todo(path, message) asks.

        function cm(f, key, value, source) { f.cm[key] = { value: String(value), source: source }; }
        function header(name, value) { return { name: str(name), value: str(value) }; }
        let CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'];
        let CORS_FORBIDDEN_HEADER = /^(cookie|host|origin|connection|referer|set-cookie|proxy-.*|sec-.*)$/i;

        let TRANSLATORS = {
            addPrefix: function(o, f, ctx, mw) {
                // Traefik prepends the prefix to the whole path; a regex route
                // capturing the path rewrites it as prefix + path.
                f.rewrite = { kind: 'addPrefix', prefix: str(o.prefix), source: mw.label };
            },

            basicAuth: function(o, f, ctx, mw) {
                let secret = str(o.secret);
                if (!secret) ctx.todo(mw.label, 'a Secret of type nginx.org/htpasswd: Traefik read the users inline or from usersFile, which NGINX Ingress Controller cannot');
                f.policies.push({ name: dnsName(mw.name + '-basic-auth'), spec: { basicAuth: { secret: secret || 'htpasswd-secret', realm: str(o.realm) || 'traefik' } }, ingress: null,
                    comments: { 'spec.basicAuth.secret': mw.label + ' secret — re-create as type nginx.org/htpasswd, key htpasswd', 'spec.basicAuth.realm': mw.label + (o.realm ? ' realm' : ' — Traefik\'s default realm') } });
                f.ann['nginx.org/basic-auth-secret'] = { value: secret || 'htpasswd-secret', source: mw.label };
                f.ann['nginx.org/basic-auth-realm'] = { value: str(o.realm) || 'traefik', source: mw.label };
                ctx.note(mw.label, 'Traefik\'s basicAuth Secret (type kubernetes.io/basic-auth, or a users list) becomes a Secret of type nginx.org/htpasswd with the file under the key htpasswd.');
                if (o.headerField || o.removeHeader) ctx.note(mw.label, 'headerField and removeHeader have no NGINX Ingress Controller equivalent: the user name is not forwarded, and the Authorization header reaches the backend.', 'warning');
            },

            buffering: function(o, f, ctx, mw) {
                let max = nginxSize(o.maxRequestBodyBytes);
                let mem = nginxSize(o.memRequestBodyBytes);
                if (max) { f.upstream['client-max-body-size'] = { value: max, source: mw.label + ' maxRequestBodyBytes' }; f.ann['nginx.org/client-max-body-size'] = { value: max, source: mw.label }; }
                if (mem) f.upstream['client-body-buffer-size'] = { value: mem, source: mw.label + ' memRequestBodyBytes' };
                if (o.maxResponseBodyBytes !== undefined || o.memResponseBodyBytes !== undefined) ctx.note(mw.label, 'NGINX has no response-body cap: maxResponseBodyBytes and memResponseBodyBytes are not migrated (tune proxy buffering instead).', 'warning');
                if (o.retryExpression) ctx.note(mw.label, 'retryExpression has no equivalent; next-upstream conditions are the nearest.', 'warning');
                if (!max && !mem && o.maxResponseBodyBytes === undefined && o.memResponseBodyBytes === undefined && !o.retryExpression) ctx.note(mw.label, 'Sets no limit, so Traefik buffered with its defaults; NGINX buffers request bodies by default. Nothing to migrate.');
            },

            circuitBreaker: function(o, f, ctx, mw) {
                let ft = o.fallbackDuration === undefined ? 10 : goDurationSeconds(o.fallbackDuration);
                f.upstream['max-fails'] = { value: 3, source: mw.label + ' — passive stand-in for expression "' + cmt(o.expression) + '"' };
                f.upstream['fail-timeout'] = { value: nginxTime(ft === null ? 10 : ft) || '10s', source: mw.label + ' fallbackDuration' };
                ctx.note(mw.label, 'NGINX Ingress Controller has no expression-based circuit breaker: the expression "' + cmt(o.expression) + '" becomes passive failure counting (max-fails 3 within fail-timeout). Active health checks are NGINX Plus (upstreams[].healthCheck).', 'warning');
            },

            compress: function(o, f, ctx, mw) {
                let min = o.minResponseBodyBytes === undefined ? 1024 : goInt(o.minResponseBodyBytes);
                f.http.push('gzip on;', 'gzip_min_length ' + (min === null ? 1024 : min) + ';', 'gzip_proxied any;',
                    'gzip_types ' + (list(o.includedContentTypes).length ? list(o.includedContentTypes).join(' ') : 'text/plain text/css application/json application/javascript text/xml application/xml') + ';');
                f.httpSource = mw.label;
                ctx.note(mw.label, 'NGINX Ingress Controller has no compression key, so gzip is http-snippets (global, every resource). Brotli and zstd need modules the image does not ship.' + (list(o.excludedContentTypes).length ? ' excludedContentTypes has no gzip form; gzip_types lists what to compress instead.' : ''), 'warning');
            },

            contentType: function(o, f, ctx, mw) { ctx.note(mw.label, 'NGINX passes Content-Type through and never sniffs it: nothing to migrate.'); },

            errors: function(o, f, ctx, mw) {
                let codes = statusCodes(o.status, 400) || [];
                f.errors = { codes: codes, service: isMap(o.service) ? o.service : { name: str(o.service) }, query: str(o.query), source: mw.label };
                if (o.statusRewrites) ctx.note(mw.label, 'statusRewrites has no equivalent: NGINX Ingress Controller keeps the original status.', 'warning');
            },

            forwardAuth: function(o, f, ctx, mw) {
                let addr = str(o.address).match(/^(https?):\/\/([^\/:]+)(?::(\d+))?(\/[^\s]*)?$/);
                let spec = { authURI: '/' };
                let comments = {};
                if (addr) {
                    let parts = addr[2].split('.');
                    let inCluster = parts.length === 1 || parts.indexOf('svc') !== -1;
                    spec.authServiceName = parts.length >= 2 && parts.indexOf('svc') !== -1 ? parts[1] + '/' + parts[0] : parts[0];
                    if (addr[3]) spec.authServicePorts = [parseInt(addr[3], 10)];
                    if (addr[4]) spec.authURI = addr[4];
                    if (addr[1] === 'https') spec.sslEnabled = true;
                    comments['spec.externalAuth.authServiceName'] = mw.label + ' address';
                    if (!inCluster) ctx.note(mw.label, 'The address ' + addr[2] + ' is not a cluster Service; externalAuth reaches a Service only. Put a Service of type ExternalName in front of it.', 'warning');
                } else {
                    spec.authServiceName = 'auth-service';
                    ctx.todo(mw.label, 'the auth Service: address "' + cmt(o.address) + '" is not an http(s) URL');
                }
                if (o.authSigninURL) { spec.authSigninURI = str(o.authSigninURL).replace(/^https?:\/\/[^\/]+/, '') || '/'; comments['spec.externalAuth.authSigninURI'] = mw.label + ' authSigninURL — a path: NGINX Ingress Controller signs in on the same host'; }
                if (isMap(o.tls) && (o.tls.caSecret || o.tls.ca)) { spec.sslVerify = true; spec.trustedCertSecret = str(o.tls.caSecret) || 'auth-ca'; comments['spec.externalAuth.trustedCertSecret'] = mw.label + ' tls.caSecret — type nginx.org/ca'; }
                f.policies.push({ name: dnsName(mw.name + '-external-auth'), spec: { externalAuth: spec }, ingress: 'nginx.org/policies', comments: comments });
                let lost = [];
                if (list(o.authResponseHeaders).length || o.authResponseHeadersRegex) lost.push('authResponseHeaders (the auth response headers are not copied to the backend request; authSnippets with auth_request_set and proxy_set_header can)');
                if (o.addAuthCookiesToResponse) lost.push('addAuthCookiesToResponse');
                if (list(o.authRequestHeaders).length) lost.push('authRequestHeaders (every client header is forwarded)');
                if (o.forwardBody) lost.push('forwardBody (the body is never sent to the auth service)');
                if (o.trustForwardHeader) lost.push('trustForwardHeader');
                if (isMap(o.tls) && (o.tls.certSecret || o.tls.cert)) lost.push('tls.certSecret (no client certificate is presented to the auth service)');
                if (o.headerField) lost.push('headerField');
                if (lost.length) ctx.note(mw.label, 'No NGINX Ingress Controller equivalent for: ' + lost.join('; ') + '.', 'warning');
            },

            grpcWeb: function(o, f, ctx, mw) { ctx.note(mw.label, 'NGINX Ingress Controller does not translate gRPC-Web to gRPC; keep a gRPC-Web proxy (such as Envoy) in front of the Service.', 'warning'); },

            headers: function(o, f, ctx, mw) {
                let req = isMap(o.customRequestHeaders) ? o.customRequestHeaders : {};
                let res = isMap(o.customResponseHeaders) ? o.customResponseHeaders : {};
                // Traefik: an empty value removes the header.
                Object.keys(req).forEach(function(h) { f.reqSet.push({ h: header(h, req[h]), source: mw.label + ' customRequestHeaders' }); });
                Object.keys(res).forEach(function(h) {
                    if (str(res[h]) === '') f.resHide.push({ name: h, source: mw.label + ' customResponseHeaders (empty: removed)' });
                    else f.resAdd.push({ h: header(h, res[h]), source: mw.label + ' customResponseHeaders' });
                });
                // The security headers Traefik builds (secure.New), each as a response header.
                let sec = [];
                if (o.frameDeny === true) sec.push(header('X-Frame-Options', 'DENY'));
                else if (o.customFrameOptionsValue) sec.push(header('X-Frame-Options', o.customFrameOptionsValue));
                if (o.contentTypeNosniff === true) sec.push(header('X-Content-Type-Options', 'nosniff'));
                if (o.customBrowserXSSValue) sec.push(header('X-XSS-Protection', o.customBrowserXSSValue));
                else if (o.browserXssFilter === true) sec.push(header('X-XSS-Protection', '1; mode=block'));
                if (o.contentSecurityPolicy) sec.push(header('Content-Security-Policy', o.contentSecurityPolicy));
                if (o.contentSecurityPolicyReportOnly) sec.push(header('Content-Security-Policy-Report-Only', o.contentSecurityPolicyReportOnly));
                if (o.referrerPolicy) sec.push(header('Referrer-Policy', o.referrerPolicy));
                if (o.permissionsPolicy) sec.push(header('Permissions-Policy', o.permissionsPolicy));
                sec.forEach(function(h) { f.resAdd.push({ h: h, source: mw.label + ' security headers' }); });
                // HSTS: Traefik sends it only over TLS, as add_header does on an HTTPS server.
                // STSSeconds set at all is a secure header (HasSecureHeadersDefined:
                // != nil), so 0 sends max-age=0, which tells browsers to drop HSTS.
                let sts = goInt(o.stsSeconds);
                if (sts !== null && sts >= 0) {
                    f.hsts = { maxAge: sts, includeSubdomains: o.stsIncludeSubdomains === true, preload: o.stsPreload === true, source: mw.label };
                    if (sts === 0) ctx.note(mw.label, 'stsSeconds 0 sent Strict-Transport-Security: max-age=0, which tells browsers to forget HSTS for the host; it is kept.');
                } else if (o.stsSeconds !== undefined) ctx.note(mw.label, 'stsSeconds "' + cmt(o.stsSeconds) + '" is not a whole number of seconds, which the Middleware CRD refuses; nothing is migrated for it.', 'warning');
                if (o.forceSTSHeader) ctx.note(mw.label, 'forceSTSHeader also sent HSTS over plain HTTP; NGINX Ingress Controller sends it over HTTPS only, which is what browsers honour.');
                // CORS.
                let hasCors = list(o.accessControlAllowOriginList).length || list(o.accessControlAllowOriginListRegex).length || list(o.accessControlAllowMethods).length
                    || list(o.accessControlAllowHeaders).length || o.accessControlAllowCredentials === true || list(o.accessControlExposeHeaders).length || o.accessControlMaxAge !== undefined;
                if (hasCors) {
                    let cors = {};
                    let origins = list(o.accessControlAllowOriginList).map(str);
                    let badOrigins = origins.filter(function(x) { return x !== '*' && !/^https?:\/\/[^/\s]+$/.test(x); });
                    cors.allowOrigin = origins.filter(function(x) { return badOrigins.indexOf(x) === -1; });
                    if (!cors.allowOrigin.length) { cors.allowOrigin = ['*']; ctx.todo(mw.label, 'the allowed origins: ' + (origins.length ? 'Traefik listed ' + badOrigins.join(', ') + ', which NGINX Ingress Controller does not accept as origins' : 'Traefik allowed none, so no browser request was allowed')); }
                    else if (badOrigins.length) ctx.note(mw.label, 'Origins ' + badOrigins.join(', ') + ' are not scheme://host, which the cors Policy requires; they are left out.', 'warning');
                    if (list(o.accessControlAllowOriginListRegex).length) ctx.note(mw.label, 'accessControlAllowOriginListRegex has no cors Policy form: list the origins explicitly.', 'warning');
                    let methods = list(o.accessControlAllowMethods).map(function(m) { return str(m).toUpperCase(); });
                    if (methods.length) {
                        cors.allowMethods = methods.filter(function(m) { return CORS_METHODS.indexOf(m) !== -1; });
                        if (cors.allowMethods.length < methods.length) ctx.note(mw.label, 'The cors Policy takes ' + CORS_METHODS.join(', ') + ' only; ' + methods.filter(function(m) { return CORS_METHODS.indexOf(m) === -1; }).join(', ') + ' left out.', 'warning');
                        if (!cors.allowMethods.length) delete cors.allowMethods;
                    }
                    let hdrs = list(o.accessControlAllowHeaders).map(str);
                    if (hdrs.length) {
                        cors.allowHeaders = hdrs.filter(function(h) { return h === '*' || (/^[A-Za-z0-9-]+$/.test(h) && !CORS_FORBIDDEN_HEADER.test(h)); });
                        if (cors.allowHeaders.length < hdrs.length) ctx.note(mw.label, 'Headers the cors Policy refuses (forbidden request headers, or not a header name) are left out: ' + hdrs.filter(function(h) { return cors.allowHeaders.indexOf(h) === -1; }).join(', ') + '.', 'warning');
                        if (!cors.allowHeaders.length) delete cors.allowHeaders;
                    }
                    if (o.accessControlAllowCredentials === true) cors.allowCredentials = true;
                    if (list(o.accessControlExposeHeaders).length) cors.exposeHeaders = list(o.accessControlExposeHeaders).map(str);
                    let age = goInt(o.accessControlMaxAge);
                    if (age !== null && age >= 0) cors.maxAge = age;
                    f.policies.push({ name: dnsName(mw.name + '-cors'), spec: { cors: cors }, ingress: 'nginx.org/policies', comments: { 'spec.cors': mw.label + ' accessControl*' } });
                    if (o.addVaryHeader) ctx.note(mw.label, 'addVaryHeader: the cors Policy has no Vary toggle; add Vary: Origin as a response header if a cache sits in front.');
                }
                let unmapped = ['allowedHosts', 'hostsProxyHeaders', 'sslProxyHeaders', 'publicKey', 'isDevelopment', 'featurePolicy', 'sslRedirect', 'sslTemporaryRedirect', 'sslHost', 'sslForceHost']
                    .filter(function(k) { return o[k] !== undefined && o[k] !== false && !(Array.isArray(o[k]) && !o[k].length); });
                if (unmapped.length) ctx.note(mw.label, 'No NGINX Ingress Controller equivalent for: ' + unmapped.join(', ') + '.', 'warning');
            },

            inFlightReq: function(o, f, ctx, mw) {
                let n = goInt(o.amount);
                let sc = isMap(o.sourceCriterion) ? o.sourceCriterion : {};
                // inFlightReq groups by host unless told otherwise (New: requestHost by default).
                let key = sc.requestHeaderName ? '$http_' + str(sc.requestHeaderName).toLowerCase().replace(/-/g, '_') : (sc.ipStrategy ? '$binary_remote_addr' : '$host');
                let zone = dnsName(mw.name + '-conn').replace(/-/g, '_');
                f.http.push('limit_conn_zone ' + key + ' zone=' + zone + ':10m;');
                f.httpSource = mw.label;
                f.location.push({ line: 'limit_conn ' + zone + ' ' + (n === null || n <= 0 ? 1 : n) + ';', source: mw.label });
                f.location.push({ line: 'limit_conn_status 429;', source: mw.label + ' — Traefik answers 429' });
                if (n === null || n <= 0) ctx.todo(mw.label, 'the concurrent-request limit: amount ' + str(o.amount) + ' is not a positive number');
                ctx.note(mw.label, 'Concurrent-request limiting has no Policy: it is limit_conn in location-snippets with its zone in http-snippets, keyed as Traefik grouped (' + key + ').', 'warning');
            },

            ipAllowList: function(o, f, ctx, mw) {
                f.allow.push({ ranges: list(o.sourceRange).map(str), source: mw.label, mw: mw });
                let code = goInt(o.rejectStatusCode);
                if (code && code !== 403) ctx.note(mw.label, 'rejectStatusCode ' + code + ': the accessControl Policy always answers 403.', 'warning');
                if (isMap(o.ipStrategy) && (o.ipStrategy.depth !== undefined || list(o.ipStrategy.excludedIPs).length)) {
                    cm(f, 'set-real-ip-from', list(o.ipStrategy.excludedIPs).join(',') || '0.0.0.0/0', mw.label + ' ipStrategy — the trusted proxies');
                    cm(f, 'real-ip-header', 'X-Forwarded-For', mw.label + ' ipStrategy');
                    cm(f, 'real-ip-recursive', 'True', mw.label + ' ipStrategy');
                    ctx.note(mw.label, 'ipStrategy is per middleware in Traefik and global in NGINX Ingress Controller (set-real-ip-from, real-ip-header): every resource then sees the forwarded client address. Set set-real-ip-from to the proxies in front.', 'warning');
                }
            },

            passTLSClientCert: function(o, f, ctx, mw) {
                if (o.pem === true) f.reqSet.push({ h: header('X-Forwarded-Tls-Client-Cert', '${ssl_client_escaped_cert}'), source: mw.label + ' pem' });
                if (isMap(o.info)) {
                    f.reqSet.push({ h: header('X-Forwarded-Tls-Client-Cert-Info', 'Subject="${ssl_client_s_dn}";Issuer="${ssl_client_i_dn}"'), source: mw.label + ' info' });
                    ctx.note(mw.label, 'Traefik builds X-Forwarded-Tls-Client-Cert-Info field by field (info.subject, info.issuer, notAfter, sans); NGINX has the whole subject and issuer DNs, so the header carries those.', 'warning');
                }
                ctx.note(mw.label, 'The certificate exists only when NGINX asks for it: attach an ingressMTLS Policy to the host as well.');
            },

            rateLimit: function(o, f, ctx, mw) {
                let avg = goInt(o.average);
                if (avg === 0 || o.average === undefined) { ctx.note(mw.label, 'average is 0, which Traefik treats as no limit: nothing to migrate.'); return; }
                if (avg === null || avg < 0) { ctx.note(mw.label, 'average "' + cmt(o.average) + '" is not a positive count; nothing is migrated.', 'warning'); return; }
                let period = o.period === undefined ? 1 : goDurationSeconds(o.period);
                if (!period) period = 1;
                let perSec = avg / period;
                let rate = perSec >= 1 && Number.isInteger(perSec) ? perSec + 'r/s' : (Number.isInteger(avg * 60 / period) ? (avg * 60 / period) + 'r/m' : Math.max(1, Math.round(perSec)) + 'r/s');
                // Traefik's bucket holds max(burst, 1) tokens and admits that
                // many at once; limit_req admits burst + 1 (nginx 1.31.7: burst=1
                // admitted 2, burst=2 admitted 3) and refuses burst=0. So NGINX
                // burst is Traefik's minus one, left out when that is 0.
                let tb = goInt(o.burst);
                let burst = Math.max(tb === null ? 1 : tb, 1) - 1;
                let spec = { rate: rate, key: '${binary_remote_addr}', zoneSize: '10M', rejectCode: 429 };
                let comments = { 'spec.rateLimit.rate': mw.label + ' average/period', 'spec.rateLimit.rejectCode': mw.label + ' — Traefik answers 429' };
                if (burst > 0) { spec.burst = burst; spec.noDelay = true; comments['spec.rateLimit.burst'] = mw.label + ' burst ' + tb + ', less the request NGINX always admits'; }
                let sc = isMap(o.sourceCriterion) ? o.sourceCriterion : {};
                if (sc.requestHeaderName) { spec.key = '${http_' + str(sc.requestHeaderName).toLowerCase().replace(/-/g, '_') + '}'; comments['spec.rateLimit.key'] = mw.label + ' sourceCriterion.requestHeaderName'; }
                else if (sc.requestHost) { spec.key = '${http_host}'; comments['spec.rateLimit.key'] = mw.label + ' sourceCriterion.requestHost'; }
                f.policies.push({ name: dnsName(mw.name + '-rate-limit'), spec: { rateLimit: spec }, ingress: null, comments: comments });
                f.ann['nginx.org/limit-req-rate'] = { value: rate, source: mw.label };
                if (burst > 0) { f.ann['nginx.org/limit-req-burst'] = { value: String(burst), source: mw.label }; f.ann['nginx.org/limit-req-no-delay'] = { value: 'true', source: mw.label }; }
                f.ann['nginx.org/limit-req-reject-code'] = { value: '429', source: mw.label };
                if (rate !== perSec + 'r/s' && !/r\/m$/.test(rate)) ctx.note(mw.label, avg + ' per ' + period + 's is ' + perSec.toFixed(3) + ' per second; NGINX takes whole requests per second or minute, so ' + rate + ' is the nearest.', 'warning');
                ctx.note(mw.label, 'Traefik delays a request up to half the token interval before refusing it; NGINX with noDelay refuses at once past the burst.');
                if (o.redis) ctx.note(mw.label, 'Redis-backed limiting is cluster-wide; NGINX Ingress Controller counts per replica unless NGINX Plus zone synchronization shares the zone.', 'warning');
                if (isMap(sc.ipStrategy)) ctx.note(mw.label, 'sourceCriterion.ipStrategy is global in NGINX Ingress Controller (set-real-ip-from, real-ip-header).', 'warning');
            },

            redirectRegex: function(o, f, ctx, mw) {
                let permanent = o.permanent === true;
                let replacement = str(o.replacement);
                if (/\$\{?\d/.test(replacement)) {
                    let to = replacement.replace(/\$\{(\d)\}/g, '$$$1');
                    f.location.push({ line: 'rewrite ' + cmt(o.regex) + ' ' + cmt(to) + ' ' + (permanent ? 'permanent' : 'redirect') + ';', source: mw.label });
                    ctx.note(mw.label, 'The replacement uses capture groups, which a VirtualServer redirect cannot, so it is an NGINX rewrite in location-snippets. Traefik matched the regex against the whole URL (scheme://host/path); rewrite matches the path only, so drop the scheme and host from the regex.', 'warning');
                } else {
                    f.redirect = { url: replacement || 'https://example.com', code: permanent ? 308 : 307, source: mw.label };
                    if (!replacement) ctx.todo(mw.label, 'the redirect URL');
                    ctx.note(mw.label, 'Traefik answered ' + (permanent ? '301 (GET) or 308' : '302 (GET) or 307') + '; NGINX takes one code, so ' + (permanent ? 308 : 307) + ', which keeps the method. The redirect applies to every request the route matches; Traefik redirected only those its regex matched.');
                }
            },

            redirectScheme: function(o, f, ctx, mw) {
                let scheme = str(o.scheme).toLowerCase();
                let permanent = o.permanent === true;
                if (scheme === 'https') {
                    f.tlsRedirect = { code: permanent ? 308 : 307, source: mw.label };
                    if (o.port && str(o.port) !== '443') ctx.note(mw.label, 'Redirecting to port ' + o.port + ': VirtualServer tls.redirect keeps the request\'s host and port 443; use a route redirect with an explicit URL for another port.', 'warning');
                } else {
                    f.redirect = { url: scheme + '://${host}' + (o.port ? ':' + o.port : '') + '${request_uri}', code: permanent ? 308 : 307, source: mw.label };
                }
            },

            replacePath: function(o, f, ctx, mw) {
                f.rewrite = { kind: 'replacePath', to: str(o.path), source: mw.label };
                ctx.note(mw.label, 'Traefik also sent the original path in X-Replaced-Path; rewritePath does not. Set it with requestHeaders if the backend reads it.');
            },

            replacePathRegex: function(o, f, ctx, mw) {
                f.rewrite = { kind: 'replacePathRegex', regex: str(o.regex), to: str(o.replacement).replace(/\$\{(\d)\}/g, '$$$1'), source: mw.label };
                ctx.note(mw.label, 'Traefik also sent the original path in X-Replaced-Path, and its regex is RE2 (NGINX: PCRE); check the pattern. Since v3.7.17 Traefik answers 400 when the rewritten path is not canonical (".." or "//"); NGINX normalises the rewritten path instead.');
            },

            retry: function(o, f, ctx, mw) {
                // attempts counts the first try (retry.go: attempts == 1 is a
                // single call), as next-upstream-tries does.
                let attempts = goInt(o.attempts);
                let conds = [];
                if (o.disableRetryOnNetworkError !== true) conds.push('error', 'timeout');
                let wanted = statusCodes(o.status) || [];
                [403, 404, 429, 500, 502, 503, 504].forEach(function(c) { if (wanted.indexOf(c) !== -1) conds.push('http_' + c); });
                if (o.retryNonIdempotentMethod === true) conds.push('non_idempotent');
                if (!conds.length) conds = ['error', 'timeout'];
                f.upstream['next-upstream'] = { value: conds.join(' '), source: mw.label + (o.status !== undefined ? ' status' : ' — network errors, Traefik\'s default') };
                f.upstream['next-upstream-tries'] = { value: attempts, source: mw.label + ' attempts (counts the first try, as NGINX does)' };
                if (attempts === 1) ctx.note(mw.label, 'attempts 1 is a single try (retry.go), so Traefik never retried; next-upstream-tries 1 does the same.');
                let to = o.timeout === undefined ? null : goDurationSeconds(o.timeout);
                if (to) f.upstream['next-upstream-timeout'] = { value: nginxTime(to), source: mw.label + ' timeout' };
                f.ann['nginx.org/proxy-next-upstream'] = { value: conds.join(' '), source: mw.label };
                f.ann['nginx.org/proxy-next-upstream-tries'] = { value: String(attempts), source: mw.label };
                let other = wanted.filter(function(c) { return [403, 404, 429, 500, 502, 503, 504].indexOf(c) === -1; });
                if (other.length) ctx.note(mw.label, 'NGINX retries on 403, 404, 429, 500, 502, 503 and 504 only; ' + other.slice(0, 8).join(', ') + (other.length > 8 ? '…' : '') + ' cannot trigger a retry.', 'warning');
                if (o.initialInterval) ctx.note(mw.label, 'NGINX retries at once: the backoff (initialInterval) has no equivalent.');
                if (o.maxRequestBodyBytes !== undefined) ctx.note(mw.label, 'maxRequestBodyBytes has no per-retry form.');
            },

            stripPrefix: function(o, f, ctx, mw) {
                f.rewrite = { kind: 'stripPrefix', prefixes: list(o.prefixes).map(str), source: mw.label };
                ctx.note(mw.label, 'Traefik also sent the stripped prefix in X-Forwarded-Prefix; rewritePath does not. Set it with requestHeaders if the backend builds URLs from it.');
            },

            stripPrefixRegex: function(o, f, ctx, mw) {
                f.rewrite = { kind: 'stripPrefixRegex', regexes: list(o.regex).map(str), source: mw.label };
                ctx.note(mw.label, 'Traefik also sent the stripped prefix in X-Forwarded-Prefix, and its regex is RE2 (NGINX: PCRE); check the pattern.');
            }
        };
        TRANSLATORS.ipWhiteList = TRANSLATORS.ipAllowList;

        // --- Assembly ----------------------------------------------------------
        function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
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
            if (/^\d+$/.test(str(port))) return parseInt(port, 10);
            if (port === null || port === undefined || port === '') { ctx.todo(where, 'the Service port (none is set)'); return 80; }
            ctx.todo(where, 'named Service port "' + port + '" — replace it with the port number; VirtualServer upstreams take numbers');
            return port;
        }
        function md(name, namespace) { let m = { name: name }; if (namespace) m.namespace = namespace; return m; }
        function docYaml(doc, comments) {
            return MigrationTool.yaml.stringify(doc, comments, { quote: function(p) { return /^metadata\.annotations\./.test(p) || /^data\./.test(p); } }).replace(/\n$/, '');
        }
        function rawYaml(doc) { return MigrationTool.yaml.stringify(doc).replace(/\n$/, ''); }
        // NGINX Ingress Controller ignores a resource whose class it does not own
        // (HasCorrectIngressClass) and claims one with none; a class naming
        // Traefik is never carried over.
        function targetClass(c, options) {
            if (options.ingressClass) return options.ingressClass;
            return c && !/traefik/i.test(c) ? c : null;
        }

        function makeCtx() {
            let ctx = {
                notes: [], todos: [],
                note: function(code, message, severity) {
                    if (ctx.notes.some(function(n) { return n.code === code && n.message === message; })) return;
                    ctx.notes.push({ code: code, message: message, severity: severity || 'note' });
                },
                todo: function(path, message) {
                    if (ctx.todos.some(function(t) { return t.path === path && t.message === message; })) return;
                    ctx.todos.push({ path: path, message: message });
                }
            };
            return ctx;
        }
        function newFragments() {
            return { upstream: {}, reqSet: [], resAdd: [], resHide: [], location: [], policies: [], allow: [], ann: {}, http: [], cm: {}, rewrite: null, redirect: null, tlsRedirect: null, hsts: null, errors: null };
        }

        // A route's path, and the route's rewrite in VirtualServer terms. Traefik
        // matches before it rewrites, so the route keeps its match and the
        // rewrite becomes rewritePath on a regex route that captures what the
        // middleware keeps. Returns { path, rewritePath } or null with a note.
        function routePath(p) {
            if (p.type === 'exact') return '=' + p.value;
            if (p.type === 'regex') return '~' + p.value;
            return p.value;
        }
        function rewriteRoute(p, rw, ctx) {
            if (!rw) return { path: routePath(p) };
            let base = p.type === 'exact' ? escapeRe(p.value) + '$' : p.type === 'regex' ? null : escapeRe(p.value);
            if (rw.kind === 'addPrefix') {
                // The whole path, with the prefix in front.
                if (base === null) return { path: routePath(p), rewritePath: null, todo: true };
                return { path: '~ ^(' + base + (p.type === 'prefix' ? '.*' : '') + ')$', rewritePath: rw.prefix.replace(/\/$/, '') + '$1' };
            }
            if (rw.kind === 'replacePath') return { path: routePath(p), rewritePath: rw.to || '/' };
            if (rw.kind === 'stripPrefix') {
                // stripPrefix removes the first listed prefix the path starts with,
                // and keeps a leading slash.
                let pre = rw.prefixes.find(function(x) { return p.value.indexOf(x.replace(/\/$/, '')) === 0; }) || rw.prefixes[0];
                if (!pre) return { path: routePath(p) };
                let stem = escapeRe(pre.replace(/\/$/, ''));
                return { path: '~ ^' + stem + '(?:/(.*))?$', rewritePath: '/$1' };
            }
            if (rw.kind === 'stripPrefixRegex') {
                ctx.todo(rw.source, 'the rewrite for stripPrefixRegex "' + rw.regexes.join('", "') + '": capture what follows the prefix in the route regex and use it in rewritePath');
                return { path: '~ ^(?:' + rw.regexes[0] + ')(.*)$', rewritePath: '/$1' };
            }
            if (rw.kind === 'replacePathRegex') {
                // Traefik replaces the whole path when the regex matches anywhere in
                // it, and passes a path it does not match unchanged; a lookahead
                // keeps the route's own match.
                let guard = base === null ? '' : '(?=' + base + ')';
                return { path: '~ ^' + guard + '.*?' + rw.regex.replace(/^\^/, ''), rewritePath: rw.to, plain: routePath(p) };
            }
            return { path: routePath(p) };
        }

        // An upstream for each Kubernetes Service a route reaches, following a
        // TraefikService: weighted (weights, default 1, as splits), mirroring (the
        // main service; mirrors noted), failover (main with backup, NGINX Plus).
        function resolveServices(services, run, namespace, ctx, label) {
            let out = [];
            services.forEach(function(s) {
                let kind = str(s.kind) || 'Service';
                if (kind === 'TraefikService') {
                    let ts = findNamed(run.traefikServices, str(s.name), s.namespace || namespace);
                    if (!ts) { ctx.note(label, 'TraefikService ' + s.name + ' is not in the paste; paste it to resolve its Services.', 'warning'); out.push({ service: str(s.name), port: 80, weight: 1, unresolved: true }); return; }
                    let sp = ts.spec;
                    if (isMap(sp.weighted)) {
                        list(sp.weighted.services).filter(isMap).forEach(function(w) { out.push({ service: str(w.name), port: w.port, weight: w.weight === undefined ? 1 : goInt(w.weight), via: 'TraefikService ' + ts.name + ' (weighted)' }); });
                        if (isMap(sp.weighted.sticky) && isMap(sp.weighted.sticky.cookie)) ctx.note('TraefikService ' + ts.name, 'weighted.sticky pinned clients to one of the weighted Services; NGINX splits per request and has no cross-upstream stickiness.', 'warning');
                    } else if (isMap(sp.mirroring)) {
                        out.push({ service: str(sp.mirroring.name), port: sp.mirroring.port, weight: 1, via: 'TraefikService ' + ts.name + ' (mirroring)' });
                        ctx.note('TraefikService ' + ts.name, 'Mirroring has no VirtualServer field: the main Service carries the traffic; copy requests to ' + list(sp.mirroring.mirrors).map(function(m) { return m && m.name; }).join(', ') + ' with the mirror directive in location-snippets and an internal location in server-snippets. NGINX mirrors every request; mirrors[].percent has no equivalent.', 'warning');
                    } else if (isMap(sp.failover)) {
                        let main = isMap(sp.failover.service) ? sp.failover.service : {};
                        let fb = isMap(sp.failover.fallback) ? sp.failover.fallback : {};
                        out.push({ service: str(main.name), port: main.port, weight: 1, backup: str(fb.name), backupPort: fb.port, via: 'TraefikService ' + ts.name + ' (failover)' });
                        ctx.note('TraefikService ' + ts.name, 'failover becomes upstreams[].backup, which NGINX Plus supports with a Service of type ExternalName only, and which fires when the main servers are down, not on errors.status.', 'warning');
                    } else {
                        ctx.note('TraefikService ' + ts.name, 'highestRandomWeight has no equivalent; the route uses round_robin.', 'warning');
                        out.push({ service: str(s.name), port: s.port, weight: 1, unresolved: true });
                    }
                    return;
                }
                out.push({ service: str(s.name), port: s.port, weight: s.weight === undefined ? 1 : goInt(s.weight), passHostHeader: s.passHostHeader, sticky: s.sticky, serversTransport: s.serversTransport });
            });
            return out;
        }
        // Weights as split percentages that sum to 100 (VirtualServer splits).
        function splitPercents(weights) {
            let total = weights.reduce(function(a, b) { return a + b; }, 0);
            if (total <= 0) return null;
            let p = weights.map(function(w) { return Math.floor(w * 100 / total); });
            let rest = 100 - p.reduce(function(a, b) { return a + b; }, 0);
            for (let i = 0; rest > 0; i = (i + 1) % p.length) { if (weights[i] > 0) { p[i]++; rest--; } }
            return p;
        }
        function matchConditions(facts, ctx, label) {
            let conds = [];
            let neg = function(n, v) { return (n ? '!' : '') + v; };
            facts.headers.forEach(function(h) { if (h.name) conds.push({ header: h.name, value: neg(h.negated, (h.regex ? '~' : '') + str(h.value)) }); });
            if (facts.methods.length > 1) ctx.note(label, 'Several Method() matchers joined with || are OR; a match is AND only, so the first method is used. Add a match per method: ' + facts.methods.map(function(m) { return m.value; }).join(', ') + '.', 'warning');
            facts.methods.slice(0, 1).forEach(function(m) { conds.push({ variable: '$request_method', value: neg(m.negated, m.value) }); });
            facts.queries.forEach(function(q) { if (q.name) conds.push({ argument: q.name, value: neg(q.negated, (q.regex ? '~' : '') + str(q.value === undefined ? '' : q.value)) }); });
            facts.clientIPs.forEach(function(ip) {
                if (str(ip.value).indexOf('/') !== -1) ctx.note(label, 'ClientIP(' + ip.value + ') is a range, which a match cannot test; use an accessControl Policy.', 'warning');
                else conds.push({ variable: '$remote_addr', value: neg(ip.negated, ip.value) });
            });
            return conds;
        }

        // The middleware chain of one route, as Traefik runs it: each name in
        // order, a chain middleware expanded in place (cycles stop). Returns
        // { mws: [model], down: reason | null }.
        function middlewareChain(refs, run, ctx, seen) {
            let out = { mws: [], down: null };
            seen = seen || {};
            refs.forEach(function(ref) {
                if (out.down) return;
                let key = (ref.namespace || '') + '/' + ref.name;
                if (ref.provider && ref.provider !== 'kubernetescrd') { out.mws.push({ external: true, ref: ref }); return; }
                let mw = findNamed(run.middlewares, ref.name, ref.namespace);
                if (!mw) { out.mws.push({ missing: true, ref: ref }); return; }
                if (mw.type === 'chain') {
                    if (seen[key]) return;
                    seen[key] = true;
                    let inner = middlewareChain(list(mw.options && mw.options.middlewares).map(function(r) { return mwRef(r, mw.namespace); }), run, ctx, seen);
                    out.mws = out.mws.concat(inner.mws);
                    if (inner.down) out.down = inner.down;
                    out.chains = (out.chains || []).concat([mw]);
                    return;
                }
                let why = refusedBecause(mw);
                if (why) out.down = 'Middleware ' + mw.name + ' (' + mw.type + ') ' + why;
                out.mws.push(mw);
            });
            return out;
        }

        // Where a mapped key's translator is.
        let TRANSLATOR_FOR = { addPrefix: 'addPrefix', basicAuth: 'basicAuth', buffering: 'buffering', circuitBreaker: 'circuitBreaker', compress: 'compress',
            contentType: 'contentType', errors: 'errors', forwardAuth: 'forwardAuth', grpcWeb: 'grpcWeb', headers: 'headers', inFlightReq: 'inFlightReq',
            ipAllowList: 'ipAllowList', ipWhiteList: 'ipWhiteList', passTLSClientCert: 'passTLSClientCert', rateLimit: 'rateLimit', redirectRegex: 'redirectRegex',
            redirectScheme: 'redirectScheme', replacePath: 'replacePath', replacePathRegex: 'replacePathRegex', retry: 'retry', stripPrefix: 'stripPrefix',
            stripPrefixRegex: 'stripPrefixRegex' };

        // Each middleware once per run: the same Middleware listed on several
        // routes is translated once and its fragments shared.
        function fragmentsFor(mw, ctx, cache) {
            let key = (mw.namespace || '') + '/' + mw.name;
            if (cache[key]) return cache[key];
            let f = newFragments();
            let tr = TRANSLATORS[TRANSLATOR_FOR[mw.type]];
            mw.label = 'Middleware ' + mw.name + ' (' + mw.type + ')';
            if (tr) {
                try { tr(mw.options || {}, f, ctx, mw); }
                catch (e) { console.warn('Traefik translator failed for ' + mw.type + ':', e); }
                f.policies.forEach(function(p) { p.from = p.from || [mw]; });
            } else if (MAPPED_UNSUPPORTED[mw.type]) {
                f.unsupported = mw.type;
            } else {
                f.unknown = mw.type;
            }
            if (mw.extraTypes && mw.extraTypes.length) ctx.note(mw.label, 'This Middleware also sets ' + mw.extraTypes.join(', ') + '; a Middleware holds one type, so Traefik read only ' + mw.type + '.', 'warning');
            cache[key] = f;
            return f;
        }
        // Middleware types the mapping table marks unsupported (no translator).
        let MAPPED_UNSUPPORTED = { digestAuth: true, encodedCharacters: true, jwt: true, oidc: true, apiKey: true, waf: true, distributedRateLimit: true,
            hmac: true, ldap: true, oAuth2ClientCredentials: true, oauth2ClientCredentials: true, oauth2TokenIntrospection: true, opa: true };

        // Several fragment bundles (the route's middlewares, in order) as one.
        // Later headers of the same name replace earlier ones, as Traefik applies
        // each middleware in turn; Policies and snippet lines accumulate.
        function mergeFragments(list_) {
            let f = newFragments();
            list_.forEach(function(x) {
                Object.keys(x.upstream).forEach(function(k) { f.upstream[k] = x.upstream[k]; });
                x.reqSet.forEach(function(r) { f.reqSet = f.reqSet.filter(function(y) { return y.h.name.toLowerCase() !== r.h.name.toLowerCase(); }); f.reqSet.push(r); });
                x.resAdd.forEach(function(r) { f.resAdd = f.resAdd.filter(function(y) { return y.h.name.toLowerCase() !== r.h.name.toLowerCase(); }); f.resAdd.push(r); });
                x.resHide.forEach(function(r) { f.resHide.push(r); });
                f.location = f.location.concat(x.location);
                f.policies = f.policies.concat(x.policies);
                f.allow = f.allow.concat(x.allow);
                Object.keys(x.ann).forEach(function(k) { f.ann[k] = x.ann[k]; });
                f.http = f.http.concat(x.http);
                if (x.httpSource) f.httpSource = x.httpSource;
                Object.keys(x.cm).forEach(function(k) { f.cm[k] = x.cm[k]; });
                ['rewrite', 'redirect', 'tlsRedirect', 'hsts', 'errors'].forEach(function(k) { if (x[k]) { if (f[k] && k === 'rewrite') f.rewriteClash = (f.rewriteClash || [f.rewrite.source]).concat([x.rewrite.source]); f[k] = x[k]; } });
            });
            return f;
        }

        // Every ipAllowList on a route is one more condition: Traefik admits a
        // client only if each list admits it, so their intersection is allowed.
        // NGINX Ingress Controller merges the allow lists of several Policies
        // into one (union), so the route gets a single Policy holding the ranges
        // every list admits. With one list that is the list itself.
        function allowPolicy(allows, ctx, nameStem) {
            if (!allows.length) return null;
            let ranges = allows[0].ranges.slice();
            if (allows.length > 1) {
                ranges = ranges.filter(function(r) { return allows.slice(1).every(function(a) { return a.ranges.indexOf(r) !== -1; }); });
                ctx.note(allows.map(function(a) { return a.source; }).join(' + '), 'Several ipAllowList middlewares on one route each had to admit the client; only the ranges in every list are allowed (' + (ranges.join(', ') || 'none') + '). Ranges that overlap without being equal are not intersected; check them.', 'warning');
            }
            if (!ranges.length) ctx.note(allows.map(function(a) { return a.source; }).join(' + '), 'No range is in every list, so Traefik admitted no client on this route. The Policy allows only 127.0.0.1/32 to keep it that way; remove the middlewares from the route if that was not intended.', 'warning');
            return { name: dnsName(nameStem + '-allow'), spec: { accessControl: { allow: ranges.length ? ranges : ['127.0.0.1/32'] } }, ingress: 'nginx.org/policies', from: allows.map(function(a) { return a.mw; }),
                comments: { 'spec.accessControl.allow': allows.map(function(a) { return a.source; }).join(' + ') + ' sourceRange' } };
        }

        // Every IngressRoute route as an entry for its host: { host, namespace,
        // path facts, match conditions, upstreams, fragments, tls, source }.
        // A route Traefik did not serve is reported and left out.
        function collectRoutes(run, ctx, cache) {
            let entries = [];
            run.ingressRoutes.forEach(function(ir) {
                let label = 'IngressRoute ' + ir.name;
                if (ir.spec.parentRefs) ctx.note(label, 'parentRefs make this a child router of another IngressRoute; NGINX Ingress Controller has no router hierarchy, so its rules are migrated as routes of their own.', 'warning');
                ir.routes.forEach(function(r, ri) {
                    let rl = label + ' route ' + (ri + 1);
                    if (r.kind !== 'Rule') { ctx.note(rl, 'kind "' + r.kind + '" is not Rule, so Traefik skipped this route.', 'warning'); return; }
                    if (!r.match) { ctx.note(rl, 'has an empty match, so Traefik skipped it.', 'warning'); return; }
                    if (!r.facts) { ctx.note(rl, 'match "' + cmt(r.match) + '" does not parse as Traefik v3 rule syntax, so Traefik refused the router. Nothing is migrated for it.', 'warning'); return; }
                    let chain = middlewareChain(r.middlewares, run, ctx);
                    if (chain.down) { ctx.note(rl, chain.down + ', so Traefik refused to build the router and its traffic got 404. Nothing is migrated for it; fix the middleware first.', 'warning'); return; }
                    let missing = chain.mws.filter(function(m) { return m.missing; });
                    if (missing.length) { ctx.note(rl, 'Middleware ' + missing.map(function(m) { return m.ref.raw; }).join(', ') + ' is not in the paste. Traefik refuses a router whose middleware does not exist; paste it to migrate this route.', 'warning'); return; }
                    chain.mws.filter(function(m) { return m.external; }).forEach(function(m) { ctx.note(rl, 'Middleware ' + m.ref.raw + ' comes from another provider (@' + m.ref.provider + '); paste its definition as a Middleware to migrate it.', 'warning'); });
                    let facts = r.facts;
                    if (facts.unknownMatchers.length) { ctx.note(rl, 'Unknown matcher ' + facts.unknownMatchers.join(', ') + ': Traefik refused the rule. Nothing is migrated for it.', 'warning'); return; }
                    let badPath = facts.paths.filter(function(p) { return p.type !== 'regex' && str(p.value).charAt(0) !== '/'; });
                    if (badPath.length) { ctx.note(rl, 'Path "' + badPath[0].value + '" does not start with /, so Traefik refused the rule. Nothing is migrated for it.', 'warning'); return; }
                    if (facts.negatedUnsupported.length) ctx.note(rl, 'Negated host or path matchers (' + facts.negatedUnsupported.join(', ') + ') have no VirtualServer form; the route is migrated without them, so it matches more than Traefik did.', 'warning');
                    if (facts.hostRegexps.length) ctx.note(rl, 'HostRegexp(' + facts.hostRegexps.join(', ') + ') has no VirtualServer form: a host is one name or a *.example.com wildcard. Make one per concrete host.', 'warning');
                    let hosts = facts.hosts.filter(function(h) { return h !== '*'; });
                    if (facts.hosts.indexOf('*') !== -1) ctx.note(rl, 'Host(`*`) matched every host; a VirtualServer serves one. Name the hosts.', 'warning');
                    if (!hosts.length) {
                        if (!facts.hostRegexps.length && facts.hosts.indexOf('*') === -1) ctx.note(rl, 'match "' + cmt(r.match) + '" names no host, so Traefik served it on every host; a VirtualServer needs one. Add Host() to migrate it.', 'warning');
                        return;
                    }
                    if (facts.hasOr && facts.paths.length <= 1 && hosts.length <= 1) ctx.note(rl, 'The rule uses ||, and a VirtualServer route matches with AND only; check the conditions.', 'warning');
                    let paths = facts.paths.length ? facts.paths : [{ type: 'prefix', value: '/' }];
                    let ups = resolveServices(r.services, run, ir.namespace, ctx, rl);
                    let frags = mergeFragments(chain.mws.filter(function(m) { return !m.missing && !m.external; }).map(function(m) { return fragmentsFor(m, ctx, cache); }));
                    (chain.chains || []).forEach(function(c) { ctx.note('Middleware ' + c.name + ' (chain)', 'A chain is its middlewares in order; NGINX Ingress Controller has no chain, so each one is applied to the route directly.'); });
                    hosts.forEach(function(host) {
                        paths.forEach(function(p) {
                            entries.push({ host: host, namespace: ir.namespace, path: p, conds: matchConditions(facts, ctx, rl), upstreams: ups, f: frags, tls: ir.tls,
                                source: { kind: 'IngressRoute', name: ir.name, route: ri, match: r.match }, mws: chain.mws, ingressClassName: ir.ingressClassName, entryPoints: ir.entryPoints, priority: r.priority });
                        });
                    });
                });
            });
            return entries;
        }

        // One VirtualServer for a host from every route entry on it (several
        // IngressRoutes merge: NGINX Ingress Controller gives a host to one
        // resource). Returns { docs: [Policy..., VirtualServer], comments: [...] }.
        function buildHost(host, namespace, entries, run, ctx, options, used) {
            let docs = [], comments = [];
            let c = {};
            let names = []; entries.forEach(function(e) { if (names.indexOf(e.source.name) === -1) names.push(e.source.name); });
            if (names.length > 1) ctx.note('Host ' + host, 'IngressRoutes ' + names.join(', ') + ' all route this host; NGINX Ingress Controller gives a host to one resource, so they are one VirtualServer.');
            let spec = {};
            let cls = targetClass(entries.map(function(e) { return e.ingressClassName; }).find(Boolean), options);
            if (cls) spec.ingressClassName = cls;
            spec.host = host;
            // TLS: the IngressRoutes' tls, one secret for the host.
            let tlsList = entries.map(function(e) { return e.tls; }).filter(Boolean);
            let secrets = []; tlsList.forEach(function(t) { if (t.secretName && secrets.indexOf(str(t.secretName)) === -1) secrets.push(str(t.secretName)); });
            if (tlsList.length) {
                spec.tls = {};
                if (secrets.length) { spec.tls.secret = secrets[0]; c['spec.tls.secret'] = 'tls.secretName'; if (secrets.length > 1) ctx.note('Host ' + host, 'The IngressRoutes name different TLS Secrets (' + secrets.join(', ') + '); a VirtualServer takes one, so ' + secrets[0] + ' is used.', 'warning'); }
                let resolver = tlsList.map(function(t) { return t.certResolver; }).find(Boolean);
                if (resolver) {
                    if (!secrets.length) spec.tls.secret = dnsName(host.replace(/^\*\./, 'wildcard.') + '-tls');
                    spec.tls['cert-manager'] = { 'cluster-issuer': 'letsencrypt' };
                    c['spec.tls.cert-manager.cluster-issuer'] = 'tls.certResolver ' + resolver + ' — the cert-manager ClusterIssuer that replaces it';
                    ctx.todo('spec.tls.cert-manager.cluster-issuer', 'the cert-manager ClusterIssuer for ' + host + ' (Traefik\'s ACME resolver ' + resolver + ' has no NGINX Ingress Controller equivalent)');
                } else if (!secrets.length) {
                    ctx.note('Host ' + host, 'The IngressRoute has tls with no secretName, so Traefik served its default certificate (TLSStore). The VirtualServer needs a Secret, or NGINX Ingress Controller started with -wildcard-tls-secret.', 'warning');
                }
                let opts = tlsList.map(function(t) { return isMap(t.options) ? t.options.name : null; }).find(Boolean);
                if (opts) ctx.note('Host ' + host, 'tls.options ' + opts + ': TLS versions and ciphers are global in NGINX Ingress Controller (ssl-protocols, ssl-ciphers in nginx-config); client certificates are an ingressMTLS Policy. See the TLSOption below.');
            }
            // Upstreams: one per (service, port) and per distinct field set.
            let upstreams = [], taken = {};
            let upFor = function(u, f, where) {
                let fields = {};
                Object.keys(f.upstream).forEach(function(k) { fields[k] = f.upstream[k].value; });
                let svc = findService(run, namespace, u.service);
                let svcAnn = svc ? svc.traefik : {};
                let key = u.service + ':' + str(u.port) + ':' + JSON.stringify(fields) + ':' + str(u.backup);
                let existing = upstreams.find(function(x) { return x.key === key; });
                if (existing) return existing.up.name;
                let name = upstreamName(u.service + (upstreams.some(function(x) { return x.up.service === u.service; }) ? '-' + (upstreams.length + 1) : ''), u.port, taken);
                let up = { name: name, service: u.service, port: upstreamPort(u.port, ctx, 'spec.upstreams.' + upstreams.length + '.port') };
                let uc = {};
                Object.keys(f.upstream).forEach(function(k) { up[k] = f.upstream[k].value; uc[k] = f.upstream[k].source; });
                if (u.backup) { up.backup = u.backup; up.backupPort = upstreamPort(u.backupPort, ctx, 'spec.upstreams.' + upstreams.length + '.backupPort'); uc.backup = u.via; }
                if (u.sticky && isMap(u.sticky.cookie)) stickyCookie(up, uc, u.sticky.cookie, 'services[].sticky.cookie', ctx);
                if (u.passHostHeader === false) ctx.note(where, 'passHostHeader: false sent the backend\'s own name as Host; NGINX sends the client\'s. Set Host with requestHeaders.', 'warning');
                if (u.serversTransport) ctx.note(where, 'serversTransport ' + u.serversTransport + ': see the ServersTransport below for its egressMTLS Policy and upstream fields.');
                upstreams.push({ key: key, up: up, comments: uc });
                return name;
            };
            // Routes, keyed by normalised path; same path, other conditions → matches.
            let routes = [], byPath = {};
            let policyRefs = [];
            let policyByName = {};
            entries.forEach(function(e) {
                let f = e.f;
                let rw = rewriteRoute(e.path, f.rewrite, ctx);
                if (f.rewriteClash) ctx.note(e.source.name, 'Several path middlewares on one route (' + f.rewriteClash.join(', ') + '): Traefik applied each in turn, a route rewrites once; the last is migrated.', 'warning');
                let where = 'IngressRoute ' + e.source.name;
                let legs = e.upstreams.filter(function(u) { return !u.unresolved || u.service; }).map(function(u) { return { name: upFor(u, f, where), weight: u.weight }; });
                let action;
                if (f.redirect) action = { redirect: { url: f.redirect.url, code: f.redirect.code } };
                else if (!legs.length) { action = { return: { code: 404, type: 'text/plain', body: 'Not Found' } }; ctx.note(where, 'This route names no service, so Traefik served nothing on it; it answers 404.'); }
                else {
                    let proxy = {};
                    if (rw.rewritePath) proxy.rewritePath = rw.rewritePath;
                    if (f.reqSet.length) proxy.requestHeaders = { set: f.reqSet.map(function(r) { return r.h; }) };
                    if (f.resAdd.length || f.resHide.length) {
                        proxy.responseHeaders = {};
                        if (f.resHide.length) proxy.responseHeaders.hide = f.resHide.map(function(r) { return r.name; });
                        if (f.resAdd.length) proxy.responseHeaders.add = f.resAdd.map(function(r) { return { name: r.h.name, value: r.h.value, always: true }; });
                    }
                    if (f.hsts && f.resAdd.every(function(r) { return r.h.name.toLowerCase() !== 'strict-transport-security'; })) {
                        let v = 'max-age=' + f.hsts.maxAge + (f.hsts.includeSubdomains ? '; includeSubDomains' : '') + (f.hsts.preload ? '; preload' : '');
                        proxy.responseHeaders = proxy.responseHeaders || {};
                        proxy.responseHeaders.add = (proxy.responseHeaders.add || []).concat([{ name: 'Strict-Transport-Security', value: v, always: true }]);
                    }
                    let weights = legs.map(function(l) { return l.weight === null ? 1 : l.weight; });
                    if (legs.length > 1) {
                        let pct = splitPercents(weights);
                        if (!pct) { action = { pass: legs[0].name }; ctx.note(where, 'Every weight is 0, so Traefik had no server for this route; it is passed to the first.', 'warning'); }
                        else {
                            let keep = legs.map(function(l, i) { return { l: l, p: pct[i] }; }).filter(function(x) { return x.p > 0; });
                            action = keep.length === 1 ? { pass: keep[0].l.name } : { splits: keep.map(function(x) { return { weight: x.p, action: Object.keys(proxy).length ? { proxy: Object.assign({ upstream: x.l.name }, proxy) } : { pass: x.l.name } }; }) };
                        }
                    } else action = Object.keys(proxy).length ? { proxy: Object.assign({ upstream: legs[0].name }, proxy) } : { pass: legs[0].name };
                }
                let pols = f.policies.slice();
                let ap = allowPolicy(f.allow, ctx, e.source.name);
                if (ap) pols.unshift(ap);
                pols.forEach(function(p) { if (!policyByName[p.name]) { policyByName[p.name] = p; } });
                let refs = pols.map(function(p) { return p.name; });
                let key = rw.path;
                let target = byPath[key];
                let piece = { conds: e.conds, action: action, refs: refs, f: f, e: e, rw: rw };
                if (target) {
                    if (!piece.conds.length && !target.base.conds.length) { ctx.note('Host ' + host, 'Two routes match ' + key + ' with nothing to tell them apart; Traefik took the longer rule (' + cmt(target.base.e.source.match.length >= e.source.match.length ? target.base.e.source.match : e.source.match) + '). That one is kept.', 'warning'); if (e.source.match.length > target.base.e.source.match.length) target.base = piece; return; }
                    if (!piece.conds.length) { target.matches = target.matches.concat(target.base.conds.length ? [target.base] : []); target.base = piece; }
                    else target.matches.push(piece);
                    return;
                }
                byPath[key] = { path: key, base: piece, matches: [] };
                routes.push(byPath[key]);
                // replacePathRegex passes a path its regex misses unchanged: the
                // route's plain path carries those requests, without rewritePath.
                if (rw.plain && !byPath[rw.plain]) {
                    let plainAction = piece.action;
                    if (plainAction.proxy) {
                        let px = Object.assign({}, plainAction.proxy);
                        delete px.rewritePath;
                        plainAction = Object.keys(px).length > 1 ? { proxy: px } : { pass: px.upstream };
                    }
                    let plainPiece = Object.assign({}, piece, { action: plainAction, rw: { path: rw.plain } });
                    byPath[rw.plain] = { path: rw.plain, base: plainPiece, matches: [] };
                    routes.push(byPath[rw.plain]);
                }
            });
            // Policies: on spec when every route shares the same set, else per route.
            let sets = routes.map(function(r) { return JSON.stringify(r.base.refs); });
            let shared = routes.length && sets.every(function(x) { return x === sets[0]; }) ? routes[0].base.refs : null;
            Object.keys(policyByName).forEach(function(n) {
                let p = policyByName[n];
                let pd = { apiVersion: NIC_API, kind: 'Policy', metadata: md(p.name, namespace), spec: p.spec };
                Object.defineProperty(pd, '_from', { value: p.from || [], enumerable: false });
                docs.push(pd);
                comments.push(Object.keys(p.comments || {}).reduce(function(acc, k) { acc[k] = p.comments[k]; return acc; }, {}));
            });
            if (shared && shared.length) { spec.policies = shared.map(function(n) { return { name: n }; }); c['spec.policies'] = 'the route middlewares above'; }
            if (upstreams.length) {
                spec.upstreams = upstreams.map(function(x) { return x.up; });
                upstreams.forEach(function(x, i) { Object.keys(x.comments).forEach(function(k) { c['spec.upstreams.' + i + '.' + k] = x.comments[k]; }); });
            }
            // HTTPS redirect: redirectScheme https on any route.
            let tr = entries.map(function(e) { return e.f.tlsRedirect; }).find(Boolean);
            if (tr) {
                spec.tls = spec.tls || {};
                spec.tls.redirect = { enable: true, code: tr.code };
                c['spec.tls.redirect'] = tr.source + ' scheme https';
                c['spec.tls.redirect.code'] = tr.source + (tr.code === 308 ? ' permanent — 308 keeps the method (Traefik: 301 for GET)' : ' — 307 keeps the method (Traefik: 302 for GET)');
                if (!spec.tls.secret) ctx.note(tr.source, 'Host ' + host + ' has no TLS here, so the redirect leads to an HTTPS server NGINX Ingress Controller does not serve for it; add the host\'s TLS Secret.', 'warning');
                if (entries.some(function(e) { return !e.f.tlsRedirect; })) ctx.note(tr.source, 'The redirect applied to the routes that listed it; tls.redirect applies to the whole host.', 'warning');
            }
            spec.routes = routes.map(function(r, ri) {
                let out = { path: r.path };
                c['spec.routes.' + ri + '.path'] = cmt(r.base.e.source.match) + (r.base.rw.rewritePath ? ' — ' + r.base.f.rewrite.source : '');
                if (!shared && r.base.refs.length) { out.policies = r.base.refs.map(function(n) { return { name: n }; }); c['spec.routes.' + ri + '.policies'] = 'this route\'s middlewares'; }
                if (r.base.f.location.length) { out['location-snippets'] = snippetBlock(r.base.f.location.map(function(l) { return l.line; })); c['spec.routes.' + ri + '.location-snippets'] = r.base.f.location.map(function(l) { return l.source; }).filter(function(v, i, a) { return a.indexOf(v) === i; }).join(' + '); }
                let ms = r.matches.concat(r.base.conds.length ? [r.base] : []);
                if (ms.length) {
                    out.matches = ms.map(function(m) { return { conditions: m.conds, action: m.action.splits ? undefined : m.action, splits: m.action.splits }; });
                    out.matches.forEach(function(m) { if (m.action === undefined) delete m.action; if (m.splits === undefined) delete m.splits; });
                    c['spec.routes.' + ri + '.matches'] = ms.map(function(m) { return cmt(m.e.source.match); }).join(' + ');
                    if (ms.some(function(m) { return JSON.stringify(m.refs) !== JSON.stringify(r.base.refs); })) ctx.note('Host ' + host, 'Routes on ' + r.path + ' that differ by header, query or method carry different middlewares; a match shares its route\'s Policies, so they are the route\'s.', 'warning');
                }
                if (r.base.conds.length) {
                    out.action = { return: { code: 404, type: 'text/plain', body: 'Not Found' } };
                    c['spec.routes.' + ri + '.action'] = 'no unconditional rule on this path: Traefik answered 404 when no match held';
                } else if (r.base.action.splits) out.splits = r.base.action.splits;
                else out.action = r.base.action;
                if (r.base.f.errors) errorPagesFor(out, r.base.f.errors, run, namespace, ctx, c, 'spec.routes.' + ri);
                return out;
            });
            if (!routes.length) return { docs: [], comments: [] };
            let used_ = used || {};
            let name = dnsName(names.length === 1 ? names[0] : host.replace(/^\*\./, 'wildcard.').split('.')[0]);
            for (let n = 2; used_[name]; n++) name = dnsName((names.length === 1 ? names[0] : host.split('.')[0]) + '-' + n);
            used_[name] = true;
            docs.push({ apiVersion: NIC_API, kind: 'VirtualServer', metadata: md(name, namespace), spec: spec });
            comments.push(c);
            return { docs: docs, comments: comments, http: entries.map(function(e) { return e.f; }) };
        }

        function stickyCookie(up, uc, ck, source, ctx) {
            let name = str(ck.name) || 'sticky';
            if (!cookieNameOk(name)) { ctx.note(source, 'Cookie name "' + name + '": NGINX Ingress Controller takes letters, digits and underscores only, so stickiness is not migrated; rename it (clients lose their pinning once).', 'warning'); return; }
            up.sessionCookie = { enable: true, name: name, path: str(ck.path) || '/' };
            if (ck.secure === true) up.sessionCookie.secure = true;
            if (ck.httpOnly === true) up.sessionCookie.httpOnly = true;
            if (ck.sameSite) up.sessionCookie.samesite = str(ck.sameSite).toLowerCase();
            let age = goInt(ck.maxAge);
            if (age !== null && age > 0) up.sessionCookie.expires = nginxTime(age);
            if (ck.domain) up.sessionCookie.domain = str(ck.domain);
            uc.sessionCookie = source;
        }

        // errors: Traefik proxied the error to its service (customerrors.New →
        // BuildHTTP) and kept the status. A VirtualServer can only redirect or
        // return, so the route redirects to the error Service's host when one
        // routes it, else it is reported; an annotated Ingress gets
        // nginx.org/custom-http-errors, which proxies as Traefik did.
        function errorPagesFor(route, err, run, namespace, ctx, c, at) {
            let codes = err.codes.filter(function(x) { return x >= 300 && x <= 599; });
            if (!codes.length) { ctx.note(err.source, 'No status in 300–599 to intercept; nothing to migrate.'); return; }
            let svcName = str(err.service && err.service.name);
            let host = null;
            run.ingressRoutes.forEach(function(ir) { ir.routes.forEach(function(r) { if (!host && r.facts && r.facts.hosts.length && r.services.some(function(s) { return str(s.name) === svcName; })) host = r.facts.hosts[0]; }); });
            if (host) {
                let q = err.query || '/{status}.html';
                route.errorPages = [{ codes: codes.slice(0, 50), redirect: { code: 302, url: 'https://' + host + q.replace(/\{status\}/g, String(codes[0])).replace(/\{originalStatus\}/g, String(codes[0])) } }];
                c[at + '.errorPages'] = err.source + ' — a redirect to the error Service\'s host; Traefik proxied it and kept the status';
                ctx.note(err.source, 'Traefik proxied the error page from ' + svcName + ' and kept the error status; a VirtualServer redirects (302) to it instead, and its URL cannot carry each status. For the proxied behaviour use an Ingress with nginx.org/custom-http-errors.', 'warning');
            } else {
                ctx.note(err.source, 'Traefik proxied the error page from Service ' + svcName + ', keeping the status. A VirtualServer cannot proxy an error page, and no route in the paste serves that Service to redirect to; an Ingress with nginx.org/custom-http-errors and spec.defaultBackend ' + svcName + ' does it as Traefik did.', 'warning');
            }
        }

        // --- Annotated Ingresses -----------------------------------------------
        // The Ingress provider: one router per path, Host(host) && matcher(path)
        // (loadRouter). pathType Exact is Path; ImplementationSpecific or none is
        // router.pathmatcher (Path, PathPrefix, PathRegexp) or PathPrefix;
        // Prefix is PathPrefix, a character-wise prefix, which an NGINX
        // location prefix matches the same way. router.* annotations apply to
        // every path; service.* come from each path's Service.
        let ROUTER_BOOL = { 'router.tls': true };
        function ingressRouterConfig(m, ctx, run) {
            let a = m.traefik;
            let get = function(k) { return a[k] ? a[k].value : undefined; };
            let bad = [];
            Object.keys(ROUTER_BOOL).forEach(function(k) { if (get(k) !== undefined && goBool(get(k)) === null) bad.push(k + '="' + get(k) + '"'); });
            ['router.priority'].forEach(function(k) { if (get(k) !== undefined && goInt(get(k)) === null) bad.push(k + '="' + get(k) + '"'); });
            ['router.observability.accesslogs', 'router.observability.metrics', 'router.observability.tracing'].forEach(function(k) { if (get(k) !== undefined && goBool(get(k)) === null) bad.push(k + '="' + get(k) + '"'); });
            let pm = get('router.pathmatcher');
            if (bad.length) return { down: 'Traefik could not decode ' + bad.join(', ') + ' (a boolean is true or false, a priority a number), so it skipped this whole Ingress ("Failed to parse annotations").' };
            return {
                middlewares: str(get('router.middlewares')).split(',').map(function(s) { return s.trim(); }).filter(Boolean).map(function(n) {
                    // A CRD middleware's ID is <namespace>-<name>@kubernetescrd
                    // (crd/name_builder.go makeID), so the reference is matched
                    // against every pasted Middleware's namespace and name.
                    let at = n.indexOf('@'), base = at === -1 ? n : n.slice(0, at), prov = at === -1 ? null : n.slice(at + 1);
                    if (prov === 'kubernetescrd') {
                        let hit = run.middlewares.find(function(x) { return (x.namespace || m.namespace || 'default') + '-' + x.name === base; })
                            || run.middlewares.find(function(x) { return base.slice(-(x.name.length + 1)) === '-' + x.name; });
                        if (hit) return { name: hit.name, provider: null, namespace: hit.namespace, raw: n };
                        let dash = base.indexOf('-');
                        return { name: dash === -1 ? base : base.slice(dash + 1), provider: null, namespace: dash === -1 ? m.namespace : base.slice(0, dash), raw: n };
                    }
                    return { name: base, provider: prov, namespace: m.namespace, raw: n };
                }),
                pathMatcher: pm,
                tls: goBool(get('router.tls')) === true || get('router.tls.certresolver') !== undefined || get('router.tls.options') !== undefined,
                certResolver: get('router.tls.certresolver'),
                tlsOptions: get('router.tls.options'),
                entryPoints: str(get('router.entrypoints')).split(',').map(function(s) { return s.trim(); }).filter(Boolean)
            };
        }
        function ingressPathFacts(p, cfg, ctx, label) {
            if (p.pathType === 'Exact') return { type: 'exact', value: p.path };
            if (p.pathType === 'Prefix') return { type: 'prefix', value: p.path };
            let pm = cfg.pathMatcher;
            if (pm === undefined || pm === '') return { type: 'prefix', value: p.path };
            if (pm === 'Path') return { type: 'exact', value: p.path };
            if (pm === 'PathPrefix') return { type: 'prefix', value: p.path };
            if (pm === 'PathRegexp') return { type: 'regex', value: p.path };
            return { invalid: 'router.pathmatcher "' + pm + '" is not Path, PathPrefix or PathRegexp, so Traefik refused this path' };
        }
        // An Ingress's paths as route entries (the same shape IngressRoutes
        // produce), its service.* settings applied per Service.
        function ingressEntries(m, run, ctx, cache) {
            let label = 'Ingress ' + (m.name || '');
            let cfg = ingressRouterConfig(m, ctx, run);
            if (cfg.down) { ctx.note(label, cfg.down + ' Nothing is migrated for it.', 'warning'); return { entries: [], cfg: cfg }; }
            let chain = middlewareChain(cfg.middlewares, run, ctx);
            if (chain.down) { ctx.note(label, chain.down + ', so Traefik refused every router of this Ingress and its traffic got 404. Nothing is migrated for it.', 'warning'); return { entries: [], cfg: cfg, down: true }; }
            let missing = chain.mws.filter(function(x) { return x.missing; });
            if (missing.length) { ctx.note(label, 'router.middlewares names ' + missing.map(function(x) { return x.ref.raw; }).join(', ') + ', which is not in the paste. Traefik refuses a router whose middleware does not exist; paste it to migrate this Ingress.', 'warning'); return { entries: [], cfg: cfg, down: true }; }
            let frags = mergeFragments(chain.mws.filter(function(x) { return !x.missing && !x.external; }).map(function(x) { return fragmentsFor(x, ctx, cache); }));
            let entries = [];
            m.hosts.forEach(function(h) {
                h.paths.forEach(function(p) {
                    if (!p.backend || !p.backend.service) { ctx.note(label, 'Path ' + p.path + ' has a resource backend, which NGINX Ingress Controller does not route; it is skipped.', 'warning'); return; }
                    let pf = ingressPathFacts(p, cfg, ctx, label);
                    if (pf.invalid) { ctx.note(label, pf.invalid + '. Nothing is migrated for it.', 'warning'); return; }
                    let svc = findService(run, m.namespace, p.backend.service);
                    let sa = svc ? serviceAnnotations(svc, ctx) : {};
                    if (sa.down) return;
                    let up = { service: p.backend.service, port: p.backend.port, weight: 1, sticky: sa.sticky, passHostHeader: sa.passHostHeader, serversTransport: sa.serversTransport };
                    let f = frags;
                    if (sa.frags) f = mergeFragments([sa.frags, frags]);
                    entries.push({ host: h.host, namespace: m.namespace, path: pf, conds: [], upstreams: [up], f: f, tls: h.tlsSecret !== null ? { secretName: h.tlsSecret || null, certResolver: cfg.certResolver, options: cfg.tlsOptions ? { name: cfg.tlsOptions } : null } : (cfg.tls ? { secretName: null, certResolver: cfg.certResolver } : null),
                        source: { kind: 'Ingress', name: m.name, match: 'Host(`' + h.host + '`) && ' + (pf.type === 'exact' ? 'Path' : pf.type === 'regex' ? 'PathRegexp' : 'PathPrefix') + '(`' + p.path + '`)' }, mws: chain.mws, ingressClassName: m.ingressClassName, svcAnn: sa });
                });
            });
            if (m.hostless.length) ctx.note(label, m.hostless.length + ' path(s) belong to a rule with no host: Traefik served them on every host. A VirtualServer needs a host; the migrated Ingress keeps them (NGINX Ingress Controller needs -allow-empty-ingress-host for a host-less rule).', 'warning');
            if (cfg.entryPoints.length && cfg.entryPoints.some(function(e) { return e !== 'web' && e !== 'websecure'; })) ctx.note(label, 'router.entrypoints ' + cfg.entryPoints.join(', ') + ': custom entry points are GlobalConfiguration HTTP listeners (VirtualServer spec.listener) or nginx.org/listen-ports.', 'warning');
            return { entries: entries, cfg: cfg, frags: frags, chain: chain };
        }
        // service.* annotations of a Service, decoded as parseServiceConfig does;
        // a value it cannot decode drops the Service from the router.
        function serviceAnnotations(svc, ctx) {
            let a = svc.traefik;
            let get = function(k) { return a[k] ? a[k].value : undefined; };
            let label = 'Service ' + svc.name;
            let bad = [];
            ['service.passhostheader', 'service.nativelb', 'service.nodeportlb', 'service.sticky.cookie', 'service.sticky.cookie.secure', 'service.sticky.cookie.httponly'].forEach(function(k) { if (get(k) !== undefined && goBool(get(k)) === null) bad.push(k + '="' + get(k) + '"'); });
            if (get('service.sticky.cookie.maxage') !== undefined && goInt(get('service.sticky.cookie.maxage')) === null) bad.push('service.sticky.cookie.maxage="' + get('service.sticky.cookie.maxage') + '"');
            if (bad.length) { ctx.note(label, 'Traefik could not decode ' + bad.join(', ') + ', so every path routing to this Service failed. Nothing is migrated for those paths.', 'warning'); return { down: true }; }
            let out = {};
            let anySticky = Object.keys(a).some(function(k) { return k.indexOf('service.sticky.cookie') === 0; });
            if (anySticky && goBool(get('service.sticky.cookie')) !== false) {
                out.sticky = { cookie: { name: get('service.sticky.cookie.name'), secure: goBool(get('service.sticky.cookie.secure')) === true, httpOnly: goBool(get('service.sticky.cookie.httponly')) === true,
                    sameSite: get('service.sticky.cookie.samesite'), maxAge: get('service.sticky.cookie.maxage'), path: get('service.sticky.cookie.path'), domain: get('service.sticky.cookie.domain') } };
            }
            if (get('service.passhostheader') !== undefined) out.passHostHeader = goBool(get('service.passhostheader'));
            if (get('service.serverstransport') !== undefined) out.serversTransport = get('service.serverstransport');
            let scheme = get('service.serversscheme');
            if (scheme !== undefined) {
                let f = newFragments();
                let s = str(scheme).toLowerCase();
                if (s === 'https') { f.upstream.tls = { value: { enable: true }, source: 'Service ' + svc.name + ' service.serversscheme https' }; f.ann['nginx.org/ssl-services'] = { value: svc.name, source: 'service.serversscheme' }; }
                else if (s === 'h2c') { f.upstream.type = { value: 'grpc', source: 'Service ' + svc.name + ' service.serversscheme h2c' }; f.ann['nginx.org/grpc-services'] = { value: svc.name, source: 'service.serversscheme' }; ctx.note(label, 'h2c is plaintext HTTP/2; NGINX speaks it to gRPC backends (type: grpc). A non-gRPC h2c backend needs proxy-http-version 2 instead.', 'warning'); }
                else ctx.note(label, 'service.serversscheme ' + scheme + ' is NGINX\'s default (http); nothing to migrate.');
                out.frags = f;
            }
            if (goBool(get('service.nativelb')) === true) { out.frags = out.frags || newFragments(); out.frags.upstream['use-cluster-ip'] = { value: true, source: label + ' service.nativelb' }; out.frags.ann['nginx.org/use-cluster-ip'] = { value: 'true', source: 'service.nativelb' }; }
            if (goBool(get('service.nodeportlb')) === true) ctx.note(label, 'service.nodeportlb has no equivalent: NGINX Ingress Controller balances pod endpoints (or the ClusterIP).', 'warning');
            if (get('service.middlewares') !== undefined) ctx.note(label, 'service.middlewares ran after the router\'s middlewares, for this Service only; they are not migrated — move them to the Ingress\'s router.middlewares if they apply to every path.', 'warning');
            return out;
        }

        // nginx.org/custom-http-errors as NGINX Ingress Controller parses it:
        // codes 300–599 (499 refused by error_page), at most 300.
        function customHTTPErrors(codes) {
            let ok = codes.filter(function(x) { return x >= 300 && x <= 599 && x !== 499; });
            ok = ok.filter(function(x, i) { return ok.indexOf(x) === i; }).sort(function(a, b) { return a - b; }).slice(0, 300);
            let all4 = 0, all5 = 0;
            ok.forEach(function(x) { if (x >= 400 && x <= 499) all4++; if (x >= 500) all5++; });
            let parts = [];
            if (all4 === 99) parts.push('4xx'); else ok.filter(function(x) { return x >= 400 && x <= 499; }).forEach(function(x) { parts.push(String(x)); });
            if (all5 === 100) parts.push('5xx'); else ok.filter(function(x) { return x >= 500; }).forEach(function(x) { parts.push(String(x)); });
            ok.filter(function(x) { return x < 400; }).forEach(function(x) { parts.unshift(String(x)); });
            return { value: parts.join(','), dropped: codes.filter(function(x) { return ok.indexOf(x) === -1; }) };
        }

        // The migrated Ingress: the original, its class and Traefik annotations
        // replaced by NGINX Ingress Controller ones from the fragments.
        function buildIngressDoc(m, res, run, ctx, options) {
            let label = 'Ingress ' + (m.name || '');
            let spec = JSON.parse(JSON.stringify(isMap(m.doc.spec) ? m.doc.spec : {}));
            let ann = {}, annC = {};
            let set = function(k, v, src) { ann[k] = String(v); annC[k] = src; };
            let frags = res.entries.map(function(e) { return e.f; });
            let f = mergeFragments(frags.length ? frags : [res.frags || newFragments()]);
            Object.keys(f.ann).forEach(function(k) { set(k, f.ann[k].value, f.ann[k].source); });
            // Policies the Ingress can reference (nginx.org/policies); the rest
            // have their annotation form above.
            let pols = f.policies.filter(function(p) { return p.ingress; });
            let ap = allowPolicy(f.allow, ctx, m.name || 'app');
            if (ap) pols.unshift(ap);
            let docs = [], comments = [];
            let byAnn = {};
            pols.forEach(function(p) {
                (byAnn[p.ingress] = byAnn[p.ingress] || []).push(p.name);
                let pd = { apiVersion: NIC_API, kind: 'Policy', metadata: md(p.name, m.namespace), spec: p.spec };
                Object.defineProperty(pd, '_from', { value: p.from || [], enumerable: false });
                docs.push(pd); comments.push(p.comments || {});
            });
            Object.keys(byAnn).forEach(function(k) { set(k, byAnn[k].join(','), 'the Policies above'); });
            // Request and response headers: the annotation forms take name: value
            // pairs split on commas; a value with a comma, colon or quote needs
            // the VirtualServer form, so it is reported.
            let req = f.reqSet.filter(function(r) { return annotationSafe(r.h.value) && r.h.value !== ''; });
            if (req.length) set('nginx.org/proxy-set-headers', req.map(function(r) { return r.h.name + ': ' + r.h.value; }).join(','), f.reqSet.map(function(r) { return r.source; }).filter(function(v, i, a) { return a.indexOf(v) === i; }).join(' + '));
            let res_ = f.resAdd.filter(function(r) { return annotationSafe(r.h.value); });
            if (f.hsts) { set('nginx.org/hsts', 'true', f.hsts.source); set('nginx.org/hsts-max-age', String(f.hsts.maxAge), f.hsts.source); if (f.hsts.includeSubdomains) set('nginx.org/hsts-include-subdomains', 'true', f.hsts.source); if (f.hsts.preload) ctx.note(f.hsts.source, 'stsPreload: nginx.org/hsts has no preload; the hsts Policy on a VirtualServer does.', 'warning'); }
            if (res_.length) set('nginx.org/add-header', res_.map(function(r) { return r.h.name + ': ' + r.h.value + ': always'; }).join(','), f.resAdd.map(function(r) { return r.source; }).filter(function(v, i, a) { return a.indexOf(v) === i; }).join(' + '));
            if (f.resHide.length) set('nginx.org/proxy-hide-headers', f.resHide.map(function(r) { return r.name; }).join(','), f.resHide[0].source);
            let unsafe = f.reqSet.concat(f.resAdd).filter(function(r) { return !annotationSafe(r.h.value) || r.h.value === ''; });
            if (unsafe.length) ctx.note(label, 'Header values with a comma, colon, quote or $ (' + unsafe.map(function(r) { return r.h.name; }).join(', ') + ') do not survive the nginx.org header annotations, which split on commas and colons; they are left out. A VirtualServer carries them (CRD-first).', 'warning');
            if (f.location.length) { set('nginx.org/location-snippets', f.location.map(function(l) { return l.line; }).join('\n'), f.location.map(function(l) { return l.source; }).filter(function(v, i, a) { return a.indexOf(v) === i; }).join(' + ')); }
            if (f.rewrite) ctx.note(f.rewrite.source, 'Path rewrites have no Ingress annotation that matches Traefik\'s; a VirtualServer route carries them (CRD-first).', 'warning');
            if (f.redirect) ctx.note(f.redirect.source, 'A redirect has no Ingress annotation; a VirtualServer route carries it (CRD-first).', 'warning');
            if (f.tlsRedirect) { set('nginx.org/redirect-to-https', 'true', f.tlsRedirect.source); set('nginx.org/http-redirect-code', String(f.tlsRedirect.code), f.tlsRedirect.source); }
            if (f.errors) {
                let ce = customHTTPErrors(f.errors.codes);
                if (ce.value) {
                    set('nginx.org/custom-http-errors', ce.value, f.errors.source + ' status');
                    spec.defaultBackend = { service: { name: str(f.errors.service.name), port: { number: goInt(f.errors.service.port) || 80 } } };
                    ctx.note(f.errors.source, 'nginx.org/custom-http-errors proxies the error to spec.defaultBackend and keeps the status, as Traefik did. Traefik rewrote the path with query "' + (f.errors.query || '/') + '"; NGINX sends the original path, so the error Service must read the status another way.' + (ce.dropped.length ? ' Codes NGINX cannot intercept were dropped: ' + ce.dropped.slice(0, 6).join(', ') + '.' : ''), 'warning');
                    if (spec.defaultBackend && !list(spec.rules).length) ctx.note(label, 'An Ingress with only a defaultBackend has no rules, which NGINX Ingress Controller rejects.', 'warning');
                }
            }
            let upSets = {};
            res.entries.forEach(function(e) { Object.keys(e.f.upstream).forEach(function(k) { upSets[k] = e.f.upstream[k]; }); });
            let annFor = { 'client-max-body-size': 'nginx.org/client-max-body-size', 'max-fails': 'nginx.org/max-fails', 'fail-timeout': 'nginx.org/fail-timeout', 'next-upstream': 'nginx.org/proxy-next-upstream', 'next-upstream-tries': 'nginx.org/proxy-next-upstream-tries', 'next-upstream-timeout': 'nginx.org/proxy-next-upstream-timeout' };
            Object.keys(upSets).forEach(function(k) { if (annFor[k] && ann[annFor[k]] === undefined) set(annFor[k], upSets[k].value, upSets[k].source); });
            if (upSets['client-body-buffer-size']) ctx.note(upSets['client-body-buffer-size'].source, 'client-body-buffer-size has no Ingress annotation; set it in nginx-config (client-body-buffer-size) or use a VirtualServer.', 'warning');
            // Sticky sessions: nginx.org/sticky-cookie-services, per Service.
            let sticky = [];
            res.entries.forEach(function(e) {
                let ck = e.upstreams[0].sticky && e.upstreams[0].sticky.cookie;
                if (!ck || sticky.some(function(s) { return s.svc === e.upstreams[0].service; })) return;
                let name = str(ck.name) || 'sticky';
                if (!cookieNameOk(name)) { ctx.note('Service ' + e.upstreams[0].service, 'Cookie name "' + name + '" has characters NGINX Ingress Controller refuses; stickiness is not migrated.', 'warning'); return; }
                let age = goInt(ck.maxAge);
                sticky.push({ svc: e.upstreams[0].service, v: 'serviceName=' + e.upstreams[0].service + ' ' + name + (age > 0 ? ' expires=' + nginxTime(age) : '') + ' path=' + (str(ck.path) || '/') + (ck.secure ? ' secure' : '') + (ck.httpOnly ? ' httponly' : '') });
            });
            if (sticky.length) set('nginx.org/sticky-cookie-services', sticky.map(function(s) { return s.v; }).join(';'), 'service.sticky.cookie (on the Service)');
            let cls = targetClass(m.ingressClassName, options);
            if (cls) spec.ingressClassName = cls; else delete spec.ingressClassName;
            let meta = md(dnsName((m.name || 'my-app') + (options.nameSuffix || '')), m.namespace);
            if (Object.keys(ann).length) meta.annotations = ann;
            let ing = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: meta };
            if (Object.keys(spec).length) ing.spec = spec;
            let c = {};
            Object.keys(annC).forEach(function(k) { if (annC[k]) c['metadata.annotations.' + k] = annC[k]; });
            docs.push(ing);
            comments.push(c);
            return { docs: docs, comments: comments, http: frags };
        }
        // Settings an Ingress carries that have no VirtualServer form, so it
        // stays an Ingress under CRD-first too: the errors middleware (which
        // custom-http-errors proxies as Traefik did), and a host-less rule.
        function needsIngress(m, res) {
            let why = [];
            if (res.entries.some(function(e) { return e.f.errors; })) why.push('the errors middleware (nginx.org/custom-http-errors proxies the error page, as Traefik did; a VirtualServer can only redirect)');
            if (m.hostless.length) why.push('a rule with no host (a VirtualServer needs one)');
            return why;
        }

        // --- TCP and UDP --------------------------------------------------------
        // IngressRouteTCP: tls.passthrough → a TransportServer per SNI on the
        // built-in tls-passthrough listener; TLS terminated with a HostSNI →
        // host + tls.secret on a TCP listener (validateTransportServerHost needs
        // both); HostSNI(`*`) without TLS → a plain TCP listener. IngressRouteUDP
        // → a UDP listener. Listeners go in the one GlobalConfiguration.
        function buildTCP(run, ctx, options, listeners) {
            let docs = [], comments = [];
            let used = {};
            let tsName = function(base) { let n = dnsName(base); for (let i = 2; used[n]; i++) n = dnsName(base + '-' + i); used[n] = true; return n; };
            let cls = function(c) { return targetClass(c, options); };
            run.ingressRoutesTCP.forEach(function(ir) {
                let label = 'IngressRouteTCP ' + ir.name;
                let pass = !!(ir.tls && ir.tls.passthrough === true);
                ir.routes.forEach(function(r, ri) {
                    if (!r.facts) { ctx.note(label, 'match "' + cmt(r.match) + '" does not parse, so Traefik refused this route.', 'warning'); return; }
                    let svcs = r.services.filter(function(s) { return s.name; });
                    if (!svcs.length) { ctx.note(label, 'route ' + (ri + 1) + ' names no service.', 'warning'); return; }
                    if (svcs.length > 1) ctx.note(label, 'Several services on one TCP route were weighted by Traefik; a TransportServer passes to one upstream, so ' + svcs[0].name + ' is used.', 'warning');
                    let svc = svcs[0];
                    let snis = r.facts.hostSNIs.filter(function(h) { return h !== '*'; });
                    let catchAll = r.facts.hostSNIs.indexOf('*') !== -1;
                    if (r.facts.hostRegexps.length) ctx.note(label, 'HostSNIRegexp has no TransportServer form; name each SNI.', 'warning');
                    if (svc.proxyProtocol) ctx.note(label, 'services[].proxyProtocol: a TransportServer has no field for it; add "proxy_protocol on;" with serverSnippets (-enable-snippets).', 'warning');
                    let mws = r.middlewares.map(function(ref) { return findNamed(run.middlewaresTCP, ref.name, ref.namespace); });
                    let snippet = [];
                    mws.forEach(function(mw, i) {
                        if (!mw) { ctx.note(label, 'MiddlewareTCP ' + r.middlewares[i].raw + ' is not in the paste; paste it to migrate it.', 'warning'); return; }
                        let mlabel = 'MiddlewareTCP ' + mw.name + ' (' + mw.type + ')';
                        if (mw.type === 'ipAllowList' || mw.type === 'ipWhiteList') {
                            let ranges = list(mw.options.sourceRange).map(str);
                            let bad = ranges.filter(function(x) { return !isAddress(x); });
                            if (!ranges.length || bad.length) { ctx.note(mlabel, 'Traefik refused it (' + (bad.length ? 'bad range ' + bad.join(', ') : 'empty sourceRange') + '), so the TCP route served nothing.', 'warning'); snippet = null; return; }
                            if (snippet) { ranges.forEach(function(x) { snippet.push('allow ' + x + ';'); }); snippet.push('deny all;'); }
                        } else if (mw.type === 'inFlightConn') {
                            ctx.note(mlabel, 'inFlightConn capped connections per client; a TransportServer caps them per upstream server (upstreams[].maxConns), which is not the same.', 'warning');
                            svc._maxConns = goInt(mw.options.amount);
                        } else ctx.note(mlabel, 'No TransportServer equivalent.', 'warning');
                    });
                    if (snippet === null) return;
                    let base = { upstreams: [{ name: 'backend', service: str(svc.name), port: upstreamPort(svc.port, ctx, label + ' port') }], action: { pass: 'backend' } };
                    if (svc._maxConns) base.upstreams[0].maxConns = svc._maxConns;
                    let c0 = { 'spec.upstreams.0.service': label + ' route ' + (ri + 1) };
                    if (snippet.length) { base.serverSnippets = snippetBlock(snippet); c0['spec.serverSnippets'] = 'MiddlewareTCP ipAllowList — a TransportServer takes no Policy (-enable-snippets)'; }
                    if (pass) {
                        if (!snis.length) { ctx.note(label, 'TLS passthrough routes on SNI, and this route names no concrete host (HostSNI(`*`) is a catch-all a TransportServer cannot be).', 'warning'); return; }
                        snis.forEach(function(sni) {
                            let spec = {};
                            if (cls(ir.ingressClassName)) spec.ingressClassName = cls(ir.ingressClassName);
                            spec.listener = { name: 'tls-passthrough', protocol: 'TLS_PASSTHROUGH' };
                            spec.host = sni;
                            Object.assign(spec, JSON.parse(JSON.stringify(base)));
                            docs.push({ apiVersion: NIC_API, kind: 'TransportServer', metadata: md(tsName(ir.name + (snis.length > 1 ? '-' + sni.split('.')[0] : '')), ir.namespace), spec: spec });
                            comments.push(Object.assign({ 'spec.listener': 'tls.passthrough — run NGINX Ingress Controller with -enable-tls-passthrough', 'spec.host': 'HostSNI' }, c0));
                        });
                        return;
                    }
                    let ep = ir.entryPoints[0] || 'tcp';
                    let lname = dnsName(ep) + '-tcp';
                    listeners[lname] = listeners[lname] || { name: lname, protocol: 'TCP', entryPoint: ep };
                    let spec = {};
                    if (cls(ir.ingressClassName)) spec.ingressClassName = cls(ir.ingressClassName);
                    spec.listener = { name: lname, protocol: 'TCP' };
                    let c = Object.assign({ 'spec.listener': 'entryPoints ' + ep + ' — its port goes in the GlobalConfiguration' }, c0);
                    if (ir.tls) {
                        if (!snis.length) { ctx.note(label, 'Traefik terminated TLS on a catch-all; NGINX Ingress Controller needs spec.host with spec.tls.secret to terminate TLS on a TCP listener. Name the host.', 'warning'); return; }
                        if (snis.length > 1) ctx.note(label, 'Several SNIs on one TLS route; a TransportServer takes one host, so ' + snis[0] + ' is used.', 'warning');
                        spec.host = snis[0];
                        spec.tls = { secret: str(ir.tls.secretName) || dnsName(snis[0] + '-tls') };
                        if (!ir.tls.secretName) ctx.todo(label, 'the TLS Secret for ' + snis[0] + ' (Traefik used its default certificate or a resolver)');
                        c['spec.tls.secret'] = 'tls.secretName';
                    } else if (snis.length) {
                        ctx.note(label, 'HostSNI without TLS can match nothing: plain TCP carries no SNI, so Traefik routed this only if the client sent TLS. Migrated as a plain TCP listener.', 'warning');
                    }
                    Object.assign(spec, JSON.parse(JSON.stringify(base)));
                    docs.push({ apiVersion: NIC_API, kind: 'TransportServer', metadata: md(tsName(ir.name), ir.namespace), spec: spec });
                    comments.push(c);
                });
            });
            run.ingressRoutesUDP.forEach(function(ir) {
                let label = 'IngressRouteUDP ' + ir.name;
                let svcs = []; list(ir.spec.routes).forEach(function(r) { list(r && r.services).forEach(function(s) { if (isMap(s) && s.name) svcs.push(s); }); });
                if (!svcs.length) { ctx.note(label, 'names no service.', 'warning'); return; }
                let ep = ir.entryPoints[0] || 'udp';
                let lname = dnsName(ep) + '-udp';
                listeners[lname] = listeners[lname] || { name: lname, protocol: 'UDP', entryPoint: ep };
                let spec = {};
                if (targetClass(ir.ingressClassName, options)) spec.ingressClassName = targetClass(ir.ingressClassName, options);
                spec.listener = { name: lname, protocol: 'UDP' };
                spec.upstreams = [{ name: 'backend', service: str(svcs[0].name), port: upstreamPort(svcs[0].port, ctx, label + ' port') }];
                spec.upstreamParameters = { udpRequests: 1, udpResponses: 1 };
                spec.action = { pass: 'backend' };
                if (svcs.length > 1) ctx.note(label, 'Several services were weighted by Traefik; a TransportServer passes to one, so ' + svcs[0].name + ' is used.', 'warning');
                ctx.note(label, 'udpRequests and udpResponses (1 and 1) end a UDP session after one datagram each way, which suits DNS; set them to what your protocol exchanges.');
                docs.push({ apiVersion: NIC_API, kind: 'TransportServer', metadata: md(dnsName(ir.name), ir.namespace), spec: spec });
                comments.push({ 'spec.listener': 'entryPoints ' + ep });
            });
            return { docs: docs, comments: comments };
        }

        // --- The controller pass -----------------------------------------------
        // What Traefik configures once for every router, and NGINX Ingress
        // Controller once for every resource: TLS versions and ciphers (TLSOption
        // → nginx-config), client certificates (TLSOption clientAuth → an
        // ingressMTLS Policy), default certificates (TLSStore → a flag), backend
        // TLS (ServersTransport → an egressMTLS Policy), and the ConfigMap
        // fragments the middlewares wrote.
        let TLS_VERSIONS = ['VersionTLS10', 'VersionTLS11', 'VersionTLS12', 'VersionTLS13'];
        let TLS_NAMES = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
        function tlsProtocols(min, max) {
            let lo = min ? TLS_VERSIONS.indexOf(str(min)) : 2;
            let hi = max ? TLS_VERSIONS.indexOf(str(max)) : 3;
            if (lo === -1 || hi === -1 || lo > hi) return null;
            return TLS_NAMES.slice(lo, hi + 1).join(' ');
        }
        function controllerPass(run, ctx, frags, listeners, options) {
            let g = { docs: [], comments: [], cm: {}, cmComments: {}, http: [], httpSources: [] };
            let setCm = function(k, v, src) {
                if (g.cm[k] !== undefined && g.cm[k] !== String(v)) { ctx.note('ConfigMap ' + k, 'Two settings write it (' + g.cm[k] + ' vs ' + v + '); the ConfigMap is global, so the first is kept.', 'warning'); return; }
                g.cm[k] = String(v); g.cmComments[k] = src;
            };
            // Middleware fragments: ConfigMap keys and http-snippets lines, once.
            frags.forEach(function(f) {
                Object.keys(f.cm).forEach(function(k) { setCm(k, f.cm[k].value, f.cm[k].source); });
                f.http.forEach(function(l) { if (g.http.indexOf(l) === -1) g.http.push(l); });
                if (f.httpSource && g.httpSources.indexOf(f.httpSource) === -1) g.httpSources.push(f.httpSource);
            });
            run.tlsOptions.forEach(function(t) {
                let label = 'TLSOption ' + t.name;
                let o = t.spec;
                let isDefault = t.name === 'default';
                if (o.minVersion || o.maxVersion) {
                    let p = tlsProtocols(o.minVersion, o.maxVersion);
                    if (p) setCm('ssl-protocols', p, label + ' minVersion/maxVersion' + (isDefault ? '' : ' — global in NGINX Ingress Controller, per router in Traefik'));
                    else ctx.note(label, 'minVersion/maxVersion are not TLS versions Traefik names (VersionTLS10…13), so Traefik refused the option; not migrated.', 'warning');
                }
                if (list(o.cipherSuites).length) {
                    setCm('ssl-ciphers', list(o.cipherSuites).map(str).join(':'), label + ' cipherSuites — Go names; translate to OpenSSL names (ECDHE-RSA-AES256-GCM-SHA384…)');
                    ctx.todo('nginx-config ssl-ciphers', 'translate ' + label + '\'s Go cipher names to OpenSSL names');
                }
                if (list(o.curvePreferences).length) { g.http.push('ssl_ecdh_curve ' + list(o.curvePreferences).map(str).join(':') + ';'); g.httpSources.push(label + ' curvePreferences'); }
                if (isMap(o.clientAuth) && (list(o.clientAuth.secretNames).length || o.clientAuth.clientAuthType)) {
                    let types = { NoClientCert: 'off', VerifyClientCertIfGiven: 'optional', RequireAndVerifyClientCert: 'on', RequestClientCert: 'optional_no_ca', RequireAnyClientCert: 'optional_no_ca' };
                    let ty = str(o.clientAuth.clientAuthType) || 'NoClientCert';
                    if (ty !== 'NoClientCert') {
                        let secrets = list(o.clientAuth.secretNames).map(str);
                        g.docs.push({ apiVersion: NIC_API, kind: 'Policy', metadata: md(dnsName(t.name + '-mtls'), t.namespace), spec: { ingressMTLS: { clientCertSecret: secrets[0] || 'client-ca', verifyClient: types[ty] || 'on', verifyDepth: 1 } } });
                        g.comments.push({ 'spec.ingressMTLS.clientCertSecret': label + ' clientAuth.secretNames — type nginx.org/ca, key ca.crt' + (secrets.length > 1 ? ' (concatenate the ' + secrets.length + ' CA bundles)' : ''), 'spec.ingressMTLS.verifyClient': label + ' clientAuthType ' + ty });
                        if (!secrets.length) ctx.todo(label, 'the CA Secret (type nginx.org/ca) for client certificates');
                        ctx.note(label, 'Client certificates are per host in NGINX Ingress Controller: reference the ingressMTLS Policy from each VirtualServer that used this TLSOption.' + (ty === 'RequestClientCert' || ty === 'RequireAnyClientCert' ? ' ' + ty + ' has no exact match; optional_no_ca is nearest.' : ''), 'warning');
                    }
                }
                if (o.sniStrict === true) ctx.note(label, 'sniStrict: NGINX Ingress Controller refuses an unknown SNI when the -default-server-tls-secret controller flag is left unset.');
                if (list(o.alpnProtocols).length) ctx.note(label, 'alpnProtocols: NGINX Ingress Controller has no ALPN setting; HTTP/2 is per host (nginx.org/http2, spec.http2).', 'warning');
                if (o.disableSessionTickets === true) { g.http.push('ssl_session_tickets off;'); g.httpSources.push(label + ' disableSessionTickets'); }
            });
            run.tlsStores.forEach(function(t) {
                let label = 'TLSStore ' + t.name;
                let dc = isMap(t.spec.defaultCertificate) ? t.spec.defaultCertificate : null;
                if (dc && dc.secretName) ctx.note(label, 'defaultCertificate ' + dc.secretName + ': the -default-server-tls-secret controller flag (Helm controller.defaultTLS.secret) serves it for unknown hosts.');
                if (isMap(t.spec.defaultGeneratedCert)) ctx.note(label, 'defaultGeneratedCert used an ACME resolver; NGINX Ingress Controller has none — use cert-manager.', 'warning');
                if (list(t.spec.certificates).length) ctx.note(label, 'certificates: reference each Secret from its own VirtualServer spec.tls.secret.');
            });
            run.serversTransports.forEach(function(t) {
                let label = 'ServersTransport ' + t.name;
                let o = t.spec;
                let em = {};
                let c = {};
                let certs = list(o.certificatesSecrets).map(str);
                if (certs.length) { em.tlsSecret = certs[0]; c['spec.egressMTLS.tlsSecret'] = label + ' certificatesSecrets — type kubernetes.io/tls'; }
                let roots = list(o.rootCAs).map(function(r) { return isMap(r) ? (r.secret || null) : null; }).filter(Boolean).concat(list(o.rootCAsSecrets).map(str));
                if (roots.length) { em.trustedCertSecret = roots[0]; em.verifyServer = true; c['spec.egressMTLS.trustedCertSecret'] = label + ' rootCAs — type nginx.org/ca'; }
                if (o.insecureSkipVerify === true) em.verifyServer = false;
                if (o.serverName) { em.serverName = true; em.sslName = str(o.serverName); c['spec.egressMTLS.sslName'] = label + ' serverName'; }
                else if (em.verifyServer) { ctx.note(label, 'Traefik verified the backend certificate against the backend\'s address; egressMTLS checks sslName, which defaults to the upstream\'s internal name. Set sslName to the name in the certificate (often <service>.<namespace>.svc).', 'warning'); ctx.todo(label + ' sslName', 'the name the backend certificate carries'); }
                let p = tlsProtocols(o.minVersion, o.maxVersion);
                if ((o.minVersion || o.maxVersion) && p) em.protocols = p;
                if (list(o.cipherSuites).length) { ctx.note(label, 'cipherSuites are Go names; egressMTLS ciphers take OpenSSL names, so they are not migrated.', 'warning'); }
                if (!Object.keys(em).length) { ctx.note(label, 'Sets no TLS: nothing for an egressMTLS Policy.' ); }
                else {
                    g.docs.push({ apiVersion: NIC_API, kind: 'Policy', metadata: md(dnsName(t.name + '-egress-mtls'), t.namespace), spec: { egressMTLS: em } });
                    g.comments.push(c);
                    ctx.note(label, 'egressMTLS sets the TLS parameters only; the upstream must speak HTTPS too (upstreams[].tls.enable, or nginx.org/ssl-services). Reference the Policy from the routes whose services named this ServersTransport.');
                }
                if (o.forwardingTimeouts || o.maxIdleConnsPerHost !== undefined) {
                    let ft = isMap(o.forwardingTimeouts) ? o.forwardingTimeouts : {};
                    let bits = [];
                    if (ft.dialTimeout) bits.push('dialTimeout → connect-timeout ' + nginxTime(goDurationSeconds(ft.dialTimeout)));
                    if (ft.responseHeaderTimeout) bits.push('responseHeaderTimeout → read-timeout ' + nginxTime(goDurationSeconds(ft.responseHeaderTimeout)) + ' (NGINX times every read, not just the headers)');
                    if (o.maxIdleConnsPerHost !== undefined) bits.push('maxIdleConnsPerHost → keepalive ' + o.maxIdleConnsPerHost);
                    if (bits.length) ctx.note(label, 'Set on the upstreams of the routes that use it: ' + bits.join('; ') + '.');
                }
                if (o.spiffe) ctx.note(label, 'spiffe has no NGINX Ingress Controller equivalent.', 'warning');
            });
            run.serversTransportsTCP.forEach(function(t) { ctx.note('ServersTransportTCP ' + t.name, 'A TransportServer has no backend TLS fields; streamSnippets with proxy_ssl directives are the escape hatch (-enable-snippets).', 'warning'); });
            let ls = Object.keys(listeners).map(function(k) { return listeners[k]; });
            if (ls.length) {
                g.docs.push({ apiVersion: NIC_API, kind: 'GlobalConfiguration', metadata: { name: 'nginx-configuration', namespace: 'nginx-ingress' }, spec: { listeners: ls.map(function(l, i) { return { name: l.name, port: 10000 + i, protocol: l.protocol }; }) } });
                let gc = {};
                ls.forEach(function(l, i) { gc['spec.listeners.' + i + '.port'] = 'TODO: the port entryPoint ' + l.entryPoint + ' listened on'; });
                g.comments.push(gc);
                ls.forEach(function(l) { ctx.todo('GlobalConfiguration listener ' + l.name, 'the port the ' + l.entryPoint + ' entry point listened on (Traefik\'s static configuration)'); });
                ctx.note('GlobalConfiguration', 'Listeners need NGINX Ingress Controller started with -global-configuration=nginx-ingress/nginx-configuration, and their ports exposed on its Service.', 'warning');
            }
            if (g.http.length) setCm('http-snippets', g.http.join('\n') + '\n', g.httpSources.join(' + ') + ' — global: http-snippets apply to every resource, and a bad line fails every reload');
            return g;
        }

        // --- The run -----------------------------------------------------------
        // Every IngressRoute and annotated Ingress route as entries, grouped by
        // host into VirtualServers; an Ingress whose settings need it, or under
        // annotation-first, as the migrated Ingress; TCP/UDP; the controller pass.
        function migrateAll(run, strategy, options) {
            options = options || {};
            let ctx = makeCtx();
            let cache = {};
            let entries = collectRoutes(run, ctx, cache);
            let results = [];
            let allFrags = [];
            run.ingresses.forEach(function(m) {
                let res = ingressEntries(m, run, ctx, cache);
                let why = needsIngress(m, res);
                if (res.down) return;
                if (strategy === 'annotation' || why.length) {
                    if (strategy !== 'annotation' && why.length) ctx.note('Ingress ' + (m.name || ''), 'Kept as an Ingress under CRD-first: ' + why.join('; ') + '. A VirtualServer would lose ' + (why.length > 1 ? 'them' : 'it') + '.', 'warning');
                    let out = buildIngressDoc(m, res, run, ctx, options);
                    results.push({ docs: out.docs, comments: out.comments, model: m });
                    allFrags = allFrags.concat(res.entries.map(function(e) { return e.f; }));
                } else {
                    entries = entries.concat(res.entries);
                }
                if (!m.hosts.length && !m.hostless.length && m.defaultBackend) ctx.note('Ingress ' + (m.name || ''), 'Has only a defaultBackend, which NGINX Ingress Controller rejects (an Ingress needs a rule); give it a host-less rule with -allow-empty-ingress-host for a catch-all.', 'warning');
            });
            // Group the route entries by namespace and host.
            let groups = {}, order = [];
            entries.forEach(function(e) { let k = (e.namespace || '') + '\u0000' + e.host; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(e); });
            let used = {};
            order.forEach(function(k) {
                let es = groups[k];
                let out = buildHost(es[0].host, es[0].namespace, es, run, ctx, options, used);
                results.push({ docs: out.docs, comments: out.comments, model: null, host: es[0].host, entries: es });
                allFrags = allFrags.concat(es.map(function(e) { return e.f; }));
            });
            let listeners = {};
            let tcp = buildTCP(run, ctx, options, listeners);
            let g = controllerPass(run, ctx, allFrags, listeners, options);
            // Middlewares no route in the paste uses. Only said when the paste
            // has no router at all: with one, a Middleware it does not
            // name belongs to another router (nic-migrate report analyzes
            // each router with the whole run beside it).
            if (!run.ingressRoutes.length && !run.ingresses.length && !run.ingressRoutesTCP.length && !run.ingressRoutesUDP.length) run.middlewares.forEach(function(mw) {
                let key = (mw.namespace || '') + '/' + mw.name;
                if (!cache[key] && mw.type !== 'chain') {
                    let referenced = run.ingressRoutes.some(function(ir) { return ir.routes.some(function(r) { return r.middlewares.some(function(x) { return x.name === mw.name; }); }); })
                        || run.middlewares.some(function(c) { return c.type === 'chain' && list(c.options && c.options.middlewares).some(function(x) { return str(isMap(x) ? x.name : x) === mw.name; }); })
                        || run.ingresses.some(function(m) { return m.traefik['router.middlewares'] && m.traefik['router.middlewares'].value.indexOf(mw.name) !== -1; });
                    if (!referenced) ctx.note('Middleware ' + mw.name + ' (' + (mw.type || 'empty') + ')', 'No route in the paste uses it, so it applied to nothing here. Paste the IngressRoute or Ingress that names it to migrate it in place.');
                }
            });
            return { results: results, tcp: tcp, controller: g, ctx: ctx, cache: cache };
        }

        function buildPlan(parsed, strategy, options) {
            let run = parsed.run || emptyRun();
            let all = migrateAll(run, strategy, options);
            let ctx = all.ctx;
            let warnings = [];
            if (Object.keys(parsed.skipped || {}).length) warnings.push({ title: 'Documents skipped', message: Object.keys(parsed.skipped).map(function(k) { return parsed.skipped[k] + ' ' + k; }).join(', ') + ' — the analyzer reads traefik.io resources, annotated Ingresses and the Services they route to.' });
            let resources = [];
            all.results.forEach(function(r) { r.docs.forEach(function(d, i) { resources.push({ doc: d, comments: r.comments[i], old: oldFor(d, r, run), model: r.model }); }); });
            all.tcp.docs.forEach(function(d, i) { resources.push({ doc: d, comments: all.tcp.comments[i], old: rawTraefik(run, ['ingressRoutesTCP', 'ingressRoutesUDP'], d.metadata.name), model: null }); });
            all.controller.docs.forEach(function(d, i) { resources.push({ doc: d, comments: all.controller.comments[i], old: d.kind === 'GlobalConfiguration' ? '# entryPoints (Traefik static configuration)' : rawTraefik(run, ['tlsOptions', 'serversTransports'], d.metadata.name.replace(/-(mtls|egress-mtls)$/, '')), model: null }); });
            let infoNotes = ctx.notes.map(function(n) { return { code: n.code, message: n.message, severity: n.severity }; });
            ctx.todos.forEach(function(t) { infoNotes.push({ code: 'TODO ' + t.path, message: 'Fill in: ' + t.message + '.', severity: 'warning' }); });
            let classNote = 'Set the class NGINX Ingress Controller owns (Helm default "nginx"; to run both controllers side by side, install with --set controller.ingressClass.name=nginx-nic and pass --class to nic-migrate). A class naming Traefik is left off the migrated resources: NGINX Ingress Controller ignores a resource whose class it does not own, without an error, and claims one with none.';
            if (resources.some(function(r) { return r.doc.kind === 'Ingress' || r.doc.kind === 'VirtualServer' || r.doc.kind === 'TransportServer'; })) infoNotes.unshift({ code: 'ingressClassName', message: classNote, severity: 'note' });
            let usesSnippets = resources.some(function(r) {
                let s = r.doc.spec || {};
                let ann = (r.doc.metadata && r.doc.metadata.annotations) || {};
                return s.serverSnippets || s['server-snippets'] || (s.routes || []).some(function(rt) { return rt['location-snippets']; }) || ann['nginx.org/location-snippets'] || ann['nginx.org/server-snippets'];
            });
            if (usesSnippets) infoNotes.unshift({ code: 'snippets', message: 'This output uses snippets, which NGINX Ingress Controller rejects unless it runs with -enable-snippets (Helm: controller.enableSnippets=true).', severity: 'warning' });
            if (resources.some(function(r) { return r.doc.kind === 'TransportServer' && r.doc.spec.listener && r.doc.spec.listener.name === 'tls-passthrough'; })) infoNotes.unshift({ code: 'tls-passthrough', message: 'TLS passthrough is off by default in NGINX Ingress Controller: install with controller.enableTLSPassthrough=true (Helm) or -enable-tls-passthrough.', severity: 'warning' });
            // Unsupported and unrecognized, from the findings.
            let unsupportedCards = [], unrecognised = [], paths = {};
            parsed.findings.forEach(function(f) {
                let idx = TRAEFIK_LOOKUP.get(f.key);
                if (idx === undefined) { if (!unrecognised.some(function(u) { return u.label === f.label; })) unrecognised.push(f); return; }
                let mp = TRAEFIK_MAPPINGS[idx];
                paths[mp.source] = mp;
                if (mp.type === 'unsupported' && !unsupportedCards.some(function(c) { return c.title === mp.source && c.code.indexOf(f.label) !== -1; })) {
                    let card = unsupportedCards.find(function(c) { return c.title === mp.source; });
                    if (card) card.code += ', ' + f.label;
                    else unsupportedCards.push({ title: mp.source, code: f.label, desc: mp.nic, anchor: mp.anchor || null, sidebarSection: sectionIdFor(mp) });
                }
            });
            let steps = [];
            let ingressDocs = resources.filter(function(r) { return r.doc.kind === 'Ingress'; });
            if (ingressDocs.length) steps.push({ id: 'analyzer-step-1', title: 'Migrated Ingress', countText: ingressDocs.length + ' Ingress' + (ingressDocs.length !== 1 ? 'es' : ''), countCls: '',
                desc: 'Replace the Traefik annotations with these NGINX Ingress Controller ones. Every rule, TLS entry and backend is kept; settings Traefik read from a Service or a Middleware are applied here too.',
                blocks: ingressDocs.map(function(r) { return { type: 'comparison', old: { title: 'Traefik Proxy ', badge: 'current', yaml: r.old }, new: { title: 'NGINX Ingress Controller ', badge: 'migrated', yaml: docYaml(r.doc, r.comments), collapsible: true } }; }) });
            let cmData = all.controller.cm;
            let cmDoc = Object.keys(cmData).length ? { doc: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nginx-config' }, data: cmData }, comments: Object.keys(all.controller.cmComments).reduce(function(a, k) { a['data.' + k] = all.controller.cmComments[k]; return a; }, {}) } : null;
            if (cmDoc) steps.push({ id: 'analyzer-step-2', title: 'ConfigMap changes', countText: Object.keys(cmData).length + ' entr' + (Object.keys(cmData).length !== 1 ? 'ies' : 'y'), countCls: 'configmap',
                desc: 'These settings are global in NGINX Ingress Controller: merge them into the nginx-config ConfigMap (with Helm, the ConfigMap is named after the release unless controller.config.name is set). They apply to every Ingress and VirtualServer.',
                blocks: [{ type: 'comparison', old: { title: 'Traefik Proxy (current)', badge: null, yaml: '# Written by the Traefik resources above (TLSOption, middlewares)' }, new: { title: 'NGINX Ingress Controller (migrated)', badge: null, yaml: docYaml(cmDoc.doc, cmDoc.comments) } }] });
            let crd = resources.filter(function(r) { return r.doc.kind !== 'Ingress'; });
            if (crd.length) {
                let blocks = [{ type: 'crd-install-note' }];
                let byKind = {};
                crd.forEach(function(r) { (byKind[r.doc.kind] = byKind[r.doc.kind] || []).push(r); });
                ['Policy', 'VirtualServer', 'TransportServer', 'GlobalConfiguration'].forEach(function(kind) {
                    let group = byKind[kind];
                    if (!group) return;
                    blocks.push({ type: 'crd-group', kind: kind, countText: group.length + ' resource' + (group.length !== 1 ? 's' : ''),
                        items: group.map(function(r) { return { category: r.doc.metadata.name + (r.doc.spec && r.doc.spec.host ? ' — ' + r.doc.spec.host : ''), plusRequired: !!(r.doc.spec && (r.doc.spec.waf || (r.doc.spec.upstreams || []).some(function(u) { return u.healthCheck || u.backup; }))), dualSuffix: null,
                            old: { title: 'Traefik Proxy (current)', badge: null, yaml: r.old, collapsible: true }, new: { title: 'NGINX Ingress Controller (migrated)', badge: null, yaml: docYaml(r.doc, r.comments), collapsible: true } }; }) });
                });
                steps.push({ id: 'analyzer-step-3', title: 'CRD resources', countText: crd.length + ' resource' + (crd.length !== 1 ? 's' : ''), countCls: 'crd',
                    desc: 'One VirtualServer per host replaces the IngressRoutes (several on one host merge), with every route, backend and TLS secret, and references the Policies beside it. Install the CRDs, apply these, then remove the Traefik resources.', blocks: blocks });
            }
            let total = parsed.foundCount;
            let pathCount = Object.keys(paths).length;
            let flagged = infoNotes.filter(function(n) { return n.severity === 'warning'; }).length;
            let pills = [{ cls: 'found', text: total + ' Traefik item' + (total !== 1 ? 's' : '') + ' found', scrollTo: null },
                { cls: 'paths', text: pathCount + ' migration path' + (pathCount !== 1 ? 's' : ''), scrollTo: steps.length ? steps[0].id : null }];
            if (crd.length) pills.push({ cls: 'crds', text: crd.length + ' require CRDs', scrollTo: 'analyzer-step-3' });
            if (flagged) pills.push({ cls: 'unrecognized', text: flagged + ' need attention', scrollTo: 'analyzer-info-notes' });
            if (unrecognised.length) pills.push({ cls: 'unrecognized', text: unrecognised.length + ' unrecognized', scrollTo: 'analyzer-unrecognized' });
            let banner = {
                strongText: total ? total + ' Traefik item' + (total !== 1 ? 's' : '') + ' analyzed' : run.ingresses.length + ' Ingress' + (run.ingresses.length !== 1 ? 'es' : '') + ' with no Traefik settings',
                restText: (total ? ', ' + pathCount + ' migration path' + (pathCount !== 1 ? 's' : '') + ' across ' + steps.length + ' step' + (steps.length !== 1 ? 's' : '') : ' — the resources below still need the NGINX Ingress Controller class') + (flagged ? ' — ' + flagged + ' need' + (flagged === 1 ? 's' : '') + ' attention before you apply.' : '.'),
                complexity: flagged > 2 || unsupportedCards.length ? 'advanced' : (flagged || cmDoc || crd.length) ? 'moderate' : 'simple'
            };
            let parts = [];
            ingressDocs.forEach(function(r) { parts.push('# Migrated Ingress\n' + docYaml(r.doc, r.comments)); });
            if (cmDoc) parts.push('# Merge into the nginx-config ConfigMap (global)\n' + docYaml(cmDoc.doc, cmDoc.comments));
            crd.forEach(function(r) { parts.push('# ' + r.doc.kind + '\n' + docYaml(r.doc, r.comments)); });
            let nextItems = [{ text: 'Review the full migration checklist', anchor: '#checklist' }, { text: 'Browse all middleware and annotation mappings', anchor: '#mappings' }];
            if (crd.length) nextItems.push({ text: 'Install the required CRDs', anchor: '#installation' });
            nextItems.push({ text: 'Check the NGINX Ingress Controller docs', href: 'https://docs.nginx.com/nginx-ingress-controller/', external: true });
            return {
                pills: pills, liveText: pills.map(function(p) { return p.text; }).join(', '), banner: banner, warnings: warnings, steps: steps, infoNotes: infoNotes,
                unsupported: unsupportedCards.length ? { title: 'Unsupported features', countText: unsupportedCards.length + ' finding' + (unsupportedCards.length !== 1 ? 's' : ''), desc: 'These Traefik settings are recognized but have no NGINX Ingress Controller equivalent. Review each one and take the recommended action.', cards: unsupportedCards } : null,
                unrecognized: unrecognised.length ? { title: 'Unrecognized Traefik configuration', desc: 'These settings were not found in the migration database. They may be plugins, Traefik Hub features, or not yet mapped.',
                    items: unrecognised.map(function(f) { return { yaml: f.key.indexOf('annotation:') === 0 ? MigrationTool.yaml.stringify({ annotations: { [f.label]: f.value } }, null, { quote: function() { return true; } }).replace(/\n$/, '') : '# ' + f.label }; }) } : null,
                export: parts.length ? { parts: parts } : null,
                nextItems: nextItems,
                resources: resources.map(function(r) { return { doc: r.doc, comments: r.comments, ingress: r.model ? r.model.name : null, namespace: r.model ? r.model.namespace : (r.doc.metadata && r.doc.metadata.namespace) || null }; }),
                configMap: cmDoc ? cmDoc.doc : null
            };
        }
        // The Traefik objects behind a card.
        function rawTraefik(run, buckets, name) {
            let hit = null;
            buckets.forEach(function(b) { run[b].forEach(function(c) { if (!hit && (dnsName(c.name) === name || name.indexOf(dnsName(c.name)) === 0)) hit = c; }); });
            return hit ? rawYaml(hit.doc) : '# (written by the Traefik resources above)';
        }
        function oldFor(d, r, run) {
            if (r.model) return rawYaml(r.model.doc);
            if (d.kind === 'VirtualServer' && r.entries) {
                let docs = [], seen = {};
                r.entries.forEach(function(e) {
                    let ir = e.source.kind === 'IngressRoute' ? run.ingressRoutes.find(function(x) { return x.name === e.source.name; }) : run.ingresses.find(function(x) { return x.name === e.source.name; });
                    if (ir && !seen[ir.name]) { seen[ir.name] = true; docs.push(ir.doc); }
                    (e.mws || []).forEach(function(mw) { if (mw && mw.doc && !seen['mw:' + mw.name]) { seen['mw:' + mw.name] = true; docs.push(mw.doc); } });
                });
                return docs.map(rawYaml).join('\n---\n');
            }
            if (d.kind === 'Policy') {
                let from = (d._from || []).filter(function(m) { return m && m.doc; });
                return from.length ? from.map(function(m) { return rawYaml(m.doc); }).join('\n---\n') : '# (from the route middlewares)';
            }
            return '# (written by the Traefik resources above)';
        }

        // --- Mapping registry ----------------------------------------------------
        // keys: parseInput finding keys. The page's reference rows, the
        // unsupported cards and where.py read source / nic / anchor; the
        // analyzer translates by middleware type (TRANSLATORS), so a row's
        // generator names what documents it.
        const TRAEFIK_MAPPINGS = [
            // Ingress annotations — router.*
            { keys: ['annotation:router.entrypoints'], source: 'router.entrypoints', nic: 'GlobalConfiguration listeners + VirtualServer spec.listener — or — nginx.org/listen-ports, nginx.org/listen-ports-ssl', type: 'annotation', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateEntryPointsNote' },
            { keys: ['annotation:router.middlewares', 'annotation:service.middlewares'], source: 'router.middlewares / service.middlewares', nic: 'VirtualServer policies[] — or — nginx.org/policies (converted Policy names)', type: 'policy', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateMiddlewaresRefNote' },
            { keys: ['annotation:router.pathmatcher'], source: 'router.pathmatcher', nic: 'VirtualServer routes[].path syntax (=, prefix, ~)', type: 'virtualserver', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generatePathMatcherNote' },
            { keys: ['annotation:router.priority'], source: 'router.priority', nic: 'No direct equivalent — NGINX location precedence (exact > longest prefix > regex order) is fixed', type: 'unsupported', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true },
            { keys: ['annotation:router.rulesyntax'], source: 'router.rulesyntax', nic: 'Not applicable — deprecated Traefik v2-syntax toggle; convert v2 matchers (Headers, HeadersRegexp) to their v3 forms during migration', type: 'unsupported', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true },
            { keys: ['annotation:router.tls'], source: 'router.tls', nic: 'Ingress spec.tls / VirtualServer spec.tls.secret', type: 'virtualserver', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateRouterTLSNote' },
            { keys: ['annotation:router.tls.certresolver'], source: 'router.tls.certresolver', nic: 'cert-manager + VirtualServer tls.cert-manager.cluster-issuer', type: 'virtualserver', category: 'TLS & certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateCertResolverNote' },
            { keys: ['annotation:router.tls.domains.n.main', 'annotation:router.tls.domains.n.sans'], source: 'router.tls.domains.n.main / .sans', nic: 'cert-manager Certificate dnsNames', type: 'virtualserver', category: 'TLS & certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateTLSDomainsNote' },
            { keys: ['annotation:router.tls.options'], source: 'router.tls.options', nic: 'ConfigMap ssl-protocols, ssl-ciphers (global)', type: 'configmap', category: 'TLS & certificates', anchor: 'tls-certificates', section: 'oss', grouped: true, generator: 'generateTLSOptionsRefNote' },
            { keys: ['annotation:router.observability.accesslogs'], source: 'router.observability.accesslogs', nic: 'ConfigMap access-log-off (global)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateAccessLogsAnnotation' },
            { keys: ['annotation:router.observability.metrics'], source: 'router.observability.metrics', nic: 'No direct equivalent — NGINX Ingress Controller metrics are controller-global (-enable-prometheus-metrics controller flag)', type: 'unsupported', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true },
            { keys: ['annotation:router.observability.tracing', 'annotation:router.observability.traceverbosity'], source: 'router.observability.tracing / .traceverbosity', nic: 'ConfigMap otel-trace-in-http + otel-exporter-endpoint (global)', type: 'configmap', category: 'Observability', anchor: 'observability', section: 'oss', grouped: true, generator: 'generateTracingAnnotation' },
            // Ingress annotations — service.*
            { keys: ['annotation:service.nativelb'], source: 'service.nativelb (on the Service)', nic: 'nginx.org/use-cluster-ip', type: 'annotation', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateNativeLBSwap' },
            { keys: ['annotation:service.nodeportlb'], source: 'service.nodeportlb (on the Service)', nic: 'No direct equivalent — NGINX Ingress Controller balances pod endpoints (or the ClusterIP with use-cluster-ip), never NodePorts', type: 'unsupported', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true },
            { keys: ['annotation:service.passhostheader'], source: 'service.passhostheader (on the Service)', nic: 'Default behavior (Host: $host) — override via VirtualServer requestHeaders.set', type: 'virtualserver', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generatePassHostHeaderNote' },
            { keys: ['annotation:service.serversscheme'], source: 'service.serversscheme (on the Service)', nic: 'VirtualServer upstreams[].tls / type: grpc — or — nginx.org/ssl-services (https) / nginx.org/grpc-services (h2c)', type: 'annotation', category: 'Ingress annotations', anchor: 'annotations', section: 'oss', grouped: true, generator: 'generateServersSchemeSwap' },
            { keys: ['annotation:service.serverstransport'], source: 'service.serverstransport (on the Service)', nic: 'Policy CRD egressMTLS + VirtualServer upstream tuning', type: 'policy', category: 'Backend transport', anchor: 'backend-transport', section: 'oss', grouped: true, generator: 'generateServersTransportRefNote' },
            { keys: ['annotation:service.sticky.cookie', 'annotation:service.sticky.cookie.name', 'annotation:service.sticky.cookie.secure', 'annotation:service.sticky.cookie.samesite', 'annotation:service.sticky.cookie.domain', 'annotation:service.sticky.cookie.httponly', 'annotation:service.sticky.cookie.maxage', 'annotation:service.sticky.cookie.path'], source: 'service.sticky.cookie.* (on the Service)', nic: 'VirtualServer upstreams[].sessionCookie', type: 'virtualserver', category: 'Session affinity', anchor: 'session-affinity', section: 'oss', grouped: true, generator: 'generateStickyCookieVS' },

            // HTTP middlewares
            { keys: ['middleware:addPrefix'], source: 'Middleware addPrefix', nic: 'VirtualServer action.proxy.rewritePath', type: 'virtualserver', category: 'Rewrites', anchor: 'rewrites', section: 'oss', generator: 'generateAddPrefixVS' },
            { keys: ['middleware:basicAuth'], source: 'Middleware basicAuth', nic: 'Policy CRD basicAuth — or — nginx.org/basic-auth-secret + nginx.org/basic-auth-realm', type: 'policy', category: 'Authentication', anchor: 'authentication', section: 'oss', dualApproach: true, generator: 'generateBasicAuthPolicy' },
            { keys: ['middleware:buffering'], source: 'Middleware buffering', nic: 'VirtualServer upstreams[].client-max-body-size / client-body-buffer-size — or — nginx.org/client-max-body-size', type: 'virtualserver', category: 'Buffering & body size', anchor: 'buffering', section: 'oss', generator: 'generateBufferingVS' },
            { keys: ['middleware:chain'], source: 'Middleware chain', nic: 'Each chained middleware applied to the route in order (VirtualServer policies[] / nginx.org/policies)', type: 'policy', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss', generator: 'generateChainNote' },
            { keys: ['middleware:circuitBreaker'], source: 'Middleware circuitBreaker', nic: 'VirtualServer upstreams[].max-fails + fail-timeout (passive) — Plus: upstreams[].healthCheck (active)', type: 'virtualserver', category: 'Resilience', anchor: 'resilience', section: 'oss', generator: 'generateCircuitBreakerVS' },
            { keys: ['middleware:compress'], source: 'Middleware compress', nic: 'ConfigMap http-snippets (gzip directives — no compression key exists)', type: 'configmap', category: 'Compression', anchor: 'compression', section: 'oss', generator: 'generateCompressConfigMap' },
            { keys: ['middleware:contentType'], source: 'Middleware contentType', nic: 'No direct equivalent — NGINX proxies Content-Type untouched; Traefik-specific auto-detection control', type: 'unsupported', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss' },
            { keys: ['middleware:digestAuth'], source: 'Middleware digestAuth', nic: 'No direct equivalent — NGINX has no digest-auth module; re-issue credentials as htpasswd and use basicAuth', type: 'unsupported', category: 'Authentication', anchor: 'authentication', section: 'oss' },
            { keys: ['middleware:encodedCharacters'], source: 'Middleware encodedCharacters', nic: 'No direct equivalent — NGINX URI normalization is fixed; encoded-character allowances cannot be configured per route', type: 'unsupported', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss' },
            { keys: ['middleware:errors'], source: 'Middleware errors', nic: 'nginx.org/custom-http-errors + spec.defaultBackend (proxies, as Traefik) — or — VirtualServer routes[].errorPages (redirect)', type: 'virtualserver', category: 'Error handling', anchor: 'error-handling', section: 'oss', generator: 'generateErrorPagesVS' },
            { keys: ['middleware:forwardAuth'], source: 'Middleware forwardAuth', nic: 'Policy CRD externalAuth', type: 'policy', category: 'Authentication', anchor: 'authentication', section: 'oss', generator: 'generateExternalAuthPolicy' },
            { keys: ['middleware:grpcWeb'], source: 'Middleware grpcWeb', nic: 'No direct equivalent — NGINX Ingress Controller has no gRPC-Web-to-gRPC translation (nginx.org/grpc-services proxies native gRPC only); keep a gRPC-Web proxy in the pod', type: 'unsupported', category: 'Miscellaneous', anchor: 'miscellaneous', section: 'oss' },
            { keys: ['middleware:headers'], source: 'Middleware headers', nic: 'VirtualServer requestHeaders + responseHeaders, Policy CRD cors — or — nginx.org/add-header, nginx.org/proxy-set-headers, nginx.org/hsts*', type: 'policy', category: 'CORS & headers', anchor: 'headers', section: 'oss', generator: 'generateHeadersContributions' },
            { keys: ['middleware:inFlightReq'], source: 'Middleware inFlightReq', nic: 'nginx.org/location-snippets (limit_conn) + ConfigMap http-snippets (limit_conn_zone)', type: 'annotation', category: 'Rate limiting & concurrency', anchor: 'rate-limiting', section: 'oss', generator: 'generateInFlightReqNote' },
            { keys: ['middleware:ipAllowList', 'middleware:ipWhiteList'], source: 'Middleware ipAllowList', nic: 'Policy CRD accessControl', type: 'policy', category: 'Access control', anchor: 'access-control', section: 'oss', generator: 'generateAccessControlPolicy' },
            { keys: ['middleware:passTLSClientCert'], source: 'Middleware passTLSClientCert', nic: 'VirtualServer requestHeaders.set with ${ssl_client_escaped_cert} / ${ssl_client_s_dn} (+ ingressMTLS Policy)', type: 'virtualserver', category: 'Access control', anchor: 'access-control', section: 'oss', generator: 'generatePassTLSClientCertVS' },
            { keys: ['middleware:rateLimit'], source: 'Middleware rateLimit', nic: 'Policy CRD rateLimit — or — nginx.org/limit-req-rate + nginx.org/limit-req-burst', type: 'policy', category: 'Rate limiting & concurrency', anchor: 'rate-limiting', section: 'oss', dualApproach: true, generator: 'generateRateLimitPolicy' },
            { keys: ['middleware:redirectRegex'], source: 'Middleware redirectRegex', nic: 'VirtualServer action.redirect (static URL) / location-snippets rewrite (captures)', type: 'virtualserver', category: 'Redirects', anchor: 'redirects', section: 'oss', generator: 'generateRedirectRegexVS' },
            { keys: ['middleware:redirectScheme'], source: 'Middleware redirectScheme', nic: 'VirtualServer tls.redirect — or — nginx.org/redirect-to-https + nginx.org/http-redirect-code', type: 'virtualserver', category: 'Redirects', anchor: 'redirects', section: 'oss', dualApproach: true, generator: 'generateRedirectSchemeVS' },
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
            { keys: ['traefikservice:weighted'], source: 'TraefikService (weighted)', nic: 'VirtualServer routes[].splits', type: 'virtualserver', category: 'Traffic splitting', anchor: 'traffic-splitting', section: 'oss', generator: 'generateSplitsFromWeighted' },
            { keys: ['traefikservice:mirroring'], source: 'TraefikService (mirroring)', nic: 'nginx.org/location-snippets + nginx.org/server-snippets (mirror directives)', type: 'annotation', category: 'Traffic splitting', anchor: 'traffic-splitting', section: 'oss', generator: 'generateMirroringNote' },
            { keys: ['traefikservice:failover'], source: 'TraefikService (failover)', nic: 'VirtualServer/VirtualServerRoute upstreams[].backup + backupPort — partial (fires on upstream unavailability, not errors.status; backup must be an ExternalName Service, NGINX Plus)', type: 'virtualserver', category: 'Traffic splitting', anchor: 'traffic-splitting', section: 'oss', generator: 'generateFailoverVS' },
            { keys: ['traefikservice:highestRandomWeight'], source: 'TraefikService (highestRandomWeight)', nic: 'No direct equivalent — VirtualServer upstreams balance round_robin, least_conn, ip_hash, hash, random or least_time', type: 'unsupported', category: 'Traffic splitting', anchor: 'traffic-splitting', section: 'oss' },
            { keys: ['kind:TLSOption'], source: 'TLSOption', nic: 'ConfigMap ssl-protocols / ssl-ciphers + Policy ingressMTLS (clientAuth)', type: 'configmap', category: 'TLS & certificates', anchor: 'tls-certificates', section: 'oss', generator: 'generateTLSOptionContributions' },
            { keys: ['kind:TLSStore'], source: 'TLSStore', nic: '-default-server-tls-secret controller flag + per-host TLS Secrets', type: 'configmap', category: 'TLS & certificates', anchor: 'tls-certificates', section: 'oss', generator: 'generateTLSStoreNote' },
            { keys: ['kind:ServersTransport'], source: 'ServersTransport', nic: 'Policy CRD egressMTLS + VirtualServer upstream tuning', type: 'policy', category: 'Backend transport', anchor: 'backend-transport', section: 'oss', generator: 'generateEgressMTLSFromServersTransport' },
            { keys: ['kind:ServersTransportTCP'], source: 'ServersTransportTCP', nic: 'No direct equivalent — TransportServer has no backend-TLS fields; use serverSnippets/streamSnippets as an escape hatch', type: 'unsupported', category: 'Backend transport', anchor: 'backend-transport', section: 'oss' },

            // Traefik Hub (commercial) middlewares → NGINX Plus
            { keys: ['middleware:jwt'], source: 'Middleware jwt (Hub)', nic: 'Policy CRD jwt (NGINX Plus)', type: 'policy', category: 'JWT authentication', anchor: 'jwt-authentication', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:oidc'], source: 'Middleware oidc (Hub)', nic: 'Policy CRD oidc (NGINX Plus)', type: 'policy', category: 'OIDC authentication', anchor: 'oidc-authentication', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:apiKey'], source: 'Middleware apiKey (Hub)', nic: 'Policy CRD apiKey', type: 'policy', category: 'API key authentication', anchor: 'api-key-authentication', section: 'plus', generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:waf'], source: 'Middleware waf (Hub)', nic: 'Policy CRD waf (NGINX Plus, via nginx.com/policies on Ingress)', type: 'policy', category: 'WAF', anchor: 'waf', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:distributedRateLimit'], source: 'Middleware distributedRateLimit (Hub)', nic: 'Policy CRD rateLimit + zone-sync ConfigMap keys (NGINX Plus)', type: 'policy', category: 'Distributed rate limiting', anchor: 'distributed-rate-limiting', section: 'plus', plusRequired: true, generator: 'generateHubMiddlewareNote' },
            { keys: ['middleware:hmac', 'middleware:ldap', 'middleware:oAuth2ClientCredentials', 'middleware:oauth2ClientCredentials', 'middleware:oauth2TokenIntrospection', 'middleware:opa'], source: 'Middleware hmac / ldap / oauth2* / opa (Hub)', nic: 'No direct equivalent — nearest paths: externalAuth Policy fronting an LDAP/OPA auth service, or the oidc Policy for OAuth2 flows', type: 'unsupported', category: 'Other Hub middlewares', anchor: 'hub-other', section: 'plus' }
        ];

        const TRAEFIK_LOOKUP = new Map();
        TRAEFIK_MAPPINGS.forEach(function(mapping, idx) { mapping.keys.forEach(function(key) { TRAEFIK_LOOKUP.set(key, idx); }); });

        // For nic-migrate: one result per routing document (IngressRoute,
        // IngressRouteTCP/UDP, Ingress), holding the resources built for it. A
        // VirtualServer shared by several (one host) belongs to the first, and
        // the rest carry mergedInto. The controller pass is .controller.
        function migrateMany(docs, strategy, options, runDocs) {
            let run = runOf(runDocs || docs);
            let all = migrateAll(run, strategy, options || {});
            let units = docs.map(function(d) { return { kind: str(d && d.kind), name: str(d && d.metadata && d.metadata.name) }; });
            let outFor = units.map(function() { return { docs: [], comments: [], notes: [], todos: [], unsupported: [], unrecognized: [], configMap: null, sources: [] }; });
            let mergedInto = units.map(function() { return null; });
            let indexOf = function(kind, name) { return units.findIndex(function(u) { return u.kind === kind && u.name === name; }); };
            all.results.forEach(function(r) {
                let owners = r.model ? [indexOf('Ingress', r.model.name)] : (r.entries || []).map(function(e) { return indexOf(e.source.kind, e.source.name); }).filter(function(i, k, a) { return i !== -1 && a.indexOf(i) === k; });
                if (!owners.length || owners[0] === -1) return;
                r.docs.forEach(function(d, i) { outFor[owners[0]].docs.push(d); outFor[owners[0]].comments.push(r.comments[i]); });
                owners.slice(1).forEach(function(o) { if (mergedInto[o] === null) mergedInto[o] = owners[0]; });
            });
            all.tcp.docs.forEach(function(d, i) {
                let o = units.findIndex(function(u) { return /^IngressRoute(TCP|UDP)$/.test(u.kind) && d.metadata.name.indexOf(dnsName(u.name)) === 0; });
                if (o !== -1) { outFor[o].docs.push(d); outFor[o].comments.push(all.tcp.comments[i]); }
            });
            // Notes go to the unit they name, else to the controller.
            let rest = [];
            all.ctx.notes.forEach(function(n) {
                let o = units.findIndex(function(u) { return str(n.code).indexOf(u.kind + ' ' + u.name) === 0; });
                (o !== -1 ? outFor[o].notes : rest).push({ name: n.code, message: n.message, severity: n.severity });
            });
            let g = all.controller;
            let outs = outFor.map(function(o, i) { return { out: o, mergedInto: mergedInto[i] }; });
            outs.controller = { docs: g.docs, comments: g.comments, notes: rest, todos: all.ctx.todos, unsupported: [], unrecognised: [], cmData: g.cm, cmComments: g.cmComments };
            return outs;
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
                noFindings: { title: 'No Traefik configuration found.', message: 'Make sure your YAML contains Traefik resources (IngressRoute, Middleware, TraefikService, …) or Ingress annotations with the traefik.ingress.kubernetes.io/ prefix.' },
                emptyStateLead: 'Paste your Traefik YAML above and click Analyze',
                emptyStateHint: 'Drag & drop a .yaml file, or try "Load Sample" for an example',
                pageNames: { 'getting-started': 'Getting started', analyzer: 'Config analyzer', reference: 'Reference guide' }
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
                    overview: 'getting-started', 'why-migrate': 'getting-started', features: 'getting-started', installation: 'getting-started', checklist: 'getting-started', 'phased-migration': 'getting-started', cli: 'getting-started', resources: 'getting-started',
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
                        annotation: 'Keep an annotated Ingress an Ingress with nginx.org/* annotations; IngressRoutes still become VirtualServers',
                        crd: 'VirtualServers and Policies throughout; an Ingress stays one only where a setting has no VirtualServer form'
                    }
                },
                samplePresets: SAMPLE_PRESETS,
                defaultPreset: 'moderate',
                parseInput: parseInput,
                buildPlan: buildPlan,
                mappings: TRAEFIK_MAPPINGS,
                // nic-migrate: one document resolved against the run, and the run.
                migrate: function(doc, strategy, options, runDocs) {
                    let outs = migrateMany([doc], strategy, options, runDocs || [doc]);
                    return outs[0].out;
                },
                migrateMany: function(docs, strategy, options, runDocs) { return migrateMany(docs, strategy, options, runDocs); }
            },
            export: {
                filename: 'traefik-nginx-migration.yaml',
                header: '# Traefik to NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/traefik-migration.html'
            }
        };
    })();
