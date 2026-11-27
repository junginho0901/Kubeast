"""How an answer names its causes (AI_CAUSE_NAMING, chart ai.causeNaming, off by default): only what a tool result shows to
be at fault, so two ends of a call the results do not tell apart are candidates and not causes; the object that holds what is
wrong and not the one the symptom shows on, what is wrong with it as one kind, and every independent cause.

The chat's system prompt says it as a section (ai/prompts.py) for a cause given in words or in a form the question asks
for: the chat has no block of its own. An alert investigation's says it beside its rca block (investigation/rca.py; nothing
with no block). The block's shape stays what it was: "causes" is the list it always was, its first entry the main cause,
and "path" is one chain, the first entry's. Off, neither prompt holds a word of it.
"""

from __future__ import annotations

from app.services import switch

# The kinds of investigation/rca.py KINDS, in its order, each with what it says of the object a cause names. A thing that can
# be changed is named in one line only, the one the "kind" line of both texts takes when two kinds fit.
KIND_MEANINGS: dict[str, str] = {
    "crash": "the process exits or is killed by an error of its own, with no change shown",
    "oom": "the container is killed for memory its own use grew to, with no change shown",
    "image": "the image cannot be pulled: its name, tag, credential or registry is wrong",
    "config_change": "a setting no other line names was changed, is missing or is wrong: in a ConfigMap, a Secret, an env "
    "variable, a command, an argument, a probe or another field",
    "rollout": "a new revision, its image pulled, fails or does not finish by its own code",
    "network_policy": "a NetworkPolicy stops the traffic",
    "dns": "the name service, or a setting of its own, resolves a name to nothing or not to what was meant",
    "resource_limit": "a CPU or memory request or limit was changed, or does not fit what the container needs",
    "quota": "a ResourceQuota or LimitRange refuses it",
    "node": "a node is not ready, under pressure or out of CPU, memory or disk, by itself or used up by a workload on it",
    "dependency_down": "what is called is shown to be gone, to refuse or to fail, but not why",
    "dependency_slow": "what is called, or the way to it, is shown to answer late, but not why",
    "storage": "a volume, its claim or its class is missing, not mounted, full or read-only",
    "none": "no fault",
}

_KINDS = "\n".join(f"  - {kind}: {meaning}" for kind, meaning in KIND_MEANINGS.items())

# Beside the investigation's rca block, after its shape.
INVESTIGATION = (
    'How to fill "causes": only what a tool result shows to be at fault goes in it, and this wins over every line below.\n'
    '- "resource" is the object that holds what is wrong: the one that was changed, or that fails with nothing before it '
    'changed or failing. The object the symptom shows on ends "path"; it is a cause only when it is that object too. For a '
    "setting read from a ConfigMap or Secret it is that ConfigMap or Secret (when a new revision only points the workload at "
    "another one, the one it reads now). For the image, command, env, requests or limits in a workload's own template it is "
    "that workload, for traffic a NetworkPolicy stops that policy, and for a node whose CPU or memory one workload uses up "
    "that workload.\n"
    '- "kind" is what is wrong with that object, not how the symptom looks. When more than one fits, what was changed decides: '
    "the kind whose line names it, not the kind of what it led to; with no change shown, the kind of what went wrong first. The "
    "kinds:\n"
    f"{_KINDS}\n"
    "- A slow or broken call has two ends. When the results show both but not which is at fault, neither is a cause: both are "
    'candidates, the callee first, in "hypotheses" as blocked (the calls that show its side under "for", what would tell the two '
    'apart under "blocked") or, in a block without it, as hypotheses in the report. With no other cause "causes" is [], '
    '"no_fault" false and "outcome", where the block has it, cannot_tell. When they show that one end, or an object between the '
    "two, is at fault, name that one only.\n"
    "- List every independent cause of the alert's symptom the results show, an entry each, the one that explains most of it "
    'first; "path" is that one\'s. What was failing before and no result shows to bring the symptom about is not one; what '
    'began before and a result shows to bring it about is. What a cause brought about is not another cause: it goes in "path". '
    "Never add one to be on the safe side.\n"
)

# The chat's section, before the language rules.
CHAT_SECTION = f"""### 원인을 적는 법
원인을 대는 답은 글이든 질문이 달라고 한 표·JSON이든, 원인마다 어느 객체(resource)의 무엇이 잘못됐는지(kind)를 이렇게 적으세요. 도구 결과가 잘못됐다고 보여 준 것만 원인이고, 이 규칙이 아래 모든 줄에 앞섭니다.
- **resource**: 잘못된 것을 가진 객체(`Kind/namespace/name`)입니다 — 바뀐 것, 또는 그 앞에 바뀌거나 고장 난 것 없이 고장 난 것. 증상이 보이는 객체는 경로(path)의 끝이고, 그 객체와 같을 때만 원인입니다. ConfigMap·Secret에서 읽는 설정이면 그 ConfigMap·Secret(새 리비전이 워크로드가 읽는 것을 다른 것으로 돌렸을 뿐이면 지금 읽는 것)이고, 워크로드 자신의 이미지·명령·env·requests·limits면 그 워크로드, NetworkPolicy가 막는 트래픽이면 그 정책, 한 워크로드가 노드의 CPU·메모리를 다 쓰면 그 워크로드입니다.
- **kind**: 증상의 모양이 아니라 그 객체의 무엇이 잘못됐나입니다. 둘 이상이 맞으면 바뀐 것으로 정하세요: 바뀐 것을 말하는 줄의 종류이고, 그것이 낳은 것의 종류가 아닙니다. 바뀐 것이 보이지 않으면 먼저 잘못된 것의 종류입니다. 질문이 낱말을 고르라고 하면 아래 뜻으로 고르고, 글로 답할 때는 낱말 대신 뜻을 쓰세요.
{_KINDS}
- **느리거나 끊긴 호출의 양 끝**: 결과가 양 끝을 다 보여 주는데 어느 쪽 탓인지는 보여 주지 않으면, 둘 다 원인이 아니라 후보입니다. 불리는 쪽부터 둘 다 후보로 적고(쪽마다 그것을 보여 준 호출과, 둘을 가를 다음 확인을 함께; 질문이 준 양식에 후보 칸이 없으면 답의 글에), 다른 원인이 없으면 원인은 비우고 알 수 없다고 답하세요. 한쪽 탓이나 둘 사이의 객체 탓인 것이 보이면 그것만 원인으로 적으세요.
- **서로 다른 원인이 여럿이면 모두**: 결과가 물은 증상의 원인으로 보여 준 것을 하나도 빼지 말고 하나씩, 증상을 가장 많이 설명하는 것부터 적으세요. 전부터 고장 나 있어도 물은 증상이 그것에서 온다고 보여 준 결과가 없으면 원인이 아니고, 먼저 시작했어도 그런 결과가 있으면 원인입니다. 경로는 그 첫 원인의 것입니다. 한 원인이 낳은 것은 다른 원인이 아니라 경로에 들어갑니다. 혹시 몰라서 더 적지는 마세요."""


def on() -> bool:
    return switch.env_on("AI_CAUSE_NAMING")
