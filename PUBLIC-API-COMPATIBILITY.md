# 公开 API 兼容与退役策略（V2）

本文件定义 `dsh-tavern-sqlite-v2` 公开导出面（`package.json` 的 `exports`）的兼容承诺、废弃（deprecated）登记与迁移建议。
基线：工作区 `b700715` / 0.4.9 静态核查；0.4.10 候选沿用同一策略。**未核跨仓外部消费者**（见 §6），因此本文件不构成"某子路径可以删除"的结论。

## 1. 合同面与三类真实消费形态

`exports` 的 **56 个子路径**是唯一公开合同面。判断"有没有消费者"必须区分三种形态，**只做仓内 `import 'dsh-tavern-sqlite-v2/<subpath>'` 检索会漏**：

| 形态 | 例子 | 说明 |
|---|---|---|
| ① 包内相对 import | `chat-sqlite-store.js:8` → `./lib/variable-archive.js` | 生产链主力，不经 `exports` 子路径 |
| ② deploy 生成垫片 | `deploy/standard-seam-transforms.mjs` 写入作者树的 `storagePackage('<name>')` / `loadOwnedModule()` 垫片、`apply-legacy-view-seams.mjs` 的 `LEGACY_VIEW_SHIM` | 在**目标作者树**里按包名解析导出，仓内看不到直接 import |
| ③ 宿主装配行 | `profiles/tavern/cordis.patch.yml` 三条持久行（`bootstrap/session-persistence.js`、`bootstrap/host-patch.js`、`bootstrap/standard-host.js`）+ 作者扫描的普通行 `plugin.js` | 由安装器写入，运行时由宿主 Loader 加载 |

## 2. 分类（56 键，b700715 静态核查）

| 分类 | 数量 | 条目 |
|---|---|---|
| prod（仓内生产消费者/根入口/宿主装配） | 44 | 见 §7 全表 |
| deploy-only（仅 deploy 动态装配） | 7 | `./regeneration-adoption`、`./legacy-view-seams`、`./legacy-fork-records`、`./legacy-source-workspace`、`./budgets`、`./conversation-fork-point`、`./chat-history-rescue` |
| test-only | 1 | `./variable-store` |
| zero（仓内零消费者） | 2 | `./mvu-script-sandbox`、`./card-script-dispatch-store` |
| infra（解析器基础设施） | 2 | `./package.json`、`./locale/*.json` |

## 3. 政策（不得削弱）

1. **保留 exports**：本仓零引用 ≠ 无外部消费者；不因"仓内没人用"删除任何子路径或文件。
2. **deprecated 只做注记**：不改运行时行为、不改解析器、不改 `files`、不删文件、不改导出形状。
   **唯一例外（2026-10-13 记录）**：已标注 deprecated 的旧**卡脚本沙箱** `./mvu-script-sandbox` 与
   旧**分派缓存** `./card-script-dispatch-store` 各自存在"不是注记能兜住"的缺陷 —— 前者自建
   `vm.createContext` 并把真宿主 `crypto`/hostApi 裸穿进 realm（realm 逃逸面），后者把合法但非
   plain object 的 JSON（`null`/数字/字符串/布尔/数组）当缓存放行，且 `JSON.parse` 产物的原型会让
   `__proto__` 类卡路径读到祖先并在写时污染 `Object.prototype`。两处按**安全收口**处理：
   **导出名与旧可见字段不变**、不删文件、不新增导出；沙箱改为**委托现役运行时**
   （`createCardScriptRuntime`，**每次调用新实例**，不再按 cardPath 缓存；更小的逃逸面，与第 5 条
   "旧卡脚本沙箱不得成为生产消费者"同向），缓存改为**丢弃非法形状回落空对象 + 拷进 null 原型容器**。
   该例外只允许"缩小逃逸面/丢弃坏缓存"，不得借它复活旧实现或放宽既有政策。
   ⚠ **确有新增（如实登记，不谎称"无新增字段/无行为变化"）**：`./mvu-script-sandbox` 的
   `dispatchEvent` 由旧 void 变为**返回现役 outcome 回执**、`dispose()` 由旧 void 变为**返回释放回执**
   `{alreadyDisposed,clearedTimers,cancelledBudgets,closedPending}`，并新增只读 `sandbox` getter 与
   `events[].source` 字段；**非 strict 的"吞异常/不向调用方抛"保留，但钩子异常的记账级别由现役运行时
   决定（当前 `logger.error`，旧垫片为 `logger.warn`）**；不新增"等待待办/续命"等旧版没有的能力。
   `./card-script-dispatch-store` 方法签名不变，仅读取语义收紧（非法形状丢弃、原型键不再命中祖先）。
3. **退役三步**：先标注 → 停新增消费者 → **大版本**移除；不与其他修复混在同一刀；移除前必须有大版本决定 + 外部证据（跨仓消费者、镜像、卸载器归属清单）。
4. **infra 永久保留**：`./package.json`、`./locale/*.json` 是解析器依赖，任何情况下不删。
5. **不复活生产死路径**：不得为了兼容旧 API 把已退役的旧实现接回主流程（旧 JSON 变量库、旧 JSON 分派库、旧卡脚本沙箱都不得成为生产消费者）。
6. 数据侧总则：存档与变量只有一个权威（SQLite 同库同事务）。外部集成**只经插件公开服务/命令面**，**不直接写库**、不自行打开数据库文件、不代做归档/回退副数据清理（会绕过 CAS、身份校验与派生清理）。

## 4. 已标注 deprecated 的 5 处（主已注记，本文件仅登记）

| 导出/文件 | 注记位置 | 现役替代（真实符号与位置） | 迁移建议 |
|---|---|---|---|
| `./card-script-dispatch-store` | `lib/card-script-dispatch-store.js:67` | `createServerDispatchStore`（`lib/server-dependencies.js:14`；由 `deploy/core-host-transform.mjs:23` 注入作者树） | 用宿主注入的服务端分派标记存储；不要自建 JSON 分派库，也不要直接写库 |
| `./variable-store` | `variable-sqlite-store.js:14`（仓内仅测试消费者） | `createVariableArchive`（`lib/variable-archive.js`，由 `chat-sqlite-store.js:8` 构造，正文与变量同事务） | 读写变量走插件公开命令/服务面（`tavern.handle`、`host-actions`、`read-variables`）；**不直接写库**，也不要在外部用 variable-archive 直接改库 |
| `./mvu-script-sandbox` | `lib/mvu/mvu-script-sandbox.js:69`（**兼容垫片**：不再自建 vm，每次调用新建并委托现役运行时） | `lib/mvu/mvu-card-runtime.js`（服务端运行时；in-process / worker 由 `lib/mvu/vm-capability.js:29` 按能力选路） | 用 `mvu-card-runtime` 与 `server-execution`；不要另建第二个卡脚本执行器 |
| `lib/mvu/mvu-events.js`（非 exports） | 文件首行 `@deprecated` | 每次运行的局部事件出口（`server-execution` 运行时） | 用现役运行时事件出口，不要缓存全局事件总线 |
| `./rollback-head-prune` | `lib/rollback-head-prune.js:1`（`lib/rollback-cleanup.js:22` 仍引用，但不在当前主回退路径上） | `lib/clean-rollback.js` 主路径 | 回退走 `cleanRollback` 公开面；不要新增消费者 |

## 5. 面向使用方的迁移要点

- **变量与存档读写**：只经插件公开面（命令 / `tavern.handle` / `host-actions` / `read-variables`）。**不直接写库**，不要绕过事务与 CAS 自己改 SQLite。
- **卡脚本/MVU 执行**：用 `mvu-card-runtime`（配合 `server-execution`），不要复用旧沙箱模块；执行不是安全隔离，见 [README 安全边界](README.md)。
- **回退/清理**：用 `clean-rollback` / `rollback-layers` 等现役公开面，不要自行修剪 head 索引或派生表。
- **旧垫片形态**：作者树里的 `storagePackage()` 垫片由安装器生成与维护，手动改写会在下次施缝被覆盖。

## 6. 未核项（删除前的必要前置证据）

- 跨仓外部消费者（其他包/profile 配置对 `dsh-tavern-sqlite-v2/*` 的使用）。
- `tools/deployed-baseline` 镜像内容。
- 维护/卸载器的 owned-file 清单对旧资产的归属判定。

上述任一项未核实时，**一律不得删除导出或文件**；如需推进，按 §3 第 3 条走大版本流程。

## 7. 全表（56 键 → 分类）

- `.`、`./session-persistence`、`./host-patch`、`./host-session-install`、`./rollback-layers`、`./rollback-head-prune`、`./rollback-cleanup`、`./rollback-business-state`、`./rollback-barrier`、`./clean-rollback`、`./worldbook-recall-store`、`./rollback-global-variables`、`./rollback-extension-settings`、`./rollback-character-variables`、`./rollback-worldbook-resources`、`./rollback-worldbook-bindings`、`./db-save-exchange`、`./chat-store`、`./author-migration-adapter`、`./failure-state`、`./session-window-projector`、`./activity-state`、`./sandbox-policy`、`./client`、`./host-actions`、`./save-handlers`、`./variable-ops`、`./legacy-bindings`、`./tavern-chat-state`、`./migration-ops`、`./read-variables`、`./fork-history-markers`、`./mvu-card-runtime`、`./mvu-update-core`、`./standard-host`、`./server-execution`、`./server-dependencies`、`./opening-server-init`、`./variable-archive`、`./current-variables`、`./compaction-warning`、`./esm-module-loader`、`./tavern-helper-api`、`./tavern-regex-api` —— **prod（44）**
- `./regeneration-adoption`、`./legacy-view-seams`、`./legacy-fork-records`、`./legacy-source-workspace`、`./budgets`、`./conversation-fork-point`、`./chat-history-rescue` —— **deploy-only（7）**
- `./variable-store` —— **test-only（1）**
- `./mvu-script-sandbox`、`./card-script-dispatch-store` —— **zero（2）**
- `./package.json`、`./locale/*.json` —— **infra（2，永久保留）**

## 8. 证据指针

- 内部核查（非发行物）：`tmp/v2-fix-audit-20261013/dead-code.md`（56 键逐项三通道核对与 Tier 分级）。
- 机器可读事实源：`package.json` 的 `exports`。
- 台账：`docs/workstreams/plugin/V2-OVERALL-STATIC-AUDIT-2026-10-13.md`（variable-store 建议先标 deprecated）、`docs/workstreams/plugin/PLUGIN-DUPLICATION-AND-API-RETIREMENT-AUDIT-2026-10-11.md`（R01 变量库、R02 旧分派库、R04 旧薄垫片模板）。
