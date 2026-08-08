# Suggested patch: add `protocol_version` to A2A audit log

**File:** `/opt/hermes/plugins/platforms/a2a/security.py` (in this Hermes container)
**Why:** When Doxa's v1.0 port lands, our `a2a_audit.jsonl` will start recording v1.0 outbound calls. The audit `summary` field is already protocol-agnostic (it's the extracted user text, not the wire envelope), but the record itself has no version marker — post-mortem can't distinguish "this row was a v0.3 call" from "this row was a v1.0 call" without grepping the protocol.py code path. Per Doxa's addendum §4: "design any audit-log fix for v1.0 payloads from the start, don't patch v0.3 audit logging only to redo it in Phase 2."

**Constraints:**
- Hermes container is read-only at the kernel level for non-`/opt/data` paths; the agent cannot apply this patch from the sandbox. Apply it from a write-permitted shell (the host machine, or the local hermes install) or hand to Doxa's sub-agent on Belel.
- Function signature stays the same: `audit(direction, peer, task_id, summary)`. No caller needs to change.
- New field has a constant default of `"1.0"` because Phronesis's plugin only speaks v1.0 today. If/when v0.3 compat is added, extend the signature to accept a `protocol_version` kwarg and have v0.3 inbound paths pass `"0.3"`.

**Diff (apply to `security.py:357-373`):**

```diff
 def audit(direction: str, peer: str, task_id: str, summary: str) -> None:
-    """Append an audit record. Best-effort — never raises into the caller."""
+    """Append an audit record. Best-effort — never raises into the caller.
+
+    protocol_version is included so post-mortem on a v0.3 vs v1.0 envelope
+    is unambiguous once Doxa's v1.0 port lands and we have both in the log.
+    Currently always "1.0" — this plugin speaks v1.0 wire format only.
+    """
     try:
         rec = {
             "ts": time.time(),
             "direction": direction,  # "inbound" | "outbound" | "push"
             "peer": peer,
             "task_id": task_id,
+            "protocol_version": "1.0",
             "summary": (summary or "")[:500],
         }
         path = _audit_path()
         path.parent.mkdir(parents=True, exist_ok=True)
         with path.open("a", encoding="utf-8") as fh:
             fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
     except Exception:
         logger.debug("A2A: audit write failed", exc_info=True)
```

**Verification after apply:**

```bash
# 1. Confirm the file still imports cleanly
python3 -c "from plugins.platforms.a2a import security; print(security.audit.__doc__.splitlines()[0])"

# 2. Confirm a new row has the field
python3 -c "from plugins.platforms.a2a import security; security.audit('outbound', 'test', 'task-x', 'test summary')"
tail -1 /opt/data/a2a_audit.jsonl | python3 -c "import json,sys; r=json.load(sys.stdin); assert r['protocol_version']=='1.0'; print('OK:', r)"
```

**Backwards compatibility:** JSONL consumers that don't know the new field will ignore it (per JSON spec). No data migration needed; new rows gain the field, old rows remain valid as-is.

**Why I didn't apply it myself:** The Hermes container's `/opt/hermes/plugins/platforms/a2a/` is read-only at the kernel level (verified with `touch` permission denied). Phronesis can read but not write — that's the sandbox's HERMES_WRITE_SAFE_ROOT rule. Whoever applies this on a write-permitted shell should run the verification commands above.
