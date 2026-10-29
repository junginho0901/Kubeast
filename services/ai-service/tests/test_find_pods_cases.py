"""find_pods matches a pod when every word of the query is in its name or in one label's key and value; k8s-service's
pods page does the same with match=tokens. The cases come from k8s-service's TestFindPodsCasesFixture
(UPDATE_FIND_PODS_CASES=1 rewrites them): this runs the resolvers' own matcher over them."""
import json
from pathlib import Path

from app.services.ai import resolvers

CASES = json.loads((Path(__file__).parent / "fixtures" / "find_pods_cases.json").read_text())


def test_find_pods_cases_match_the_pods_page():
    assert len(CASES) >= 400
    assert 40 <= sum(c["matches"] for c in CASES) <= len(CASES) - 40
    wrong = []
    for c in CASES:
        query = c["query"].strip()
        got = resolvers._all_tokens_in_text(None, query, c["name"]) or resolvers._query_in_mapping(None, query, c["labels"])
        if got != c["matches"]:
            wrong.append(c)
    assert wrong == []
