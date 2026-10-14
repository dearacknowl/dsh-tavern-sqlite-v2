# 0.4.12 跨存档变量缓存修复与回归验证

基线：516fb86e3db90fa91c3f60f20253fa081a810b83。验证环境：Windows / Node.js v24.15.0，2026-10-14。

## 本次修复 B11

同一个 createVariableArchive 实例读取两个档案时，snapshotCache 原键仅包含 message_index 和 swipe_id。A、B 档在相同楼层及 swipe 下，连续只读不会触发写入失效，B 可命中 A 的变量快照。

缓存键改为 JSON.stringify([chatId, index, swipe])。保留现有全局写入失效、容量限制和返回值深拷贝行为。回归测试使用两个独立 SQLite 库，经真实 hydrateRow API 验证 A→B→A 读取及返回值修改隔离。

## 历史问题状态

作者在 a1ec25e / 516fb86 中已修复 B02–B06、B09、B10，并加强 B08 的事务边界；B01 也已在上游解决。本 PR 保留作者实现，仅补充不依赖外部宿主源码的合成回归测试，包括静态依赖后动态导入的顶层 await 场景。

B07：旧版测试原本约定同毫秒按 operation_id 排序，早期将其直接判定为缺陷缺乏契约依据。新上游已明确改为 rowid 顺序，本 PR 保留上游的新行为，不另行修改召回排序。

## 验证

新增 test/audit-regressions.test.mjs 共 9 项测试，涵盖历史问题及 B11。最初在 eda1689 基线的八类问题测试均失败；整合作者新修复后，以下定向套件共 35 tests / 35 pass / 0 fail。

```shell
node --experimental-vm-modules --test test/audit-regressions.test.mjs test/variable-snapshot-cache.test.mjs test/variable-archive.test.mjs test/variable-query-sqlite-compat.test.mjs test/esm-module-loader.test.mjs test/db-save-identities.test.mjs test/db-save-exchange.test.mjs test/worldbook-recall-store.test.mjs test/worldbook-recall-sql-read.test.mjs
```

另运行作者 test/issue15-boundaries.test.mjs：7 pass / 3 fail。三个失败均因其依赖的外部宿主 copy-json-tree.js 夹具缺失，分别涉及两项 B08 和一项 B10；未修改原测试或声称这三项已通过。

变量查询兼容测试自行提示缺少冻结源码夹具，历史召回扩展段未执行。先前 current-variable-consumers.test.mjs 也因缺少外部 tavern-helper-context.js 夹具加载失败。未执行全量套件或真实宿主 UI/E2E。

大包测试仅验证 1/4/8 MiB 合成容器进入 schema 检查且不发生正则栈溢出；不是完整大存档玩法验收。原有合成完整 DB 交换往返测试通过。身份写入测试注入最小 helper，仅验证 update/read 边界。

本 PR 相对当前上游仅修改变量缓存源码、新增测试和本报告，不修改安装器或包版本，不安装或迁移用户存档。
