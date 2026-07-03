
# Changelog

This is a documentation-only site; entries track notable content and tooling updates rather than versioned software releases. The product versions referenced on the site (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway) are kept current as upstream releases ship.

## 1.1.0 (July 3, 2026)

- Traefik migration tool (`traefik-migration.html`) — interactive analyzer for Traefik resources (IngressRoute, Middleware, TraefikService, TCP/UDP routes), mappings for all 24 OSS HTTP middlewares and the Traefik Ingress annotations, TLS/cert-manager guidance, and static-configuration translation. Documented against Traefik v3.7.6 and NGINX Ingress Controller v5.5.1.
- The migration tools now share one engine: `assets/js/migration-core.js` plus a per-source module (`migration-ingress-nginx.js`, `migration-traefik.js`).

## 1.0.0 (March 4, 2026)

Initial release of the NGINX on Kubernetes site:

- Landing page (`index.html`) — hub for the NGINX Kubernetes ecosystem (NGINX Ingress Controller, NGINX Gateway Fabric, ingress2gateway, and the migration tool).
- NGINX Ingress migration tool (`ingress-nginx-migration.html`) — interactive YAML analyzer, 130+ annotation mappings, CRD migration examples, and ConfigMap migration guidance.
