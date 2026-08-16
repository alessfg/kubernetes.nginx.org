'use strict';
/* convert.js — assemble applyable manifests from the engine's output.
   =========================================================================
   The division of labour here is the whole idea:

     the engine supplies correct NIC *values*   — it knows that limit-rps: 5
                                                  becomes rate: 5r/s with a
                                                  burst, that affinity: cookie
                                                  becomes a sessionCookie block
     this file supplies correct *structure*     — one resource per host, every
                                                  route, every backend, policies
                                                  wired, TLS and namespace kept

   So nothing re-implements a mapping. Each generated resource is parsed back
   into data, its distinguishing fragment is lifted out, and the fragment is
   grafted onto a resource built from the real Ingress spec. A mapping fixed on
   the page is fixed here on the next run, which is the same guarantee stage 1
   has.

   Community annotations are Ingress-scoped, so a fragment derived from one
   applies to every route or upstream of that Ingress. That is why grafting is
   sound rather than a guess.
   ========================================================================= */

const yaml = require('./yaml');

const NIC_API = 'k8s.nginx.org/v1';

/* ------------------------------------------------------------------ model */

function toModel(doc) {
    const md = doc.metadata || {};
    const spec = doc.spec || {};
    const annotations = md.annotations || {};
    const rules = Array.isArray(spec.rules) ? spec.rules : [];

    const tlsByHost = new Map();
    for (const entry of (Array.isArray(spec.tls) ? spec.tls : [])) {
        for (const h of (entry.hosts || [])) tlsByHost.set(h, entry.secretName || null);
    }

    return {
        name: md.name || 'unnamed',
        namespace: md.namespace || null,
        ingressClassName: spec.ingressClassName || annotations['kubernetes.io/ingress.class'] || null,
        annotations,
        communityAnnotations: Object.keys(annotations)
            .filter((k) => k.startsWith('nginx.ingress.kubernetes.io/'))
            .reduce((acc, k) => { acc[k.slice('nginx.ingress.kubernetes.io/'.length)] = annotations[k]; return acc; }, {}),
        defaultBackend: spec.defaultBackend || null,
        tlsByHost,
        hosts: rules.map((r) => ({
            host: r.host || null,
            tlsSecret: tlsByHost.get(r.host) || null,
            paths: (((r.http || {}).paths) || []).map((p) => ({
                path: p.path || '/',
                pathType: p.pathType || 'ImplementationSpecific',
                service: ((p.backend || {}).service || {}).name || null,
                port: (((p.backend || {}).service || {}).port || {}).number
                    || (((p.backend || {}).service || {}).port || {}).name
                    || null
            }))
        })).filter((h) => h.host)
    };
}

/* -------------------------------------------------------- engine fragments */

/* Parse the engine's generated documents back into data and lift out the parts
   that distinguish each one. Comment-only preambles are stripped first — the
   generators prefix some resources with an explanatory comment block. */
function readGenerated(parts) {
    const out = { policies: [], upstreamExtras: {}, proxyExtras: {}, routeExtras: {}, redirect: null, transportServers: [], unmergeable: [] };

    for (const part of parts) {
        if (/^#\s*Step 1:/.test(part) || /^#\s*Step 2:/.test(part)) continue; // swaps + ConfigMap handled elsewhere
        const bodyText = part.replace(/^#[^\n]*\n/, '');
        let doc;
        try {
            doc = yaml.parse(bodyText);
        } catch {
            continue;
        }
        if (!doc || !doc.kind) continue;

        if (doc.kind === 'Policy') { out.policies.push(doc); continue; }
        if (doc.kind === 'TransportServer') { out.transportServers.push(doc); continue; }
        if (doc.kind !== 'VirtualServer') continue;

        const spec = doc.spec || {};
        const up = (spec.upstreams || [])[0] || {};
        for (const [k, v] of Object.entries(up)) {
            if (k === 'name' || k === 'service' || k === 'port') continue;
            out.upstreamExtras[k] = v;
        }
        const route = (spec.routes || [])[0] || {};
        const action = route.action || {};
        if (action.redirect) out.redirect = action.redirect;
        for (const [k, v] of Object.entries(action.proxy || {})) {
            if (k === 'upstream') continue;
            out.proxyExtras[k] = v;
        }
        for (const [k, v] of Object.entries(route)) {
            if (k === 'path' || k === 'action') continue;
            out.routeExtras[k] = v;
        }
        /* splits/matches describe traffic shape that cannot be inferred from a
           single Ingress — canary needs the other Ingress to know about. */
        if (spec.upstreams && spec.upstreams.some((u) => /TODO/.test(String(u.service)))) {
            out.unmergeable.push({ kind: doc.kind, name: (doc.metadata || {}).name, reason: 'references a service the analyzer could not infer' });
        }
    }
    return out;
}

/* The nginx.org/* annotation block the engine produced for the whole Ingress. */
function readSwaps(plan) {
    const blocks = [];
    for (const step of (plan && plan.steps) || []) {
        for (const b of step.blocks || []) {
            if (b.type === 'comparison' && b.new && b.new.yaml) blocks.push(b.new.yaml);
        }
    }
    if (!blocks.length) return {};
    const merged = {};
    for (const block of blocks) {
        let parsed;
        try {
            parsed = yaml.parse(block);
        } catch {
            continue;
        }
        Object.assign(merged, (parsed && parsed.annotations) || {});
    }
    // Annotation values must be strings.
    for (const k of Object.keys(merged)) {
        if (merged[k] !== null && typeof merged[k] !== 'string') merged[k] = String(merged[k]);
    }
    return merged;
}

/* ------------------------------------------------------------------ paths */

const REGEX_CHARS = /[()*+?[\]{}|^$\\]/;

/* Ingress pathType -> VirtualServer path syntax. NIC takes a bare prefix, "="
   for exact, and "~" for a case-sensitive regex. */
function toVsPath(p, hasRewrite) {
    if (p.pathType === 'Exact') return '= ' + p.path;
    if (REGEX_CHARS.test(p.path)) return '~ ^' + p.path;
    if (hasRewrite && p.path !== '/') return '~ ^' + p.path;
    return p.path;
}

function sanitiseName(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'app';
}

/* --------------------------------------------------------------- assembly */

function buildVirtualServers(model, gen, opts) {
    const docs = [];
    const notes = [];
    const policyNames = gen.policies.map((p) => (p.metadata || {}).name).filter(Boolean);
    const hasRewrite = Boolean(gen.proxyExtras.rewritePath);

    for (const hostEntry of model.hosts) {
        const upstreams = [];
        const byKey = new Map();
        for (const p of hostEntry.paths) {
            if (!p.service) { notes.push('skipped a path with no backend service on ' + hostEntry.host); continue; }
            const key = p.service + ':' + p.port;
            if (!byKey.has(key)) {
                const base = sanitiseName(p.service);
                let name = base;
                let n = 2;
                while (upstreams.some((u) => u.name === name)) name = base + '-' + n++;
                const upstream = { name, service: p.service, port: p.port };
                Object.assign(upstream, gen.upstreamExtras);
                upstreams.push(upstream);
                byKey.set(key, name);
            }
        }

        const routes = hostEntry.paths.filter((p) => p.service).map((p) => {
            const route = { path: toVsPath(p, hasRewrite) };
            /* rewritePath is Ingress-scoped in the community controller, but a
               target referencing $1 needs the path to actually have a capture
               group. Copying "/$1" onto a plain "/" route rewrites every
               request to "/" — faithful to the source annotation and almost
               never what anyone meant. Drop it there and say so. */
            const proxyExtras = Object.assign({}, gen.proxyExtras);
            if (typeof proxyExtras.rewritePath === 'string' && /\$\d/.test(proxyExtras.rewritePath) && !/\(/.test(p.path)) {
                delete proxyExtras.rewritePath;
                notes.push('rewritePath "' + gen.proxyExtras.rewritePath + '" was not applied to path "' + p.path +
                    '" — that path has no capture group for the $n reference');
            }
            if (gen.redirect) {
                route.action = { redirect: Object.assign({}, gen.redirect) };
            } else if (Object.keys(proxyExtras).length) {
                route.action = { proxy: Object.assign({ upstream: byKey.get(p.service + ':' + p.port) }, proxyExtras) };
            } else {
                route.action = { pass: byKey.get(p.service + ':' + p.port) };
            }
            Object.assign(route, gen.routeExtras);
            return route;
        });

        if (!routes.length) { notes.push('no routable paths for ' + hostEntry.host + ' — no VirtualServer emitted'); continue; }

        const spec = {};
        const cls = opts.ingressClass || model.ingressClassName;
        if (cls) spec.ingressClassName = cls;
        spec.host = hostEntry.host;
        if (hostEntry.tlsSecret) {
            spec.tls = { secret: hostEntry.tlsSecret };
            const redirect = model.communityAnnotations['ssl-redirect'];
            if (redirect === undefined || String(redirect) === 'true') {
                spec.tls.redirect = { enable: true };
            }
        }
        if (policyNames.length) spec.policies = policyNames.map((n) => ({ name: n }));
        spec.upstreams = upstreams;
        spec.routes = routes;

        /* One host keeps the Ingress's own name, so the common case round-trips
           to something recognisable; several hosts need a per-host suffix
           because a VirtualServer binds exactly one host. */
        const suffix = model.hosts.length > 1 ? '-' + hostEntry.host.split('.')[0] : '';
        const metadata = { name: sanitiseName(model.name + suffix) };
        if (model.namespace) metadata.namespace = model.namespace;

        docs.push({ apiVersion: NIC_API, kind: 'VirtualServer', metadata, spec });
    }
    return { docs, notes };
}

function buildIngress(model, gen, swaps, opts) {
    const notes = [];
    const annotations = {};
    // Keep everything that is not a community annotation, then add the swaps.
    for (const [k, v] of Object.entries(model.annotations)) {
        if (k.startsWith('nginx.ingress.kubernetes.io/')) continue;
        if (k === 'kubernetes.io/ingress.class') continue; // superseded by spec.ingressClassName
        annotations[k] = v;
    }
    Object.assign(annotations, swaps);

    const policyNames = gen.policies.map((p) => (p.metadata || {}).name).filter(Boolean);
    if (policyNames.length) annotations['nginx.org/policies'] = policyNames.join(',');

    const spec = {};
    const cls = opts.ingressClass || model.ingressClassName;
    if (cls) spec.ingressClassName = cls;
    if (model.defaultBackend) spec.defaultBackend = model.defaultBackend;
    const tls = [];
    const seen = new Set();
    for (const h of model.hosts) {
        if (!h.tlsSecret || seen.has(h.tlsSecret)) continue;
        seen.add(h.tlsSecret);
        tls.push({ hosts: model.hosts.filter((x) => x.tlsSecret === h.tlsSecret).map((x) => x.host), secretName: h.tlsSecret });
    }
    if (tls.length) spec.tls = tls;
    spec.rules = model.hosts.map((h) => ({
        host: h.host,
        http: {
            paths: h.paths.map((p) => ({
                path: p.path,
                pathType: p.pathType,
                backend: { service: { name: p.service, port: typeof p.port === 'number' ? { number: p.port } : { name: p.port } } }
            }))
        }
    }));

    const metadata = { name: model.name };
    if (model.namespace) metadata.namespace = model.namespace;
    if (Object.keys(annotations).length) metadata.annotations = annotations;

    /* Features with no annotation form are the reason this target is not always
       enough — say so rather than emitting an Ingress that quietly does less. */
    const vsOnly = Object.keys(gen.proxyExtras).concat(Object.keys(gen.routeExtras));
    if (vsOnly.length) {
        notes.push('these need a VirtualServer and are absent from the Ingress target: ' + vsOnly.join(', '));
    }
    if (gen.redirect) notes.push('a redirect action needs a VirtualServer and is absent from the Ingress target');

    return { docs: [{ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata, spec }], notes };
}

function withNamespace(doc, namespace) {
    if (!namespace) return doc;
    const copy = JSON.parse(JSON.stringify(doc));
    copy.metadata = copy.metadata || {};
    if (!copy.metadata.namespace) copy.metadata.namespace = namespace;
    return copy;
}

/* Strip the TODO placeholders the generators emit so the output is valid YAML,
   and report each one — an unresolved TODO is a decision, not a value. */
function extractTodos(doc, path, todos) {
    if (Array.isArray(doc)) {
        doc.forEach((v, i) => extractTodos(v, path + '[' + i + ']', todos));
        return doc;
    }
    if (doc && typeof doc === 'object') {
        for (const [k, v] of Object.entries(doc)) {
            if (typeof v === 'string' && /TODO/.test(v)) todos.push(path + '.' + k);
            else extractTodos(v, path + '.' + k, todos);
        }
    }
    return doc;
}

function convert(model, result, opts) {
    const gen = readGenerated(result.parts || []);
    const swaps = readSwaps(result.plan);
    const built = opts.target === 'ingress'
        ? buildIngress(model, gen, swaps, opts)
        : buildVirtualServers(model, gen, opts);

    const docs = built.docs.slice();
    const notes = built.notes.slice();

    for (const policy of gen.policies) docs.push(withNamespace(policy, model.namespace));
    for (const ts of gen.transportServers) {
        docs.push(withNamespace(ts, model.namespace));
        notes.push('a TransportServer was emitted separately — it carries L4 traffic and cannot merge into a VirtualServer');
    }
    for (const u of gen.unmergeable) notes.push(u.kind + '/' + u.name + ': ' + u.reason);

    const todos = [];
    for (const doc of docs) extractTodos(doc, doc.kind, todos);
    for (const t of todos) notes.push('unresolved placeholder at ' + t + ' — the analyzer could not infer this value');

    if (opts.target !== 'ingress' && Object.keys(swaps).length) {
        /* VirtualServer has native fields for most of these, but not all; the
           ones with no field are the reason an Ingress target still exists. */
        notes.push('annotation swaps not represented on the VirtualServer: ' + Object.keys(swaps).join(', ') +
            ' — review against the VirtualServer reference, or use --target ingress');
    }

    return { docs, notes, policies: gen.policies.length, swaps };
}

module.exports = { toModel, convert, readGenerated, readSwaps, toVsPath, sanitiseName };
