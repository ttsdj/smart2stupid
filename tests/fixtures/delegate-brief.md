# Brief: 委派协议冒烟测试

## 1. 需求背景

验证 smart2stupid 委派 CLI 可以在不启动 Web UI 的情况下创建任务状态、事件和文件变化记录。

## 2. 澄清结论

- 使用 echo executor，不修改业务文件。

## 3. 优化后的提示词

接收这份 brief 并返回成功。

## 4. 分步计划

1. 接收 handoff。
2. 正常退出。

## 5. 约束

- 不修改工作区业务文件。

## 6. 验收标准

- 产生 delegate-state.json。
- 产生 delegate-events.jsonl。
