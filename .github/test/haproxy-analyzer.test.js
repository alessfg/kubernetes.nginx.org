'use strict';
/* The HAProxy analyzer held to the rules analyzer.test.js holds ingress-nginx
   to: what a migration must do whatever the engine does inside. Each rule runs
   over every mapped HAProxy key under both strategies and over the samples,
   so a failure names its rule, the input, the strategy and the card.
   conversions.test.js covers the value transforms one by one. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadAnalyzer, analyze } = require('./lib/load.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-haproxy.js');
const Y = tool.yaml;
const mod = fs.readFileSync(path.join(ROOT, 'assets/js/migration-haproxy.js'), 'utf8');

const run = (yaml, strategy) => {
    const before = warnings.length;
    const r = analyze(source, yaml, strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))) });
};
const ingress = (ann) => Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: ann },
    spec: { tls: [{ hosts: ['a.example.com'], secretName: 'a-tls' }], rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
const configMap = (data) => Y.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'haproxy-kubernetes-ingress' }, data });

// A value each key accepts, so the branch that translates it runs.
const VALUES = {
    'allow-list': '10.0.0.0/8', 'deny-list': '10.1.0.0/16', whitelist: '10.0.0.0/8', blacklist: '10.1.0.0/16', 'src-ip-header': 'X-Real-IP',
    'auth-type': 'basic-auth', 'auth-secret': 'default/users', 'auth-realm': 'Members', 'server-ca': 'default/backend-ca', 'server-crt': 'default/client-crt',
    'server-proto': 'h2', 'cookie-persistence': 'SRV', 'cookie-persistence-no-dynamic': 'SRV', 'rate-limit-requests': '10', 'rate-limit-period': '1s',
    'rate-limit-size': '100k', 'rate-limit-status-code': '429', 'rate-limit-whitelist': '10.0.0.0/8', 'cors-allow-origin': 'https://a.example.com',
    'cors-allow-methods': 'GET, POST', 'cors-allow-headers': 'X-Custom', 'cors-max-age': '1m', 'request-set-header': 'X-From haproxy',
    'response-set-header': 'X-Served-By nginx', 'set-host': 'internal.example.com', 'request-capture': 'hdr(User-Agent)', 'request-capture-len': '64',
    'check-http': '/healthz', 'check-interval': '5s', 'timeout-check': '2s', 'load-balance': 'leastconn', 'scale-server-slots': '42',
    'path-rewrite': '/old/(.*) /new/\\1', 'request-redirect': 'example.com', 'request-redirect-code': '301', 'ssl-redirect-code': '301',
    'ssl-redirect-port': '8443', 'timeout-server': '30s', 'pod-maxconn': '100', 'ingress.class': 'haproxy',
    'backend-config-snippet': 'http-send-name-header x-dst-server', 'cr-backend': 'be', 'send-proxy-protocol': 'proxy-v2', 'forwarded-for': 'false',
    'route-acl': 'rand(100) lt 25',
    'syslog-server': 'address:10.0.0.1, port:514, facility:local0, level:info', 'log-format': '%ci %ST', 'log-format-tcp': '%ci', 'http-connection-mode': 'http-keep-alive',
    'global-config-snippet': 'ssl-default-bind-ciphers ECDHE\ntune.bufsize 32768', 'frontend-config-snippet': 'http-request deny if { path /x }',
    'stats-config-snippet': 'stats show-node', 'ssl-certificate': 'default/cert', 'tls-alpn': 'h2,http/1.1', 'client-ca': 'default/ca', 'proxy-protocol': '10.0.0.0/8',
    maxconn: '2000', nbthread: '4', 'hard-stop-after': '30s', 'timeout-connect': '5s', 'timeout-client': '50s', 'timeout-http-request': '5s',
    'timeout-http-keep-alive': '1m', 'timeout-queue': '5s', 'timeout-tunnel': '1h', 'timeout-client-fin': '1s', 'timeout-server-fin': '1s',
    'generate-certificates-signer': 'default/ca', 'quic-alt-svc-max-age': '60'
};
const ANNOTATIONS = [...new Set([...mod.matchAll(/'annotation:([\w.-]+)'/g)].map((m) => m[1]))];
const CONFIGMAP = [...new Set([...mod.matchAll(/'configmap:([\w.-]+)'/g)].map((m) => m[1]))].filter((k) => k !== 'tcp-services');
const value = (k) => VALUES[k] || 'true';

// Every input the rules run over: each annotation on an Ingress, each
// ConfigMap key beside one, and the three samples.
const CASES = ANNOTATIONS.map((k) => ({ label: k, yaml: ingress({ ['haproxy.org/' + k]: value(k) }), keys: [k] }))
    .concat(CONFIGMAP.map((k) => ({ label: 'ConfigMap ' + k, yaml: ingress({}) + '---\n' + configMap({ [k]: value(k) }), keys: [k] })))
    .concat(Object.keys(source.analyzer.samplePresets).map((p) => ({ label: 'sample ' + p, yaml: source.analyzer.samplePresets[p], keys: [] })));

test('the case list covers every mapped HAProxy key', () => {
    assert.ok(ANNOTATIONS.length > 50 && CONFIGMAP.length > 25, ANNOTATIONS.length + ' annotations, ' + CONFIGMAP.length + ' ConfigMap keys');
});

test('every recognised setting is named in the output, under both strategies', () => {
    /* Nothing recognised may vanish: a key is named in a generated comment, a
       note or a card — and not only as "has no translation". */
    const broken = [];
    for (const c of CASES.filter((x) => x.keys.length)) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        const k = c.keys[0];
        const said = r.text + '\n' + JSON.stringify(r.plan.infoNotes) + JSON.stringify(r.plan.unsupported || '') + JSON.stringify(r.plan.unrecognized || '');
        if (!said.includes(k)) broken.push(c.label + ' / ' + strategy + ': not named');
        if (r.plan.infoNotes.some((n) => /no translation for it/.test(n.message) && n.code.includes(k))) broken.push(c.label + ' / ' + strategy + ': only "no translation"');
        // The catch-all for a translator that wrote nothing and said nothing.
        if (r.plan.infoNotes.some((n) => /did not say why/.test(n.message) && n.message.includes(k))) broken.push(c.label + ' / ' + strategy + ': lost (its translator wrote and said nothing)');
    }
    assert.deepEqual(broken, []);
});

test('the analyzer view keeps its promises for every setting and sample', () => {
    /* The rules analyzer.test.js holds ingress-nginx to: both sides on every
       card; a Policy card shows one mapping's settings; the export holds
       exactly the cards' resources; CRD-first replaces the Ingress and
       annotation-first keeps it (TLS passthrough is a TransportServer under both). */
    const mappingOf = {};
    for (const m of source.analyzer.mappings) for (const k of m.keys) mappingOf[k.split(':')[1]] = m;
    const kindsIn = (text) => (text.match(/^kind: (\w+)/gm) || []).map((k) => k.slice(6));
    const settingsIn = (yaml) => [...yaml.matchAll(/(?:haproxy\.(?:org|com)|ingress\.kubernetes\.io)\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    const broken = [];
    for (const c of CASES) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        const at = c.label + ' / ' + strategy;
        const cards = r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])))
            .map((it) => ({ title: it.category || it.old.title, old: it.old.yaml, kinds: kindsIn(it.new.yaml), left: settingsIn(it.old.yaml) }));
        for (const card of cards) {
            if (!card.old.trim()) broken.push('1 ' + at + ': ' + card.title + ' has an empty side');
            if (/annotations: \{\}/.test(card.old)) broken.push('1 ' + at + ': ' + card.title + ' shows an empty annotations block');
            for (const k of card.left) if (!c.yaml.includes(k)) broken.push('1 ' + at + ': ' + card.title + ' shows ' + k + ', which was not pasted');
            if (card.kinds.length === 1 && card.kinds[0] === 'Policy' && new Set(card.left.map((k) => mappingOf[k])).size > 1) broken.push('2 ' + at + ': Policy card ' + card.title + ' mixes ' + card.left.join(', '));
        }
        const shown = cards.flatMap((card) => card.kinds).sort().join(', ');
        const exported = (r.plan.export ? r.plan.export.parts : []).flatMap(kindsIn).sort().join(', ');
        if (shown !== exported) broken.push('4 ' + at + ': the cards show [' + shown + '], the export holds [' + exported + ']');
        const all = cards.flatMap((card) => card.kinds);
        if (strategy === 'crd' && all.includes('Ingress')) broken.push('5 ' + at + ': CRD-first emitted an Ingress');
        if (strategy === 'annotation' && all.includes('VirtualServer')) broken.push('5 ' + at + ': annotation-first emitted a VirtualServer');
    }
    assert.deepEqual(broken, [], 'a promise of the analyzer view broke');
});

test('generated resources pass the checks NGINX Ingress Controller applies at admission', () => {
    /* A static subset of v5.7.0's validation: one of action/splits per route,
       split weights summing to 100, a pass or proxy naming an upstream, numeric
       upstream ports, valid redirect codes, unique route paths (NGINX refuses a
       duplicate location) and no class naming HAProxy (NGINX Ingress Controller
       ignores the resource). */
    const broken = [];
    for (const c of CASES) for (const strategy of ['crd', 'annotation']) {
        for (const d of run(c.yaml, strategy).docs) {
            if (!d || d.kind !== 'VirtualServer') continue;
            const at = c.label + ' / ' + strategy + ' ' + d.metadata.name;
            const names = new Set((d.spec.upstreams || []).map((u) => u.name));
            const seen = new Set();
            for (const route of d.spec.routes || []) {
                if (seen.has(route.path)) broken.push(at + ': duplicate route ' + route.path);
                seen.add(route.path);
                if (Number(!!route.action) + Number(!!route.splits) !== 1) broken.push(at + ' ' + route.path + ': exactly one of action / splits');
                if (route.splits && route.splits.reduce((n, s) => n + s.weight, 0) !== 100) broken.push(at + ': splits do not sum to 100');
                for (const a of [route.action].concat((route.splits || []).map((s) => s.action), (route.matches || []).map((m) => m.action))) {
                    if (a && a.pass && !names.has(a.pass)) broken.push(at + ': pass ' + a.pass + ' names no upstream');
                    if (a && a.proxy && !names.has(a.proxy.upstream)) broken.push(at + ': proxy ' + a.proxy.upstream + ' names no upstream');
                    if (a && a.redirect && ![301, 302, 307, 308].includes(a.redirect.code)) broken.push(at + ': redirect code ' + a.redirect.code);
                }
            }
            for (const u of d.spec.upstreams || []) if (typeof u.port !== 'number') broken.push(at + ': upstream port ' + u.port);
            if (/haproxy/i.test(d.spec.ingressClassName || '')) broken.push(at + ': a class naming HAProxy');
        }
    }
    assert.deepEqual(broken, []);
});

test('generated YAML parses back to the same objects', () => {
    /* What the page shows, the export copies and nic-migrate writes goes
       through MigrationTool.yaml; each part must read back as emitted. */
    for (const c of CASES) for (const strategy of ['crd', 'annotation']) {
        const r = run(c.yaml, strategy);
        for (const part of (r.plan.export ? r.plan.export.parts : [])) {
            const doc = Y.parse(part);
            assert.deepEqual(JSON.parse(JSON.stringify(Y.parse(Y.stringify(doc)))), JSON.parse(JSON.stringify(doc)), c.label + ' / ' + strategy);
        }
    }
});

test('each card shows the HAProxy objects behind its own resource', () => {
    /* The VirtualServer card of the advanced sample shows the Ingress's own
       annotations, the canary Service's route-acl and the Backend the
       Service's cr-backend names — every object that shaped it — and no
       Policy's settings. */
    const r = run(source.analyzer.samplePresets.advanced);
    const items = r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])));
    const vs = items.find((it) => /web-app — app\.example\.com/.test(it.category)).old.yaml;
    assert.match(vs, /haproxy\.org\/path-rewrite/);
    assert.match(vs, /name: app-canary[\s\S]*route-acl/);
    assert.match(vs, /kind: Backend/);
    assert.doesNotMatch(vs, /rate-limit|cors-|auth-secret/, 'Policy settings belong on their own cards');
    const rl = items.find((it) => /rate-limit$/.test(it.category)).old.yaml;
    assert.deepEqual(rl.match(/haproxy\.org\/[a-z-]+/g).sort(), ['haproxy.org/rate-limit-period', 'haproxy.org/rate-limit-requests', 'haproxy.org/rate-limit-status-code']);
});
