from app.services.audit_target import MAX_OBJECTS, ToolTarget, tool_target


def test_named_arguments_are_the_target():
    args = {"resource_type": "deployment", "resource_name": "web", "namespace": "shop"}
    assert tool_target("k8s_scale", args) == ToolTarget("deployment", "web", "shop", None)
    assert tool_target("k8s_get_pod_logs", {"pod_name": "web-1", "namespace": "shop"}) == ToolTarget("tool", "web-1", "shop", None)
    assert tool_target("k8s_get_resources", {"resource_type": "pods"}) == ToolTarget("pods", "k8s_get_resources", None, None)


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
