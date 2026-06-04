"""
Kubernetes 리소스 수량(quantity) 파싱/계산 헬퍼.

ai_service.py 에서 추출. self 의존이 없는 순수 함수 모음.
"""
from typing import Dict, List, Optional


def parse_cpu_quantity_to_m(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        if s.endswith("m"):
            return int(float(s[:-1]))
        if s.endswith("n"):
            # nano cores -> millicores
            return int(float(s[:-1]) / 1_000_000)
        # assume cores
        return int(float(s) * 1000)
    except Exception:
        return None


def parse_memory_quantity_to_mi(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        if s.endswith("Ki"):
            return int(float(s[:-2]) / 1024)
        if s.endswith("Mi"):
            return int(float(s[:-2]))
        if s.endswith("Gi"):
            return int(float(s[:-2]) * 1024)
        if s.endswith("Ti"):
            return int(float(s[:-2]) * 1024 * 1024)
        # bytes
        return int(float(s) / (1024 * 1024))
    except Exception:
        return None


def median_int(values: List[int]) -> Optional[int]:
    if not values:
        return None
    values_sorted = sorted(values)
    return values_sorted[len(values_sorted) // 2]


def round_up_int(value: int, step: int) -> int:
    if step <= 0:
        return value
    return int(((value + step - 1) // step) * step)


def labels_match_selector(labels: Dict, selector: Dict) -> bool:
    if not selector:
        return False
    if not labels:
        return False
    for k, v in selector.items():
        if labels.get(k) != v:
            return False
    return True


def extract_image_tag_flag(image: str) -> str:
    if not image:
        return "unknown"
    # image without ':' after last '/' is often untagged -> defaults to latest
    last_segment = image.split("/")[-1]
    if ":" not in last_segment:
        return "untagged"
    if image.endswith(":latest"):
        return "latest"
    return "pinned"
