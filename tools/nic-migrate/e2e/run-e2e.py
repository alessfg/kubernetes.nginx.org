#!/usr/bin/env python3
"""End-to-end migration test: deploy a real ingress-nginx Ingress, convert it
with nic-migrate, and prove the F5 NGINX Ingress Controller serves it the same.

=============================================================================
The assertion is EQUIVALENCE, not a hardcoded expectation. Each case is sent to
both controllers and the two answers are compared. A test that asserted "NIC
returns /things/42" would encode today's belief about how rewritePath handles a
capture group; a test that asserts "NIC returns whatever ingress-nginx returned"
encodes the thing a migration actually promises. When they differ, the
difference is the finding — that is the pipeline working, not failing.

Both controllers run at once on distinct IngressClasses (nginx, nginx-nic), so
the comparison is simultaneous rather than before-and-after. Requests are made
from a pod inside the cluster straight at each controller's ClusterIP Service,
which avoids hostPort and NodePort collisions between the two entirely.

Written in Python for the same reason .github/scripts/check-all.py is: this is a
long sequence of commands whose individual exit codes all matter, and a shell
pipeline reports the status of the last command in the pipe. See the incident
list in AGENTS.md.

Usage:
    python3 tools/nic-migrate/e2e/run-e2e.py                 # full run, cluster deleted after
    python3 tools/nic-migrate/e2e/run-e2e.py --keep          # leave the cluster up
    python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster  # use the current kube context
    python3 tools/nic-migrate/e2e/run-e2e.py --target ingress

Exit: 0 every case agreed and every absolute expectation held, 1 otherwise,
      2 a prerequisite is missing.
=============================================================================
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
E2E = os.path.dirname(os.path.abspath(__file__))
MANIFESTS = os.path.join(E2E, 'manifests')
NS = 'e2e-shop'
CLUSTER = 'nic-migrate-e2e'

COMMUNITY_NS = 'ingress-nginx'
COMMUNITY_CLASS = 'nginx'
NIC_NS = 'nginx-ingress'
NIC_CLASS = 'nginx-nic'

# Pinned so a run is reproducible. The NIC chart matches what the site
# documents; see .github/scripts/check-versions.py for the three formats.
NIC_CHART = 'oci://ghcr.io/nginx/charts/nginx-ingress'
NIC_CHART_VERSION = '2.6.4'
COMMUNITY_REPO = 'https://kubernetes.github.io/ingress-nginx'


# --------------------------------------------------------------- plumbing

class Fail(Exception):
    pass


# Whether this run created the cluster, and so owns deleting it.
CREATED = {'cluster': False}


def run(argv, *, input_=None, check=True, quiet=False, timeout=600):
    """One command, one exit code, never chained through a pipe."""
    try:
        proc = subprocess.run(argv, input=input_, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        # A missing binary is a Fail like any other, not a traceback. Reaching
        # here past preflight means a tool went away mid-run, or a code path
        # ran a tool preflight does not know about.
        raise Fail('%s is not on PATH' % argv[0])
    except subprocess.TimeoutExpired:
        raise Fail('%s timed out after %ds' % (' '.join(argv[:3]), timeout))
    if check and proc.returncode != 0:
        raise Fail('%s exited %d\n%s%s' % (' '.join(argv[:4]), proc.returncode,
                                           proc.stdout.strip(), proc.stderr.strip()))
    if not quiet and proc.returncode != 0:
        sys.stderr.write(proc.stderr)
    return proc


def kubectl(*args, **kw):
    return run(['kubectl', *args], **kw)


def helm(*args, **kw):
    return run(['helm', *args], **kw)


def say(msg):
    print(msg, flush=True)


def phase(title):
    say('\n\033[1m== %s\033[0m' % title if sys.stdout.isatty() else '\n== %s' % title)


def wait_for(what, fn, timeout=300, interval=3):
    """Poll until fn() is truthy. Reports what it was waiting for on timeout —
    a bare 'timed out' is useless at 3am in CI."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Fail as err:
            last = str(err)
        time.sleep(interval)
    raise Fail('timed out after %ds waiting for %s (last: %s)' % (timeout, what, last))


# ----------------------------------------------------------------- phases

def reachable_context():
    """The current context, if there is one and it answers. Used to point at
    --skip-cluster rather than demanding kind from someone who already has a
    cluster running."""
    try:
        ctx = run(['kubectl', 'config', 'current-context'], check=False, quiet=True, timeout=15)
        if ctx.returncode != 0 or not ctx.stdout.strip():
            return None
        ping = run(['kubectl', 'version', '-o', 'json'], check=False, quiet=True, timeout=20)
        return ctx.stdout.strip() if ping.returncode == 0 else None
    except Fail:
        return None


def preflight(args):
    phase('Preflight')
    needed = ['kubectl', 'helm', 'node', 'openssl']
    if not args.skip_cluster:
        needed += ['kind', 'docker']
    missing = [t for t in needed if shutil.which(t) is None]
    if missing:
        hint = ''
        if 'kind' in missing or 'docker' in missing:
            ctx = reachable_context()
            if ctx:
                hint = ('\n\n  You already have a working cluster: context "%s".\n'
                        '  Re-run against it and skip kind entirely:\n'
                        '      python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster' % ctx)
            else:
                hint = ('\n  kind:   brew install kind   (or: go install sigs.k8s.io/kind@v0.25.0)\n'
                        '  Or start any cluster (minikube start, k3d, Docker Desktop Kubernetes)\n'
                        '  and re-run with --skip-cluster.')
        raise Fail('not on PATH: %s%s' % (', '.join(missing), hint))

    if not args.skip_cluster:
        proc = run(['docker', 'info'], check=False, quiet=True, timeout=60)
        if proc.returncode != 0:
            ctx = reachable_context()
            extra = ('\n  Or use the cluster you already have: --skip-cluster (context "%s")' % ctx) if ctx else ''
            raise Fail('the Docker daemon is not running — start Docker Desktop and retry.' + extra)
    else:
        ctx = reachable_context()
        if not ctx:
            raise Fail('--skip-cluster needs a reachable cluster, and the current kube context '
                       'does not answer. Start one (minikube start / k3d cluster create) or drop '
                       '--skip-cluster to have kind build one.')
    say('  tools present: %s' % ', '.join(needed))


# ------------------------------------------------------------- self-test

def self_test():
    """Exercise the pure logic with no cluster, so the parts a cluster run is
    worst at diagnosing are covered everywhere the runner can be run at all.
    Mirrors where.py --self-test."""
    checks = []

    def check(name, got, want):
        checks.append((name, got == want, got, want))

    r = parse_response('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
                       'Set-Cookie: E2ESESSION=abc; Path=/\r\n\r\n'
                       '{"app":"api","uri":"/things/42"}')
    check('status', r['status'], 200)
    check('app', r['app'], 'api')
    check('uri', r['uri'], '/things/42')
    check('header lowercased', 'set-cookie' in r['headers'], True)

    # A redirect chain must report its final hop, not its first.
    r = parse_response('HTTP/1.1 308 Permanent Redirect\r\nLocation: https://x/\r\n\r\n'
                       'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"app":"web","uri":"/"}')
    check('final hop status', r['status'], 200)
    check('final hop app', r['app'], 'web')

    r = parse_response('HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\n\r\n<html>404</html>')
    check('non-JSON body', (r['status'], r['app']), (404, None))
    check('empty response', parse_response('')['status'], 0)

    # A case with no explicit compare falls back to the strict triple.
    names = [c['name'] for c in CASES]
    check('case names unique', len(set(names)), len(names))
    check('every case has a host', all(c.get('host') for c in CASES), True)
    check('every case has a path', all(c.get('path') for c in CASES), True)

    cmd, scheme = curl_argv(dict(host='h', path='/', scheme='https', headers={'Origin': 'o'}))
    check('https adds -k', '-k' in cmd, True)
    check('host header sent', 'Host: h' in cmd, True)
    check('extra header sent', 'Origin: o' in cmd, True)

    failed = [c for c in checks if not c[1]]
    for name, ok, got, want in checks:
        say('  %s  %s' % ('ok  ' if ok else 'FAIL', name))
        if not ok:
            say('        got %r, want %r' % (got, want))
    say('\n%d of %d self-tests passed.' % (len(checks) - len(failed), len(checks)))
    return 1 if failed else 0


def create_cluster(args):
    if args.skip_cluster:
        ctx = kubectl('config', 'current-context').stdout.strip()
        phase('Cluster (reusing context %s)' % ctx)
        return
    phase('Cluster')
    existing = run(['kind', 'get', 'clusters'], check=False, quiet=True).stdout.split()
    if CLUSTER in existing:
        say('  reusing existing kind cluster %s' % CLUSTER)
    else:
        say('  creating kind cluster %s (this takes a minute)' % CLUSTER)
        run(['kind', 'create', 'cluster', '--name', CLUSTER,
             '--config', os.path.join(MANIFESTS, 'kind-cluster.yaml'), '--wait', '120s'],
            timeout=900)
    CREATED['cluster'] = True
    kubectl('config', 'use-context', 'kind-' + CLUSTER)


def install_controllers(args):
    phase('Controllers')
    say('  installing community ingress-nginx (class %s)' % COMMUNITY_CLASS)
    helm('repo', 'add', 'ingress-nginx', COMMUNITY_REPO, check=False, quiet=True)
    helm('repo', 'update', 'ingress-nginx', quiet=True)
    cmd = ['upgrade', '--install', 'ingress-nginx', 'ingress-nginx/ingress-nginx',
           '-n', COMMUNITY_NS, '--create-namespace', '--wait', '--timeout', '10m',
           '--set', 'controller.service.type=ClusterIP',
           '--set', 'controller.ingressClassResource.name=' + COMMUNITY_CLASS,
           '--set', 'controller.ingressClassResource.controllerValue=k8s.io/ingress-nginx',
           # The admission webhook needs a cert and a reachable endpoint, and
           # adds a failure mode that has nothing to do with what is under test.
           '--set', 'controller.admissionWebhooks.enabled=false']
    if args.community_chart:
        cmd += ['--version', args.community_chart]
    helm(*cmd, timeout=900)

    say('  installing F5 NGINX Ingress Controller (class %s)' % NIC_CLASS)
    helm('upgrade', '--install', 'nic', NIC_CHART, '--version', NIC_CHART_VERSION,
         '-n', NIC_NS, '--create-namespace', '--wait', '--timeout', '10m',
         '--set', 'controller.service.type=ClusterIP',
         '--set', 'controller.enableCustomResources=true',
         '--set', 'controller.ingressClass.name=' + NIC_CLASS,
         '--set', 'controller.ingressClass.create=true',
         timeout=900)

    versions = {}
    for label, ns, selector in (('ingress-nginx', COMMUNITY_NS, 'app.kubernetes.io/name=ingress-nginx'),
                                ('NIC', NIC_NS, 'app.kubernetes.io/instance=nic')):
        out = kubectl('get', 'pods', '-n', ns, '-l', selector,
                      '-o', 'jsonpath={.items[0].spec.containers[0].image}', check=False).stdout.strip()
        versions[label] = out or '(unknown)'
        say('  %-14s %s' % (label, versions[label]))
    return versions


def controller_service(ns, selector):
    """ClusterIP Service DNS name for a controller, discovered rather than
    hardcoded — the name depends on the Helm release name."""
    out = kubectl('get', 'svc', '-n', ns, '-l', selector,
                  '-o', 'jsonpath={.items[*].metadata.name}').stdout.split()
    names = [n for n in out if 'admission' not in n and 'metrics' not in n]
    if not names:
        raise Fail('no Service found in namespace %s for selector %s' % (ns, selector))
    return '%s.%s.svc.cluster.local' % (names[0], ns)


def deploy_workload(args):
    phase('Workload')
    kubectl('apply', '-f', os.path.join(MANIFESTS, 'workload.yaml'))
    make_tls_secret()
    for dep in ('api', 'web', 'web2'):
        kubectl('rollout', 'status', 'deploy/' + dep, '-n', NS, '--timeout=180s')
    kubectl('wait', '--for=condition=Ready', 'pod/probe', '-n', NS, '--timeout=180s')
    say('  three backends and the probe pod are ready')


def make_tls_secret():
    """A self-signed cert so spec.tls has something real to point at. Created
    imperatively because generating an X.509 cert needs a tool, and openssl is
    the one every runner already has."""
    have = kubectl('get', 'secret', 'shop-tls', '-n', NS, check=False, quiet=True).returncode == 0
    if have:
        return
    if shutil.which('openssl') is None:
        raise Fail('openssl is not on PATH and is needed to create the TLS secret')
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        key = os.path.join(tmp, 'tls.key')
        crt = os.path.join(tmp, 'tls.crt')
        run(['openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
             '-keyout', key, '-out', crt, '-days', '2',
             '-subj', '/CN=shop.example.com',
             '-addext', 'subjectAltName=DNS:shop.example.com'])
        kubectl('create', 'secret', 'tls', 'shop-tls', '-n', NS,
                '--cert=' + crt, '--key=' + key)
    say('  created the shop-tls secret')


def apply_source(args):
    phase('Source Ingress (community)')
    kubectl('apply', '-f', os.path.join(MANIFESTS, 'source-ingress.yaml'))
    wait_for('the community controller to program the Ingress',
             lambda: kubectl('get', 'ingress', 'shop', '-n', NS,
                             '-o', 'jsonpath={.status.loadBalancer}', check=False).stdout.strip() not in ('', '{}')
             or True, timeout=30, interval=2)
    # A ClusterIP controller never populates status.loadBalancer, so settle by
    # polling the controller itself in the baseline phase instead.
    say('  applied ingress/shop on class %s' % COMMUNITY_CLASS)


def convert(args):
    phase('Convert')
    cli = os.path.join(ROOT, 'tools', 'nic-migrate', 'nic-migrate.js')
    src = os.path.join(MANIFESTS, 'source-ingress.yaml')
    cmd = ['node', cli, 'convert', '-f', src, '--target', args.target,
           '--class', NIC_CLASS, '--no-color']
    proc = run(cmd, check=False)
    if proc.returncode != 0 and not proc.stdout.strip():
        raise Fail('nic-migrate convert failed:\n' + proc.stderr)
    for line in proc.stderr.strip().splitlines():
        say('  ' + line)
    out_path = os.path.join(args.workdir, 'converted.yaml')
    os.makedirs(args.workdir, exist_ok=True)
    with open(out_path, 'w') as fh:
        fh.write(proc.stdout)
    kinds = [l.split(':', 1)[1].strip() for l in proc.stdout.splitlines() if l.startswith('kind:')]
    say('  wrote %s (%s)' % (os.path.relpath(out_path, ROOT), ', '.join(kinds) or 'nothing'))
    if not kinds:
        raise Fail('convert produced no resources')
    return out_path


def apply_converted(args, path):
    phase('Apply converted manifests')
    with open(path) as fh:
        text = fh.read()
    kubectl('apply', '-f', path)

    if 'kind: VirtualServer' in text:
        def valid():
            out = kubectl('get', 'virtualserver', '-n', NS,
                          '-o', 'jsonpath={range .items[*]}{.metadata.name}={.status.state} ',
                          check=False).stdout.strip()
            states = dict(p.split('=', 1) for p in out.split() if '=' in p)
            if states and all(v == 'Valid' for v in states.values()):
                return out
            return None
        say('  ' + wait_for('every VirtualServer to reach state Valid', valid, timeout=180))
    else:
        say('  applied the converted Ingress on class %s' % NIC_CLASS)
    # Give the controller a moment to reload after the resource is accepted.
    time.sleep(5)


# ------------------------------------------------------------------ probes

CASES = [
    # name, host, path, scheme, extra headers, absolute expectations
    dict(name='root-routes-to-web', host='shop.example.com', path='/',
         expect_status=200, expect_app='web'),
    dict(name='api-path-routes-to-api', host='shop.example.com', path='/api/things/42',
         expect_status=200, expect_app='api'),
    dict(name='api-rewrite-strips-prefix', host='shop.example.com', path='/api/things/42',
         compare=('status', 'uri', 'app')),
    dict(name='api-bare-prefix', host='shop.example.com', path='/api',
         expect_status=200, expect_app='api'),
    dict(name='second-host-routes-to-web2', host='b.example.com', path='/',
         expect_status=200, expect_app='web2'),
    dict(name='unknown-host-is-refused', host='nope.example.com', path='/',
         compare=('status',)),
    dict(name='cors-header-present', host='shop.example.com', path='/',
         headers={'Origin': 'https://shop.example.com'},
         compare=('status',), header_present='access-control-allow-origin'),
    dict(name='affinity-cookie-present', host='shop.example.com', path='/api/x',
         compare=('status',), header_present='set-cookie'),
    dict(name='tls-terminates', host='shop.example.com', path='/', scheme='https',
         expect_status=200, expect_app='web'),
    dict(name='plain-http-not-redirected', host='shop.example.com', path='/',
         compare=('status',), expect_status=200),
]


def curl_argv(case):
    """The curl command for a case. Split out from http() so --self-test can
    check it without a cluster."""
    scheme = case.get('scheme', 'http')
    cmd = ['curl', '-sS', '-i', '--max-time', '10']
    if scheme == 'https':
        cmd += ['-k']
    cmd += ['-H', 'Host: %s' % case['host']]
    for key, value in (case.get('headers') or {}).items():
        cmd += ['-H', '%s: %s' % (key, value)]
    return cmd, scheme


def parse_response(raw):
    """Normalise a raw `curl -i` response. Pure, so --self-test can cover it —
    this is the most bug-prone part of the pipeline and the part a cluster run
    is worst at diagnosing."""
    if not raw or not raw.strip():
        return dict(status=0, headers={}, body='', app=None, uri=None, error='no response')

    # Take the last header block, so a redirect chain reports its final hop.
    blocks = raw.split('\r\n\r\n') if '\r\n\r\n' in raw else raw.split('\n\n')
    head, body = blocks[0], ''
    for i in range(len(blocks) - 1, 0, -1):
        if blocks[i].strip():
            head, body = blocks[i - 1], blocks[i]
            break

    status = 0
    headers = {}
    for line in [l.strip() for l in head.replace('\r', '').split('\n') if l.strip()]:
        if line.upper().startswith('HTTP/'):
            parts = line.split()
            if len(parts) > 1 and parts[1].isdigit():
                status = int(parts[1])
            continue
        if ':' in line:
            key, value = line.split(':', 1)
            # setdefault: keep the FIRST of a repeated header (Set-Cookie), so
            # presence checks are stable.
            headers.setdefault(key.strip().lower(), value.strip())

    parsed = None
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError):
        pass
    if not isinstance(parsed, dict):
        parsed = {}
    return dict(status=status, headers=headers, body=body.strip(),
                app=parsed.get('app'), uri=parsed.get('uri'), error=None)


def http(target, case):
    """One request from inside the cluster."""
    cmd, scheme = curl_argv(case)
    port = 443 if scheme == 'https' else 80
    cmd += ['%s://%s:%d%s' % (scheme, target, port, case['path'])]
    proc = kubectl('exec', '-n', NS, 'probe', '--', *cmd, check=False)
    result = parse_response(proc.stdout)
    if result['status'] == 0 and proc.stderr.strip():
        result['error'] = proc.stderr.strip().splitlines()[-1][:120]
    return result


def compare(args, community_target, nic_target):
    phase('Compare')
    width = max(len(c['name']) for c in CASES)
    failures = []
    rows = []

    for case in CASES:
        before = http(community_target, case)
        after = http(nic_target, case)
        fields = case.get('compare', ('status', 'app', 'uri'))
        diffs = [f for f in fields if before.get(f) != after.get(f)]

        problems = list(diffs)
        if 'expect_status' in case and after['status'] != case['expect_status']:
            problems.append('status!=%d' % case['expect_status'])
        if 'expect_app' in case and after['app'] != case['expect_app']:
            problems.append('app!=%s' % case['expect_app'])
        needed = case.get('header_present')
        if needed:
            if needed not in before['headers']:
                problems.append('ingress-nginx did not send %s' % needed)
            if needed not in after['headers']:
                problems.append('NIC did not send %s' % needed)

        ok = not problems
        rows.append((case['name'], ok, before, after, problems))
        if not ok:
            failures.append(case['name'])

    for name, ok, before, after, problems in rows:
        mark = 'ok  ' if ok else 'FAIL'
        say('  %s  %-*s  ingress-nginx=%s  nic=%s' % (
            mark, width, name, summarise(before), summarise(after)))
        for p in problems:
            say('        %s' % p)
    return failures


def summarise(r):
    if r.get('error'):
        return '<%s>' % r['error'][:40]
    bits = [str(r['status'])]
    if r['app']:
        bits.append(r['app'])
    if r['uri']:
        bits.append(r['uri'])
    return '/'.join(bits)


# -------------------------------------------------------------------- main

def teardown(args):
    """Only ever removes a cluster this run is responsible for. Failing before
    the cluster exists must not try to delete one, and --skip-cluster means the
    cluster belongs to the caller."""
    if args.skip_cluster or not CREATED['cluster']:
        return
    if args.keep:
        say('\ncluster %s left running (--keep). Delete it with:\n  kind delete cluster --name %s'
            % (CLUSTER, CLUSTER))
        return
    phase('Teardown')
    try:
        run(['kind', 'delete', 'cluster', '--name', CLUSTER], check=False, timeout=300)
    except Fail as err:
        say('  could not delete the cluster: %s' % err)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--keep', action='store_true', help='leave the kind cluster running')
    ap.add_argument('--skip-cluster', action='store_true',
                    help='use the current kube context instead of creating a kind cluster')
    ap.add_argument('--target', default='virtualserver', choices=['virtualserver', 'ingress'])
    ap.add_argument('--community-chart', default='', help='pin the ingress-nginx chart version')
    ap.add_argument('--workdir', default=os.path.join(E2E, '.work'))
    ap.add_argument('--self-test', action='store_true',
                    help='check the runner\'s own logic; needs no cluster and no Docker')
    args = ap.parse_args()

    if args.self_test:
        phase('Self-test')
        return self_test()

    started = time.time()
    try:
        preflight(args)
        create_cluster(args)
        deploy_workload(args)
        versions = install_controllers(args)
        apply_source(args)
        converted = convert(args)
        apply_converted(args, converted)

        community_target = controller_service(COMMUNITY_NS, 'app.kubernetes.io/name=ingress-nginx')
        nic_target = controller_service(NIC_NS, 'app.kubernetes.io/instance=nic')

        # Both controllers need to have actually programmed their config.
        wait_for('the community controller to serve the Ingress',
                 lambda: http(community_target, CASES[0])['status'] == 200, timeout=180)
        wait_for('NIC to serve the converted resources',
                 lambda: http(nic_target, CASES[0])['status'] in (200, 301, 308), timeout=180)

        failures = compare(args, community_target, nic_target)
    except Fail as err:
        say('\nFAILED: %s' % err)
        teardown(args)
        return 1
    except KeyboardInterrupt:
        say('\ninterrupted')
        teardown(args)
        return 1

    phase('Result')
    say('  target        %s' % args.target)
    for label, image in versions.items():
        say('  %-13s %s' % (label, image))
    say('  elapsed       %ds' % (time.time() - started))
    if failures:
        say('\n  %d of %d cases did not match: %s' % (len(failures), len(CASES), ', '.join(failures)))
        say('  A mismatch is a real difference between the two controllers — read the rows above.')
        teardown(args)
        return 1
    say('\n  all %d cases behave identically through both controllers.' % len(CASES))
    teardown(args)
    return 0


if __name__ == '__main__':
    sys.exit(main())
