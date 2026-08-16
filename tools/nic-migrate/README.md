# nic-migrate

Batch the migration tool's analyzer over real Ingress manifests, from a terminal.

The web tool at [kubernetes.nginx.org/ingress-nginx-migration.html](https://kubernetes.nginx.org/ingress-nginx-migration.html)
analyzes one paste at a time. This runs the *same* engine — same 57 mapping
entries, same ~130 annotations, same value transforms, same CRD generators —
over a directory of manifests or a live cluster, one Ingress document at a time,
and adds the thing a paste box cannot: a per-Ingress account of what the
engine's single-context model left behind.

It reads the mapping database out of `assets/js/` rather than vendoring a copy,
so it cannot drift from the published page. Run it from a checkout.

```bash
node tools/nic-migrate/nic-migrate.js report -f ./manifests
node tools/nic-migrate/nic-migrate.js report --kubectl -n prod
kubectl get ing -A -o yaml | node tools/nic-migrate/nic-migrate.js report
node tools/nic-migrate/nic-migrate.js checklist
```

Zero dependencies. Node 18+.

## Stage 1 is advisory, on purpose

**Do not apply this output unreviewed.** The engine was written to teach one
annotation at a time, and its shape follows from that:

- `parseInput` keeps **one** host, service, path and TLS secret. A two-path
  Ingress produces output covering the first path only.
- Every CRD generator emits a **self-contained illustration**. `rewrite-target`
  plus `affinity` yields *two* VirtualServers that both claim the same host —
  apply both and NIC accepts one and rejects the other.
- Policies are generated but the reference to them is only ever a comment.
- `namespace`, `ingressClassName` and `spec.tls` are read but not carried into
  any generated resource.

None of that is a bug in the page; it is the right shape for a reference tool
and the wrong shape for a file you would `kubectl apply`. So rather than paper
over it, `nic-migrate` reports it. Every one of those conditions is a named gap:

| Severity | Meaning |
|---|---|
| `blocking` | Would be rejected, or would lose traffic, if applied as-is |
| `review` | Needs a human decision |
| `note` | Informational |

`--strict` exits non-zero when any `blocking` gap is found, so this is usable as
a CI gate on a migration branch.

### Gaps it detects

`generator-warning` · `hosts-dropped` · `paths-dropped` · `backends-dropped` ·
`host-conflict` · `policy-unwired` · `namespace-dropped` · `tls-dropped` ·
`class-dropped` · `todo-placeholders` · `unsupported` · `unrecognized` ·
`snippet-passthrough`

`generator-warning` is the load-bearing one. `buildPlan` runs each generator in
a `try`/`catch` that only `console.warn`s, so a broken generator **drops its
resource** and the analysis still looks successful. A thrown exception is not
the failure signal — a captured warning is.

## Options

```
report
  -f, --file <path>        YAML file, or a directory scanned for .yaml/.yml.
                           Repeatable.
  -k, --kubectl            Read live Ingresses with kubectl.
  -n, --namespace <ns>     Namespace for --kubectl (default: all namespaces).
  -s, --strategy <name>    crd | annotation            (default: crd)
  -o, --out <dir>          Also write per-Ingress YAML, with a gap header.
      --json               Emit JSON instead of the text report.
      --no-color           Disable ANSI colour (also honours NO_COLOR).
      --strict             Exit 1 if any blocking gap was found.

checklist                  Print the 22-item migration checklist, read live
                           from the published page.
```

## Layout

```
nic-migrate.js      CLI: argument parsing, input gathering, output
lib/engine.js       Boots the site's analyzer headless via .github/test/lib/load.js
lib/ingress.js      Document splitting and the Ingress scanner
lib/gaps.js         The gap checks
lib/render.js       Text report, JSON, and the -o file header
```

Tests are at `.github/test/nic-migrate.test.js` — under `.github/` so Pages does
not serve them, and picked up by the existing `node --test` suite. The tool
itself is excluded from the published site by `_config.yml` at the repo root.

`lib/engine.js` depends on `.github/test/lib/load.js` deliberately: one loader,
so a change to how the engine boots breaks the CLI loudly at startup instead of
leaving a vendored copy to age quietly.

## Stage 2: the converter

Stage 1 reports. A converter that emits manifests you could actually apply is
the next piece, and it needs a different foundation:

- **Real YAML parsing.** `lib/ingress.js` is a scanner, which is fine when every
  value it produces ends up in an advisory sentence and not fine when values
  have to round-trip. The plan is to shell out to
  `kubectl create --dry-run=client -o json`, so kubectl's own parser does the
  work and the zero-dependency rule survives.
- **Merge, don't illustrate.** One VirtualServer per host, all routes folded in,
  Policies wired into `spec.policies`, TLS and namespace preserved.
- **Validate.** `kubectl apply --dry-run=server` before anything is written.

Worth stating because it narrows the job: NIC reads standard
`networking.k8s.io/v1` Ingress. The migration is annotations, ConfigMap keys,
and the features that genuinely need CRDs — not a wholesale resource rewrite.
Keeping the Ingress and rewriting its annotations is a valid migration for a
large share of real workloads, and the `annotation` strategy targets exactly
that.
