'use strict';
/* Analyzer regression tests for every source module on the shared engine.
   Run with: node --test test/
   The load-bearing invariant is warnings.length === 0 — buildPlan wraps each
   generator in a try/catch that only console.warn()s, so a broken generator
   silently drops its resource instead of throwing. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

const MODULES = [
    { name: 'ingress-nginx', file: 'assets/js/migration-ingress-nginx.js' },
    { name: 'haproxy', file: 'assets/js/migration-haproxy.js' },
];

for (const mod of MODULES) {
    test(`${mod.name}: every sample preset × strategy builds a plan with zero generator warnings`, () => {
        const { source, warnings } = loadAnalyzer(mod.file);
        for (const [presetName, yaml] of Object.entries(source.analyzer.samplePresets)) {
            for (const strategy of ['annotation', 'crd']) {
                const before = warnings.length;
                const { parsed, plan } = analyze(source, yaml, strategy);
                assert.equal(warnings.length, before,
                    `${presetName} × ${strategy} warned: ${warnings.slice(before).join(' | ')}`);
                assert.ok(parsed.foundCount > 0, `${presetName}: no findings`);
                assert.ok(plan.steps.length > 0, `${presetName} × ${strategy}: no steps`);
                assert.ok(plan.pills.length >= 2 && plan.banner && plan.liveText,
                    `${presetName} × ${strategy}: summary metadata missing`);
                assert.ok(plan.export && plan.export.parts.length > 0,
                    `${presetName} × ${strategy}: no export output`);
                for (const part of plan.export.parts) {
                    assert.ok(part && part.trim(), `${presetName} × ${strategy}: empty export part`);
                }
            }
        }
    });

    test(`${mod.name}: empty and foreign input produce no findings and no warnings`, () => {
        const { source, warnings } = loadAnalyzer(mod.file);
        for (const input of ['', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: plain\nspec:\n  ports:\n    - port: 80']) {
            const { parsed, plan } = analyze(source, input, 'crd');
            assert.equal(parsed.foundCount, 0);
            assert.equal(plan.steps.length, 0);
        }
        assert.equal(warnings.length, 0, warnings.join(' | '));
    });
}

test('haproxy: unknown haproxy.org annotation lands in the unrecognized bucket', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: x',
        '  annotations:', '    haproxy.org/not-a-real-thing: "1"',
        'spec:', '  rules:', '    - host: a.example.com',
    ].join('\n');
    const { plan } = analyze(source, yaml, 'crd');
    assert.ok(plan.unrecognized, 'expected an unrecognized section');
    assert.equal(plan.unrecognized.items.length, 1);
});

test('haproxy: v1 CRD spec.config unwraps and maps Global fields', () => {
    const { source, warnings } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: ingress.v1.haproxy.org/v1', 'kind: Global', 'metadata:', '  name: g',
        'spec:', '  config:', '    maxconn: 5000', '    nbthread: 4',
    ].join('\n');
    const { parsed, plan, text } = analyze(source, yaml, 'crd');
    assert.equal(warnings.length, 0, warnings.join(' | '));
    assert.equal(parsed.foundCount, 1);
    assert.match(text, /worker-connections: "?5000/);
    assert.match(text, /worker-processes: "?4/);
    // v1 group warning surfaces to the user
    assert.ok(plan.warnings.some((w) => /ingress\.v1\.haproxy\.org/.test(w.title)));
});

test('haproxy: v3 Global CRD unwraps nested performance/ssl options', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: ingress.v3.haproxy.org/v3', 'kind: Global', 'metadata:', '  name: g',
        'spec:', '  nbthread: 4',
        '  performance_options:', '    maxconn: 40000',
        '  ssl_options:', '    default_bind_ciphers: ECDHE-RSA-AES256-GCM-SHA384',
    ].join('\n');
    const { text } = analyze(source, yaml, 'crd');
    assert.match(text, /worker-connections: "?40000/);
    assert.match(text, /ssl-ciphers: "?ECDHE-RSA-AES256-GCM-SHA384/);
});

test('haproxy: tcp-services ConfigMap becomes GlobalConfiguration + TransportServer per entry', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: tcp-services', '  namespace: default',
        'data:', '  "5432": "databases/postgres:5432"',
    ].join('\n');
    const { text } = analyze(source, yaml, 'crd');
    assert.match(text, /kind: GlobalConfiguration/);
    assert.match(text, /protocol: TCP/);
    assert.match(text, /kind: TransportServer/);
    assert.match(text, /service: postgres/);
});

test('haproxy: ssl-passthrough emits a TLS_PASSTHROUGH TransportServer', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: pt',
        '  annotations:', '    haproxy.org/ssl-passthrough: "true"',
        'spec:', '  rules:', '    - host: pt.example.com', '      http:', '        paths:',
        '          - path: /', '            pathType: Prefix', '            backend:',
        '              service:', '                name: pt-svc', '                port:', '                  number: 443',
    ].join('\n');
    const { text } = analyze(source, yaml, 'crd');
    assert.match(text, /TLS_PASSTHROUGH/);
    assert.match(text, /host: pt\.example\.com/);
});

test('haproxy: hard no-equivalents surface as unsupported cards, not silently dropped', () => {
    const { source } = loadAnalyzer('assets/js/migration-haproxy.js');
    const yaml = [
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: u',
        '  annotations:',
        '    haproxy.org/send-proxy-protocol: "proxy-v2"',
        '    haproxy.org/rate-limit-whitelist: "10.0.0.0/8"',
        '    haproxy.org/quic-alt-svc-max-age: "60"',
        'spec:', '  rules:', '    - host: u.example.com',
    ].join('\n');
    const { plan } = analyze(source, yaml, 'crd');
    assert.ok(plan.unsupported, 'expected unsupported section');
    assert.equal(plan.unsupported.cards.length, 3);
});
