# CLAUDE.md

## Project Overview

Documentation-only project covering NGINX on Kubernetes. The site serves as a general-purpose landing page for NGINX's Kubernetes ecosystem, including:

- **NGINX Ingress Controller** (`nginx/kubernetes-ingress`) — F5 NGINX's Kubernetes Ingress Controller
- **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`) — F5 NGINX Gateway API-native implementation
- **NGINX Ingress Migration Tool** — Interactive guide for migrating from the community controller (`kubernetes/ingress-nginx`) to the NGINX Ingress Controller
- **ingress2gateway** (`kubernetes-sigs/ingress2gateway`) — CLI tool to convert Ingress resources to Gateway API

Project characteristics:

- No build system, tests, or package manager
- Static HTML + Markdown documentation with CSS/JS in `assets/` (no CDN/third-party runtime dependencies)
- Owned by F5, Inc., Apache 2.0 license

## Directory layout

CSS and JS are split into external files under `assets/` (shared chrome + per-page), so the two HTML pages no longer duplicate styles/scripts. Images live under `assets/img/`, the webfont under `assets/fonts/`.

```
assets/
  css/  shared.css        # chrome: @font-face, design tokens, type scale, reset, topbar, sidebar, event banner, dark mode, layout, accessibility
        index.css         # landing-page-only styles (hero, feature/project grids, compat tables, CTAs, code blocks)
        migration.css     # migration-tool styles shared by all migration pages (analyzer UI, mapping/reference tables, badges, checklist, print)
  js/   shared.js         # chrome behavior: dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year (globals)
        index.js          # landing-page behavior: version auto-fetch, SPA product switching, entrance animation, YouTube
        migration-core.js           # source-agnostic migration-tool engine: analyzer orchestration/rendering, table filtering, page nav, checklist; defines window.MigrationTool (NIC target versions + shared utils)
        migration-ingress-nginx.js  # ingress-nginx SOURCE module: INGRESS_NGINX_VERSION, ANNOTATION_MAPPINGS, parsers, CRD generators, sample presets; defines window.MIGRATION_SOURCE
  img/  icon.svg, icon-512.png, apple-touch-icon.{svg,png}, og-image.{svg,png}
  fonts/ InterVariable-subset.woff2, OFL.txt, README.md   # the site's only webfont — see README.md for provenance and how to regenerate
```

Loading rules (all pages): `shared.css` is linked before the page CSS; `shared.js` is loaded before the page JS (the page scripts are IIFEs that call shared.js globals like `closeSidebar` / `copyToClipboard`). Migration pages load **three** scripts in this exact order: `shared.js` → `migration-<source>.js` → `migration-core.js`. The source module must load before the core (the core reads `window.MIGRATION_SOURCE` at top level); source modules never touch the DOM and may dereference `MigrationTool.*` only inside function bodies (call time), never at top level. Asset paths are **relative** (`assets/css/…`, `assets/js/…`, no leading `/`) so they resolve identically locally, in PR previews, and in production. Every page also carries a `<link rel="preload" as="font" … crossorigin>` for the woff2 **before** the stylesheet links — the `@font-face` lives inside `shared.css`, so without the preload the font is not discoverable until that CSS has parsed. The inline `<head>` dark-mode flash-prevention `<script>` and the page-specific JSON-LD stay inline; classic (non-module) scripts keep functions global.

## Typography

The site sets type in **Inter**, per the **F5 Design System (F5DS)** — the design system for F5 Distributed Cloud product UI (`~/.claude/skills/f5-product-ui-core`). This is deliberately a *different* standard from the F5 marketing brand (`f5-brand-core`: Neusa Next Pro Wide / Proxima Nova), which the site used until 2026-08-07; those faces are license-gated on brand.f5.com and could never be self-hosted, so most visitors only ever saw a metric-corrected Arial standing in for them. **Do not blend the two standards** — a value correct in one is a defect in the other. The split, as of 2026-08-11, is:

| Dimension | Standard |
|---|---|
| Type, spacing, radius, elevation, motion, grid, component geometry, UI-label case | **F5DS** |
| Colour, and long-form prose voice | **F5 marketing / Brand Center ramps**, NGINX green lead |

So an F5DS scanner run flags every colour, and that is expected rather than a regression. See "Spacing, radius, elevation, motion" below for the structural half.

- **All sizes go through the scale tokens in `shared.css`** (`--fs-*` / `--lh-*`): `h1` 36/54, `h2` 24/36, `h3` 18/26, `body-lg` 16/24, `body` 14/20, `caption` 12/18, `badge` 10/16, `code` 14/24. Never write a raw `rem`/`px` font-size — including in inline `style=` attributes and in JS-generated `cssText`, both of which exist in the migration tool and are easy to miss.
- F5DS pairs a **fixed leading with each size** rather than one global ratio, so `line-height` is a length, not a multiplier: any rule that sets `font-size` must restate the paired `--lh-*`.
- **Weights are 400 / 500 / 700 only.** No 300, no 600.
- **`letter-spacing` is 0 on every style** — the scale specifies no tracking anywhere, so there should be no `letter-spacing` declaration in the CSS at all.
- **Documented deviations** (keep them, don't "fix" them): `--mono` stays SF Mono rather than F5DS's Courier, which is unreadable at code-block sizes — docs.nginx.com deviates identically with JetBrains Mono. The glyph-only sizes (`.checklist li::before` ☐, `.sample-dropdown-btn::after` ▼), the em-based inline `code` size, and the print stylesheet's `11pt` are icons/relative/print, not type.
- The font is **self-hosted, never a CDN**. See `assets/fonts/README.md` before upgrading or re-subsetting it — in particular, `→` is used 29 times in the mapping tables and is outside both stock Google `latin` and `latin-ext` ranges.

## Spacing, radius, elevation, motion

Structural tokens live in `shared.css:root` alongside the type scale, and follow **F5DS**. Same rule as typography: **never write a raw value at a call site** — including inline `style=` attributes and JS-generated `cssText`/`style.*`, which is where they hide.

- **Spacing** (`--space-*`): base 8px, every value a multiple of 4. Named for F5DS's own steps so each token is auditable: `xsmall` 2, `small` 4, `base` 8, `2x` 16, `2hx` 20, `3x` 24, `3hx` 28, `4x` 32, `4hx` 36, `5x` 40, plus `6x` 48 and `8x` 64 as local extensions past F5DS's published 40px ceiling (its own `Nx = 8N` formula). Two hard rules: **`12px` is not in the system** — resolve a 12px gap to 8 or 16 by context, never to itself, which is why there is deliberately no step between `base` and `2x` — and **2px is only used between a label and its form control.**
- **Choosing between 8 and 16**, rather than rounding: icon↔text **8**; between buttons in a group **20**; sibling controls in a row **16**; grid gutter **16**; same-thought margin (heading→body, para→para) **8**; peer blocks and body→trailing-link **16**; container insets **16**, so labels align with the container's own margin; section→section **40**. When genuinely ambiguous, round **down** to 8 — vertical padding compounds down a 4,900-line page.
- **Radius** (`--radius` 4px, `--radius-small` 2px, `--radius-pill` 999px): 4px for everything, `--radius-small` only when an element is too small for 4px, and **`--radius-pill` for Tags and Badges only** — a pill-shaped button, card or input is off-system. `.analyzer-pill` is split on exactly this line: the `<span>` keeps the pill, the `<button>` takes 4px.
- **Elevation** (`--elev-0/1/2`): N700 `#0B1640` at 8% / 12%, never black. **L0 on buttons and typographic elements** — they carry their own affordance. L1/L2 only on surfaces genuinely above the page. Interactive surfaces rest on L1 and strengthen to L2 on hover; **they do not translate** (see deviations).
- **Motion** (`--dur-*`, `--ease-*`): D2 200ms for colour/opacity with an explicit `linear`, D3 300ms, D4 400ms, D5 600ms, and 400ms linear for a shadow's own fade (the Elevation page, not the Motion page). `--ease-enter` (EaseOutQuint) on entrances, `--ease-exit` (EaseInCubic) on exits. F5DS assigns durations **by distance travelled**, adding 100ms per 10% of screen crossed — use that to place a new value rather than guessing.
- **Grid**: 12 columns, 16px gutter adopted (`--space-2x` on every multi-column grid). F5DS's 20px side margin is **not** adopted; the site keeps 48px content gutters. `--sidebar-w` is 264px, F5DS's fixed Primary Navigation width.
- **Buttons**: one system in `shared.css` — `.btn` plus `.btn-primary`/`.btn-secondary`, sizes `.btn-xs` 24 / default 32 / `.btn-md` 40, 20px horizontal padding, `.btn-row` for the 20px group gap, `.btn-loading` for the F5DS Loading state. **Exactly one Primary per group.** Match a button's size to any input beside it. Compose bespoke buttons onto `.btn` (add `btn` + variant + size to the `className`) and keep only the colours that differ — do not redefine geometry. Tabs and the segmented control are separate F5DS components and deliberately stay off `.btn`.
- **UI-label case**: Title Case on buttons, links, tab labels and navigation titles, and on the `<h2>`/`<h3>` headings that mirror a nav item so the two agree. Sentence case on notification titles and bodies, tooltips, form-control labels, error text, checklist items, table-cell blurbs and `sidebar-link-desc`. No terminal punctuation on labels. Preserve technical tokens verbatim (`CRD`, `NGINX`, `ConfigMap`, `mTLS`, `responseHeaders`, `ingress2gateway`, and the community repo name `ingress-nginx` — never `Ingress-Nginx`).

### Documented deviations (keep these; don't let a scanner "fix" them)

| Deviation | Why |
|---|---|
| **No hover lift** — L1→L2 shadow only, no `translateY(-4px)` | Decided in `1dab729` against f5.com's production CSS. F5DS's `Elevate Up` is a Motion-page catalogue entry, not a mandate, and 40 cards lifting on one landing page is a lot of motion for a docs site. |
| **Marketing colour palette** | The deliberate half of the two-standard split. |
| **Dark theme** | F5DS publishes none (Early Availability only). Dark shadows deepen with black — N700 at 8% is invisible on black. |
| **900px / 600px breakpoints, and all max-widths** | F5DS publishes no breakpoints and never states its fixed grid's maximum width. Local conventions, not spec values. |
| **48px content gutters** (not F5DS's 20px) | 20px assumes a dense product screen in a chrome-heavy shell; on a 1300px docs page it puts prose against the viewport edge. |
| **`--mono` = SF Mono** (not Courier) | Unreadable at code-block sizes; docs.nginx.com deviates identically. |
| **`min-height: 44px` on mobile tabs/controls** | WCAG target size beats F5DS's fixed 32px. |
| **`prefers-reduced-motion` kill switch** | F5DS is silent; an addition, not a deviation. |
| **`.info-box` class names** | Mandated below, and `migration-core.js` matches on `classList.contains('info-box')` to hide notes with their tables. |
| **`border-radius: 50%` ×5, and the step-number knockout ring** | A spinner and a 6px state dot cannot take a 4px corner; the ring is not an elevation. |
| **`Why Migrate?` keeps its `?`** | A genuine question serving as a section title. |
| **`scale()` on the checklist marker and scroll-to-top hover** | Kept by owner request in `1dab729`. |
| **Inline `code` 2px vertical padding** | F5DS publishes nothing for inline code; 4px inflates the line box in prose. |
| **`.approach-tab` `margin-bottom: -2px`** | Not spacing — it must equal the tab strip's 2px border so the active tab covers it. |

**Inferred, not published** — say so when touching these: table cell padding (F5DS has **no** table component), `.info-box` internal padding (screenshot-only in the spec), which elevation level a dropdown gets (only Toast=L1 is stated), heading case, and any spacing above 40px.

## Key Files

- `index.html` — **The live landing page** served via GitHub Pages. Hub page linking to all four projects/tools above. Styles/scripts live in `assets/css/{shared,index}.css` and `assets/js/{shared,index}.js`.
- `ingress-nginx-migration.html` — **The live migration tool** at `https://kubernetes.nginx.org/ingress-nginx-migration.html`. Interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, and ConfigMap migration guidance. Styles live in `assets/css/{shared,migration}.css`; scripts are `assets/js/shared.js` + `assets/js/migration-ingress-nginx.js` + `assets/js/migration-core.js` (in that order).

## Workflow

### Landing page (`index.html`)

- Now markup-only (~690 lines) — styles are in `assets/css/{shared,index}.css` and behavior in `assets/js/{shared,index}.js`. Edit the HTML for content/layout, the CSS/JS files for presentation/behavior.

### Migration tool (`ingress-nginx-migration.html`)

- The live migration tool is `ingress-nginx-migration.html`, linked from the landing page with a relative path (`href="ingress-nginx-migration.html"`) so the link resolves identically when opened locally, in PR previews, and in production. Do not change it to an absolute FQDN — that only works in production and breaks local testing.
- The page runs on the shared engine: the source module (`migration-ingress-nginx.js`) supplies mapping data + `parseInput`/`buildPlan`; `migration-core.js` owns rendering/nav/checklist. **The analyzer's mappings (`ANNOTATION_MAPPINGS` in the source module) and the static reference tables in the HTML must stay in agreement in both directions:** editing a mapping (or its generator) means updating the matching reference-table row — **including the example YAML in the expanded panel, which must match what the corresponding generator emits** — and editing a reference row whose construct the analyzer handles (there is a matching `ANNOTATION_MAPPINGS` entry) means updating the mapping/generator to match. **Exception:** reference rows for NIC-only features with no community equivalent (the left cell reads "No direct equivalent") have no analyzer counterpart, so editing them needs no JS change — e.g. the `apiKey` Policy row, since the community controller has no API-key annotation for the analyzer to map. A recurring bug is a hand-written example drifting from its still-correct generator; treat the generator as the source of truth and fix the example to match it.

#### Verifying analyzer changes (there is no build system or test suite)

The analyzer is pure data — the source module's `parseInput` → `buildPlan` returns a plain `MigrationPlan` object with no DOM. Test generator/mapping edits in Node by loading `assets/js/migration-ingress-nginx.js` + `assets/js/migration-core.js` under a hand-rolled `window`/`document` stub (its `createElement`/`getElementById`/etc. return a chainable no-op element) and calling `MIGRATION_SOURCE.analyzer.parseInput`/`buildPlan` on the sample presets. **Load-bearing gotcha:** `buildPlan` runs each generator in a `try/catch` that only `console.warn`s on failure, so a broken generator **silently drops its resource** from the output instead of throwing — capturing `console.warn` (count > 0, not a thrown exception) is the only way to detect it. `node --check` catches syntax only. Also sanity-check generated `k8s.nginx.org/v1` field names against the `json:` tags in `nginx/kubernetes-ingress/pkg/apis/configuration/v1/types.go` to catch invalid CRD fields.

Two more silent-failure paths worth knowing, both outside `buildPlan`: `renderPlan` `console.warn`s and skips any `block.type` it does not recognise (the type strings come from the source module, so they can drift on one side only), and the static comparison-block copy buttons attach through a bare `if (!h5 || !pre) return;` with no warning at all — changing `.comparison-block`, its `<h4>`, or the `<pre>` nesting silently removes all 344 of them.

#### Design-token invariant guards

The F5DS scanner (`~/.claude/skills/f5-product-ui-core/scripts/scan_ui_tokens.py`) is **not** a sufficient gate: it cannot resolve `var()`, so a correct `var(--space-2x)` is invisible to it while a literal `16px` counts as on-token. Its spacing and typography dimensions therefore read low *because* the site uses tokens. Use these greps instead — they inspect every value and are not fooled by indirection. Note the `(?<![\w-])` lookbehind: without it, `margin` matches inside `scroll-margin-top`.

```bash
# no 12px in any spacing property (F5DS excludes 12px from the system)
grep -rnE '(^|[^\w-])(padding|margin|gap|row-gap|column-gap|inset)[a-z-]*:[^;{}"]*\b12px' assets index.html ingress-nginx-migration.html
# no literal radius, and the pill token is 999 not 9999
grep -rn 'border-radius:[^;}"]*[0-9]px' assets index.html ingress-nginx-migration.html | grep -v '50%'
grep -rn '9999px' assets index.html ingress-nginx-migration.html      # only the off-screen clipboard trick
# elevation must come from --elev-*; no raw black shadow tints
grep -rnE 'box-shadow:[^;}"]*rgba\(0, *0, *0' assets index.html ingress-nginx-migration.html
# one focus idiom: outline, never a box-shadow ring
grep -rnE ':focus[^{]*\{[^}]*box-shadow' assets/css
# no literal font-size (4 sanctioned deviations only — see Typography)
grep -rnE "font-size: *[0-9]|fontSize *= *['\"][0-9]" assets index.html ingress-nginx-migration.html
grep -rn 'letter-spacing' assets index.html ingress-nginx-migration.html    # must stay 0 hits
# every spacing px a multiple of 4 (1px hairlines and the documented 2px excepted),
# and anything above 40px a multiple of 8
python3 -c "
import re, glob
P = r'(?<![\w-])(?:padding|margin|gap|row-gap|column-gap)[a-z-]*'
for f in glob.glob('assets/css/*.css'):
    for i, l in enumerate(open(f), 1):
        if l.lstrip().startswith(('/*', '*')): continue
        for m in re.finditer(P + r': *([^;}]+)', l):
            for px in re.findall(r'-?\d+px', m.group(1)):
                n = abs(int(px[:-2]))
                if n % 4 and n not in (1, 2): print(f'{f}:{i} off-grid {px}')
                if n > 40 and n % 8: print(f'{f}:{i} >40 not /8 {px}')
"
# class drift: every class written by HTML/JS must exist in the CSS
# (baseline: only the 'badge-' prefix hook is legitimately unresolved)
```

#### Migration tool ordering and structure rules

- **Annotation mapping rows** within each category table must be sorted alphabetically by the community annotation name (left column).
- **"No direct equivalent" rows** (NIC-only annotations) go at the end of their category table, after all community-to-NIC mappings.
- **NIC-only annotations must not be bundled** into community mapping rows. If an NIC annotation has no community equivalent, it gets its own "No direct equivalent" row — never grouped into an existing row that maps community annotations.
- **Within a single row**, when multiple annotations are listed on either side, they should be in alphabetical order.
- **Collapsed cells stay terse** — the always-visible mapping cells (both columns of a `tr.expandable`) show only badges + `<code>` + a short blurb (≤ ~6 words of prose, e.g. `No direct equivalent`, `Not applicable`, `No direct equivalent (use <code>basicAuth</code>)`). Never put a full explanatory sentence, caveat, or workaround in a collapsed cell. Any such explanation belongs in the expanded panel (`tr.example-row`) as an `info-box` banner: `info-box warning` for hard "no equivalent / no replacement" cases (bold lead-in like `<strong>No direct equivalent:</strong>`), `info-box note` for softer guidance. A `warning` added alongside an existing `note` precedes it.

## Shared UI Elements

The shared "chrome" lives in `assets/css/shared.css` and `assets/js/shared.js` as the single source of truth — **edit it once there**, not in two places. This covers:

- **Event banner** (Announcements) — the green fixed banner and its CSS (`.event-banner`, `body.has-banner` offsets). **Dormant, not dead:** it was live in markup from 2026-03-19 to 2026-04-07 carrying a conference announcement and was removed when that expired, so there is currently no banner element in either page and **no JS init** — it is pure CSS awaiting its next announcement. Re-enable it by adding the markup and `has-banner` to `<body>`; do not delete the CSS as unreferenced. (`.coming-soon-label` + `.btn-disabled` and `.version-pill.i2g` are dormant in the same way.)
- **Top bar** — the NGINX logo, GitHub link, and dark-mode toggle (CSS + dark-toggle wiring in `shared.js`)
- **Sidebar** — structure, external links, copyright, and the drawer open/close behavior (`shared.js`)
- **Dark mode** — design-token overrides and chrome (topbar/sidebar) colors in `shared.css`; the dark-mode toggle logic in `shared.js`

The HTML markup for these elements (the topbar/sidebar/banner DOM) is still present in both `index.html` and `ingress-nginx-migration.html` and must stay structurally in sync — the shared CSS/JS keys off shared IDs/classes (`#sidebar`, `#sidebarBackdrop`, `#menuToggle`, `#darkToggle`, `.topbar`, `.event-banner`, `#copyright-year`, `#page-announce`).

**Page-scoped exception — dark-mode content link colors:** dark-mode link colors (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in `index.css`, `.main-inner` in `migration.css`) and stay in the **per-page** CSS — never in `shared.css` and never global, or they override topbar/sidebar link colors.

## Hosting

- **Repository**: https://github.com/nginx/kubernetes.nginx.org
- **GitHub Pages**: https://kubernetes.nginx.org/ (serves `index.html` from `main` branch as the landing page)
- **Migration Tool**: https://kubernetes.nginx.org/ingress-nginx-migration.html

## Domain Concepts

- **Landing page**: The root `index.html` is a hub for the NGINX Kubernetes ecosystem — not just the migration tool
- **Gateway API**: The standard Kubernetes API for traffic management; NGINX Gateway Fabric is the NGINX implementation
- **Annotation prefixes**: Community uses `nginx.ingress.kubernetes.io/`, NGINX Ingress Controller uses `nginx.org/` (OSS) or `nginx.com/` (Plus)
- **CRDs**: NGINX Ingress Controller supports VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration
- **NGINX Plus**: Only the NGINX Ingress Controller supports Plus features (JWT, OIDC, WAF).
- **Naming**: Use "NGINX Ingress Controller" (not "Official NGINX Ingress Controller" or "NGINX Inc."). The community controller is referred to as the "community controller" or by its repo name `kubernetes/ingress-nginx`.

## Research Resources

When verifying information, use GitHub MCP tools to fetch from these authoritative sources:

**Community controller** (`kubernetes/ingress-nginx`):

- GitHub: https://github.com/kubernetes/ingress-nginx
- Docs tree: https://github.com/kubernetes/ingress-nginx/blob/main/docs
- Annotations: https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/nginx-configuration/annotations.md
- Docs site: https://kubernetes.github.io/ingress-nginx
- Published annotations: https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/

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

**Migration guide**: https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx

Prefer GitHub MCP tools over WebFetch for documentation sites.

## Version Accuracy

**Critical rule:** Every annotation, ConfigMap key, CRD field, or feature documented in the migration tool MUST exist in the version referenced by the tool's "Version Reference" banner. Before adding any NIC feature to the migration tool:

1. Check the version stated in the tool's Version Reference (e.g., "v5.4.1").
2. Verify the feature exists in that released version — use `mcp__github__get_file_contents` against the corresponding tag (e.g., `v5.4.1`) to confirm annotations/CRD fields exist in source code or docs.
3. Never document unreleased features, features from `main` branch that haven't been tagged, or features from future versions.

When bumping the referenced version, audit the release notes to identify genuinely new features and update accordingly — but do not pre-document features from versions that haven't shipped yet.

### Bidirectional accuracy (guard against staleness, not just fabrication)

The rule above catches **fabrication** (documenting something that doesn't exist). It does NOT catch **staleness** — describing a construct that *does* exist with outdated semantics, wrong defaults/status codes, or an incomplete field set. Both are accuracy failures, and staleness is the more dangerous because "does it exist?" checks pass right over it. When documenting or reviewing **any** construct (mapping row, generator, note), verify all four — against the tagged source in both repos, never from memory (adversarial intuition about these constructs is wrong roughly half the time):

1. **Exists** — the annotation/field exists in the pinned version (the rule above).
2. **Semantics match** — the behavior, status codes, defaults, and value formats the tool states match the pinned source. (E.g. the community `auth-signin` accepts a full URL, but NIC's externalAuth `authSigninURI` is a **relative** URI — CRD pattern `^/.*$` — so the tool must strip the scheme/host, not pass the URL through.)
3. **Complete** — the tool has not omitted fields/sub-options that exist in the pinned version and that a migrator would hit. (E.g. NIC's `accessControl` Policy is allow **xor** deny — validation requires *exactly one* of `allow`/`deny` — so a source rule needing both becomes two Policies; collapsing it into one silently drops half the intent.)
4. **NIC side checked both ways** — NIC-side claims are neither overstated (e.g. "no HTTP fallback-service field" when VirtualServer/VirtualServerRoute upstreams have `backup`/`backupPort`) nor understated, and any Plus-only NIC capability (e.g. `least_time`, ExternalName upstream services) is labeled as such.

### Release update checklist

When updating the sites for a new release, update **all** of the following.

**Kubernetes compatibility (applies to both NIC and NGF):** the compat tables always show the **latest 3 Kubernetes minor versions** (matches upstream's support window — verify via `kubernetes/kubernetes` releases), not the project's full supported range. Bump these alongside any release update if a newer K8s minor has shipped.

#### NGINX Ingress Controller (NIC) release

**`index.html`:**

- Version fallback text in `data-version="nic.release"` spans in `index.html` (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`) in `index.html`
- Helm chart version in `data-version="nic.helm"` spans and the Helm install command in `index.html`
- JS `VERSION_CONFIG` fallback values for `nic.release` and `nic.helm` — now in `assets/js/index.js`
- **Compatibility table** in the NIC section of `index.html` — update NGINX OSS version (check `NGINX_OSS_VERSION` in `build/Dockerfile` at the release tag) and Kubernetes versions if changed

**Migration tool:**

- Update the NIC target versions in the `MigrationTool.NIC` block at the **top of `assets/js/migration-core.js`** (`VERSION`, `HELM_VERSION` — the install commands and release URL derive from them). This is the single source of truth for the NIC side of the Version Reference banners, the standalone `kubectl apply` example, and the analyzer's CRD-install references on **every** migration page.
- Update the `INGRESS_NGINX_VERSION` constant at the **top of `assets/js/migration-ingress-nginx.js`** (source-controller side of the banner; the release link derives from it). Banner text and release-tag links are populated from these constants at `DOMContentLoaded` via `data-*` attributes. Note: `kubernetes/ingress-nginx` was archived (Mar 2026) and `controller-v1.15.1` is its final release, so this constant should not need bumping again.
- Update the static fallback text inside the `data-*-version` spans / `data-*-release-link` anchors in `ingress-nginx-migration.html` (so no-JS users see the correct version before the JS runs).

#### NGINX Gateway Fabric (NGF) release

**`index.html` only** (the migration tool does not reference NGF):

- Version fallback text in `data-version="ngf.release"` spans (sidebar, hero badge, Key Details)
- Release tag link in the hero badge (`href`)
- Helm chart version in `data-version="ngf.helm"` spans and the Helm install command
- JS `VERSION_CONFIG` fallback values for `ngf.release` and `ngf.helm` — now in `assets/js/index.js`
- **Compatibility table** in the NGF section — update NGINX OSS version (check the NGF release notes / README technical specs table) and Kubernetes versions if changed
- **Supported Resources** tag list — review against `apis/v1alpha1` and `apis/v1alpha2` at the release tag to catch any new CRDs (e.g. `WAFPolicy` was added in v2.6.0). Keep tags alphabetical within the NGF custom-resources block.
- **Gateway API version** in the "Fully Conformant Gateway API" pill and feature card copy (currently mentions v1.5.1) — update if the release bumps the conformant Gateway API version.
