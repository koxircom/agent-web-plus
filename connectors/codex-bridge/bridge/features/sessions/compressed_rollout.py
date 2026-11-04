"""Read compressed old rollouts without changing Codex-owned history files."""
import ctypes
import ctypes.util
import tempfile
from contextlib import contextmanager, nullcontext
from pathlib import Path

MAX_EXPANDED_BYTES = 1024 * 1024 * 1024


def resolve_rollout_path(value):
    path = Path(value)
    if path.exists():
        return path
    if path.suffix == '.jsonl':
        compressed = path.with_name(path.name + '.zst')
        if compressed.exists():
            return compressed
    return path


class _Buffer(ctypes.Structure):
    _fields_ = [('data', ctypes.c_void_p), ('size', ctypes.c_size_t), ('pos', ctypes.c_size_t)]


def iter_zstd_chunks(source):
    library = ctypes.util.find_library('zstd')
    if not library:
        raise ValueError('读取压缩历史需要系统 Zstandard 库')
    zstd = ctypes.CDLL(library)
    zstd.ZSTD_createDStream.restype = ctypes.c_void_p
    zstd.ZSTD_initDStream.argtypes = [ctypes.c_void_p]
    zstd.ZSTD_initDStream.restype = ctypes.c_size_t
    zstd.ZSTD_decompressStream.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Buffer), ctypes.POINTER(_Buffer)]
    zstd.ZSTD_decompressStream.restype = ctypes.c_size_t
    zstd.ZSTD_isError.argtypes = [ctypes.c_size_t]
    zstd.ZSTD_isError.restype = ctypes.c_uint
    zstd.ZSTD_freeDStream.argtypes = [ctypes.c_void_p]
    decoder = zstd.ZSTD_createDStream()
    if not decoder:
        raise ValueError('无法初始化压缩历史读取器')
    try:
        if zstd.ZSTD_isError(zstd.ZSTD_initDStream(decoder)):
            raise ValueError('无法初始化压缩历史读取器')
        remaining = 1
        while chunk := source.read(131072):
            source_buffer = ctypes.create_string_buffer(chunk)
            incoming = _Buffer(ctypes.addressof(source_buffer), len(chunk), 0)
            while incoming.pos < incoming.size:
                output_buffer = ctypes.create_string_buffer(131072)
                outgoing = _Buffer(ctypes.addressof(output_buffer), len(output_buffer), 0)
                before = incoming.pos
                remaining = zstd.ZSTD_decompressStream(decoder, ctypes.byref(outgoing), ctypes.byref(incoming))
                if zstd.ZSTD_isError(remaining) or (incoming.pos == before and not outgoing.pos):
                    raise ValueError('压缩历史损坏，无法读取')
                if outgoing.pos:
                    yield output_buffer.raw[:outgoing.pos]
        if remaining != 0:
            raise ValueError('压缩历史不完整，无法读取')
    finally:
        zstd.ZSTD_freeDStream(decoder)


@contextmanager
def open_rollout(path, *, source=None):
    if getattr(path, 'suffix', '') != '.zst':
        with (nullcontext(source) if source is not None else path.open('rb')) as stream:
            yield stream
        return
    with (nullcontext(source) if source is not None else path.open('rb')) as stream, tempfile.TemporaryFile() as target:
        total = 0
        for chunk in iter_zstd_chunks(stream):
            total += len(chunk)
            if total > MAX_EXPANDED_BYTES:
                raise ValueError('压缩历史解压后超过大小限制')
            target.write(chunk)
        target.seek(0)
        yield target
