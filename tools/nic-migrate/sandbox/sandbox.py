#!/usr/bin/env python3
"""sandbox.py — a cluster to try nic-migrate against by hand.

The e2e runner proves the conversion and tears the cluster down. This does the
opposite: it brings the same cluster up, leaves it running, and gets out of the
way so you can run the CLI yourself and look at what happens.

    python3 tools/nic-migrate/sandbox/sandbox.py up
    python3 tools/nic-migrate/sandbox/sandbox.py status
    python3 tools/nic-migrate/sandbox/sandbox.py probe sandbox-shop.example.com /api/things/42
    python3 tools/nic-migrate/sandbox/sandbox.py down

Nothing here reimplements the cluster. `up` shells out to e2e/run-e2e.py, and
everything else imports that script's helpers, for the same reason lib/engine.js
reads the site's analyzer through .github/test/lib/load.js: one definition of how
the cluster is built, so a change to it cannot leave this command quietly
describing a cluster that no longer exists.
"""

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NIC_MIGRATE = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(NIC_MIGRATE))
E2E_SCRIPT = os.path.join(NIC_MIGRATE, 'e2e', 'run-e2e.py')
MANIFESTS = os.path.join(HERE, 'manifests')
CLI = os.path.join(NIC_MIGRATE, 'nic-migrate.js')

# `up` stops here rather than at the last stage. This is the one checkpoint
# where both controllers are running and no converted resource exists yet, which
# is exactly the state you want to start experimenting from: the community
# Ingress is live and serving, NIC is installed with its CRDs registered, and
# every decision after that point is yours.
STAGE = 'nic-installed'


def die(msg):
    sys.stderr.write('sandbox: %s\n' % msg)
    raise SystemExit(1)


def cluster_exists(e2e):
    if shutil.which('kind') is None:
        return False
    out = subprocess.run(['kind', 'get', 'clusters'], capture_output=True,
                         text=True).stdout.split()
    return e2e.CLUSTER in out


def require_cluster(e2e):
    """Check for the cluster before touching kubectl. Without this, every
    command run against an empty kubeconfig answers with a screenful of
    kubectl's own discovery errors, which reads like a broken tool rather than
    a cluster that was never started."""
    if not cluster_exists(e2e):
        die('kind cluster %s does not exist. Run `up` first.' % e2e.CLUSTER)


def load_e2e():
    """Import run-e2e.py as a module. Its filename is not a valid identifier,
    hence the explicit loader rather than a plain import."""
    if not os.path.exists(E2E_SCRIPT):
        die('cannot find %s — run this from a checkout of the repository' % E2E_SCRIPT)
    spec = importlib.util.spec_from_file_location('run_e2e', E2E_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:                                  # noqa: BLE001
        die('could not load the e2e helpers from run-e2e.py: %s' % exc)
    return module


# ------------------------------------------------------------------ up / down

def cmd_up(args):
    """Delegate the whole bring-up. --until implies --keep, so the cluster
    survives the call.

    No preflight of its own on purpose. run-e2e.py already checks for the tools
    it needs, and it only needs kind and Docker when it is the thing building
    the cluster: with --skip-cluster it wants a reachable context instead. A
    Docker check here duplicated that and got it wrong, failing --skip-cluster
    runs that needed no Docker at all. Its message is also better than one this
    script could give, because it detects a usable context and names it.
    """
    argv = [sys.executable, E2E_SCRIPT, '--until', STAGE]
    if args.skip_cluster:
        argv.append('--skip-cluster')
    # flush before handing over: the child inherits this stdout, and without it
    # Python's buffer lands after the child's output, so the line meant to
    # explain what is about to run appears after it already has.
    print('sandbox: handing over to run-e2e.py --until %s\n' % STAGE, flush=True)
    result = subprocess.run(argv, cwd=ROOT)
    if result.returncode != 0:
        die('the e2e bring-up failed with exit code %d (its output is above)'
            % result.returncode)
    print()
    next_steps()


def next_steps():
    e2e = load_e2e()
    print('The cluster is up and both controllers are running.\n')
    print('  namespace        %s   (three echo backends: api-svc, web-svc, web2-svc)' % e2e.NS)
    print('  community class  %s' % e2e.COMMUNITY_CLASS)
    print('  NIC class        %s' % e2e.NIC_CLASS)
    print('  TLS secret       shop-tls  (self-signed, CN=shop.example.com)\n')
    print('Validate a fixture against the real CRDs:')
    print('  node %s convert \\\n    -f %s --validate'
          % (rel(CLI), rel(os.path.join(MANIFESTS, '04-multi-host.yaml'))))
    print('\nApply one on the NIC class and look at it:')
    print('  node %s convert \\\n    -f %s --class %s --name-suffix -nic | kubectl apply -f -'
          % (rel(CLI), rel(os.path.join(MANIFESTS, '04-multi-host.yaml')), e2e.NIC_CLASS))
    print('  kubectl get virtualserver -n %s' % e2e.NS)
    print('\nCompare the two controllers on the same request:')
    print('  python3 %s probe sandbox-shop.example.com /api/things/42' % rel(__file__))
    print('\nWhen you are finished:')
    print('  python3 %s down' % rel(__file__))


def rel(path):
    """Paths relative to the repository root, because that is where the README
    tells you to run these commands from."""
    try:
        return os.path.relpath(path, ROOT)
    except ValueError:
        return path


def cmd_down(args):
    e2e = load_e2e()
    if shutil.which('kind') is None:
        die('kind is not on PATH, so this script cannot delete the cluster.')
    if not cluster_exists(e2e):
        print('cluster %s is already gone; nothing to delete.' % e2e.CLUSTER)
        return
    print('sandbox: deleting kind cluster %s' % e2e.CLUSTER)
    subprocess.run(['kind', 'delete', 'cluster', '--name', e2e.CLUSTER])


# -------------------------------------------------------------------- status

def cmd_status(args):
    e2e = load_e2e()
    require_cluster(e2e)
    print('cluster        %s' % e2e.CLUSTER)
    for label, ns, selector in (('ingress-nginx', e2e.COMMUNITY_NS, e2e.COMMUNITY_SELECTOR),
                                ('NIC', e2e.NIC_NS, e2e.NIC_SELECTOR)):
        pods = e2e.kubectl('get', 'pods', '-n', ns, '-l', selector,
                           '-o', 'jsonpath={range .items[*]}{.metadata.name}={.status.phase} {end}',
                           check=False, quiet=True).stdout.strip()
        print('%-14s %s' % (label, pods or '(not installed)'))
    print()
    for kind in ('ingress', 'virtualserver', 'policy'):
        out = e2e.kubectl('get', kind, '-n', e2e.NS, '--no-headers',
                          check=False, quiet=True).stdout.strip()
        print('%s in %s:' % (kind, e2e.NS))
        print('\n'.join('  ' + line for line in out.splitlines()) if out else '  (none)')


# --------------------------------------------------------------------- probe

def cmd_probe(args):
    """The same request through both controllers, side by side.

    This is the question a migration actually asks. An absolute assertion is a
    claim about today's belief; "both controllers answer the same" is the thing
    being promised, so the comparison is the output rather than a footnote to it.
    """
    e2e = load_e2e()
    require_cluster(e2e)
    case = dict(host=args.host, path=args.path, scheme=args.scheme)
    if args.header:
        case['headers'] = dict(h.split(':', 1) for h in args.header)

    rows = []
    for label, ns, selector in (('ingress-nginx', e2e.COMMUNITY_NS, e2e.COMMUNITY_SELECTOR),
                                ('NIC', e2e.NIC_NS, e2e.NIC_SELECTOR)):
        try:
            target = e2e.controller_service(ns, selector)
        except Exception as exc:                              # noqa: BLE001
            rows.append((label, None, str(exc)))
            continue
        rows.append((label, e2e.http(target, case), None))

    print('%s %s://%s%s\n' % ('GET', args.scheme, args.host, args.path))
    for label, result, err in rows:
        if err or result is None:
            print('  %-14s -- %s' % (label, err))
            continue
        print('  %-14s %3d  app=%-5s uri=%-24s %s'
              % (label, result['status'], result['app'] or '-',
                 result['uri'] or '-', result['error'] or ''))

    answers = [r for _, r, e in rows if r and not e]
    if len(answers) == 2:
        same = (answers[0]['status'] == answers[1]['status']
                and answers[0]['app'] == answers[1]['app']
                and answers[0]['uri'] == answers[1]['uri'])
        print('\n  => %s' % ('the two agree' if same else
                             'THEY DIFFER — status, backend or received URI is not the same'))


# ---------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        prog='sandbox.py',
        description='A live cluster for trying nic-migrate by hand.')
    sub = ap.add_subparsers(dest='command', required=True)

    up = sub.add_parser('up', help='bring the cluster up and leave it running')
    up.add_argument('--skip-cluster', action='store_true',
                    help='use the cluster in the current kubectl context')
    up.set_defaults(fn=cmd_up)

    st = sub.add_parser('status', help='what is running, and what is applied')
    st.set_defaults(fn=cmd_status)

    pr = sub.add_parser('probe', help='one request through both controllers')
    pr.add_argument('host')
    pr.add_argument('path', nargs='?', default='/')
    pr.add_argument('--scheme', default='http', choices=['http', 'https'])
    pr.add_argument('--header', action='append', metavar='K:V',
                    help='extra request header. Repeatable.')
    pr.set_defaults(fn=cmd_probe)

    dn = sub.add_parser('down', help='delete the cluster')
    dn.set_defaults(fn=cmd_down)

    args = ap.parse_args()
    try:
        args.fn(args)
    except KeyboardInterrupt:
        die('interrupted. The cluster is still up — run `down` to remove it.')


if __name__ == '__main__':
    main()
