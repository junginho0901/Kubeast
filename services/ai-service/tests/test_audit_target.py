from app.services.audit_target import MAX_OBJECTS, ToolTarget, kept_tool_args, tool_target, write_tool_input


ENV_PATCH = {"resource_type": "deployment", "resource_name": "web", "patch": {"spec": {"containers": [{"name": "app", "env": [
    {"name": "PWD", "value": "/app"}, {"name": "OLDPWD", "value": "/root"}, {"name": "pwd", "value": "~/app"},
    {"name": "DB_PWD", "value": "/fake-pass-1"}, {"name": "PWD", "value": "fake-pass-2"}, {"name": "PGPASSWORD", "value": "/fake-pass-3"},
    {"name": "DB_PASS", "value": "fake-pass-4"}, {"name": "API_KEYS", "value": "fake-key-1"},
]}]}}}
ENV_GONE = ("fake-pass-1", "fake-pass-2", "fake-pass-3", "fake-pass-4", "fake-key-1")


def test_a_write_row_keeps_the_working_directory_and_loses_the_credentials():
    preview = write_tool_input("k8s_patch_resource", ENV_PATCH)["patch_preview"]
    for gone in ENV_GONE:
        assert gone not in preview
    for kept in ("name: PWD\n", "value: /app", "value: /root", "value: ~/app"):
        assert kept in preview


def test_a_kept_write_argument_keeps_the_working_directory_and_loses_the_credentials():
    env = kept_tool_args(ENV_PATCH)["patch"]["spec"]["containers"][0]["env"]
    assert env == [
        {"name": "PWD", "value": "/app"}, {"name": "OLDPWD", "value": "/root"}, {"name": "pwd", "value": "~/app"},
        {"name": "DB_PWD", "value": "<REDACTED:DB_PWD>"}, {"name": "PWD", "value": "<REDACTED:PWD>"}, {"name": "PGPASSWORD", "value": "<REDACTED:PGPASSWORD>"},
        {"name": "DB_PASS", "value": "<REDACTED:DB_PASS>"}, {"name": "API_KEYS", "value": "<REDACTED:API_KEYS>"},
    ]


def test_a_json_patch_under_env_is_held_by_its_path_whatever_it_names():
    args = {"resource_type": "deployment", "resource_name": "web", "patch": [
        {"op": "add", "path": "/spec/containers/0/env/0", "value": {"name": "PWD", "value": "/app"}},
        {"op": "replace", "path": "/spec/containers/0/env/0/value", "value": "/app"},
    ]}
    assert [op["value"] for op in kept_tool_args(args)["patch"]] == ["<REDACTED:value>", "<REDACTED:value>"]


SECRET_LIST = "apiVersion: v1\nkind: SecretList\nitems:\n- metadata: {name: a, namespace: shop}\n  data: {cfg.json: ZmFrZS1jZmctdmFsdWU=}\n  stringData: {settings.ini: fake-settings-value}\n"
SECRET_LIST_GONE = ("ZmFrZS1jZmctdmFsdWU=", "fake-settings-value")


def test_a_typed_secret_list_loses_its_items_values_as_kubectl_reads_them_as_secrets():
    for tool in ("k8s_apply_manifest", "k8s_create_resource"):
        preview = write_tool_input(tool, {"yaml_content": SECRET_LIST})["manifest_preview"]
        assert "cfg.json" in preview and "settings.ini" in preview
        for gone in SECRET_LIST_GONE:
            assert gone not in preview
    kept = kept_tool_args({"yaml_content": SECRET_LIST})["yaml_content"]
    assert "cfg.json" in kept
    for gone in SECRET_LIST_GONE:
        assert gone not in kept
    as_object = kept_tool_args({"resource_manifest": {"kind": "SecretList", "items": [{"metadata": {"name": "a"}, "data": {"cfg.json": "ZmFrZS1jZmctdmFsdWU="}}]}})
    assert as_object["resource_manifest"]["items"][0]["data"] == {"cfg.json": "<REDACTED:secret>"}


def test_an_item_of_another_kind_in_a_secret_list_keeps_its_fields():
    manifest = {"kind": "SecretList", "items": [{"kind": "ConfigMap", "metadata": {"name": "a"}, "data": {"cfg.json": "plain-config"}}]}
    assert kept_tool_args({"resource_manifest": manifest})["resource_manifest"]["items"][0]["data"] == {"cfg.json": "plain-config"}


def test_named_arguments_are_the_target():
    args = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop"}
    assert tool_target("k8s_scale", args) == ToolTarget("deployment", "web", "shop", None)
    assert tool_target("k8s_get_pod_logs", {"pod_name": "web-1", "namespace": "shop"}) == ToolTarget("tool", "web-1", "shop", None)
    assert tool_target("k8s_get_resources", {"resource_type": "pods"}) == ToolTarget("pods", "k8s_get_resources", None, None)


def test_a_read_of_a_kubeast_record_names_that_record():
    assert tool_target("investigations", {"investigation_id": "inv-1"}) == ToolTarget("investigation", "inv-1", None, None)
    assert tool_target("investigations", {"status": "done"}) == ToolTarget("tool", "investigations", None, None)
    assert tool_target("session_recordings", {"recording_id": "r1"}) == ToolTarget("session_recording", "r1", None, None)
    assert tool_target("session_recordings", {"actor_email": "ann"}) == ToolTarget("tool", "session_recordings", None, None)


def test_one_object_in_yaml_json_or_a_dict():
    yaml_one = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: made\n  namespace: team-a\n"
    want = ToolTarget("ConfigMap", "made", "team-a", ["ConfigMap team-a/made"])
    assert tool_target("k8s_create_resource", {"yaml_content": yaml_one}) == want
    assert tool_target("k8s_apply_manifest", {"yaml_content": '{"kind":"ConfigMap","metadata":{"name":"made","namespace":"team-a"}}'}) == want
    assert tool_target("k8s_apply_manifest", {"resource_manifest": {"kind": "ConfigMap", "metadata": {"name": "made", "namespace": "team-a"}}}) == want
    # the namespace argument stands in for a manifest without one (k8s_diff)
    no_ns = "kind: Deployment\nmetadata:\n  name: web\n"
    assert tool_target("k8s_diff", {"yaml_content": no_ns, "namespace": "shop"}) == ToolTarget("Deployment", "web", "shop", ["Deployment shop/web"])
    assert tool_target("k8s_create_resource", {"yaml_content": "kind: Job\nmetadata:\n  generateName: run-\n"}).id == "run-"


def test_several_objects_and_lists():
    same_kind = "kind: ConfigMap\nmetadata:\n  name: a\n  namespace: x\n---\nkind: ConfigMap\nmetadata:\n  name: b\n  namespace: x\n"
    assert tool_target("k8s_apply_manifest", {"yaml_content": same_kind}) == ToolTarget("ConfigMap", "2 objects", "x", ["ConfigMap x/a", "ConfigMap x/b"])
    mixed = same_kind + "---\nkind: Namespace\nmetadata:\n  name: x\n---\n# empty document\n"
    t = tool_target("k8s_apply_manifest", {"yaml_content": mixed})
    assert (t.type, t.id, t.namespace) == ("manifest", "3 objects", None)
    assert t.objects[-1] == "Namespace x"
    as_list = '{"kind":"List","items":[{"kind":"Service","metadata":{"name":"s","namespace":"y"}},{"kind":"Service","metadata":{"name":"t","namespace":"y"}}]}'
    assert tool_target("k8s_apply_manifest", {"yaml_content": as_list}) == ToolTarget("Service", "2 objects", "y", ["Service y/s", "Service y/t"])
    many = "\n---\n".join(f"kind: ConfigMap\nmetadata:\n  name: c{i}\n" for i in range(MAX_OBJECTS + 5))
    t = tool_target("k8s_apply_manifest", {"yaml_content": many})
    assert t.id == f"{MAX_OBJECTS + 5} objects" and len(t.objects) == MAX_OBJECTS


def test_an_unreadable_manifest_falls_back_to_the_tool():
    assert tool_target("k8s_apply_manifest", {"yaml_content": "kind: [unclosed"}) == ToolTarget("tool", "k8s_apply_manifest", None, None)
    assert tool_target("k8s_apply_manifest", {"yaml_content": "just text"}) == ToolTarget("tool", "k8s_apply_manifest", None, None)
    assert tool_target("k8s_apply_manifest", {}) == ToolTarget("tool", "k8s_apply_manifest", None, None)
