# linecount

`linecount` 是一个用 Python 3 标准库实现的命令行工具，用于统计文件或目录下各文本文件的行数（总行数、空行数、非空行数）。它逐行流式读取文件，支持递归/非递归目录扫描、通配符过滤、多种输出格式与排序，且不依赖任何第三方包。

## 环境要求

- Python 3.7+（仅使用标准库，无第三方依赖）

## 运行方式

无需安装。在项目根目录下执行：

```
python -m linecount PATH [选项]
```

也可以按需创建别名：

```
alias linecount='python -m linecount'
```

## 参数

```
usage: linecount [-h] [--include PATTERN] [--exclude PATTERN]
                 [--format table|json|csv] [--sort lines|path]
                 [--no-recursive]
                 PATH
```

| 参数 | 说明 |
|------|------|
| `PATH` | 要统计的文件或目录路径。传入文件时只统计该文件；传入目录时默认递归统计目录下所有文件。 |
| `--include PATTERN` | 只统计匹配至少一个 include 模式的文件。可重复传入，默认不限制。 |
| `--exclude PATTERN` | 跳过匹配任一 exclude 模式的文件；优先级高于 `--include`。可重复传入。 |
| `--format table\|json\|csv` | 输出格式，默认 `table`。 |
| `--sort lines\|path` | 排序方式，默认 `path`。 |
| `--no-recursive` | 目录只扫描第一层，不进入子目录。 |
| `-h, --help` | 显示帮助并退出。 |

## 示例

```bash
# 统计单个文件
python -m linecount src/main.py

# 递归统计整个目录
python -m linecount src

# 只统计目录第一层的文件
python -m linecount . --no-recursive

# 只统计 Python 文件
python -m linecount . --include "*.py"

# 排除测试文件（exclude 优先于 include）
python -m linecount . --include "*.py" --exclude "test_*.py"

# 按相对路径过滤
python -m linecount . --exclude "vendor/*"

# JSON 输出并按行数排序
python -m linecount . --format json --sort lines

# CSV 输出
python -m linecount . --format csv
```

## 默认排除项

扫描目录时会跳过：

- 隐藏文件和隐藏目录（名称以 `.` 开头），例如 `.git`、`.venv`、`.gitignore`。
- 固定排除目录：`.git`、`node_modules`、`build`、`dist`、`out`、`target`、`__pycache__`、`venv`、`.venv`。
- 二进制文件（见「文本检测」）。

显式传入的单个文件不受隐藏规则限制，但仍会应用 `--include`/`--exclude` 与二进制检测。

## 文本检测

读取文件开头 8 KB，若其中包含 NUL 字节（`\x00`）则判定为二进制并跳过。空文件（0 字节）视为文本，统计为 0 行。

## 过滤规则

- `--include`/`--exclude` 使用 shell 风格通配符（`*`、`?`、`[...]`），与 Python `fnmatch` 一致。
- 每个模式会同时匹配「文件名」和「相对路径」（目录扫描时使用 `/` 分隔、相对于被扫描目录）；任一匹配即视为命中。
- 单个文件输入时只匹配文件名。
- 优先级：`--exclude` 优先。文件命中任一 exclude 即被跳过；若提供了 include，文件还必须命中至少一个 include 才会被统计。
- 模式匹配遵循平台的文件名大小写规则（Windows 不区分大小写，Linux/macOS 区分）。

## 行数定义

- 按物理行统计，不解析注释、代码等语义类别。
- 总行数 = 空行数 + 非空行数。
- 空行指去除首尾空白后为空的物理行（含仅含空白字符的行）。
- 末行没有换行符时仍计入一行。
- 使用 Python 通用换行模式（`\n`、`\r`、`\r\n` 均按换行处理），文件按 UTF-8 解码。
- 逐行流式读取，不将整个文件载入内存。

## 输出

### table（默认）

```
Path              Lines  Empty  Non-empty
-------------------------------------------
src/a.py              5      2          3
src/b.py              1      0          1
-------------------------------------------
Total                 6      2          4
2 files
```

表格末尾显示各类行数合计（Total）与文件数；若有失败文件，汇总行会附加错误数（详见 stderr）。

### json

```json
{
  "files": [
    {"path": "src/a.py", "lines": 5, "empty": 2, "non_empty": 3}
  ],
  "summary": {"files": 2, "lines": 6, "empty": 2, "non_empty": 4, "errors": 0},
  "errors": []
}
```

- `files` 仅包含成功统计的文件。
- `errors` 包含失败文件的 `path` 与 `reason`。
- 可直接用 `json.load` 解析。

### csv

```csv
path,lines,empty,non_empty
src/a.py,5,2,3
src/b.py,1,0,1
```

CSV 仅含逐文件数据（表头 + 数据行），可由 `csv` 模块读取。

## 错误处理与退出码

- 单个文件读取失败（无权限、解码失败、损坏等）时，向 stderr 输出 `linecount: warning: <路径>: <原因>`，并继续统计其余文件。
- 目录无法读取时同样向 stderr 警告并继续。
- 退出码：
  - `0`：成功（无任何错误）。
  - `1`：部分失败（至少一个文件或目录处理出错）。
  - `2`：参数或输入路径无效（如不支持的 `--format`/`--sort` 取值、路径不存在）。

## 测试

仅依赖标准库 `unittest`：

```
python -m unittest discover -s tests -v
```

测试覆盖空文件、末行无换行、UTF-8、空白行、二进制文件、嵌套目录、默认排除、include/exclude 过滤与优先级、非递归模式、单文件输入、排序、读取失败与错误恢复、退出码，以及 table、JSON、CSV 三种输出格式。
