'use strict';
/* The Traefik analyzer held to what haproxy-analyzer.test.js holds HAProxy to:
   every value of every option migrates to something NGINX Ingress Controller
   admits, or to a note, and each behaviour is read from Traefik's source
   (v3.7.17) and, where the source left it open, settled on nginx 1.31.7. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAnalyzer, analyze } = require('./lib/load.js');
const { refused } = require('./lib/nic-admission.js');

const { source, tool, warnings } = loadAnalyzer('assets/js/migration-traefik.js');
const Y = tool.yaml;

const run = (yaml, strategy) => {
    const before = warnings.length;
    const r = analyze(source, yaml, strategy || 'crd');
    assert.deepEqual(warnings.slice(before), [], 'a translator failed');
    return Object.assign(r, { docs: JSON.parse(JSON.stringify(Y.parseAll(r.text))).filter(Boolean) });
};
const kinds = (r, k) => r.docs.filter((d) => d.kind === k);
const said = (r, re) => r.plan.infoNotes.some((n) => re.test(n.message));
const doc = (o) => Y.stringify(o);
// One IngressRoute on a.example.com, /api through the named middlewares, / plain.
const route = (mws, extra) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name: 'app' }, spec: Object.assign({ routes: [
    { match: 'Host(`a.example.com`) && PathPrefix(`/api`)', kind: 'Rule', middlewares: mws.map((name) => ({ name })), services: [{ name: 'web', port: 80 }] },
    { match: 'Host(`a.example.com`) && PathPrefix(`/`)', kind: 'Rule', services: [{ name: 'web', port: 80 }] }], tls: { secretName: 'a-tls' } }, extra || {}) });
const mw = (name, type, options) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name }, spec: { [type]: options } });
const paste = (...docs) => docs.join('---\n');
const apiRoute = (r) => (kinds(r, 'VirtualServer')[0] || { spec: { routes: [] } }).spec.routes.find((x) => /\/api/.test(x.path));

// Options of each middleware type, and values that tell Traefik's readers apart.
const OPTIONS = {
    addPrefix: { prefix: ['/v1', ''] },
    basicAuth: { secret: ['users', ''], realm: ['Members', ''] },
    buffering: { maxRequestBodyBytes: [1048576, 0, -1, 'x'], memRequestBodyBytes: [4096] },
    circuitBreaker: { expression: ['NetworkErrorRatio() > 0.5'], fallbackDuration: ['10s', '1m30s', 'x'] },
    compress: { minResponseBodyBytes: [1024, 'x'], encodings: [['gzip'], ['br', 'zstd'], ['lzw'], []] },
    errors: { status: [['500-504'], ['404', '5xx'], ['nope']], service: [{ name: 'errsvc', port: 80 }], query: ['/{status}.html'] },
    forwardAuth: { address: ['http://auth.auth.svc.cluster.local:4180/check', 'https://auth.example.com/verify', 'not a url'], authResponseHeaders: [['X-User']] },
    headers: { customRequestHeaders: [{ 'X-A': 'a, b' }, { 'X-B': '' }], customResponseHeaders: [{ 'X-C': 'x: y' }, { 'X-D': '' }], frameDeny: [true], stsSeconds: [31536000, 0, 'x'],
        accessControlAllowOriginList: [['https://a.example.com'], ['*'], ['not-an-origin']], accessControlAllowMethods: [['GET', 'FOO']], accessControlAllowHeaders: [['X-Custom', 'Cookie']], accessControlMaxAge: [100, -1] },
    inFlightReq: { amount: [10, 0, 'x'] },
    ipAllowList: { sourceRange: [['10.0.0.0/8'], ['10.0.0.0/8', 'nope'], []], rejectStatusCode: [404, 999] },
    passTLSClientCert: { pem: [true], info: [{ subject: { commonName: true } }] },
    rateLimit: { average: [10, 0, -1, 'x'], burst: [0, 1, 5, 'x'], period: ['1s', '1m', '1m30s', '-1s', 'x'] },
    redirectRegex: { regex: ['^https?://a.example.com/(.*)', '(?=x)'], replacement: ['https://b.example.com/${1}', 'https://b.example.com/'], permanent: [true, false] },
    redirectScheme: { scheme: ['https', 'http', ''], permanent: [true, false], port: ['8443'] },
    replacePath: { path: ['/new', ''] },
    replacePathRegex: { regex: ['^/old/(.*)', '[', '(?<=x)y'], replacement: ['/new/$1'] },
    retry: { attempts: [3, 1, 0, -1, 'x'], status: [['500-503'], ['418']], timeout: ['5s', 'x'], disableRetryOnNetworkError: [true] },
    stripPrefix: { prefixes: [['/api'], []] },
    stripPrefixRegex: { regex: [['/[a-z]+'], ['[']] }
};

test('every value of every middleware option migrates to something NGINX Ingress Controller admits, or to a note', () => {
    const broken = [];
    let runs = 0;
    for (const [type, opts] of Object.entries(OPTIONS)) {
        for (const [opt, values] of Object.entries(opts)) {
            for (const v of values) {
                const yaml = paste(route(['m']), mw('m', type, { [opt]: v }));
                for (const strategy of ['crd', 'annotation']) {
                    runs++;
                    let r;
                    try { r = run(yaml, strategy); } catch (e) { broken.push(type + '.' + opt + '=' + JSON.stringify(v) + ' / ' + strategy + ': ' + e.message); continue; }
                    for (const d of r.docs) for (const e of refused(d)) broken.push(type + '.' + opt + '=' + JSON.stringify(v) + ' / ' + strategy + ': ' + e);
                    // The middleware either shaped the /api route or is explained.
                    const api = apiRoute(r);
                    // A middleware can also write the /api route's upstream fields.
                    const vs = kinds(r, 'VirtualServer')[0];
                    const ups = vs ? (vs.spec.upstreams || []).filter((u) => Object.keys(u).some((k) => !['name', 'service', 'port'].includes(k))) : [];
                    const plain = api && api.action && api.action.pass && !api.policies && !api['location-snippets'] && !ups.length;
                    const noted = r.plan.infoNotes.some((n) => /Middleware m\b/.test(n.code + ' ' + n.message));
                    const global = r.plan.configMap || kinds(r, 'Policy').length;
                    if (plain && !noted && !global) broken.push(type + '.' + opt + '=' + JSON.stringify(v) + ' / ' + strategy + ': did not say why');
                }
            }
        }
    }
    assert.ok(runs >= 200, runs + ' runs');
    assert.deepEqual(broken, []);
});

test('a middleware Traefik refuses to build fails its route, which migrates as nothing', () => {
    /* pkg/server/router/router.go: a buildRouterHandler error skips the router,
       so its traffic got 404. Each refusal is the middleware's own New(). */
    const REFUSED = [
        ['ipAllowList', { sourceRange: ['10.0.0.0/8', 'nope'] }],
        ['ipAllowList', { sourceRange: [] }],
        ['ipAllowList', { sourceRange: ['10.0.0.0/8'], rejectStatusCode: 999 }],
        ['addPrefix', { prefix: '' }],
        ['redirectScheme', { scheme: '' }],
        ['retry', { attempts: 0 }],
        ['retry', { attempts: 2, disableRetryOnNetworkError: true }],
        ['rateLimit', { average: 10, period: '-1s' }],
        ['replacePathRegex', { regex: '[', replacement: '/' }],
        ['replacePathRegex', { regex: '(?<=x)y', replacement: '/' }],
        ['compress', { includedContentTypes: ['text/html'], excludedContentTypes: ['text/css'] }],
        ['headers', {}],
        ['errors', { status: ['500'] }]
    ];
    const kept = [];
    for (const [type, o] of REFUSED) {
        const r = run(paste(route(['m']), mw('m', type, o)));
        if (apiRoute(r)) kept.push(type + ' ' + JSON.stringify(o));
        if (!said(r, /refused to build the router/)) kept.push(type + ' ' + JSON.stringify(o) + ': not explained');
        if (!kinds(r, 'VirtualServer').length) kept.push(type + ': the healthy / route was lost too');
    }
    assert.deepEqual(kept, []);
    // An empty forwardAuth address builds (NewForward does not check it).
    assert.ok(apiRoute(run(paste(route(['m']), mw('m', 'forwardAuth', { address: '' })))), 'forwardAuth without an address is not a build error');
});

test('a middleware the paste does not hold fails its route, as Traefik refuses it', () => {
    // server/middleware/middlewares.go: "middleware %q does not exist".
    const r = run(route(['ghost']));
    assert.equal(apiRoute(r), undefined);
    assert.ok(said(r, /ghost is not in the paste/));
});

test('rate-limit burst is Traefik\'s less one, with noDelay, and absent at 0', () => {
    /* Traefik's bucket holds max(burst, 1) tokens and admits that many at once
       (ratelimiter/rate_limiter.go). NGINX limit_req admits burst + 1 and
       refuses burst=0 (nginx 1.31.7: burst=1 admitted 2, burst=2 admitted 3,
       burst=0 "invalid burst value"). */
    const rl = (o) => kinds(run(paste(route(['m']), mw('m', 'rateLimit', o))), 'Policy').map((p) => p.spec.rateLimit).find(Boolean);
    assert.deepEqual([rl({ average: 10, burst: 5 }).burst, rl({ average: 10, burst: 5 }).noDelay], [4, true]);
    assert.equal(rl({ average: 10, burst: 1 }).burst, undefined, 'burst 1 admits one: no NGINX burst');
    assert.equal(rl({ average: 10, burst: 0 }).burst, undefined, 'Traefik reads burst 0 as 1');
    assert.equal(rl({ average: 10 }).burst, undefined);
    assert.equal(rl({ average: 0 }), undefined, 'average 0 is no limit (rate.Inf)');
    assert.equal(rl({ average: 100, period: '1m' }).rate, '100r/m');
    assert.equal(rl({ average: 10, period: '1m30s' }).rate !== undefined, true, 'a compound duration is a period');
});

test('retry attempts count the first try, as next-upstream-tries does', () => {
    // retry.go: attempts == 1 is a single call.
    const up = kinds(run(paste(route(['m']), mw('m', 'retry', { attempts: 3 }))), 'VirtualServer')[0].spec.upstreams.find((u) => u['next-upstream-tries']);
    assert.equal(up['next-upstream-tries'], 3);
});

test('service.* annotations are read from the Service, not the Ingress', () => {
    /* provider/kubernetes/ingress/kubernetes.go: parseServiceConfig(service.Annotations). */
    const ing = (ann) => doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: ann }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const svc = (ann) => doc({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', annotations: ann }, spec: { ports: [{ port: 80 }] } });
    const sticky = { 'traefik.ingress.kubernetes.io/service.sticky.cookie': 'true', 'traefik.ingress.kubernetes.io/service.sticky.cookie.name': 'srv' };
    const onService = kinds(run(paste(ing({}), svc(sticky))), 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(onService.sessionCookie.name, 'srv');
    const onIngress = kinds(run(paste(ing(sticky), svc({}))), 'VirtualServer')[0].spec.upstreams[0];
    assert.equal(onIngress.sessionCookie, undefined, 'on the Ingress, Traefik never read it');
    // A value paerser cannot decode drops the Service's paths.
    const bad = run(paste(ing({}), svc({ 'traefik.ingress.kubernetes.io/service.sticky.cookie': 'yes' })));
    assert.equal(kinds(bad, 'VirtualServer').length, 0);
    assert.ok(said(bad, /could not decode service\.sticky\.cookie="yes"/));
});

test('several IngressRoutes on one host are one VirtualServer', () => {
    // NGINX Ingress Controller gives a host to one resource (pinned convention).
    const ir = (name, path, svc) => doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', metadata: { name }, spec: { routes: [{ match: 'Host(`a.example.com`) && PathPrefix(`' + path + '`)', kind: 'Rule', services: [{ name: svc, port: 80 }] }] } });
    const r = run(paste(ir('api', '/api', 'api'), ir('web', '/', 'web')));
    const vs = kinds(r, 'VirtualServer');
    assert.equal(vs.length, 1);
    assert.deepEqual(vs[0].spec.routes.map((x) => x.path).sort(), ['/', '/api']);
});

test('an annotated Ingress is a VirtualServer under CRD-first, and an Ingress where a setting needs one', () => {
    const ing = (ann) => doc({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'app', annotations: ann }, spec: { rules: [{ host: 'a.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } });
    const plain = run(paste(ing({ 'traefik.ingress.kubernetes.io/router.middlewares': 'default-rl@kubernetescrd' }), doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', metadata: { name: 'rl', namespace: 'default' }, spec: { rateLimit: { average: 10 } } })));
    assert.equal(kinds(plain, 'Ingress').length, 0);
    assert.equal(kinds(plain, 'VirtualServer').length, 1);
    // errors proxies the page (custom-http-errors); a VirtualServer only redirects.
    const errs = run(paste(ing({ 'traefik.ingress.kubernetes.io/router.middlewares': 'errs@kubernetescrd' }), mw('errs', 'errors', { status: ['500-502'], service: { name: 'errsvc', port: 8080 } })));
    const kept = kinds(errs, 'Ingress');
    assert.equal(kept.length, 1, 'kept an Ingress under CRD-first');
    assert.equal(kept[0].metadata.annotations['nginx.org/custom-http-errors'], '500,501,502');
    assert.equal(kept[0].spec.defaultBackend.service.name, 'errsvc');
    // Annotation-first: always the Ingress.
    assert.equal(kinds(run(ing({}), 'annotation'), 'Ingress').length, 1);
});

test('passthrough with several SNIs is a TransportServer each', () => {
    const r = run(doc({ apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRouteTCP', metadata: { name: 'pt' }, spec: { routes: [{ match: 'HostSNI(`a.example.com`) || HostSNI(`b.example.com`)', services: [{ name: 'tls', port: 443 }] }], tls: { passthrough: true } } }));
    assert.deepEqual(kinds(r, 'TransportServer').map((t) => t.spec.host).sort(), ['a.example.com', 'b.example.com']);
});
