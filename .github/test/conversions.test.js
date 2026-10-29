'use strict';
/* Semantic conversion tests for the HAProxy source module — the value
   transforms where the two controllers' defaults or units diverge, and where
   HAProxy reads a setting from. Crafted YAML goes through the real
   parseInput/buildPlan path, and assertions read the generated documents,
   parsed, so the emitter's quoting is not what is tested. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-haproxy.js');
const Y = tool.yaml;

const run = (yaml, strategy) => {
    const before = warnings.length;
    const r = analyze(source, yaml, strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))) });
};
const kinds = (r, kind) => r.docs.filter((d) => d.kind === kind);
const notes = (r) => r.plan.infoNotes.map((n) => n.code + ' — ' + n.message).join('\n');
const ann = (r) => kinds(r, 'Ingress')[0].metadata.annotations || {};
const cm = (r) => (kinds(r, 'ConfigMap')[0] || { data: {} }).data;

function ingressWith(annotations, extra) {
    const doc = {
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: {} },
        spec: { rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app-svc', port: { number: 80 } } } }] } }] }
    };
    for (const [k, v] of Object.entries(annotations)) doc.metadata.annotations[k] = v;
    return Y.stringify(Object.assign(doc, extra || {}));
}
const configMap = (data) => Y.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'haproxy-kubernetes-ingress' }, data });
const service = (name, annotations) => Y.stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name, annotations }, spec: { ports: [{ port: 80 }] } });
const stream = (...docs) => docs.join('---\n');

// HAProxy's canary documentation: the main and canary Services each on a rule
// for the same host, the canary carrying route-acl.
const canary = (acl) => stream(
    Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'echo' }, spec: { rules: [{ host: 'echo.example.com', http: { paths: [
        { path: '/', pathType: 'ImplementationSpecific', backend: { service: { name: 'echo-prod', port: { number: 80 } } } },
        { path: '/', pathType: 'ImplementationSpecific', backend: { service: { name: 'echo-staging', port: { number: 80 } } } }] } }] } }),
    service('echo-staging', { 'haproxy.org/route-acl': acl }));

// rand(<range>) yields 0..range-1 (HAProxy 3.2 configuration.txt), so the
// canary percentage must use the exact matched count per operator.
test('route-acl rand(): exact canary percentages for lt/le/ge/gt', () => {
    for (const [acl, pct] of [['rand(100) lt 25', 25], ['rand(100) le 25', 26], ['rand(100) ge 25', 75], ['rand(100) gt 25', 74], ['rand(10) lt 3', 30]]) {
        const vs = kinds(run(canary(acl)), 'VirtualServer')[0];
        const route = vs.spec.routes.find((rt) => rt.splits);
        assert.ok(route, acl + ': a split route');
        assert.deepEqual(route.splits.map((s) => s.weight), [100 - pct, pct], acl);
        const up = (name) => vs.spec.upstreams.find((u) => u.name === name).service;
        assert.equal(up(route.splits[1].action.pass), 'echo-staging', acl + ': the canary leg');
    }
});

test('route-acl: a cookie test becomes a match, as in the HAProxy canary docs', () => {
    /* `cookie(staging) -m found` is the example in HAProxy's own documentation;
       the generator before the whole-Ingress rewrite reported it untranslatable. */
    const vs = kinds(run(canary('cookie(staging) -m found')), 'VirtualServer')[0];
    const m = vs.spec.routes[0].matches[0];
    assert.deepEqual(m.conditions, [{ cookie: 'staging', value: '!' }]);
    assert.equal(vs.spec.upstreams.find((u) => u.name === m.action.pass).service, 'echo-staging');
});

test('route-acl: compound/unsupported ACLs degrade to a warning, never wrong YAML', () => {
    for (const acl of ['rand(100) lt 25 !{ hdr(x) -m str y }', 'path_beg /admin', 'src 10.0.0.0/8 or src 192.168.0.0/16']) {
        const r = run(canary(acl));
        assert.ok(!/splits:|matches:/.test(r.text), acl + ': must not emit splits or matches');
        assert.match(notes(r), /not translat/i, acl + ': expected an untranslatable note');
    }
    // A route-acl Service no Ingress routes to: HAProxy builds no route for it.
    const alone = run(service('canary-svc', { 'haproxy.org/route-acl': 'path_beg /admin' }));
    assert.match(notes(alone), /not translatable/);
    assert.match(notes(alone), /No Ingress in the paste routes to this Service/);
});

test('cors: "*" methods expand without HEAD; explicit GET+HEAD drops HEAD (NIC admission rule)', () => {
    const methods = (m) => kinds(run(ingressWith({ 'haproxy.org/cors-enable': 'true', 'haproxy.org/cors-allow-methods': m })), 'Policy')[0].spec.cors.allowMethods;
    assert.ok(methods('*').includes('GET') && !methods('*').includes('HEAD'), 'wildcard expansion must not list HEAD');
    assert.ok(!methods('GET, HEAD, POST').includes('HEAD'), 'HEAD must be dropped when GET is present');
    assert.ok(methods('HEAD, OPTIONS').includes('HEAD'), 'HEAD without GET is valid and must be kept');
});

test('cors: maxAge always emitted (HAProxy default 5s vs NIC default 86400)', () => {
    assert.equal(kinds(run(ingressWith({ 'haproxy.org/cors-enable': 'true' })), 'Policy')[0].spec.cors.maxAge, 5);
});

test('syslog-server: HAProxy levels err/warning translate to nginx error/warn', () => {
    const log = (level) => cm(run(configMap({ 'syslog-server': `address:10.0.0.5, port:514, facility:local0, level:${level}` })))['access-log'];
    assert.match(log('err'), /severity=error/);
    assert.match(log('warning'), /severity=warn\b/);
    assert.match(log('info'), /severity=info/);
});

test('ssl-redirect: code is always explicit, defaults to the HAProxy 302, and 303 clamps to 302', () => {
    const code = (a) => ann(run(ingressWith(a), 'annotation'))['nginx.org/http-redirect-code'];
    assert.equal(code({ 'haproxy.org/ssl-redirect': 'true' }), '302');
    assert.equal(code({ 'haproxy.org/ssl-redirect': 'true', 'haproxy.org/ssl-redirect-code': '303' }), '302');
    assert.equal(code({ 'haproxy.org/ssl-redirect': 'true', 'haproxy.org/ssl-redirect-code': '307' }), '307');
});

test('ssl-redirect: on by default with TLS, as HAProxy does, and off when set false', () => {
    /* httpsRedirect.go turns the redirect on when the Ingress has TLS and
       ssl-redirect is unset. */
    const tls = { spec: { tls: [{ hosts: ['app.example.com'], secretName: 'app-tls' }], rules: [{ host: 'app.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app-svc', port: { number: 80 } } } }] } }] } };
    assert.deepEqual(kinds(run(ingressWith({}, tls)), 'VirtualServer')[0].spec.tls.redirect, { enable: true, code: 302 });
    assert.equal(kinds(run(ingressWith({ 'haproxy.org/ssl-redirect': 'false' }, tls)), 'VirtualServer')[0].spec.tls.redirect, undefined);
});

test('timeout-server sets BOTH proxy-read-timeout and proxy-send-timeout', () => {
    const a = ann(run(ingressWith({ 'haproxy.org/timeout-server': '50s' }), 'annotation'));
    assert.equal(a['nginx.org/proxy-read-timeout'], '50s');
    assert.equal(a['nginx.org/proxy-send-timeout'], '50s');
    const up = kinds(run(ingressWith({ 'haproxy.org/timeout-server': '50s' })), 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(up['read-timeout'], '50s');
    assert.equal(up['send-timeout'], '50s');
});

test('HAProxy bare times are milliseconds: timeout-connect "5000" becomes 5s', () => {
    assert.equal(cm(run(configMap({ 'timeout-connect': '5000' })))['proxy-connect-timeout'], '5s');
});

test('rate-limit: requests/period convert to r/s or r/m, admit the same burst, and keep the HAProxy 403', () => {
    /* HAProxy denies past N requests per period (reqRateLimit.go, sc0_http_req_rate
       gt N) without queueing: N at once pass. burst 0 refused the second of two
       quick requests; burst N-1 with nodelay admits the same N. */
    const policy = (a) => kinds(run(ingressWith(a)), 'Policy')[0].spec.rateLimit;
    const perSecond = policy({ 'haproxy.org/rate-limit-requests': '100', 'haproxy.org/rate-limit-period': '1s', 'haproxy.org/rate-limit-status-code': '429' });
    assert.equal(perSecond.rate, '100r/s');
    assert.equal(perSecond.burst, 99);
    assert.equal(perSecond.noDelay, true);
    assert.equal(perSecond.rejectCode, 429);
    const perMinute = policy({ 'haproxy.org/rate-limit-requests': '100', 'haproxy.org/rate-limit-period': '1m' });
    assert.equal(perMinute.rate, '100r/m');
    assert.equal(perMinute.rejectCode, 403, 'unset status-code must emit the HAProxy 403 default');
    // A rateLimit Policy cannot be referenced from an Ingress: annotations instead.
    const a = ann(run(ingressWith({ 'haproxy.org/rate-limit-requests': '10' }), 'annotation'));
    assert.equal(a['nginx.org/limit-req-rate'], '10r/s');
    assert.equal(a['nginx.org/limit-req-burst'], '9');
});

// NIC stores this key's value as MainServerSSLDHParamFileContent and writes
// the file itself (configurator AddOrUpdateDHParam), so the key holds the DH
// parameters, not a path. Passing HAProxy's path straight through looks right
// and breaks the reload.
test('ssl_dh_param_file emits PEM content, never the HAProxy path', () => {
    const cr = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Global', metadata: { name: 'haproxy-global' }, spec: { ssl_options: { dh_param_file: '/etc/ssl/dhparam.pem' } } });
    const v = cm(run(stream(configMap({ 'cr-global': 'haproxy-global' }), cr)))['ssl-dhparam-file'];
    assert.match(v, /^-----BEGIN DH PARAMETERS-----\n/);
    assert.notEqual(v.trim(), '/etc/ssl/dhparam.pem', 'must not emit the path as the value');
});

test('load-balance: verified value map incl. no-equivalent fallbacks', () => {
    const lb = (v) => run(ingressWith({ 'haproxy.org/load-balance': v }), 'annotation');
    assert.equal(ann(lb('leastconn'))['nginx.org/lb-method'], 'least_conn');
    assert.equal(ann(lb('source'))['nginx.org/lb-method'], 'ip_hash');
    assert.equal(ann(lb('uri'))['nginx.org/lb-method'], 'hash $request_uri consistent');
    const first = lb('first');
    assert.equal(ann(first)['nginx.org/lb-method'], undefined, 'balance first has no NIC equivalent');
    assert.ok(first.plan.infoNotes.some((n) => /load-balance: first/.test(n.code)), 'the note names the value');
});

test('allow-list beside deny-list: one allow Policy, and the denied addresses inside it still denied', () => {
    /* HAProxy denies a client outside allow-list OR inside deny-list. NGINX
       Ingress Controller applies only the allow Policy when a resource
       references both, so two Policies dropped the deny list without a word.
       A denied address inside an allowed range must still be denied. */
    const yaml = ingressWith({ 'haproxy.org/allow-list': '10.0.0.0/8', 'haproxy.org/deny-list': '10.1.2.3,192.168.1.1' });
    for (const strategy of ['crd', 'annotation']) {
        const r = run(yaml, strategy);
        const pols = kinds(r, 'Policy');
        assert.equal(pols.length, 1, strategy + ': a deny Policy is ignored beside an allow one');
        assert.deepEqual(pols[0].spec.accessControl, { allow: ['10.0.0.0/8'] }, strategy);
        const snippet = strategy === 'crd' ? kinds(r, 'VirtualServer')[0].spec.routes[0]['location-snippets'] : ann(r)['nginx.org/location-snippets'];
        assert.match(snippet, /deny 10\.1\.2\.3;/, strategy + ': the denied address inside the allowed range');
        assert.doesNotMatch(snippet, /192\.168\.1\.1/, strategy + ': outside every allowed range, allow-only blocks it');
    }
    // A deny list on its own is still a deny Policy.
    assert.deepEqual(kinds(run(ingressWith({ 'haproxy.org/deny-list': '10.1.2.3' })), 'Policy')[0].spec.accessControl, { deny: ['10.1.2.3'] });
});

test('5.7: server-proto h2 becomes proxy-http-version "2", on the annotation and the upstream field', () => {
    /* v5.7.0 sets the upstream HTTP version (annotations.go, http_version.go).
       Before it, generic HTTP/2 to a backend had no form at all. */
    const yaml = ingressWith({ 'haproxy.org/server-proto': 'h2' });
    assert.equal(ann(run(yaml, 'annotation'))['nginx.org/proxy-http-version'], '2');
    assert.equal(kinds(run(yaml), 'VirtualServer')[0].spec.upstreams[0]['proxy-http-version'], '2');
});

test('5.6: set-host becomes nginx.org/upstream-vhost when it is a plain hostname, a VirtualServer header otherwise', () => {
    assert.equal(ann(run(ingressWith({ 'haproxy.org/set-host': 'Internal.Example.com' }), 'annotation'))['nginx.org/upstream-vhost'], 'internal.example.com', 'lowercased, as validation requires');
    // A port fails upstream-vhost validation and would reject the Ingress:
    // annotation-first keeps the Ingress and says to switch; CRD-first sets Host.
    const port = ingressWith({ 'haproxy.org/set-host': 'internal.example.com:8080' });
    const a = run(port, 'annotation');
    assert.equal(ann(a)['nginx.org/upstream-vhost'], undefined);
    assert.match(notes(a), /CRD-first/);
    const set = kinds(run(port), 'VirtualServer')[0].spec.routes[0].action.proxy.requestHeaders.set;
    assert.deepEqual(set, [{ name: 'Host', value: 'internal.example.com:8080' }]);
});

test('a header value built from a sample fetch never lands in a literal-only annotation', () => {
    /* nginx.org/proxy-set-headers and add-header take literal values only; %[src]
       is HAProxy syntax, and a "$" makes NGINX Ingress Controller reject the Ingress. */
    const yaml = ingressWith({ 'haproxy.org/request-set-header': 'X-Client %[src]' });
    const a = run(yaml, 'annotation');
    assert.equal(ann(a)['nginx.org/proxy-set-headers'], undefined);
    assert.match(notes(a), /CRD-first/);
    const c = run(yaml);
    assert.equal(kinds(c, 'VirtualServer')[0].spec.routes[0].action.proxy.requestHeaders.set[0].name, 'X-Client');
    assert.match(notes(c), /sample fetch/, 'the rewrite is called out');
});

test('5.6: forwarded-for "false" becomes the disable-forwarded-headers ConfigMap key, with its cost named', () => {
    const r = run(ingressWith({ 'haproxy.org/forwarded-for': 'false' }));
    assert.equal(cm(r)['disable-forwarded-headers'], 'true');
    assert.ok(r.plan.infoNotes.some((n) => /global/.test(n.message) && /-enable-snippets/.test(n.message)));
});

test('cors-respond-to-options is answered by the cors Policy, not reported as unsupported', () => {
    /* The cors Policy renders "if ($request_method = 'OPTIONS') { return 204; }",
       which is what HAProxy's annotation turned on (resSetCORS.go). */
    const { plan } = run(ingressWith({ 'haproxy.org/cors-enable': 'true', 'haproxy.org/cors-respond-to-options': 'true' }));
    assert.ok(!plan.unsupported || !plan.unsupported.cards.some((c) => /respond-to-options/.test(c.code)));
    assert.ok(plan.infoNotes.some((n) => /respond-to-options/.test(n.code) && /204/.test(n.message)));
});

/* ------------------------------------------------- what HAProxy applies where */

test('a backend setting is read Service first, then Ingress, then ConfigMap, per Service', () => {
    /* service.New(): a Service's annotations, then the Ingress's, then the
       ConfigMap's (v3.2.12). Two Services resolving differently keep their own
       values; one ConfigMap value for all is the global key. */
    const two = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'haproxy.org/load-balance': 'leastconn' } }, spec: { rules: [{ host: 'app.example.com', http: { paths: [
        { path: '/a', pathType: 'Prefix', backend: { service: { name: 'svc-a', port: { number: 80 } } } },
        { path: '/b', pathType: 'Prefix', backend: { service: { name: 'svc-b', port: { number: 80 } } } }] } }] } });
    const r = run(stream(two, service('svc-a', { 'haproxy.org/load-balance': 'source' }), configMap({ 'load-balance': 'roundrobin' })));
    const ups = kinds(r, 'VirtualServer')[0].spec.upstreams;
    assert.equal(ups.find((u) => u.service === 'svc-a')['lb-method'], 'ip_hash', 'the Service wins');
    assert.equal(ups.find((u) => u.service === 'svc-b')['lb-method'], 'least_conn', 'then the Ingress');
    // Only the ConfigMap: one global key, not a field on every upstream.
    const g = run(stream(ingressWith({}), configMap({ 'load-balance': 'leastconn' })));
    assert.equal(cm(g)['lb-method'], 'least_conn');
    assert.equal(kinds(g, 'VirtualServer')[0].spec.upstreams[0]['lb-method'], undefined);
});

test('a cr-backend Backend replaces the backend annotations of the Service it is reached from', () => {
    /* getBackendModel: with a Backend CR, no backend annotation is processed. */
    const backend = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Backend', metadata: { name: 'be' }, spec: { balance: { algorithm: 'leastconn' }, server_timeout: 50000 } });
    const r = run(stream(ingressWith({}), service('app-svc', { 'haproxy.org/cr-backend': 'be', 'haproxy.org/load-balance': 'source' }), backend));
    const up = kinds(r, 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(up['lb-method'], 'least_conn', 'the Backend, not the annotation');
    assert.equal(up['read-timeout'], '50s');
    assert.match(notes(r), /HAProxy ignored load-balance/);
});

test('a Global or Defaults CR applies only when the ConfigMap names it, and then replaces its keys', () => {
    /* controller/global.go: cr-global / cr-defaults in the ConfigMap select the
       CR, which replaces the ConfigMap's Global / Defaults keys. */
    const defaults = Y.stringify({ apiVersion: 'ingress.v3.haproxy.org/v3', kind: 'Defaults', metadata: { name: 'd' }, spec: { connect_timeout: 7000 } });
    const named = run(stream(configMap({ 'cr-defaults': 'd', 'timeout-connect': '3s' }), defaults));
    assert.equal(cm(named)['proxy-connect-timeout'], '7s', 'the CR replaces the ConfigMap key');
    assert.match(notes(named), /ignored the ConfigMap's timeout-connect/);
    const unnamed = run(stream(configMap({ 'timeout-connect': '3s' }), defaults));
    assert.equal(cm(unnamed)['proxy-connect-timeout'], '3s');
    assert.match(notes(unnamed), /applied to nothing/);
});

test('path-rewrite replaces the whole path where its regex matches, and leaves the rest', () => {
    /* replace-path searches the path and replaces all of it (configuration.txt
       3.2). The regex route matches only what the rule rewrites; the plain
       route carries the rest. Checked on nginx 1.31.7 with the location NGINX
       Ingress Controller renders: /app/a/b → /new/a/b, /app unchanged. */
    const two = Y.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: { 'haproxy.org/path-rewrite': '/app/(.*) /new/\\1' } }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/app', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const routes = kinds(run(two), 'VirtualServer')[0].spec.routes;
    assert.deepEqual(routes.map((rt) => rt.path), ['~ ^(?=/app(?:/|$)).*?/app/(.*)', '/app']);
    assert.equal(routes[0].action.proxy.rewritePath, '/new/$1');
    // The one-field form on an Ingress: rewrite-target with no path-regex
    // replaces the whole path (rewrite "<path>" <target> break).
    const one = run(ingressWith({ 'haproxy.org/path-rewrite': '/fixed' }), 'annotation');
    assert.equal(ann(one)['nginx.org/rewrite-target'], '/fixed');
    assert.equal(ann(one)['nginx.org/path-regex'], undefined);
});

test('request-redirect without a scheme redirects to http://, as HAProxy does', () => {
    /* hostRedirect.go: SSLRequest only for an https:// value. */
    const action = (v) => kinds(run(ingressWith({ 'haproxy.org/request-redirect': v })), 'VirtualServer')[0].spec.routes[0].action.redirect;
    assert.deepEqual(action('example.com'), { url: 'http://example.com${request_uri}', code: 302 });
    assert.equal(action('https://example.com').url, 'https://example.com${request_uri}');
});

test('a class naming HAProxy is never carried over, since NGINX Ingress Controller would ignore the resource', () => {
    /* HasCorrectIngressClass: a class it does not own is skipped silently; an
       empty one is claimed. */
    const r = run(ingressWith({}, { spec: { ingressClassName: 'haproxy', rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } }));
    assert.equal(kinds(r, 'VirtualServer')[0].spec.ingressClassName, undefined);
});
