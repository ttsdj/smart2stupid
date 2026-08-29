"""Command-line interface, output formatting, and entry point for linecount."""

import argparse
import csv
import json
import os
import sys

from linecount.core import (
    BinaryFileError,
    FileError,
    Summary,
    collect,
    count_file,
)

EXIT_OK = 0
EXIT_PARTIAL_FAILURE = 1
EXIT_USAGE = 2


def _format_error(exc) -> str:
    text = "{}: {}".format(type(exc).__name__, exc)
    if len(text) > 300:
        text = text[:297] + "..."
    return text


def _configure_stream_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass


def build_parser():
    parser = argparse.ArgumentParser(
        prog="linecount",
        description="Count physical lines (total, empty, non-empty) in text files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("path", metavar="PATH", help="file or directory to count")
    parser.add_argument(
        "--include",
        metavar="PATTERN",
        action="append",
        default=[],
        help="only count files matching at least one glob pattern; matches file "
             "name or relative path (repeatable)",
    )
    parser.add_argument(
        "--exclude",
        metavar="PATTERN",
        action="append",
        default=[],
        help="skip files matching any glob pattern; takes precedence over "
             "--include; matches file name or relative path (repeatable)",
    )
    parser.add_argument(
        "--format",
        metavar="table|json|csv",
        default="table",
        choices=("table", "json", "csv"),
        help="output format (default: table)",
    )
    parser.add_argument(
        "--sort",
        metavar="lines|path",
        dest="sort",
        default="path",
        choices=("lines", "path"),
        help="sort results by line count or by path (default: path)",
    )
    parser.add_argument(
        "--no-recursive",
        action="store_true",
        help="only scan the first level of a directory",
    )
    return parser


def run_count(path_arg, include, exclude, recursive):
    """Count all eligible files; return (results, errors).

    Per-file failures are reported to stderr and collected for structured
    output; they do not abort the run.
    """
    errors = []

    def report_error(epath, exc):
        reason = _format_error(exc)
        errors.append(FileError(epath, reason))
        print("linecount: warning: {}: {}".format(epath, reason), file=sys.stderr)

    results = []
    for abs_path, display in collect(path_arg, include, exclude, recursive, report_error):
        try:
            results.append(count_file(abs_path, display))
        except BinaryFileError:
            continue
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            report_error(display, exc)
    return results, errors


def _summary_line(summary) -> str:
    text = "{} file{}".format(summary.files, "" if summary.files == 1 else "s")
    if summary.errors:
        text += ", {} error{}".format(summary.errors, "" if summary.errors == 1 else "s")
    return text


def render_table(results, summary, out):
    headers = ["Path", "Lines", "Empty", "Non-empty"]
    rows = [[r.path, str(r.lines), str(r.empty), str(r.non_empty)] for r in results]
    total_row = ["Total", str(summary.lines), str(summary.empty), str(summary.non_empty)]

    widths = [len(headers[i]) for i in range(4)]
    for row in rows:
        for i, cell in enumerate(row):
            if len(cell) > widths[i]:
                widths[i] = len(cell)
    for i, cell in enumerate(total_row):
        if len(cell) > widths[i]:
            widths[i] = len(cell)

    def fmt(row):
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row))

    sep = "-" * (sum(widths) + 2 * (len(widths) - 1))

    out_lines = [fmt(headers), sep]
    if rows:
        out_lines.extend(fmt(row) for row in rows)
        out_lines.append(sep)
    out_lines.append(fmt(total_row))
    out_lines.append(_summary_line(summary))
    out.write("\n".join(out_lines) + "\n")


def render_json(results, summary, errors, out):
    data = {
        "files": [
            {"path": r.path, "lines": r.lines, "empty": r.empty, "non_empty": r.non_empty}
            for r in results
        ],
        "summary": {
            "files": summary.files,
            "lines": summary.lines,
            "empty": summary.empty,
            "non_empty": summary.non_empty,
            "errors": summary.errors,
        },
        "errors": [{"path": e.path, "reason": e.reason} for e in errors],
    }
    json.dump(data, out, indent=2, ensure_ascii=False)
    out.write("\n")


def render_csv(results, out):
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["path", "lines", "empty", "non_empty"])
    for r in results:
        writer.writerow([r.path, r.lines, r.empty, r.non_empty])


def main(argv=None) -> int:
    _configure_stream_encoding()
    parser = build_parser()
    args = parser.parse_args(argv)

    if not os.path.exists(args.path):
        print("linecount: error: path does not exist: {}".format(args.path), file=sys.stderr)
        return EXIT_USAGE
    if not (os.path.isfile(args.path) or os.path.isdir(args.path)):
        print("linecount: error: not a file or directory: {}".format(args.path), file=sys.stderr)
        return EXIT_USAGE

    results, errors = run_count(args.path, args.include, args.exclude, not args.no_recursive)

    if args.sort == "lines":
        results.sort(key=lambda r: (r.lines, r.path))
    else:
        results.sort(key=lambda r: r.path)

    summary = Summary(
        files=len(results),
        lines=sum(r.lines for r in results),
        empty=sum(r.empty for r in results),
        non_empty=sum(r.non_empty for r in results),
        errors=len(errors),
    )

    if args.format == "json":
        render_json(results, summary, errors, sys.stdout)
    elif args.format == "csv":
        render_csv(results, sys.stdout)
    else:
        render_table(results, summary, sys.stdout)

    return EXIT_PARTIAL_FAILURE if errors else EXIT_OK
