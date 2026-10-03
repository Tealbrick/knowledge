"""Fixture-only socket guard; loaded by the native runner, never production."""
import ipaddress
import socket


def allowed(host):
    if host in ("localhost", "127.0.0.1", "::1", None):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except (ValueError, TypeError):
        return False


def check_address(address):
    if not isinstance(address, tuple) or not allowed(address[0]):
        raise OSError("fixture_non_loopback_network_denied")


original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
original_getaddrinfo = socket.getaddrinfo


def connect(self, address):
    check_address(address)
    return original_connect(self, address)


def connect_ex(self, address):
    check_address(address)
    return original_connect_ex(self, address)


def getaddrinfo(host, *args, **kwargs):
    if not allowed(host):
        raise OSError("fixture_non_loopback_dns_denied")
    return original_getaddrinfo(host, *args, **kwargs)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = getaddrinfo
