# Hugo build for kubernetes.nginx.org (fork). Mirrors nginx/documentation targets.
# Requires Hugo Extended (>= 0.151; CI pins 0.152.2) and Go (for Hugo Modules).

HUGO ?= hugo
THEME_MODULE = github.com/nginxinc/nginx-hugo-theme/v2

.PHONY: help docs watch drafts clean hugo-get hugo-tidy hugo-update

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

docs: ## Production build to ./public
	$(HUGO) --minify --gc -e production

watch: ## Local dev server at http://localhost:1313
	$(HUGO) --bind 0.0.0.0 -p 1313 server --disableFastRender

drafts: ## Local dev server including draft content
	$(HUGO) --bind 0.0.0.0 -p 1313 server -D --disableFastRender

clean: ## Remove the build output
	[ -d "public" ] && rm -rf "public" || true

hugo-get: ## Update the theme module to the latest version
	$(HUGO) mod get -u $(THEME_MODULE)

hugo-tidy: ## Tidy Hugo modules
	$(HUGO) mod tidy

hugo-update: hugo-get hugo-tidy ## Update + tidy modules
