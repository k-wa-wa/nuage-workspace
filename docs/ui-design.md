# Nuage UI 設計標準・デザインシステム原則

本ドキュメントは、Nuage エコシステム（`nuage-autopilot4`, `nuage-monitoring-stack`, `pechka` 等）において提供される Web UI および PWA の設計哲学、デザイントークン体系の考え方、およびコンポーネントの責任分離を定義する。

---

## 1. デザイン哲学（北極星）

- **「ミニマルで高密度な開発者コックピット × 洗練された触覚フィードバック（Liquid / Fluid）」**
- 派手な装飾や不要なグラデーションに頼らず、美しいタイポグラフィ、正確な余白、そして押した瞬間の心地よい物理フィードバック（弾性スプリング）で語るクラフトマンシップを追求する。
- スマホ（片手操作・スキマ時間での瞬時把握）とデスクトップ（一発俯瞰・集中操作）の双方で摩擦のない体験を提供する。
- 各プロダクトを横断したときに、単一の調和した OS／コックピットを操作している一貫性を保つ。

---

## 2. デザイントークン体系（Design Tokens）

すべてのデザイン値（色・余白・フォント・モーション・角丸）は CSS 変数（トークン）として宣言的に定義し、コンポーネント側での生値の直書きを禁止する。

### 2.1. カラーパレット（セマンティック定義）

Nuage の UI は**ダークテーマ専用**とし、ライトモードは原則サポートしない（ダークテーマを前提としたコントラスト・視認性設計に一本化する）。

- **ベースカラー**:
  - `--bg`: アプリケーション全体の背景色（`#191816`）
  - `--fg`: 基本テキスト色（`#e8e4dc`）
  - `--card`: カード・パネル背景色（`#211f1c`）
  - `--line`: 境界線（ボーダー）色（`#2f2d29`）
  - `--muted`: 補助テキスト・不活性要素色（`#98928a`）
- **セマンティック・状態カラー**:
  - `--accent`: 主アクション・フォーカス・リンク色（`#60a5fa`）
  - `--warn`: エラー・警告・障害色（`#e0a08a`）
  - `--success`: 完了・成功インジケータ色（`#10b981`）
  - `--blocked`: 保留・待機インジケータ色（`#f59e0b`）
- **半透明（Alpha）パターンの基準階層と命名規約**:
  透過率の直書き（`rgba`）による乱立を防ぐため、以下の 3 段階に集約し `--<token>-subtle` / `--<token>-emphasis` / `--<token>-border` としてトークン化する（対象: `accent`, `warn`, `muted`, `success`, `blocked`）。
  - **弱（`--*-subtle`, ~8%）**: バッジ・カード背景、不活性チップ
  - **中（`--*-emphasis`, ~16%）**: ホバー時背景、選択中アイテム
  - **強（`--*-border`, ~25%）**: 有色枠線、フォーカスリング背景

### 2.2. スペーシング（4px / 8px グリッドシステム）

余白（padding, margin, gap）は 4px / 8px の倍数に厳格に統一する。変則的な数値（5px, 7px, 13px 等）は原則許容しない。

- `4px`: 極小（バッジ内部、アイコンとテキストの隙間）
- `8px`: 小（カード内要素間、チップ間隔、ボタン内パディング）
- `12px`: 中小（カードヘッダー、モーダル内セクション）
- `16px`: 中（コンテナパディング、グリッドギャップ）
- `20px〜24px`: 大（メイン領域パディング、モーダル外枠）

### 2.3. タイポグラフィ階層

- **フォントファミリ**:
  - 本文・UI: `"IBM Plex Sans", "IBM Plex Sans JP", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
  - コード・メタ情報: `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
- **サイズ階層（5 段階に制限）**:
  - `11px`: タグ、バッジ、メタデータ、タイムスタンプ
  - `12px`: 補助テキスト、補足リンク、小ボタン、コンテキストバー
  - `13px〜14px`: 本文、カードタイトル、チャットメッセージ、標準ボタン
  - `15px`: ヘッダータイトル、セクション見出し、モーダル見出し
  - `18px〜22px`: モーダル内クローズアイコン、重要数値、大見出し

### 2.4. 角丸（Border Radius）階層

- `sm (4px)`: バッジ、タグ、小さなインジケータ（`--radius-sm`）
- `md (6px〜8px)`: 通常ボタン、カード、セレクト、入力欄（`--radius-md`）
- `lg (12px〜16px)`: モーダルボックス、ボトムシート、大型パネル（`--radius-lg`）
- `full (9999px)`: ピル型チップ、丸型アイコンボタン（`--radius-full`）

### 2.5. モーション・触覚トークン（iOS Fluid Interaction）

ボタンやインタラクティブ要素の押し心地を統一するため、イージングと持続時間をトークン化する。

- **イージング**:
  - `--ease-spring`: 指を離したときの弾むスプリング復帰（`cubic-bezier(0.34, 1.56, 0.64, 1)`）
  - `--ease-snappy`: 押した瞬間の素早い沈み込み（`ease-out`）
- **持続時間**:
  - `--duration-press`: 押下時の即時フィードバック（`0.08s`）
  - `--duration-release`: 復帰時のなめらかなスプリング（`0.35s`）
- **スケール**:
  - `--scale-button-active`: 標準ボタン・バッジ押下時の縮小比率（`0.94`）
  - `--scale-icon-active`: アイコンボタン・閉じるボタン押下時の縮小比率（`0.88`）

---

## 3. 機械検査によるガードレール（`ui-validate.yml`）

機械検査できる制約（生カラー直書き禁止、`@media (hover: hover)` 必須、エントリ CSS の必須トークン・`-webkit-tap-highlight-color: transparent`・`:focus:not(:focus-visible)` / `:focus-visible`・`user-select: none` / `touch-action: manipulation`・モバイル幅の `font-size >= 16px`）は、共通 Reusable Workflow の [ui-validate.yml](../.github/workflows/ui-validate.yml)（実装: [.github/workflows/validate/ui/](../.github/workflows/validate/ui/)）で自動検証する。

各ルールの技術的根拠および例外時のオプトアウト方法（`nuage-ui-ignore-color`, `nuage-ui-ignore-hover` または `stylelint-disable-next-line`）は、lint 側の設定・定義コメント（[stylelint.config.mjs](../.github/workflows/validate/ui/stylelint.config.mjs) および [lint.mjs](../.github/workflows/validate/ui/lint.mjs)）を参照すること。

なお、機械検査になじまない定性原則として以下を遵守すること。

- モーダルオープン時の自動フォーカスによる青枠（× ボタンのアウトライン等）を許容しない。
- 目的のないアニメーション、過度なグラデーション、意味のないドロップシャドウを避け、情報の視認性と読みやすさを最優先とする。

---

## 4. UI コンポーネントの基本設計原則（責任の分離）

- **Card**:
  - 状態とアクションの最小単位。
  - カード全体をクリックしたときの主遷移アクションと、補助操作（バッジ・履歴・詳細ボタン等）のイベント分離を明確に行う。
- **Modal / Drawer**:
  - 補助的な詳細情報（エラー原因、履歴、システム情報、設定画面）の表示に徹する。
  - 背景オーバーレイのクリックまたは右上のクローズボタンで素早く閉じられること。
- **Interactive Elements (Buttons / Chips)**:
  - 押下時（`:active`）に `--scale-button-active` または `--scale-icon-active` と `--duration-press` を適用し、物理的な押し心地を提供する。
