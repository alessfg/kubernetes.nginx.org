'use strict';
/* tools/nic-migrate — CLI behaviour that nothing else guards.
   =========================================================================
   The CLI reads the shipped analyzer rather than a copy of it, so the mapping
   database itself is already covered by test-analyzer.js and the wiring suite.
   What is only covered here is the layer the CLI adds: document splitting,
   the Ingress scanner, and the gap checks that tell a reader which parts of a
   real manifest the engine's single-context model did not carry over.

   These tests live under .github/test/ rather than beside the tool so CI picks
   them up from the existing `node --test .github/test/*.test.js` glob and
   GitHub Pages does not serve them. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ROOT } = require('./lib/load.js');
const TOOL = path.join(ROOT, 'tools', 'nic-migrate');

const { splitDocuments, isIngress, describe: describeIngress } = require(path.join(TOOL, 'lib', 'ingress.js'));
const { detect, sortGaps } = require(path.join(TOOL, 'lib', 'gaps.js'));
const { createEngine } = require(path.join(TOOL, 'lib', 'engine.js'));
const { splitKubectlList, loadChecklist } = require(path.join(TOOL, 'nic-migrate.js'));

const engine = createEngine();
const analyze = (yaml) => {
    const result = engine.analyze(yaml, 'crd');
    const desc = describeIngress(yaml);
    return { desc, result, gaps: sortGaps(detect(desc, result)) };
};
const gapIds = (a) => a.gaps.map((g) => g.id);

const ing = (annotations, spec) => [
    'apiVersion: networking.k8s.io/v1',
    'kind: Ingress',
    'metadata:',
    '  name: app',
    '  namespace: prod',
    '  annotations:',
    ...annotations.map((a) => '    nginx.ingress.kubernetes.io/' + a),
    'spec:',
    ...spec
].join('\n');

const ONE_RULE = [
    '  rules:',
    '  - host: a.example.com',
    '    http:',
    '      paths:',
    '      - path: /',
    '        backend:',
    '          service:',
    '            name: a-svc',
    '            port:',
    '              number: 80'
];

test('splitDocuments separates a multi-document stream and ignores --- inside values', () => {
    const docs = splitDocuments('kind: Ingress\na: 1\n---\nkind: Service\nb: "---"\n');
    assert.equal(docs.length, 2);
    assert.equal(docs.filter(isIngress).length, 1);
});

test('splitKubectlList expands a List into one document per item', () => {
    /* Regression: the item check has to precede the "back to top level" test,
       because "- apiVersion:" starts at column 0 and is non-whitespace. With
       the tests in the other order the scan ended on the first item and the
       whole List was analyzed as a single Ingress. */
    const list = [
        'apiVersion: v1',
        'kind: List',
        'items:',
        '- apiVersion: networking.k8s.io/v1',
        '  kind: Ingress',
        '  metadata:',
        '    name: alpha',
        '    namespace: ns1',
        '- apiVersion: networking.k8s.io/v1',
        '  kind: Ingress',
        '  metadata:',
        '    name: beta',
        '    namespace: ns2',
        'metadata:',
        '  resourceVersion: ""'
    ].join('\n');
    const docs = splitKubectlList(list);
    assert.equal(docs.length, 2);
    assert.ok(docs.every(isIngress), 'every item should parse as an Ingress');
    assert.deepEqual(docs.map((d) => describeIngress(d).name), ['alpha', 'beta']);
    assert.deepEqual(docs.map((d) => describeIngress(d).namespace), ['ns1', 'ns2']);
});

test('describe extracts hosts, paths, services, TLS, namespace and class', () => {
    const d = describeIngress(ing(['proxy-body-size: 10m'], [
        '  ingressClassName: nginx',
        '  tls:',
        '  - hosts:',
        '    - a.example.com',
        '    secretName: a-tls',
        '  rules:',
        '  - host: a.example.com',
        '    http:',
        '      paths:',
        '      - path: /api',
        '        backend:',
        '          service:',
        '            name: api-svc',
        '            port:',
        '              number: 8080',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: web-svc',
        '            port:',
        '              number: 80',
        '  - host: b.example.com',
        '    http:',
        '      paths:',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: b-svc',
        '            port:',
        '              number: 80'
    ]));
    assert.deepEqual(d.hosts, ['a.example.com', 'b.example.com']);
    assert.equal(d.paths, 3);
    assert.deepEqual(d.services, ['api-svc', 'web-svc', 'b-svc']);
    assert.equal(d.hasTls, true);
    assert.deepEqual(d.tlsSecrets, ['a-tls']);
    assert.equal(d.namespace, 'prod');
    assert.equal(d.ingressClassName, 'nginx');
    assert.deepEqual(d.annotations, ['proxy-body-size']);
});

test('a block scalar body is not read as structure', () => {
    /* A snippet can contain anything, including lines that look like keys.
       Reading them would invent hosts and inflate the path count. */
    const d = describeIngress(ing([
        'configuration-snippet: |',
        '  host: not-a-real-host.example.com',
        '  path: /not-a-real-path'
    ], ONE_RULE));
    assert.deepEqual(d.hosts, ['a.example.com']);
    assert.equal(d.paths, 1);
});

test('tls hosts are not counted as rule hosts', () => {
    const d = describeIngress(ing(['proxy-body-size: 1m'], [
        '  tls:',
        '  - hosts:',
        '    - a.example.com',
        '    - alias.example.com',
        '    secretName: a-tls',
        ...ONE_RULE
    ]));
    assert.deepEqual(d.hosts, ['a.example.com'], 'tls[].hosts is a plural list, not a rule host');
});

test('two single-feature generators claiming one host are reported as a conflict', () => {
    /* rewrite-target and affinity each emit their own VirtualServer bound to
       the same host. Applied together NIC accepts one and rejects the other,
       so this has to surface as blocking rather than as two happy resources. */
    const a = analyze(ing(['rewrite-target: /$1', 'affinity: cookie'], ONE_RULE));
    const conflict = a.gaps.find((g) => g.id === 'host-conflict');
    assert.ok(conflict, 'expected a host-conflict gap, got: ' + gapIds(a).join(', '));
    assert.equal(conflict.severity, 'blocking');
    assert.match(conflict.message, /a\.example\.com/);
});

test('generated Policies that are never referenced are reported as unwired', () => {
    const a = analyze(ing(['enable-cors: "true"'], ONE_RULE));
    const unwired = a.gaps.find((g) => g.id === 'policy-unwired');
    assert.ok(unwired, 'expected policy-unwired, got: ' + gapIds(a).join(', '));
    assert.equal(unwired.severity, 'blocking');
});

test('hosts, paths and backends beyond the first are reported as dropped', () => {
    const a = analyze(ing(['rewrite-target: /$1'], [
        '  rules:',
        '  - host: a.example.com',
        '    http:',
        '      paths:',
        '      - path: /api',
        '        backend:',
        '          service:',
        '            name: api-svc',
        '            port:',
        '              number: 8080',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: web-svc',
        '            port:',
        '              number: 80',
        '  - host: b.example.com',
        '    http:',
        '      paths:',
        '      - path: /',
        '        backend:',
        '          service:',
        '            name: b-svc',
        '            port:',
        '              number: 80'
    ]));
    const ids = gapIds(a);
    for (const id of ['hosts-dropped', 'paths-dropped', 'backends-dropped']) {
        assert.ok(ids.includes(id), 'expected ' + id + ', got: ' + ids.join(', '));
    }
});

test('an annotation-only migration reports no blocking gaps', () => {
    /* The negative case matters as much as the positives: if every input came
       back blocking, the severity would carry no information. */
    const a = analyze(ing(['proxy-body-size: 10m', 'proxy-connect-timeout: "30"'], ONE_RULE));
    const blocking = a.gaps.filter((g) => g.severity === 'blocking');
    assert.deepEqual(blocking, [], 'unexpected blocking gaps: ' + JSON.stringify(blocking));
    assert.match(a.result.yaml, /nginx\.org\/client-max-body-size/);
});

test('an unmapped annotation is reported rather than silently dropped', () => {
    const a = analyze(ing(['not-a-real-annotation: "1"'], ONE_RULE));
    const note = a.gaps.find((g) => g.id === 'unrecognized');
    assert.ok(note, 'expected unrecognized, got: ' + gapIds(a).join(', '));
    assert.match(note.message, /not-a-real-annotation/);
});

test('the checklist is read from the published page, not duplicated here', () => {
    const items = loadChecklist();
    assert.ok(items.length >= 20, 'expected the full checklist, got ' + items.length + ' items');
    assert.ok(items.every((t) => t.length > 0 && !/[<>]/.test(t)), 'items should be plain text');
});
