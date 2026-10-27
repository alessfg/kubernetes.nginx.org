'use strict';
/* The migration analyzer's behaviour on real manifests — one test per defect
   the 2026-10-09 audit found (named A1, B4 and so on in the commit that added
   this file), plus the guarantees the rewrite rests on. test-analyzer.js covers the presets and
   the mapping/table contract; nic-migrate.test.js covers the CLI.

   Every manifest here goes through the same parseInput/buildPlan the page
   runs, so a failure is what a reader would have pasted and been told. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-ingress-nginx.js');
const Y = tool.yaml;

// An Ingress with one TLS host and one backend, plus the given annotations.
const ingress = (ann, extra) => {
    const doc = {
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
        metadata: { name: 'app', annotations: {} },
        spec: {
            tls: [{ hosts: ['a.example.com'], secretName: 'a-tls' }],
            rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }]
        }
    };
    for (const k of Object.keys(ann || {})) doc.metadata.annotations['nginx.ingress.kubernetes.io/' + k] = ann[k];
    return Object.assign(doc, extra || {});
};
const run = (doc, strategy) => {
    const before = warnings.length;
    const r = analyze(source, typeof doc === 'string' ? doc : Y.stringify(doc), strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    // The analyzer runs in a vm context, so its objects belong to another
    // realm and strict deepEqual compares their prototypes: re-home them.
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))) });
};
const kinds = (r, kind) => r.docs.filter((d) => d.kind === kind);
const notes = (r) => r.plan.infoNotes.map((n) => n.code + ' — ' + n.message).join('\n');

/* ---------------------------------------------------------------- parsing */

test('A1: values kubectl wraps onto continuation lines are read whole', () => {
    const r = run([
        'apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  annotations:',
        '    nginx.ingress.kubernetes.io/whitelist-source-range: 10.0.0.0/8, 172.16.0.0/12,',
        '      192.168.0.0/16',
        '    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, X-One,',
        '      X-Two"',
        '    nginx.ingress.kubernetes.io/enable-cors: "true"',
        '  name: wrapped',
        'spec:', '  rules:', '  - host: a.example.com', '    http:', '      paths:', '      - path: /', '        pathType: Prefix',
        '        backend: {service: {name: web, port: {number: 80}}}'
    ].join('\n'));
    const acl = kinds(r, 'Policy').find((p) => p.spec.accessControl);
    assert.deepEqual(acl.spec.accessControl.allow, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
    const cors = kinds(r, 'Policy').find((p) => p.spec.cors);
    assert.deepEqual(cors.spec.cors.allowHeaders, ['Authorization', 'X-One', 'X-Two']);
    assert.equal(kinds(r, 'VirtualServer')[0].metadata.name, 'wrapped', 'the rest of the document survives');
});

test('A2: quote escapes are decoded', () => {
    const r = run(ingress({ 'configuration-snippet': 'add_header X-Debug "#1";' }));
    const vs = kinds(r, 'VirtualServer')[0];
    assert.equal(vs.spec.routes[0]['location-snippets'], 'add_header X-Debug "#1";\n');
    const r2 = run("apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app\n  annotations:\n    nginx.ingress.kubernetes.io/auth-realm: 'Bob''s'\n    nginx.ingress.kubernetes.io/auth-secret: s\nspec:\n  rules:\n  - host: a.example.com\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend: {service: {name: web, port: {number: 80}}}\n");
    assert.equal(kinds(r2, 'Policy')[0].spec.basicAuth.realm, "Bob's");
});

test('A9: hosts and paths come from the Ingress, not from other documents', () => {
    const deploy = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n      - name: c\n        livenessProbe:\n          httpGet: {path: /healthz, port: 8080}\n';
    const r = run(deploy + '---\n' + Y.stringify(ingress({ 'proxy-body-size': '1m' })));
    assert.deepEqual(kinds(r, 'VirtualServer')[0].spec.routes.map((x) => x.path), ['/']);
    assert.match(r.plan.warnings.map((w) => w.message).join(), /1 Deployment/);
});

test('A10: a literal backslash-n in a value is not a line break', () => {
    const r = run(ingress({ 'server-snippet': "location = /ping { return 200 'pong\\n'; }" }));
    assert.equal(kinds(r, 'VirtualServer')[0].spec['server-snippets'], "location = /ping { return 200 'pong\\n'; }\n");
});

test('A16: kubectl -o json input is analyzed', () => {
    const r = run(JSON.stringify(ingress({ 'proxy-body-size': '8m' })));
    assert.equal(kinds(r, 'VirtualServer')[0].spec.upstreams[0]['client-max-body-size'], '8m');
});

test('A18: thousands of blank lines do not stall the parser', () => {
    const t0 = Date.now();
    run(Y.stringify(ingress({ 'proxy-body-size': '8m' })) + '\n'.repeat(8000));
    assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
});

test('A20: inline annotation maps keep each key separate', () => {
    const r = run('apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app\n  annotations: {nginx.ingress.kubernetes.io/proxy-body-size: 8m, nginx.ingress.kubernetes.io/proxy-read-timeout: "60"}\nspec:\n  rules:\n  - host: a.example.com\n    http:\n      paths:\n      - path: /\n        pathType: Prefix\n        backend: {service: {name: web, port: {number: 80}}}\n');
    const u = kinds(r, 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(u['client-max-body-size'], '8m');
    assert.equal(u['read-timeout'], '60s');
});

test('C6: an Ingress with no community annotations still migrates', () => {
    const doc = ingress({});
    delete doc.metadata.annotations;
    const parsed = source.analyzer.parseInput(Y.stringify(doc));
    assert.equal(parsed.empty, null, 'not reported as "no annotations found"');
    const r = run(doc);
    assert.equal(kinds(r, 'VirtualServer')[0].spec.tls.secret, 'a-tls');
    assert.match(r.plan.banner.strongText, /no community annotations/);
});

test('C6: an unparseable paste and a non-Ingress paste say why', () => {
    const bad = source.analyzer.parseInput('a: 1\n  b: 2\n');
    assert.match(bad.empty.title, /could not be parsed/);
    const svc = source.analyzer.parseInput('apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n');
    assert.match(svc.empty.message, /1 Service/);
});

/* -------------------------------------------------------------- assembly */

test('B1/A4: one VirtualServer per host, carrying TLS — never two on one host', () => {
    const r = run(ingress({ affinity: 'cookie', 'proxy-read-timeout': '30', 'rewrite-target': '/' }));
    const vs = kinds(r, 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.equal(vs[0].spec.tls.secret, 'a-tls');
    assert.ok(!/^annotations:/m.test(r.text), 'no bare annotations: block in the export');
});

test('B1: every host, path and backend of a multi-host Ingress is carried over', () => {
    const doc = ingress({ 'proxy-body-size': '1m' });
    doc.spec.rules.push({ host: 'b.example.com', http: { paths: [{ path: '/x', pathType: 'Prefix', backend: { service: { name: 'other', port: { number: 8080 } } } }] } });
    const vs = kinds(run(doc), 'VirtualServer');
    assert.deepEqual(vs.map((v) => v.spec.host), ['a.example.com', 'b.example.com']);
    assert.equal(vs[1].spec.upstreams[0].service, 'other');
    assert.equal(vs[1].spec.tls, undefined, 'only the TLS host gets tls');
});

test('B1: annotation-first emits the whole migrated Ingress, not an annotations fragment', () => {
    const r = run(ingress({ 'proxy-body-size': '8m' }), 'annotation');
    const ing = kinds(r, 'Ingress')[0];
    assert.equal(ing.metadata.annotations['nginx.org/client-max-body-size'], '8m');
    assert.deepEqual(ing.spec.tls, [{ hosts: ['a.example.com'], secretName: 'a-tls' }]);
});

test('every recognised annotation is named in the output, under both strategies', () => {
    /* A3: ~25 recognised annotations used to vanish under "Analysis complete".
       Each of the 130 now ends up in a generated comment, a note or a card. */
    const SAMPLE = { 'whitelist-source-range': '10.0.0.0/8', canary: 'true', affinity: 'cookie', 'auth-url': 'http://auth.ns.svc.cluster.local/auth',
        'enable-cors': 'true', 'backend-protocol': 'HTTPS', 'load-balance': 'ewma', 'upstream-hash-by': '$request_uri', 'proxy-buffering': 'on',
        'connection-proxy-header': 'keep-alive', 'ssl-passthrough': 'true', 'custom-http-errors': '404', 'permanent-redirect': 'https://x.example.com',
        'temporal-redirect': 'https://t.example.com', 'limit-rps': '10', 'mirror-target': 'https://m.example.com', 'auth-type': 'basic',
        'rewrite-target': '/', 'app-root': '/a', 'stream-snippet': 'server { listen 1; }', 'server-alias': 'b.example.com',
        'auth-tls-secret': 'ns/ca', 'proxy-ssl-secret': 'ns/c', 'custom-headers': 'ns/cm', 'from-to-www-redirect': 'true', 'default-backend': 'svc' };
    const NEEDS = [[/^canary-/, { canary: 'true' }], [/^cors-/, { 'enable-cors': 'true' }], [/^(session-cookie|affinity-mode)/, { affinity: 'cookie' }],
        [/^auth-(signin|snippet|method|response-headers|request-redirect|signin-redirect-param|cache-key|cache-duration|proxy-set-headers)$/, { 'auth-url': 'http://auth.ns.svc.cluster.local/auth' }],
        [/^permanent-redirect-code$/, { 'permanent-redirect': 'https://x.example.com' }], [/^temporal-redirect-code$/, { 'temporal-redirect': 'https://t.example.com' }],
        [/^proxy-ssl-/, { 'proxy-ssl-secret': 'ns/c' }], [/^limit-burst-multiplier$/, { 'limit-rps': '10' }], [/^auth-(secret-type|realm|type)$/, { 'auth-secret': 's' }],
        [/^upstream-hash-by-subset/, { 'upstream-hash-by': '$request_uri' }]];
    const mapped = [];
    for (const m of source.analyzer.mappings) mapped.push(...m.community);
    assert.equal(mapped.length, 130);
    const missing = [];
    for (const name of mapped) {
        for (const strategy of ['crd', 'annotation']) {
            const ann = { [name]: SAMPLE[name] !== undefined ? SAMPLE[name] : '7' };
            for (const [re, add] of NEEDS) if (re.test(name)) Object.assign(ann, add);
            const r = run(ingress(ann), strategy);
            const found = (r.text.match(/#.*$/gm) || []).join('\n') + JSON.stringify([r.plan.infoNotes, r.plan.unsupported, r.plan.unrecognized]);
            if (!new RegExp('(^|[^a-z-])' + name + '($|[^a-z-])').test(found)) missing.push(strategy + ' ' + name);
            // Named only as "no translation" is a lost feature, not a migration:
            // every mapped annotation has one (this caught mirror-host and
            // mirror-request-body being dropped when mirroring lost its branch).
            if (r.plan.infoNotes.some((n) => n.code.includes('/' + name + ':') && /has no translation for it/.test(n.message))) missing.push(strategy + ' ' + name + ' (untranslated)');
        }
    }
    assert.deepEqual(missing, [], 'recognised but not named anywhere in the output');
});

/* ----------------------------------------------------------- B: accuracy */

test('B2: app-root is a 302 from "/" only, not a rewrite of everything', () => {
    const vs = kinds(run(ingress({ 'app-root': '/app1' })), 'VirtualServer')[0];
    assert.deepEqual(vs.spec.routes[0], { path: '=/', action: { redirect: { url: '${scheme}://${host}/app1', code: 302 } } });
    assert.equal(vs.spec.routes[1].action.pass, 'web');
    assert.equal(run(ingress({ 'app-root': '/app1' }), 'annotation').docs[0].metadata.annotations['nginx.org/app-root'], '/app1');
});

test('B2/B6: rewrite-target regex routes match like the community ~* and sort longest first', () => {
    const doc = ingress({ 'rewrite-target': '/$2' });
    doc.spec.rules[0].http.paths.unshift({ path: '/api(/|$)(.*)', pathType: 'ImplementationSpecific', backend: { service: { name: 'api', port: { number: 80 } } } });
    const vs = kinds(run(doc), 'VirtualServer')[0];
    assert.deepEqual(vs.spec.routes.map((x) => x.path), ['~ (?i)^/api(/|$)(.*)', '~ (?i)^/']);
    assert.equal(vs.spec.routes[0].action.proxy.rewritePath, '/$2');
    assert.equal(vs.spec.routes[1].action.pass, 'web', '"/" rewritten to "/" is dropped');
    const ing = run(doc, 'annotation').docs.find((d) => d.kind === 'Ingress');
    assert.equal(ing.metadata.annotations['nginx.org/path-regex'], 'case_insensitive');
});

test('B3/A6/A7: a canary defaults to weight 0, and never labels the canary as main', () => {
    const lone = kinds(run(ingress({ canary: 'true', 'canary-by-header': 'X-C' })), 'VirtualServer')[0];
    const route = lone.spec.routes[0];
    assert.equal(route.splits, undefined, 'no split without canary-weight');
    assert.equal(route.action.pass, 'stable', 'the default leg is the stable placeholder');
    assert.equal(route.matches[0].action.pass, 'web');
    const weighted = kinds(run(ingress({ canary: 'true', 'canary-weight': '30' })), 'VirtualServer')[0].spec.routes[0];
    assert.deepEqual(weighted.splits.map((s) => [s.weight, s.action.pass]), [[70, 'stable'], [30, 'web']]);
    assert.ok(!weighted.action, 'a route has splits or an action, never both');
});

test('B3: a canary pasted with its stable Ingress merges into one VirtualServer', () => {
    const stable = ingress({});
    delete stable.metadata.annotations;
    stable.spec.rules[0].http.paths[0].backend.service.name = 'stable-svc';
    const canary = ingress({ canary: 'true', 'canary-weight': '25' });
    canary.metadata.name = 'app-canary';
    canary.spec.rules[0].http.paths[0].backend.service.name = 'canary-svc';
    const r = run(Y.stringifyAll([stable, canary]));
    const vs = kinds(r, 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.deepEqual(vs[0].spec.routes[0].splits.map((s) => s.weight), [75, 25]);
    assert.equal(vs[0].spec.routes[0].splits[0].action.pass, 'stable-svc');
});

test('B4: an allow list beside a deny list still denies the addresses inside it', () => {
    /* NIC uses only the allow list when a resource references both; the
       community controller denied first. The denied addresses inside the
       allowed ranges go into a location snippet, which NIC renders before the
       Policy's allow rules (nginx 1.29: 10.1.2.3 -> 403, 10.9.9.9 -> 200). */
    const r = run(ingress({ 'whitelist-source-range': '10.0.0.0/8', 'denylist-source-range': '10.1.2.3,192.168.1.1' }));
    const p = kinds(r, 'Policy');
    assert.equal(p.length, 1);
    assert.deepEqual(p[0].spec.accessControl, { allow: ['10.0.0.0/8'] });
    assert.equal(kinds(r, 'VirtualServer')[0].spec.routes[0]['location-snippets'], 'deny 10.1.2.3;\n');
});

test('B7: externalAuth names the Service, keeps the port and drops community-only variables', () => {
    const r = run(ingress({ 'auth-url': 'http://oauth2-proxy.auth.svc.cluster.local:4180/oauth2/auth',
        'auth-signin': 'https://$host/oauth2/start?rd=$escaped_request_uri', 'auth-response-headers': 'X-Auth-Request-User' }));
    const ea = kinds(r, 'Policy')[0].spec.externalAuth;
    assert.equal(ea.authServiceName, 'auth/oauth2-proxy');
    assert.deepEqual(ea.authServicePorts, [4180]);
    assert.equal(ea.authSigninURI, '/oauth2/start');
    assert.ok(!/escaped_request_uri/.test(r.text));
    assert.match(kinds(r, 'VirtualServer')[0].spec.routes[0]['location-snippets'], /proxy_set_header X-Auth-Request-User \$auth_x_auth_request_user;/);
    const ext = kinds(run(ingress({ 'auth-url': 'https://auth.example.com/check' })), 'Policy')[0].spec.externalAuth;
    assert.notEqual(ext.authServiceName, 'auth', 'an external host is not a Service name');
});

test('B8: snippets carry the enable-snippets warning, and headers-more is called out', () => {
    const r = run(ingress({ 'configuration-snippet': 'more_set_headers "X: 1";' }));
    assert.match(notes(r), /-enable-snippets/);
    assert.match(notes(r), /more_set_headers[^\n]*unknown directive/);
});

test('B9: the CA secret type NIC requires is stated', () => {
    assert.match(notes(run(ingress({ 'auth-tls-secret': 'ns/ca' }))), /nginx\.org\/ca/);
});

test('B10: GRPCS gets TLS, the gRPC type and HTTP/2, in both strategies', () => {
    const r = run(ingress({ 'backend-protocol': 'GRPCS' }));
    const u = kinds(r, 'VirtualServer')[0].spec.upstreams[0];
    assert.deepEqual([u.type, u.tls], ['grpc', { enable: true }]);
    assert.equal(kinds(r, 'ConfigMap')[0].data.http2, 'true');
    const ann = run(ingress({ 'backend-protocol': 'GRPCS' }), 'annotation').docs.find((d) => d.kind === 'Ingress').metadata.annotations;
    assert.equal(ann['nginx.org/grpc-services'], 'web');
    assert.equal(ann['nginx.org/ssl-services'], 'web');
});

test('B11: TLS passthrough is a TransportServer under both strategies, with the flag named', () => {
    for (const s of ['crd', 'annotation']) {
        const r = run(ingress({ 'ssl-passthrough': 'true' }), s);
        assert.equal(kinds(r, 'TransportServer')[0].spec.listener.protocol, 'TLS_PASSTHROUGH');
        assert.match(notes(r), /enableTLSPassthrough/);
    }
});

test('B12: CORS keeps the community defaults, and never pairs * with credentials', () => {
    const cors = kinds(run(ingress({ 'enable-cors': 'true' })), 'Policy')[0].spec.cors;
    assert.equal(cors.allowCredentials, true);
    assert.equal(cors.maxAge, 1728000);
    assert.ok(cors.allowMethods.includes('PATCH'));
    assert.ok(!cors.allowOrigin.includes('*'));
});

test('B15: rate limits keep nodelay and the community 503', () => {
    const rl = kinds(run(ingress({ 'limit-rps': '10', 'limit-connections': '5' })), 'Policy')[0].spec.rateLimit;
    assert.deepEqual([rl.rate, rl.burst, rl.noDelay, rl.rejectCode], ['10r/s', 50, true, 503]);
    const r = run(ingress({ 'limit-rps': '10', 'limit-connections': '5' }));
    assert.match(kinds(r, 'ConfigMap')[0].data['http-snippets'], /limit_conn_zone \$binary_remote_addr zone=app_conn:5m;/);
    assert.match(kinds(r, 'VirtualServer')[0].spec.routes[0]['location-snippets'], /limit_conn app_conn 5;/);
});

test('B16: session affinity keeps max-age and the community cookie name', () => {
    const sc = kinds(run(ingress({ affinity: 'cookie', 'session-cookie-max-age': '172800' })), 'VirtualServer')[0].spec.upstreams[0].sessionCookie;
    assert.equal(sc.name, 'INGRESSCOOKIE');
    assert.equal(sc.expires, '2d');
    const ann = run(ingress({ affinity: 'cookie' }), 'annotation').docs.find((d) => d.kind === 'Ingress').metadata.annotations;
    assert.equal(ann['nginx.org/sticky-cookie-services'], 'serviceName=web INGRESSCOOKIE httponly');
});

test('CRD-first does not call a setting the VirtualServer carries "no VirtualServer form"', () => {
    /* Several translators write the VirtualServer field and the nginx.org/*
       annotation; the CRD-first fallback must not report the annotation as
       lost when the field already carries it (it did, for backend-protocol). */
    for (const ann of [{ 'backend-protocol': 'HTTPS' }, { 'backend-protocol': 'GRPC' }, { 'upstream-hash-by': '$request_uri' },
        { 'proxy-next-upstream': 'error' }, { 'upstream-vhost': 'u.example.com' }, { 'x-forwarded-prefix': '/p' }, { 'custom-headers': 'ns/cm' }]) {
        assert.doesNotMatch(notes(run(ingress(ann))), /has no VirtualServer form/, JSON.stringify(ann));
    }
    // ...and still reports one that has none.
    assert.match(notes(run(ingress({ 'proxy-max-temp-file-size': '1m' }))), /snippets/);
});

test('mirroring keeps the mirror, its Host and its request body', () => {
    const vs = kinds(run(ingress({ 'mirror-target': 'https://m.example.com$request_uri', 'mirror-request-body': 'off' })), 'VirtualServer')[0];
    assert.equal(vs.spec.routes[0]['location-snippets'], 'mirror /_mirror-app;\nmirror_request_body off;\n');
    assert.match(vs.spec['server-snippets'], /location = \/_mirror-app \{\n    internal;\n    proxy_set_header Host m\.example\.com;\n    proxy_pass https:\/\/m\.example\.com\$request_uri;\n\}/);
    // A hostname with a variable needs a resolver (nginx 1.29: "no resolver defined").
    assert.match(notes(run(ingress({ 'mirror-target': 'https://m.example.com$request_uri' }))), /resolver-addresses/);
    assert.doesNotMatch(notes(run(ingress({ 'mirror-target': 'https://m.example.com/fixed' }))), /resolver-addresses/);
});

test('A14: a beta Ingress migrates to a valid networking.k8s.io/v1 one', () => {
    const doc = ingress({ 'proxy-body-size': '8m' });
    doc.apiVersion = 'extensions/v1beta1';
    doc.spec.backend = { serviceName: 'default-svc', servicePort: 80 };
    doc.spec.rules[0].http.paths[0] = { path: '/', backend: { serviceName: 'web', servicePort: 'http' } };
    const ing = kinds(run(doc, 'annotation'), 'Ingress')[0];
    assert.equal(ing.apiVersion, 'networking.k8s.io/v1');
    assert.deepEqual(ing.spec.rules[0].http.paths[0], { path: '/', backend: { service: { name: 'web', port: { name: 'http' } } }, pathType: 'ImplementationSpecific' });
    assert.deepEqual(ing.spec.defaultBackend, { service: { name: 'default-svc', port: { number: 80 } } });
    assert.equal(ing.spec.backend, undefined);
});

test('B17: each server-alias is its own lowercase host', () => {
    const vs = kinds(run(ingress({ 'server-alias': 'www.example.com,Alt.Example.com' })), 'VirtualServer');
    assert.deepEqual(vs.map((v) => v.spec.host), ['a.example.com', 'www.example.com', 'alt.example.com']);
});

test('A5: generated YAML parses back — wildcard hosts, regex values, NO/YES', () => {
    const doc = ingress({ 'canary': 'true', 'canary-by-header': 'X-C', 'canary-by-header-pattern': '^v\\d+$', 'configuration-snippet': 'NO' });
    doc.spec.rules[0].host = '*.example.com';
    doc.spec.tls[0].hosts = ['*.example.com'];
    for (const s of ['crd', 'annotation']) {
        const r = run(doc, s);
        assert.ok(r.docs.length > 0);
        assert.ok(!/^\s*host: \*/m.test(r.text), 'a wildcard host is quoted');
    }
    const vs = kinds(run(doc), 'VirtualServer')[0];
    assert.equal(vs.spec.routes[0].matches[0].conditions[0].value, '~^v\\d+$');
});

test('A12/A19: empty and prototype-named values are reported, not crashed on or emitted', () => {
    const r = run(ingress({ 'proxy-buffer-size': '', 'load-balance': 'constructor' }));
    assert.ok(!/buffer-size|lb-method/.test(r.text.replace(/#.*$/gm, '')), r.text);
    assert.match(notes(r), /constructor/);
});

test('B14: force-ssl-redirect follows the request scheme, as the community controller did', () => {
    /* lua_ingress.lua redirects when pass_access_scheme is http: $scheme, or
       X-Forwarded-Proto only under the global use-forwarded-headers. With TLS
       on the Ingress that is tls.redirect's default (basedOn scheme); without
       TLS the note explains the load-balancer case instead of guessing. */
    const vs = kinds(run(ingress({ 'force-ssl-redirect': 'true' })), 'VirtualServer')[0];
    assert.deepEqual(vs.spec.tls.redirect, { enable: true, code: 308 });
    const noTls = ingress({ 'force-ssl-redirect': 'true' });
    delete noTls.spec.tls;
    assert.match(notes(run(noTls)), /use-forwarded-headers/);
});

test('C7: every migration names the ingressClassName change', () => {
    assert.match(notes(run(ingress({ 'proxy-body-size': '1m' }))), /ingressClassName/);
});

test('C8: the simple sample is not labelled advanced under CRD-first', () => {
    const r = run(source.analyzer.samplePresets.simple);
    assert.equal(r.plan.banner.complexity, 'simple');
});

test('generated resources pass the checks NIC applies at admission', () => {
    /* A static subset of NIC v5.6.3's validation: one of action/splits per
       route, split weights summing to 100, Service-name upstreams, valid
       redirect codes and error-page ranges. */
    const all = ['simple', 'moderate', 'advanced'].flatMap((p) => ['crd', 'annotation'].map((s) => run(source.analyzer.samplePresets[p], s)));
    all.push(run(ingress({ canary: 'true', 'canary-weight': '30', 'custom-http-errors': '404,503', 'permanent-redirect': 'https://x.example.com' })));
    for (const r of all) {
        for (const vs of kinds(r, 'VirtualServer')) {
            const names = new Set((vs.spec.upstreams || []).map((u) => u.name));
            for (const route of vs.spec.routes) {
                assert.equal(Number(!!route.action) + Number(!!route.splits), 1, 'route ' + route.path + ': exactly one of action / splits');
                if (route.splits) assert.equal(route.splits.reduce((n, s) => n + s.weight, 0), 100);
                for (const a of [route.action].concat((route.splits || []).map((s) => s.action), (route.matches || []).map((m) => m.action))) {
                    if (a && a.pass) assert.ok(names.has(a.pass), 'pass ' + a.pass + ' names an upstream');
                    if (a && a.redirect) assert.ok([301, 302, 307, 308].includes(a.redirect.code));
                }
                for (const e of route.errorPages || []) assert.ok(e.codes.every((c) => c >= 300 && c <= 599));
            }
        }
    }
});

/* Defects the reference-row sync found, each checked against NIC v5.6.3. */

test('a top-level auth-signin gets its own base path, never "/"', () => {
    /* NIC adds `location <authSigninRedirectBasePath>` for the sign-in. The
       parent of /login is "/", which duplicated the route's location "/". */
    for (const s of ['crd', 'annotation']) {
        const p = kinds(run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-signin': 'https://$host/login' }), s), 'Policy')[0];
        assert.equal(p.spec.externalAuth.authSigninURI, '/login');
        assert.equal(p.spec.externalAuth.authSigninRedirectBasePath, '/login');
    }
    const oauth = kinds(run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/oauth2/auth', 'auth-signin': 'https://$host/oauth2/start' })), 'Policy')[0];
    assert.equal(oauth.spec.externalAuth.authSigninRedirectBasePath, undefined, '/oauth2 is NIC\'s default');
    const clash = ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-signin': 'https://$host/api/login' });
    clash.spec.rules[0].http.paths.push({ path: '/api', pathType: 'Prefix', backend: { service: { name: 'api', port: { number: 80 } } } });
    assert.match(notes(run(clash)), /already routes \/api/);
});

test('enable-opentelemetry carries the exporter endpoint NIC requires', () => {
    /* otel-trace-in-http without otel-exporter-endpoint: NIC reports the
       ConfigMap invalid and turns tracing off (configmaps.go). */
    const r = run(ingress({ 'enable-opentelemetry': 'true' }));
    const cm = kinds(r, 'ConfigMap')[0];
    assert.equal(cm.data['otel-trace-in-http'], 'true');
    assert.ok(cm.data['otel-exporter-endpoint'], 'endpoint present');
    assert.match(r.text, /otel-exporter-endpoint: .*# TODO/);
    assert.equal(kinds(run(ingress({ 'enable-opentelemetry': 'false' })), 'ConfigMap').length, 0);
});

test('auth-always-set-cookie keeps always, and a plain auth-url says the cookie is not passed on', () => {
    for (const s of ['crd', 'annotation']) {
        const r = run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-always-set-cookie': 'true' }), s);
        assert.match(r.text, /add_header Set-Cookie \$auth_cookie always;/);
    }
    const plain = run(ingress({ 'auth-url': 'http://auth.default.svc.cluster.local/verify' }));
    assert.doesNotMatch(plain.text, /snippets/, 'no snippet unless asked for');
    assert.match(notes(plain), /Set-Cookie from the auth response/);
});

test('custom-headers marks its placeholder and keeps more_set_headers\' every-status behaviour', () => {
    const crd = run(ingress({ 'custom-headers': 'default/h' }));
    assert.match(crd.text, /responseHeaders: +# custom-headers — TODO/);
    assert.equal(kinds(crd, 'VirtualServer')[0].spec.routes[0].action.proxy.responseHeaders.add[0].always, true);
    const ann = run(ingress({ 'custom-headers': 'default/h' }), 'annotation');
    assert.match(ann.text, /nginx\.org\/add-header: "X-Example-Header: value: always" +# custom-headers — TODO/);
});

test('advice that needs NGINX Plus says so', () => {
    /* ExternalName backends and resolver-addresses are Plus-only in v5.6.3
       (controller.go getEndpointsForIngressBackend, configmaps.go). */
    assert.match(notes(run(ingress({ 'auth-url': 'https://auth.example.com/verify' }))), /ExternalName Service in front of auth\.example\.com works only on NGINX Plus/);
    assert.match(notes(run(ingress({ 'mirror-target': 'http://mirror.example.com$request_uri' }))), /add a resolver line .*On NGINX Plus, the resolver-addresses/);
});

test('auth-keepalive says what each target does with the auth connection', () => {
    const ann = { 'auth-url': 'http://auth.default.svc.cluster.local/verify', 'auth-keepalive': '10' };
    assert.match(notes(run(ingress(ann), 'crd')), /new connection to the auth Service for each check/);
    assert.match(notes(run(ingress(ann), 'annotation')), /shares nginx\.org\/keepalive/);
});

test('each card shows the community annotations behind its own resource', () => {
    /* Every card used to repeat the whole Ingress (24 annotations beside a
       three-line mTLS Policy); a card shows what produced the resource beside it. */
    const cardKeys = (r) => r.plan.steps.flatMap((s) => s.blocks.flatMap((b) => b.items || (b.old ? [b] : [])))
        .map((it) => ({ name: it.category || '', keys: (it.old.yaml.match(/nginx\.ingress\.kubernetes\.io\/([a-z0-9-]+)/g) || []).map((x) => x.split('/')[1]) }));
    const cards = cardKeys(run(source.analyzer.samplePresets.advanced));
    const card = (re) => cards.find((c) => re.test(c.name)).keys.sort();
    assert.deepEqual(card(/ingress-mtls$/), ['auth-tls-secret', 'auth-tls-verify-client', 'auth-tls-verify-depth']);
    assert.deepEqual(card(/rate-limit$/), ['limit-connections', 'limit-rps']);
    const vs = card(/secure\.example\.com/);
    assert.ok(vs.includes('proxy-body-size') && vs.includes('affinity') && vs.includes('limit-connections'));
    assert.ok(!vs.includes('cors-allow-origin') && !vs.includes('limit-rps') && !vs.includes('enable-modsecurity'), vs.join(' '));
    // A canary pair: the merged VirtualServer shows both Ingresses' annotations.
    const pair = Y.stringifyAll([ingress({ 'proxy-body-size': '8m' }), Object.assign(ingress({ canary: 'true', 'canary-weight': '20' }), { metadata: { name: 'app-canary', annotations: { 'nginx.ingress.kubernetes.io/canary': 'true', 'nginx.ingress.kubernetes.io/canary-weight': '20' } } })]);
    assert.deepEqual(cardKeys(run(pair)).find((c) => /a\.example\.com/.test(c.name)).keys.sort(), ['canary', 'canary-weight', 'proxy-body-size']);
    // Nothing behind the VirtualServer but the rules: the card shows the spec.
    const bare = run(ingress({ 'enable-modsecurity': 'true' })).plan.steps.find((s) => s.id === 'analyzer-step-3').blocks.find((b) => b.items).items[0];
    assert.match(bare.old.yaml, /spec:\n  tls:/);
    assert.doesNotMatch(bare.old.yaml, /annotations: \{\}/);
});
