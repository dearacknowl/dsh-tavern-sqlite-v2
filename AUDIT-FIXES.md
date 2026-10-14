# 0.4.12 审查修复与验证

基线：eda16896e5decd2579f5a88630d550f159d3975a。验证环境：Windows / Node.js v24.15.0，2026-10-14。

|审查编号|问题|本次修复|
|---|---|---|
|B02|中文条目超过分页字节预算|按 UTF-8 字节计量，续页完整返回全部条目|
|B03|字符串页尾和预览拆开代理对|页尾避开代理对，游标使用实际截断位置|
|B04|单条转义后超预算返回重复游标|明确抛出条目超限错误，不返回无进展游标|
|B05|大 Base64 分组重复正则栈溢出|使用单字符重复校验并单独检查长度，保留填充和字符限制|
|B06|插件私有 sessionId/chatId 被当作系统身份|身份转换跳过 tavernPluginData，其他结构身份仍重映射|
|B09|并发导入提前读取顶层 await 的导出|等待求值 Promise，覆盖静态依赖后再次动态导入|
|B10|update 可持久化错误 chat.id|首次及后续更新均在建库/写入前检查目标身份|
|B11|不同档相同楼层和 swipe 命中同一快照缓存|缓存键包含 chatId，保留返回值脱离和现有失效逻辑|

B01（包缺件）及 B08（并发旧 revision 覆盖）在基线上已修复，本次不重复修改。

**撤回 B07 缺陷分类**：`test/worldbook-recall-sql-read.test.mjs` 明确规定同毫秒使用 operation_id 排序。此前报告把它当作“最新插入”语义是误判；本次保持既有实现与测试，排序策略若要改变应单独讨论。

## 验证

新增 `test/audit-regressions.test.mjs`：8 类缺陷、9 项测试，含两个 ESM 并发入口组合。最初每类一个测试在未修改基线上 8/8 失败，修复后全部通过。

```shell
node --experimental-vm-modules --test test/audit-regressions.test.mjs test/variable-snapshot-cache.test.mjs test/variable-archive.test.mjs test/variable-query-sqlite-compat.test.mjs test/esm-module-loader.test.mjs test/db-save-identities.test.mjs test/db-save-exchange.test.mjs test/worldbook-recall-store.test.mjs test/worldbook-recall-sql-read.test.mjs
```

结果：34 tests，34 pass，0 fail。原有变量查询兼容测试自行提示缺少冻结源码夹具，其历史召回扩展段未执行，不能把这部分算作已验证。

另尝试 `test/current-variable-consumers.test.mjs`，因缺少外部 `tmp/plg-standard-1001-code/b/lib/domain/tavern-helper-context.js` 夹具在加载时失败；未修改该测试以掩盖失败。未执行全量套件或真实宿主 UI/E2E。

大包测试验证 1/4/8 MiB 合成容器进入 schema 检查且不再发生正则栈溢出；这些容器不是可游玩完整大存档。原有 DB 交换的合成完整存档往返测试通过。身份写入测试注入最小 helper，仅验证 update/read 边界，不代表完整宿主投影验收。跨档缓存使用真实归档模块与两个独立 SQLite 库验证。

本改动不修改包版本，不安装或迁移用户存档，保持草稿等待作者审查。
