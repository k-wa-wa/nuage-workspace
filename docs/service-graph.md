# サービス間依存グラフ & カタログ

このドキュメントは `generate-service-graph` スキルにより各リポジトリのマニフェストから自動生成されたものである。手動での直接編集は行わず、マニフェスト変更後にスクリプトを再実行すること。

<!-- BEGIN:AUTOGEN_SERVICE_GRAPH -->

### サービス間依存グラフ (Mermaid)

```mermaid
flowchart TD
    subgraph Clients["🌐 外部アクセス / クライアント"]
        User["Client Browser"]
    end

    subgraph Edge["DNS / エッジレイヤー"]
        CF_Public["Cloudflare (*.wpcapp.net)"]
        CoreDNS_Internal["CoreDNS (*.cluster.wpc)"]
    end

    subgraph Cluster["Talos Kubernetes Cluster (Cilium CNI)"]
        subgraph IngressLayer["Cilium Ingress Routing"]
            Ing_1["hubble.cluster.wpc"]
            Ing_2["autopilot-ui.wpcapp.net"]
            Ing_3["argocd.cluster.wpc"]
            Ing_4["bwproxy.wpcapp.net"]
            Ing_5["pechka.wpcapp.net"]
            Ing_6["pechka-workflow.wpcapp.net"]
            Ing_7["grafana.wpcapp.net"]
            Ing_8["monitoring.wpcapp.net"]
        end

        subgraph NS_Pechka["ns: pechka (k-wa-wa/pechka)"]
            Nginx["nginx:80<br/>(Cache & Reverse Proxy)"]
            Pechka_FE["frontend:3000 (Next.js)"]
            Pechka_API["api:8080 (Go)"]
            Argo_Workflow["argo-server:2746 (Workflows)"]
            Ext_PG_Svc["postgres (ExternalName)"]
            Ext_MinIO_Svc["minio (ExternalName)"]
        end

        subgraph NS_BWP["ns: bare-web-proxy (k-wa-wa/bare-web-proxy)"]
            BWP_Svc["bare-web-proxy-service:80"]
        end

        subgraph NS_Mon["ns: nuage-monitoring-stack"]
            Mon_FE["monitoring-pwa-frontend:80"]
            Mon_BE["monitoring-pwa-backend:80"]
            Grafana["kube-prometheus-stack-grafana:80"]
            Chaos["chaos-monitor-grafana:3000"]
        end

        subgraph NS_Ext["ns: external-service (nuage-cluster)"]
            Svc_PG["postgres:5432 (10.20.1.40)"]
            Svc_MinIO["minio:9000"]
            Svc_AutoUI["autopilot-ui:8787 (10.20.1.51)"]
        end

        subgraph NS_System["ns: argocd & kube-system"]
            ArgoCD_Server["argocd-server:80"]
            Hubble_UI["hubble-ui:80"]
            AppSet_Multi["ApplicationSet: multi-repo-deploy"]
        end
    end

    subgraph NixOS_Infra["NixOS ホスト群 (Proxmox VE / EVPN prvmain)"]
        PG_Cluster[("pg-cluster (10.20.1.40:5432)<br/>Patroni PostgreSQL")]
        MinIO_Host[("MinIO Host (10.20.1.x:9000)<br/>Object Storage")]
        Auto_Host["autopilot-server (10.20.1.51)<br/>nuage-autopilot4"]
    end

    User --> CF_Public
    User --> CoreDNS_Internal

    CoreDNS_Internal --> Ing_1
    CF_Public --> Ing_2
    CoreDNS_Internal --> Ing_3
    CF_Public --> Ing_4
    CF_Public --> Ing_5
    CF_Public --> Ing_6
    CF_Public --> Ing_7
    CF_Public --> Ing_8

    Ing_1 -->|/| Hubble_UI
    Ing_2 -->|/| Svc_AutoUI
    Ing_3 -->|/| ArgoCD_Server
    Ing_4 -->|/| BWP_Svc
    Ing_5 -->|/| Nginx
    Ing_6 -->|/| Argo_Workflow
    Ing_7 -->|/| Grafana
    Ing_8 -->|/api, /webhook| Mon_BE
    Ing_8 -->|/grafana| Grafana
    Ing_8 -->|/chaos-monitor| Chaos
    Ing_8 -->|/| Mon_FE

    Nginx -->|/| Pechka_FE
    Nginx -->|/api| Pechka_API
    Nginx -->|/resources, /thumbnails| Ext_MinIO_Svc
    Pechka_API -.->|Proxy Crawl HTTP| BWP_Svc
    Pechka_API --> Ext_PG_Svc
    Ext_PG_Svc --> Svc_PG --> PG_Cluster
    Ext_MinIO_Svc --> Svc_MinIO --> MinIO_Host
    Svc_AutoUI --> Auto_Host

    AppSet_Multi -.->|GitOps Sync| NS_Pechka
    AppSet_Multi -.->|GitOps Sync| NS_BWP
    AppSet_Multi -.->|GitOps Sync| NS_Mon
```

### サービスカタログ

| リポジトリ | Namespace | 公開ドメイン / Ingress | 内部 Service | 外部・他サービス依存先 | デプロイ方式 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `pechka` | `pechka` | `pechka.wpcapp.net`<br/>`pechka-workflow.wpcapp.net` | `nginx:80`<br/>`frontend:3000`<br/>`api:8080`<br/>`argo-server:2746` | • `bare-web-proxy-service` (HTTP)<br/>• `pg-cluster` (10.20.1.40:5432)<br/>• `minio` (10.20.1.x:9000)<br/>• Sakura AI API | Argo CD (`multi-repo-deploy`) |
| `bare-web-proxy` | `bare-web-proxy` | `bwproxy.wpcapp.net` | `bare-web-proxy-service:80` | なし (独立プロキシ) | Argo CD (`multi-repo-deploy`) |
| `nuage-monitoring-stack` | `monitoring` | `monitoring.wpcapp.net`<br/>`grafana.wpcapp.net` | `monitoring-pwa-frontend:80`<br/>`monitoring-pwa-backend:80`<br/>`kube-prometheus-stack-grafana:80`<br/>`chaos-monitor-grafana:3000` | • Prometheus<br/>• Alertmanager | Argo CD (`multi-repo-deploy`) |
| `nuage-autopilot4` | `external-service` | `autopilot-ui.wpcapp.net` | `autopilot-ui:8787` | • NixOS VM (`autopilot-server`: 10.20.1.51)<br/>• GitHub API<br/>• Ollama (`192.168.5.222`) | NixOS / Systemd + K8s External Endpoint |
| `nuage-cluster` | `argocd`<br/>`kube-system` | `argocd.cluster.wpc`<br/>`hubble.cluster.wpc` | `argocd-server:80`<br/>`hubble-ui:80` | • Talos API<br/>• Cilium CNI | Argo CD (`applications-prod`) / Bootstrap |

<!-- END:AUTOGEN_SERVICE_GRAPH -->
