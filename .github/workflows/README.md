# 共通 GitHub Actions ワークフロー

各リポジトリから `workflow_call` で呼び出す共通 Reusable Workflow 群である。詳細な入力パラメータや検証ルールは各ワークフロー定義および [validate/k8s/](validate/k8s/) を参照すること。

## 一覧

| ファイル | 役割 |
| :-- | :-- |
| `docker-build-push.yml` | Docker イメージのビルド、Trivy 脆弱性スキャン（合格時のみ GHCR へ push）、PR プレビューコメント投稿 |
| `k8s-validate.yml` | Kustomize ビルド、`yamllint` / `kubeconform` / `pluto` 検証、Conftest（Rego）による k8s 標準ポリシー検査 |
| `ci.yml` | このリポジトリ内の Rego ポリシーテストとワークフロー YAML の lint（他リポジトリからは呼ばない） |

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

`prod`・`preview` それぞれの Kustomize オーバーレイを検証する。

```yaml
permissions:
  contents: read

jobs:
  validate-k8s:
    uses: k-wa-wa/nuage-workspace/.github/workflows/k8s-validate.yml@master
    with:
      yamllint-path: "k8s"
      prod-overlays: "k8s/overlays/prod"
      preview-overlays: "k8s/overlays/preview"
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

# 必要に応じて環境変数（PROD_OVERLAYS / PREVIEW_OVERLAYS / YAMLLINT_PATH 等）や引数を指定する
"$RUNNER"
```
