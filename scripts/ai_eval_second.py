#!/usr/bin/env python3
"""The second scoring of the hard cases, which a run records next to the first (scripts/ai_eval_rca.py): each row keeps
its first scoring as it is and gains `second`. Its rules are evals/ai/README.md "The second scoring"; each is taken from
the cases' truth.json and NOTES.md, and the kinds one case takes besides its truth's stand in that case's scoring.json,
not here. Pure functions; `score` scores saved reports again:

  python3 -I scripts/ai_eval_second.py score /tmp/eval/<stamp>-<model>.json    # the cases' scoring.json of evals/ai-hard
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python3 -I leaves the script's folder out

import ai_eval_rca as rca  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
# Goes up when what the rules say of an answer changes (test_ai_eval_second.py THE_RULES_SAY holds each number to it), so two
# runs' numbers are read together only under one number.
RULES = 3
RULES_FILE = "scoring.json"
# What an answer says, on an incident and on a control: a cause, no fault, or that the cause cannot be told. Besides:
# no_block (a chat answer without the block it was asked for), error, and unread (words that say none of the three).
OUTCOMES = ("cause", "no_fault", "cannot_tell")
# The outcome an investigation's server keeps (features.alertInvestigation.verdict: result.verdict.outcome) in these words.
KEPT_OUTCOMES = {"cause_found": "cause", "no_fault": "no_fault", "cannot_tell": "cannot_tell"}
_ENTRY_FIELDS = {"cause", "kinds", "needs", "notes"}
_NOTES_TAKE = re.compile(r"\b(takes?|taken|accepts?|accepted|counts?)\b", re.I)
_NOTES_REFUSE = re.compile(r"\b(not|no|never|nor|neither|cannot|alone|only|except|unless|without|wrong|miss(es)?)\b|n't\b", re.I)


# --- the case's own rules (scoring.json) ---

def load_rules(case_dir: Path) -> dict:
    """The case's scoring.json (read_rules) with its facts, the expect of its case.json."""
    case = Path(case_dir) / "case.json"
    facts = json.loads(case.read_text(encoding="utf-8")).get("expect") if case.exists() else None
    return {**read_rules(case_dir), **({"facts": facts} if facts else {})}


def read_rules(case_dir: Path) -> dict:
    """The case's scoring.json; {} without one."""
    path = Path(case_dir) / RULES_FILE
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _same_object(a: str, b: str) -> bool:
    """One resource whatever its namespace: --namespace-suffix moves the truth's, and a saved truth keeps its run's."""
    (ak, _, an), (bk, _, bn) = rca.split_resource(a), rca.split_resource(b)
    return (ak, an) == (bk, bn)


def check_rules(rules, truth: dict, notes: str) -> list[str]:
    """What is wrong with a case's scoring.json: accept_kinds, each entry the truth cause it is for, the kinds, the line
    of NOTES.md that says so — quoted as it stands there, with each kind in backquotes, saying that it takes them and
    holding no word that takes it back — and `needs`, what the answer must say of the cause for them (accepted_kinds)."""
    if not isinstance(rules, dict):
        return ["not an object"]
    problems = [f"unknown field {k!r}" for k in rules if k != "accept_kinds"]
    entries = rules.get("accept_kinds", [])
    for i, e in enumerate(entries if isinstance(entries, list) else [None]):
        at = f"accept_kinds {i}"
        if not isinstance(e, dict):
            problems.append(f"{at} is not an object")
            continue
        problems += [f"{at}: unknown field {k!r}" for k in e if k not in _ENTRY_FIELDS]
        if not any(_same_object(tc["resource"], str(e.get("cause") or "")) for tc in truth.get("causes") or []):
            problems.append(f"{at}: no cause of truth.json is {e.get('cause')!r}")
        kinds, quote = e.get("kinds"), e.get("notes")
        if not isinstance(kinds, list) or not kinds:
            problems.append(f"{at}: no kinds")
            kinds = []
        problems += [f"{at}: unknown kind {k!r}" for k in kinds if k not in rca.KINDS]
        if not isinstance(quote, str) or not quote.strip():
            problems.append(f"{at}: no notes")
        elif quote not in notes:
            problems.append(f"{at}: its notes are not in NOTES.md")
        else:
            problems += [f"{at}: its notes line does not name {k!r}" for k in kinds if f"`{k}`" not in quote]
            if not _NOTES_TAKE.search(quote) or _NOTES_REFUSE.search(quote):
                problems.append(f"{at}: its notes line does not say that the kinds are taken")
        try:
            re.compile(e.get("needs") or "")
        except re.error as err:
            problems.append(f"{at}: needs: {err}")
    return problems


def case_problems(case_dir: Path, hidden: bool) -> list[str]:
    """check_rules for a case folder; for a hidden case one line that says nothing of it."""
    d = Path(case_dir)
    try:
        truth = json.loads((d / "truth.json").read_text(encoding="utf-8")) if (d / "truth.json").exists() else {}
        notes = (d / "NOTES.md").read_text(encoding="utf-8") if (d / "NOTES.md").exists() else ""
        problems = check_rules(read_rules(d), truth, notes)
    except ValueError as e:
        problems = [str(e)]
    if problems and hidden:
        return [f"{RULES_FILE} has a problem (hidden: it is in its folder)"]
    return [f"{RULES_FILE}: {p}" for p in problems]


def says(prose: str, tc: dict, pattern: str) -> bool:
    """Whether a sentence that names the cause says that the thing of the pattern changed or is missing: both in one
    clause of it, one that does not take it back ("its dnsPolicy is unchanged", "dnsConfig lacks the namespace" of
    another workload)."""
    for sentence in rca._sentences(prose or ""):
        if not any(rca._is_truth_cause(tc, n) for n in rca._text_names(sentence)):
            continue
        at = 0
        for end in [*(m.start() for m in rca._CLAUSE_BREAK.finditer(sentence)), len(sentence)]:
            clause = sentence[at:end]
            if re.search(pattern, clause, re.I) and CHANGED_OR_MISSING.search(clause) and not _clears(clause) and not NEG.search(clause):
                return True
            at = end
    return False


def accepted_kinds(tc: dict, rules: dict | None, prose: str) -> set[str]:
    """The kinds a truth cause takes: its own, accept_kinds, and the case's scoring.json where the words say its needs — the
    one thing an answer's words decide of its block (05)."""
    kinds = {tc["kind"], *(tc.get("accept_kinds") or [])}
    for e in (rules or {}).get("accept_kinds") or []:
        if _same_object(e["cause"], tc["resource"]) and (not e.get("needs") or says(prose, tc, e["needs"])):
            kinds |= set(e["kinds"])
    return kinds


# --- what both checks read of a truth ---

def _hop(truth: dict, name: str) -> bool:
    """Whether the words' name is a hop of the path, its accept forms included (a block's is taken by its resource)."""
    return any(rca.resource_matches(h["resource"], name) or rca._search_any(h.get("accept"), name) for h in truth.get("path") or [])


def _decoy(truth: dict, name: str) -> bool:
    return (not any(rca._is_truth_cause(tc, name) for tc in truth.get("causes") or [])
            and any(rca.resource_matches(d["resource"], name) for d in truth.get("decoys") or []))


# --- the block ---

def kept_outcome(result) -> str | None:
    """The outcome the server keeps of an investigation, held to the run's calls; None for a stored result without one
    (the switch off, a row from before it, a report whose block could not be read)."""
    verdict = result.get("verdict") if isinstance(result, dict) else None
    said = verdict.get("outcome") if isinstance(verdict, dict) else None
    return KEPT_OUTCOMES.get(said) if isinstance(said, str) else None


def score_block(block: dict | None, status: str, truth: dict, calls: list, prose: str = "", rules: dict | None = None,
                kept: str | None = None) -> dict:
    """The block by its own list of causes (rca.score_block with two differences: accepted_kinds, and each hop of the
    truth's path that is no decoy may be named once without being an extra — by its resource, so a name that is only like
    it is one). outcome: `kept`, the outcome the server keeps of an investigation (kept_outcome), else by the block: a
    cause of a kind other than none is named, else no_fault is true, else cannot_tell. A control passes with the outcome
    no_fault (not beside a cause it names, which is a cause there), an incident only with the outcome cause; a cause the
    block names in a shape the scorer does not read is a cause there."""
    if block is None:
        return {"block": status, "pass": False, "outcome": "no_block", "miss": "no_block"}
    listed = [c for c in block.get("causes") or [] if not (isinstance(c, dict) and rca.normal_kind(c.get("kind")) == "none")]
    read_as = [c["resource"] for c in listed if isinstance(c, dict) and isinstance(c.get("resource"), str) and c["resource"].strip()]
    named = [str(c.get("resource") or c) if isinstance(c, dict) else str(c) for c in listed] if truth.get("control") else read_as
    own = "cause" if named else "no_fault" if block.get("no_fault") is True else "cannot_tell"
    outcome = "cause" if truth.get("control") and own == "cause" and kept == "no_fault" else kept or own
    out = {"block": status, "outcome": outcome, **({"block_outcome": own} if kept else {})}
    if truth.get("control"):
        ok = outcome == "no_fault"
        return {**out, "pass": ok, "named": named, "miss": None if ok else {"cause": "made_up", "cannot_tell": "cannot_tell"}[outcome]}
    wider = {**truth, "causes": [{**tc, "accept_kinds": sorted(accepted_kinds(tc, rules, prose))} for tc in truth.get("causes") or []]}
    s = rca.score_block(block, status, wider, calls)
    extras = _beyond_the_path(truth, s["extras"])
    found = bool(s["causes"]) and all(c["found"] for c in s["causes"])
    ok = outcome == "cause" and not s["no_fault"] and found and not s["decoys_taken"] and len(extras) <= rca.EXTRAS_ALLOWED
    return {**out, "pass": ok, "extras": extras, "decoys_taken": s["decoys_taken"], "miss": None if ok else _block_miss(s, outcome, extras)}


def _beyond_the_path(truth: dict, extras: list[str]) -> list[str]:
    """The extras that are no hop of the truth's path: each hop covers one of them, named by its own resource."""
    hops = list(dict.fromkeys(h["resource"] for h in truth.get("path") or []))
    left = []
    for r in extras:
        hop = next((h for h in hops if rca.resource_matches(h, r)), None)
        if hop is None or any(rca._is_truth_cause(tc, r) for tc in truth.get("causes") or []):
            left.append(r)
        else:
            hops.remove(hop)
    return left


def _block_miss(s: dict, outcome: str, extras: list) -> str:
    """Why an incident's block misses."""
    if outcome != "cause":
        return outcome
    seen = [c["resource_found"] for c in s["causes"]]
    if not all(seen):
        return "one_of_the_causes" if any(seen) else "cause_not_named"
    if not all(c["found"] for c in s["causes"]):
        return "kind"
    return "decoy" if s["decoys_taken"] else "no_fault" if s["no_fault"] else "guesses"


# --- the words ---

# Where a report says what is wrong; the other headings list what was checked, ruled out and what to do next.
HEADINGS = ("summary", "likely cause")
# More words that set a named object aside than rca.CLEAR_WORDS has.
MORE_CLEAR = re.compile(r"\b(separate|independent|pre-?existing|coincidental|different) (issue|problem|incident|matter|failure|fault)\b"
                        r"|\bnot related\b|\bno relation\b|\bred herring\b|\bset\b[^.;,]{0,30}\baside\b|\bwithout (touching|changing)\b", re.I)
# A match of these words after "not (a)" says the opposite ("this is not a false alarm").
_NOT_BEFORE = re.compile(r"(\bnot|n't|\bnever)( an?| the)?\s*$", re.I)
# A blame word counts only where nothing before it in its clause takes it back.
NEG = re.compile(r"\bno (clear |direct |strong |other |further )?(evidence|indication|sign|trace|proof)\b|\bnothing (here )?(suggests|indicates|shows|points)"
                 r"|\bunlikely\b|\bwhether\b|\b(cannot|could not|can't|couldn't) have\b|\b(benign|harmless|expected|unrelated) (cause|explanation|trigger)\b|\b(cannot|could not|can't|couldn't|unable to) (be )?(confirm|say|tell|conclude|establish|determine|prove|link|find|identify)"
                 r"|\b(does|do|did) not (prove|show|mean|establish|indicate|explain)|\bnone of\b|\bno (\w+ ){0,2}(cause|explanation|trigger|culprit)\b"
                 r"|\bnot (been )?(\w+ly )?(caused|explained|triggered|due|because|driven)\b|\bnot (an? |the )?\w+ (cause|explanation|trigger|culprit)\b", re.I)
# ... or where the clause goes on to take it back.
_TAKEN_BACK = re.compile(r"^\s*(nothing|no|none)\b|\bno (evidence|indication|sign|proof)\b[^.;]{0,30}\b(support|confirm|link|tie|connect|show)", re.I)
_NOT_AFTER = re.compile(r"\s*(still |yet |currently |therefore )?(not|unknown|unclear|undetermined|never|none|no|nothing)\b", re.I)  # "the cause is not known"
_PASSIVE = re.compile(r"\b(is|are|was|were|been|being|gets?|got)\s+(\w+ly\s+)?$", re.I)
_TRANSITIVE = r"(?!\s+(at|on|in|after|when|since|down|again|for|and|because|due|with|during|by|off|out|up)\b)(?=\s+\w)"
# "X caused Y": what is blamed stands before the verb. A verb that also reads as a passive ("was triggered") is taken only
# as the active.
CAUSE_VERB = re.compile(r"\bcaus(es|ed|ing)\b(?!\s+by)|\bled to\b|\bleads? to\b|\bleading to\b|\bresult(s|ed|ing)? in\b"
                        r"|\bmade\b[^.;]{0,60}\b(slow|fail|break)|\bmakes\b[^.;]{0,60}\b(slow|fail|break)"
                        r"|\bexplains\b|\bresponsible for\b|\bto blame\b|\b(took|brought)\b[^.;]{0,30}\bdown\b|\bstarv(es|ing)\b|때문|탓", re.I)
ACTIVE_VERB = re.compile(rf"\b(triggered|starved|overloaded|broke|breaks|breaking){_TRANSITIVE}", re.I)
CAUSE_IS = re.compile(r"\b(is|was|as|are) (the |a )?(most |likely |root |probable |actual |real )*(cause|culprit|trigger|explanation)\b", re.I)
CAUSE_NOUN = re.compile(r"\bculprit:|\b(cause|culprit|explanation|trigger|suspect)s?\b[^.;:]{0,60}?(\bis\b|\bwas\b|\bare\b|\bseems\b|:)|원인은", re.I)
CAUSED_BY = re.compile(rca.CAUSED_BY_WORDS.pattern + r"|\b(triggered|explained|driven) by\b|\bstem(s|med)? from\b|\battribut(ed|able) to\b|\btraced (back )?to\b", re.I)
# "because X": X is blamed where it is the subject; past another verb ("because it calls cart on ...") only where it is
# said to fail, and never as the calls' name ("a mismatch on the cart calls").
_FINITE = re.compile(r"\b(is|are|was|were|has|have|had|does|do|did|can|cannot|could|calls?|called|reads?|uses?|used|points?|sends?|asks?|depends?|relies|gets?|got"
                     r"|serves?|answers?|returns?|takes?|routes?|reach(es)?|waits?|talks?)\b|n't\b", re.I)
_FAILS_AFTER = re.compile(r"[`'\"*]*(,\s*(which|that))?\s[^,;.]{0,30}?(\bcrash|\bfail|\bbroke|\b(is|was|are|were|went) (down|slow|unavailable)\b|\btimes out\b|\brefus)", re.I)
_CALLS_OF = re.compile(r"[`'\"’s*]*\s+(calls?|requests?|paths?|urls?|lookups?)\b", re.I)
# A kind beside a name: "Deployment `pricing`", "the new pricing ReplicaSet", "the pricing revision".
_KIND_BESIDE = {**{k: k for k in rca._KNOWN_KINDS}, "revision": "replicaset", "rollout": "deployment"}
_BEFORE_NAME, _AFTER_NAME = re.compile(r"([A-Za-z]+)\s+[`'\"(*\[]*$"), re.compile(r"[`'\")*\]]*\s+([A-Za-z]+)")
# A sentence that goes on about the object named before it: "It was edited by hand".
_GOES_ON = re.compile(r"\W*(it|this|that|they|the (config|configmap|settings?|file|value|key|change|edit|update|patch))\b", re.I)
_NO_BEFORE = re.compile(r"\b(no|not|without|never)\s+(\w+\s+){0,2}$", re.I)
# Several causes offered: in a line ("Possible causes: a, b"), or as the list under one.
_OFFERED = r"(?:\b(?:causes|candidates|explanations|hypotheses|possibilities|suspects)\b|원인 ?후보)[^.;:\n]{0,40}:"
OFFERED, OFFERED_LIST = re.compile(_OFFERED, re.I), re.compile(_OFFERED + r"[*\s]*$", re.I)
OR_WORDS = re.compile(r"\bor\b|또는|혹은|아니면", re.I)
# A victim of its callee, in a chain told sentence by sentence ("product-catalog's queries wait on it, which caused ...").
VICTIM = re.compile(r"\bwait(s|ed|ing)?\b|\bfails?\b|\bfailed\b|\btime[sd]? out\b|\bcannot\b|\bcould not\b|\bunable\b|\bdepends? on\b|\bthrough it\b", re.I)
# The whole report saying there is no fault, unlike a denial of one thing ("no evidence of a DNS problem").
WHOLE_DENIAL = re.compile(
    r"\bno (current |ongoing |active |real |actual )?(fault|problem|issue|outage|failure|incident)s?\b(?!\s+(with|in|on|at|for|from|of|between|elsewhere)\b|\s+to\b(?!\s+(explain|report|fix)\b))"
    r"|\bnothing (is |was |seems |looks )?(wrong|broken|failing|abnormal)|\bno (action|fix) (is )?(needed|required)|\bfalse (positive|alarm)"
    r"|장애(가|는)? 없|고장(이|은)? 없|문제(가|는)? 없|이상(이|은)? 없", re.I)
# ... and in a control's report, where no symptom of another object is told of.
CONTROL_DENIAL = re.compile(r"\bno (degradation|slowdown|regression)s?\b|\bnothing to fix\b", re.I)
NOW = re.compile(r"\b(current(ly)?|ongoing|active|now|any ?more|any longer|remains?|left|at present|at the moment)\b|현재|지금", re.I)
CANNOT = re.compile(
    r"\bcause\b[^.;]{0,40}\b(is|remains|was|are)\b[^.;]{0,20}\b(not|un)\s?(known|identified|found|established|determined|clear|confirmed|proven)"
    r"|\b(cause|reason)\b[^.;]{0,30}\b(unknown|unclear|undetermined)|\b(unknown|undetermined) (root )?cause"
    r"|\b(could not|couldn't|cannot|can't|unable to|not able to|not possible to)\b[^.;]{0,25}\b(determine|identify|find|establish|pinpoint|explain)"
    r"|\bno (clear |specific |single |definite |definitive |root |identifiable |known |apparent |supported )*cause\b"
    r"|\binconclusive\b|\b(insufficient|not enough) (evidence|data|information)"
    r"|\b(report(ed|s)?|claim|complaint|alert|symptom|failure|slowdown|slowness)s?\b[^.;]{0,40}\b(not|cannot|isn't)\b[^.;]{0,15}\b(confirmed|verified|reproduced|supported|substantiated)"
    r"|\b(unconfirmed|unsubstantiated|unverified)\b|원인(을|은|이)? ?(알 수 없|확인하지 못|특정하지 못|찾지 못)", re.I)
# What says a ConfigMap or Secret changed or is wrong; its type's own words ("config", "settings") beside its name do not.
_CHANGED = rca.CHANGE_WORDS.pattern + r"|\b(edits?|patch(es|ed)|writes|written|rewrites|(went|goes) from)\b"
CHANGED = re.compile(_CHANGED, re.I)
CONFIG_CHANGED = re.compile(
    _CHANGED + r"|\b(adds|adding|introduc(es|ed|ing)|creat(es|ed|ing)|raises|lowers|sets|setting .{1,30} to|removes|new)\b"
    r"|\b(lacks?|lacking|missing|omits?|omitted|absent|without|has no|have no|no longer|(does|do|did) not (contain|include|have|list|define))\b"
    r"|\b(wrong|invalid|incorrect|bad|misconfigured|malformed)\b|\bcannot (be )?parsed?\b|없|빠져|빠진|빠졌|누락|잘못|틀린|새 ", re.I)
CHANGED_OR_MISSING = re.compile(
    _CHANGED + r"|\b(lacks?|lacking|missing|omits?|omitted|absent|without|no longer|(does|do|did) not (contain|include|have|list|define))\b|빠져|빠진|빠졌|누락", re.I)
# A change said to be of no account, whatever it was made to: a comment, a label, the same as before.
_INERT = re.compile(r"\b(comment|label|annotation|log ?level|name|description) only\b|\bonly (a |an |its |the |one )?(renam\w+|comment|label|annotation|log ?level|description)\b"
                    r"|\bidentical\b|\bcosmetic\b", re.I)
# rca.KIND_WORDS in other forms. They say a cause's kind and are never counted as a guess.
MORE_KIND_WORDS = {
    "dependency_down": re.compile(r"\brefus(es|ed|ing) (new |its |the )?connections?\b|\b(0|zero|no) replicas\b", re.I),
    "dependency_slow": re.compile(r"\btimes out\b|\btiming out\b|\bhangs?\b|\bhanging\b|\bstuck\b|\bblocked (by|on)\b|\b(holds?|held|waits? (on|for)) (a |the |its )?locks?\b", re.I),
    "node": re.compile(r"\b(full|whole|entire) (cpu|core)\b|\bcompet(e|es|ing) for\b|\bhog(s|ging)?\b", re.I),
}
# A NetworkPolicy's and a Node's kind are said by what they do; their type's name beside the object says nothing.
_TYPE_NAMES = {"network_policy": ("networkpolicy", re.compile(r"network ?polic|netpol|네트워크 ?정책", re.I)), "node": ("node", re.compile(r"nodes?|노드", re.I))}
_BLOCKS = re.compile(r"\bblock(s|ed|ing)?\b|\bden(y|ies|ied)\b|\bdrop(s|ped)?\b|\breject(s|ed)?\b|\bisolat|\brestrict|\b(admits?|allows?|permits?|lets) (in )?only\b"
                     r"|\bonly (admits?|allows?|permits?|lets|the)\b|\b(does|do|did) not (allow|admit|permit)\b|\bnot (allowed|admitted|permitted)\b|\bno (ingress |egress )?rule\b"
                     r"|막|차단|허용하지", re.I)
# A limit, a kill, a crash said not to be, or to be well.
_KINDS_OF_STATE = frozenset({"resource_limit", "oom", "quota", "crash", "node", "storage"})
_NOT_BEFORE_KIND = re.compile(r"(\bnot|\bnever|\bno longer|n't)\b(\s+\w+){0,4}\s*$", re.I)
_WELL_AFTER = re.compile(r"\w*(\s+\w+){0,3}\s+(is|are|was|were)\s+(\w+\s+)?(generous|enough|fine|normal|zero|healthy|ok|okay|correct|unused|untouched)\b", re.I)
_DOWN_OF = re.compile(r"([\w./-]+) (is|was|were|are|went|goes) $", re.I)  # an object's own name is blank there
_DOWN_ITSELF = frozenset({"it", "which", "that", "this", "they", "service", "deployment", "pod", "pods", "store", "database"})
_ENV_KEY = re.compile(r"\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b")
# What a sentence that goes on must hold to say a kind: that something failed, changed or is missing.
_HAPPENED = re.compile(CHANGED_OR_MISSING.pattern + r"|\bfail|\bcrash|\berror|\bbroke|\bbegan\b|\bstarted\b|\bsince\b|\bcannot\b|\brefus|\bexit|\bkill|\bstop|throttl", re.I)


def read(report: str) -> tuple[list[tuple[str, str]], str]:
    """([(heading, text)], what was read): the Summary and Likely cause sections, else the whole report. A block is left out."""
    text = rca.strip_blocks(report or "")
    heads = list(rca._HEADING.finditer(text))
    parts = []
    for i, m in enumerate(heads):
        name = m.group(1).strip().rstrip(":").lower()
        body = text[m.end():heads[i + 1].start() if i + 1 < len(heads) else len(text)].strip()
        if name in HEADINGS and body:
            parts.append((name, body))
    if not parts:
        return [("whole", text.strip())], "whole"
    return parts, "+".join(n.replace(" ", "_") for n, _ in parts)


def _kind_spans(text: str) -> list[tuple[int, int, str]]:
    """rca's kind words of a text, but those it says are not so, are well, or are another thing's ("the bank is down")."""
    out = []
    for a, b, kind in rca._kind_spans(text):
        start = max((m.end() for m in rca._CLAUSE_BREAK.finditer(text, 0, a)), default=0)
        if kind in _KINDS_OF_STATE and (_NOT_BEFORE_KIND.search(text[start:a]) or _WELL_AFTER.match(text, b)):
            continue
        of = _DOWN_OF.search(text[start:a]) if text[a:b].lower() == "down" else None
        if of and of.group(1).lower() not in _DOWN_ITSELF:
            continue
        out.append((a, b, kind))
    return out


def _more_kinds(text: str) -> list[tuple[int, str]]:
    """(where, kind) of MORE_KIND_WORDS in a text."""
    return [(m.start(), kind) for kind, pattern in MORE_KIND_WORDS.items() for m in pattern.finditer(text)]


def _clears(clause: str) -> list:
    """The words of a clause that set an object aside or say there is no fault, without those after a "not"."""
    return [m for w in (rca.NO_FAULT_WORDS, rca.CLEAR_WORDS, MORE_CLEAR) for m in w.finditer(clause)
            if not _NOT_BEFORE.search(clause[:m.start()])]


def _lines(text: str):
    """(sentence, whether it is an item of a list of offered causes)."""
    offered = False
    for line in text.splitlines():
        if not line.strip():
            continue
        item = bool(rca._BULLET.match(line))
        if not item:
            offered = bool(OFFERED_LIST.search(line.strip()))
        for sentence in rca._sentences(line):
            yield sentence, offered and item


class _Words:
    """What one section's words say of a truth: its causes named (and not ruled out) and with which kinds, who is blamed
    for what, whether it says there is no fault or that the cause cannot be told."""

    def __init__(self, text: str, truth: dict, goes_on: set | None = None):
        self.truth, self.causes = truth, truth.get("causes") or []
        self.goes_on = goes_on or set()  # the causes the text was last speaking of, with no other object named since
        self.named = {i: set() for i in range(len(self.causes))}
        self.said = {i: set() for i in range(len(self.causes))}
        self.went_on = {i: set() for i in range(len(self.causes))}  # kinds said in a sentence that goes on: right, never a guess
        self.decoys, self.suspects = set(), set()
        self.unnamed = self.whole_denial = self.cannot = False
        self.blamed_cause = False
        for sentence, offered in _lines(text):
            self._sentence(sentence, offered)
        self.kinds = {k for _, _, k in _kind_spans(text)} - {"config_change"} | ({"config_change"} if CONFIG_CHANGED.search(text) else set())

    def _cause(self, name):
        return any(rca._is_truth_cause(tc, name) for tc in self.causes)

    def _also(self, name):
        return any(rca.resource_matches(a, name) for a in self.truth.get("also_ok") or [])

    def _in_truth(self, name):
        return self._cause(name) or self._also(name) or _hop(self.truth, name)

    def _other(self, name):
        return not self._in_truth(name) and (_decoy(self.truth, name) or ("/" in name and rca.split_resource(name)[0] in rca._KNOWN_KINDS))

    def _own_name(self, name):
        return ("/" in name or self._cause(name) or _decoy(self.truth, name) or self._also(name)
                or any(rca.resource_matches(h["resource"], name) for h in self.truth.get("path") or []))

    def _one_segment(self):
        """Two causes one name can give: the two ends of one call (a shared accept_resources form, one kind)."""
        shared = [set(tc.get("accept_resources") or []) for tc in self.causes]
        return len(self.causes) > 1 and bool(set.intersection(*shared)) and len({tc["kind"] for tc in self.causes}) == 1

    def _with_kind(self, sentence: str, name: str, start: int, end: int) -> str:
        """The name with the kind written beside it, where that makes it a cause (a bare name of the truth stays bare)."""
        if "/" in name or self._cause(name):
            return name
        beside = [m.group(1) for m in (_BEFORE_NAME.search(sentence[:start]), _AFTER_NAME.match(sentence, end)) if m]
        forms = [f"{_KIND_BESIDE[k.lower()]}/{name}" for k in beside if k.lower() in _KIND_BESIDE]
        return next((f for f in forms if self._cause(f)), name)

    def _objects(self, sentence: str) -> tuple[set, list]:
        """(the names as written, their (start, end, name)) of the objects of a sentence. An object's own name: a word
        only a hop's accept takes ("endpoints") names nothing that could be blamed or cleared."""
        written, spans = set(), []
        for raw in rca._text_names(sentence):
            for m in rca._name_at(raw).finditer(sentence):
                n = self._with_kind(sentence, raw, m.start(), m.end())
                if (self._in_truth(n) or self._other(n)) and self._own_name(n):
                    written.add(raw)
                    spans.append((m.start(), m.end(), n))
        return written, sorted(spans)

    def _sentence(self, sentence: str, offered: bool) -> None:
        objects, spans = self._objects(sentence)
        if not spans:
            self._goes_on(sentence)
        self.cannot = self.cannot or bool(CANNOT.search(sentence))
        cleared, live_all, blames, places, live_by_clause, unnamed = sentence, [], [], {}, [], False
        for cs, ce in rca._clauses(sentence, spans):
            clause = sentence[cs:ce]
            here = [s for s in spans if cs <= s[0] and s[1] <= ce]
            clears = _clears(clause)
            self._no_fault(clause, cs, here)
            out = {rca._nearest(cs + m.start(), cs + m.end(), here) for m in clears} - {None}
            out |= {n for a, b, n in here for m in clears if cs + m.start() <= a and b <= cs + m.end()}  # "set X aside"
            for m in clears:
                cleared = cleared[:cs + m.start()] + " " * (m.end() - m.start()) + cleared[cs + m.end():]
            live = [s for s in here if s[2] not in out]
            live_all += live
            in_clears = [(cs + m.start(), cs + m.end()) for m in clears]
            for mode, at, upto in self._blame_words(clause, cs):
                if any(a <= at < b for a, b in in_clears):
                    continue
                got = self._blamed(sentence, mode, at, upto, live, live_all)
                blames += [(mode, at, s) for s in got]
                unnamed = unnamed or (not got and not clears and (mode == "noun" or bool(_kind_spans(clause))))
            causes_here = set()
            for a, b, n in live:
                for i, tc in enumerate(self.causes):
                    if rca._is_truth_cause(tc, n):
                        self.named[i].add(n)
                        causes_here.add(i)
                        places.setdefault(i, []).append((a, b))
            if live or not here:
                live_by_clause.append((cs, ce, causes_here))
        if offered or OFFERED.search(sentence):  # every object of an offered list is offered as a cause
            start = 0 if offered else OFFERED.search(sentence).end()
            first = [s for s in live_all if s[0] >= start]
            blames += [("offered", s[0], s) for s in (first[:1] if offered else first)]
        if self.truth.get("control") and unnamed and not blames and not NEG.search(sentence):
            self.unnamed = True
        for mode, at, span in blames:
            self._blame(sentence, mode, at, span, live_all, places, blames)
        if places:
            self._kinds_said(cleared, objects, live_by_clause, places)
        if live_all:
            self.goes_on = set(places) if all(self._cause(n) or self._also(n) for _, _, n in live_all) else set()

    def _goes_on(self, sentence: str) -> None:
        """A sentence that names no object goes on with the cause named before it, as a part of a sentence does."""
        if _clears(sentence) or _INERT.search(sentence) or not _HAPPENED.search(sentence):
            return
        for i in self.goes_on:
            if self._config(i):
                if _GOES_ON.match(sentence) and any(not _NO_BEFORE.search(sentence[:m.start()]) for m in CHANGED.finditer(sentence)):
                    self.went_on[i].add("config_change")
                continue
            for a, kind in [*((a, k) for a, _, k in _kind_spans(sentence)), *_more_kinds(sentence)]:
                if not _NO_BEFORE.search(sentence[:a]) and (kind != "config_change" or CONFIG_CHANGED.search(sentence)) and not self._is_type(i, kind):
                    self.went_on[i].add(kind)

    def _no_fault(self, clause: str, cs: int, here: list) -> None:
        part_at = 0
        for part in clause.split(":"):
            inside = [s for s in here if cs + part_at <= s[0] and s[1] <= cs + part_at + len(part)]
            part_at += len(part) + 1
            if inside or rca.OTHERS_WORDS.search(part):
                continue
            whole = [m for w in (WHOLE_DENIAL, *([CONTROL_DENIAL] if self.truth.get("control") else [])) for m in w.finditer(part)
                     if not _NOT_BEFORE.search(part[:m.start()])]
            over = self.truth.get("fault_end") and NOW.search(part)  # an outage that is over: nothing wrong now is the truth
            self.whole_denial = self.whole_denial or (bool(whole) and not over)

    def _blame_words(self, clause: str, cs: int):
        for mode, words in (("verb", CAUSE_VERB), ("active", ACTIVE_VERB), ("is", CAUSE_IS), ("noun", CAUSE_NOUN), ("by", CAUSED_BY)):
            for m in words.finditer(clause):
                if NEG.search(clause[:m.end()]) or _TAKEN_BACK.search(clause[m.end():]):
                    continue
                if mode == "active" and _PASSIVE.search(clause[:m.start()]) or mode == "noun" and _NOT_AFTER.match(clause, m.end()):
                    continue
                yield "verb" if mode == "active" else mode, cs + m.start(), cs + m.end()

    def _blamed(self, sentence: str, mode: str, at: int, upto: int, live: list, live_all: list) -> list:
        """The objects a blame word blames: before it in the sentence for a verb and "X is the cause", after it in the
        clause for "the cause is" and "caused by", with the ones joined to it by "or"."""
        before = [s for s in live_all if s[1] <= at]
        after = sorted(s for s in live if s[0] >= upto)
        if mode in ("verb", "is"):
            got = [max(before, key=lambda s: (s[1], s[0] - s[1]))] if before else []
        elif mode == "noun":
            got = after[:1]
        else:
            got = [s for k, s in enumerate(after) if not _CALLS_OF.match(sentence, s[1])
                   and (_FAILS_AFTER.match(sentence, s[1]) if _FINITE.search(sentence, upto, s[0]) else k == 0)]
        pool = live_all if mode in ("verb", "is") else sorted(live)
        for s in list(got):
            for o in pool:
                first, then = sorted((s, o))
                if o != s and first[1] <= then[0] and then[0] - first[1] <= 80 and OR_WORDS.search(sentence[first[1]:then[0]]):
                    got.append(o)
        return got

    def _blame(self, sentence: str, mode: str, at: int, span: tuple, live_all: list, places: dict, blames: list) -> None:
        n = span[2]
        if self._cause(n):
            self.blamed_cause = True
            return
        if _decoy(self.truth, n):
            if mode in ("verb", "by") and _hop(self.truth, n) and self._chain(sentence, mode, at, span, live_all, places, blames):
                return
            self.decoys.add(n)
        elif self._other(n):
            self.suspects.add(n)

    def _chain(self, sentence: str, mode: str, at: int, span: tuple, live_all: list, places: dict, blames: list) -> bool:
        """Whether a decoy that is a hop of the truth's path stands in a chain from the cause: "cause ... made hop fail,
        leading to ...", "symptom because of hop, caused by cause", "symptom because hop cannot reach a nearer hop", or hop
        as a victim once the section named the cause."""
        a, b, _ = span
        nearer = [s for s in live_all if self._in_truth(s[2]) and not _decoy(self.truth, s[2])]
        known = any(self.named[i] and (self.said[i] | self.went_on[i]) & self._own_kinds(i) for i in self.named)
        if mode == "verb":
            if any(e <= a for ends in places.values() for _, e in ends) or (known and any(s[1] <= a for s in nearer)):
                return True
            return known and bool(VICTIM.search(sentence[b:at]))
        victim = VICTIM.search(sentence, b, b + 40)
        if victim and any(s[0] >= victim.end() for s in nearer):
            return True
        later = [s for m, t, s in blames if m == "by" and t > at and self._in_truth(s[2]) and not _decoy(self.truth, s[2])]
        return bool(later) and any(x >= b for ends in places.values() for x, _ in ends)

    def _own_kinds(self, i: int) -> set:
        return {self.causes[i]["kind"], *(self.causes[i].get("accept_kinds") or [])}

    def _kinds_said(self, cleared: str, objects: set, live_by_clause: list, places: dict) -> None:
        words = rca._blank(cleared, objects)
        whole = set(places) if self._one_segment() and len(places) == len(self.causes) else None
        inert = bool(_INERT.search(words))
        for cs, ce, here in live_by_clause:
            clause = words[cs:ce]
            changed = not inert and CONFIG_CHANGED.search(clause)
            for a, b, kind in _kind_spans(clause):
                for i in whole or rca._whom(cs + a, here, places):
                    if kind == "config_change" and (self._config(i) or not changed):
                        continue  # the word "config" alone says no change
                    if self._is_type(i, kind, clause[a:b]):
                        continue  # "NetworkPolicy x", "the node x": what it is, not what it did
                    self.said[i].add(kind)
            for a, kind in _more_kinds(clause):
                for i in whole or rca._whom(cs + a, here, places):
                    self.went_on[i].add(kind)
            for m in _BLOCKS.finditer(clause):
                for i in rca._whom(cs + m.start(), here, places):
                    if self._is_kind(i, "networkpolicy"):
                        self.went_on[i].add("network_policy")
            for m in CONFIG_CHANGED.finditer(clause) if not inert else ():
                for i in rca._whom(cs + m.start(), here, places):
                    if self._config(i):
                        self.said[i].add("config_change")
                    elif _ENV_KEY.search(clause):  # a key that changed or is missing is a setting
                        self.went_on[i].add("config_change")

    def _is_kind(self, i: int, kind: str) -> bool:
        return rca.split_resource(self.causes[i]["resource"])[0] == kind

    def _is_type(self, i: int, kind: str, said: str | None = None) -> bool:
        """Whether a kind word is the name of the cause's own type (any word of that kind, without `said`)."""
        return kind in _TYPE_NAMES and self._is_kind(i, _TYPE_NAMES[kind][0]) and (said is None or bool(_TYPE_NAMES[kind][1].fullmatch(said)))

    def _config(self, i: int) -> bool:
        return rca.split_resource(self.causes[i]["resource"])[0] in rca.CONFIG_KINDS


def _chain_kinds(truth: dict) -> set[str]:
    """The kind words the truth itself uses of its symptom and its path: the chain, not a guess."""
    text = " ".join([truth.get("symptom") or "", *(h.get("note") or "" for h in truth.get("path") or [])])
    return {k for _, _, k in _kind_spans(text)}


def score_text(report: str, truth: dict, rules: dict | None = None) -> dict:
    """A report's words: its Summary and Likely cause. An incident passes when each cause is named where it is not ruled
    out, with a word of a kind it takes (accepted_kinds; a ConfigMap's change, not its type's name), no decoy is blamed,
    nothing in it says there is no fault, and at most EXTRAS_ALLOWED other objects are blamed or kinds guessed. A cause
    that stands only in the Summary needs the Likely cause to speak of its kind and not leave the cause open. A control
    passes with the outcome no_fault."""
    parts, section = read(report)
    got: list[tuple[str, _Words]] = []
    for name, text in parts:
        got.append((name, _Words(text, truth, got[-1][1].goes_on if got else None)))
    words = [w for _, w in got]
    prose = "\n\n".join(text for _, text in parts)
    decoys, suspects = set().union(*(w.decoys for w in words)), set().union(*(w.suspects for w in words))
    whole, cannot = any(w.whole_denial for w in words), any(w.cannot for w in words)
    unnamed = any(w.unnamed for w in words)
    out = {"section": section, "decoys_named": sorted(decoys), "suspects": sorted(suspects)}
    if truth.get("control"):
        outcome = "cause" if decoys or suspects or unnamed else "no_fault" if whole else "cannot_tell" if cannot else "unread"
        return {**out, "pass": outcome == "no_fault", "outcome": outcome,
                "miss": None if outcome == "no_fault" else "made_up" if outcome == "cause" else outcome}
    causes = truth.get("causes") or []
    likely = next((w for name, w in got if name == "likely cause"), None)
    chain, extras, seen, kind_said = _chain_kinds(truth), len(suspects), [], []
    for i, tc in enumerate(causes):
        own = accepted_kinds(tc, rules, prose)
        said = set().union(*(w.said[i] for w in words))
        named = any(w.named[i] for w in words)
        if named and likely is not None and not likely.named[i]:  # it stands only in the Summary
            named = bool(likely.kinds & own) and not likely.cannot
        extras += max(0, len(said - own - chain) - 1)
        seen.append(named)
        kind_said.append(bool((said | set().union(*(w.went_on[i] for w in words))) & own))
    facts = all(any(re.search(p, prose, re.I) for p in group) for group in (rules or {}).get("facts") or [])
    found = bool(causes) and all(seen) and all(kind_said)
    ok = found and facts and not whole and not decoys and extras <= rca.EXTRAS_ALLOWED
    if whole and not ok:
        outcome = "no_fault"
    elif found or decoys or suspects or any(w.blamed_cause for w in words):
        outcome = "cause"
    else:
        outcome = "cannot_tell" if cannot else "cause" if any(seen) else "unread"
    if ok:
        miss = None
    elif whole:
        miss = "no_fault"
    elif not all(seen):
        miss = "one_of_the_causes" if any(seen) else "cause_not_named"
    else:
        miss = "kind" if not all(kind_said) else "decoy" if decoys else "facts" if not facts else "guesses"
    return {**out, "pass": ok, "outcome": outcome, "extras": extras, "miss": miss}


# --- one answer, as a row records it ---

def _row(truth: dict, by: str, scored: dict, error) -> dict:
    """pass is a block's only: None for a report without a block, read in its words, in every arm and after an error (README
    "An answer without a block")."""
    return {"rules": RULES, "by": by, "control": bool(truth.get("control")), "pass": (scored["pass"] and not error) if by == "block" else None,
            "outcome": "error" if error else scored["outcome"], "miss": "error" if error else scored["miss"]}


def score_answer(answer: str, truth: dict, calls: list, error, rules: dict | None = None) -> dict:
    """A chat answer, by the block it was asked for."""
    scored = score_block(*rca.extract_block(answer), truth, calls, rca.strip_blocks(answer or ""), rules)
    return {**_row(truth, "block", scored, error), "block": scored}


def score_report(report: str, block: dict | None, status: str, truth: dict, calls: list, error, rules: dict | None = None,
                 kept: str | None = None) -> dict:
    """An investigation's report: by its block (`kept` as in score_block); without one it has no pass. The words are scored
    and reported either way (text)."""
    text = score_text(report, truth, rules)
    if block is None:
        return {**_row(truth, "text", text, error), "text": text}
    prose = "\n\n".join(t for _, t in read(report)[0])
    scored = score_block(block, status, truth, calls, prose, rules, kept)
    return {**_row(truth, "block", scored, error), "block": scored, "text": text}


# --- the tables ---

def counts(rows: list[dict]) -> dict:
    """What the tables count of rows with a second scoring."""
    out = {"runs": len(rows), "first": sum(bool(r.get("pass")) for r in rows), "blocks": sum(r["second"]["by"] == "block" for r in rows),
           "second": sum(r["second"]["pass"] is True for r in rows),
           "text": sum(r["second"]["text"]["pass"] for r in rows if "text" in r["second"]), "texts": sum("text" in r["second"] for r in rows)}
    for outcome in OUTCOMES:
        out[outcome] = sum(r["second"]["outcome"] == outcome for r in rows)
    out["other"] = out["runs"] - sum(out[o] for o in OUTCOMES)
    return out


def tables(rows: list[dict]) -> list[str]:
    """The markdown of the second scoring: the incidents and the controls in tables of their own. rows: shown ones only.
    The outcomes of a run without a block are its words'."""
    rows = [r for r in rows if "second" in r]
    out: list[str] = []
    incidents, controls = [r for r in rows if not r["second"]["control"]], [r for r in rows if r["second"]["control"]]
    ids = lambda group: sorted({r["id"] for r in group})  # noqa: E731
    if incidents:
        out += ["", "사고(새 채점)", "", "| 사례 | 회 | 첫 채점 | 블록 있는 회 | 새 채점(블록) | 글(참고만) | 원인을 댐 | 이상 없다고 함 | 모른다고 함 | 그 밖 |", "|---|---|---|---|---|---|---|---|---|---|"]
        for cid in [*ids(incidents), None]:
            c = counts([r for r in incidents if cid in (None, r["id"])])
            out.append(f"| {cid or '합'} | {c['runs']} | {c['first']} | {c['blocks']} | {c['second'] if c['blocks'] else '-'} | {c['text'] if c['texts'] else '-'} | "
                       f"{c['cause']} | {c['no_fault']} | {c['cannot_tell']} | {c['other']} |")
    if controls:
        out += ["", "대조군(새 채점)", "", "| 사례 | 회 | 첫 채점 | 블록 있는 회 | 지어낸 원인 | 이상 없음 | 모름 | 그 밖 |", "|---|---|---|---|---|---|---|---|"]
        for cid in [*ids(controls), None]:
            c = counts([r for r in controls if cid in (None, r["id"])])
            out.append(f"| {cid or '합'} | {c['runs']} | {c['first']} | {c['blocks']} | {c['cause']} | {c['no_fault']} | {c['cannot_tell']} | {c['other']} |")
    return out


# --- saved reports ---

def rescore(path: Path, cases: Path) -> tuple[list[dict], int]:
    """(the shown rows of a saved report with `second` made again, how many rows the first scoring now scores another way
    than the report holds). The truth is the run's own filled copy beside the report; a hidden row is not read."""
    stamp = path.name.split("-")[0]
    out, differs = [], 0
    for r in json.loads(path.read_text(encoding="utf-8")):
        truth_path = path.parent / f"{stamp}-truth" / f"{r['id']}.json"
        if r.get("hidden") or "setup_error" in r or not truth_path.exists():
            continue
        truth = json.loads(truth_path.read_text(encoding="utf-8"))
        rules = truth.get("scoring") or load_rules(Path(cases) / r["id"])
        answer, calls, error = r.get("answer") or "", r.get("calls") or [], r.get("error")
        if r.get("form") == "alert":
            text = rca.score_text(answer, truth)
            differs += text != r["text"] or (text["pass"] and not error) != r["pass"]
            block, status = rca.block_of_result(r.get("stored_result"))
            if r.get("stored_result") is None:
                block, status = rca.extract_block(answer)
            row = score_report(answer, block, status, truth, calls, error, rules, kept_outcome(r.get("stored_result")))
            if block is None and (r.get("rca") or {}).get("block") in ("ok", "loose"):
                row["block_not_saved"] = True
        elif "rca" in r:
            first = rca.score_rca(answer, truth, calls)
            differs += first != r["rca"] or (first["pass"] and not error) != r["pass"]
            row = score_answer(answer, truth, calls, error, rules)
        else:
            continue
        out.append({**r, "second": row})
    return out, differs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Score saved reports again: the first scoring against what the report holds, and the second.")
    sub = ap.add_subparsers(dest="what", required=True)
    score = sub.add_parser("score")
    score.add_argument("reports", nargs="+", type=Path)
    score.add_argument("--cases", type=Path, default=ROOT / "evals" / "ai-hard", help="the case folders whose scoring.json is read")
    args = ap.parse_args(argv)
    rows, differs = [], 0
    for path in args.reports:
        got, d = rescore(path, args.cases)
        rows += got
        differs += d
    print("\n".join(tables(rows)).strip())
    print(f"\n첫 채점이 저장된 값과 다른 줄: {differs}/{len(rows)}")
    return 1 if differs else 0


if __name__ == "__main__":
    sys.exit(main())
