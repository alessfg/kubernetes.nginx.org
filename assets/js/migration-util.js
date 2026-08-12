/* migration-util.js — the migration tool's data-transformation layer.
   =========================================================================
   CARRIED VERBATIM through the rebuild. Every function here is a pure string
   transformation with no DOM access, and the source module
   (migration-ingress-nginx.js) calls them while generating YAML. Their exact
   behaviour — including which characters get neutralised and how a multi-line
   value becomes a block scalar — is part of the contract the ~340 mapping
   entries were written against. Reimplementing them would risk changing the
   generated output in ways no test here would catch.

   It lives in its own file, separate from migration-core.js, so the boundary
   between what was carried and what was rewritten is visible rather than
   buried inside one file.

   Load order on the migration page:
     chrome.js -> migration-util.js -> migration-<source>.js -> migration-core.js

   The source module dereferences MigrationTool only inside function bodies
   (at call time, never at load time), so it tolerates loading before or after
   this file. migration-core.js reads window.MIGRATION_SOURCE at top level and
   must therefore load last.
   ========================================================================= */
'use strict';

(function () {
    /* Single source of truth for the F5 NGINX Ingress Controller versions —
       the migration TARGET — that the tool is documented against. Bump these
       when updating the Version Reference; see the release checklist in
       CLAUDE.md. The SOURCE controller's version lives at the top of its own
       migration-<source>.js. */
    var NIC = {
        VERSION: 'v5.5.4',
        HELM_VERSION: '2.6.4'
    };
    NIC.CRD_INSTALL_CMD = 'kubectl apply -f https://raw.githubusercontent.com/nginx/kubernetes-ingress/'
        + NIC.VERSION + '/deploy/crds.yaml';
    NIC.HELM_INSTALL_CMD = 'helm install nginx-ingress oci://ghcr.io/nginx/charts/nginx-ingress --version '
        + NIC.HELM_VERSION + ' --set controller.enableCustomResources=true';
    NIC.RELEASE_URL = 'https://github.com/nginx/kubernetes-ingress/releases/tag/' + NIC.VERSION;

    /* Strip a trailing inline "# comment" from a YAML scalar, honouring quotes
       (a '#' only begins a comment at the start of the value or after
       whitespace). */
    function stripInlineComment(s) {
        var inSingle = false, inDouble = false;
        for (var k = 0; k < s.length; k++) {
            var c = s[k];
            if (c === '"' && !inSingle) { inDouble = !inDouble; }
            else if (c === "'" && !inDouble) { inSingle = !inSingle; }
            else if (c === '#' && !inSingle && !inDouble && (k === 0 || /\s/.test(s[k - 1]))) {
                return s.slice(0, k);
            }
        }
        return s;
    }

    /* Values interpolated into generated nginx directives come straight from
       the pasted YAML — neutralise characters that could terminate or extend
       the directive (newlines, ';', '{', '}', a quote-breaking '"', and a
       trailing backslash that would eat the closing quote). Legitimate values
       for these directives use none of them. */
    function sanitizeSnippetValue(value) {
        return String(value)
            .replace(/[\r\n;{}]+/g, ' ')
            .replace(/"/g, '\\"')
            .replace(/\\+$/, '')
            .trim();
    }

    function formatYamlKV(indent, key, value) {
        if (value == null) { value = ''; }
        /* Drop an optional leading "|\n" block-scalar marker that callers prepend. */
        var body = value.indexOf('|\\n') === 0 ? value.substring(3) : value;
        /* Treat both the literal "\n" marker and real newline characters as
           line breaks, so multi-line snippet values always render as a valid,
           indented YAML block scalar (single-line values stay quoted). */
        var lines = body.split(/\\n|\n/);
        if (value.indexOf('|\\n') === 0 || lines.length > 1) {
            return indent + key + ': |\n' + lines.map(function (l) {
                return indent + '  ' + l.trim();
            }).join('\n');
        }
        var escaped = body ? body.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : body;
        return indent + key + ': "' + escaped + '"';
    }

    /* Normalise CRLF/CR and split a manifest into YAML documents. */
    function splitDocuments(yamlText) {
        return yamlText.replace(/\r\n?/g, '\n').split(/^---\s*$/m);
    }

    /* Detect syntax the analyzer does not fully parse and surface it, so a
       confusing "no findings" result has a clear cause. Source-specific checks
       (e.g. multiple Ingress hosts) live in the source module's parseInput. */
    function detectGenericSyntaxWarnings(yamlText) {
        var warnings = [];
        /* Kustomize: commonAnnotations is applied at build time, not inline. */
        if (/^kind:\s*Kustomization\b/m.test(yamlText) || /^commonAnnotations:\s*$/m.test(yamlText)) {
            warnings.push({
                title: 'Kustomize manifest detected',
                message: 'This tool reads inline annotations on Ingress resources. Run `kustomize build` first and paste the rendered Ingress output.'
            });
        }
        /* YAML anchors and aliases are not expanded, so referenced annotations
           would be silently dropped. */
        if (/(^|\s)&[A-Za-z0-9_-]+/m.test(yamlText) || /(:\s|^\s*-\s*)\*[A-Za-z0-9_-]+/m.test(yamlText)) {
            warnings.push({
                title: 'YAML anchors or aliases detected',
                message: 'The analyzer does not expand `&anchor` / `*alias` references. Resolve them (or paste the rendered manifest) for accurate results.'
            });
        }
        /* Helm templates also need pre-rendering. */
        if (/\{\{[^}]+\}\}/.test(yamlText)) {
            warnings.push({
                title: 'Helm template syntax detected',
                message: '`{{ ... }}` placeholders are not evaluated. Run `helm template` and paste the rendered output.'
            });
        }
        return warnings;
    }

    /* Inject "  # <source-name>" comments into generated YAML so each line can
       be traced back to the finding it came from. Two passes: value-based
       matching, then field-name matching for whatever is still unmatched. */
    function annotateYamlWithSources(yaml, foundAnnotations) {
        var crdYamlLines = yaml.split('\n');
        var usedAnnotations = {};

        /* First pass: value-based matching. */
        var annotatedLines = crdYamlLines.map(function (line) {
            if (/^\s*#/.test(line) || /^(apiVersion|kind|metadata|spec):/.test(line.trim())) { return line; }
            var nameCheck = line.match(/^(\s+)name:\s/);
            if (nameCheck && nameCheck[1].length <= 4) { return line; }
            var kvMatch = line.match(/^(\s+\S+:\s*)(.+)$/);
            if (!kvMatch) { return line; }
            var lineVal = kvMatch[2].replace(/^["']|["']$/g, '').trim();
            var matched = null;
            foundAnnotations.forEach(function (a) {
                if (matched) { return; }
                if (usedAnnotations[a.annotation]) { return; }
                var v = a.value != null ? String(a.value) : '';
                var cleaned = v.replace(/^[^/]+\//, '');
                if (lineVal && (lineVal === v || lineVal === cleaned
                        || v.indexOf(lineVal) !== -1 || lineVal.indexOf(cleaned) !== -1)) {
                    matched = a.annotation;
                }
                /* Boolean transforms: on/off -> true/false */
                if (!matched && ((v === 'on' && lineVal === 'true') || (v === 'off' && lineVal === 'false'))) {
                    matched = a.annotation;
                }
            });
            if (matched) {
                usedAnnotations[matched] = true;
                return line + '  # ' + matched;
            }
            return line;
        });

        /* Second pass: field-name matching for annotations still unmatched. */
        var unmatched = foundAnnotations.filter(function (a) {
            return !usedAnnotations[a.annotation];
        });
        if (unmatched.length > 0) {
            annotatedLines = annotatedLines.map(function (line) {
                if (/  # \S/.test(line)) { return line; }
                if (/^\s*#/.test(line) || /^(apiVersion|kind|metadata|spec):/.test(line.trim())) { return line; }
                var nameCheck = line.match(/^(\s+)name:\s/);
                if (nameCheck && nameCheck[1].length <= 4) { return line; }
                var keyMatch = line.match(/^\s+(\S+):/);
                if (!keyMatch) { return line; }
                /* Normalise camelCase to hyphenated: sessionCookie -> session-cookie */
                var fieldKey = keyMatch[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
                var matched = null;
                unmatched.forEach(function (a) {
                    if (matched) { return; }
                    if (usedAnnotations[a.annotation]) { return; }
                    var parts = a.annotation.toLowerCase().split('-');
                    var last1 = parts[parts.length - 1];
                    var last2 = parts.length >= 2 ? parts.slice(-2).join('-') : '';
                    /* Match the last segment (min 3 chars) or the last two. */
                    if ((last1.length > 2 && fieldKey === last1) || (last2 && fieldKey === last2)) {
                        matched = a.annotation;
                    }
                    /* For key-only lines, check whether the value appears in the field name. */
                    if (!matched && /:\s*$/.test(line)) {
                        var v = a.value != null ? String(a.value).toLowerCase() : '';
                        if (v.length > 3 && fieldKey.indexOf(v) !== -1) {
                            matched = a.annotation;
                        }
                    }
                });
                if (matched) {
                    usedAnnotations[matched] = true;
                    return line + '  # ' + matched;
                }
                return line;
            });
        }
        return annotatedLines.join('\n');
    }

    window.MigrationTool = {
        NIC: NIC,
        util: {
            splitDocuments: splitDocuments,
            stripInlineComment: stripInlineComment,
            sanitizeSnippetValue: sanitizeSnippetValue,
            formatYamlKV: formatYamlKV,
            detectGenericSyntaxWarnings: detectGenericSyntaxWarnings,
            annotateYamlWithSources: annotateYamlWithSources
        }
    };
}());
