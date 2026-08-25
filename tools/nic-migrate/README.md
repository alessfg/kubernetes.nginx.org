# nic-migrate

Run the migration tool's analyzer over real Ingress manifests, from a terminal.

> **Important:** `nic-migrate` is beta. Review the output before you apply
> anything to a cluster. Command names, flags, and the manifests it generates
> can still change.

The [NGINX Ingress Migration Tool](https://kubernetes.nginx.org/ingress-nginx-migration.html)
on the web analyzes one paste at a time. `nic-migrate` runs the same engine over
a directory of manifests or a live cluster. You get the same 57 mapping entries,
the same 130 annotations, and the same value transforms and generators for
custom resource definitions (CRDs).

`nic-migrate` reads the mapping database from `assets/js/`. It doesn't vendor a
copy, so it can't drift from the published page. Run it from a checkout of this
repository.

No dependencies. Node 18 or newer. You need `kubectl` only for `--kubectl` and
`--validate`.

## Get started

```shell
# What would change, and what the analyzer cannot work out on its own
node tools/nic-migrate/nic-migrate.js report -f ./manifests
node tools/nic-migrate/nic-migrate.js report --kubectl -n prod

# Manifests you can apply
node tools/nic-migrate/nic-migrate.js convert -f ./manifests --validate
node tools/nic-migrate/nic-migrate.js convert -f ./in --target ingress -o ./out

# The 22-item checklist, read live from the published page
node tools/nic-migrate/nic-migrate.js checklist
```

Use `report` to understand a workload. It shows the raw analyzer output, one
single-feature illustration per annotation, and what those illustrations leave
out.

Use `convert` to migrate a workload. It merges those illustrations into
manifests you can apply.

## Read a report

A report looks like this.

```text
nic-migrate — advisory report · strategy: crd

e2e-shop/shop  (shop.example.com, b.example.com)
  7 annotations found · 5 migration paths · 3 require CRDs · complexity advanced

  Annotation swaps
    annotations:
      # Buffering
      nginx.org/client-max-body-size: "10m"  # proxy-body-size
      # SSL/TLS
      nginx.org/ssl-redirect: "false"  # ssl-redirect

  CRD resources  (illustrative — see gaps)
    Policy/cors-policy
    VirtualServer/rewrite-app  host shop.example.com
    VirtualServer/sticky-app  host shop.example.com

  Gaps  (8)
    [blocking] backends-dropped
      Ingress routes to 3 services (api-svc, web-svc, web2-svc) but the generated
      upstreams reference only api-svc.
    [blocking] host-conflict
      2 resources claim host shop.example.com (VirtualServer/rewrite-app,
      VirtualServer/sticky-app). They are separate illustrations of single
      features — merge them into one resource before applying.
    [review  ] tls-dropped
      Source Ingress terminates TLS (secret: shop-tls) but no generated
      VirtualServer has a tls block.
    ... 5 more
```

Always review a report before you apply anything. The engine illustrates one
annotation at a time, and its output follows from that design:

- `parseInput` keeps one host, service, path, and TLS secret. A two-path Ingress
  produces output that covers the first path only.
- Each CRD generator emits a self-contained illustration. `rewrite-target` plus
  `affinity` gives you two VirtualServers claiming the same host. Apply both,
  and F5 NGINX Ingress Controller accepts one and rejects the other.
- The analyzer generates Policies, but it only ever references them in a
  comment.
- The analyzer reads `namespace`, `ingressClassName`, and `spec.tls`, but
  doesn't carry them into any generated resource.

A reference page needs one feature at a time. A file you apply with `kubectl`
needs all of them at once. `nic-migrate` reports each mismatch as a named gap
with one of three severities.

| Severity | Meaning |
|---|---|
| `blocking` | Fails on apply, or loses traffic |
| `review` | Needs a decision from you |
| `note` | Carries information only |

When `--strict` finds any `blocking` gap, it exits non-zero. Use `--strict` as a
continuous integration (CI) gate on a migration branch.

It detects these gaps: `generator-warning`, `hosts-dropped`, `paths-dropped`,
`backends-dropped`, `host-conflict`, `policy-unwired`, `namespace-dropped`,
`tls-dropped`, `class-dropped`, `todo-placeholders`, `unsupported`,
`unrecognized`, `snippet-passthrough`.

Watch `generator-warning` closely. `buildPlan` runs each generator in a
`try`/`catch` that only calls `console.warn`. A broken generator drops its
resource, and the analysis still looks successful. The failure signal is a
captured warning, not a thrown exception.

## Convert manifests

`--target virtualserver` is the default. It emits one merged VirtualServer per
host. Every path becomes a route, and every distinct backend becomes an
upstream. `spec.policies` references the Policies, and TLS, namespace, and
`ingressClassName` all carry over.

`--target ingress` keeps the Ingress resource. It rewrites the annotations to
`nginx.org/*` and adds `nginx.org/policies` for anything that needs a Policy.
This target carries less risk, and it's enough for many real workloads, because
NGINX Ingress Controller reads a standard `networking.k8s.io/v1` Ingress. It
defaults to `--strategy annotation`, because the CRD-first strategy
produces fragments an Ingress can't carry.

### Differences that break a conversion

Three NGINX Ingress Controller behaviors break a conversion that otherwise looks
correct. `convert` handles the first two for you. Know all three before you read
its output or debug an apply:

- **NGINX Ingress Controller matches Ingress paths literally.** The community
  controller treats an `ImplementationSpecific` path with regex metacharacters as
  a regex. NGINX Ingress Controller needs `nginx.org/path-regex`. Without it,
  `/api(/|$)(.*)` matches nothing, and every `/api/...` request falls through to
  the catch-all `/` and returns 200 from the wrong backend. No dry run catches
  that, so `--validate` won't warn you either. `convert` adds the annotation and
  reports that the annotation applies to every path on the Ingress.
- **NGINX Ingress Controller rejects snippets outright instead of degrading.**
  `enableSnippets` is off by default. An Ingress that uses
  `nginx.org/server-snippets` fails with
  `snippet specified but snippets feature is not enabled`. The annotation
  strategy converts cross-origin resource sharing (CORS) settings into snippets,
  so `--target ingress` needs `helm --set controller.enableSnippets=true`.
- **Session affinity has no Ingress annotation form.** Affinity maps to the
  VirtualServer field `upstreams[].sessionCookie`, and there's no `nginx.org/*`
  equivalent. `--target ingress` reports a note and drops it. Use
  `--target virtualserver` to carry it over.

When a target can't represent something, `nic-migrate` reports it as a note
instead of dropping it. One example is a `$n` rewrite copied onto a path with no
capture group. That's faithful to the community annotation, and almost never
what you want.

`nic-migrate` never re-implements a mapping. It parses each generated resource
back into data and lifts out the distinguishing fragment. Then it grafts that
fragment onto a resource built from your real Ingress spec. Fix a mapping on the
page, and the next run picks up the fix.

`--validate` runs `kubectl apply --dry-run=server`. That's the check that
catches a missing CRD. If no cluster is reachable, `--validate`
reports that validation didn't run and exits non-zero. It never reports a pass
it can't back up.

`--dry-run=client` needs server discovery to recognize a kind, so it fails on
every VirtualServer, and kubectl has no weaker mode to fall back to. A local
structural check runs instead, labeled as the weaker check it is.

Run `nic-migrate.js --help` for the full option list.

> **Important:** With `--target ingress`, the output reuses the source name.
> Applying it replaces the Ingress you're migrating. Pass `--name-suffix` to
> write a separate resource instead.

## What's still manual

`nic-migrate` leaves four things to you:

- **Canary and traffic splitting.** `splits` and `matches` need to know about
  the other Ingress. A converter that reads one resource can't infer it.
- **Snippets.** `nic-migrate` carries them across verbatim and never validates
  them. A directive that works in the community controller may not work in the
  same context under NGINX Ingress Controller.
- **F5 NGINX Plus features** (JWT, OIDC, WAF). These have no community
  equivalent to convert from, so they're additions rather than migrations.
- **The controller install.** `checklist` prints the steps. Installing CRDs and
  running both controllers side by side is a cluster operation, and
  `nic-migrate` doesn't do it.

## Layout

```text
nic-migrate.js      Command line: argument parsing, input, output, validation
lib/engine.js       Boots the site's analyzer headless through .github/test/lib/load.js
lib/ingress.js      Document splitting and the Ingress scanner (report only)
lib/gaps.js         The gap checks (report only)
lib/render.js       Text report, JSON, and the -o file header
lib/yaml.js         YAML subset parser and emitter (convert only)
lib/convert.js      Ingress model, fragment lifting, resource assembly
```

`lib/ingress.js` is a scanner, and `lib/yaml.js` is a parser. Everything the
scanner reads ends up in an advisory sentence, so an approximation is fine
there. It isn't fine in the converter, where values have to round-trip into
manifests.

`lib/engine.js` depends on `.github/test/lib/load.js` on purpose. With one
loader, a change to how the engine boots breaks the command at startup. A
vendored copy ages quietly instead.

Tests live at `.github/test/nic-migrate.test.js`. They sit under `.github/` so
GitHub Pages doesn't serve them, and the existing `node --test` suite picks them
up. `_config.yml` at the repository root keeps `tools/` off the published site.

### About lib/yaml.js

`lib/yaml.js` is a subset parser and emitter. It's cross-checked against PyYAML
on realistic manifests and fuzzed over roughly 5,000 random round-trips.

Fuzzing found two bugs that a code review misses. `- - k: v` parsed
as a key named `- k`. And `- "x: y"` parsed as `{'"x': 'y"'}`, because the key
pattern backtracks into the quoted scalar.

Anchors, aliases, merge keys, and tags return an error instead of being dropped
in silence. No real Kubernetes manifest needs them.

Considered and rejected: calling `kubectl create --dry-run=client -o json` to
borrow the kubectl parser. It's the more correct parser. But it makes kubectl a
hard requirement for reading a file from disk. It also can't emit, so this tool
still needs an emitter.

One emitter rule matters. The emitter quotes any scalar that starts with a
digit, `+`, `-`, or `.`. Under-quoting is a correctness bug, and over-quoting is
only cosmetic. Kubernetes uses a YAML 1.1 parser, and a YAML 1.1 parser reads
`0755` as the integer 493.

## End-to-end test

`e2e/run-e2e.py` proves the conversion on a real cluster in four stages. Each
stage isolates a different failure mode, so a failed run tells you which layer
broke.

| Stage | What it establishes |
|---|---|
| `baseline` | ingress-nginx alone serves the fixture, and each case matches its own expectations |
| `nic-installed` | NGINX Ingress Controller is deployed and answering before any converted resource exists |
| `converted` | Both controllers serve at once, and ingress-nginx still passes. A migration must not disturb what's live |
| `cutover` | With the community Ingress deleted and ingress-nginx uninstalled, NGINX Ingress Controller alone matches the baseline |

```shell
# Checks the runner's own logic. No cluster, no Docker.
python3 tools/nic-migrate/e2e/run-e2e.py --self-test

# Throwaway kind cluster, all four stages, then delete it
python3 tools/nic-migrate/e2e/run-e2e.py
python3 tools/nic-migrate/e2e/run-e2e.py --keep          # leave it up to poke at

# Stop at a checkpoint to debug (implies --keep)
python3 tools/nic-migrate/e2e/run-e2e.py --until baseline

# Use a cluster you already have
python3 tools/nic-migrate/e2e/run-e2e.py --skip-cluster
```

You need `kubectl`, `helm`, `node`, and `openssl`. Unless you pass `--skip-cluster`, you also need `kind` and
`docker`. The preflight check names anything
missing before the script does any work.

Every stage after the first compares against the recorded baseline from stage 1,
not against literal values. The assertion is equivalence. Each case goes to both
controllers, and the script compares the answers.

An assertion like "NGINX Ingress Controller returns `/things/42`" locks in
today's belief about how `rewritePath` handles a capture group. "It returns
whatever ingress-nginx returned" is what a migration actually promises. The
script reports any difference as a finding.

`.github/workflows/e2e.yml` installs `kind` and calls the same script, so
there's no CI-only path to drift out of sync. CI runs it on changes to this tool
or the engine, on demand, and weekly. The weekly run catches upstream drift in
ingress-nginx or NGINX Ingress Controller, not drift in this repository.

The scope is NGINX Open Source. `nic-migrate` never drops a case with no
equivalent on a target. It prints the case as `skip` with its reason, so the
count never shrinks in silence.

## Sandbox

`sandbox/` holds seven Ingress manifests to run the tool against by hand, and a
script that brings the e2e cluster up and leaves it running.

```shell
# No cluster needed
node tools/nic-migrate/nic-migrate.js report -f tools/nic-migrate/sandbox/manifests

# Both controllers, left running to apply conversions against
python3 tools/nic-migrate/sandbox/sandbox.py up
```

Each fixture isolates one behavior, so a surprising report points at one cause.
See [sandbox/README.md](sandbox/README.md).
