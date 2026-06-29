import hmac

from src.wire import canonical_json, parse_envelope, sign_envelope, signing_input, verify_signature


def test_canonical_json_matches_sign_ts_contract():
    value = {
        "z": [3, {"b": True, "a": None}],
        "a": "x",
        "n": 12,
        "nested": {"y": "yes", "x": [1, 2]},
    }

    assert (
        canonical_json(value)
        == '{"a":"x","n":12,"nested":{"x":[1,2],"y":"yes"},"z":[3,{"a":null,"b":true}]}'
    )


def test_signature_fixed_vector():
    claims = {
        "iss": "cf-functions",
        "aud": "gas-api",
        "action": "saveCells",
        "operator": "reviewer@example.com",
        "role": "unknown",
        "operationId": "op-123",
        "ts": 1710000000,
        "nonce": "0123456789abcdef0123456789abcdef",
    }
    payload = {
        "candidateId": "cand-1",
        "operationId": "op-123",
        "cells": {"s02": 0, "s01": 3},
    }

    assert (
        signing_input(claims, payload)
        == '{"action":"saveCells","aud":"gas-api","iss":"cf-functions","nonce":"0123456789abcdef0123456789abcdef","operationId":"op-123","operator":"reviewer@example.com","role":"unknown","ts":1710000000}.{"candidateId":"cand-1","cells":{"s01":3,"s02":0},"operationId":"op-123"}'
    )
    assert (
        sign_envelope(claims, payload, "dummy-secret")
        == "sha256=4fd8d192f91ba6c15211a8badb222251c20bbc70f4a31f1a47de00f980c86519"
    )
    verify_signature(claims, payload, "dummy-secret", sign_envelope(claims, payload, "dummy-secret"))


def test_signature_rejects_mismatch():
    claims = {"aud": "gas-api", "ts": 1}
    payload = {"b": 2}

    try:
        verify_signature(claims, payload, "dummy-secret", "sha256=bad")
    except Exception as error:
        assert getattr(error, "code") == "unauthorized"
    else:
        raise AssertionError("expected unauthorized")


def test_parse_envelope_defaults_payload_to_object():
    claims, payload = parse_envelope({"claims": {"aud": "gas-api"}})

    assert claims == {"aud": "gas-api"}
    assert payload == {}
