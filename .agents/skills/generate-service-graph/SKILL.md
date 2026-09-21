---
name: generate-service-graph
description: Generate Mermaid service dependency graphs and catalog tables by scanning Ingress, Service, ApplicationSet, and ConfigMap across repositories, and embed them into Markdown documentation.
---

# Generate Service Graph Skill

各リポジトリ（`nuage-cluster`, `bare-web-proxy`, `pechka`, `nuage-monitoring-stack`）の Kubernetes マニフェスト（Ingress, Service, EndpointSlice, ApplicationSet, ConfigMap）を静的解析し、サービス間依存図（Mermaid）とサービスカタログ表を自動生成して `docs/service-graph.md` 等のドキュメントへ出力・埋め込む手順である。

## 実行コマンド

`nuage-workspace` ルートで以下のコマンドを実行する。

```bash
bun run .agents/skills/generate-service-graph/scripts/generate.ts
```

### オプション

- `--dry-run`: ファイル更新を行わず、生成された Mermaid コードと Markdown テーブルを標準出力に表示する
- `--target <path>`: 出力先の Markdown ファイルを指定する（デフォルト: `docs/service-graph.md`）

```bash
# プレビュー表示
bun run .agents/skills/generate-service-graph/scripts/generate.ts --dry-run

# 特定のファイルを対象に更新
bun run .agents/skills/generate-service-graph/scripts/generate.ts --target README.md
```

## ドキュメント埋め込みの仕組み

対象 Markdown ファイル内の以下のマーカーコメント間が自動生成コンテンツで置換される（ファイルが存在しない場合は新規作成される）。

```markdown
<!-- BEGIN:AUTOGEN_SERVICE_GRAPH -->
（ここに Mermaid 図およびサービスカタログ表が自動生成される）
<!-- END:AUTOGEN_SERVICE_GRAPH -->
```

## 検証手順 (`verify-mermaid` スキルの併用)

ドキュメント更新後、必ず `verify-mermaid` スキルに従って構文検証を実施する。

```bash
npx -y @mermaid-js/mermaid-cli -i docs/service-graph.md -o /tmp/service_graph_test.svg
rm -f /tmp/service_graph_test*
```

構文エラーがないことを確認し、生成された一時ファイルを削除する。

## 発動タイミング

以下のような変更が発生した際に本スキルを実行する。

1. 新規サービスの追加、または既存 Ingress / Service のドメイン・ポート変更時
2. `external-service` による外部 NixOS VM/LXC やミドルウェアの接続先変更時
3. サービス間の通信経路（プロキシ接続、外部 API 呼び出し等）の追加・変更時
4. リポジトリ横断のドキュメント（`CLAUDE.md`, `README.md`）の整合性確認時
