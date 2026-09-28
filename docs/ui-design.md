# Nuage UI 設計標準・デザインシステム原則

本ドキュメントは、Nuage エコシステム（`nuage-autopilot4`, `nuage-monitoring-stack`, `pechka` 等）において提供されるWeb UIおよびPWAの設計哲学、デザイントークン体系、実装ガイダンス、および品質担保のためのガードレールを定義する。

---

## 1. デザイン哲学（北極星）

- **「ミニマルで高密度な開発者コックピット × 洗練された触覚フィードバック（Liquid / Fluid）」**
- 派手な装飾や不要なグラデーションに頼らず、美しいタイポグラフィ、正確な余白、そして押した瞬間の心地よい物理フィードバック（弾性スプリング）で語るクラフトマンシップを追求する。
- スマホ（片手操作・スキマ時間での瞬時把握）とデスクトップ（一発俯瞰・集中操作）の双方で摩擦のない体験を提供する。
- 各プロダクトを横断したときに、単一の調和したOS／コックピットを操作している一貫性を保つ。

---

## 2. デザイントークン体系（Design Tokens）

すべてのデザイン値（色・余白・フォント・モーション・角丸）は CSS 変数（トークン）として宣言的に定義し、コンポーネント側での生値の直書きを禁止する。

### 2.1. カラーパレット（セマンティック定義）

Nuage の UI は**ダークテーマ専用**とし、ライトモードは原則サポートしない（ダークテーマを前提としたコントラスト・視認性設計に一本化する）。

- **ベースカラー**:
  - `--bg`: アプリケーション全体の背景色 (`#191816`)
  - `--fg`: 基本テキスト色 (`#e8e4dc`)
  - `--card`: カード・パネル背景色 (`#211f1c`)
  - `--line`: 境界線（ボーダー）色 (`#2f2d29`)
  - `--muted`: 補助テキスト・不活性要素色 (`#98928a`)
- **セマンティック・状態カラー**:
  - `--accent`: 主アクション・フォーカス・リンク色 (`#60a5fa`)
  - `--warn`: エラー・警告・障害色 (`#e0a08a`)
  - `--success`: 完了・成功インジケータ色 (`#10b981`)
  - `--blocked`: 保留・待機インジケータ色 (`#f59e0b`)
- **半透明（Alpha）パターンの基準階層**:
  透過率の直書き（`rgba`）による乱立を防ぐため、以下の3段階に集約してトークン化・適用する。
  - **弱（Subtle ~8%）**: バッジ・カード背景、不活性チップ
  - **中（Emphasis ~16%）**: ホバー時背景、選択中アイテム
  - **強（Border ~25%）**: 有色枠線、フォーカスリング背景

### 2.2. スペーシング（4px / 8px グリッドシステム）

余白（padding, margin, gap）は 4px / 8px の倍数に厳格に統一する。変則的な数値（5px, 7px, 13px等）は原則許容しない。

- `4px`: 極小（バッジ内部、アイコンとテキストの隙間）
- `8px`: 小（カード内要素間、チップ間隔、ボタン内パディング）
- `12px`: 中小（カードヘッダー、モーダル内セクション）
- `16px`: 中（コンテナパディング、グリッドギャップ）
- `20px〜24px`: 大（メイン領域パディング、モーダル外枠）

### 2.3. タイポグラフィ階層

- **フォントファミリ**:
  - 本文・UI: `"IBM Plex Sans", "IBM Plex Sans JP", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
  - コード・メタ情報: `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
- **サイズ階層（5段階に制限）**:
  - `11px`: タグ、バッジ、メタデータ、タイムスタンプ
  - `12px`: 補助テキスト、補足リンク、小ボタン、コンテキストバー
  - `13px〜14px`: 本文、カードタイトル、チャットメッセージ、標準ボタン
  - `15px`: ヘッダータイトル、セクション見出し、モーダル見出し
  - `18px〜22px`: モーダル内クローズアイコン、重要数値、大見出し

### 2.4. 角丸（Border Radius）階層

- `sm (4px)`: バッジ、タグ、小さなインジケータ (`--radius-sm`)
- `md (6px〜8px)`: 通常ボタン、カード、セレクト、入力欄 (`--radius-md`)
- `lg (12px〜16px)`: モーダルボックス、ボトムシート、大型パネル (`--radius-lg`)
- `full (9999px)`: ピル型チップ、丸型アイコンボタン (`--radius-full`)

### 2.5. モーション・触覚トークン（iOS Fluid Interaction）

ボタンやインタラクティブ要素の押し心地を統一するため、イージングと持続時間をトークン化する。

- **イージング**:
  - `--ease-spring`: 指を離したときの弾むスプリング復帰 (`cubic-bezier(0.34, 1.56, 0.64, 1)`)
  - `--ease-snappy`: 押した瞬間の素早い沈み込み (`ease-out`)
- **持続時間**:
  - `--duration-press`: 押下時の即時フィードバック (`0.08s`)
  - `--duration-release`: 復帰時のなめらかなスプリング (`0.35s`)
- **スケール**:
  - `--scale-button-active`: 標準ボタン・バッジ押下時の縮小比率 (`0.94`)
  - `--scale-icon-active`: アイコンボタン・閉じるボタン押下時の縮小比率 (`0.88`)

### 2.6. トークン定義リファレンス (`:root` CSS 変数一覧)

```css
:root {
  /* ベースカラー（ダークテーマ専用） */
  --bg: #191816;
  --fg: #e8e4dc;
  --card: #211f1c;
  --line: #2f2d29;
  --muted: #98928a;

  /* セマンティック・状態カラー */
  --accent: #60a5fa;
  --warn: #e0a08a;
  --success: #10b981;
  --blocked: #f59e0b;

  /* 半透明（Alpha）パターントークン（弱 ~8%, 中 ~16%, 強 ~25%） */
  --accent-subtle: rgba(96, 165, 250, 0.08);
  --accent-emphasis: rgba(96, 165, 250, 0.16);
  --accent-border: rgba(96, 165, 250, 0.25);

  --warn-subtle: rgba(224, 160, 138, 0.08);
  --warn-emphasis: rgba(224, 160, 138, 0.16);
  --warn-border: rgba(224, 160, 138, 0.25);

  --muted-subtle: rgba(152, 146, 138, 0.08);
  --muted-emphasis: rgba(152, 146, 138, 0.16);
  --muted-border: rgba(152, 146, 138, 0.25);

  --success-subtle: rgba(16, 185, 129, 0.08);
  --success-emphasis: rgba(16, 185, 129, 0.16);
  --success-border: rgba(16, 185, 129, 0.25);

  --blocked-subtle: rgba(245, 158, 11, 0.08);
  --blocked-emphasis: rgba(245, 158, 11, 0.16);
  --blocked-border: rgba(245, 158, 11, 0.25);

  /* タイポグラフィ */
  --font-sans:
    "IBM Plex Sans", "IBM Plex Sans JP", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  /* 角丸 */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 14px;
  --radius-full: 9999px;

  /* モーション・触覚トークン（iOS Fluid Interaction） */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-snappy: ease-out;
  --duration-press: 0.08s;
  --duration-release: 0.35s;
  --scale-button-active: 0.94;
  --scale-icon-active: 0.88;
}
```

---

## 3. ガードレール（禁止事項・アンチパターン）

統一感を損なわないための厳格な制約：

1. **生の値（Magic Values）の直書き禁止**:
   - `style={{ ... }}` や CSS 内に生カラーコード（`#161b22`, `rgba(...)`）を直書きしない。必ずセマンティックトークンを経由する。
   - ダークテーマ専用のため、生ホワイト（`#fff`）や生ブラック（`#000`）の直書きを避け、必ずセマンティック変数（`--fg`, `--bg`, `--card` 等）を使用する。
2. **ブラウザ標準の青枠・ハイライトの排除**:
   - モバイル WebKit のタップハイライト（`-webkit-tap-highlight-color: transparent`）を全称セレクタまたは主要操作要素に徹底する。
   - タップ時・マウスクリック時の青枠（`:focus:not(:focus-visible)`）を抑止し、キーボード操作時（`:focus-visible`）のみ視認性・アクセシビリティを保つ。
   - モーダルオープン時の自動フォーカスによる青枠（×ボタンのアウトライン等）を許容しない。
3. **モバイルでの `:hover` 残留の禁止**:
   - ホバースタイル（色の変化や `transform`）は必ず `@media (hover: hover)` でラップし、タッチデバイスでタップ後にホバー状態が画面上に残らないようにする。
4. **長押しテキスト選択の誤発火禁止**:
   - ボタンやインタラクティブ要素には `user-select: none;` と `touch-action: manipulation;` を適用し、連打や長押しで不要なテキスト選択枠を出さない。
5. **過剰な装飾の排除**:
   - 目的のないアニメーション、過度なグラデーション、意味のないドロップシャドウを避け、情報の視認性と読みやすさを最優先とする。
6. **iOS Safari フォーム自動ズームの防止**:
   - モバイル幅（`@media (max-width: 768px)`）での入力要素（`input`, `textarea`, `select`）は `font-size: 16px` 以上を維持する。16px 未満を指定すると iOS Safari がフォーカス時に画面を自動拡大し、レイアウトが崩れるため。

---

## 4. UIコンポーネントの基本設計原則（責任の分離）

- **Card**:
  - 状態とアクションの最小単位。
  - カード全体をクリックしたときの主遷移アクションと、補助操作（バッジ・履歴・詳細ボタン等）のイベント分離を明確に行う。
- **Modal / Drawer**:
  - 補助的な詳細情報（エラー原因、履歴、システム情報、設定画面）の表示に徹する。
  - 背景オーバーレイのクリックまたは右上のクローズボタンで素早く閉じられること。
- **Interactive Elements (Buttons / Chips)**:
  - 押下時（`:active`）に `--scale-button-active` または `--scale-icon-active` と `--duration-press` を適用し、物理的な押し心地を提供する。
