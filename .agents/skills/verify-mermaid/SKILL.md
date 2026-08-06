---
name: verify-mermaid
description: Verify Mermaid diagram syntax in Markdown files. Use this skill whenever editing or creating Markdown files containing Mermaid code blocks.
---

# Verify Mermaid Skill

Markdown ファイルに含まれる Mermaid 図の構文エラーを `@mermaid-js/mermaid-cli` を用いて検証する手順である。

## 検証手順

Markdown ファイルを作成・更新した際、以下のコマンドで Mermaid 構文のビルドテストを実施する。

```bash
npx -y @mermaid-js/mermaid-cli -i <path/to/file.md> -o /tmp/mermaid_test.svg
```

### 注意点・エラー発生時の対応
1. ノードラベル内で `()` や `{}`、日本語、特殊文字を使う場合は、`id["ラベル名 (補足)"]` のようにダブルクォーテーションで囲む。
2. `<br/>` や HTML タグが含まれる場合も引用符 `""` を忘れないこと。
3. エラーが出力された場合、指示された行数と構文エラーを確認して修正し、再度検証コマンドを実行する。
4. 検証完了後、一時出力ファイル `/tmp/mermaid_test.svg` は削除する。
