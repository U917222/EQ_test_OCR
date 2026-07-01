.PHONY: help test deploy

help:
	@echo "ocr-api targets:"
	@echo "  make test     - run pytest"
	@echo "  make deploy   - deploy to Cloud Run (asia-northeast1)"

test:
	cd $(CURDIR) && uv run pytest

deploy:
	cd $(CURDIR) && gcloud run deploy ocr-api \
		--source . \
		--region asia-northeast1
