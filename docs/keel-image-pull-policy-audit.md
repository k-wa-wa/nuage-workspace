# Keel・`:latest` / floating タグ利用ワークロードの `imagePullPolicy` 横展開棚卸し

関連 Issue: [#31](https://github.com/k-wa-wa/nuage-workspace/issues/31)

## 1. 背景と目的

`pechka` PR #69 の preview 環境検証において、Keel（`keel.sh/policy: force`, `keel.sh/trigger: poll`, `keel.sh/matchTag: "true"`）で自動更新する Deployment や `:latest` タグを使用するワークロードで `imagePullPolicy` が未設定だと、非 `:latest` タグ差し替え時（`:pr-<N>` 等）の既定値 `IfNotPresent` によりノードキャッシュの古いイメージが再利用され続ける問題が発覚した。

本ドキュメントは、`~/ghq/github.com/k-wa-wa/` 配下の Kubernetes マニフェストを持つ全リポジトリ（`bare-web-proxy`, `pechka`, `nuage-monitoring-stack`, `nuage-honeytrap`, `nuage-cluster`, `nuage-home`）を対象に、以下を調査・棚卸しした記録である（他リポジトリの直接修正は別 PR / 後続 Issue で実施する）。

- Keel (`keel.sh/*`) 監視対象ワークロードの `imagePullPolicy` 設定状況
- 素の Workflow / Job / CronJob / Pod / Deployment で自前イメージ・`:latest`・タグ省略・floating タグを利用する箇所の網羅
- `.github/workflows/validate/k8s/workload.rego` の新ルール（Keel 監視対象 `deny`、`:latest`/タグ省略 `warn`）による既存リポジトリへの影響確認

---

## 2. 棚卸し結果サマリ

| 分類 | 件数（ファイル / 箇所） | 概要 |
| :-- | :-- | :-- |
| Keel 対象ワークロード（対応済） | 12 箇所（5 リポジトリ） | 全監視対象コンテナに `imagePullPolicy: Always` が設定済み（`nuage-home` は退役リポジトリ） |
| 素のワークロード（設定済） | 7 ファイル | `pechka` Workflow/Job、`nuage-honeytrap` `cloudflared`、`nuage-cluster` `searxng` / `litellm` は `Always` 設定済み |
| 要対応候補（後続対応） | 10 ファイル群 | `pechka` 手動テスト Job（自前イメージ `imagePullPolicy` 欠落・CI 対象外）、`mc-job` / `minio-local` の `:latest`、`bare-web-proxy` `headless-chrome`（`IfNotPresent` + `k8s-validate.yml` 未導入）、floating バージョンタグ群 |
| 意図的例外 | 1 箇所 | `nuage-cluster` `preview-isolation-test`（レート制限回避のため `busybox:latest` + `IfNotPresent`） |

---

## 3. Keel (`keel.sh/*`) 対象ワークロード一覧

`keel.sh/policy: force` / `keel.sh/trigger: poll` / `keel.sh/matchTag: "true"` を設定している全 Deployment を棚卸しした。現時点で監視対象コンテナのすべてに `imagePullPolicy: Always` が設定されている。

| リポジトリ | ファイル | コンテナ | イメージ | `imagePullPolicy` | `monitorContainers` | 状態 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `bare-web-proxy` | `k8s/base/deployment.yaml` | `proxy-app` | `ghcr.io/k-wa-wa/bare-web-proxy:latest` | `Always` | `"proxy-app"` | 対応済 |
| `bare-web-proxy` | `k8s/base/deployment.yaml` | `headless-chrome` | `chromedp/headless-shell:latest` | `IfNotPresent` | （対象外） | 要検討（§4.2 参照） |
| `pechka` | `k8s/base/api/api.yaml` | `api` | `ghcr.io/k-wa-wa/pechka-api:latest` | `Always` | `"api"` | 対応済 |
| `pechka` | `k8s/base/frontend/frontend.yaml` | `frontend` | `ghcr.io/k-wa-wa/pechka-frontend:latest` | `Always` | `"frontend"` | 対応済 |
| `pechka` | `k8s/base/tech-feed/aivisspeech.yaml` | `aivisspeech` | `ghcr.io/k-wa-wa/pechka/aivisspeech-engine:latest` | `Always` | `"aivisspeech"` | 対応済 |
| `pechka` | `k8s/overlays/preview/tech-feed-patch.yaml` | `aivisspeech` | （base 継承、`pr-<N>` 差し替え対象） | `Always`（明示パッチ） | （base 継承） | 対応済 |
| `pechka` | `k8s/overlays/preview/vrt-report.yaml` | `vrt-report` | `ghcr.io/k-wa-wa/pechka-vrt-report:latest` | `Always` | `"vrt-report"` | 対応済 |
| `pechka` | `k8s/overlays/preview/storybook-report.yaml` | `storybook-report` | `ghcr.io/k-wa-wa/pechka-storybook-report:latest` | `Always` | `"storybook-report"` | 対応済 |
| `nuage-monitoring-stack` | `k8s/base/monitoring-pwa/monitoring-pwa.yaml` | `backend` | `ghcr.io/k-wa-wa/nuage-monitoring-stack-monitoring-pwa-backend:latest` | `Always` | `"backend"` | 対応済 |
| `nuage-monitoring-stack` | `k8s/base/monitoring-pwa/monitoring-pwa.yaml` | `frontend` | `ghcr.io/k-wa-wa/nuage-monitoring-stack-monitoring-pwa-frontend:latest` | `Always` | `"frontend"` | 対応済 |
| `nuage-honeytrap` | `k8s/base/deployment.yaml` | `honeytrap` | `ghcr.io/k-wa-wa/nuage-honeytrap:latest` | `Always` | `"honeytrap"` | 対応済 |
| `nuage-home` | `k8s/base/backend/deployment.yaml` | `backend` | `ghcr.io/k-wa-wa/nuage-home-backend:latest` | `Always` | `"backend"` | 対応済（退役リポジトリ） |
| `nuage-home` | `k8s/base/frontend/deployment.yaml` | `frontend` | `ghcr.io/k-wa-wa/nuage-home-frontend:latest` | `Always` | `"frontend"` | 対応済（退役リポジトリ） |
| `nuage-home` | `k8s/base/sandbox/deployment.yaml` | `runner` | `ghcr.io/k-wa-wa/nuage-home-sandbox:latest` | `Always` | `"runner"` | 対応済（退役リポジトリ） |

---

## 4. 素のワークロード（Workflow / Job / CronJob / Deployment 等）一覧

### 4.1 設定済み箇所

| リポジトリ | ファイル | 種別 / コンテナ | イメージ | `imagePullPolicy` | 備考 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `pechka` | `k8s/base/etl/workflow.yaml` | `WorkflowTemplate` (5 コンテナ) | `ghcr.io/k-wa-wa/pechka/etl-*:latest` | `Always` | 全 5 テンプレートに設定済 |
| `pechka` | `k8s/base/etl/subtitle-workflow.yaml` | `CronWorkflow` (`subtitle-gen`) | `ghcr.io/k-wa-wa/pechka/etl-subtitle:latest` | `Always` | 設定済 |
| `pechka` | `k8s/base/tech-feed/workflow.yaml` | `CronWorkflow` / `WorkflowTemplate` (2 コンテナ) | `ghcr.io/k-wa-wa/pechka/tech-feed-{collect,produce}:latest` | `Always` | 両テンプレートに設定済 |
| `pechka` | `k8s/overlays/preview/tech-feed-produce-job.yaml` | `Job` (`produce`) | `ghcr.io/k-wa-wa/pechka/tech-feed-produce:latest` | `Always` | 設定済 |
| `nuage-honeytrap` | `k8s/base/cloudflared.yaml` | `Deployment` (`cloudflared`) | `cloudflare/cloudflared:latest` | `Always` | 設定済 |
| `nuage-cluster` | `manifests/apps/searxng/base/deployment.yaml` | `Deployment` (`searxng`) | `searxng/searxng:latest` | `Always` | 設定済 |
| `nuage-cluster` | `manifests/apps/litellm/base/deployment.yaml` | `Deployment` (`litellm`) | `ghcr.io/berriai/litellm:main-latest` | `Always` | floating タグ・設定済 |

### 4.2 要対応候補（別 PR / 後続 Issue で対応）

| リポジトリ | ファイル | 種別 / コンテナ | イメージ | 現在の `imagePullPolicy` | 問題点と推奨対応 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `pechka` | `k8s/base/etl/tests/integration-test-job.yaml` | `Job` (`initContainers[name=load]`) | `ghcr.io/k-wa-wa/pechka/etl-load:latest` | 未設定 | **高優先**: 自前イメージかつ `:latest` で `imagePullPolicy: Always` が欠落。`k8s/base/etl/kustomization.yaml` 未収録のため既存 CI から漏れている。`Always` 明示＋必要に応じ検証対象へ追加する |
| `pechka` | `k8s/base/etl/tests/integration-test-job.yaml` | `Job` (`generate-fixtures`, `migrate`, `verify`) | `python:3.12-alpine`, `postgres:15-alpine` | 未設定 | テスト再現性の観点で、追従するなら `Always`、固定するならパッチ固定タグ + `IfNotPresent` に整理する |
| `pechka` | `k8s/base/infra/minio/mc-job.yaml` | `Job` (`wait-for-minio`, `s3-setup`) | `curlimages/curl:latest` | 未設定 | 新ルールで `WARN` 検出。PreSync 毎回最新取得なら `Always`、安定性・レート制限回避優先ならパッチ固定タグ + `IfNotPresent` に変更する |
| `pechka` | `k8s/overlays/preview/minio-local.yaml` | `Deployment` (`minio`) | `adobe/s3mock:latest` | 未設定 | 新ルールで `WARN` 検出。タグ固定 + `IfNotPresent` または `Always` 明示を検討する |
| `bare-web-proxy` | `k8s/base/deployment.yaml` | `Deployment` (`headless-chrome`) | `chromedp/headless-shell:latest` | `IfNotPresent` | `monitorContainers: "proxy-app"` の対象外であり新ルールでは `WARN` 検出。同一 Deployment 内に自前イメージかつ Keel 監視対象の `proxy-app` が同居するため、リソース単位で効く `nuage.io/ignore-image-pull-policy` は使用してはならない（`proxy-app` の必須チェックまで無効化されるため）。意図的固定なら固定タグ（または digest）へ変更、最新追従なら `Always` 化する。併せて `k8s-validate.yml` 自体が未導入であるため CI 導入を検討する |
| `pechka` | `k8s/base/infra/postgres/migrate-job.yaml` | `Job` (`wait-for-postgres`, `migrate`) | `postgres:16` | 未設定 | floating メジャーバージョンタグ。本番 PostgreSQL のマイナーバージョン整合やキャッシュ挙動に応じ、固定タグ + `IfNotPresent` または `Always` へ整理する |
| `pechka` | `k8s/overlays/preview/seed-from-prod-job.yaml` | `Job` (`wait-for-postgres`, `seed`) | `postgres:16` | 未設定 | 同上（floating メジャーバージョンタグ） |
| `pechka` | `k8s/overlays/preview/postgres/postgres.yaml` | `StatefulSet` (`postgres`) | `postgres:16` | 未設定 | 同上（floating メジャーバージョンタグ） |
| `pechka` | `k8s/base/infra/mongodb/mongodb.yaml` | `StatefulSet` (`mongodb`) | `mongo:7` | 未設定 | 同上（floating メジャーバージョンタグ） |
| `pechka` | `k8s/base/infra/benthos/benthos.yaml` | `Deployment` (`initContainers[name=wait-for-mongodb]`) | `busybox:1.36` | 未設定 | 同上（floating マイナーバージョンタグ） |
| `nuage-cluster` | `manifests/bootstrap/argocd/kustomization.yaml` | `Deployment` (`initContainers[name=download-avp]`) | `alpine:3.22` | 未設定 | 同上（floating マイナーバージョンタグ） |

### 4.3 意図的例外

| リポジトリ | ファイル | 種別 / コンテナ | イメージ | 現在の `imagePullPolicy` | 理由と今後の方針 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `nuage-cluster` | `manifests/apps/preview-isolation-test/base/cronjob.yaml` | `CronJob` (`isolation-test`) | `busybox:latest` | `IfNotPresent` | `nuage-cluster/docs/preview-security.md` にて、15 分毎の CronJob 実行における Docker Hub レート制限および起動遅延を回避するため意図的に `IfNotPresent` を明示している。新ルールでは `WARN` として可視化される。後続で固定タグ化または `nuage.io/ignore-image-pull-policy: "true"` 付与を検討する |

### 4.4 参考: 固定タグ / digest 固定で問題のない箇所

- `nuage-monitoring-stack/k8s/repo-scan/cronjob.yaml`: `alpine/git`, `trivy`, `semgrep`, `python` はすべて `@sha256:...` digest 固定。
- `nuage-monitoring-stack/k8s/ssvc/cronjob.yaml`: `python:3.14.10-slim@sha256:...` digest 固定。
- `pechka/k8s/base/infra/benthos/benthos.yaml` (`benthos`): `redpandadata/connect:4.111.0` + `imagePullPolicy: IfNotPresent`（バージョン固定理由コメントあり）。
- `pechka/k8s/base/infra/nginx/nginx.yaml`: `nginx/nginx-unprivileged:1.30.7-alpine`（パッチバージョン固定）。
- `pechka/k8s/base/infra/elasticsearch/elasticsearch.yaml`: `elasticsearch:8.19.23`（パッチバージョン固定）。
- `nuage-cluster/manifests/apps/keel/base/kustomization.yaml`: `ghcr.io/keel-hq/keel` タグ `0.22.4`（Helm values でパッチバージョン固定）。
- `nuage-cluster/manifests/bootstrap/argocd/kustomization.yaml` (`argocd-vault-plugin-kustomize`): `quay.io/argoproj/argocd:v3.5.7`（パッチバージョン固定）。

---

## 5. 新 Rego ポリシーによる既存マニフェスト検証結果

変更後の `.github/workflows/validate/k8s/run.sh` を各リポジトリの現行アクティブマニフェストに対して実行し、意図しない CI 破壊（新規 `FAIL`）が発生しないことを確認した。

| リポジトリ | 検証コマンド相当 | 終了コード | 新規 `FAIL` | 検出された新規 `WARN`（期待どおり） |
| :-- | :-- | :-- | :-- | :-- |
| `pechka` | `run.sh --prod --yamllint-path k8s k8s/overlays/prod` | `0` | 0 件 | `Job/minio-setup` (`init:wait-for-minio`, `s3-setup`: `curlimages/curl:latest`, `""`) |
| `pechka` | `run.sh --preview k8s/overlays/preview` | `0` | 0 件 | `Deployment/minio` (`adobe/s3mock:latest`, `""`) |
| `nuage-monitoring-stack` | `run.sh --prod --enable-helm --yamllint-path k8s k8s/overlays/prod` | `0` | 0 件 | 0 件 |
| `nuage-monitoring-stack` | `run.sh --preview --enable-helm k8s/overlays/preview` | `0` | 0 件 | 0 件 |
| `nuage-cluster` | `run.sh --prod --enable-helm --yamllint-path manifests 'manifests/apps/*/overlays/prod'` | `0` | 0 件 | `preview-isolation-test/CronJob/preview-isolation-test` (`busybox:latest`, `"IfNotPresent"`) |
| `nuage-cluster` | `run.sh --enable-helm 'manifests/apps/*.yaml'` | `0` | 0 件 | 0 件 |
| `nuage-cluster` | `run.sh --enable-helm --fail-on-policy false manifests/bootstrap/kustomization.yaml` | `0` | 0 件（`imagePullPolicy` 関連） | 0 件（`imagePullPolicy` 関連） |
| `bare-web-proxy`（参考・CI 未導入） | `run.sh k8s/overlays/prod` | 非 0（既存 probe 欠落） | 0 件（`imagePullPolicy` 関連） | `Deployment/bare-web-proxy` `headless-chrome` (`chromedp/headless-shell:latest`, `"IfNotPresent"`) |
| `nuage-honeytrap`（参考・CI 未導入） | `run.sh --prod k8s/overlays/prod` | 非 0（既存 PDB/probe 欠落） | 0 件（`imagePullPolicy` 関連） | 0 件 |
