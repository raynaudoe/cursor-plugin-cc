PLUGIN_DIR := plugins/cursor
TMPDIR ?= /tmp
NPM_CONFIG_CACHE ?= $(TMPDIR)/cursor-plugin-cc-npm-cache
PACK_DIR ?= $(TMPDIR)/cursor-plugin-pack
NODE ?= node

.PHONY: ci-test ci-quality ci-lint ci-coverage ci-guardrails ci-package-smoke

ci-test:
	cd $(PLUGIN_DIR) && NPM_CONFIG_CACHE="$(NPM_CONFIG_CACHE)" npm ci
	cd $(PLUGIN_DIR) && npm test

ci-quality: ci-lint ci-coverage ci-guardrails ci-package-smoke

ci-lint:
	cd $(PLUGIN_DIR) && NPM_CONFIG_CACHE="$(NPM_CONFIG_CACHE)" npm ci
	cd $(PLUGIN_DIR) && npm run lint

ci-coverage:
	cd $(PLUGIN_DIR) && npm run test:coverage

ci-guardrails:
	$(NODE) tools/ci/guardrails.mjs

ci-package-smoke:
	NPM_CONFIG_CACHE="$(NPM_CONFIG_CACHE)" PACK_DIR="$(PACK_DIR)" NODE="$(NODE)" bash tools/ci/package-smoke.sh
