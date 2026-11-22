# 共通 GitHub Actions Reusable Workflow リファレンス

本ドキュメントは、`nuage-workspace` が提供する共通 GitHub Actions Reusable Workflow（`.github/workflows/docker-build-push.yml` および `.github/workflows/k8s-validate.yml`）と OPA/Conftest ポリシー（`policies/k8s/`）の詳細仕様を定める。

---

## 1. `docker-build-push.yml`（コンテナイメージビルド・スキャン・Push）

### 1.1. 処理フロー

1. **タグ決定**: `pull_request` イベント時は `:pr-<N>` と `:sha-<head_sha>`、既定ブランチへの `push` イベント時は `:latest` と `:sha-<sha>` を付与する。
2. **ローカルビルド**: `docker/build-push-action@v5` を `push: false`・`load: true` で実行し、ローカル Docker デーモンへイメージをロードする（GHA ビルドキャッシュは維持）。
3. **Trivy 脆弱性スキャン（可視化＋ゲート）**:
   - リポジトリ直下（または `trivy-ignore-file` 指定パス）に `.trivyignore` が存在する場合のみ `trivyignores` に渡す。存在しない場合もエラーにしない。
   - 全重大度（`UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL`）の JSON レポートを取得し、`$GITHUB_STEP_SUMMARY` に重大度別集計表およびブロック対象外（例: `HIGH` 以下）の警告 CVE 一覧を出力する。
   - 続いて `scan-severity`（既定値 `CRITICAL`）および `ignore-unfixed`（既定値 `true`）でゲート検査（`exit-code: "1"`）を実行する。
4. **GHCR Push・PR コメント**:
   - スキャン合格後のみ GHCR へログインし、各タグを `docker push` する。
   - スキャン不合格時は push も PR プレビューコメント投稿も実行しない。

### 1.2. 入力パラメータ

| パラメータ | 型 | 既定値 | 説明 |
| :-- | :-- | :-- | :-- |
| `image` | string | （必須） | push 先イメージ名（例: `ghcr.io/k-wa-wa/pechka-api`） |
| `context` | string | `"."` | `docker build` のビルドコンテキスト |
| `file` | string | `""` | Dockerfile のパス。空の場合は `context` 直下の `Dockerfile` を使用する |
| `require-same-repo-pr` | boolean | `true` | fork からの PR でジョブをスキップするか |
| `pr-comment-marker` | string | `""` | PR コメントの検索・更新に使うマーカー文字列。空でコメント投稿を省略する |
| `pr-comment-body` | string | `""` | PR に投稿するコメント本文（Markdown） |
| `scan-severity` | string | `"CRITICAL"` | push をブロックする Trivy 脆弱性重大度（カンマ区切り、例: `"CRITICAL,HIGH"`） |
| `ignore-unfixed` | boolean | `true` | 修正パッチが存在しない脆弱性を無視するか |
| `trivy-ignore-file` | string | `".trivyignore"` | `.trivyignore` ファイルのパス。存在する場合のみ適用する |

### 1.3. 呼び出し例

```yaml
permissions:
  contents: read
  packages: write
  pull-requests: write

jobs:
  docker-build-push:
    uses: k-wa-wa/nuage-workspace/.github/workflows/docker-build-push.yml@master
    with:
      context: ./api
      image: ghcr.io/${{ github.repository }}-api
      # 厳格化する場合は CRITICAL,HIGH 等を指定する
      # scan-severity: "CRITICAL,HIGH"
```

---

## 2. `k8s-validate.yml`（Kubernetes マニフェスト検証・標準化）

### 2.1. 検証パイプライン

1. **YAML リント（`yamllint`）**: `yamllint-path`（既定 `k8s`）が存在する場合に実行する。呼び出し側に `.yamllint` / `.yamllint.yml` / `.yamllint.yaml` が無い場合はワークフロー内蔵のフォールバック設定を適用する。
2. **Kustomize ビルド（`kustomize build`）**: `prod-overlays`・`preview-overlays` に指定された各オーバーレイ（存在するディレクトリのみ）をレンダリングする。`enable-helm: true` 指定時は `--enable-helm` を付与する。
3. **スキーマ検証（`kubeconform`）**: `-strict -ignore-missing-schemas` および Datree `CRDs-catalog` を参照してリソース定義を検証する。
4. **非推奨 API 検出（`pluto`）**: 廃止予定または削除済みの Kubernetes API バージョンを検出する。
5. **Nuage 標準ポリシー検査（`conftest`）**: `policies/k8s/` の Rego ポリシーを `--combine` モードで適用し、結果を `$GITHUB_STEP_SUMMARY` に出力する。

### 2.2. 入力パラメータ

| パラメータ | 型 | 既定値 | 説明 |
| :-- | :-- | :-- | :-- |
| `yamllint-path` | string | `"k8s"` | `yamllint` 対象パス（空文字でスキップ） |
| `prod-overlays` | string | `"k8s/overlays/prod"` | `prod` 環境として検証するオーバーレイパス（カンマまたは改行区切り） |
| `preview-overlays` | string | `"k8s/overlays/preview"` | `preview` 環境として検証するオーバーレイパス（カンマまたは改行区切り） |
| `enable-helm` | boolean | `false` | `kustomize build --enable-helm` を有効にするか |
| `own-image-prefixes` | string | `"ghcr.io/k-wa-wa/"` | 自前イメージと判定するプレフィックス（カンマ区切り） |
| `exclude-helm-managed` | boolean | `true` | Helm 管理サードパーティリソースをワークロード品質ルールから除外するか |
| `fail-on-policy` | boolean | `true` | Conftest 違反時にジョブを失敗させるか（`false` で警告サマリのみ出力して成功終了） |
| `policy-ref` | string | `"master"` | `k-wa-wa/nuage-workspace` からポリシーを取得する Git ref |
| `require-same-repo-pr` | boolean | `true` | fork からの PR でジョブをスキップするか |

### 2.3. 呼び出し例

標準構成（`pechka` / `bare-web-proxy` 等）:

```yaml
permissions:
  contents: read

jobs:
  validate-k8s:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
```

Helm チャートを含むリポジトリ（`nuage-monitoring-stack` 等）および段階移行時の warn-only 設定例:

```yaml
jobs:
  validate-k8s:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
    with:
      enable-helm: true
      fail-on-policy: false
```

---

## 3. OPA / Conftest ポリシー一覧（`policies/k8s/`）

### 3.1. 共通ルール（`prod` / `preview` 双方で必須）

| ファイル | 種別 | 内容 |
| :-- | :-- | :-- |
| `workload.rego` | `deny` | 自前イメージ（`own_image_prefixes` 一致）を使う全コンテナ（`initContainers` および `WorkflowTemplate` / `CronWorkflow` / `Workflow` 含む）に `imagePullPolicy: Always` を必須とする |
| `workload.rego` | `deny` | 自前イメージを使う `Deployment` に `keel.sh/policy`, `keel.sh/trigger`, `keel.sh/matchTag: "true"`, `keel.sh/monitorContainers`（全自前イメージ利用コンテナ名を含むこと）を必須とする。`CronJob`・`Job`・`WorkflowTemplate` 等は対象外である |
| `workload.rego` | `deny` | 全メインコンテナ（`Deployment` / `StatefulSet` / `DaemonSet` / `Job` / `CronJob` / `Pod` / Argo Workflows）に `resources.requests`（`cpu`, `memory`）および `resources.limits`（`memory`）を必須とする |
| `workload.rego` | `warn` | `initContainers` に `resources.requests` / `limits` が未設定の場合に警告を出力する |
| `workload.rego` | `deny` | 常駐ワークロード（`Deployment` / `StatefulSet` / `DaemonSet`）の全コンテナに `readinessProbe` と `livenessProbe` を必須とする |

### 3.2. `preview` 専用ルール（`env == "preview"`）

| ファイル | 種別 | 内容 |
| :-- | :-- | :-- |
| `preview.rego` | `deny` | クラスタ全体または他環境へ波及するリソース（`ClusterRole`, `ClusterRoleBinding`, `CustomResourceDefinition`, `PriorityClass`, `MutatingWebhookConfiguration`, `ValidatingWebhookConfiguration`, `StorageClass`, `PersistentVolume`, `IngressClass`, `ClusterIssuer`, `DaemonSet`, `VMRule`, `VMAlert`, `VMAlertmanager`, `VMAgent`, `VMServiceScrape`, `VMPodScrape`, `VMProbe`, `VMNodeScrape`, `VMStaticScrape`, `VMScrapeConfig`, `PrometheusRule`, `ServiceMonitor`, `PodMonitor`）の混入を禁止する |
| `preview.rego` | `deny` | Argo CD ApplicationSet の置換・自動削除対象となる `Namespace` リソースがちょうど 1 つ存在することを必須とする |
| `preview.rego` | `deny` | `RoleBinding` の `subjects[].namespace` が `preview` の `Namespace` 名と不整合な場合を禁止する |
| `preview.rego` | `warn` | 名前空間スコープリソースの `metadata.namespace` が `preview` の `Namespace` 名と異なる固定値になっている場合に警告を出力する |
| `preview.rego` | `deny` | `Ingress` が ApplicationSet の JSON Patch 置換対象（`spec.rules[0].host`, `spec.tls[0].hosts[0]`, `spec.tls[0].secretName`）を備えていない場合、または `*.wpcapp.net`（`-pr-` を除く）/ `*.cluster.wpc` の本番ホスト名が直書きされている場合を禁止する |

### 3.3. `prod` 専用ルール（`env == "prod"`）

対象: ステートレス `Deployment`（`ReadWriteOnce` / `ReadWriteOncePod` PVC 参照ワークロードおよびオプトアウト対象を除く）

| ファイル | 種別 | 内容 |
| :-- | :-- | :-- |
| `ha.rego` | `deny` | `spec.replicas >= 2`（または対象 Deployment を指す `HorizontalPodAutoscaler` の `minReplicas >= 2`）を必須とする |
| `ha.rego` | `deny` | `topologySpreadConstraints` または `affinity.podAntiAffinity` において `topologyKey: kubernetes.io/hostname` によるノード分散設定を必須とする |
| `ha.rego` | `deny` | 対象 Deployment の Pod ラベルに一致する `PodDisruptionBudget` の存在と無停止・ドレイン許容設定（`minAvailable >= 1` かつ `< replicas`、または `maxUnavailable >= 1` かつ `< replicas`、あるいは `"0%"`/`"100%"` 以外のパーセント指定）を必須とする |

### 3.4. 除外・オプトアウト仕様

#### 自動除外
1. **`ReadWriteOnce` PVC 参照ワークロード**: `Deployment` が同一 Kustomize ビルド内の `ReadWriteOnce` または `ReadWriteOncePod` の `PersistentVolumeClaim` をマウントしている場合、`ha.rego` の可用性ルール（`replicas >= 2`・ノード分散・`PDB`）から自動除外する。
2. **Helm 管理サードパーティリソース**: `helm.sh/chart` ラベルまたは `app.kubernetes.io/managed-by: Helm` ラベルを持ち、かつ自前イメージを使用していないリソースは、`exclude_helm_managed: true`（既定）のときワークロード品質ルール・`prod` HA ルールから除外する。`preview` 環境での危険リソース混入チェックは Helm 由来でも除外しない。

#### 明示的オプトアウトアノテーション
`metadata.annotations` に文字列 `"true"` を設定することで、意図的な例外ワークロードをルールごとに除外できる。

| アノテーション | 効果 | 主な用途 |
| :-- | :-- | :-- |
| `nuage.io/ignore-ha: "true"` | `prod` HA ルール（replicas / 分散 / PDB）を除外する | 外部定義の RWO PVC 参照 Deployment や単一稼働前提の特殊ワークロード |
| `nuage.io/ignore-probes: "true"` | `readinessProbe` / `livenessProbe` チェックを除外する | HTTP/TCP ヘルスチェックを持たない特殊常駐コンテナ |
| `nuage.io/ignore-resources: "true"` | `resources.requests` / `limits` チェックを除外する | 上流マニフェストをそのまま利用しパッチ不要な例外リソース |
| `nuage.io/ignore-keel: "true"` | `keel.sh/*` アノテーションチェックを除外する | Argo CD のイメージタグ上書きのみで運用し Keel 自動更新を使わない Deployment |
| `nuage.io/ignore-image-pull-policy: "true"` | `imagePullPolicy: Always` チェックを除外する | イミュータブルタグ固定で運用する特殊ワークロード |
| `nuage.io/allow-in-preview: "true"` | `preview` 禁止リソースチェックを除外する | preview 環境に特別に許可するクラスタ／監視関連リソース |

---

## 4. ローカル検証コマンド

ポリシーのユニットテスト実行:

```bash
opa test policies/k8s -v
conftest verify -p policies/k8s
```

他リポジトリの Kustomize オーバーレイに対するドライラン例:

```bash
kustomize build ~/ghq/github.com/k-wa-wa/pechka/k8s/overlays/prod > /tmp/rendered.yaml
conftest test --combine --all-namespaces \
  -p policies/k8s \
  -d <(echo '{"env":"prod","own_image_prefixes":["ghcr.io/k-wa-wa/"],"exclude_helm_managed":true}') \
  /tmp/rendered.yaml
```
