# Dashboard JSON Schema

`dashboard.v1alpha1.json` describes a Kubeast dashboard document (`apiVersion: kubeast.io/dashboards/v1alpha1`) in JSON Schema draft 2020-12. It is generated from the Go model in `internal/model`, so it lists the same fields, enums and name patterns the server checks.

Point an editor at it to get completion and errors while writing a dashboard by hand. In VS Code, `settings.json`:

```json
"json.schemas": [
  {
    "fileMatch": ["*.dashboard.json"],
    "url": "https://raw.githubusercontent.com/junginho0901/Kubeast/main/services/dashboards-service-go/schema/dashboard.v1alpha1.json"
  }
]
```

`examples/web-red.json` is a complete dashboard: rate, errors and duration of one HTTP service, with its error logs.

The schema checks shape. The server also checks rules that span fields, which a schema cannot say:

- `x + w` stays within the 24 columns, and every panel is placed exactly once.
- Variable names and query `refId`s within a panel are unique.
- `refresh` is at least 10s, and threshold steps go up.
- A `repeat` names a variable of the same dashboard.

After changing `internal/model`, regenerate the file from the module root:

```sh
go run ./cmd/schemagen
```

The test in `internal/schema` fails while the committed file differs from the model.
