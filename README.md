# storage-zfs-resilver-priority-validator
验证 ZFS resilver、scrub 和 I/O 优先级

> **注意：本仓库中所有池（pool）、vdev、故障域、resilver 进度、scrub 状态、带宽与 I/O 延迟均为模拟数据，不连接、不读取、不修改任何真实 ZFS 系统。**

## 背景

ZFS 池在某个 vdev 降级后会开始 resilver，同时可能还有 scrub 和普通 I/O 在竞争带宽。简单的调度器只看池的剩余容量，会忽略单个故障域（fault domain）已经过载。本项目用 Node.js 24.16.0 模拟一个按轮次计算后台任务预算的调度器，验证以下约束：

- 同一故障域不能并发过多恢复任务（默认每轮每故障域 1 个 resilver，可配置）。
- scrub 不能压制 resilver：resilver 优先分配带宽，scrub 只拿剩余预算，预算耗尽时本轮暂停。
- 普通写入保留最低带宽保障（`minWriteBandwidthMBps`），后台任务预算 = 总带宽 − 写入保障。
- 已完成区域（resilver / scrub 的 `completedRegions`）不会重复扫描。
- 数据热度（hotness）用于优先恢复最热、最脆弱的区域。

## 输入

`planRound(input)`（见 `src/scheduler.js`）接受：

- `pool`：池名、总带宽、普通写入最低带宽。
- `vdevs`：vdev 列表，含 `faultDomain` 与 `state`（`online` / `degraded`）。
- `resilvers`：每个降级 vdev 的恢复任务，含总区域数、已完成区域、区域大小、最大速率。
- `scrub`：scrub 状态与进度。
- `io`：普通写入需求带宽与 I/O 延迟。
- `hotness`：每个 vdev 各区域的数据热度（0–1）。
- `limits`：故障域并发上限、resilver 最低速率、轮次时长等可选项。

## 输出

- `tasks`：本轮后台任务顺序（resilver → deferred-resilver → scrub → normal-write），含带宽分配与本轮扫描的区域。
- `bandwidthMBps`：总带宽、写入保障、后台预算、未分配余量。
- `vulnerableRanges`：仍脆弱的数据范围（未完成的区域、偏移、大小、热度，按热度降序）。
- `warnings`：带宽不足等告警。

## 运行

```sh
node --test        # 运行测试（覆盖 vdev 故障、并发 scrub、带宽不足）
node src/main.js   # 运行模拟演示场景
```
