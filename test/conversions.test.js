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
