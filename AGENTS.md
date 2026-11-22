# Nuage Workspace Rules (複数リポジトリ横断管理ガイドライン)

このファイルは、AI Agent が nuage の複数のリポジトリにまたがって DevOps・管理を行う際の、動作ルールと前提条件を定義する。Agent は、コマンド実行やファイル編集の際、これらのルールを厳格に適用しなければならない。

## 1. リポジトリの地図

リポジトリはすべて ghq の置き場所 `~/ghq/github.com/k-wa-wa/<repo>` にある（Mac・atelier 共通）。

- Orca のワークスペースは `~/orca/workspaces/<repo>/<name>` にある git worktree なので、他のリポジトリを `../` で指せない。`~/ghq/github.com/k-wa-wa/<repo>` の絶対パスを使う。
- 以降の章では、リポジトリを名前で指す（例: nuage-cluster の `manifests/`）。場所はこの表のとおり `~/ghq/github.com/k-wa-wa/<名前>` と読み替える。
- 手元に無いリポジトリは `ghq get k-wa-wa/<repo>` で取る。atelier では、Orca にも登録する `orca-get k-wa-wa/<repo>` を使う。
- `nuage.code-workspace` は、VS Code で主なリポジトリを並べて開くためのものである（`~/ghq/github.com/k-wa-wa/nuage-workspace` から `../` で指す）。

| リポジトリ | 役割 | 本番への入り方 |
| :-- | :-- | :-- |
| `nuage-workspace` | 横断のルール（この地図）・スキル・共通の reusable workflow | — |
| `nuage-cluster` | 基盤。Proxmox 上の NixOS（VM・LXC）、Talos の k8s と Argo CD、Terraform / Terragrunt、LB の HAProxy（`nix/hosts/loadbalancer`） | 下の「適用経路」 |
| `nuage-monitoring-stack` | 監視スタックの k8s 資材と、監視用の PWA | Argo CD（nuage-cluster の `manifests/apps/multi-repo-deploy.yaml`） |
| `pechka` | ホームメディア基盤。NAS などからコンテンツを取り込み、ブラウザで閲覧・配信する | Argo CD（`multi-repo-deploy.yaml`。PR のプレビューは `pechka-preview-appset.yaml`） |
| `bare-web-proxy` | 通信量を減らす中継 Web プロキシ（Go + Headless Chrome）。エージェントの検索・ページ取得にも使う | Argo CD（`multi-repo-deploy.yaml`） |
| `nuage-usage-ledger` | メインフレーム（MVS 3.8j）で動く使用量の勘定系（JCL・COBOL・REXX） | nuage-cluster の flake input。mainframe に載る |
| `cicerone3270` | 3270 端末を案内付きで操作する汎用の TUI | nuage-cluster の flake input。mainframe に `ci3270` として入る |
| `nuage-autopilot5` | Orca の窓口から任された仕事を完走させる `autopilot-run` と、全エージェント共通のルール・スキル | nuage-cluster の flake input。atelier に入る |
| `nix-config` | Mac と atelier のユーザー環境（home-manager）と、個人の共通ルール（`modules/home-manager/ai-agent/rules.md`） | Mac は `home-manager switch`。atelier は nuage-cluster の flake input |
| `nuage-autopilot4` | 旧 autopilot（GitHub の Issue / PR 駆動）。nuage-autopilot5 へ移行中 | nuage-cluster の flake input。autopilot-server に入る |

各リポジトリで作業を始める前に、そのリポジトリ直下の `AGENTS.md` を読み、固有のルールと最新のコマンドを把握すること。

---

## 2. GitOps 原則と変更の適用経路

システム全体が GitOps 原則に基づいて管理されている。場当たり的な環境直接の書き換え（例: `kubectl edit` による直接編集）は恒久対応とせず、必ず各ソースコードを変更した上で GitOps 経路にて適用する。

### 適用経路の早見表

| 資材 | 適用経路 |
| :-- | :-- |
| k8s マニフェスト（nuage-cluster の `manifests/`、および各アプリの `k8s/`） | `master` へ push → Argo CD が自動同期 |
| NixOS LXC / VM（nuage-cluster の `nix/`） | `master` へ push → `system.autoUpgrade` が自動適用 |
| nuage-cluster の flake input になっているリポジトリ（上の表） | そのリポジトリを push → nuage-cluster で `nix flake update <input> --flake ./nix` → nuage-cluster を push → autoUpgrade |
| Terraform / Terragrunt（nuage-cluster の `terraform/`） | ユーザーが `terragrunt apply` を実行（AI は plan まで） |

flake input のリポジトリは、push しただけでは本番に入らない。nuage-cluster の `flake.lock` を更新するまでが一つの変更である。

NixOS に効く変更 (nuage-cluster の `nix/`、flake input のリポジトリ) の反映を案内するときは、push と `flake.lock` の更新に続けて、対象ホストで nixos-upgrade を起動して結果を見るところまで、そのまま貼れるコマンドで示す (実行はユーザーが行う)。
コマンドと、複数台のホストの順番は nuage-cluster の AGENTS.md の「適用経路」に従う。

---

## 3. 複数リポジトリ間の依存関係と運用ルール

リポジトリを跨ぐ変更を行う場合、以下の依存関係を考慮して順序よく作業を進めること。

1. **アプリ変更とマニフェストの追従**:
   - アプリケーション（`pechka` 等）でポート、コンテキストパス、環境変数などの定義を変更した場合は、必ず nuage-cluster 側のマニフェスト（Deployment や Service, Ingress 定義など）に反映させる。
2. **監視設定の追従**:
   - サービスを追加・変更した際は、nuage-monitoring-stack のスクレイプ対象・アラートルール・ダッシュボードが追従できているか確認する。
3. **ルーティングの追従**:
   - ルーティングや SSL/TLS の変更時は、nuage-cluster の LB（`nix/hosts/loadbalancer` の HAProxy）と k8s の Ingress の整合性を保つ。
4. **flake input の契約**:
   - nuage-usage-ledger の `nix build` の出力は、nuage-cluster の `nix/hosts/mainframe/mvs-config.nix` との約束事である。形を変えるときは両方を合わせて変える。
   - nuage-autopilot5・nix-config の NixOS / home-manager モジュールのオプションを変えたら、nuage-cluster の `nix/hosts/atelier/` を合わせて変える。

---

## 4. Skills (スキル) の参照

- 本リポジトリの `.agents/skills/` に定義されている横断DevOpsスキルの他、nuage-cluster の `.agents/skills/` などの個別リポジトリに配置されているスキルも必要に応じて読み込み、実行手順の参考にすること。

---

## 5. 共通 GitHub Actions Reusable Workflow

`nuage-workspace` は、複数リポジトリで共通利用する GitHub Actions Reusable Workflow および OPA/Conftest ポリシーを提供する。詳細は [docs/shared-ci.md](docs/shared-ci.md) を参照すること。

### 5.1. `docker-build-push.yml`（Docker ビルド・Trivy スキャン・GHCR Push）

`.github/workflows/docker-build-push.yml` は、Docker イメージのローカルビルド（`load: true`）、Trivy による脆弱性スキャン、GHCR への push、PR プレビューコメントの投稿をまとめた reusable workflow である。

- 呼び出し側のワークフローには `permissions: contents: read / packages: write / pull-requests: write` を明示する必要がある。
- デフォルトで `scan-severity: "CRITICAL"`・`ignore-unfixed: true` により Trivy スキャンを実行し、該当脆弱性を検出した場合は GHCR への push と PR コメント投稿をブロックする。
- `HIGH` 以下などブロック対象外の脆弱性はブロックせず、GitHub Actions Step Summary（`$GITHUB_STEP_SUMMARY`）に集計表と警告一覧を出力する。
- 呼び出し側リポジトリ直下に `.trivyignore` が存在する場合に自動適用する（未存在でもエラーにならない）。

主な入力パラメータ:

| パラメータ | 既定値 | 説明 |
| :-- | :-- | :-- |
| `image` | （必須） | push 先イメージ名（例: `ghcr.io/owner/repo`） |
| `context` | `"."` | `docker build` のビルドコンテキスト |
| `file` | `""` | Dockerfile パス（空の場合は `context` 直下） |
| `scan-severity` | `"CRITICAL"` | push をブロックする Trivy 重大度（カンマ区切り） |
| `ignore-unfixed` | `true` | 修正パッチが存在しない脆弱性を無視するか |
| `trivy-ignore-file` | `".trivyignore"` | `.trivyignore` のパス（存在する場合のみ適用） |
| `require-same-repo-pr` | `true` | fork からの PR をスキップするか |
| `pr-comment-marker` / `pr-comment-body` | `""` | PR プレビューコメントのマーカーおよび本文 |

### 5.2. `k8s-validate.yml`（Kubernetes マニフェスト検証・標準化）

`.github/workflows/k8s-validate.yml` は、`yamllint`・`kustomize build`・`kubeconform`・`pluto` および `policies/k8s/` の OPA/Conftest ポリシーによる k8s マニフェスト検証をまとめた reusable workflow である。

```yaml
jobs:
  validate-k8s:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
    with:
      yamllint-path: "k8s"
      prod-overlays: "k8s/overlays/prod"
      preview-overlays: "k8s/overlays/preview"
```

主な入力パラメータ:

| パラメータ | 既定値 | 説明 |
| :-- | :-- | :-- |
| `yamllint-path` | `"k8s"` | `yamllint` の対象パス（空でスキップ、`.yamllint` 未配置時は既定設定を使用） |
| `prod-overlays` | `"k8s/overlays/prod"` | `prod` として検証する Kustomize オーバーレイ（カンマ/改行区切り） |
| `preview-overlays` | `"k8s/overlays/preview"` | `preview` として検証する Kustomize オーバーレイ（カンマ/改行区切り） |
| `enable-helm` | `false` | `kustomize build` に `--enable-helm` を付与するか |
| `own-image-prefixes` | `"ghcr.io/k-wa-wa/"` | 自前イメージプレフィックス（カンマ区切り） |
| `exclude-helm-managed` | `true` | Helm 管理サードパーティリソースをワークロード品質ルールから除外するか |
| `fail-on-policy` | `true` | Conftest 違反時に失敗させるか（`false` で警告サマリのみ出力） |
| `policy-ref` | `"master"` | ポリシー定義を取得する `nuage-workspace` の ref |

ポリシー体系（`policies/k8s/`）とオプトアウトアノテーション:

- **共通（`prod` / `preview`）**: 自前イメージへの `imagePullPolicy: Always`、自前イメージ利用 Deployment への `keel.sh/*` アノテーション（`policy: force`, `trigger: poll`, `matchTag: "true"`, `monitorContainers` 正規表現一致）、メインコンテナの `resources.requests`/`limits`、常駐ワークロード（Deployment / StatefulSet / DaemonSet）への `readinessProbe`/`livenessProbe`。
- **`preview` のみ**: クラスタ全体・他環境へ波及するリソース（`ClusterRole`, `ClusterRoleBinding`, `CustomResourceDefinition`, `VMRule`, `DaemonSet` 等）の禁止、`Namespace` 単一性、外部 SA を指す `RoleBinding.subjects[].namespace` 不整合禁止、`Ingress` の ApplicationSet 置換前提構造および本番ホスト直書き禁止。
- **`prod` のみ**: ステートレス Deployment への `replicas >= 2`、ノード分散（`topologySpreadConstraints` または `podAntiAffinity` の `kubernetes.io/hostname`）、無停止許容 `PodDisruptionBudget` の存在。`ReadWriteOnce` PVC を参照するワークロードは自動除外する。
- **オプトアウト用アノテーション（`metadata.annotations` に `"true"` を設定）**: `nuage.io/ignore-ha`, `nuage.io/ignore-probes`, `nuage.io/ignore-resources`, `nuage.io/ignore-keel`, `nuage.io/ignore-image-pull-policy`, `nuage.io/allow-in-preview`。

---

## 6. 制約事項

- **SOPS操作の禁止**:
  特別な指示がない限り、SOPS を用いたシークレットファイルの作成・編集・復号は実行しないこと。ユーザーにファイルの作成や編集を促すこと。
- **Terraform, Terragrunt操作の禁止**:
  特別な指示がない限り、Terraform, Terragrunt の操作は実行しないこと。ユーザーに操作を促すこと。
- **言い切り調の使用**:
  コメントアウトやドキュメントを記述する際は、です・ます調（敬体）を避け、である・する調（常体）の言い切りを使用すること。
