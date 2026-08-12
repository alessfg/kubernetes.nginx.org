
[![Project Status: Active – The project has reached a stable, usable state and is being actively developed.](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/nginx/kubernetes.nginx.org/badge)](https://securityscorecards.dev/viewer/?uri=github.com/nginx/kubernetes.nginx.org)
[![Community Support](https://badgen.net/badge/support/community/cyan?icon=awesome)](/SUPPORT.md)
[![Community Forum](https://img.shields.io/badge/community-forum-009639?logo=discourse&link=https%3A%2F%2Fcommunity.nginx.org)](https://community.nginx.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/license/apache-2-0)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-3.0-4baaaa.svg)](/CODE_OF_CONDUCT.md)

# kubernetes.nginx.org

F5's Kubernetes portfolio in one place, commercial and open source, served via GitHub Pages at [kubernetes.nginx.org](https://kubernetes.nginx.org/).

## What's Here

**[Home](https://kubernetes.nginx.org/)** is a grid of every product. **[Catalog](https://kubernetes.nginx.org/catalog/)** groups them by use case, and **[Better Together](https://kubernetes.nginx.org/solutions/better-together/)** covers how they combine — with each integration marked either as one F5 documents or as architectural guidance.

### Products

| | |
|---|---|
| [BIG-IP Next for Kubernetes](https://kubernetes.nginx.org/products/big-ip-next-for-kubernetes/) | L4–L7 ingress **and egress** at the North/South gateway. Commercial. |
| [BIG-IP Container Ingress Services](https://kubernetes.nginx.org/products/container-ingress-services/) | Programs an external BIG-IP from inside Kubernetes. Apache 2.0. |
| [NGINX Ingress Controller](https://kubernetes.nginx.org/products/nginx-ingress-controller/) | Ingress plus CRDs, with NGINX in the same pod. Apache 2.0. |
| [NGINX Gateway Fabric](https://kubernetes.nginx.org/products/nginx-gateway-fabric/) | Gateway API, with a separated control and data plane. Apache 2.0. |
| [F5 WAF for NGINX](https://kubernetes.nginx.org/products/f5-waf-for-nginx/) | App and API security inside either NGINX data plane. Commercial. |
| [F5 AI Gateway](https://kubernetes.nginx.org/products/f5-ai-gateway/) | Governs traffic to AI model providers. Commercial. |

### Tools

- **[ingress-nginx Migration](https://kubernetes.nginx.org/tools/ingress-nginx-migration/)** — move from the retired community controller to the F5 NGINX Ingress Controller. 130+ annotation mappings, the ConfigMap keys that differ, CRD examples, and an analyzer that reads your own YAML and returns a migration plan. Nothing leaves the browser.
- **[ingress2gateway](https://kubernetes.nginx.org/tools/ingress2gateway/)** — convert Ingress resources to Gateway API. An upstream Kubernetes SIG project, not an F5 one.

## Project Structure

A documentation-only project with **no build system, no package manager and no test framework**. Static HTML with first-party CSS and JS under `assets/`, and no third-party runtime dependency of any kind — including the webfont, which is self-hosted.

The site follows the **F5 Design System**, the design system behind the F5 Distributed Cloud console. `assets/css/tokens.css` is the whole design surface: every colour, size, space, radius, shadow and duration used anywhere resolves to a token declared there.

### Running it locally

Paths are depth-relative, so opening `index.html` straight from the filesystem
works. For a closer match to production:

```console
python3 -m http.server
```

Then open <http://localhost:8000>. The same relative paths are why the site also
works from a GitHub Pages project subpath, which is how fork previews are served.

### Checks

There is no CI for these yet; run them before opening a pull request.

```console
python3 scripts/check-tokens.py        # design-token invariants, retired colours, undefined var()
python3 scripts/check-contrast.py      # every colour pairing against WCAG 2.1 AA
python3 scripts/check-chrome-sync.py   # the shared chrome is byte-identical across all pages
node    scripts/test-analyzer.js       # the migration analyzer, under a DOM stub
```

The analyzer test matters more than it looks: `buildPlan` runs each CRD generator inside a `try/catch` that only warns, so a broken generator drops its resource and the tool still appears to work. A thrown exception is not the failure signal — the script counts `console.warn` instead.

`.claude/CLAUDE.md` holds the full working spec: the design-system rules and their documented deviations, the migration tool's data-versus-presentation boundary, the version-accuracy rules, and the release checklist.

## Contributing

Please see the [contributing guide](/CONTRIBUTING.md) for guidelines on how to best contribute to this project.

## License

[Apache License, Version 2.0](/LICENSE)

&copy; [F5, Inc.](https://www.f5.com/) 2026
