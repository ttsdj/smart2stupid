"""File discovery, filtering, and line counting for linecount."""

import os
from dataclasses import dataclass
from fnmatch import fnmatch

# Directories skipped during directory scans in addition to hidden
# directories (names starting with ".").
DEFAULT_EXCLUDED_DIRS = frozenset({
    ".git",
    "node_modules",
    "build",
    "dist",
    "out",
    "target",
    "__pycache__",
    "venv",
    ".venv",
})

# Bytes read from the head of each file to detect binary content.
BINARY_SNIFF_BYTES = 8192


class BinaryFileError(Exception):
    """Raised when a file is detected as binary and should be skipped."""


@dataclass
class FileResult:
    """Line counts for one successfully counted file."""

    path: str
    lines: int = 0
    empty: int = 0
    non_empty: int = 0


@dataclass
class FileError:
    """A per-file failure with a human-readable reason."""

    path: str
    reason: str


@dataclass
class Summary:
    """Global totals across all successfully counted files."""

    files: int = 0
    lines: int = 0
    empty: int = 0
    non_empty: int = 0
    errors: int = 0


def _is_hidden(name: str) -> bool:
    return name.startswith(".")


def _matches_any(name: str, rel_path: str, patterns) -> bool:
    for pattern in patterns:
        if fnmatch(name, pattern) or fnmatch(rel_path, pattern):
            return True
    return False


def should_include_file(name: str, rel_path: str, include, exclude) -> bool:
    """Apply the --include/--exclude rules.

    Exclusion wins: a file matching any exclude pattern is skipped.  If
    include patterns are given, the file must additionally match at least
    one of them.
    """
    if _matches_any(name, rel_path, exclude):
        return False
    if include and not _matches_any(name, rel_path, include):
        return False
    return True


def collect(path_arg, include, exclude, recursive, on_error):
    """Return [(abs_path, display_path)] for files that pass the filters.

    on_error(path, exc) is invoked for non-fatal discovery errors such as
    an unreadable directory.  Hidden files are skipped during directory
    scans; a file passed directly is always a candidate.
    """
    if os.path.isfile(path_arg):
        name = os.path.basename(path_arg)
        if should_include_file(name, name, include, exclude):
            return [(os.path.abspath(path_arg), path_arg)]
        return []

    root = os.path.abspath(path_arg)
    candidates = []

    if recursive:
        def walk_onerror(exc):
            on_error(getattr(exc, "filename", None) or root, exc)

        for dirpath, dirnames, filenames in os.walk(root, topdown=True, onerror=walk_onerror):
            dirnames[:] = sorted(
                d for d in dirnames
                if not _is_hidden(d) and d not in DEFAULT_EXCLUDED_DIRS
            )
            for fname in sorted(filenames):
                if _is_hidden(fname):
                    continue
                abs_path = os.path.join(dirpath, fname)
                rel_path = os.path.relpath(abs_path, root).replace(os.sep, "/")
                if should_include_file(fname, rel_path, include, exclude):
                    candidates.append((abs_path, rel_path))
        return candidates

    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError as exc:
        on_error(root, exc)
        return []
    for entry in entries:
        try:
            if entry.is_dir():
                continue
        except OSError as exc:
            on_error(entry.path, exc)
            continue
        fname = entry.name
        if _is_hidden(fname):
            continue
        if should_include_file(fname, fname, include, exclude):
            candidates.append((entry.path, fname))
    return candidates


def count_file(abs_path: str, display: str) -> FileResult:
    """Count physical lines in abs_path, returning a FileResult.

    Raises BinaryFileError for binary files, OSError for unreadable
    files, and UnicodeDecodeError for files that are not valid UTF-8.
    Lines are read one at a time, so memory use stays bounded for large
    files.
    """
    with open(abs_path, "rb") as fh:
        head = fh.read(BINARY_SNIFF_BYTES)
    if b"\x00" in head:
        raise BinaryFileError()

    total = 0
    empty = 0
    non_empty = 0
    with open(abs_path, "r", encoding="utf-8") as fh:
        for line in fh:
            total += 1
            if line.strip() == "":
                empty += 1
            else:
                non_empty += 1
    return FileResult(path=display, lines=total, empty=empty, non_empty=non_empty)
