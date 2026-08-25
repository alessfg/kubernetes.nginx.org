# nic-migrate sandbox

A set of Ingress manifests to run `nic-migrate` against, and a throwaway cluster
to apply the results to.

The [end-to-end test](../README.md#end-to-end-test) proves the conversion and
then deletes its cluster. This sandbox does the opposite. It gives you input
worth looking at, brings the same cluster up, and leaves it running.

Use it to answer two different questions:

- What does the tool do with an Ingress like mine? Node 18 or newer, nothing else.
- Does the converted output actually work? This half needs a cluster.

Docker is only needed for the second half, and only when `kind` builds the
cluster for you. If you already have a cluster, point the sandbox at it with
`--skip-cluster` and you don't need Docker or `kind`.

## What's here

```text
manifests/   seven ingress-nginx Ingresses, each isolating one behavior
sandbox.py   brings the cluster up, compares controllers, tears it down
```

Each fixture is deliberately narrow. When a report surprises you, the fixture
that produced it points at one cause instead of six.

| Fixture | What it shows | Report result |
|---|---|---|
| `01-plain-swaps.yaml` | Annotations that become `nginx.org/*` keys and nothing more | 0 blocking, 0 review |
| `02-policies.yaml` | Four Policy custom resources, and the reference the analyzer never writes | 1 blocking, 2 review |
| `03-host-conflict.yaml` | Three generators, three VirtualServers, one host | 1 blocking, 2 review |
| `04-multi-host.yaml` | The production shape: two hosts, three paths, three backends, TLS | 4 blocking, 3 review |
| `05-unsupported.yaml` | Annotations with no equivalent, and annotations the database doesn't know | 5 review, 1 note |
| `06-snippets.yaml` | Output that F5 NGINX Ingress Controller rejects on apply | 1 blocking |
| `07-mixed-documents.yaml` | A realistic file: 3 Ingresses among other resources | 1 blocking, 2 review |

Every fixture carries a comment block explaining why it exists and what to look
for. Read the file before you read its report.

## Run it without a cluster

Run all of these from the repository root. You need Node 18 or newer, and
nothing else.

```shell
# Start here. One Ingress, nine annotations, no gaps at all.
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests/01-plain-swaps.yaml

# Then the opposite extreme.
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml

# All seven at once: 9 Ingresses, 8 blocking gaps, 2 documents skipped.
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests
```

Now compare `report` against `convert` on the same fixture. This is the most
useful thing in the sandbox.

```shell
# Advisory: two VirtualServers fighting over one host, three backends dropped.
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml

# Applyable: one VirtualServer per host, every backend an upstream.
node tools/nic-migrate/nic-migrate.js convert -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml
```

The second command recovers what the first says it lost. It keeps both hosts,
all three services, the namespace, the class, and the TLS secret.

### Compare the two targets

`--target virtualserver` is the default. `--target ingress` keeps the Ingress
and rewrites its annotations. Fixture 03 shows where they diverge.

```shell
node tools/nic-migrate/nic-migrate.js convert -f tools/nic-migrate/sandbox/manifests/03-host-conflict.yaml --target virtualserver
node tools/nic-migrate/nic-migrate.js convert -f tools/nic-migrate/sandbox/manifests/03-host-conflict.yaml --target ingress
```

The Ingress target can't represent session affinity, so it reports a note and
tells you which target can. It also adds `nginx.org/path-regex`, because
NGINX Ingress Controller matches Ingress paths literally.

### Use it as a gate

`--strict` exits non-zero when it finds a blocking gap. Fixture 01 passes and
fixture 04 fails.

```shell
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests/01-plain-swaps.yaml --strict; echo "exit $?"
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml --strict; echo "exit $?"
```

Add `--json` to any report for machine-readable output.

## Run it against a live cluster

`sandbox.py up` builds a kind cluster, installs both controllers, and stops.
It leaves the cluster running so you can drive the rest yourself.

You need `kubectl`, `helm`, `node`, and `openssl`. To have `kind` build the
cluster, start Docker first and add `kind`.

```shell
# kind builds a throwaway cluster. Needs Docker.
python3 tools/nic-migrate/sandbox/sandbox.py up

# Or use a cluster you already have. Needs neither Docker nor kind.
python3 tools/nic-migrate/sandbox/sandbox.py up --skip-cluster
```

`--skip-cluster` uses your current kubectl context and installs both
controllers into it. It reports the context by name if it can't reach one.

The bring-up takes several minutes. It prints the class names and the next
commands when it finishes.

> **Important:** The fixtures use the `e2e-shop` namespace and the three echo
> backends the end-to-end test already creates. That reuse is why `up` needs no
> workload of its own, and it's why the fixtures name `api-svc`, `web-svc`, and
> `web2-svc`.

`up` applies the end-to-end test's own Ingress, not these fixtures. Apply the
fixture you want to work on first. Without it, ingress-nginx has no route for
that host and there's nothing to compare a conversion against.

```shell
kubectl apply -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml
```

With the cluster up, `--validate` becomes useful. It runs
`kubectl apply --dry-run=server`, which is the check that catches a missing
custom resource definition.

```shell
node tools/nic-migrate/nic-migrate.js convert \
  -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml --validate
```

Then apply a conversion on the NGINX Ingress Controller class and look at it.
The suffix keeps it separate from the community Ingress, so both controllers
serve at once.

```shell
node tools/nic-migrate/nic-migrate.js convert \
  -f tools/nic-migrate/sandbox/manifests/04-multi-host.yaml \
  --class nginx-nic --name-suffix -nic | kubectl apply -f -

kubectl get virtualserver -n e2e-shop
python3 tools/nic-migrate/sandbox/sandbox.py status
```

### Compare the two controllers

A migration promises that the new controller answers like the old one. `probe`
sends one request to both and compares the answers. Both sides must be applied
first, or you get 404 from each and the comparison means nothing.

```shell
python3 tools/nic-migrate/sandbox/sandbox.py probe sandbox-shop.example.com /api/things/42
```

The backends echo the URI they received, so a rewrite is visible from the
response. That matters, because a rewrite is only observable from the backend
side.

```text
GET http://sandbox-shop.example.com/api/things/42

  ingress-nginx  200  app=api   uri=/things/42
  NIC            200  app=api   uri=/things/42

  => the two agree
```

A difference in status, backend, or received URI is the finding. Report it
against the mapping rather than fixing the manifest by hand.

### Clean up

```shell
python3 tools/nic-migrate/sandbox/sandbox.py down
```

## Two things the sandbox can't tell you

`--validate` checks structure and admission. It can't check routing. Fixture 04
carries the `/api(/|$)(.*)` path for exactly this reason: without
`nginx.org/path-regex`, that path matches nothing, and every `/api/` request
quietly answers from the wrong backend. A dry run passes. Only `probe` catches
it.

Snippets are never parsed. Fixture 06 converts cleanly and then fails on apply,
because snippet support is off by default. Install with
`--set controller.enableSnippets=true` to get past it, and read the contents
yourself. The tool copies them across without checking them.
