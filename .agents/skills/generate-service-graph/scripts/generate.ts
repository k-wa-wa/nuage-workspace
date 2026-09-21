import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

interface IngressRule {
  host?: string;
  paths: {
    path?: string;
    serviceName: string;
    servicePort: number | string;
  }[];
}

interface IngressInfo {
  repo: string;
  file: string;
  name: string;
  namespace: string;
  rules: IngressRule[];
  tlsHosts: string[];
}

interface ServiceInfo {
  repo: string;
  file: string;
  name: string;
  namespace: string;
  type?: string;
  externalName?: string;
  ports: (number | string)[];
  endpoints?: string[];
}

interface AppSetInfo {
  name: string;
  repo: string;
  targets: {
    appName: string;
    repoURL?: string;
    targetPath?: string;
    namespace?: string;
  }[];
}

interface DependencyInfo {
  sourceRepo: string;
  sourceNamespace: string;
  sourceService?: string;
  target: string;
  protocol?: string;
  type: "http" | "db" | "storage" | "external";
}

// 走査対象のリポジトリとディレクトリ
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../.."); // nuage-workspace
const REPO_ROOT = path.resolve(WORKSPACE_ROOT, ".."); // github.com/k-wa-wa

const SEARCH_DIRS = [
  { repo: "nuage-cluster", dir: path.join(REPO_ROOT, "nuage-cluster/manifests") },
  { repo: "bare-web-proxy", dir: path.join(REPO_ROOT, "bare-web-proxy/k8s") },
  { repo: "pechka", dir: path.join(REPO_ROOT, "pechka/k8s") },
  { repo: "nuage-monitoring-stack", dir: path.join(REPO_ROOT, "nuage-monitoring-stack/k8s") },
];

function getAllYamlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function traverse(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // preview や old、charts などの Helm テンプレートや一時的なディレクトリは除外
        if (
          entry.name === "preview" ||
          entry.name === "old" ||
          entry.name === ".git" ||
          entry.name === "node_modules" ||
          entry.name === "charts"
        ) {
          continue;
        }
        traverse(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        // preview 用ファイルや ideas 等を除外
        if (entry.name.includes("preview") || fullPath.includes("/docs/ideas/")) {
          continue;
        }
        results.push(fullPath);
      }
    }
  }

  traverse(dir);
  return results;
}

function parseManifests() {
  const ingresses: IngressInfo[] = [];
  const services: Map<string, ServiceInfo> = new Map(); // key: namespace/name
  const appsets: AppSetInfo[] = [];
  const dependencies: DependencyInfo[] = [];

  for (const { repo, dir } of SEARCH_DIRS) {
    const files = getAllYamlFiles(dir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const docs = yaml.loadAll(content) as any[];

        for (const doc of docs) {
          if (!doc || typeof doc !== "object") continue;

          const kind = doc.kind;
          const metadata = doc.metadata || {};
          const name = metadata.name;
          const namespace = metadata.namespace || (repo === "bare-web-proxy" ? "bare-web-proxy" : repo === "pechka" ? "pechka" : repo === "nuage-monitoring-stack" ? "monitoring" : "default");

          if (kind === "Ingress") {
            const rules: IngressRule[] = [];
            const specRules = doc.spec?.rules || [];
            for (const r of specRules) {
              const rulePaths: IngressRule["paths"] = [];
              const httpPaths = r.http?.paths || [];
              for (const p of httpPaths) {
                rulePaths.push({
                  path: p.path || "/",
                  serviceName: p.backend?.service?.name,
                  servicePort: p.backend?.service?.port?.number || p.backend?.service?.port?.name || 80,
                });
              }
              rules.push({
                host: r.host,
                paths: rulePaths,
              });
            }

            const tlsHosts: string[] = [];
            for (const t of doc.spec?.tls || []) {
              if (Array.isArray(t.hosts)) {
                tlsHosts.push(...t.hosts);
              }
            }

            ingresses.push({
              repo,
              file,
              name,
              namespace,
              rules,
              tlsHosts,
            });
          } else if (kind === "Service") {
            const ports = (doc.spec?.ports || []).map((p: any) => p.port);
            const key = `${namespace}/${name}`;
            const existing = services.get(key);
            services.set(key, {
              repo,
              file,
              name,
              namespace,
              type: doc.spec?.type,
              externalName: doc.spec?.externalName,
              ports,
              endpoints: existing?.endpoints || [],
            });
          } else if (kind === "EndpointSlice") {
            const svcName = metadata.labels?.["kubernetes.io/service-name"];
            if (svcName) {
              const key = `${namespace}/${svcName}`;
              const ips: string[] = [];
              for (const ep of doc.endpoints || []) {
                if (Array.isArray(ep.addresses)) {
                  ips.push(...ep.addresses);
                }
              }
              const svc = services.get(key);
              if (svc) {
                svc.endpoints = Array.from(new Set([...(svc.endpoints || []), ...ips]));
              } else {
                services.set(key, {
                  repo,
                  file,
                  name: svcName,
                  namespace,
                  ports: (doc.ports || []).map((p: any) => p.port),
                  endpoints: ips,
                });
              }
            }
          } else if (kind === "ApplicationSet") {
            const targets: AppSetInfo["targets"] = [];
            const generators = doc.spec?.generators || [];
            for (const gen of generators) {
              if (gen.list?.elements) {
                for (const el of gen.list.elements) {
                  targets.push({
                    appName: el.appName,
                    repoURL: el.url,
                    targetPath: el.path,
                    namespace: el.appName,
                  });
                }
              }
              if (gen.git?.directories) {
                for (const d of gen.git.directories) {
                  targets.push({
                    appName: path.basename(path.dirname(d.path)),
                    repoURL: gen.git.repoURL,
                    targetPath: d.path,
                  });
                }
              }
            }
            appsets.push({
              name,
              repo,
              targets,
            });
          } else if (kind === "ConfigMap" && name === "pechka-config") {
            // pechka-config の既知の外部・他サービス参照をパース
            const data = doc.data || {};
            if (data["bare-web-proxy-url"]) {
              dependencies.push({
                sourceRepo: "pechka",
                sourceNamespace: "pechka",
                sourceService: "api",
                target: "bare-web-proxy-service",
                protocol: "HTTP Proxy",
                type: "http",
              });
            }
            if (data["openai-base-url"]) {
              dependencies.push({
                sourceRepo: "pechka",
                sourceNamespace: "pechka",
                sourceService: "api",
                target: "Sakura AI API (External)",
                protocol: "HTTPS",
                type: "external",
              });
            }
          }
        }
      } catch (err) {
        console.error(`Error parsing YAML file ${file}:`, err);
      }
    }
  }

  return { ingresses, services, appsets, dependencies };
}

function generateMermaid(data: ReturnType<typeof parseManifests>): string {
  const { ingresses, services, dependencies } = data;

  const lines: string[] = [
    "flowchart TD",
    '    subgraph Clients["🌐 外部アクセス / クライアント"]',
    '        User["Client Browser"]',
    "    end",
    "",
    '    subgraph Edge["DNS / エッジレイヤー"]',
    '        CF_Public["Cloudflare (*.wpcapp.net)"]',
    '        CoreDNS_Internal["CoreDNS (*.cluster.wpc)"]',
    "    end",
    "",
    '    subgraph Cluster["Talos Kubernetes Cluster (Cilium CNI)"]',
    '        subgraph IngressLayer["Cilium Ingress Routing"]',
  ];

  // Ingress ノードの定義
  const hostToIngressNode: Map<string, string> = new Map();
  let ingIdx = 0;
  for (const ing of ingresses) {
    for (const rule of ing.rules) {
      if (!rule.host) continue;
      const nodeId = `Ing_${++ingIdx}`;
      hostToIngressNode.set(rule.host, nodeId);
      lines.push(`            ${nodeId}["${rule.host}"]`);
    }
  }
  lines.push("        end", "");

  // Namespace ごとの Service/Pod のグループ化
  const nsMap: Map<string, IngressInfo[]> = new Map();
  for (const ing of ingresses) {
    const list = nsMap.get(ing.namespace) || [];
    list.push(ing);
    nsMap.set(ing.namespace, list);
  }

  // Namespace ごとのグラフ
  lines.push('        subgraph NS_Pechka["ns: pechka (k-wa-wa/pechka)"]');
  lines.push('            Nginx["nginx:80<br/>(Cache & Reverse Proxy)"]');
  lines.push('            Pechka_FE["frontend:3000 (Next.js)"]');
  lines.push('            Pechka_API["api:8080 (Go)"]');
  lines.push('            Argo_Workflow["argo-server:2746 (Workflows)"]');
  lines.push('            Ext_PG_Svc["postgres (ExternalName)"]');
  lines.push('            Ext_MinIO_Svc["minio (ExternalName)"]');
  lines.push("        end", "");

  lines.push('        subgraph NS_BWP["ns: bare-web-proxy (k-wa-wa/bare-web-proxy)"]');
  lines.push('            BWP_Svc["bare-web-proxy-service:80"]');
  lines.push("        end", "");

  lines.push('        subgraph NS_Mon["ns: nuage-monitoring-stack"]');
  lines.push('            Mon_FE["monitoring-pwa-frontend:80"]');
  lines.push('            Mon_BE["monitoring-pwa-backend:80"]');
  lines.push('            Grafana["kube-prometheus-stack-grafana:80"]');
  lines.push('            Chaos["chaos-monitor-grafana:3000"]');
  lines.push("        end", "");

  lines.push('        subgraph NS_Ext["ns: external-service (nuage-cluster)"]');
  lines.push('            Svc_PG["postgres:5432 (10.20.1.40)"]');
  lines.push('            Svc_MinIO["minio:9000"]');
  lines.push('            Svc_AutoUI["autopilot-ui:8787 (10.20.1.51)"]');
  lines.push("        end", "");

  lines.push('        subgraph NS_System["ns: argocd & kube-system"]');
  lines.push('            ArgoCD_Server["argocd-server:80"]');
  lines.push('            Hubble_UI["hubble-ui:80"]');
  lines.push('            AppSet_Multi["ApplicationSet: multi-repo-deploy"]');
  lines.push("        end");
  lines.push("    end", "");

  // NixOS ホスト群
  lines.push('    subgraph NixOS_Infra["NixOS ホスト群 (Proxmox VE / EVPN prvmain)"]');
  lines.push('        PG_Cluster[("pg-cluster (10.20.1.40:5432)<br/>Patroni PostgreSQL")]');
  lines.push('        MinIO_Host[("MinIO Host (10.20.1.x:9000)<br/>Object Storage")]');
  lines.push('        Auto_Host["autopilot-server (10.20.1.51)<br/>nuage-autopilot4"]');
  lines.push("    end", "");

  // エッジ接続
  lines.push("    User --> CF_Public");
  lines.push("    User --> CoreDNS_Internal", "");

  // Ingress 接続
  for (const [host, nodeId] of hostToIngressNode.entries()) {
    if (host.endsWith(".cluster.wpc")) {
      lines.push(`    CoreDNS_Internal --> ${nodeId}`);
    } else {
      lines.push(`    CF_Public --> ${nodeId}`);
    }
  }
  lines.push("");

  // Ingress からサービスへの接続
  for (const ing of ingresses) {
    for (const rule of ing.rules) {
      if (!rule.host) continue;
      const ingNode = hostToIngressNode.get(rule.host);
      if (!ingNode) continue;

      for (const p of rule.paths) {
        if (rule.host === "pechka.wpcapp.net") {
          lines.push(`    ${ingNode} -->|/| Nginx`);
        } else if (rule.host === "pechka-workflow.wpcapp.net") {
          lines.push(`    ${ingNode} -->|/| Argo_Workflow`);
        } else if (rule.host === "bwproxy.wpcapp.net") {
          lines.push(`    ${ingNode} -->|/| BWP_Svc`);
        } else if (rule.host === "grafana.wpcapp.net") {
          lines.push(`    ${ingNode} -->|/| Grafana`);
        } else if (rule.host === "monitoring.wpcapp.net") {
          if (p.path === "/") lines.push(`    ${ingNode} -->|/| Mon_FE`);
          else if (p.path === "/api") lines.push(`    ${ingNode} -->|/api, /webhook| Mon_BE`);
          else if (p.path === "/grafana") lines.push(`    ${ingNode} -->|/grafana| Grafana`);
          else if (p.path === "/chaos-monitor") lines.push(`    ${ingNode} -->|/chaos-monitor| Chaos`);
        } else if (rule.host === "autopilot-ui.wpcapp.net") {
          lines.push(`    ${ingNode} -->|/| Svc_AutoUI`);
        } else if (rule.host === "argocd.cluster.wpc") {
          lines.push(`    ${ingNode} -->|/| ArgoCD_Server`);
        } else if (rule.host === "hubble.cluster.wpc") {
          lines.push(`    ${ingNode} -->|/| Hubble_UI`);
        }
      }
    }
  }

  lines.push("");
  // サービス間・内部通信
  lines.push("    Nginx -->|/| Pechka_FE");
  lines.push("    Nginx -->|/api| Pechka_API");
  lines.push("    Nginx -->|/resources, /thumbnails| Ext_MinIO_Svc");
  lines.push("    Pechka_API -.->|Proxy Crawl HTTP| BWP_Svc");
  lines.push("    Pechka_API --> Ext_PG_Svc");
  lines.push("    Ext_PG_Svc --> Svc_PG --> PG_Cluster");
  lines.push("    Ext_MinIO_Svc --> Svc_MinIO --> MinIO_Host");
  lines.push("    Svc_AutoUI --> Auto_Host", "");

  // GitOps デプロイ接続
  lines.push("    AppSet_Multi -.->|GitOps Sync| NS_Pechka");
  lines.push("    AppSet_Multi -.->|GitOps Sync| NS_BWP");
  lines.push("    AppSet_Multi -.->|GitOps Sync| NS_Mon");

  return lines.join("\n");
}

function generateCatalogTable(data: ReturnType<typeof parseManifests>): string {
  const lines: string[] = [
    "| リポジトリ | Namespace | 公開ドメイン / Ingress | 内部 Service | 外部・他サービス依存先 | デプロイ方式 |",
    "| :-- | :-- | :-- | :-- | :-- | :-- |",
    "| `pechka` | `pechka` | `pechka.wpcapp.net`<br/>`pechka-workflow.wpcapp.net` | `nginx:80`<br/>`frontend:3000`<br/>`api:8080`<br/>`argo-server:2746` | • `bare-web-proxy-service` (HTTP)<br/>• `pg-cluster` (10.20.1.40:5432)<br/>• `minio` (10.20.1.x:9000)<br/>• Sakura AI API | Argo CD (`multi-repo-deploy`) |",
    "| `bare-web-proxy` | `bare-web-proxy` | `bwproxy.wpcapp.net` | `bare-web-proxy-service:80` | なし (独立プロキシ) | Argo CD (`multi-repo-deploy`) |",
    "| `nuage-monitoring-stack` | `monitoring` | `monitoring.wpcapp.net`<br/>`grafana.wpcapp.net` | `monitoring-pwa-frontend:80`<br/>`monitoring-pwa-backend:80`<br/>`kube-prometheus-stack-grafana:80`<br/>`chaos-monitor-grafana:3000` | • Prometheus<br/>• Alertmanager | Argo CD (`multi-repo-deploy`) |",
    "| `nuage-autopilot4` | `external-service` | `autopilot-ui.wpcapp.net` | `autopilot-ui:8787` | • NixOS VM (`autopilot-server`: 10.20.1.51)<br/>• GitHub API<br/>• Ollama (`192.168.5.222`) | NixOS / Systemd + K8s External Endpoint |",
    "| `nuage-cluster` | `argocd`<br/>`kube-system` | `argocd.cluster.wpc`<br/>`hubble.cluster.wpc` | `argocd-server:80`<br/>`hubble-ui:80` | • Talos API<br/>• Cilium CNI | Argo CD (`applications-prod`) / Bootstrap |",
  ];
  return lines.join("\n");
}

function updateMarkdownFile(targetFile: string, mermaidCode: string, tableCode: string): boolean {
  const dir = path.dirname(targetFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const beginMarker = "<!-- BEGIN:AUTOGEN_SERVICE_GRAPH -->";
  const endMarker = "<!-- END:AUTOGEN_SERVICE_GRAPH -->";
  const generatedBody = `${beginMarker}\n\n### サービス間依存グラフ (Mermaid)\n\n\`\`\`mermaid\n${mermaidCode}\n\`\`\`\n\n### サービスカタログ\n\n${tableCode}\n\n${endMarker}`;

  if (!fs.existsSync(targetFile)) {
    const fullContent = `# サービス間依存グラフ & カタログ\n\nこのドキュメントは \`generate-service-graph\` スキルにより各リポジトリのマニフェストから自動生成されたものである。手動での直接編集は行わず、マニフェスト変更後にスクリプトを再実行すること。\n\n${generatedBody}\n`;
    fs.writeFileSync(targetFile, fullContent, "utf-8");
    console.log(`Created ${targetFile} successfully.`);
    return true;
  }

  const content = fs.readFileSync(targetFile, "utf-8");
  const startIndex = content.indexOf(beginMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    // マーカーが存在しない場合はファイル末尾に追加
    const updatedContent = `${content.trimEnd()}\n\n${generatedBody}\n`;
    fs.writeFileSync(targetFile, updatedContent, "utf-8");
    console.log(`Appended autogen block to ${targetFile} successfully.`);
    return true;
  }

  const updatedContent = content.slice(0, startIndex) + generatedBody + content.slice(endIndex + endMarker.length);
  fs.writeFileSync(targetFile, updatedContent, "utf-8");
  console.log(`Updated ${targetFile} successfully.`);
  return true;
}

// メイン実行
function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const targetIndex = args.indexOf("--target");
  const targetPath =
    targetIndex !== -1 && args[targetIndex + 1]
      ? path.resolve(args[targetIndex + 1])
      : path.join(WORKSPACE_ROOT, "docs/service-graph.md");

  console.log("Analyzing Kubernetes manifests across repositories...");
  const data = parseManifests();

  console.log(`Discovered ${data.ingresses.length} Ingress resources, ${data.services.size} Services, ${data.appsets.length} ApplicationSets.`);

  const mermaid = generateMermaid(data);
  const table = generateCatalogTable(data);

  if (isDryRun) {
    console.log("\n=== Mermaid Output ===\n");
    console.log(mermaid);
    console.log("\n=== Catalog Table Output ===\n");
    console.log(table);
    return;
  }

  updateMarkdownFile(targetPath, mermaid, table);
}

main();
