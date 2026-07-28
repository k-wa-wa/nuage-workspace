{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.nuage-autopilot;

  # "k-wa-wa/pechka" -> "pechka"。GitHub のリポジトリ名自体は "/" を含めないため、
  # owner を落として最後のセグメントのみを取り出せば衝突なくサニタイズできる…はずだが、
  # 別 owner 配下に同名リポジトリが存在する場合（例: "org-a/foo" と "org-b/foo"）は
  # どちらも "nuage-autopilot-foo" という同一 unit 名に写像されてしまう。
  # repositories リストにそのような組み合わせを含めないこと。
  repoBaseName = repo: lib.last (lib.splitString "/" repo);
  unitName = repo: "nuage-autopilot-${repoBaseName repo}";

  # StateDirectory は /var/lib 配下の相対名を指定する systemd の仕組みであるため、
  # cfg.stateDir が /var/lib 配下にあることを前提にベース名だけを取り出す。
  # 複数リポジトリのサービスが同じ StateDirectory 名を共有するが、
  # systemd はディレクトリ単位の参照カウントを行うため複数 unit からの共有に問題はない。
  # リポジトリごとの作業場所の分離は Go 側 (stateDir 配下にリポジトリ名でサブディレクトリを掘る) に委ねる。
  stateDirName = baseNameOf cfg.stateDir;

  mkRepoService = repo: {
    name = unitName repo;
    value = {
      description = "nuage-autopilot: ${repo} の 1 サイクルを実行する";

      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      # git / gh をサービスの PATH に含める。
      # extraPackages は Nix パッケージ、extraPathPrefixes は Nix 管理外の
      # インストール先（公式インストーラで入れた claude / agy など）を通すための枠。
      #
      # environment.PATH を直接定義しないこと。NixOS の systemd モジュールが
      # 全サービスに対して coreutils 等を含む environment.PATH を定義しており、
      # 追加で定義すると値の衝突でエラーになる。path はリストとして正しくマージされる。
      path = [ pkgs.git pkgs.gh ] ++ cfg.extraPackages ++ cfg.extraPathPrefixes;

      environment.NUAGE_STATE_DIR = cfg.stateDir;

      serviceConfig = {
        Type = "oneshot";

        StateDirectory = stateDirName;

        # 先頭の '-' はファイルが存在しなくても起動失敗にしないイディオム。
        # nuage-cluster の nix/modules/common.nix の nix-daemon.EnvironmentFile と同じ形。
        EnvironmentFile = cfg.environmentFile;

        # ハングした場合の検知（旧 Supervisor の代替）。
        TimeoutStartSec = cfg.timeout;

        ExecStart = "${lib.getExe cfg.package} --repo ${repo}";

        # DynamicUser は使わない: git clone と LLM CLI が安定した HOME を要求するため。
        #
        # claude / agy は CLI の TUI でサインインし、認証情報を実行ユーザーの HOME
        # (~/.claude 等) に保存する。サービスを root で動かすと、SSH でログインして
        # サインインしたユーザーの認証情報を読めない。そのため、人間がサインインする
        # ユーザーとサービスの実行ユーザーを一致させる。
        # systemd は User= 指定時に HOME / USER / LOGNAME を passwd から設定する。
        User = cfg.user;
      };
    };
  };

  mkRepoTimer = repo: {
    name = unitName repo;
    value = {
      description = "nuage-autopilot: ${repo} の実行タイマー";
      wantedBy = [ "timers.target" ];

      timerConfig = {
        OnCalendar = cfg.interval;
        Persistent = true;
        # リポジトリごとに実行時刻をずらし、同時多重実行の負荷集中を避ける。
        # 値自体は DESIGN.md に指定がないため妥当な既定値として選定した。
        RandomizedDelaySec = "5m";
        Unit = "${unitName repo}.service";
      };
    };
  };
in
{
  options.services.nuage-autopilot = {
    enable = mkEnableOption "nuage-autopilot（GitHub Issue/PR 駆動の自律開発オートパイロット）";

    package = mkOption {
      type = types.package;
      description = ''
        実行する nuage-autopilot パッケージ。
        既定値は本モジュールを export する flake.nix 側で `lib.mkDefault` により設定される。
        このモジュールを flake 外から単体で import する場合は明示的に指定すること。
      '';
    };

    repositories = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        対象リポジトリの一覧。"owner/name" 形式で指定する（例: "k-wa-wa/pechka"）。
        1 リポジトリにつき service + timer が 1 組ずつ生成される。
      '';
      example = [ "k-wa-wa/pechka" "k-wa-wa/nuage-cluster" ];
    };

    user = mkOption {
      type = types.str;
      default = "nixos";
      description = ''
        サービスの実行ユーザー。
        claude / agy は TUI でサインインした結果を実行ユーザーの HOME に保存するため、
        人間が SSH でログインしてサインインするユーザーと一致させる必要がある。
      '';
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/nuage-autopilot";
      description = "リポジトリの clone やサイクルの作業状態を置くディレクトリ。";
    };

    interval = mkOption {
      type = types.str;
      default = "*:0/5";
      description = "systemd の `OnCalendar` 形式で指定する実行間隔。";
    };

    enableTimer = mkOption {
      type = types.bool;
      default = true;
      description = ''
        タイマーによる定期実行を行うかどうか。

        false にしてもサービス本体の unit は生成されるため、
        `systemctl start nuage-autopilot-<repo>.service` で手動実行できる。
        導入直後や挙動を変更した直後など、まず 1 サイクルを目視で確認したい場合に false にする。

        `systemctl stop ...timer` で止める運用にしないこと。
        次回の nixos-rebuild で構成が復元され、意図せず定期実行が再開される。
      '';
    };

    environmentFile = mkOption {
      type = types.str;
      default = "-/var/lib/nuage-autopilot/secrets.env";
      description = ''
        secret を注入する `EnvironmentFile`。先頭の `-` はファイルが存在しなくても
        サービスの起動を失敗させないことを意味する。
      '';
    };

    timeout = mkOption {
      type = types.str;
      default = "30m";
      description = "1 サイクルあたりの `TimeoutStartSec`。ハング検知に用いる。";
    };

    extraPackages = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = "サービスの実行時 PATH に追加する Nix パッケージ。";
    };

    extraPathPrefixes = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "/home/nixos/.local" ];
      description = ''
        Nix パッケージになっていない CLI（公式インストーラで導入した claude / agy など）を
        サービスの実行時 PATH に通すためのディレクトリ。

        NixOS の `systemd.services.<name>.path` の仕様により、各要素の末尾に `/bin` と
        `/sbin` が付与されて PATH に追加される。したがって `/home/nixos/.local/bin` を
        通したい場合は、その親である `/home/nixos/.local` を指定する。
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.repositories != [ ];
        message = "services.nuage-autopilot.repositories を空にしたまま enable することはできない";
      }
    ];

    # サービス本体は enableTimer の値によらず常に生成する。
    # タイマーを止めていても systemctl start で手動実行できるようにするため。
    systemd.services = listToAttrs (map mkRepoService cfg.repositories);
    systemd.timers = mkIf cfg.enableTimer (listToAttrs (map mkRepoTimer cfg.repositories));
  };
}
