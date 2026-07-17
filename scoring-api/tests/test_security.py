import pytest

from src.security import authorize
from src.wire import ApiError


@pytest.mark.parametrize(
    "action",
    [
        "listCandidateDocuments",
        "uploadCandidateDocument",
        "deleteCandidateDocument",
    ],
)
def test_candidate_document_actions_allow_operator(action):
    authorize(action, "operator")


def test_candidate_document_actions_reject_unknown_roles():
    with pytest.raises(ApiError) as error:
        authorize("listCandidateDocuments", "unknown")

    assert error.value.code == "forbidden"
