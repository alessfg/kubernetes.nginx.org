# CLAUDE.md

## Project Overview

Documentation-only project covering NGINX on Kubernetes. The site serves as a general-purpose landing page for NGINX's Kubernetes ecosystem, including:

- **NGINX Ingress Controller** (`nginx/kubernetes-ingress`) — F5 NGINX's Kubernetes Ingress Controller
- **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`) — F5 NGINX Gateway API-native implementation
- **ingress-nginx → NIC migration tool** — Interactive guide for migrating from the community controller (`kubernetes/ingress-nginx`) to the NGINX Ingress Controller
- **Traefik → NIC migration tool** — Interactive guide for migrating from Traefik Proxy (`traefik/traefik`) to the NGINX Ingress Controller (scaffold; content under construction)
- **ingress2gateway** (`kubernetes-sigs/ingress2gateway`) — CLI tool to convert Ingress resources to Gateway API

Project characteristics:

- No build system, tests, or package manager
- Static HTML + Markdown. `index.html` stays self-contained (inline CSS/JS); the two migration tools share `migration-shared.css` and `migration-shared.js`.
- Owned by F5, Inc., Apache 2.0 license

## Key Files

- `index.html` — **The live landing page** served via GitHub Pages. Hub page linking to all projects/tools above. Self-contained (inline CSS/JS).
- `ingress-nginx-migration.html` — **The live ingress-nginx → NIC migration tool** at `https://kubernetes.nginx.org/ingress-nginx-migration.html`. Interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, ConfigMap migration guidance.
- `traefik-migration.html` — **The live Traefik → NIC migration tool** at `https://kubernetes.nginx.org/traefik-migration.html`. Scaffold with placeholder content; reference tables and analyzer being added incrementally.
- `migration-shared.css` — Shared styles for both migration tools (variables, banner, topbar, sidebar shell, layout, tables, analyzer UI, info-boxes, source selector). Not consumed by `index.html`.
- `migration-shared.js` — Shared shell behavior for both migration tools (sidebar mobile toggle, dark mode, scroll-to-top button, migration checklist persistence). Loaded with `defer` from `<head>`. Source-specific code (data, analyzer, generators) stays inline in each tool's HTML.

## Workflow

### Landing page (`index.html`)

- Can be edited directly for layout/content updates since it is relatively lightweight (~1,165 lines) and self-contained.

### Migration tools (`ingress-nginx-migration.html` and `traefik-migration.html`)

- Both tools share `migration-shared.css` + `migration-shared.js` via `<link>`/`<script src>` tags in `<head>`.
- Source-specific data (version constants, annotation/middleware mappings, analyzer code, sample manifests) stays inline in each tool's HTML.
- A topbar `<details>` chip and a sidebar mode-switcher let users jump between the two tools. The active source is marked by a static `.active` class per HTML file — no JS state, no URL params, links survive bookmarks and direct loads.

#### Migration tool ordering and structure rules

Applies to mapping tables in both `ingress-nginx-migration.html` and `traefik-migration.html` (once Traefik tables land):

- **Annotation/middleware mapping rows** within each category table must be sorted alphabetically by the source name (left column).
- **"No direct equivalent" rows** (NIC-only or source-only features without a target) go at the end of their category table, after all source-to-NIC mappings.
- **NIC-only annotations must not be bundled** into source mapping rows. If an NIC annotation has no source equivalent, it gets its own "No direct equivalent" row — never grouped into an existing row.
- **Within a single row**, when multiple annotations are listed on either side, they should be in alphabetical order.

## Shared UI Elements

Most of the previously-duplicated shell (topbar markup, sidebar shell, banner CSS, dark mode, layout, table styles, analyzer UI) now lives in `migration-shared.css` / `migration-shared.js` and is consumed by **both** migration tools automatically. `index.html` still has its own inline copy.

When changing **any** of the elements below, update both the shared files **and** `index.html`:

- **Event banner** (Announcements) — the green fixed banner at the top of the page, including its CSS (`.event-banner`, `.has-banner` offsets) and JS init
- **Top bar** — the NGINX logo, GitHub link, and dark mode toggle (markup is duplicated in each HTML file; behavior is in `migration-shared.js`)
- **Sidebar external links** — GitHub, Documentation, Blog, YouTube, Community links at the bottom of the sidebar (markup duplicated per file)
- **Sidebar copyright** — footer text in the sidebar
- **Dark mode styles** — variable overrides, sidebar link/ext colors. Dark mode link colors (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in index.html, `.main-inner` in the migration tools) — never applied globally, or they will override topbar/sidebar link colors.
- **Source-selector chip + sidebar mode-switcher** — present on both migration tools; CSS lives in `migration-shared.css`. The chip's `.source-chip-current` text and the `.active` class assignments on `.source-chip-option` / `.source-mode` differ per file.

## Hosting

- **Repository**: https://github.com/nginx/kubernetes.nginx.org
- **GitHub Pages**: https://kubernetes.nginx.org/ (serves `index.html` from `main` branch as the landing page)
- **ingress-nginx Migration Tool**: https://kubernetes.nginx.org/ingress-nginx-migration.html
- **Traefik Migration Tool**: https://kubernetes.nginx.org/traefik-migration.html

## Domain Concepts

- **Landing page**: The root `index.html` is a hub for the NGINX Kubernetes ecosystem — not just the migration tools
- **Gateway API**: The standard Kubernetes API for traffic management; NGINX Gateway Fabric is the NGINX implementation
- **Annotation prefixes**: Community ingress-nginx uses `nginx.ingress.kubernetes.io/`; Traefik uses `traefik.ingress.kubernetes.io/` on standard Ingress resources; NGINX Ingress Controller uses `nginx.org/` (OSS) or `nginx.com/` (Plus)
- **NIC CRDs**: NGINX Ingress Controller supports VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration
- **Traefik CRDs (v3.x, `traefik.io/v1alpha1`)**: IngressRoute, IngressRouteTCP, IngressRouteUDP, Middleware, MiddlewareTCP, ServersTransport, ServersTransportTCP, TLSOption, TLSStore, TraefikService. Pre-v3 used `traefik.containo.us/v1alpha1` (deprecated as of Traefik 3.0; the analyzer should detect both and warn on v2 manifests since several fields were renamed in the v2 → v3 transition, e.g. `IPWhiteList` → `IPAllowList`).
- **NGINX Plus**: Only the NGINX Ingress Controller supports Plus features (JWT, OIDC, WAF).
- **Naming**: Use "NGINX Ingress Controller" (not "Official NGINX Ingress Controller" or "NGINX Inc."). The community controller is referred to as the "community controller" or by its repo name `kubernetes/ingress-nginx`. Traefik is referred to as "Traefik" or "Traefik Proxy" (not "Traefik Labs" — that's the company).

## Research Resources

When verifying information, use GitHub MCP tools to fetch from these authoritative sources:

**Community controller** (`kubernetes/ingress-nginx`):

- GitHub: https://github.com/kubernetes/ingress-nginx
- Docs tree: https://github.com/kubernetes/ingress-nginx/blob/main/docs
- Annotations: https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/nginx-configuration/annotations.md
- Docs site: https://kubernetes.github.io/ingress-nginx
- Published annotations: https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/

**Traefik Proxy** (`traefik/traefik`):

- GitHub: https://github.com/traefik/traefik
- Annotations on standard Ingress: `docs/content/reference/routing-configuration/kubernetes/ingress.md` (at the release tag)
- IngressRoute CRD reference: `docs/content/reference/routing-configuration/kubernetes/crd/http/ingressroute.md`
- TraefikService CRD reference: `docs/content/reference/routing-configuration/kubernetes/crd/http/traefikservice.md`
- HTTP middleware list: `docs/content/reference/routing-configuration/http/middlewares/overview.md`
- TCP middleware list: `docs/content/reference/routing-configuration/tcp/middlewares/overview.md`
- CRD manifests (authoritative for field names): `docs/content/reference/dynamic-configuration/traefik.io_*.yaml`
- Docs site: https://doc.traefik.io/traefik/

**NGINX Ingress Controller** (`nginx/kubernetes-ingress`):

- GitHub: https://github.com/nginx/kubernetes-ingress
- Docs tree: https://github.com/nginx/kubernetes-ingress/tree/main/docs/content
- Annotations: https://github.com/nginx/documentation/blob/main/content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md
- Docs site: https://docs.nginx.com/nginx-ingress-controller/
- Published annotations: https://docs.nginx.com/nginx-ingress-controller/configuration/ingress-resources/advanced-configuration-with-annotations/
- VirtualServer CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/virtualserver-and-virtualserverroute-resources/
- Policy CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/policy-resource/
- TransportServer CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/transportserver-resource/
- GlobalConfiguration CRD: https://docs.nginx.com/nginx-ingress-controller/configuration/global-configuration/globalconfiguration-resource/

**NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`):

- GitHub: https://github.com/nginx/nginx-gateway-fabric
- Docs site: https://docs.nginx.com/nginx-gateway-fabric/

**ingress2gateway** (`kubernetes-sigs/ingress2gateway`):

- GitHub: https://github.com/kubernetes-sigs/ingress2gateway

**Migration guides**:

- ingress-nginx → NIC: https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx
- Traefik → NIC: no official migration guide yet — this tool is the canonical reference

Prefer GitHub MCP tools over WebFetch for documentation sites.

## Version Accuracy

**Critical rule:** Every annotation, ConfigMap key, CRD field, or feature documented in either migration tool MUST exist in the version referenced by the tool's "Version Reference" banner. Before adding any feature to a migration tool:

1. Check the version stated in the tool's Version Reference (e.g., NIC `v5.5.0`, Traefik `v3.7.1`).
2. Verify the feature exists in that released version — use `mcp__github__get_file_contents` against the corresponding tag to confirm annotations/CRD fields exist in source code or docs.
3. Never document unreleased features, features from `main`/`master` branches that haven't been tagged, or features from future versions.

When bumping the referenced version, audit the release notes to identify genuinely new features and update accordingly — but do not pre-document features from versions that haven't shipped yet.

### Release update checklist

When updating the sites for a new release, update **all** of the following.

**Kubernetes compatibility (applies to both NIC and NGF):** the compat tables always show the **latest 3 Kubernetes minor versions** (matches upstream's support window — verify via `kubernetes/kubernetes` releases), not the project's full supported range. Bump these alongside any release update if a newer K8s minor has shipped.

#### NGINX Ingress Controller (NIC) release

**`index.html`:**

- Version fallback text in `data-version="nic.release"` spans (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`)
- Helm chart version in `data-version="nic.helm"` spans and the Helm install command
- JS `VERSION_CONFIG` fallback values for `nic.release` and `nic.helm`
- **Compatibility table** in the NIC section — update NGINX OSS version (check `NGINX_OSS_VERSION` in `build/Dockerfile` at the release tag) and Kubernetes versions if changed

**`ingress-nginx-migration.html`:**

- Update the `NIC_VERSION` and `INGRESS_NGINX_VERSION` constants at the top of the main `<script>` block — these are the single source of truth for the Version Reference banners (3 instances), the standalone `kubectl apply` example, and every `crdInstall` URL inside `ANNOTATION_MAPPINGS`. Banner text and release-tag links are populated from these constants at `DOMContentLoaded`.
- Update the static fallback text inside the `data-*-version` spans / `data-*-release-link` anchors (so no-JS users see the correct version before the JS runs).

**`traefik-migration.html`:**

- Update the `NIC_VERSION` constant in the inline `<script>` block — populates `[data-nic-version]` spans and `[data-nic-release-link]` href.
- Update the static fallback text inside the `data-nic-*` spans/anchors.

#### Traefik release

**`traefik-migration.html` only** (the other tools don't reference Traefik):

- Update the `TRAEFIK_VERSION` constant in the inline `<script>` block.
- Update the static fallback text inside `data-traefik-version` spans and `data-traefik-release-link` anchors.
- When bumping major versions (e.g. v3 → v4), audit Middleware CRD field names, IngressRoute schema, and any deprecated API groups (`traefik.containo.us` → `traefik.io` happened at the v2 → v3 boundary — expect similar churn at major bumps).

#### NGINX Gateway Fabric (NGF) release

**`index.html` only** (the migration tools do not reference NGF):

- Version fallback text in `data-version="ngf.release"` spans (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`)
- Helm chart version in `data-version="ngf.helm"` spans and the Helm install command
- JS `VERSION_CONFIG` fallback values for `ngf.release` and `ngf.helm`
- **Compatibility table** in the NGF section — update NGINX OSS version (check the NGF release notes / README technical specs table) and Kubernetes versions if changed
- **Supported Resources** tag list — review against `apis/v1alpha1` and `apis/v1alpha2` at the release tag to catch any new CRDs (e.g. `WAFPolicy` was added in v2.6.0). Keep tags alphabetical within the NGF custom-resources block.
- **Gateway API version** in the "Fully Conformant Gateway API" pill and feature card copy (currently mentions v1.5.1) — update if the release bumps the conformant Gateway API version.
