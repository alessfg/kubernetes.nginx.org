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

/* Every mapped key, under every value that tells HAProxy's readers apart, under
   both strategies. HAProxy never rejects an Ingress over a value: it logs and
   keeps what it had, so a value it could not read must migrate to nothing, and
   what does migrate must pass NGINX Ingress Controller v5.7.0's own checks
   (internal/k8s/validation.go, pkg/apis/configuration/validation, configmaps.go).
   The analyzer used to copy "5 seconds" into proxy-read-timeout and
   "10.0.0.0/8, bogus" into an accessControl Policy, both refused. */
const SPREAD = ['', 'true', 'false', 't', '1', 'on', 'yes', 'off', '0', '-1', '5', '100abc', '5 seconds', '500us', '30s', 'x y z', 'X-H a, b', 'X-H a:b',
    '10.0.0.0/8, bogus', 'https://a.com,https://b.com', 'Cookie', 'GET,FOO', '302', 'default/name'];
const nicTime = (s) => typeof s === 'string' && s.trim() !== '' && /^(\d+y)??\s*(\d+M)??\s*(\d+w)??\s*(\d+d)??\s*(\d+h)??\s*(\d+m)??\s*(\d+s?)??\s*(\d+ms)??$/.test(s);
const nicLb = (s) => ['round_robin', 'least_conn', 'ip_hash', 'random', 'random two', 'random two least_conn', 'least_time header', 'least_time last_byte', 'least_time header inflight', 'least_time last_byte inflight'].includes(s) || /^hash \S+( consistent)?$/.test(s);
const nicAddress = (s) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s) || (/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && s.includes(':'));
const nicHeader = /^[-A-Za-z0-9!#$%&'*+.^_`|~]+$/;
function refused(d) {
    const out = [];
    const ann = (d.metadata && d.metadata.annotations) || {};
    const check = (k, ok) => { if (k in ann && !ok(String(ann[k]))) out.push(k + '=' + ann[k]); };
    ['nginx.org/proxy-read-timeout', 'nginx.org/proxy-send-timeout', 'nginx.org/proxy-connect-timeout'].forEach((k) => check(k, nicTime));
    ['nginx.org/max-conns', 'nginx.org/max-fails'].forEach((k) => check(k, (v) => /^\d+$/.test(v)));
    check('nginx.org/lb-method', nicLb);
    ['nginx.org/ssl-redirect', 'nginx.org/redirect-to-https'].forEach((k) => check(k, (v) => /^(1|t|T|TRUE|true|True|0|f|F|FALSE|false|False)$/.test(v)));
    check('nginx.org/http-redirect-code', (v) => ['301', '302', '307', '308'].includes(v));
    check('nginx.org/limit-req-burst', (v) => /^\d+$/.test(v) && v !== '0');
    check('nginx.org/limit-req-reject-code', (v) => +v >= 400 && +v <= 599);
    ['nginx.org/proxy-set-headers', 'nginx.org/add-header'].forEach((k) => check(k, (v) => v.split(',').every((e) => nicHeader.test(e.split(':')[0].trim()))));
    // add-header splits on ":" into name, value and flag; the flag must be
    // "always" (validateAddHeaderAnnotation, v5.7.0).
    check('nginx.org/add-header', (v) => v.split(',').every((e) => { const p = e.split(':'); return p.length < 3 || (p.length === 3 && /^\s*always\s*$/i.test(p[2])); }));
    const s = d.spec || {};
    if (d.kind === 'Policy') {
        const rl = s.rateLimit;
        if (rl && (rl.burst !== undefined && !(rl.burst > 0) || rl.rejectCode < 400 || rl.rejectCode > 599)) out.push('rateLimit ' + JSON.stringify(rl));
        const ac = s.accessControl;
        if (ac) [].concat(ac.allow || [], ac.deny || []).filter((x) => !nicAddress(String(x))).forEach((x) => out.push('accessControl ' + x));
        const c = s.cors;
        if (c) {
            (c.allowHeaders || []).filter((h) => h !== '*' && (!nicHeader.test(h) || /^(cookie|host|origin|connection|referer|set-cookie|proxy-.*|sec-.*)$/i.test(h))).forEach((h) => out.push('cors header ' + h));
            (c.allowMethods || []).filter((m) => !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'].includes(m)).forEach((m) => out.push('cors method ' + m));
            (c.allowOrigin || []).filter((o) => o !== '*' && !/^https?:\/\/[^/\s]+$/.test(o)).forEach((o) => out.push('cors origin ' + o));
        }
    }
    if (d.kind === 'VirtualServer') {
        for (const u of s.upstreams || []) {
            ['read-timeout', 'send-timeout', 'connect-timeout'].forEach((f) => { if (u[f] !== undefined && !nicTime(String(u[f]))) out.push('upstream ' + f + '=' + u[f]); });
            if (u['lb-method'] !== undefined && !nicLb(u['lb-method'])) out.push('upstream lb-method=' + u['lb-method']);
            if (u['max-conns'] !== undefined && !(u['max-conns'] >= 0)) out.push('upstream max-conns=' + u['max-conns']);
            if (u.sessionCookie && !/^[_A-Za-z0-9]+$/.test(u.sessionCookie.name)) out.push('sessionCookie.name=' + u.sessionCookie.name);
            if (u.healthCheck) ['interval', 'read-timeout'].forEach((f) => { if (u.healthCheck[f] !== undefined && !nicTime(String(u.healthCheck[f]))) out.push('healthCheck ' + f + '=' + u.healthCheck[f]); });
        }
        if (s.tls && s.tls.redirect && ![301, 302, 307, 308].includes(s.tls.redirect.code)) out.push('tls.redirect.code=' + s.tls.redirect.code);
    }
    if (d.kind === 'ConfigMap') {
        const data = d.data || {};
        ['proxy-read-timeout', 'proxy-send-timeout', 'proxy-connect-timeout', 'keepalive-timeout', 'worker-shutdown-timeout'].forEach((k) => { if (k in data && !nicTime(String(data[k]))) out.push(k + '=' + data[k]); });
        ['worker-connections', 'keepalive'].forEach((k) => { if (k in data && !/^\d+$/.test(String(data[k]))) out.push(k + '=' + data[k]); });
        if ('worker-processes' in data && !/^(\d+|auto)$/.test(String(data['worker-processes']))) out.push('worker-processes=' + data['worker-processes']);
        if ('lb-method' in data && !nicLb(data['lb-method'])) out.push('lb-method=' + data['lb-method']);
        // http-snippets reach nginx.conf unchecked: a bad time there fails the
        // reload for every resource on the controller.
        String(data['http-snippets'] || '').split('\n').forEach((l) => { const m = l.match(/^\s*(\w+_timeout)\s+(.*);$/); if (m && !nicTime(m[2])) out.push('http-snippets ' + l.trim()); });
    }
    return out;
}

test('every value of every key migrates to something NGINX Ingress Controller accepts, or to a note', () => {
    const broken = [];
    let runs = 0;
    const inputs = ANNOTATIONS.flatMap((k) => SPREAD.map((v) => ({ at: k + '="' + v + '"', yaml: ingress({ ['haproxy.org/' + k]: v }) })))
        .concat(CONFIGMAP.flatMap((k) => SPREAD.map((v) => ({ at: 'ConfigMap ' + k + '="' + v + '"', yaml: ingress({}) + '---\n' + configMap({ [k]: v }) }))));
    for (const c of inputs) for (const strategy of ['crd', 'annotation']) {
        runs++;
        const r = run(c.yaml, strategy);
        for (const d of r.docs) if (d) for (const e of refused(d)) broken.push(c.at + ' / ' + strategy + ': ' + e);
        const said = JSON.stringify(r.plan.infoNotes);
        if (/did not say why/.test(said)) broken.push(c.at + ' / ' + strategy + ': lost');
        if (/undefined|NaN|\[object Object\]/.test(r.text + said)) broken.push(c.at + ' / ' + strategy + ': undefined or NaN in the output');
    }
    assert.ok(runs > 3000, runs + ' runs');
    assert.deepEqual(broken.slice(0, 40), [], broken.length + ' problems');
});

test('each value is read as HAProxy v3.2.12 reads it', () => {
    /* The readers differ per annotation (pkg/annotations, pkg/utils): booleans
       are utils.GetBoolValue (ParseBool plus on/off/enabled/disabled, not
       "yes"), or annotations.Bool (only "true"), or input == "true"; times are
       utils.ParseTime (an int64 and one suffix, bare is milliseconds); the
       gates are the processors' own. Each row: an input, then what the
       migration must, and must not, contain. */
    const ROWS = [
        ['cors-enable yes is not a boolean: no CORS', { 'cors-enable': 'yes' }, null, /kind: Policy/],
        ['cors-enable t is true', { 'cors-enable': 't' }, /cors:/, null],
        ['cors-max-age 1500 is 1s, truncated', { 'cors-enable': 'true', 'cors-max-age': '1500' }, /maxAge: 1 /, null],
        ['an unknown CORS method voids the methods header', { 'cors-enable': 'true', 'cors-allow-methods': 'GET, FOO' }, null, /allowMethods/],
        ['ssl-redirect yes: no redirect, TLS or not', { 'ssl-redirect': 'yes' }, null, /redirect:/],
        ['ssl-redirect t: a redirect', { 'ssl-redirect': 't' }, /redirect:[\s\S]*enable: true/, null],
        ['ssl-passthrough 1: off (annotations.Bool)', { 'ssl-passthrough': '1' }, /kind: VirtualServer/, /TransportServer/],
        ['server-ssl yes: plaintext', { 'server-ssl': 'yes' }, null, /tls:\s*# server-ssl/],
        ['check t: checks on, so no max-fails 0', { check: 't' }, null, /max-fails/],
        ['check off: max-fails 0', { check: 'off' }, /max-fails: 0/, null],
        ['forwarded-for 0: false', { 'forwarded-for': '0' }, /disable-forwarded-headers/, null],
        ['auth-secret without auth-type: no authentication', { 'auth-secret': 'users' }, null, /basicAuth|basic-auth-secret/],
        ['an unset realm is Protected-Content', { 'auth-type': 'basic-auth', 'auth-secret': 'users' }, /realm: Protected-Content/, null],
        ['spaces in a realm become dashes', { 'auth-type': 'basic-auth', 'auth-secret': 'users', 'auth-realm': 'Members Only' }, /realm: Members-Only/, null],
        ['both cookie annotations: no cookie', { 'cookie-persistence': 'A', 'cookie-persistence-no-dynamic': 'B' }, null, /sessionCookie/],
        ['a bad address voids the allow-list', { 'allow-list': '10.0.0.0/8, nope' }, null, /accessControl/],
        ['rate-limit-requests 100r does not parse: no limit', { 'rate-limit-requests': '100r' }, null, /rateLimit/],
        ['rate-limit-requests 1: no burst field', { 'rate-limit-requests': '1' }, /rate: "?1r\/s/, /burst/],
        ['a status code HAProxy cannot send falls back to 403', { 'rate-limit-requests': '5', 'rate-limit-status-code': '302' }, /rejectCode: 403/, null],
        ['timeout-server 5 seconds: nothing', { 'timeout-server': '5 seconds' }, null, /read-timeout/],
        ['timeout-server 500us: ParseTime has no microseconds', { 'timeout-server': '500us' }, null, /read-timeout/],
        ['load-balance random is two draws', { 'load-balance': 'random' }, /lb-method: random two/, null],
        ['load-balance ROUNDROBIN is invalid, so roundrobin', { 'load-balance': 'ROUNDROBIN' }, /lb-method: round_robin/, null],
        ['pod-maxconn 100abc: nothing', { 'pod-maxconn': '100abc' }, null, /max-conns/],
        ['check false stops check-http', { check: 'false', 'check-http': '/healthz' }, null, /healthCheck/],
        ['a request-redirect-code HAProxy refuses: no redirect', { 'request-redirect': 'example.com', 'request-redirect-code': '305' }, null, /redirect:\s*\n\s*url/]
    ];
    const broken = [];
    for (const [label, ann, want, not] of ROWS) {
        const r = run(ingress(Object.fromEntries(Object.entries(ann).map(([k, v]) => ['haproxy.org/' + k, v]))), 'crd');
        if (want && !want.test(r.text)) broken.push(label + ': missing ' + want);
        if (not && not.test(r.text)) broken.push(label + ': has ' + not);
        if (!r.plan.infoNotes.some((n) => Object.keys(ann).some((k) => n.code.includes(k) || n.message.includes(k))) && !want) broken.push(label + ': says nothing');
    }
    const cm = (data) => run(ingress({}) + '---\n' + configMap(data), 'crd');
    if (/basicAuth|ingressMTLS/.test(cm({ 'client-crt-optional': 'true' }).text)) broken.push('client-crt-optional without client-ca made a Policy');
    if (!/verifyClient: "?on/.test(cm({ 'client-ca': 'ca', 'client-crt-optional': '1' }).text)) broken.push('client-crt-optional 1 relaxed verification (annotations.Bool)');
    if (/client_\w+_timeout 5 seconds/.test(cm({ 'timeout-client': '5 seconds' }).text)) broken.push('timeout-client 5 seconds reached http-snippets');
    if (/worker-connections/.test(cm({ maxconn: 'lots' }).text)) broken.push('maxconn lots reached nginx-config');
    assert.deepEqual(broken, []);
});

test('a backend checked with server-ca names the certificate name NGINX checks', () => {
    /* HAProxy's server-ca verifies the chain only (service/ca.go: verify
       required, no verifyhost). NGINX with verifyServer also checks the name
       against proxy_ssl_name, $proxy_host unless sslName is set — the
       VirtualServer upstream name, which no certificate carries. */
    const r = run(ingress({ 'haproxy.org/server-ca': 'default/backend-ca' }), 'crd');
    assert.match(r.text, /sslName: web\.default\.svc|sslName: web\.svc/);
    assert.ok(r.plan.infoNotes.some((n) => /checks its name/.test(n.message)), 'the name check is called out');
});
