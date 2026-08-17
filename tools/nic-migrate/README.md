# nic-migrate

Run the migration tool's analyzer over real Ingress manifests, from a terminal —
ingress-nginx by default, or HAProxy or Traefik with `--source`.

> **Beta.** Review the output before you apply anything to a cluster. Command
> names, flags, and the manifests it generates may still change.

The web tool at
[kubernetes.nginx.org/ingress-nginx-migration.html](https://kubernetes.nginx.org/ingress-nginx-migration.html)
analyzes one paste at a time. `nic-migrate` runs the same engine over a
directory of manifests or a live cluster. Same 57 mapping entries, same 130
annotations, same value transforms and CRD generators. It reads the mapping
database out of `assets/js/` instead of vendoring a copy, so it cannot drift
from the published page. Run it from a checkout.

No dependencies. Node 18 or newer. `kubectl` is needed only for `--kubectl`
and `--validate`.

## Getting started

```bash
# What would change, and what the analyzer cannot work out on its own
node tools/nic-migrate/nic-migrate.js report -f ./manifests
node tools/nic-migrate/nic-migrate.js report --source haproxy -f ./manifests
node tools/nic-migrate/nic-migrate.js report --source traefik --whole-input -f ./crs
node tools/nic-migrate/nic-migrate.js report --kubectl -n prod

# Manifests you can apply
node tools/nic-migrate/nic-migrate.js convert -f ./manifests --validate
node tools/nic-migrate/nic-migrate.js convert -f ./in --target ingress -o ./out

# The 22-item checklist, read live from the published page
node tools/nic-migrate/nic-migrate.js checklist
```

`report` shows the analyzer's own output, one single-feature illustration per
annotation, and names what those illustrations leave out. Use it to understand
a workload. `convert` merges them into manifests you can apply. Use it to
migrate one.

## Sources

`--source` picks which of the site's analyzers to run. The mapping data, value
transforms and generators all come from `assets/js/`, so the CLI reports exactly
what the matching page reports.

| | ingress-nginx | haproxy | traefik |
|---|---|---|---|
| module | `migration-ingress-nginx.js` | `migration-haproxy.js` | `migration-traefik.js` |
| annotation prefixes | `nginx.ingress.kubernetes.io/` | `haproxy.org/`, `haproxy.com/`, `ingress.kubernetes.io/` | `traefik.ingress.kubernetes.io/` |
| kinds read | Ingress | Ingress, Service, ConfigMap, Global, Defaults, Backend, Frontend, TCP | Ingress, IngressRoute(+TCP/UDP), Middleware(+TCP), TraefikService, TLSOption, TLSStore, ServersTransport(+TCP) |

The kinds column is the substantive difference, and the three sources sit at
different points on it. ingress-nginx keeps every setting on the Ingress, so an
Ingress-only scan sees all of it. HAProxy spreads the same job across annotated
Ingress **and Service** objects, its controller ConfigMap and five CRs. Traefik
inverts that: one annotation prefix, and almost everything real in CRs. A scan
that only looked at Ingresses would report "nothing found" on either.

Traefik's static configuration is deliberately not in that list: it is CLI flags
or a `traefik.yml`, not a Kubernetes object, so there is no kind to gate on. The
page documents it; the CLI cannot read it.

### `--whole-input`, and when you need it

By default each document is analyzed on its own. That is right for
ingress-nginx, where an Ingress is self-contained, and it keeps the report
per-object.

It is wrong for a Traefik `IngressRoute`, which references `Middleware` objects
that are separate documents by design. Analyzed alone, every one of those
references is reported as unresolved and the migration is understated — the
middlewares contribute nothing. `--whole-input` analyzes everything as one unit,
the way the web tool treats a paste, and the references resolve: a rate-limit
Middleware becomes a `rateLimit` Policy, a headers Middleware becomes the HSTS
annotations.

The cost is the engine's single-context model — one host, one service, one path
across the whole input — so the gaps then report the rest as dropped. That is
the honest trade, and it is why the flag is opt-in rather than the default. The
same applies to a HAProxy Ingress that points at a `Backend` CR.

`report` covers all of those kinds. `convert` builds from the Ingress, so for a
HAProxy input it names the Service objects, ConfigMap and CRs it did not
represent on stderr and tells you to run `report` for them, rather than dropping
them quietly.

One more difference worth knowing: the class on a source Ingress selects the
*source* controller. Copying `ingressClassName: haproxy` onto NIC output would
produce a resource NIC ignores — silently, since an unmatched class is not an
error — so `convert` omits a foreign class and says so. Pass `--class nginx` to
set NIC's. The community controller's class is usually literally `nginx`, which
is also NIC's default, so that one carries over untouched.

Adding a source is one entry in `lib/sources.js` plus a module in `assets/js/`.

## Reading a report

```
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

Do not apply a report unreviewed. The engine was written to teach one
annotation at a time, and its output follows from that:

- `parseInput` keeps one host, service, path, and TLS secret. A two-path
  Ingress produces output covering the first path only.
- Each CRD generator emits a self-contained illustration. `rewrite-target`
  plus `affinity` yields two VirtualServers claiming the same host. Apply both
  and NGINX Ingress Controller accepts one, rejects the other.
- Policies are generated, but the reference to them is only ever a comment.
- `namespace`, `ingressClassName`, and `spec.tls` are read but not carried into
  any generated resource.

A reference page needs one feature at a time. A file you `kubectl apply` needs
all of them at once. `nic-migrate` reports each case as a named gap:

| Severity | Meaning |
|---|---|
| `blocking` | Would be rejected, or would lose traffic, if applied as-is |
| `review` | Needs a human decision |
| `note` | Informational |

`--strict` exits non-zero when any `blocking` gap is found, which makes this
usable as a CI gate on a migration branch.

The gaps it detects: `generator-warning`, `hosts-dropped`, `paths-dropped`,
`backends-dropped`, `host-conflict`, `policy-unwired`, `namespace-dropped`,
`tls-dropped`, `class-dropped`, `todo-placeholders`, `unsupported`,
`unrecognized`, `snippet-passthrough`.

Watch `generator-warning` in particular. `buildPlan` runs each generator in a
`try`/`catch` that only calls `console.warn`, so a broken generator drops its
resource while the analysis still looks successful. The failure signal is a
captured warning, not a thrown exception.

## Converting

`--target virtualserver` (the default) emits one merged VirtualServer per host.
Every path becomes a route, every distinct backend an upstream, Policies are
referenced from `spec.policies`, and TLS, namespace, and `ingressClassName` are
carried over.

`--target ingress` keeps the Ingress resource and rewrites its annotations to
`nginx.org/*`, adding `nginx.org/policies` for anything that needs a Policy.
It is lower risk and enough for many real workloads, because NGINX Ingress
Controller reads standard `networking.k8s.io/v1` Ingress. It defaults to
`--strategy annotation`, since asking for an Ingress and then running the
CRD-first strategy produces fragments an Ingress cannot carry.

Anything the chosen target cannot represent is reported as a note rather than
dropped. That includes a `$n` rewrite copied onto a path with no capture group,
which is faithful to the community annotation and almost never intended.

Nothing here re-implements a mapping. Each generated resource is parsed back
into data, its distinguishing fragment is lifted out, and that fragment is
grafted onto a resource built from the real Ingress spec. Fix a mapping on the
page and it is fixed here on the next run.

`--validate` runs `kubectl apply --dry-run=server`, which is the check that
catches a CRD that is not installed. With no cluster reachable it reports that
validation did not run and exits non-zero, rather than reporting a pass.
`--dry-run=client` needs server discovery to recognize a kind, so it fails on
every VirtualServer, and kubectl has no weaker mode to fall back to. A local
structural check runs instead, labelled as the weaker thing it is.

Run `nic-migrate.js --help` for the full option list. One flag is worth knowing
about before a side-by-side run: with `--target ingress`, the output reuses the
source's name. Applying it replaces the Ingress you are migrating. Pass
`--name-suffix` to write a separate resource instead.

## What is still manual

- **Canary and traffic splitting.** `splits` and `matches` need the other
  Ingress to be known, and a single-resource converter cannot infer it.
- **Snippets.** Carried across verbatim and never validated. Directives valid
  in the community controller may not be valid in the same context under
  NGINX Ingress Controller.
- **NGINX Plus features** (JWT, OIDC, WAF) have no community equivalent to
  convert from. They are additions, not migrations. Session affinity is not in
  this group: `sessionCookie` works on NGINX Open Source.
- **The controller install.** `checklist` prints the steps. Installing CRDs and
  running both controllers side by side is a cluster operation this tool does
  not perform.

## Layout

```
nic-migrate.js      CLI: argument parsing, input gathering, output, validation
lib/sources.js      One entry per source: module path, kinds read, CLI strings
lib/engine.js       Boots the site's analyzer headless through .github/test/lib/load.js
lib/ingress.js      Document splitting and the Ingress scanner (report only)
lib/gaps.js         The gap checks (report only)
lib/render.js       Text report, JSON, and the -o file header
lib/yaml.js         YAML subset parser and emitter (convert only)
lib/convert.js      Ingress model, fragment lifting, resource assembly
```

`lib/ingress.js` is a scanner and `lib/yaml.js` is a parser. Everything the
scanner reads ends up in an advisory sentence, so approximation is acceptable
there, and not in the converter, where values have to round-trip into manifests.

`lib/engine.js` depends on `.github/test/lib/load.js` on purpose. One loader
means a change to how the engine boots breaks the CLI at startup, instead of
leaving a vendored copy to age quietly.

Tests live at `.github/test/nic-migrate.test.js`, under `.github/` so Pages does
not serve them, and picked up by the existing `node --test` suite. `_config.yml`
at the repo root keeps `tools/` off the published site.

### About lib/yaml.js

A subset parser and emitter, cross-checked against PyYAML on realistic
manifests and fuzzed over roughly 5,000 random round-trips. Fuzzing found two bugs that reading would
not have. `- - k: v` parsed as a key named `- k`. And `- "x: y"` parsed as
`{'"x': 'y"'}`, because the key pattern backtracks into the quoted scalar.

Anchors, aliases, merge keys, and tags return an error rather than being
silently dropped. No Kubernetes manifest in the wild needs them.

Considered and rejected: shelling out to `kubectl create --dry-run=client -o
json` to borrow kubectl's parser. It is the more correct parser. But it makes
kubectl a hard requirement for reading a file off disk, and it cannot emit, so
an emitter would have been needed anyway.

One emitter rule is worth knowing: any scalar starting with a digit, `+`, `-`,
or `.` is quoted. Under-quoting is a correctness bug and over-quoting is
cosmetic. `0755` read by a YAML 1.1 parser, which is what Kubernetes uses, is
the integer 493.

## End-to-end test

`e2e/run-e2e.py` proves the conversion on a real cluster in four stages. Each
isolates a different failure mode, so a red run tells you which layer broke.

| Stage | What it establishes |
|---|---|
| `baseline` | ingress-nginx alone serves the fixture, each case checked against its own expectations |
| `nic-installed` | NGINX Ingress Controller is deployed and answering before any converted resource exists |
| `converted` | Both controllers serve at once, and ingress-nginx is re-checked, because a migration must not disturb what is still live |
| `cutover` | The community Ingress is deleted, ingress-nginx is uninstalled, and NGINX Ingress Controller alone still matches the baseline |

```bash
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

Needs `kubectl`, `helm`, `node`, and `openssl`, plus `kind` and `docker` unless
you pass `--skip-cluster`. Preflight names anything missing before doing any
work.

Every stage after the first compares against the recorded stage-1 baseline
rather than against literals. The assertion is equivalence: each case goes to
both controllers and the answers are compared. Asserting "NGINX Ingress
Controller returns `/things/42`" would bake in today's belief about how
`rewritePath` handles a capture group. Asserting "it returns whatever
ingress-nginx returned" is what a migration promises. Differences are reported
as findings.

`.github/workflows/e2e.yml` installs `kind` and calls the same script, so there
is no CI-only path to drift out of sync. CI runs it on changes to this tool or the
engine, on demand, and weekly. The weekly run is there to catch upstream drift
in ingress-nginx or NGINX Ingress Controller rather than in our own code.

Scope is NGINX Open Source. A case with no equivalent on a target prints as
`skip` with its reason rather than being dropped, so the count never quietly
shrinks.

### What the first real run found

None of these was predicted. All three are now handled by `convert`.

- **Ingress paths are matched literally.** The community controller treats an
  `ImplementationSpecific` path containing regex metacharacters as a regex.
  NGINX Ingress Controller needs `nginx.org/path-regex`. Without it,
  `/api(/|$)(.*)` matched nothing and every `/api/...` request fell through to
  the catch-all `/`, returning 200 from the wrong backend. No dry run would
  have caught it.
- **Snippets are rejected by default.** `enableSnippets` is off, and an Ingress
  using `nginx.org/server-snippets` is rejected outright rather than degraded:
  `snippet specified but snippets feature is not enabled`. The annotation
  strategy converts CORS into snippets, so `--target ingress` needs
  `helm --set controller.enableSnippets=true`.
- **Session affinity has no Ingress annotation form.** It maps to VirtualServer
  `upstreams[].sessionCookie`, which works on NGINX Open Source. There is no
  `nginx.org/*` equivalent, so `--target ingress` loses stickiness silently.

The pipeline also answered the question it was built for: `rewritePath` handles
`$2` captures the same way the community `rewrite-target` does. Both
controllers return `/things/42` for `/api/things/42`.
