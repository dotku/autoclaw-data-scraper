# AutoClaw Data Scraper — 架构设计（To-Be / Target）

> 版本 v1.0 · 2026-05-31 · 类型：**目标设计（To-Be）**
> 配套文档：[现状架构（As-Is）](./architecture-current.md)

本文描述以**企业级标准**设计的目标架构，以及从现状收敛到目标的路线图。系统当前的真实实现见配套的[现状文档](./architecture-current.md)；本文聚焦"应该长成什么样"与"如何分阶段抵达"。

设计遵循团队既定原则：**MVP 优先、增量演进、不过度工程**——因此目标态以"分阶段、每阶段可独立交付/可停"的方式落地，而非要求一次到位。

---

## 1. 质量目标（架构驱动力）

| 维度 | 目标 | 优先级 |
|---|---|---|
| **成本** | AWS 侧 ≈ $0–1/月；真实成本是数据 API 额度 | P0（团队全员无薪、现金紧） |
| **合规** | 抓取符合各源 ToS；联系人数据满足 GDPR/CAN-SPAM | P0（目标市场含欧盟） |
| **安全** | 密钥零明文落盘/落 state；数据静态加密 | P0 |
| **可靠** | 单源失败不拖垮整轮；可观测、可告警 | P1 |
| **可维护** | 新增数据源/客户低成本扩展 | P1 |
| **可扩展** | 1 客户 → N 客户，日级 → 按需 | P2 |

**非目标（明确排除）**：实时/流式采集、自建 GPU/LLM（平台统一走 AWS Bedrock）、多区域 DR。

---

## 2. 核心设计主张：收敛为单一 Lambda-原生管线

现状有两条割裂管线（贸易情报跑 GitHub Actions 并 git-commit 数据；线索跑 Lambda 并入 S3，详见[现状文档](./architecture-current.md)）。目标是把二者**收敛到统一运行时与治理体系**：

- 所有生产采集统一由 **EventBridge → Lambda → S3 数据湖** 承载，纳入同一套密钥/加密/IAM/可观测体系。
- **GitHub Actions 退为纯 CI**（构建/测试/部署），不再承担生产数据采集，不再向仓库 commit 数据。

```
              ┌────────────── 控制面 (IaC: OpenTofu) ──────────────┐
              │ KMS CMK · SSM(多密钥池) · IAM最小权限 · S3加密 · 告警 │
              └──────────────────────────────────────────────────────┘

 EventBridge Scheduler ──invoke──> Lambda: collector
  (per-client cron)                 │
                                    │  ┌ Secrets (SSM+KMS, 运行时解密, 池化) ┐
                                    │  ├ Source Adapters (统一契约) ──────────┤
                                    │  │   apollo · places · hunter (licensed) │
                                    │  │   oec · wits (public)                 │
                                    │  │   [linkedin/amazon/temu/walmart]      │ ← tos-risk, 默认禁用
                                    │  ├ Pipeline: collect→clean→dedupe→        │
                                    │  │          enrich→validate→score         │
                                    │  └ Writers: S3 数据湖 (raw/clean/curated) │
                                    │
                                    ├─> S3 Data Lake (SSE-KMS, 版本化, 分层)
                                    ├─> CloudWatch (结构化日志 + EMF 指标 + X-Ray)
                                    ├─> SNS 告警 (失败 / 配额 / 数据质量)
                                    └─失败─> SQS DLQ
```

---

## 3. C4 视图

### 3.1 Container

| Container | 技术 | 职责 | 相对现状 |
|---|---|---|---|
| Scheduler | EventBridge Scheduler | 按客户/源触发 | 🟢 沿用 |
| Collector | Lambda (nodejs22) | 采集编排主体 | 🟡 合并两管线 |
| Source Adapters | `src/scrapers/*` | 每源一适配器，**统一签名** | 🟡 重构接口 |
| Secrets | SSM + KMS（池化） | 运行时解密注入 | 🟢 沿用 |
| Data Lake | S3（分层） | raw → clean → curated | 🟡 现仅单层 |
| Observability | CloudWatch + SNS + SQS DLQ + X-Ray | 日志/指标/告警/死信/追踪 | 🔴 新建 |
| CI/CD | GitHub Actions | lint/test/build/tofu | 🟡 由采集器改为 CI |

### 3.2 组件：统一 Source Adapter 契约

把现状 12 个各异其趣的 scraper 收敛到一个契约，使编排层与限流/重试/合规/可观测解耦：

```typescript
// src/core/source.ts
export interface SourceAdapter<Q, R> {
  readonly id: string;                 // "apollo" | "oec" | ...
  readonly kind: "api" | "scrape";
  readonly compliance: ComplianceTag;  // "licensed" | "public-api" | "tos-risk"
  collect(query: Q, ctx: RunContext): Promise<R[]>;
}

export interface RunContext {
  runId: string;            // 幂等键 / 链路追踪
  client: string;
  limiter: RateLimiter;     // 令牌桶，按 source 配额
  budget: CreditBudget;     // API 额度预算，超额即停
  logger: StructuredLogger; // 注入 runId/source 的结构化日志
  clock: () => string;      // 注入时钟（可测试）
}
```

编排层从硬编码步骤改为**声明式 plan**：`{ source, query, dependsOn }[]`，由统一 runner 执行——天然支持并发、依赖、单源隔离失败（把现状的 `Promise.allSettled` 语义提升为一等公民）。

---

## 4. 数据架构

### 4.1 数据湖分层（Medallion）

现状 S3 只落最终 leads（单层）。目标引入三层以支持血缘、回溯与质量门：

```
s3://<bucket>/
  raw/      <client>/<source>/dt=<date>/run=<runId>/part.json   ← 原样落盘，不可变，溯源
  clean/    <client>/<source>/dt=<date>/...                      ← 归一化+去重后
  curated/  <client>/<segment>/leads-<date>.{json,csv}           ← 当前输出（保持兼容）
  _manifest/<client>/manifest-<date>.json                        ← 运行清单/血缘
```

- **raw 不可变**：满足审计与"为何抓到这条"的可追溯性。
- **curated 保持现有路径**：下游（`aws s3 sync` / 销售团队）零改动。
- 分区键 `dt=`/`run=` 兼容未来 Athena/Glue 直查，无需 ETL 服务器。

### 4.2 Lead 数据契约（Schema）

以现状 `Lead` 接口为基线，企业化补充：

| 类别 | 字段 | 治理要求 |
|---|---|---|
| 身份 | name, domain, apolloId | domain 归一化为去重主键（现已实现） |
| Firmographic | industry, employeeCount, estimatedRevenue, country | 标注 `source` |
| **PII（敏感）** | contacts[].email/name/linkedinUrl | 见 §6.4：保留期 + 来源合法性标记 |
| 血缘 | source, collectedAt, **runId, sourceLicense** | 新增后两者用于审计 |
| 质量 | **validationStatus, score** | 新增，质量门产出 |

**强约束**：所有写入前经 schema 校验（建议 `zod`）。失败记录进 `clean/_rejected/`，不进 curated，避免脏数据污染销售动作。

### 4.3 数据质量门

| 检查 | 规则 | 失败动作 |
|---|---|---|
| 必填 | name & domain 非空 | drop（现已实现） |
| 去重 | domain 唯一 | drop（现已实现） |
| 格式 | email RFC、domain 可解析 | 标记 `validationStatus` |
| 新鲜度 | collectedAt 在本轮窗口内 | 告警 |
| 数量基线 | segment 产出 < 历史均值 50% | 告警（疑似源结构变更/被封） |

---

## 5. 基础设施目标增量

现状基础设施（KMS/SSM 池化/TLS-only S3/最小权限 IAM/版本化）已达企业基线，**保留**。目标新增：

```hcl
aws_sqs_queue.dlq                          # Lambda 异步失败死信
aws_lambda_function_event_invoke_config    # dead_letter + max_retry=1
aws_sns_topic.alerts                       # 告警出口（邮件/飞书 webhook）
aws_cloudwatch_metric_alarm.*              # 失败率 / 配额耗尽 / 数据质量
tracing_config { mode = "Active" }         # X-Ray
```

仍坚持无数据库、无常驻计算、无 NAT 的极简原则——告警/DLQ 均按量近零成本。

**CI/CD 升级**：GitHub Actions 由采集器改为交付管线（`lint → test → build:lambda → tofu plan`，main 合并 `tofu apply`）。用 **GitHub OIDC → AWS IAM Role** 替代静态 access key；密钥退出 GitHub repo secrets（仅留 CI 部署最小集）。

---

## 6. 安全与合规架构

### 6.1 密钥管理

- **单一事实源 = SSM SecureString（KMS 加密，多密钥池化 `_POOL`）**，现已具备；废除管线 A 的 GitHub secrets 采集用途。
- 轮换：KMS 自动轮换已开；API key 轮换走 `aws ssm put-parameter` 加 `<provider>/<label>` 新键，文档化为季度 runbook。利用现有 `_POOL` 做无缝切换。

### 6.2 加密与 IAM

静态/传输加密现已到位。目标：CI 部署角色与运行时角色分离；启用 CloudTrail 审计 KMS `Decrypt`（CMK 选型本就为此）。

### 6.3 抓取来源合规分级（P0，当前最大缺口）

把合规决策从"代码里随手 import"变为"治理决策"——`ComplianceTag` 进入 adapter 契约，runner 对 `tos-risk` 源**默认拒绝执行**，除非显式放行：

| 分级 | 来源 | 处置 |
|---|---|---|
| `licensed` / `public-api` | Apollo, Places, Hunter, OEC, WITS | ✅ 保留（官方 API / 公开数据） |
| `tos-risk` | LinkedIn, Amazon, Temu, Walmart, ImportYeti(Playwright 抓取) | ⚠️ **默认禁用**，需法务评估 + 显式开关 + 限流/UA 合规后方可启用 |

### 6.4 PII 治理（GDPR / CAN-SPAM）

目标市场含**德国、英国**——Apollo 富集的联系人邮箱/姓名属个人数据，受 GDPR 约束；外联邮件受 CAN-SPAM / 欧盟反垃圾约束。企业标准要求：

- **合法性基础标注**：每条联系人记录标 `sourceLicense`。
- **数据最小化 + 保留期**：联系人数据设 TTL（建议 ≤180 天）；S3 生命周期对 `contacts` 分区单独过期，到期物理删除。
- **删除权（DSAR）**：提供按 email/domain 删除的 runbook/脚本（raw 不可变层除外，需法律保留例外说明）。
- **外联合规**：邮件须含发件人实体 + 退订机制；维护 suppression list（退订/退信不再触达）。
- **访问限制**：leads 属内部资产，仅销售/市场可访问；不导出真实客户名到外部材料（团队红线）。

> 落地建议：先出一页《数据采集与外联合规说明》并由负责人签署，再启用 outreach 自动发送。当前 outreach 仅"生成"不"发送"，是补合规的好窗口。

---

## 7. 可靠性与可观测性

### 7.1 失败隔离与幂等

- **单源隔离**：把现状电商管线的 `allSettled` 语义推广到全部源（runner 级）。
- **幂等**：以 `runId + 输出路径（含 dt/run）` 保证重跑不污染；raw 层不可变天然幂等。
- **额度熔断**：API 层统一接入 `RateLimiter + CreditBudget`，额度耗尽即优雅停止并告警，避免烧光月度免费额度。

### 7.2 可观测性

| 支柱 | 现状 | 目标 |
|---|---|---|
| 日志 | `console.log` | 结构化 JSON（runId/client/source/数量/耗时），Logs Insights 可查 |
| 指标 | 无 | CloudWatch EMF：`leads_collected`、`enrich_calls`、`api_credits_used`、`run_duration`、`source_failures` |
| 追踪 | 无 | X-Ray Active tracing |
| 告警 | 无 | SNS：run 失败、segment 产出骤降、API 额度 >80% |
| 死信 | 无 | SQS DLQ + 重投 runbook |

### 7.3 SLO（建议初版）

| SLO | 目标 |
|---|---|
| 日采集成功率（≥1 segment 产出） | ≥ 99%（按月） |
| 单轮端到端时延 | < 300s（Lambda timeout 内） |
| 数据新鲜度 | curated 当日可用 |
| 配额安全 | 月度 API 额度使用 < 90% |

---

## 8. 可扩展性与演进

- **多客户**：现已是 `client/segment` 维度，handler 已支持 `event.client` 路由。目标把 segment 定义外置为 **S3/SSM 配置**，实现"加客户不改代码、不重部署"。
- **多源**：统一 adapter 契约后，新增源 = 实现一个 `SourceAdapter` + 注册。
- **吞吐**：当前 Lambda 顺序处理足够（~2min）。若逼近 300s，演进为 **Step Functions Map** 按 segment 扇出并行（仍无常驻计算）。
- **查询/分析**：raw/clean 分区就绪后接 **Athena**（按查询计费）替代手工 sync。

---

## 9. 演进路线图（现状 → 目标）

每阶段独立可交付、可停。

### Phase 0 — 合规与治理止血（P0，~1 周）
- [ ] 输出《采集 ToS 分级 + PII/外联合规说明》，负责人签署
- [ ] `tos-risk` 源默认禁用（LinkedIn/Amazon/Temu/Walmart/Playwright 抓取），加显式开关
- [ ] 停止 main.ts 向 git 仓库 commit 数据；数据仅落 S3
- [ ] 联系人数据加保留期/TTL 生命周期

### Phase 1 — 管线收敛与密钥统一（P0–P1，~1–2 周）
- [ ] 贸易情报管线迁入 Lambda 运行时与 SSM/KMS 密钥体系
- [ ] GitHub Actions 改为 CI（lint/test/build/tofu），OIDC 替代静态 AWS key
- [ ] 引入 `SourceAdapter` 契约 + 声明式 runner，替换硬编码步骤
- [ ] LLM 由 Gemini 切换到 AWS Bedrock（符合平台约定）

### Phase 2 — 数据治理与质量（P1，~1–2 周）
- [ ] S3 数据湖三层（raw/clean/curated）+ 血缘 manifest（含 runId）
- [ ] `zod` schema 校验 + 质量门 + `_rejected` 隔离区
- [ ] 数量基线告警（疑似源失效检测）

### Phase 3 — 可观测与可靠（P1–P2，~1 周）
- [ ] 结构化日志 + CloudWatch EMF 指标 + X-Ray
- [ ] SQS DLQ + SNS 告警（失败/额度/质量）
- [ ] `RateLimiter + CreditBudget` 统一限流与额度熔断

### Phase 4 — 规模化（P2，按需）
- [ ] segment/client 配置外置（S3/SSM），加客户零改码
- [ ] 必要时 Step Functions Map 扇出并行
- [ ] Athena 按需查询

---

## 10. 架构决策记录（ADR 摘要）

| # | 决策 | 理由 | 取舍 |
|---|---|---|---|
| ADR-1 | Serverless（Lambda）而非常驻容器 | 日级低频、$0 空闲成本、无运维 | 冷启动/15min 上限（当前 2min，无虞） |
| ADR-2 | Lambda **不进 VPC** | 省 NAT ~$32/mo；仅访问公网 API+S3 | 放弃 VPC 内私有资源访问（暂不需要） |
| ADR-3 | 自管 **KMS CMK** | 轮换/key policy/审计/可吊销 | +~$1/mo |
| ADR-4 | 密钥**带外注入 SSM**，不入 state | state 泄露 ≠ 密钥泄露 | 部署多一步手动注入（runbook 化） |
| ADR-5 | SSM **按 provider 多密钥池化** | 支持无缝密钥轮换（`_POOL`） | SSM 路径层级略复杂 |
| ADR-6 | 收敛为**单一 Lambda 管线** | 统一治理/密钥/可观测，消除割裂 | 一次性迁移成本（Phase 1） |
| ADR-7 | `tos-risk` 源**默认禁用** | 企业不可承担抓取法律风险 | 牺牲部分覆盖换合规确定性 |
| ADR-8 | S3 **Medallion 分层** | 血缘/审计/回溯/可查询 | 存储略增（KB 级，可忽略） |
