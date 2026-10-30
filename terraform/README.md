# nuage GitHub リソース管理 (Terraform / Terragrunt)

## 認証方針

セキュリティ（静的クレデンシャルの放置防止）と運用の手軽さを両立するため、**GitHub CLI (`gh`) の Web ログイン（ブラウザ起動 + パスキー認証）による一時認証**を採用する。

Terraform（GitHub Provider）は環境変数 `GITHUB_TOKEN` を自動参照するため、設定ファイルへのトークンの書き込みは不要である。

## 作業手順

### 1. 一時認証（ブラウザ起動 & パスキー認証）

作業開始時に `gh` で Web ログインを行う。ブラウザが開き、Touch ID / パスキー等で認証する。

```bash
gh auth login --web -s repo
```

### 2. 計画・適用の実行

`gh auth token` から取得した一時トークンを環境変数に渡して実行する。

```bash
# Plan の確認
GITHUB_TOKEN=$(gh auth token) terragrunt plan

# 変更の適用
GITHUB_TOKEN=$(gh auth token) terragrunt apply
```

### 3. 作業終了（トークンの破棄）

作業完了後は `gh auth logout` を実行し、セッションと一時トークンを破棄する。

```bash
gh auth logout -h github.com
unset GITHUB_TOKEN
```
