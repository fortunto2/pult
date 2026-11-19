.DEFAULT_GOAL := help
.PHONY: help install test test-worker test-py lint integration

help:  ## list targets
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | column -t -s "$$(printf '\t')"

install:  ## one-time: worker dependencies and the Python test environment
	cd worker && npm ci
	uv sync

test: test-worker test-py  ## everything that needs no network and no wrangler

test-worker:  ## worker: node:test + typecheck
	cd worker && npm test && npm run -s typecheck

test-py:  ## Mac side: pytest (fake worker, fake claude)
	uv run pytest -q --ignore=tests/integration

lint:  ## ruff over the Python side
	uv run ruff check .

integration:  ## the real worker (wrangler dev --local, fresh local D1) + a Telegram stub + the Mac scripts. One wrangler process only
	INTEGRATION=1 uv run pytest tests/integration -q -p no:cacheprovider
