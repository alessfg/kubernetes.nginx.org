
# Changelog

This is a documentation-only site; entries track notable content and tooling updates rather than versioned software releases. The product versions referenced on the site (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway) are kept current as upstream releases ship.

## 1.1.0 (July 7, 2026)

- HAProxy migration tool (`haproxy-migration.html`) — interactive analyzer for HAProxy Kubernetes Ingress Controller resources (annotated Ingress/Service objects, the controller ConfigMap including tcp-services, and the Global/Defaults/Backend/Frontend/TCP custom resources in both API groups), 80+ annotation mappings, controller-flag and CRD-field tables, and route-acl canary translation. Documented against HAProxy Kubernetes Ingress Controller v3.2.12 and NGINX Ingress Controller v5.5.1.
- The migration tools now share one engine: `assets/js/migration-core.js` plus a per-source module (`migration-ingress-nginx.js`, `migration-haproxy.js`).

## 1.0.0 (March 4, 2026)

Initial release of the NGINX on Kubernetes site:

- Landing page (`index.html`) — hub for the NGINX Kubernetes ecosystem (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway, and the migration tool).
- NGINX Ingress migration tool (`ingress-nginx-migration.html`) — interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, and ConfigMap migration guidance.
