import hmac

import pytest

from src.wire import (
    ApiError,
    assert_audience_and_action,
    canonical_json,
    parse_envelope,
    sign_envelope,
    signing_input,
    verify_signature,
)


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
        "aud": "scoring-api",
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
        == '{"action":"saveCells","aud":"scoring-api","iss":"cf-functions","nonce":"0123456789abcdef0123456789abcdef","operationId":"op-123","operator":"reviewer@example.com","role":"unknown","ts":1710000000}.{"candidateId":"cand-1","cells":{"s01":3,"s02":0},"operationId":"op-123"}'
    )
    assert (
        sign_envelope(claims, payload, "dummy-secret")
        == "sha256=c48ac7aeab5f3ee18be8efb56ab415018858a4903453894d85bb87e5876ee347"
    )
    verify_signature(claims, payload, "dummy-secret", sign_envelope(claims, payload, "dummy-secret"))


def test_signature_rejects_mismatch():
    claims = {"aud": "scoring-api", "ts": 1}
    payload = {"b": 2}

    try:
        verify_signature(claims, payload, "dummy-secret", "sha256=bad")
    except Exception as error:
        assert getattr(error, "code") == "unauthorized"
    else:
        raise AssertionError("expected unauthorized")


def test_parse_envelope_defaults_payload_to_object():
    claims, payload = parse_envelope({"claims": {"aud": "scoring-api"}})

    assert claims == {"aud": "scoring-api"}
    assert payload == {}


def test_legacy_audience_is_accepted_during_rolling_migration():
    action, operation_id = assert_audience_and_action(
        {"aud": "gas-api", "action": "getResult"}, {}, ""
    )

    assert action == "getResult"
    assert operation_id == ""


def test_candidate_document_actions_are_part_of_the_signed_action_contract():
    upload_operation_id_value = "11111111-1111-4111-8111-111111111111"
    list_action, list_operation_id = assert_audience_and_action(
        {"aud": "scoring-api", "action": "listCandidateDocuments"},
        {"candidateId": "cand-1"},
        "",
    )
    upload_action, upload_operation_id = assert_audience_and_action(
        {
            "aud": "scoring-api",
            "action": "uploadCandidateDocument",
            "operationId": upload_operation_id_value,
        },
        {"candidateId": "cand-1"},
        "",
    )
    delete_action, delete_operation_id = assert_audience_and_action(
        {
            "aud": "scoring-api",
            "action": "deleteCandidateDocument",
            "operationId": "op-delete",
        },
        {"candidateId": "cand-1"},
        "",
    )

    assert (list_action, list_operation_id) == ("listCandidateDocuments", "")
    assert (upload_action, upload_operation_id) == (
        "uploadCandidateDocument",
        upload_operation_id_value,
    )
    assert (delete_action, delete_operation_id) == ("deleteCandidateDocument", "op-delete")


@pytest.mark.parametrize("action", ["uploadCandidateDocument", "deleteCandidateDocument"])
def test_candidate_document_writes_require_operation_id(action):
    with pytest.raises(ApiError) as error:
        assert_audience_and_action(
            {"aud": "scoring-api", "action": action},
            {"candidateId": "cand-1"},
            "",
        )

    assert error.value.code == "validation"
    assert error.value.message == "operationId is required"


def test_candidate_document_upload_requires_uuid_operation_id():
    with pytest.raises(ApiError) as error:
        assert_audience_and_action(
            {
                "aud": "scoring-api",
                "action": "uploadCandidateDocument",
                "operationId": "not-a-uuid",
            },
            {"candidateId": "cand-1"},
            "",
        )

    assert error.value.code == "validation"
    assert error.value.message == "uploadCandidateDocument operationId must be a UUID"
