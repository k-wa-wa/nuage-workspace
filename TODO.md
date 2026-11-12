# TODO / 横断改善アイディア集

`nuage-workspace` 配下の全リポジトリを俯瞰した上での、運用改善・開発速度向上・実験アイディアの一覧。

**スコープの区別**: インフラ単体（Talos / Terraform / Nix / Argo CD 本体）の課題は
[`../nuage-cluster/TODO.md`](../nuage-cluster/TODO.md) が正である。本ファイルは
**「複数リポジトリに跨る問題」** と **「開発ループそのものの速度」** に絞る。

---

## 0. 現状サマリ（2026-11 時点の観測）

| 観点 | 現状 |
| :-- | :-- |
| デプロイ経路 | GitHub Actions → ghcr.io (`:latest` / `:sha-<sha>`) → Argo CD (`multi-repo-deploy` ApplicationSet) が各リポジトリの `k8s/overlays/prod` を同期（`bare-web-proxy`, `nuage-honeytrap`, `nuage-monitoring-stack`, `pechka`） |
| 共通 CI | `nuage-workspace` の Reusable Workflow (`docker-build-push.yml`) を `bare-web-proxy`, `nuage-monitoring-stack`, `pechka` (API / Frontend) が利用中。バッチ・レポート系コンテナのみ自前ビルドが残る |
| PR プレビュー | `pechka` / `bare-web-proxy` / `nuage-monitoring-stack` に `*-preview-appset.yaml` があり、`preview` ラベル付き PR に `*-pr-N.wpcapp.net` が自動で立つ。AppProject (`preview-apps`) と Cilium ネットワーク隔離ガードレール (`preview-isolation-guardrail`) による多層防御が稼働中 |
| 自律開発 | `nuage-autopilot5`（TypeScript）が atelier (NixOS VM) 上で稼働。Orca サーバーと連携し、窓口エージェントが受けた仕事を `autopilot-run` が裏で完走させる構成へ移行。旧 `nuage-autopilot4` から順次集約中 |
| 自動検証 | PR プレビューに対し、リポジトリ側の `.agents/autopilot-gate.md`（curl レンダリングテスト等）に基づいて合否を判定。プレビューからの内部不正通信は `nuage-honeytrap` へ誘導・隔離 |
| 内部可観測性 | atelier 上の `ai-agent-metrics-collector` がエージェント使用量を収集し VictoriaMetrics へ投入。Grafana の「AI Agent 可観測性ダッシュボード」で使用量・コスト・タスク別消費・実行結果を可視化 |
| 監視 | Alertmanager / VictoriaMetrics (`VMRule`) → `monitoring-pwa-backend` の webhook → PWA プッシュ通知 |
| リポジトリ設定 | `terraform/main.tf` で全リポジトリを module 管理。`nuage-autopilot4`, `nuage-autopilot5`, `nuage-usage-ledger`, `cicerone3270`, `nuage-dr`, `nuage-honeytrap` の追加と旧リポジトリ整理が完了 |
| シークレット | `pechka` / `nuage-monitoring-stack` は argocd-vault-plugin による SOPS 参照化が完了。atelier VM へのエージェント認証情報集約（`/var/lib/atelier/secrets.env`）により平文リスクを排除 |

---

## 1. 爆速開発（開発ループの短縮） — 優先度: 最高

### 1.1 Docker イメージタグ運用（`:latest` と `:sha` の整合）

- [ ] **master ビルドの `:sha-<sha>` 固定デプロイと Argo CD 自動追従**
  - 現在は `:latest` と `:sha-<sha>` の両方を push しているが、Argo CD 側の追従方式（keel や image updater、または Git への commit 追従）を整理し、タグの曖昧性を排除する。
  - PR 環境等のコンテナイメージ自動更新には Keel を採用し、Argo CD と共存運用中。master 側の運用ポリシーを確定させる。

### 1.2 CI の重複排除と高速化

- [x] **共通 Reusable Workflow の新設と適用**
  - `nuage-workspace/.github/workflows/docker-build-push.yml` を作成。
  - `bare-web-proxy` と `nuage-monitoring-stack` は共通ワークフロー呼び出しへの移行を完了。
- [x] **pechka の主要コンポーネントにおける共通 Reusable Workflow 移行**
  - `pechka` の `api.yml` および `frontend.yml` (push-image) を `k-wa-wa/nuage-workspace/.github/workflows/docker-build-push.yml@master` に移行完了。
  - （残課題: `tech-feed.yml` の 2 イメージマトリクスビルド、および `etl.yml` / `aivisspeech.yml` 等の個別バッチビルドの共通化検討）
- [ ] **Self-hosted Runner (ARC) をクラスタに置く**
  - `nuage-cluster/TODO.md` にもあるが、体感速度への寄与が最も大きいのはここ。
  - 特に重いのは `pechka/frontend` の VRT ジョブ（`npx playwright install --with-deps chromium` を毎回実行）と Remotion の `npm ci`。Runner イメージにブラウザと node_modules を焼き込めば分単位で縮む。
  - buildx の `cache-from: type=gha` を **自宅 Minio / SeaweedFS の S3 バックエンド**に切り替えると GHA キャッシュ 10GB 制限からも解放される。

### 1.3 ローカル開発体験の横断的な統一

- [ ] **モックファースト開発を横展開する**
  - `pechka/frontend` の Storybook + msw + `e2e/mock-server.mjs` + VRT + `check:stories`（CI でストーリー漏れを検知）という構成は完成度が高い。**これを `monitoring-pwa/frontend` にも移植する**。
  - K8s を起動せず UI を触れる状態が「爆速」の実体である。
- [ ] **devShell / ツールチェーンの固定**
  - Go のバージョンが `bare-web-proxy` は Dockerfile 内 alpine で `1.26`、`pechka` は `go-version-file` 参照とバラバラ。`flake.nix` の devShell に寄せ、CI もそこから引く。

### 1.4 プレビュー環境の強化

- [ ] **3 本の preview ApplicationSet を共通テンプレート化する**
  - `bare-web-proxy-preview-appset.yaml` / `pechka-preview-appset.yaml` / `nuage-monitoring-stack-preview-appset.yaml` が、パッチ内容以外ほぼ同一。
  - matrix generator（list × pullRequest）でアプリ名・ホスト名だけをパラメータ化した 1 本に畳む。新規アプリの preview 対応が数行で済むようになる。
- [x] **preview 環境の多層防御とセキュリティ隔離**
  - PR ごとの preview 環境専用 AppProject (`preview-apps`) を導入し、namespace や作成可能リソースをホワイトリスト化。
  - `CiliumClusterwideNetworkPolicy` (`preview-isolation-guardrail`) により、クラスタ内部ゾーンや自宅 LAN への横展開を完全遮断。不審な通信は `nuage-honeytrap` へ誘導する構成を確立。
- [x] **preview のライフサイクル管理（起動制御）**
  - ApplicationSet の generator に `labels: - preview` を指定し、必要な PR だけに限定して preview を立ち上げる運用を確立。無駄なリソース消費を防止。
- [ ] **preview のライフサイクル管理（残骸掃除）**
  - preview namespace に ResourceQuota / LimitRange を設定し、暴走 PR がクラスタを圧迫しないようにする。
  - PR close 後に **GHCR に残る `pr-N` タグを掃除するワークフロー**を追加する（現状残り続ける）。
- [ ] **ビルド SHA をアプリから露出させる**
  - 「preview が応答した」と「preview が**このコミット**を配信している」は別物。後者を確かめられないと verify は鮮度を検証できない。
  - 対象は **PR ごとにビルドされる 5 イメージだけ**: `bare-web-proxy` / `pechka-api` / `pechka-frontend` / `monitoring-pwa-backend` / `monitoring-pwa-frontend`。
  - `docker/build-push-action` に `build-args: COMMIT_SHA=...` を渡し、Go は ldflags、Next.js / Vite は build-arg で埋める。共通ワークフローに 1 行足せば大半に配れる。
- [ ] **preview 到達待ちを CI に寄せる（autopilot の evaluate 待ち時間を削減）**
  - 現状は各リポジトリの `.agents/autopilot-gate.md` 内で curl によるポーリングを行っているが、CI 側に「preview が head_sha を配信するまでポーリングする」ジョブを置くことで、evaluate が余計な sleep を挟まず即座に検証に入れる。
- [x] **`pechka/.github/workflows/tech-feed.yml` の `push-image` にブランチ条件が無い問題の修正**
  - `if: github.event_name == 'push'` を追加し、PR から `:latest` が上書きされる事故を防止完了。
- [ ] **`.agents/autopilot-gate.md` の全リポジトリ標準化**
  - `bare-web-proxy` と `pechka` に配備されたプレビュー検証ゲート（SPA 描画、特定テキスト、ヘッダ検証等）の仕組みを、`nuage-monitoring-stack` 等の他リポジトリにも展開する。

---

## 2. 横断運用の一貫性 — 優先度: 高

- [x] **リポジトリ設定 Terraform の棚卸しと管理追加**
  - `terraform/main.tf` に `nuage-autopilot4`, `nuage-autopilot5`, `nuage-usage-ledger`, `cicerone3270`, `nuage-dr`, `nuage-honeytrap` の module 定義を追加完了。
  - 旧リポジトリ（`nuage-autopilot`, `nuage-autopilot2`）を整理し、退役した `nuage-home` も地図から削除。
- [ ] **Branch 保護・リポジトリルールの全リポジトリ展開**
  - `nuage-dr` にて `bypass_mode = "pull_request"` や `required_status_checks`（`check`, `build-dr-nas`）の導入を開始。
  - 他の主要リポジトリにも required status checks や `delete_branch_on_merge`, `allow_auto_merge` を展開する。
- [ ] **gitleaks / SOPS 暗号化チェックの横断適用**
  - `.sops.yaml` を持つのは `nuage-cluster` / `nuage-monitoring-stack` / `pechka`。
  - pre-commit や reusable workflow で「平文コミットの防止」および「SOPS 暗号化漏れ検証（`sops_mac` の存在チェック）」を一括適用する。
- [ ] **クレデンシャル棚卸し表の作成**
  - 各ホストの `secrets.env` や SOPS 管理シークレット、PAT、SOPS Age 鍵の所在と有効期限を 1 枚にまとめる。

---

## 3. AI Agent 基盤の強化 — 優先度: 高（このワークスペース固有の伸びしろ）

- [ ] **AGENTS.md が無いリポジトリへの整備**
  - `nuage-cluster`, `nuage-workspace`, `pechka`, `nuage-autopilot4`, `nuage-autopilot5`, `cicerone3270`, `nuage-usage-ledger`, `nuage-honeytrap` に配備完了。
  - **残存リポジトリ**: `bare-web-proxy`, `nuage-monitoring-stack`。これらにもビルド/テストコマンド、マニフェスト追従要否、検証ゲートの入口を定義する。
- [x] **共通ルール・スキルの配布機構の確立**
  - `nix-config`（Mac・atelier の home-manager）経由で個人の共通ルール（`rules.md`, `mac.md`）を全エージェント環境に自動注入。
  - `nuage-autopilot5` の `home/` symlink 構成により、窓口・実行エージェントへの統一ルール適用を実現。
- [x] **autopilot の可観測性基盤の構築**
  - `nuage-autopilot4` の内蔵 Dashboard (Web UI: 8787) に加え、atelier 上に `ai-agent-metrics-collector` (Python + systemd timer) を導入。
  - エージェント使用量（トークン数、モデル別、フェーズ別、タスク別支出、セッション数、実行結果）を VictoriaMetrics へ毎分投入。
  - Grafana に「AI Agent 可観測性ダッシュボード (`grafana-dashboard-ai-agent.yaml`)」を構築し、リアルタイムでの監視が可能になった。
- [ ] **Alertmanager / PWA 連携による予算・異常消費通知**
  - VictoriaMetrics のメトリクスに基づき、月間支出超過やエージェント暴走（トークン急増・失敗ループ）を検知して Alertmanager → `monitoring-pwa` へプッシュ通知するアラートルール (`VMRule`) を整備する。
- [x] **ローカル LLM・マルチモデルのルーティング基盤の実用投入**
  - クラスタ内に LiteLLM を配備し、`lm-server` (qwen3.8-27b), さくらAI Platform (Kimi-K2.6), Google AI Studio (gemini-3.8-flash) を統合。
  - ダウン時の即時フェイルオーバー構成（`auto` モデルグループ）を構築。
  - atelier の `models.yaml` でエージェント・作業段階（high / standard / light）に応じたモデル自動フォールバック運用を確立。
- [x] **エージェント認証情報と実行基盤の集中管理**
  - atelier VM (NixOS) に作業場を集約し、`/var/lib/atelier/secrets.env` と `setup.sh` による一元管理を実現。
  - クラスタ調査用 read-only ServiceAccount 配布スクリプトにより、「クラスタ内はステートレス」原則を崩さずにエージェントの安全な調査権限を担保。
- [ ] **autopilot5 への全面移行と運用安定化**
  - Issue/PR 駆動（autopilot4）から Orca 窓口 + `autopilot-run` への移行を進め、各リポジトリのワークスペース運用を標準化する。

---

## 4. 技術的に面白そうな実験

- [x] **依存グラフの自動生成と自己文書化**
  - `generate-service-graph` スキルを実装。各リポジトリの Ingress / Service / ApplicationSet / ConfigMap を走査してサービス間依存図を mermaid で自動生成し、ドキュメントに埋め込む機構を確立。
- [x] **bare-web-proxy を agent のブラウジング基盤に転用する**
  - `bare-web-proxy` に `X-Program-Mode: true`（プログラムモード）を実装完了。
  - 不要なタグ（ツールバー、CSS、コメント、nav/header/footer等）を削ぎ落とした軽量 HTML を返却し、LLM のコンテキスト・トークン消費削減を実現。
- [x] **プレビュー環境のハニーポット誘導・能動防御**
  - `nuage-honeytrap` をクラスタ内に配備。プレビュー環境からクラスタ内部や自宅 LAN への不正なプローブ通信を CCNP でハニーポットへ誘導・検知する実験構成を稼働。
- [ ] **週次の自律リポジトリ健全性レビュー**
  - スケジュール実行の agent に「TODO.md と実装の乖離」「死んだマニフェスト」「旧ドメイン残骸」「AGENTS.md の陳腐化」を検査させ、Issue や Orca ワークスペースで報告させる。
- [ ] **DORA メトリクスの計測**
  - GitHub API から lead time for changes / deployment frequency / change failure rate / MTTR を集め、Prometheus に投げて Grafana でトラッキングする。
- [ ] **preview URL の QR コード化**
  - PR コメントに QR を貼り、スマホから即座に preview を確認できるようにする。
- [ ] **pechka のコンテンツを AI へのインプットとして繋ぐ**
  - 字幕生成パイプラインと Elasticsearch / MongoDB / MinIO を活かし、ローカル LLM (lm-server) と連携して字幕埋め込みによるコンテンツ検索・RAG を構築する。

---

## 5. 進め方の推奨順序

1. **3.1（残るリポジトリの AGENTS.md 整備）** — `bare-web-proxy` と `nuage-monitoring-stack` への配備。エージェント実装・自律開発の品質基準を横断で揃える。
2. **1.4（preview 到達待ちの CI 化）** — `.agents/autopilot-gate.md` の sleep ポーリングを CI 側に寄せ、検証待ち時間を削減する。
3. **3.4（AI Agent メトリクスのアラートルール整備）** — 構築済みの VictoriaMetrics / Grafana ダッシュボードに `VMRule` を足し、予算超過や暴走を monitoring-pwa へ通知する。
4. **2.2（Branch 保護・auto-merge の全リポジトリ展開）** — `terraform/modules/repo` を通じて auto-merge と CI 必須化を広げ、安全な自律マージの基盤を整える。
5. **1.2（Self-hosted Runner / ARC の導入）** — VRT や Remotion ビルドの重いジョブをクラスタ内 Runner で高速化する。
6. **1.4（preview ApplicationSet の共通テンプレート化）** — matrix generator による統合でプレビュー管理コストを下げる。
