'use strict';
/* Semantic conversion tests for the HAProxy source module — the value
   transforms where the two controllers' defaults or units diverge. These are
   behavior-level: crafted YAML goes through the real parseInput/buildPlan
   path and assertions run against the generated output, so internals can be
   refactored freely without breaking the suite. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

function load() {
    return loadAnalyzer('assets/js/migration-haproxy.js');
}

function serviceWithRouteACL(acl) {
    return [
        'apiVersion: v1', 'kind: Service', 'metadata:', '  name: canary-svc',
        '  annotations:', `    haproxy.org/route-acl: "${acl}"`,
        'spec:', '  ports:', '    - port: 80',
    ].join('\n');
}

function ingressWith(annotations) {
    const lines = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: app',
        '  annotations:',
    ];
    for (const [k, v] of Object.entries(annotations)) lines.push(`    ${k}: ${JSON.stringify(v)}`);
    lines.push(
        'spec:', '  rules:', '    - host: app.example.com', '      http:', '        paths:',
        '          - path: /', '            pathType: Prefix', '            backend:',
        '              service:', '                name: app-svc', '                port:', '                  number: 80',
    );
    return lines.join('\n');
}

// rand(<range>) yields 0..range-1 (HAProxy 3.2 configuration.txt), so the
// canary percentage must use the exact matched count per operator.
test('route-acl rand(): exact canary percentages for lt/le/ge/gt', () => {
    const { source } = load();
    const cases = [
        ['rand(100) lt 25', 25],
        ['rand(100) le 25', 26],
        ['rand(100) ge 25', 75],
        ['rand(100) gt 25', 74],
        ['rand(10) lt 3', 30],
    ];
    for (const [acl, canaryPct] of cases) {
        const { text } = analyze(source, serviceWithRouteACL(acl), 'crd');
        assert.match(text, new RegExp(`weight: ${100 - canaryPct}\\b`), `${acl}: primary weight`);
        assert.match(text, new RegExp(`weight: ${canaryPct}\\b[^\\n]*route-acl`), `${acl}: canary weight`);
    }
});

test('route-acl: compound/unsupported ACLs degrade to a warning, never wrong YAML', () => {
    const { source, warnings } = load();
    for (const acl of ['rand(100) lt 25 !{ hdr(x) -m str y }', 'path_beg /admin', 'src 10.0.0.0/8 or src 192.168.0.0/16']) {
        const { plan, text } = analyze(source, serviceWithRouteACL(acl), 'crd');
        assert.ok(!/splits:/.test(text), `${acl}: must not emit splits`);
        assert.ok(plan.infoNotes.some((n) => /not translatable/i.test(n.message)), `${acl}: expected untranslatable note`);
    }
    assert.equal(warnings.length, 0, warnings.join(' | '));
});

test('cors: "*" methods expand without HEAD; explicit GET+HEAD drops HEAD (NIC admission rule)', () => {
    const { source } = load();
    const wildcard = analyze(source, ingressWith({
        'haproxy.org/cors-enable': 'true',
        'haproxy.org/cors-allow-methods': '*',
    }), 'crd').text;
    assert.match(wildcard, /- GET\b/);
    assert.ok(!/- HEAD\b/.test(wildcard), 'wildcard expansion must not list HEAD');

    const explicit = analyze(source, ingressWith({
        'haproxy.org/cors-enable': 'true',
        'haproxy.org/cors-allow-methods': 'GET, HEAD, POST',
    }), 'crd').text;
    assert.ok(!/- HEAD\b/.test(explicit), 'HEAD must be dropped when GET is present');

    const headOnly = analyze(source, ingressWith({
        'haproxy.org/cors-enable': 'true',
        'haproxy.org/cors-allow-methods': 'HEAD, OPTIONS',
    }), 'crd').text;
    assert.match(headOnly, /- HEAD\b/, 'HEAD without GET is valid and must be kept');
});

test('cors: maxAge always emitted (HAProxy default 5s vs NIC default 86400)', () => {
    const { source } = load();
    const { text } = analyze(source, ingressWith({ 'haproxy.org/cors-enable': 'true' }), 'crd');
    assert.match(text, /maxAge: 5\b/);
});

test('syslog-server: HAProxy levels err/warning translate to nginx error/warn', () => {
    const { source } = load();
    const cm = (level) => [
        'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: haproxy-kubernetes-ingress',
        'data:', `  syslog-server: "address:10.0.0.5, port:514, facility:local0, level:${level}"`,
    ].join('\n');
    assert.match(analyze(source, cm('err'), 'crd').text, /severity=error/);
    assert.match(analyze(source, cm('warning'), 'crd').text, /severity=warn\b/);
    assert.match(analyze(source, cm('info'), 'crd').text, /severity=info/);
});

test('ssl-redirect: code is always explicit, defaults to the HAProxy 302, and 303 clamps to 302', () => {
    const { source } = load();
    const noCode = analyze(source, ingressWith({ 'haproxy.org/ssl-redirect': 'true' }), 'annotation').text;
    assert.match(noCode, /nginx\.org\/http-redirect-code: "?302/);

    const code303 = analyze(source, ingressWith({
        'haproxy.org/ssl-redirect': 'true',
        'haproxy.org/ssl-redirect-code': '303',
    }), 'annotation').text;
    assert.match(code303, /nginx\.org\/http-redirect-code: "?302/);

    const code307 = analyze(source, ingressWith({
        'haproxy.org/ssl-redirect': 'true',
        'haproxy.org/ssl-redirect-code': '307',
    }), 'annotation').text;
    assert.match(code307, /nginx\.org\/http-redirect-code: "?307/);
});

test('timeout-server sets BOTH proxy-read-timeout and proxy-send-timeout', () => {
    const { source } = load();
    const { text } = analyze(source, ingressWith({ 'haproxy.org/timeout-server': '50s' }), 'annotation');
    assert.match(text, /proxy-read-timeout: "?50s/);
    assert.match(text, /proxy-send-timeout: "?50s/);
});

test('HAProxy bare times are milliseconds: timeout-connect "5000" becomes 5s', () => {
    const { source } = load();
    const cm = [
        'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: haproxy-kubernetes-ingress',
        'data:', '  timeout-connect: "5000"',
    ].join('\n');
    assert.match(analyze(source, cm, 'crd').text, /proxy-connect-timeout: "?5s/);
});

test('rate-limit: requests/period convert to r/s or r/m and rejectCode stays explicit (HAProxy 403 default)', () => {
    const { source } = load();
    const perSecond = analyze(source, ingressWith({
        'haproxy.org/rate-limit-requests': '100',
        'haproxy.org/rate-limit-period': '1s',
        'haproxy.org/rate-limit-status-code': '429',
    }), 'crd').text;
    assert.match(perSecond, /rate: 100r\/s/);
    assert.match(perSecond, /rejectCode: 429/);

    const perMinute = analyze(source, ingressWith({
        'haproxy.org/rate-limit-requests': '100',
        'haproxy.org/rate-limit-period': '1m',
    }), 'crd').text;
    assert.match(perMinute, /rate: 100r\/m/);
    assert.match(perMinute, /rejectCode: 403/, 'unset status-code must emit the HAProxy 403 default');
});

// NIC stores this key's value as MainServerSSLDHParamFileContent and writes
// the file itself (configurator AddOrUpdateDHParam), so the key holds the DH
// parameters, not a path. Passing HAProxy's path straight through looks right
// and breaks the reload.
test('ssl_dh_param_file emits PEM content, never the HAProxy path', () => {
    const { source } = load();
    const cr = [
        'apiVersion: ingress.v3.haproxy.org/v3', 'kind: Global', 'metadata:', '  name: haproxy-global',
        'spec:', '  ssl_options:', '    dh_param_file: /etc/ssl/dhparam.pem',
    ].join('\n');
    const { text } = analyze(source, cr, 'crd');
    assert.match(text, /ssl-dhparam-file: \|/, 'must be a block scalar, not a quoted scalar');
    assert.match(text, /-----BEGIN DH PARAMETERS-----/);
    assert.ok(!/ssl-dhparam-file: "/.test(text), 'must not emit the path as the value');
});

test('load-balance: verified value map incl. no-equivalent fallbacks', () => {
    const { source } = load();
    const lb = (v) => analyze(source, ingressWith({ 'haproxy.org/load-balance': v }), 'annotation');
    assert.match(lb('leastconn').text, /lb-method: "?least_conn/);
    assert.match(lb('source').text, /lb-method: "?ip_hash/);
    assert.match(lb('uri').text, /hash \$request_uri consistent/);
    const first = lb('first');
    assert.ok(!/lb-method/.test(first.text), 'balance first has no NIC equivalent');
    assert.ok(first.plan.infoNotes.some((n) => /first/.test(n.code)));
});

test('allow-list beside deny-list: one allow Policy, and the denied addresses inside it still denied', () => {
    /* HAProxy denies a client outside allow-list OR inside deny-list. NGINX
       Ingress Controller applies only the allow Policy when a resource
       references both, so two Policies dropped the deny list without a word.
       A denied address inside an allowed range must still be denied. */
    const { source } = load();
    const yaml = ingressWith({ 'haproxy.org/allow-list': '10.0.0.0/8', 'haproxy.org/deny-list': '10.1.2.3,192.168.1.1' });
    for (const strategy of ['crd', 'annotation']) {
        const { text } = analyze(source, yaml, strategy);
        assert.doesNotMatch(text, /access-control-deny/, strategy + ': a deny Policy is ignored beside an allow one');
        assert.match(text, /allow:\s*\n\s*- 10\.0\.0\.0\/8/, strategy);
        assert.match(text, /deny 10\.1\.2\.3;/, strategy + ': the denied address inside the allowed range');
        assert.doesNotMatch(text, /deny 192\.168\.1\.1;/, strategy + ': outside every allowed range, allow-only blocks it');
    }
    // A deny list on its own is still a deny Policy.
    assert.match(analyze(source, ingressWith({ 'haproxy.org/deny-list': '10.1.2.3' }), 'crd').text, /deny:\s*\n\s*- 10\.1\.2\.3/);
});

test('5.7: server-proto h2 becomes proxy-http-version "2", on the annotation and the upstream field', () => {
    /* v5.7.0 sets the upstream HTTP version (annotations.go, http_version.go).
       Before it, generic HTTP/2 to a backend had no form at all. */
    const { source } = load();
    const svc = ingressWith({ 'haproxy.org/server-proto': 'h2' });
    assert.match(analyze(source, svc, 'annotation').text, /nginx\.org\/proxy-http-version: "2"/);
    assert.match(analyze(source, svc, 'crd').text, /proxy-http-version: "2"\s+# haproxy\.org\/server-proto/);
});

test('5.6: set-host becomes nginx.org/upstream-vhost when it is a plain hostname, a VirtualServer otherwise', () => {
    const { source } = load();
    const plain = analyze(source, ingressWith({ 'haproxy.org/set-host': 'Internal.Example.com' }), 'annotation').text;
    assert.match(plain, /nginx\.org\/upstream-vhost: "internal\.example\.com"/, 'lowercased, as validation requires');
    // A port fails upstream-vhost validation and would reject the Ingress.
    const port = analyze(source, ingressWith({ 'haproxy.org/set-host': 'internal.example.com:8080' }), 'annotation').text;
    assert.doesNotMatch(port, /nginx\.org\/upstream-vhost:/);
    assert.match(port, /name: Host\s+value: "internal\.example\.com:8080"/);
});

test('a header value built from a sample fetch never lands in a literal-only annotation', () => {
    /* nginx.org/proxy-set-headers and add-header take literal values only; %[src]
       is HAProxy syntax, and a "$" makes NGINX Ingress Controller reject the Ingress. */
    const { source } = load();
    const { text, plan } = analyze(source, ingressWith({ 'haproxy.org/request-set-header': 'X-Client %[src]' }), 'annotation');
    assert.doesNotMatch(text, /proxy-set-headers/);
    assert.match(text, /kind: VirtualServer/);
    assert.ok((plan.infoNotes || []).some((n) => /sample fetch/.test(n.message)), 'the rewrite is called out');
});

test('5.6: forwarded-for "false" becomes the disable-forwarded-headers ConfigMap key, with its cost named', () => {
    const { source } = load();
    const { text, plan } = analyze(source, ingressWith({ 'haproxy.org/forwarded-for': 'false' }), 'crd');
    assert.match(text, /disable-forwarded-headers: "true"/);
    assert.ok((plan.infoNotes || []).some((n) => /global/.test(n.message) && /-enable-snippets/.test(n.message)));
});

test('cors-respond-to-options is answered by the cors Policy, not reported as unsupported', () => {
    /* The cors Policy renders "if ($request_method = 'OPTIONS') { return 204; }",
       which is what HAProxy's annotation turned on (resSetCORS.go). */
    const { source } = load();
    const { plan } = analyze(source, ingressWith({ 'haproxy.org/cors-enable': 'true', 'haproxy.org/cors-respond-to-options': 'true' }), 'crd');
    assert.ok(!plan.unsupported || !plan.unsupported.cards.some((c) => /respond-to-options/.test(c.code)));
    assert.ok((plan.infoNotes || []).some((n) => /respond-to-options/.test(n.code) && /204/.test(n.message)));
});
