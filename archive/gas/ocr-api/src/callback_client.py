"""GAS WebアプリのWebhookへ認識結果を返す。"""

import hashlib
import hmac
import json
import logging
import os
import time
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests

logger = logging.getLogger(__name__)

CALLBACK_TIMEOUT_SECONDS = 120
CALLBACK_URL_ENV = "RECOGNITION_CALLBACK_URL"
CALLBACK_ALLOWED_HOSTS_ENV = "RECOGNITION_CALLBACK_ALLOWED_HOSTS"
SIGNATURE_QUERY_PARAM = "cheqSignature"
TIMESTAMP_QUERY_PARAM = "cheqTimestamp"


class CallbackError(Exception):
    pass


class CallbackValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _split_csv(value: str) -> set[str]:
    return {item.strip().lower().rstrip(".") for item in value.split(",") if item.strip()}


def _allowed_callback_hosts() -> set[str]:
    return _split_csv(os.environ.get(CALLBACK_ALLOWED_HOSTS_ENV, ""))


def _validate_callback_url(url: str, allowed_hosts: set[str] | None) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise CallbackValidationError("callback_url_not_https", "callback URL must use HTTPS")
    if not parsed.hostname:
        raise CallbackValidationError("callback_url_missing_host", "callback URL must include a host")
    if parsed.username or parsed.password:
        raise CallbackValidationError(
            "callback_url_has_credentials", "callback URL must not include credentials"
        )

    host = parsed.hostname.lower().rstrip(".")
    if allowed_hosts is not None and host not in allowed_hosts:
        raise CallbackValidationError(
            "callback_host_not_allowed", f"callback host is not allowed: {host}"
        )
    return url


def resolve_callback_url(requested_callback_url: str | None) -> str:
    """Return the callback URL after applying server-side config and validation."""
    allowed_hosts = _allowed_callback_hosts()
    configured_url = os.environ.get(CALLBACK_URL_ENV, "").strip()
    if configured_url:
        return _validate_callback_url(configured_url, allowed_hosts or None)

    if not requested_callback_url:
        raise CallbackValidationError("callback_url_missing", "callback URL is required")
    if not allowed_hosts:
        raise CallbackValidationError(
            "callback_allowlist_missing",
            f"{CALLBACK_ALLOWED_HOSTS_ENV} is required when callback URL is request-supplied",
        )
    return _validate_callback_url(requested_callback_url, allowed_hosts)


def _signed_url(callback_url: str, secret: str, body: bytes) -> str:
    """Add GAS-readable HMAC proof to the URL.

    Apps Script web apps expose query parameters and raw postData, but not custom
    request headers. Keep the secret out of the JSON body and sign the raw body.
    """
    timestamp = str(int(time.time()))
    signing_input = timestamp.encode("ascii") + b"." + body
    digest = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).hexdigest()
    parsed = urlparse(callback_url)
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key not in {SIGNATURE_QUERY_PARAM, TIMESTAMP_QUERY_PARAM}
    ]
    query.extend(
        [
            (TIMESTAMP_QUERY_PARAM, timestamp),
            (SIGNATURE_QUERY_PARAM, f"sha256={digest}"),
        ]
    )
    return urlunparse(parsed._replace(query=urlencode(query)))


def post_recognition_result(callback_url: str, candidate_id: str, recognition: dict) -> dict:
    """recognitionResult をGASへPOSTする。

    GAS WebアプリはエラーでもHTTP 200を返すため、レスポンスボディの ok を確認する。
    """
    callback_url = resolve_callback_url(callback_url)
    secret = os.environ.get("RECOGNITION_WEBHOOK_SECRET", "")
    if not secret:
        raise CallbackError("RECOGNITION_WEBHOOK_SECRET is not set")

    payload = {
        "action": "recognitionResult",
        "candidateId": candidate_id,
        "recognition": recognition,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signed_url = _signed_url(callback_url, secret, body)
    # script.google.com はPOST後に302でレスポンス取得用URLへ転送する
    response = requests.post(
        signed_url,
        data=body,
        headers={"Content-Type": "application/json"},
        timeout=CALLBACK_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    try:
        body = response.json()
    except ValueError as error:
        raise CallbackError(f"GAS webhook returned non-JSON response: {response.text[:500]}") from error

    if not body.get("ok"):
        raise CallbackError(f"GAS webhook rejected the result: {body.get('error', body)}")

    logger.info("callback delivered: candidateId=%s", candidate_id)
    return body
