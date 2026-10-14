# V2 公开发布前全量测试门禁结果

- 日期：2026-10-05
- 基线：`c29ae5b35a96088264f857bc963765d97ffac438`（2026-10-05 15:07:19 +0800）
- 工作目录：`D:\工作目录\Leopold\dsh-tavern`（命令从仓库根执行；插件 `plugins/dsh-tavern-sqlite-v2` 下无 `tmp/`，测试夹具位于仓库根 `tmp/`）
- 命令：`node --test --test-reporter=tap "plugins\dsh-tavern-sqlite-v2\test\*.test.mjs"`（Node v24.19.0，99 个测试文件）
- 原始 TAP：`plugins/dsh-tavern-sqlite-v2/tmp/v2-publish/test-gate/full-run.tap.txt`

## 汇总

| 项 | 值 |
| --- | --- |
| tests | 387 |
| pass | 370 |
| fail | 17 |
| cancelled / skipped / todo | 0 / 0 / 0 |
| 文件级失败数 | 9 个 .test.mjs 文件（被 node --test 记为 9 个额外失败条目） |
| 耗时 | 24106 ms（wall 24230 ms，约 24 秒） |
| 退出码 | 1 |

其中 17 项 = 8 个独立断言/子测试失败（编号 19、20、55、61、238、249、283、373）+ 9 个文件级 `test failed` 条目（编号 11、14、38、41、43、74、78、80、82），后者即下列 9 个文件本身失败。

## 夹具前置核查（用户点名项）

`tmp/upstream-25` 系列**全部存在**，非缺夹具故障：`tmp/upstream25-author-fixture`（988 文件）、`tmp/upstream25-client-sync`（50）、`tmp/upstream25-helper-contract`（5）、`tmp/upstream25-implementation-seams`（2）；`.tmp-verify-clean-install/` 亦完整（含 `blank-clean-host-0930.js` 334675 B、`blank-clean-client-0930.js` 1287910 B 等）。

## 失败明细（具体 test + 原因一行）

| # | test 文件 | 失败 test/块 | 原因（首因） |
| --- | --- | --- | --- |
| 19 | core-host-transform | seq 清理：drain → 单事务截断 → 内存就地重建 | 断言不等：expected 3 / actual 5（事件数未按预期截断） |
| 20 | core-host-transform | seq 清理：边界不合法 ⇒ 抛错且一次都不碰库 | ERR_ASSERTION（同文件前置块失败连带） |
| 61 | core-host-transform | 真实作者完整与缓存消费者同步响应注册变化 | `压缩警告合并投影丢失作者forkTurnsByMessageId字段` |
| 373 | core-host-transform | 变换：旧代同时缺 signal + 资源快照 ⇒ 一并补齐 | `核心运行时接缝标记存在但实现不完整（缺少 presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts \|\| []）` |
| 14 | core-host-transform.test.mjs | 文件级 | `AssertionError: binding.context ||`（test/core-host-transform.test.mjs:17 夹具形状断言失败） |
| 55 | client-rollback-resync-consumer | 旧53隐藏记录不能隐藏复用的新53 | `回退状态锚点漂移：if (released) throw new Error("会话读取已取消")`（deploy/rollback-sync-state-transform.mjs:2 锚点未命中） |
| 11 | client-rollback-resync-consumer.test.mjs | 文件级 | 同上锚点漂移导致文件加载即抛 |
| 238 | （rollback/冷恢复） | 冷恢复实际rc.2构造会生成end-seed | `冷会话恢复缺少已就绪的酒馆宿主补丁，拒绝用原生词汇猜测读取` |
| 249 | server-execution | 脚本不await的Host写在runtime结束后仍被whenIdle等待 | `SERVER_EXECUTION_HOOK_TIMEOUT`：卡脚本异步完成超出预算，本次不提交 |
| 283 | server-execution | 真实作者lib/index按源码序施完全部前置Host缝后… | `压缩警告合并投影丢失作者forkTurnsByMessageId字段`（与 #61 同因） |
| 78 | server-execution.test.mjs | 文件级，2 组失败 | ①`兼容面：generateRaw 未接线 ⇒ 明确抛错` 实际抛 `缺少 options.generateRaw`；②`核心事件桥：命令前建 runtime…` 钩子顺序多出 `MESSAGE_RECEIVED`（期望 5 项，实际 6 项） |
| 41 | mvu-zod-notification.test.mjs | 文件级 | `SERVER_EXECUTION_LOAD_FAILED`：服务端ESM需要 `--experimental-vm-modules`，当前进程未启用（见 `lib/server-execution.js:213`） |
| 43 | opening-seam-sources.test.mjs | 文件级 | `开局服务端接线锚点不唯一：共用动态脚本分类标记`（deploy/opening-runtime-transform.mjs:7） |
| 74 | save-ui-main-entry.test.mjs | 文件级 | `host fixture 必须回到 main 施缝前`（test/save-ui-main-entry.test.mjs:37） |
| 80 | standard-bare-install.test.mjs | 文件级 | `S1/S2 反向片段命中数必须逐项为 1，拒绝猜测`：actual `{flush:1, importLine:1, provide:0, storeBlock:0}` |
| 82 | standard-seams.test.mjs | 文件级 | `标准接入仅支持已适配作者2.5.0，拒绝未知版本`（deploy/standard-seams.mjs:97；夹具作者版本与 2.5.0 不匹配） |
| 38 | main-legacy-seams-lifecycle.test.mjs | 文件级 | `fixture 必须回到 main 施缝前`（test/main-legacy-seams-lifecycle.test.mjs:19） |

## 分类（供主智能体判断，非结论性建议）

- **夹具版本/环境漂移类**（38、74、82、41）：夹具未回到"施缝前/main"状态，或作者版本非 2.5.0，或服务端 ESM 未开 `--experimental-vm-modules`；非产品逻辑断言。
- **接缝锚点漂移类**（11、55、43、80、14）：`deploy/*transform.mjs` 的锚点在当前作者源码上命中数 ≠ 1（0 次或多处），属接缝与上游源码不同步。
- **真实产品断言失败**（19、20、61、283、78、249、238、373）：截断计数、`forkTurnsByMessageId` 投影丢失、`presetRegexScripts` 接缝不完整、钩子事件多派 `MESSAGE_RECEIVED`、`generateRaw` 未接线、异步写超预算、冷恢复拒绝；这些是发布门禁的实际拦路项。

## 未确认项

- 未验证上述失败是否为基线既有状态（未回退到更早提交对照）。
- 未按用户禁令修改任何产品/test 文件；未重跑已通过项；未联网、未安装依赖。
- 9 个文件级失败均带退出即抛性质（顶部 uncaught），其文件内其余断言未执行，实际覆盖面少于通过计数所示。
