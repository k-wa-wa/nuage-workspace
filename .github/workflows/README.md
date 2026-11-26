# 共通 GitHub Actions ワークフロー

各リポジトリから `workflow_call` で呼び出す共通 Reusable Workflow 群である。詳細な入力パラメータや検証ルールは各ワークフロー定義および [validate/k8s/](validate/k8s/)・[validate/ui/](validate/ui/) を参照すること。

## 一覧

| ファイル | 役割 |
| :-- | :-- |
| `docker-build-push.yml` | Docker イメージのビルド、Trivy 脆弱性スキャン（合格時のみ GHCR へ push）、PR プレビューコメント投稿 |
| `k8s-validate.yml` | Kustomize ビルド、`yamllint` / `kubeconform` / `pluto` 検証、Conftest（Rego）による k8s 標準ポリシー検査 |
| `ui-validate.yml` | Stylelint と AST スキャナによる Nuage UI 設計標準（生カラー禁止・`:hover` ガード・エントリ CSS トークン/ガードレール）検査 |
| `ci.yml` | このリポジトリ内の Rego ポリシーテスト、UI lint テスト、`shellcheck`、ワークフロー YAML の lint（他リポジトリからは呼ばない） |

## 使い方

### `docker-build-push.yml`

呼び出し側には `contents: read`・`packages: write`・`pull-requests: write` の権限が必要である。

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
```

### `k8s-validate.yml`

`targets` に渡した対象（Kustomize ディレクトリ、`kustomization.yaml(.yml)` / `Kustomization`、単体 YAML ファイル、非 Kustomize フォルダ、glob パターン）を自動判別し、標準チェック（`kubeconform` / `pluto` / `keel.rego` / `resources.rego` / `probes.rego`、および `yamllint-path` 指定時は `yamllint`）を実行する。さらに `prod: true` で `ha.rego`、`preview: true` で `preview.rego` を追加適用できる（`prod` と `preview` の同時指定は不可）。

```yaml
permissions:
  contents: read

jobs:
  validate-prod:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
    with:
      targets: "k8s/overlays/prod"
      prod: true
      yamllint-path: "k8s"

  validate-preview:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
    with:
      targets: "k8s/overlays/preview"
      preview: true
```

複数ターゲットを混在させる場合は `targets` にカンマまたは改行区切りで並べる（既存プロジェクトで段階的に導入する場合は `fail-on-policy: false` や `nuage.io/ignore-*` アノテーションと併用する）。

```yaml
jobs:
  validate-common:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
    with:
      enable-helm: true
      yamllint-path: "manifests"
      fail-on-policy: false
      targets: |
        manifests/bootstrap/kustomization.yaml
        manifests/apps/*.yaml
```

#### ローカル実行（各リポジトリの `k8s/lint.sh`）

同じ検証処理をローカルの `k8s/lint.sh` からも実行できる。手元に `nuage-workspace` がある場合はローカルの [run.sh](validate/k8s/run.sh) を使い、無い場合は `master` から一時取得する。

```bash
#!/usr/bin/env nix-shell
#!nix-shell -i bash -p kustomize kubeconform pluto conftest jq yamllint -I nixpkgs=channel:nixpkgs-unstable
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

LOCAL_RUNNER="${HOME}/ghq/github.com/k-wa-wa/nuage-workspace/.github/workflows/validate/k8s/run.sh"
if [ -x "$LOCAL_RUNNER" ]; then
  RUNNER="$LOCAL_RUNNER"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -sSfL "https://github.com/k-wa-wa/nuage-workspace/archive/refs/heads/master.tar.gz" \
    | tar -xz -C "$TMP_DIR" "nuage-workspace-master/.github/workflows/validate/k8s"
  RUNNER="${TMP_DIR}/nuage-workspace-master/.github/workflows/validate/k8s/run.sh"
fi

# 例: "$RUNNER" --yamllint-path k8s --prod k8s/overlays/prod
# 例: "$RUNNER" --preview k8s/overlays/preview
# 例: "$RUNNER" manifests/bootstrap/kustomization.yaml manifests/apps/*.yaml
"$RUNNER" --prod k8s/overlays/prod
```

### `ui-validate.yml`

`target-dir` 配下の `.css` / `.tsx` / `.ts` / `.jsx` / `.js`（既定で `*.test.*`, `*.spec.*`, `*.stories.*`, `*.config.*`, `*.d.ts`, `e2e/`, `mocks/`, `public/`, `.storybook/`, `tests/`, `node_modules/`, `.next/`, `dist/` 等を除外）を対象に、生カラー直書き禁止・`:hover` の `@media (hover: hover)` ラップ必須・`entry-css` 指定時の必須トークンとモバイル/アクセシビリティガードレールを検証する。

```yaml
permissions:
  contents: read

jobs:
  validate-ui:
    uses: k-wa-wa/nuage-workspace/.github/workflows/ui-validate.yml@master
    with:
      target-dir: "frontend"
      entry-css: "app/globals.css"
```

既存リポジトリへ段階導入する場合は `fail-on-policy: false` や `exclude`、行末・直前行コメント（`nuage-ui-ignore-color`, `nuage-ui-ignore-hover`）を併用する。

```yaml
jobs:
  validate-ui:
    uses: k-wa-wa/nuage-workspace/.github/workflows/ui-validate.yml@master
    with:
      target-dir: "frontend"
      entry-css: "app/globals.css"
      exclude: |
        legacy/**
      fail-on-policy: false
```

#### ローカル実行

```bash
LOCAL_RUNNER="${HOME}/ghq/github.com/k-wa-wa/nuage-workspace/.github/workflows/validate/ui/run.sh"
if [ -x "$LOCAL_RUNNER" ]; then
  RUNNER="$LOCAL_RUNNER"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -sSfL "https://github.com/k-wa-wa/nuage-workspace/archive/refs/heads/master.tar.gz" \
    | tar -xz -C "$TMP_DIR" "nuage-workspace-master/.github/workflows/validate/ui"
  RUNNER="${TMP_DIR}/nuage-workspace-master/.github/workflows/validate/ui/run.sh"
fi

"$RUNNER" --entry-css app/globals.css frontend
```
