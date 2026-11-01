# Import corpus

Published Grafana dashboards the importer is tested on (`TestCorpus`, `TestImportedCorpusPassesSchema`). Each folder holds the files of one source at its latest release when they were fetched (2026-11-01), unchanged, with that source's license. `SUMMARY.txt` is written by `go test -run TestCorpus -update`.

| Folder | Source | Version | License |
|---|---|---|---|
| `kube-prometheus/` | [prometheus-operator/kube-prometheus](https://github.com/prometheus-operator/kube-prometheus) `manifests/grafana-dashboardDefinitions.yaml`, each ConfigMap's JSON as a file | v0.19.0 (`799f3d73`) | Apache-2.0 (`LICENSE`) |
| `kubernetes-mixin/` | [kubernetes-monitoring/kubernetes-mixin](https://github.com/kubernetes-monitoring/kubernetes-mixin) release asset `dashboards_out/`: the 10 dashboards whose panels or queries differ from kube-prometheus's copy (the other 13 are the same and left out) | version-1.5.6 (`890c2ec0`) | Apache-2.0 (`LICENSE`, `NOTICE`) |
| `dotdc/` | [dotdc/grafana-dashboards-kubernetes](https://github.com/dotdc/grafana-dashboards-kubernetes) `dashboards/` | v3.0.8 (`e4faf59e`) | Apache-2.0 (`LICENSE`) |
| `node-exporter-full/` | [rfmoz/grafana-dashboards](https://github.com/rfmoz/grafana-dashboards) `prometheus/node-exporter-full.json` (no releases; latest commit of the file) | `d66cfafc` (2026-10-26) | Apache-2.0 (`LICENSE`) |
| `grafana-13.3.0-v1-resource/` | Six of the files above, and `../edge-cases.json`, saved in Grafana 13.3.0 (`6f8ce3c6`) and read back as a V1 Resource (`GET /apis/dashboard.grafana.app/v1/…`): the classic dashboard inside Grafana's resource envelope, migrated to schemaVersion 42 | Grafana 13.3.0 | as the source file's folder; `edge-cases` is this repository's (MIT) |

`../grafana-13.3.0-v2/` holds schema v2 documents (Grafana 13's default export) for the v2 import (`v2_test.go`), all from Grafana 13.3.0 (`6f8ce3c6`) in a local container:

- `pairs.tar.gz`: the 53 files above saved in Grafana and read back as v2 (`v2/`, `GET /apis/dashboard.grafana.app/v2/…`); then each v2 document stored again as it is (unchanged, checked) and read back as v1 (`v1/`): Grafana's own v2 → v1 conversion of that document. Reformatted with sorted keys. Licenses as the source file's folder.
- `native/`: seven v2 dashboards written for the layouts and v2-only features (`make_samples.py` writes them: tabs, auto grids, nested, collapsed and header-less rows, repeats, section variables and annotations, conditional rendering, a library panel, an element not placed, every variable kind), stored in Grafana and read back as v2 (`*.v2.json`), v2beta1 (`*.v2beta1.json`) and v1 (`*.v1.json`, Grafana's conversion). This repository's (MIT).
