---
name: review-k8s-manifests
description: Review Kubernetes manifests for Nuage repositories. Use whenever creating, editing, or reviewing Kubernetes YAML, Kustomize overlays, Argo Workflows, or Helm values, especially to enforce imagePullPolicy, Keel annotations, resource limits, probes, prod HA, and preview isolation policies.
---

# Review Kubernetes Manifests Skill

Nuage 配下の各リポジトリで Kubernetes マニフェスト（Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod, Argo `WorkflowTemplate` / `Workflow` / `CronWorkflow`, Kustomize overlay 等）を作成・変更・レビューする際の確認観点を定義する。記述・コメントのチェックでは常体（である・する調）を維持する。

## 1. イメージタグと `imagePullPolicy` の整合性（最重要観点）

1. **Keel 監視対象コンテナには `imagePullPolicy: Always` を必ず明示する**
   - `keel.sh/policy: force`、`keel.sh/trigger: poll`、`keel.sh/matchTag: "true"` 等で Keel が監視するコンテナは、固定タグ・floating タグ・`:latest` を問わず `imagePullPolicy: Always` を必須とする。
   - 理由: `matchTag: "true"` + `force` の運用では、同一タグで新しい digest が push された際に Keel が Pod を再作成する。このとき `imagePullPolicy` が `IfNotPresent` だとノード上のキャッシュ済みイメージがそのまま再利用され、更新が反映されないサイレント障害を引き起こす。
   - **Kustomize / Argo CD によるイメージタグ差し替えの罠**: ベース定義で `:latest` を使い `imagePullPolicy` を省略していると、単体では Kubernetes の既定値により `Always` として動くように見える。しかし Argo CD ApplicationSet の `kustomize.images` や overlay で `:latest` を `:pr-<N>` や `:v1.2.3` に差し替えた瞬間、非 `:latest` タグに対する Kubernetes 既定値（`IfNotPresent`）へ切り替わるため、`imagePullPolicy: Always` は必ず YAML 上に明示する。

2. **自前イメージを使う全ワークロード・全コンテナに `imagePullPolicy: Always` を明示する**
   - `ghcr.io/k-wa-wa/...` 等の自前イメージを使う場合は、Deployment だけでなく StatefulSet / DaemonSet / Job / CronJob / Pod / Argo `WorkflowTemplate` / `Workflow` / `CronWorkflow` の通常コンテナおよび `initContainers` のすべてに `imagePullPolicy: Always` を設定する。

3. **`:latest`・タグ省略・floating タグの扱い**
   - `:latest`、タグ省略（暗黙 `:latest`）、および floating タグ（`:main-latest`, `:16`, `:7`, `:3.22` 等のメジャー/マイナー指定）を使うコンテナは、原則として以下のいずれかに揃える。
     - 最新追従を意図する場合: `imagePullPolicy: Always` を明示する。
     - 再現性やキャッシュを優先する場合: パッチバージョンを含む固定タグ（例: `16.8-alpine`）または不変ダイジェスト（`@sha256:...`）へ固定し、`imagePullPolicy: IfNotPresent` を明示する。
   - Docker Hub レート制限や遅延回避等の明確な理由で `:latest` + `imagePullPolicy: IfNotPresent` を意図的に採用する場合は、理由をマニフェスト内コメント（および設計ドキュメント）に明記し、`nuage.io/ignore-image-pull-policy: "true"` アノテーションで明示的にオプトアウトする。
   - **注意（リソース単位の適用範囲）**: `nuage.io/ignore-image-pull-policy: "true"` はコンテナ単位ではなくリソース（ワークロード）単位で効くため、自前イメージや Keel 監視対象コンテナと同居するワークロードには絶対に付与しない。混在ワークロード内のサードパーティ製サイドカー等で `:latest` 警告を解消したい場合は、オプトアウトではなく固定タグ（または `@sha256:...` digest）への固定、または `imagePullPolicy: Always` の明示で対処する。

## 2. Keel アノテーションの整合性

自前イメージを利用する Deployment（および Keel 更新対象ワークロード）では、以下のアノテーションが意図どおり設定されているか確認する。

- `keel.sh/policy: force`
- `keel.sh/trigger: poll`
- `keel.sh/matchTag: "true"`
- `keel.sh/pollSchedule`: 必要に応じて指定（例: `"@every 2m"`）
- `keel.sh/monitorContainers`: カンマ区切りではなく **Go (RE2) 正規表現** で指定する（複数指定する場合は `app,sidecar` ではなく `^(app|sidecar)$` 等）。監視対象から外したいサードパーティ製サイドカー（例: `headless-chrome`）が同居する場合は、監視対象コンテナ名のみに一致する正規表現を記述し、非対象コンテナの意図を明確にする。

## 3. 既存の共通ポリシーとレビュー項目

マニフェストが `.github/workflows/validate/k8s/` 配下の共通 Rego ポリシーを満たしているか確認する。

- **基本ワークロード要件 (`workload.rego`)**:
  - 全通常コンテナに `resources.requests`（`cpu`, `memory`）と `resources.limits`（`memory`）を設定する（`initContainers` にも設定を推奨）。
  - Deployment / StatefulSet / DaemonSet の全通常コンテナに `readinessProbe` と `livenessProbe` を設定する。
  - やむを得ず除外する場合は `nuage.io/ignore-image-pull-policy`、`nuage.io/ignore-keel`、`nuage.io/ignore-resources`、`nuage.io/ignore-probes` を理由コメント付きで付与する。
- **本番 HA 要件 (`ha.rego`, `prod` 環境)**:
  - RWO/RWOP PVC を使わないステートレス Deployment は `replicas >= 2`（または HPA `minReplicas >= 2`）とし、`topologySpreadConstraints` または `podAntiAffinity`（`topologyKey: kubernetes.io/hostname`）によるノード分散と、無停止ドレインを許容する `PodDisruptionBudget` を用意する。
- **プレビュー環境要件 (`preview.rego`, `preview` 環境)**:
  - `ClusterRole` / `ClusterRoleBinding` / CRD / `DaemonSet` 等のクラスタ全体や他環境に波及するリソースを混入させない。
  - `Namespace` を 1 つだけ含め、Ingress の `spec.rules[0].host`・`spec.tls[0].hosts[0]`・`spec.tls[0].secretName` を定義し、本番ドメイン（`.wpcapp.net` の非 `-pr-` ホストや `.cluster.wpc`）を直書きしない。

## 4. ローカル検証の実行

レビューや変更の最終確認として、必ずローカル検証スクリプトを実行して `kubeconform` / `pluto` / `conftest` / `yamllint` の結果（`FAIL` が 0 件であること、および `WARN` の内容が意図どおりであること）を確認する。

```bash
# nuage-workspace 内の run.sh を使う場合
~/ghq/github.com/k-wa-wa/nuage-workspace/.github/workflows/validate/k8s/run.sh --yamllint-path k8s --prod k8s/overlays/prod
~/ghq/github.com/k-wa-wa/nuage-workspace/.github/workflows/validate/k8s/run.sh --preview k8s/overlays/preview

# 各リポジトリに lint.sh がある場合
./k8s/lint.sh
```
