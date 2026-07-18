# Security Policy

## Secret Handling

Never commit production secrets, real `.clasp.json` files, local `.env` files, service-account JSON, private candidate data, or scanned answer sheets.

Required production secrets should be configured outside Git:

- `RECOGNITION_API_KEY`
- `PDF_RENDER_KEY`
- `APP_ACCESS_PASSWORD`
- Google Cloud service-account credentials, when not provided by the runtime

Prefer Google Secret Manager or equivalent managed secret storage for deployments.

## Reporting Vulnerabilities

If you find a vulnerability, do not open a public issue with exploit details. Contact the maintainers privately with:

- A short description of the issue.
- The affected component (`web`, `scoring-api`, `ocr-api`, or `scoring-core`).
- Reproduction steps or a minimal proof of concept.
- Suggested impact and remediation, if known.

The maintainers should confirm receipt, assess impact, and publish a fix before public disclosure.

## Public Data Rules

Do not publish real candidate information, real answer sheets, Drive file IDs, API keys, signing secrets, or service-account material. Use synthetic fixtures only.
