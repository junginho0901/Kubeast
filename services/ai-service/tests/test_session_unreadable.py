"""A chat route that checks its caller itself keeps the status of a session that could not be checked: 503, which the
console does not read as signed out, not the 401 that signs it out."""
import pytest
from fastapi import HTTPException

from app import api as api_module


async def test_a_caller_whose_session_cannot_be_checked_gets_503_not_401(monkeypatch):
    def unreadable(_token):
        raise HTTPException(status_code=503, detail="Session could not be checked; try again", headers={"Retry-After": "5"})

    monkeypatch.setattr(api_module, "decode_access_token", unreadable)
    with pytest.raises(HTTPException) as refused:
        await api_module._authorize_session_access("Bearer tok", "s1")
    assert (refused.value.status_code, refused.value.headers) == (503, {"Retry-After": "5"})


async def test_a_token_that_does_not_stand_is_still_401(monkeypatch):
    def revoked(_token):
        raise HTTPException(status_code=401, detail="Token revoked")

    def broken(_token):
        raise ValueError("not a token")

    for decode, detail in ((revoked, "Token revoked"), (broken, "Invalid token")):
        monkeypatch.setattr(api_module, "decode_access_token", decode)
        with pytest.raises(HTTPException) as refused:
            await api_module._authorize_session_access("Bearer tok", "s1")
        assert (refused.value.status_code, refused.value.detail) == (401, detail)
