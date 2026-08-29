"""Automated tests for linecount (stdlib unittest only)."""

import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from linecount.cli import main  # noqa: E402

FIXTURES = os.path.join(REPO_ROOT, "tests", "fixtures")

# Expected (lines, empty, non_empty) for every file counted when the
# fixtures directory is scanned recursively with default settings.
EXPECTED_SCAN = {
    "empty.txt": (0, 0, 0),
    "no_newline.txt": (2, 0, 2),
    "utf8.txt": (2, 0, 2),
    "mixed.txt": (4, 2, 2),
    "src/a.py": (5, 2, 3),
    "src/b.py": (1, 0, 1),
    "src/sub/c.txt": (1, 0, 1),
    "deep/dir/file.txt": (1, 0, 1),
}


def run_cli(args):
    """Run linecount.cli.main in-process, capturing stdout/stderr."""
    old_out, old_err = sys.stdout, sys.stderr
    out, err = io.StringIO(), io.StringIO()
    sys.stdout, sys.stderr = out, err
    try:
        code = main(args)
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return code, out.getvalue(), err.getvalue()


def scan_json(args):
    code, out, err = run_cli(["--format", "json"] + args)
    return code, json.loads(out), err


class TestSingleFile(unittest.TestCase):
    def test_no_newline(self):
        path = os.path.join(FIXTURES, "no_newline.txt")
        code, out, err = run_cli([path])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        _, data, _ = scan_json([path])
        self.assertEqual(data["summary"]["errors"], 0)
        self.assertEqual(len(data["files"]), 1)
        f = data["files"][0]
        self.assertEqual(f["path"], path)
        self.assertEqual((f["lines"], f["empty"], f["non_empty"]), (2, 0, 2))

    def test_empty_file(self):
        path = os.path.join(FIXTURES, "empty.txt")
        _, data, _ = scan_json([path])
        self.assertEqual(len(data["files"]), 1)
        f = data["files"][0]
        self.assertEqual((f["lines"], f["empty"], f["non_empty"]), (0, 0, 0))

    def test_utf8(self):
        path = os.path.join(FIXTURES, "utf8.txt")
        _, data, _ = scan_json([path])
        f = data["files"][0]
        self.assertEqual((f["lines"], f["empty"], f["non_empty"]), (2, 0, 2))

    def test_whitespace_and_last_line_without_newline(self):
        path = os.path.join(FIXTURES, "mixed.txt")
        _, data, _ = scan_json([path])
        f = data["files"][0]
        self.assertEqual((f["lines"], f["empty"], f["non_empty"]), (4, 2, 2))

    def test_hidden_file_explicit(self):
        path = os.path.join(FIXTURES, ".gitignore")
        code, out, err = run_cli([path])
        self.assertEqual(code, 0)
        _, data, _ = scan_json([path])
        self.assertEqual(len(data["files"]), 1)
        self.assertEqual(data["files"][0]["lines"], 1)

    def test_binary_file_explicit_is_skipped(self):
        path = os.path.join(FIXTURES, "binary.dat")
        _, data, _ = scan_json([path])
        self.assertEqual(data["files"], [])
        self.assertEqual(data["summary"]["errors"], 0)


class TestDirectoryScan(unittest.TestCase):
    def test_recursive_default(self):
        code, out, err = run_cli([FIXTURES])
        self.assertEqual(code, 1)  # bad_utf8.txt fails
        self.assertIn("bad_utf8.txt", err)
        self.assertIn("UnicodeDecodeError", err)

        _, data, _ = scan_json([FIXTURES])
        files = {f["path"]: f for f in data["files"]}
        self.assertEqual(len(files), len(EXPECTED_SCAN))
        for rel, (lines, empty, non_empty) in EXPECTED_SCAN.items():
            self.assertIn(rel, files)
            self.assertEqual(
                (files[rel]["lines"], files[rel]["empty"], files[rel]["non_empty"]),
                (lines, empty, non_empty),
            )
        self.assertNotIn("bad_utf8.txt", files)
        self.assertEqual(data["summary"]["errors"], 1)
        self.assertEqual(data["summary"]["files"], len(EXPECTED_SCAN))
        self.assertEqual(data["summary"]["lines"], sum(v[0] for v in EXPECTED_SCAN.values()))
        self.assertEqual(data["summary"]["empty"], sum(v[1] for v in EXPECTED_SCAN.values()))
        self.assertEqual(data["summary"]["non_empty"], sum(v[2] for v in EXPECTED_SCAN.values()))

    def test_binary_skipped(self):
        _, data, _ = scan_json([FIXTURES])
        paths = [f["path"] for f in data["files"]]
        self.assertNotIn("binary.dat", paths)
        self.assertNotIn("build/gen.o", paths)

    def test_default_exclusions(self):
        _, data, _ = scan_json([FIXTURES])
        paths = [f["path"] for f in data["files"]]
        for skipped in ("node_modules/dep/d.js", "build/gen.o",
                        ".hidden_dir/h.txt", ".gitignore"):
            self.assertNotIn(skipped, paths)

    def test_no_recursive(self):
        code, out, err = run_cli([FIXTURES, "--no-recursive"])
        self.assertEqual(code, 1)
        _, data, _ = scan_json([FIXTURES, "--no-recursive"])
        paths = [f["path"] for f in data["files"]]
        self.assertIn("empty.txt", paths)
        self.assertIn("no_newline.txt", paths)
        self.assertNotIn("src/a.py", paths)
        self.assertNotIn("deep/dir/file.txt", paths)
        self.assertEqual(len(paths), 4)
        self.assertEqual(data["summary"]["errors"], 1)

    def test_output_paths_use_forward_slash(self):
        # Relative paths in directory scans are normalized to "/" on every
        # platform (including Windows, where os.sep is "\\"). This keeps
        # --include/--exclude patterns and JSON/CSV/table output stable
        # across platforms.
        _, data, _ = scan_json([FIXTURES])
        self.assertGreater(len(data["files"]), 0)
        for f in data["files"]:
            self.assertNotIn("\\", f["path"], f["path"])
        # The nested path proves normalization applies below the top level.
        self.assertIn("deep/dir/file.txt", [f["path"] for f in data["files"]])


class TestFilters(unittest.TestCase):
    def test_include_py(self):
        _, data, _ = scan_json([FIXTURES, "--include", "*.py"])
        self.assertEqual(sorted(f["path"] for f in data["files"]), ["src/a.py", "src/b.py"])
        self.assertEqual(data["summary"]["errors"], 0)

    def test_exclude_txt(self):
        _, data, _ = scan_json([FIXTURES, "--exclude", "*.txt"])
        self.assertEqual(sorted(f["path"] for f in data["files"]), ["src/a.py", "src/b.py"])
        self.assertEqual(data["summary"]["errors"], 0)

    def test_exclude_wins_over_include(self):
        code, out, err = run_cli([FIXTURES, "--include", "*.py", "--exclude", "src/*"])
        self.assertEqual(code, 0)
        _, data, _ = scan_json([FIXTURES, "--include", "*.py", "--exclude", "src/*"])
        self.assertEqual(data["files"], [])
        self.assertEqual(data["summary"]["errors"], 0)

    def test_include_by_relative_path(self):
        _, data, _ = scan_json([FIXTURES, "--include", "src/*.py"])
        self.assertEqual(sorted(f["path"] for f in data["files"]), ["src/a.py", "src/b.py"])

    def test_repeatable_exclude(self):
        _, data, _ = scan_json([FIXTURES, "--exclude", "*.txt", "--exclude", "*.py"])
        self.assertEqual(data["files"], [])

    def test_repeatable_include(self):
        # Repeatable --include is a union: a file matching any include
        # pattern is kept. "c.txt" matches src/sub/c.txt by basename.
        _, data, _ = scan_json([FIXTURES, "--include", "*.py", "--include", "c.txt"])
        self.assertEqual(sorted(f["path"] for f in data["files"]),
                         ["src/a.py", "src/b.py", "src/sub/c.txt"])
        self.assertEqual(data["summary"]["errors"], 0)

    def test_include_matches_basename(self):
        # A bare basename pattern matches nested files by file name even
        # though the relative path does not equal the pattern.
        _, data, _ = scan_json([FIXTURES, "--include", "a.py"])
        self.assertEqual(sorted(f["path"] for f in data["files"]), ["src/a.py"])

    def test_exclude_matches_basename(self):
        # A bare basename pattern excludes nested files by file name.
        _, data, _ = scan_json([FIXTURES, "--exclude", "file.txt"])
        self.assertNotIn("deep/dir/file.txt", [f["path"] for f in data["files"]])
        self.assertIn("src/a.py", [f["path"] for f in data["files"]])

    def test_single_file_respects_filters(self):
        path = os.path.join(FIXTURES, "no_newline.txt")
        _, data, _ = scan_json([path, "--exclude", "*.txt"])
        self.assertEqual(data["files"], [])


class TestSorting(unittest.TestCase):
    def test_sort_path_default(self):
        _, data, _ = scan_json([FIXTURES])
        paths = [f["path"] for f in data["files"]]
        self.assertEqual(paths, sorted(paths))
        self.assertEqual(paths[0], "deep/dir/file.txt")
        self.assertEqual(paths[-1], "utf8.txt")

    def test_sort_lines(self):
        _, data, _ = scan_json([FIXTURES, "--sort", "lines"])
        paths = [f["path"] for f in data["files"]]
        self.assertEqual(paths, [
            "empty.txt",
            "deep/dir/file.txt",
            "src/b.py",
            "src/sub/c.txt",
            "no_newline.txt",
            "utf8.txt",
            "mixed.txt",
            "src/a.py",
        ])
        lines = [f["lines"] for f in data["files"]]
        self.assertEqual(lines, sorted(lines))


class TestFormats(unittest.TestCase):
    def test_table(self):
        path = os.path.join(FIXTURES, "no_newline.txt")
        code, out, err = run_cli([path])
        self.assertEqual(code, 0)
        self.assertIn("Path", out)
        self.assertIn("Lines", out)
        self.assertIn("Empty", out)
        self.assertIn("Non-empty", out)
        self.assertIn(path, out)
        self.assertIn("Total", out)
        self.assertIn("1 file", out)

    def test_table_totals(self):
        code, out, err = run_cli([FIXTURES, "--include", "no_newline.txt",
                                  "--include", "empty.txt"])
        self.assertEqual(code, 0)
        self.assertIn("Total", out)
        self.assertIn("2 files", out)

    def test_json_parse(self):
        code, out, err = run_cli([FIXTURES, "--format", "json"])
        data = json.loads(out)
        self.assertIn("files", data)
        self.assertIn("summary", data)
        self.assertIn("errors", data)
        self.assertEqual(data["summary"]["errors"], 1)
        self.assertIn("bad_utf8.txt", err)
        self.assertEqual(code, 1)

    def test_json_success_structure(self):
        path = os.path.join(FIXTURES, "utf8.txt")
        code, out, err = run_cli([path, "--format", "json"])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        data = json.loads(out)
        self.assertEqual(data, {
            "files": [{"path": path, "lines": 2, "empty": 0, "non_empty": 2}],
            "summary": {"files": 1, "lines": 2, "empty": 0, "non_empty": 2, "errors": 0},
            "errors": [],
        })

    def test_json_partial_failure_structure(self):
        code, out, err = run_cli([FIXTURES, "--format", "json"])
        data = json.loads(out)  # stdout is still valid JSON on partial failure
        self.assertEqual(code, 1)
        self.assertEqual(set(data.keys()), {"files", "summary", "errors"})
        for f in data["files"]:
            self.assertEqual(set(f.keys()), {"path", "lines", "empty", "non_empty"})
        self.assertEqual(set(data["summary"].keys()),
                         {"files", "lines", "empty", "non_empty", "errors"})
        self.assertEqual(data["summary"]["errors"], 1)
        self.assertEqual(data["summary"]["files"], len(EXPECTED_SCAN))
        self.assertEqual([e["path"] for e in data["errors"]], ["bad_utf8.txt"])
        self.assertIn("UnicodeDecodeError", data["errors"][0]["reason"])
        self.assertEqual(set(data["errors"][0].keys()), {"path", "reason"})

    def test_csv(self):
        code, out, err = run_cli([FIXTURES, "--format", "csv"])
        rows = list(csv.reader(io.StringIO(out)))
        self.assertEqual(rows[0], ["path", "lines", "empty", "non_empty"])
        self.assertEqual(len(rows), len(EXPECTED_SCAN) + 1)
        data = {r[0]: (int(r[1]), int(r[2]), int(r[3])) for r in rows[1:]}
        self.assertEqual(data, EXPECTED_SCAN)
        self.assertEqual(code, 1)

    def test_csv_single_success(self):
        path = os.path.join(FIXTURES, "utf8.txt")
        code, out, err = run_cli([path, "--format", "csv"])
        rows = list(csv.reader(io.StringIO(out)))
        self.assertEqual(rows, [["path", "lines", "empty", "non_empty"], [path, "2", "0", "2"]])
        self.assertEqual(code, 0)


class TestExitCodes(unittest.TestCase):
    def test_success_zero(self):
        code, out, err = run_cli([os.path.join(FIXTURES, "empty.txt")])
        self.assertEqual(code, 0)

    def test_partial_failure_one(self):
        code, out, err = run_cli([FIXTURES])
        self.assertEqual(code, 1)

    def test_missing_path(self):
        missing = os.path.join(FIXTURES, "does-not-exist.txt")
        code, out, err = run_cli([missing])
        self.assertEqual(code, 2)
        self.assertIn("does not exist", err)

    def test_invalid_format(self):
        with self.assertRaises(SystemExit) as cm:
            main(["--format", "bogus", os.path.join(FIXTURES, "empty.txt")])
        self.assertEqual(cm.exception.code, 2)

    def test_invalid_sort(self):
        with self.assertRaises(SystemExit) as cm:
            main(["--sort", "bogus", os.path.join(FIXTURES, "empty.txt")])
        self.assertEqual(cm.exception.code, 2)

    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = run_cli([tmp])
            self.assertEqual(code, 0)
            self.assertIn("0 files", out)


class TestErrorRecovery(unittest.TestCase):
    def test_decode_error_recovers(self):
        code, out, err = run_cli([FIXTURES])
        self.assertEqual(code, 1)
        # stderr warning carries the locatable path and the specific reason.
        self.assertIn("linecount: warning: bad_utf8.txt: UnicodeDecodeError", err)
        self.assertIn("'utf-8' codec", err)
        # other files are still counted
        _, data, _ = scan_json([FIXTURES])
        self.assertEqual(data["summary"]["files"], len(EXPECTED_SCAN))

    def test_streaming_no_whole_file_read(self):
        # Prove counting uses line iteration, not read()/readlines(). A
        # guarded file object raises on unbounded read() and on readlines(),
        # yet the count still completes.
        path = os.path.join(FIXTURES, "no_newline.txt")
        real_open = open

        class Guard:
            def __init__(self, fh):
                self._fh = fh

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self._fh.close()
                return False

            def read(self, n=None):
                if n is None:
                    raise AssertionError("unbounded read() must not be used")
                return self._fh.read(n)

            def readlines(self, *args, **kwargs):
                raise AssertionError("readlines() must not be used")

            def __iter__(self):
                return iter(self._fh)

        def guarded_open(p, *args, **kwargs):
            return Guard(real_open(p, *args, **kwargs))

        with mock.patch("builtins.open", side_effect=guarded_open):
            code, out, err = run_cli([path, "--format", "json"])
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        data = json.loads(out)
        self.assertEqual((data["files"][0]["lines"],
                          data["files"][0]["empty"],
                          data["files"][0]["non_empty"]), (2, 0, 2))

    def test_permission_error_recovers(self):
        target = os.path.join(FIXTURES, "no_newline.txt")
        real_open = open

        def fake_open(path, *args, **kwargs):
            if os.path.abspath(str(path)) == os.path.abspath(target):
                raise PermissionError(13, "Permission denied", str(path))
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=fake_open):
            code, out, err = run_cli([FIXTURES])
            jcode, jout, jerr = run_cli([FIXTURES, "--format", "json"])

        self.assertEqual(code, 1)
        # stderr warning carries the locatable path and the specific reason.
        self.assertIn("linecount: warning: no_newline.txt: PermissionError", err)
        self.assertIn("Permission denied", err)
        self.assertEqual(jcode, 1)
        self.assertIn("linecount: warning: no_newline.txt: PermissionError", jerr)
        data = json.loads(jout)
        # bad_utf8.txt plus the mocked permission failure
        self.assertEqual(data["summary"]["errors"], 2)
        self.assertEqual(data["summary"]["files"], len(EXPECTED_SCAN) - 1)
        self.assertNotIn("no_newline.txt", [f["path"] for f in data["files"]])


class TestModuleEntry(unittest.TestCase):
    def run_module(self, args):
        return subprocess.run(
            [sys.executable, "-m", "linecount"] + args,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_module_single_file(self):
        path = os.path.join(FIXTURES, "no_newline.txt")
        result = self.run_module([path])
        self.assertEqual(result.returncode, 0)
        self.assertIn("no_newline.txt", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_module_json(self):
        path = os.path.join(FIXTURES, "no_newline.txt")
        result = self.run_module(["--format", "json", path])
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertEqual(data["files"][0]["lines"], 2)

    def test_help(self):
        result = self.run_module(["--help"])
        self.assertEqual(result.returncode, 0)
        for token in ("PATH", "--include", "--exclude", "--format",
                      "--sort", "--no-recursive"):
            self.assertIn(token, result.stdout)
        for token in ("table", "json", "csv", "lines", "path",
                      "table|json|csv", "lines|path"):
            self.assertIn(token, result.stdout)
        self.assertIn("default: table", result.stdout)
        self.assertIn("default: path", result.stdout)

    def test_help_and_readme_agree(self):
        # Every option and format/sort enum value must appear in both the
        # --help output and the README so the documented interface cannot
        # drift from the implementation.
        with open(os.path.join(REPO_ROOT, "README.md"), encoding="utf-8") as fh:
            readme = fh.read()
        result = self.run_module(["--help"])
        self.assertEqual(result.returncode, 0)
        for token in ("--include", "--exclude", "--format", "--sort",
                      "--no-recursive", "table", "json", "csv", "lines", "path"):
            self.assertIn(token, result.stdout)
            self.assertIn(token, readme)

    def test_missing_path_exit_2(self):
        result = self.run_module(["no/such/path"])
        self.assertEqual(result.returncode, 2)
        self.assertIn("does not exist", result.stderr)


if __name__ == "__main__":
    unittest.main()
