# AutoClaw Data Scraper — 架构设计（To-Be / Target）

> 版本 v1.1 · 2026-05-31 · 类型：**目标设计（To-Be）**
> 配套文档：[现状架构（As-Is）](./architecture-current.md)
> v1.1 变更：新增 **Part II — 上市公司标准增量层（GRC / 风险 / 审计）**（§11–§18）。

本文描述目标架构与从现状收敛到目标的路线图，分两部分：

- **Part I（§1–§10）**：**企业级技术架构**——运行时、数据、安全、可靠性、可观测性。
- **Part II（§11–§18）**：**上市公司（拟上市）标准增量**——在技术架构之上叠加的**组织级控制与可审计性**：控制框架（SOX/SOC2 视角）、第三方/子处理者风险、数据合规程序、业务连续性、访问治理、事件响应、供应链安全。

> **适用性声明（重要，避免过度工程）**：本文把设计做到上市公司标准，使系统"**审计就绪（audit-ready）**"；但**实施按重要性（materiality）分期**——多数组织级控制在融资/收入/员工/客户数据量达到相应门槛时才落地（见 §17 成熟度矩阵的"触发门槛"列）。这与团队既定原则一致：**MVP 优先、增量演进、不过度工程**——设计先行、实施按需，二者不矛盾。

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

---

# Part II — 上市公司标准增量层（GRC / 风险 / 审计）

Part I 已交付**企业级技术架构**。上市（拟上市）标准在其之上额外要求**组织级控制与可审计性**：监管/审计（SOX、SOC 2、ISO 27001、GDPR）要的不只是"系统安全"，而是"**控制有设计、有执行、有证据、可被第三方审计**"。本部分给出这层增量。

> 实施遵循 §0 适用性声明：**设计达标即"审计就绪"，落地按 §17 的重要性门槛分期**——绝大多数控制在融资/营收/员工/数据规模到阈值前不强制实施，避免 MVP 阶段过度工程。

## 11. 控制框架与可审计性（SOX / SOC 2 视角）

核心理念：**每个生产变更与数据访问都留下不可抵赖的证据链**。

| 控制 | 现状 | 上市标准目标 |
|---|---|---|
| 变更管理 | 生产 apply 需人工批准（已有；本项目两次自动 apply 被安全层拦截即此控制生效） | main 受保护分支；PR 必须关联审批人；`tofu plan` 工件归档；变更与工单关联 |
| 职责分离 (SoD) | 单一 IAM 用户 | 三权分立：**部署角色 ≠ 运行时角色 ≠ 密钥注入人**；CI 用 OIDC role 仅能 plan/apply 指定 stack |
| 审计日志 | CloudTrail 账号级原始日志 | CloudTrail 投递至独立加密 S3 + 不可删除（Object Lock）；KMS `Decrypt`、SSM 读取纳入审计告警 |
| 证据留存 | 无 | 控制运行证据（审批、扫描、复审记录）集中留档，供年度审计抽样 |

## 12. 第三方 / 子处理者风险（Vendor Risk）

我们把**真人个人数据**交给多个外部服务处理 → 上市标准要求正式的子处理者治理。

| 子处理者 | 用途 | 必备控制 |
|---|---|---|
| AWS | 基础设施/存储/Bedrock | 已有 SOC2；留档；BAA/DPA 视需要 |
| Apollo | 公司/联系人数据、富集 | **DPA 签署**、数据来源合法性确认、SOC2 报告留档 |
| Brevo | 邮件发送/联系人库 | DPA、退订/反垃圾合规、数据驻留（EU 选项） |
| Google (Places) | 公司发现 | API ToS 合规、配额 |
| Hunter | 邮箱补全 | DPA、来源合法性 |
| Anthropic (Bedrock) | LLM 起草 | 走 AWS Bedrock，数据不出账号边界 |

- **GDPR Art. 30 处理活动记录（RoPA）**：维护一张"数据类别 × 用途 × 子处理者 × 法律基础 × 保留期"的台账。
- 子处理者**年度复审** + 公开**子处理者清单**（B2B SaaS 惯例）。

## 13. 数据合规程序（在 §6.4 技术层之上的"程序"层）

§6.4 给的是技术手段（TTL、suppression、删除脚本）；上市标准还要**成文的程序与责任人**：

- **数据分类**：公开 / 内部 / **PII** / 机密——分级决定加密、访问、保留。
- **保留计划表**：raw（审计保留，含法律例外）/ contacts（PII，≤180 天）/ curated（业务期）。
- **DSAR 流程**：按 email/domain 的查询、导出、删除请求处理 SLA + 责任人。
- **同意与退订**：外联前置——发件实体、退订机制、suppression list 审计。
- **隐私政策 / Cookie 同意**：对外站点（sienovo-intl）侧。

> 红线（团队既定，[[feedback_no_client_names]]）：真实客户名不进外部材料。

## 14. 业务连续性与灾备（BCP / DR）

修订 Part I 的"多区域 DR 非目标"：上市标准要的不是"多活"，而是"**有文档、可恢复、演练过**"的明确立场。

| 资产 | RPO（可容忍丢失） | RTO（恢复时长） | 手段 |
|---|---|---|---|
| S3 数据湖 | ≈0 | < 1h | 版本化（已有）；可选跨区复制（CRR）作为冷备 |
| 基础设施 | n/a | < 2h | 全 IaC，`tofu apply` 重建；state 在独立加密 bucket |
| CRM DB（sienovo-intl） | < 24h | < 4h | 托管 Postgres PITR + 定期导出 |
| 密钥 | 0 | 即时 | SSM/KMS 区域内冗余；轮换 runbook |

- **半年一次恢复演练**并留记录（演练本身就是上市审计项）。
- 多活多区域仍**不做**（成本/收益不匹配，明确记录为风险接受）。

## 15. 访问治理与身份生命周期（IGA）

| 维度 | 目标 |
|---|---|
| 人员身份 | AWS 走 **IAM Identity Center (SSO) + 强制 MFA**；废除共享 IAM 用户 |
| 最小权限 | 角色化、按职责授权；**季度访问复审**并留证 |
| 入转离 (JML) | 入职授权审批、转岗权限回收、离职即时禁用的成文流程 |
| 机器身份 | **OIDC 短期凭证**替代长期 access key（与 §5 CI 一致） |

## 16. 安全运营与供应链

- **事件响应 (IR)**：检测（CloudWatch/可选 GuardDuty）→ 分级 → 处置 → **复盘 (post-mortem)**；**密钥/数据泄露专项预案**（轮换 runbook 已具雏形）。
- **软件供应链**：`package-lock` 已提交（构建可复现）；接 **Dependabot / `npm audit`** 阻断已知漏洞依赖；构建走 OIDC、无长期凭证；规模化后可加 **SBOM** 与制品签名。
- **漏洞管理**：定期依赖扫描 + 修复 SLA（按严重度）。

## 17. 控制成熟度矩阵（现状 / 目标 / 触发实施门槛）

> 这张表是 Part II 的操作核心：**何时**该把某控制从"设计"推进到"实施"，由"重要性门槛"驱动，而非一次到位。

| 控制域 | 现状 | 上市目标 | 触发实施的门槛 |
|---|---|---|---|
| 加密 / 密钥 (§6) | ✅ 已达 | 维持 | — 已实施 |
| 变更管理 / 审批 (§11) | 🟡 人工批准已有 | 受保护分支 + 证据归档 | 多人协作 / 首个外部审计 |
| 职责分离 / OIDC (§11,§15) | 🔴 单用户 | 三权分立 + SSO+MFA | 团队 >3 有 AWS 访问 |
| 审计日志 (§11) | 🟡 CloudTrail 原始 | 独立 bucket + Object Lock + 告警 | SOC 2 启动 |
| 子处理者 DPA / RoPA (§12) | 🔴 无 | 全 DPA + 台账 | **启用对外发送邮件前（P0）** |
| PII 程序 / DSAR (§13) | 🟡 技术手段有 | 成文程序 + 责任人 | 首个欧盟联系人入库 / 对外发送前 |
| BCP / DR 演练 (§14) | 🟡 版本化 | RPO/RTO + 半年演练 | 首个付费客户依赖产出 |
| 访问复审 (§15) | 🔴 无 | 季度复审留证 | SOC 2 / 投资人尽调 |
| 事件响应 / 供应链 (§16) | 🟡 部分 | IR 预案 + Dependabot | 团队稳定 / 首个事件后 |

图例：✅ 达标 · 🟡 部分 · 🔴 缺口

## 18. 路线图增量 — Phase 5：GRC（按重要性触发，非日历驱动）

承接 Part I 的 Phase 0–4。本阶段**不按时间排期**，按 §17 门槛触发：

- [ ] **（对外发送邮件前，P0）** 子处理者 DPA（Apollo/Brevo）+ RoPA 台账 + PII/外联合规说明签署
- [ ] **（团队 >3 有 AWS 访问）** IAM Identity Center SSO+MFA；CI 切 OIDC；废共享用户；职责分离
- [ ] **（SOC 2 / 投资人尽调启动）** CloudTrail 独立加密 bucket + Object Lock；季度访问复审；控制证据归档
- [ ] **（首付费客户依赖产出）** BCP RPO/RTO 文档 + 首次恢复演练
- [ ] **（持续）** Dependabot + `npm audit` 门禁；IR 预案 + 首次桌面演练

## ADR 增量

| # | 决策 | 理由 | 取舍 |
|---|---|---|---|
| ADR-9 | **设计达上市标准、实施按重要性分期** | 审计就绪 + 不过度工程，二者兼得 | 文档与实施暂有差距（由 §17 矩阵显式管理，非隐性债务） |
| ADR-10 | 人员访问统一 **SSO + MFA + 季度复审** | 上市/SOC2 硬性要求；消除共享凭证 | 初期配置成本（达门槛才启动） |
| ADR-11 | **DPA + RoPA 作为"启用对外发送"的前置条件** | 对真人发邮件的法律风险最实在 | 外联上线前必须完成此项（卡点） |
| ADR-12 | DR 采"文档化+可恢复+演练"而非多活 | 成本/收益匹配；满足审计实质 | 区域级故障下 RTO 数小时（已接受） |

---

# Part III — 增长引擎：发现栈 + 外联闭环学习

Part I/II 是"数据子系统怎么建/怎么合规"。Part III 是它的**业务用途**：把线索变成**可外联的客户**，并用外联结果**反向优化**找客户与写邮件的策略——形成自我改进的增长回路。

## 19. 免费发现栈（Discovery Stack）

发现层尽量用**免费/已拥有**的数据源；经典 technographic API（BuiltWith/Wappalyzer）不真免费、且对本 ICP 价值低，用 Firecrawl 内容信号替代。

| 维度 | 工具 | 成本 | 角色 |
|---|---|---|---|
| ICP 公司/决策人 | **Apollo** search | 付费（已购） | 主发现：按行业/职位/规模/地区筛 |
| 验证邮箱 | **Hunter** domain-search | 免费 25→付费 | 补 Apollo 屏蔽的邮箱（已接入，credit 熔断） |
| 地理/本地 | **Google Places** | 免费 $200/mo | 本地集成商/安装商（Apollo 漏的中小区域） |
| 技术/领域信号 | **Firecrawl** | 已有 key | 抓官网→检测 边缘AI/RK3588/竞品 关键词 |
| 贸易/市场情报 | **OEC + WITS** | 免费免 key（已在 repo） | 边缘AI硬件进出口流向→选市场/segment |

**Firecrawl 一举三得**：技术画像（领域关键词检测）+ ICP 打分输入 + 邮件个性化素材。

## 20. 外联闭环学习层（Outreach Learning Loop）

```
Apollo/Places/OEC(发现) → Hunter(邮箱) → Firecrawl(打分/个性化)
        ↑                                          ↓
   策略 Playbook  ←── 多周期复盘(LLM,Bedrock) ←── 个性化外联 → OutreachEmail 漏斗
   (喂回起草 + Apollo 过滤)                          (sent/open/click/reply/bounce/complaint)
```

**数据源**：`OutreachEmail` 全漏斗遥测（webhook 驱动：delivered/opened/clicked/replied/bounced(hard/soft/blocked)/complaint/unsubscribed），可按 campaign(=客户类型)/step/subject/发送时段切片。

**四个周期，按数据量定权责**：

| 周期 | 量(预热) | 复盘 | 更新 | 自动/人工 |
|---|---|---|---|---|
| 每日 | ~30 | 退信/投诉/退订激增、送达异常 | 暂停+suppression、列表清洗 | 🤖 **自动**（信誉保护，小样本也立即行动） |
| 每周 | ~150 | 主题开信率、开场变体、哪类客户有反应 | 主题/开场 A/B 建议 | 👤 人工（方向性） |
| 每月 | ~600 | 各类型回复率、哪个 productFocus 转化、序列效果 | campaign aiContext/playbook | 👤 人工 |
| 每季 | ~2400 | **ICP 验证**：哪些行业/职位/规模真回复 | **回写 Apollo 过滤** + 杀/扩活动 | 👤 人工（接 OKR 复盘） |

**统计诚实（也是上市严谨性）**：预热期量低 → 多数"学习"方向性、不显著。所以：内容/策略变更设**最小样本门槛**（如活动 <50 封或 <5 回复不调角度）+ **人工批准**，避免过拟合噪声；**仅"安全/信誉"自动**（投诉/退信激增→自动熔断暂停）。

**策略记忆 = Playbook**：复盘更新它、起草层(`outreach-draft.mjs`)读它注入 prompt。每次复盘存 **`OutreachInsight`** 审计行（周期/指标快照/发现/建议/已应用），可追溯。

**差异化策略层**：每个客户类型一个 `OutreachCampaign`（不同 productFocus/aiContext），Firecrawl 在其上做逐公司个性化 = "每客户不同策略 × 每公司个性化"。

## 21. 增长引擎路线图（Phase G，承接 Part I 的 Phase 0–4）

- **G0（已做，本会话）**：4 个分客户类型 campaign（draft）；Hunter 验证邮箱接入 runner（credit 熔断）
- **G1**：Google Places 接入发现层；Firecrawl 领域信号 → **ICP fit score**（OKR KR1.3）
- **G2**：外联学习层——指标 SQL + `OutreachInsight` 表 + Playbook 字段 + 每日安全熔断；周/月/季复盘脚本
- **G3**：季度 ICP 学习**回写 Apollo/Places 过滤**；OEC/WITS 市场情报接入选市场

> 前置卡点（ADR-11）：任何**对外发送**前须清合规门（DPA/RoPA/opt-out）。G0 的 campaign 故意建为 `draft`。

## ADR 增量（Part III）

| # | 决策 | 理由 | 取舍 |
|---|---|---|---|
| ADR-13 | **Firecrawl 内容信号取代 BuiltWith/Wappalyzer** | 经典 technographic 不真免费/规则过时；对本 ICP 领域关键词更有用；key 已有 | 自建检测逻辑（轻量） |
| ADR-14 | **每客户类型一个 campaign（策略层）+ Firecrawl 逐公司个性化层** | 复用现有 OutreachCampaign 机制实现差异化策略，零新基础设施 | 需维护 N 套活动文案 |
| ADR-15 | 外联学习**仅安全自动**，策略变更**人工+最小样本门槛** | 预热期数据噪声大，防过拟合；信誉保护需即时 | 策略迭代慢于纯自动（刻意） |
| ADR-16 | **Hunter 拿验证邮箱**（Apollo API 屏蔽邮箱），按 credit 熔断 | 解决"找到人却无邮箱"缺口；不超免费额度 | 多一个数据源依赖 |
