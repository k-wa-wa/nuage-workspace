# nuage-autopilot 設計・実装レビュー

対象: `autopilot/DESIGN.md` および `autopilot/` 配下の Go 実装（`3f2e8ae` 時点）
参照: `../nuage-cluster/nix/hosts/autopilot-server/configuration.nix`（実際のデプロイ定義）

検証済みの事実:

- `go build ./...` / `go vet ./...` / `go test ./...` はすべて通る（テスト 57 本、1759 行）
- `nix/modules/nuage-autopilot.nix` はワークツリーにも Git 履歴にも存在しない

---

## 0. 総評

設計の中核である「ラベルをプログラムカウンタにしない」「毎サイクル現実から状態を導出し直す」という判断は正しく、旧 `nuage-agent` の常駐デーモン＋状態機械を systemd に吸収した構成も筋が良い。Go 側の実装品質も高く、テストは fake を挟んだ境界設計になっていて実際の `claude` / `git` / `gh` を起動しない。コメントの密度と説明の質は特筆に値する。

一方で、**「現実から状態を導出し直す」の "現実" を取得しきれていない**という一点の綻びが、システム全体の終端性を壊している。具体的には review worker の合格判定が Go 側から原理的に見えない（A-1）。この状態では、レビューが通っても dispatcher はそれを観測できず同じ PR に review を割り当て続け、しかもループ上限のカウンタも回らないため安全弁も作動しない。設計上「唯一の脱出口」とされている人間の介入すら、PR に対しては付与コマンドが誤っていて機能しない可能性が高い（A-2）。

つまり現状は「動き出すが、止まらない」構造になっている。まずここを塞ぐことを最優先とすべきである。

以下、重大度順に記載する。

---

## A. 重大 (Critical)

(A-1, A-2, A-3, A-4 ともに対応完了)

---

---

## B. 高 (High)

### B-1. Issue と PR の紐付けが dispatcher に見えない — 重複 PR を生む

`dev` worker が Issue #42 から `feature/issue-42` を切って PR #43 を作っても、Issue #42 は open のまま、`agent:` ラベルも付かない（DESIGN.md 8章の方針どおり worker はラベル遷移をしない）。次サイクル、dispatcher に渡る候補には Issue #42 と PR #43 が**互いに無関係な 2 件として**並ぶ。`DispatchCandidate` には紐付け情報が一切無く、PR 本文の `Closes #42` も Issue 側からは見えない。

dispatcher プロンプトは「着手されていない新規の Issue には spec を」と指示しているだけなので、Issue #42 に再び dev が割り当てられ、**同じ内容の 2 本目のブランチと PR** が作られる可能性が高い。

**対処（Go 側が確実）**: `buildDispatchCandidates` で PR 本文の `Closes #N` / `Fixes #N` および `feature/issue-N` 形式の head ref を走査し、Issue 候補に `関連PR: #43 (open)` を注記する。決定論的に書ける処理を LLM の推測に委ねない、という DESIGN.md 8章の janitor に関する判断と同じ考え方である。

**対処（プロンプト側、併用推奨）**: dev(Issue) プロンプトの冒頭に既存 PR の確認手順を入れる（後述 P-8）。

### B-2. `ListComments` が「最も古い 100 件」しか取らない

`comments.go:12` は `?per_page=100` のみでソート指定もページネーションも無い。GitHub のコメント API は**既定で昇順（古い順）**なので、コメントが 100 件を超えたアイテムでは **新しいコメントが 1 件も取得できない**。

`botCommentsSinceLastHuman` は取得済みの配列を降順ソートしてから数えるので、「取得できた範囲での最新」を最新だと誤認する。dispatcher に渡る「直近コメント（新しい順）」も同様に嘘になる。100 件は autopilot が回るリポジトリでは十分到達しうる。

`issues.go:11` の TODO は件数超過を認識しているが、**「先頭ページ ＝ 最古」という向きの問題**は認識されていないように読める。少なくとも `&sort=created&direction=desc` を付けるべきで、Link ヘッダ追跡まで実装できればなお良い。

### B-4. プロンプトインジェクション経路が開いている

`nuage-workspace` は public リポジトリであり、DESIGN.md もそう明記している。第三者が起票した Issue の本文とコメントが、

1. dispatcher（haiku, `--permission-mode bypassPermissions`）
2. worker（既定モデル, 同じく `bypassPermissions`）

にそのまま渡り、worker は `repo` スコープの `GH_TOKEN` を環境変数として継承した状態でシェルを自由に叩ける。しかも巡回対象には `nuage-cluster`（クラスタ構成）と `nuage-workspace`（autopilot 自身のソース）が含まれる。

`Item.Author` は既に取得できているので、**候補を信頼できる作成者に限定する**のが最も低コストで効く対策である。

```go
// AllowedAuthors が非空の場合、そこに含まれる作成者の Issue/PR のみを候補にする。
// 公開リポジトリで第三者が起票した本文が bypassPermissions の worker を
// 駆動することを防ぐ（プロンプトインジェクション対策）。
```

加えて GitHub 側で既定ブランチのブランチ保護を有効にし、`GH_TOKEN` は fine-grained PAT で対象リポジトリのみに絞ることを推奨する。プロンプト側の禁止事項（後述 P-10）は多層防御の一枚目にすぎず、それ単体を頼ってはならない。

### B-5. dispatcher が `bypassPermissions` で全ツールを持っている

`runner.go:46` の `runArgs` は dispatcher / worker 共通で `--permission-mode bypassPermissions` を渡す。dispatcher は「判断のみを行い、実装や検証は行わない」（DESIGN.md 8章、プロンプトにも明記）はずなのに、実際には `StateDir`（= 全リポジトリの clone 置き場）を作業ディレクトリとして任意のコマンドを実行できる。

haiku とはいえ、これは不要な権限であり、コストと事故の両面でリスクがある。`Options.ExtraArgs` に `--disallowed-tools`（あるいは `--allowed-tools` を空に相当する指定）を追加し、dispatcher はツール無しで動かすべきである。副次的に、無駄なツール呼び出しによるレイテンシとトークン消費も減る。

### B-6. CI の状態を誰も見ていない

DESIGN.md 8章は「PR が存在するか、**CI が通っているか**、未対応のレビュー指摘があるか — これらが真の状態である」と書いているが、check runs / commit status を取得するコードは無い。dispatcher は CI の合否を知らないまま `qa` を割り当てるか判断することになる。

`GET /repos/{repo}/commits/{sha}/check-runs` の集約結果（success/failure/pending）を `DispatchCandidate` に足すのは安価で、効果が大きい。実装しないなら DESIGN.md から当該記述を落として、期待値を実装に合わせる。

---

## C. 中 (Medium)

| # | 箇所 | 内容 |
| :-- | :-- | :-- |
| C-2 | `cycle/dispatcher.go:137` | リトライが**まったく同じプロンプト**の再送。決定論的に同じ失敗を繰り返しやすい。2 回目には `lastErr`（「番号 N は候補集合に無い」等）をプロンプトに追記して差分を与える |
| C-3 | `cycle/cycle.go:133-137` | 候補 1 件の `ListComments` が失敗しただけでサイクル全体が中断する。1 件の一時的な失敗で他リポジトリの処理まで巻き添えにするのは重い。ログして当該候補をスキップするほうが可用性が高い |
| C-4 | `cycle/cycle.go:149-161` | ループ上限に達した候補が 1 件でもあると `return` してしまい、同サイクルの健全な候補は処理されない。ラベル付与後はそのまま dispatch に進めてよい（付与済みアイテムを候補から除くだけ） |
| C-5 | `repo/repo.go:146` | `EnsureWorkspace` が毎サイクル**全リポジトリ**を `fetch` + `reset --hard` + `clean -fd` する。(a) 前サイクルが未 push で残した commit を無警告で破棄する、(b) 5 リポジトリ × 5 サイクル = 1 起動あたり `ls-remote` 25 回。対象リポジトリ以外は「未 clone なら clone、あれば何もしない」で足りる |
| C-7 | `github/types.go:89` | `PullRequest.Draft` を取得しているが `Item` にも `DispatchCandidate` にも伝播していない。Draft PR は通常「レビュー前」なので dispatcher に渡す価値がある |
| C-9 | `runner/runner.go:207` | `scanner.Buffer(..., 1024*1024)` により 1MB を超える 1 行で読み取りが失敗する。`--output-format json` の応答は 1 行なので、worker 側でこの形式を使うようになった場合に問題化する。dispatcher の応答は小さいので現状は顕在化しない |
| C-10 | `prompt/dev.go:59` | `echo ... > pr_body.md` を**リポジトリの作業ツリー内**に作る。コマンドが途中で失敗すると `rm` に到達せず、後続の `git add -A` で成果物に混入する。`mktemp` でツリー外に作るべき |
| C-12 | `config/config.go:66` | `--repos` の各要素が `owner/name` 形式かを検証していない。誤設定は `repo.splitRepo` まで進んでから初めて分かる |

---

## D. プロンプトの改善

ここが本題。現状のプロンプトは旧 `nuage-agent` からの忠実な移植として質が高いが、**「ラベル駆動の状態機械」から「dispatcher が毎サイクル推測する」方式に変わったことの含意が、プロンプト本文にまだ反映されていない**。dispatcher が推測するしかない以上、worker の出力は推測しやすい形で残さなければならない。それが P-1〜P-3 の主題である。

### P-1. 合格判定の投稿先を統一する【最優先 / A-1 の対処】

`internal/prompt/review.go:62-66` を次のように変える。

```go
2. **問題ない場合 (Passed)**
   すべての観点でチェックに合格した場合、PR に合格判定のコメントを投稿する。
   - **重要**: 「gh pr review」 は使用しないこと。gh pr review が作成する Review オブジェクトは
     Issue コメント API に現れず、次サイクルの dispatcher からもループ上限の判定からも
     観測できないため、レビュー済みの PR に対して review が際限なく繰り返されることになる。
     必ず 「gh pr comment」 を使うこと。
   - コメント投稿: 「gh pr comment %[3]d --body-file <一時ファイル>」
```

`--approve` を避ける理由（自己 PR への Approve 不可）は正しいが、その代替が `--comment` である必要はない。

### P-7. 重複着手を防ぐ

`dev`(Issue) プロンプトの手順 1 の前に置く（B-1 の対処）。

```
0. **重複着手の確認（必須）**
   実装を始める前に、この Issue に対する Pull Request が既に存在しないかを確認する。
   コマンド: 「gh pr list --state all --search "%[4]d in:body" --json number,state,title,headRefName」
   既に open な PR が存在する場合、新しいブランチや PR を作ってはならない。その PR に対する
   修正として作業するか、追加作業が不要と判断した場合はその旨を結果コメントに書いて終了する。
```

`spec` にも同種のガードが要る（本文に既に PRD と AC が書かれている Issue に対して、再度 spec が走って PRD を二重投稿する経路がある）。

### P-8. マルチリポジトリ・ワークスペースであることを worker に伝える

`repo.EnsureWorkspace` は `stateDir/owner/` 配下に全リポジトリを兄弟ディレクトリとして並べるが、**その事実をプロンプトが一切伝えていない**。手元 PC の開発体験を再現するというコミット `3f2e8ae` の意図が、worker には届いていない。同時に、`CLAUDE.md` 3 章が定める「アプリ変更 → `nuage-cluster` のマニフェスト追従」「監視設定の追従」「プロキシ設定の追従」も、worker がそれらのリポジトリの存在を知らなければ実行できない。

```
## リポジトリ横断の作業について
- 作業ディレクトリの親ディレクトリには、本ワークスペースの他リポジトリが兄弟ディレクトリとして
  clone されている（例: ../nuage-cluster、../pechka）。参照は自由に行ってよい。
- ただし、他リポジトリへの**変更は当該リポジトリで別の Pull Request として起票**すること。
  カレントリポジトリの PR に他リポジトリの変更を混ぜてはならない。
- 他リポジトリへの追従が必要になったが今回のスコープで実施しない場合は、その内容を
  当該リポジトリの Issue として起票し（gh issue create --repo <owner/name>）、
  結果コメントにその Issue 番号を記載すること。
```

3 番目は「追従漏れ」を autopilot 自身のキューに戻す設計であり、`CLAUDE.md` 3 章の運用ルールと噛み合う。

### P-11. その他の小さな修正

| 箇所 | 修正内容 |
| :-- | :-- |
| `dev.go:59`, `spec.go:42`, `qa.go:25` | `echo ... > pr_body.md`（作業ツリー内）→ `mktemp` でツリー外に作る（C-10）。あわせて `echo` は本文中の `\n` やバックスラッシュの扱いが処理系依存なのでヒアドキュメント推奨 |
| `spec.go:42` | 「echo "..." > issue_body.md && gh issue edit ... && rm issue_body.md」は `&&` 連鎖のため途中失敗で `rm` が実行されない。`;` 区切りか `trap` にする |

---

## E. 良かった点

公平を期すために記す。

- **ラベルをプログラムカウンタにしない**という中心的判断と、その理由（ラベルは真の状態の写像にすぎず必ずズレる）の言語化。旧実装の反省が設計に正しく反映されている。
- **オプトアウト方式**の候補選別。「エージェントに触らせたくないものだけ止める」という向きは、自動化の摩擦を最小にする正しい選択である。
- **`Dispatcher` / `LLMExecutor` のインターフェース分離**。実 CLI を起動せずに `cycle.Run` の分岐を網羅できており、テストの費用対効果が高い。
- **`truncateRunes` が末尾に `…` を付け、その意味をプロンプトで説明している**点。「切り詰めた事実を伝えないと欠けた情報から誤って断定する」という配慮は、LLM をコンポーネントとして扱ううえで的確である。
- **`gh auth setup-git` による credential helper 委譲**。トークンを remote URL にも設定ファイルにも残さない、正しい実装。
- **プロンプトを標準入力で渡す**判断（ARG_MAX と `ps` からの漏洩という 2 つの理由を明記）。
- **必須環境変数が無いときに終了コード 0 で警告終了する**判断と、その理由（タイマー実行のたびに failed になると本当の障害が埋もれる）。運用を分かっている設計である。
- コード内コメントが「何をしているか」ではなく「**なぜそう決めたか / 何を却下したか**」を書いている。`bodyPreviewLimit` / `commentPreviewLimit` / `recentCommentLimit` の各定数に、旧値で何が起きたかまで残っているのは特に良い。

---

## F. 推奨する対応順序

**第 1 波 — 「止まらない」を止める（これをやらないと無人運用は成立しない）**

1. A-1: review の合格判定を `gh pr comment` に変更（プロンプト 1 行）＋ Go 側で `ListReviews` を統合
2. A-2: `awaitingUserReviewNote` を `Kind` で分岐（`gh pr edit` / `gh issue edit`）＋ ラベルの起動時冪等作成（C-8）
3. P-2 / P-3: 機械可読な状態行と「必ず結果コメントを 1 件残す」の全 worker 適用
4. B-3: ループ上限のカウント対象を `botLogin` 一致のみに絞る

**第 2 波 — 暴走と事故の防止**

5. A-4: SIGTERM ハンドルと `agent:running` の確実な解除、リポジトリごとのタイムアウト分割
6. B-4: 作成者フィルタの導入＋ブランチ保護＋トークンスコープの絞り込み
7. P-9: プロンプトへの禁止事項の明示
8. B-5: dispatcher のツール無効化

**第 3 波 — 判断精度の向上**

9. B-1: Issue↔PR の紐付けを `DispatchCandidate` に注記（＋ P-7 の重複着手ガード）
10. B-2: コメント取得を降順化／ページネーション
11. B-6: CI 状態の取得、または DESIGN.md からの記述削除
12. P-5 / P-6: npm 決め打ちの排除、QA 自己修復ルールの制限

**第 4 波 — 整合性の回復**

13. A-3: `nixosModules` の実装または削除、および DESIGN.md 4 / 6 / 7 / 11 章の実態への同期
14. C-1 / C-2 / C-4 / C-5 / C-6 ほかの中程度の項目

---

## G. 留保事項

- `gh issue edit` に PR 番号を渡した場合の挙動（A-2）は、`gh` が番号を Issue として解決する実装であることに基づく推論であり、autopilot-server 上での実地確認はしていない。ただし提案する修正（`Kind` による分岐）はどちらに転んでも正しいため、確認を待たずに適用してよい。
- `nuage-cluster` 側は現在のワークツリーの内容を参照した。同リポジトリの master および `flake.lock` が指す revision とは異なる可能性がある。
- コスト・レイテンシの定量評価は行っていない。`ListComments` が候補ごとに毎サイクル発行される点（5 リポジトリ × 候補数 × 実行頻度）は、巡回頻度を上げる際に GitHub のレート制限との兼ね合いで再評価が要る。
