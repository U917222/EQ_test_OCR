.PHONY: help test deploy

help:
	@echo "scoring-api targets:"
	@echo "  make test     - run pytest"
	@echo "  make deploy   - deploy to Cloud Run (asia-northeast1)"

test:
	cd $(CURDIR) && uv run pytest

deploy:
	cd $(CURDIR) && gcloud run deploy scoring-api \
		--source . \
		--region asia-northeast1
