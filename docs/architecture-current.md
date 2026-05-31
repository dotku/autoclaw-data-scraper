# AutoClaw Data Scraper — 现状架构（As-Is）

> 版本 v1.0 · 2026-05-31 · 类型：**现状记录（As-Is）**
> 配套文档：[目标架构设计（To-Be）](./architecture-design.md)

本文如实记录系统**当前已实现**的架构，不含目标态设计与改进建议——那些在配套的[设计文档](./architecture-design.md)中。本文用于新成员快速理解"现在是怎么跑的"，以及作为演进的基线。

---

## 1. 系统定位

AutoClaw 平台的数据采集与销售线索生产子系统。采集外部数据源（海关贸易记录、贸易流统计、电商平台、B2B 企业库），清洗、富集、用 LLM 分析，产出线索资产（leads）与贸易情报报告。首个生产客户：**sienovo-intl**（信迈国际，边缘 AI 硬件，欧美市场）。

---

## 2. 部署拓扑总览

当前系统由**两条并行管线**组成，部署在两个不同运行时：

```
┌──────────────────────── 管线 A：贸易情报 ────────────────────────┐
│  GitHub Actions (cron 06:00 UTC)  →  src/main.ts (9 步)            │
│     数据落地：git commit 回仓库 + upload-artifact (90d)            │
└───────────────────────────────────────────────────────────────────┘

┌──────────────────────── 管线 B：B2B 线索 ────────────────────────┐
│  EventBridge Scheduler (cron 02:00 UTC, 默认 DISABLED)            │
│     →  AWS Lambda (nodejs22)  →  src/leads/sienovo-intl.ts        │
│     数据落地：S3 (SSE-KMS) + 本地 resource-library/ (CLI 时)       │
└───────────────────────────────────────────────────────────────────┘
```

两条管线共享 `src/scrapers/*` 下的源适配器代码，但编排、运行时、密钥来源、数据落地方式均不同。

---

## 3. 管线 A：贸易情报（`src/main.ts`）

**触发**：`.github/workflows/daily-scrape.yml`，每日 06:00 UTC，或手动 `workflow_dispatch`（带 `use_playwright`/`skip_*` 开关）。

**执行步骤**（顺序，部分可跳过）：

| 步骤 | 源 | 实现 | 跳过开关 |
|---|---|---|---|
| 1 | ImportYeti（海关进出口记录） | Cheerio 或 Playwright | — |
| 2 | OEC（HS code 贸易流） | API | — |
| 3 | WITS（World Bank 贸易数据） | API | — |
| 4 | 电商：Shopify/Amazon/Temu/Walmart | `Promise.allSettled` 并发 | `--skip-ecommerce` |
| 5 | LinkedIn（公司/人员查询） | 抓取 | — |
| 6 | Apollo firmographic 富集 | API（需 `APOLLO_API_KEY`） | `--skip-enrich` |
| 7 | Gemini 贸易趋势分析 | API（需 `GEMINI_API_KEY`） | `--skip-llm` |
| 8 | 外联邮件生成（top 10） | Gemini | `--skip-outreach` |
| 9 | HTML 统计报告 | `report/stats.ts` | `--skip-report` |

**数据落地**：所有结果写入 `./data/*.json`（按日期命名），workflow 结束后 `git commit & push` 回仓库，并 `upload-artifact`（保留 90 天）。

**密钥**：来自 GitHub repo secrets（`GEMINI_API_KEY`、`APOLLO_API_KEY`）。

**特征**：单源失败不中断（步骤 4 用 `allSettled`，步骤 7 用 try/catch）；HTTP 抓取有 UA 轮换 + 指数退避（`utils/http.ts`，3 次重试）。

---

## 4. 管线 B：B2B 线索（`src/leads/sienovo-intl.ts`）

**触发**：EventBridge Scheduler，cron 02:00 UTC，**默认 `schedule_enabled=false`**（调试期避免烧 API 额度，需手动 invoke 或显式开启）。input 为 `{client:"sienovo-intl", enrich:true}`。

**云入口**：`src/lambda/handler.ts`
1. `loadSecretsFromSSM()` — 启动即从 SSM 按路径拉取 SecureString，解密后注入 `process.env`（详见 §6）。
2. 校验 `APOLLO_API_KEY` 存在，校验 `event.client`。
3. 调 `runLeadTasks({only, enrich, today})`。

**业务逻辑**：按 4 个客户细分 segment **顺序**执行：

| segment | 标签 | Apollo 关键词（节选） |
|---|---|---|
| `system-integrators` | 系统集成商/方案商 | video analytics, machine vision, edge computing, smart city |
| `hardware-distributors` | 硬件分销商/贸易商 | embedded computer, iot gateway, single board computer |
| `end-users` | 终端企业用户 | factory automation, quality inspection, smart manufacturing |
| `oem-brands` | OEM/品牌方 | odm, white label, contract manufacturing |

目标地区：US / Canada / UK / Germany / Australia。

**单 segment 流程**：
```
searchCompanies (2 页 × 25, 页间 sleep 1s)
  → clean()  归一化域名 + 按域名去重 + 去空 name
  → [enrich] 取 top 8：enrichCompany(firmographic) + findContacts(决策人, 3人)，每条 sleep 1.2s
  → writeLeads()  → JSON + CSV
最后 writeManifest() 汇总
```

**数据落地**（`src/storage/resource-library.ts`，双后端，运行时按 `LEADS_BUCKET` 环境变量切换）：
- 设了 `LEADS_BUCKET`（Lambda）→ 写 S3
- 未设（本地 CLI）→ 写 `./resource-library/`

两端目录结构一致，可 `aws s3 sync` 下载：
```
<client>/<segment>/leads-<date>.json
<client>/<segment>/leads-<date>.csv
<client>/manifest-<date>.json
```

---

## 5. 基础设施现状（`infra/`，OpenTofu）

State 远端复用 `sienovo-tofu-state`（S3 + DynamoDB 锁，us-east-1）。当前资源：

| 资源 | 配置 |
|---|---|
| **Lambda** (`lambda.tf`) | nodejs22, 512MB, **no-VPC**, timeout 300s；env 仅 `LEADS_BUCKET` + `SSM_PREFIX`（无明文密钥） |
| **EventBridge Scheduler** (`schedule.tf`) | cron `0 2 * * ? *`，默认 DISABLED；input `{client:"sienovo-intl", enrich:true}` |
| **S3** (`s3.tf`) | SSE-KMS + bucket key；版本化；noncurrent 90d 过期；public access block 全开；**TLS-only bucket policy**（拒绝非 HTTPS） |
| **KMS CMK** (`kms.tf`) | 自管密钥，开启轮换，deletion window 7d，覆盖 SSM + S3 |
| **SSM SecureString** (`ssm.tf`) | 见 §6 |
| **IAM** (`lambda.tf`) | Lambda role 最小权限：S3 仅 `PutObject`、SSM 仅本前缀路径、KMS 仅本 key；CloudWatch 用 AWS 托管 basic execution policy |
| **CloudWatch Logs** | 显式 log group，保留 14d |
| **Scheduler IAM** (`schedule.tf`) | 独立 role，仅 `lambda:InvokeFunction` 本函数 |

**打包**：`scripts/build-lambda.mjs`（esbuild）把 `src/lambda/handler.ts` 打成 `dist/index.mjs`（ESM，`@aws-sdk/*` 标记 external 由运行时提供），Terraform `archive_file` 再 zip。

---

## 6. 密钥与加密现状

**SSM 布局——按服务源（provider）组织，支持单 provider 多密钥**（`ssm.tf` + `handler.ts`）：

```
<prefix>/<provider>/<label>      例：/autoclaw-data-scraper/apollo/default
                                     /autoclaw-data-scraper/apollo/backup-1
```

- Terraform 为每个 provider（`apollo`、`google-places`、`hunter`）**只 seed 一个空占位** `default`，值为 `REPLACE_VIA_CLI`，`lifecycle.ignore_changes=[value]`。
- **真实密钥带外注入**（`aws ssm put-parameter --overwrite`），永不进入 Terraform state。
- 同一 provider 可随时加更多 key（如 `apollo/backup-1`），Lambda 按路径自动发现。

**运行时加载**（`handler.ts` `loadSecretsFromSSM()`）：
- `GetParametersByPathCommand`（Recursive + WithDecryption），**分页遍历**（NextToken）。
- 按 `<provider>` 映射到 collector 读取的 env 名（`apollo`→`APOLLO_API_KEY` 等）。
- 每 provider 第一个 key → 规范 env 变量；**所有 key 逗号拼接为 `<ENV>_POOL`**（为未来密钥轮换预留）。
- 占位值 `REPLACE_VIA_CLI` 跳过。

**加密**：静态——S3 SSE-KMS、SSM SecureString，均用项目 CMK；传输——S3 TLS-only policy，外部 API 全 HTTPS。

**本地开发**：`.env.local`（已 gitignore，当前含 `FIRECRAWL_API_KEY`、`APOLLO_API_KEY`）；无 `SSM_PREFIX` 时 `loadSecretsFromSSM()` 直接返回，走 `.env.local`。

---

## 7. 成本现状（us-east-1，日级运行）

| 服务 | 量级 | 月成本 |
|---|---|---|
| Lambda | ~30 次 × ~2min @512MB ≈ 1.8k GB-s（免费额度 400k） | $0 |
| S3 | KB–百 MB，版本化 + 90d 过期 | <$0.10 |
| EventBridge Scheduler | 30/月 vs 14M 免费 | $0 |
| SSM Parameter Store | SecureString 标准层 | $0 |
| KMS CMK | 1 key | ~$1 |
| CloudWatch Logs | 每次几 KB，14d 保留 | $0 |
| **AWS 合计** | | **≈ $0–1/月** |

真实成本是数据 API 额度（Apollo / Places / Hunter / Gemini），均有免费层覆盖 MVP 量。

---

## 8. 当前能力与已知局限（如实）

| 能力 | 现状 |
|---|---|
| 管线 B 基础设施安全加固 | ✅ 已具备（KMS/SSM 出 state/TLS/最小权限/版本化） |
| 单 provider 多密钥 + 轮换池 | ✅ 已具备（`_POOL`） |
| 单源失败隔离 | ⚠️ 部分（仅管线 A 步骤 4/7；管线 B segment 顺序执行，未隔离） |
| 数据落地治理 | ⚠️ 管线 A `git commit` 入仓库（无加密/访问控制）；管线 B 已入 S3 |
| 密钥体系统一 | ⚠️ 管线 A 用 GitHub secrets，与管线 B 的 SSM/KMS 割裂 |
| 抓取源合规分级 | ❌ 无（LinkedIn/Amazon/Temu/Walmart 抓取直接 import 执行） |
| PII / 外联合规控制 | ❌ 无（采集个人邮箱但无保留期/退订/DSAR） |
| 数据质量校验 | ⚠️ 仅 `clean()` 去重去空，无 schema 校验 |
| 可观测性 | ❌ 仅 `console.log`，无指标/告警/DLQ/追踪 |
| 自动化测试 / CI 质量门 | ❌ 无单测；`npm test` 实为 `--dry-run` |
| LLM 提供商 | ⚠️ 用 Google Gemini（平台级约定为 AWS Bedrock） |

> 这些局限的目标态与改进路线见 [架构设计文档](./architecture-design.md)。

---

## 9. 代码资产清单

| 模块 | 路径 | 角色 |
|---|---|---|
| 贸易情报编排 | `src/main.ts` | 管线 A 入口 |
| 线索编排 | `src/leads/sienovo-intl.ts` | 管线 B 业务逻辑（importable） |
| Lambda handler | `src/lambda/handler.ts` | 云入口，SSM 密钥加载（多密钥池化） |
| 资源库写入 | `src/storage/resource-library.ts` | S3/本地双后端 |
| 源适配器 | `src/scrapers/*.ts` | 12 源：apollo, google-places, hunter, importyeti, linkedin, oec, wits, shopify, amazon, temu, walmart, playwright-scraper |
| LLM | `src/llm/gemini.ts` | 贸易分析 + 外联生成 |
| 外联 | `src/outreach/{template-builder,email-generator}.ts` | 仅生成，未发送 |
| 报告 | `src/report/stats.ts` | HTML 统计报告 |
| HTTP 工具 | `src/utils/http.ts` | UA 轮换 + 退避 |
| 基础设施 | `infra/*.tf` | OpenTofu |
| 构建 | `scripts/build-lambda.mjs` | esbuild 打包 Lambda |
