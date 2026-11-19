.DEFAULT_GOAL := help
.PHONY: help install test test-worker test-py lint integration check-public hooks release

help:  ## list targets
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | column -t -s "$$(printf '\t')"

install:  ## one-time: worker dependencies and the Python test environment
	cd worker && npm ci
	uv sync

test: test-worker test-py check-public  ## everything that needs no network and no wrangler (includes the public-tree scan)

test-worker:  ## worker: node:test + typecheck
	cd worker && npm test && npm run -s typecheck

test-py:  ## Mac side: pytest (fake worker, fake claude)
	uv run pytest -q --ignore=tests/integration

lint:  ## ruff over the Python side
	uv run ruff check .

integration:  ## the real worker (wrangler dev --local, fresh local D1) + a Telegram stub + the Mac scripts. One wrangler process only
	INTEGRATION=1 uv run pytest tests/integration -q -p no:cacheprovider

check-public:  ## scan the tree for ids, hosts, keys and your own patterns (PULT_SCRUB_FILE, default ~/.config/pult/scrub-patterns.txt); H=1 adds git history
	scripts/check-public.sh $(if $(H),--history,)

hooks:  ## install the pre-commit hook that runs check-public
	ln -sf ../../scripts/pre-commit .git/hooks/pre-commit

release:  ## V=0.2.0: tests, scan, then an annotated tag (CHANGELOG.md must have a section for it). No push.
	@test -n "$(V)" || { echo "usage: make release V=x.y.z"; exit 2; }
	@grep -q "^## $(V) " CHANGELOG.md || { echo "CHANGELOG.md has no '## $(V) ' section"; exit 1; }
	$(MAKE) test lint
	$(MAKE) check-public H=1
	git tag -a v$(V) -m "pult $(V)"
	@echo "tagged v$(V); push it with: git push origin main v$(V)"
