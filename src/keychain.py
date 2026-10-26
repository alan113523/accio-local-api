"""Store this bridge's own OAuth grant in the macOS login Keychain.

Payloads travel through stdin/stdout pipes, never command-line arguments.
Existing Accio Keychain items and authentication files are never opened.
"""
import ctypes as c
import sys

sec = c.CDLL('/System/Library/Frameworks/Security.framework/Security')
core = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
service = b'com.local.accio-api.oauth'
account = b'primary'
sec.SecKeychainFindGenericPassword.argtypes = [c.c_void_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_char_p, c.POINTER(c.c_uint32), c.POINTER(c.c_void_p), c.POINTER(c.c_void_p)]
sec.SecKeychainFindGenericPassword.restype = c.c_int32
sec.SecKeychainAddGenericPassword.argtypes = [c.c_void_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_void_p, c.POINTER(c.c_void_p)]
sec.SecKeychainAddGenericPassword.restype = c.c_int32
sec.SecKeychainItemModifyAttributesAndData.argtypes = [c.c_void_p, c.c_void_p, c.c_uint32, c.c_void_p]
sec.SecKeychainItemModifyAttributesAndData.restype = c.c_int32
sec.SecKeychainItemFreeContent.argtypes = [c.c_void_p, c.c_void_p]
core.CFRelease.argtypes = [c.c_void_p]

def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action not in ('get', 'put'):
        return 2
    length, data, item = c.c_uint32(), c.c_void_p(), c.c_void_p()
    status = sec.SecKeychainFindGenericPassword(None, len(service), service, len(account), account, c.byref(length), c.byref(data), c.byref(item))
    try:
        if action == 'get':
            if status == -25300:
                sys.stdout.write('null')
                return 0
            if status:
                return 1
            sys.stdout.buffer.write(c.string_at(data, length.value))
            return 0
        payload = sys.stdin.buffer.read(65537)
        if not payload or len(payload) > 65536:
            return 2
        buf = c.create_string_buffer(payload)
        if status == 0:
            status = sec.SecKeychainItemModifyAttributesAndData(item, None, len(payload), buf)
        elif status == -25300:
            status = sec.SecKeychainAddGenericPassword(None, len(service), service, len(account), account, len(payload), buf, None)
        return 0 if status == 0 else 1
    finally:
        if data.value:
            sec.SecKeychainItemFreeContent(None, data)
        if item.value:
            core.CFRelease(item)

if __name__ == '__main__':
    sys.exit(main())
