# Nuage Workspace Rules (複数リポジトリ横断管理ガイドライン)

このファイルは、`nuage-workspace` をルートとするマルチ・ルート・ワークスペースにおいて、AI Agentが関連する複数のリポジトリを横断的に DevOps・管理する際の動作ルールと前提条件を定義する。Agent は、コマンド実行やファイル編集の際、これらのルールを厳格に適用しなければならない。

## 1. 対象リポジトリと役割

本ワークスペースは以下のリポジトリ群で構成されている。

| リポジトリ名 | 相対パス | 主な役割 |
| :-- | :-- | :-- |
| `nuage-workspace` | `.` | Agent横断管理用ルール・スキルの共通リポジトリ |
| `nuage-cluster` | `../nuage-cluster` | Kubernetes クラスターインフラ、Talos OS、GitOps（Argo CD）管理 |
| `nuage-monitoring-stack` | `../nuage-monitoring-stack` | 監視スタック（Prometheus, Grafana, Alertmanager 等）の設定管理 |
| `pechka` | `../pechka` | アプリケーションサービス |
| `bare-web-proxy` | `../bare-web-proxy` | リバースプロキシおよびフロントエンドルーティング管理 |
| `nuage-autopilot2` | `../nuage-autopilot2` | GitHub Projects 駆動の自律開発オートパイロットサービス |

各リポジトリで詳細な作業を開始する前に、必ずそのリポジトリ直下にある `AGENTS.md` を読み込み、固有のルールや最新のコマンド仕様を把握すること。

---

## 2. GitOps 原則と変更の適用経路

システム全体が GitOps 原則に基づいて管理されている。場当たり的な環境直接の書き換え（例: `kubectl edit` による直接編集）は恒久対応とせず、必ず各ソースコードを変更した上で GitOps 経路にて適用する。

### 適用経路の早見表

| 資材 | 適用経路 |
| :-- | :-- |
| k8s マニフェスト（`../nuage-cluster/manifests/`、および各アプリの `k8s/`） | `master` へ push → Argo CD が自動同期 |
| NixOS LXC / VM（`../nuage-cluster/nix/`） | `master` へ push → `system.autoUpgrade` が自動適用 |
| Terraform / Terragrunt（`../nuage-cluster/terraform/`） | ユーザーが `terragrunt apply` を実行（AI は plan まで） |
| アプリケーション（`pechka`, `bare-web-proxy` など） | 各リポジトリの適用プロセスに従う |

---

## 3. 複数リポジトリ間の依存関係と運用ルール

リポジトリを跨ぐ変更を行う場合、以下の依存関係を考慮して順序よく作業を進めること。

1. **アプリ変更とマニフェストの追従**:
   - アプリケーション（`pechka` 等）でポート、コンテキストパス、環境変数などの定義を変更した場合は、必ず `../nuage-cluster` 側のマニフェスト（Deployment や Service, Ingress 定義など）に反映させる。
2. **監視設定の追従**:
   - サービスを追加・変更した際は、`../nuage-monitoring-stack` における Prometheus の ServiceMonitor やアラートルール、Grafana ダッシュボードの設定が追従できているか確認する。
3. **プロキシ設定の追従**:
   - ルーティングや SSL/TLS 設定の変更時は、`../bare-web-proxy` の HAProxy/Nginx 設定を更新し、必要に応じて K8s の Ingress との整合性を保つ。

---

## 4. Skills (スキル) の参照

- 本リポジトリの `.agents/skills/` に定義されている横断DevOpsスキルの他、`../nuage-cluster/.agents/skills/` などの個別リポジトリに配置されているスキルも必要に応じて `view_file` 等で読み込み、実行手順の参考にすること。

---

## 5. 共通 GitHub Actions Reusable Workflow

`.github/workflows/docker-build-push.yml` は、Docker イメージのビルド・GHCR への push・PR プレビューコメントの投稿をまとめた reusable workflow である。`pechka`, `bare-web-proxy`, `nuage-monitoring-stack` など複数リポジトリで同一内容がコピペされていた処理を集約したもので、各リポジトリからは `workflow_call` で 10 行程度の呼び出しに縮める。

呼び出し側のワークフローには `permissions: contents: read / packages: write / pull-requests: write` を明示する必要がある。

---

## 6. 制約事項

- **SOPS操作の禁止**:
  特別な指示がない限り、SOPS を用いたシークレットファイルの作成・編集・復号は実行しないこと。ユーザーにファイルの作成や編集を促すこと。
- **Terraform, Terragrunt操作の禁止**:
  特別な指示がない限り、Terraform, Terragrunt の操作は実行しないこと。ユーザーに操作を促すこと。
- **言い切り調の使用**:
  コメントアウトやドキュメントを記述する際は、です・ます調（敬体）を避け、である・する調（常体）の言い切りを使用すること。
