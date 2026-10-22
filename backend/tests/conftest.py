"""All backend checks here are offline; unmocked socket traffic fails the test."""
import socket
import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Unmocked network traffic forbidden in local checks")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
