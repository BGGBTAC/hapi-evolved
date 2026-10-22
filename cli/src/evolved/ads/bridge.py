"""HAPI-eVolved adapter: fixed bridge to the unchanged vendored claude_ads_core.

Started only by `hapi evolved ads` as `python -I -S -B bridge.py <vendor-root> <command> ...`.
Isolated mode ignores PYTHON* variables, the user site and the working directory, so nothing from
the user's project is importable. The vendored core is imported from the explicit root, the policy
root is that same pinned root, and every path argument is a private copy prepared by the caller.
This file is HAPI code, not upstream code; it only calls public upstream functions.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


CLI_ALLOWLIST = frozenset({"validate", "render", "status"})


def _emit(payload: object) -> None:
    sys.stdout.write(json.dumps(payload, sort_keys=True, ensure_ascii=False))
    sys.stdout.write("\n")


def _fail(message: str, code: int = 2) -> int:
    sys.stderr.write(json.dumps({"status": "invalid", "error": message[:2000]}, sort_keys=True) + "\n")
    return code


def _load(path: str) -> object:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return _fail("usage: bridge.py <vendor-root> <command> ...")
    root = Path(argv[0])
    if not (root / "claude_ads_core" / "__init__.py").is_file() or not (root / "control-plane" / "manifests").is_dir():
        return _fail("vendor root does not contain claude_ads_core and control-plane/manifests")
    sys.path.insert(0, str(root))
    import claude_ads_core
    from claude_ads_core.adapters import AdapterError, GenericCSVExportAdapter, NativeCSVExportAdapter
    from claude_ads_core.adapters.mappings_v1 import PROFILES
    from claude_ads_core.cli import main as core_main
    from claude_ads_core.contracts import ContractError, validate_contract
    from claude_ads_core.control_registry import RegistryError, load_control_registry
    from claude_ads_core.policy_root import resolve_policy_root
    from claude_ads_core.report_policy import validate_report_bundle_policy

    loaded = Path(claude_ads_core.__file__).resolve().parent
    if loaded != (root / "claude_ads_core").resolve():
        return _fail("claude_ads_core was not loaded from the pinned vendor root")
    policy_root = resolve_policy_root(str(root))
    command, args = argv[1], argv[2:]
    try:
        if command == "version":
            _emit({"core": claude_ads_core.__version__, "python": list(sys.version_info[:3]), "policy_root": "pinned"})
            return 0
        if command == "cli":
            # Pass-through for a fixed allowlist of upstream subcommands; the caller builds argv from fixed options and
            # private copies only. Anything else (ingest-export via this path, cockpit, unknown commands) is refused.
            if not args or args[0] not in CLI_ALLOWLIST:
                return _fail("core command not allowed through the HAPI bridge")
            if args[0] in {"render", "status"} and "--policy-root" not in args:
                return _fail("core command requires the pinned policy root")
            for index, value in enumerate(args):
                if value == "--policy-root" and (index + 1 >= len(args) or Path(args[index + 1]).resolve() != root.resolve()):
                    return _fail("policy root must be the pinned vendor root")
            return int(core_main(args) or 0)
        if command == "capabilities":
            manifest = json.loads((policy_root / "control-plane" / "manifests" / "capability-manifest.json").read_text(encoding="utf-8"))
            registry = load_control_registry(policy_root)
            platforms = []
            for platform in manifest["platforms"]:
                profile = PROFILES.get(platform["id"])
                platforms.append({
                    "id": platform["id"],
                    "display_name": platform.get("display_name"),
                    "capabilities": [{"id": item["id"], "mode": item["mode"], "status": item["status"], "reason": item.get("reason") or item.get("disabled_reason")} for item in platform["capabilities"]],
                    "native_export": None if profile is None else {
                        "profile_id": profile.profile_id, "status": profile.status, "source_format": profile.source_format,
                        "expected_headers": list(profile.expected_headers), "required_context": list(profile.required_context),
                        "disabled_reason": profile.disabled_reason,
                    },
                    "scoring_profile": registry.profile_for(platform["id"]).status,
                    "controls": len(registry.entries_for(platform["id"])),
                })
            from claude_ads_core.adapters.csv_export import REQUIRED_COLUMNS
            _emit({"snapshot_at": manifest.get("snapshot_at"), "default_mutation_mode": manifest.get("default_mutation_mode"),
                   "generic_csv_columns": list(REQUIRED_COLUMNS), "platforms": platforms})
            return 0
        if command == "ingest":
            platform, fmt, context, source = args
            if fmt == "generic":
                if context != "{}":
                    return _fail("generic CSV exports take no context")
                snapshot = GenericCSVExportAdapter(platform).read_snapshot(source)
            elif fmt == "native":
                parsed = json.loads(context)
                if not isinstance(parsed, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in parsed.items()):
                    return _fail("native context must be an object of strings")
                snapshot = NativeCSVExportAdapter(platform, parsed).read_snapshot(source)
            else:
                return _fail("unknown export format")
            validate_contract("account-snapshot", snapshot)
            _emit(snapshot)
            return 0
        if command == "prepare":
            snapshot_path, findings_path, lifecycle_path, meta_path = args
            snapshot = _load(snapshot_path)
            validate_contract("account-snapshot", snapshot)
            lifecycle = _load(lifecycle_path)
            validate_contract("data-lifecycle", lifecycle)
            meta = _load(meta_path)
            findings = [] if findings_path == "-" else _load(findings_path)
            platform = snapshot["account"]["platform"]
            worker = None
            if isinstance(findings, dict):
                # One upstream audit-worker-result (the platform specialist's output) for this snapshot's platform.
                validate_contract("audit-worker-result", findings)
                if findings["platform"] != platform:
                    return _fail(f"audit-worker-result is for {findings['platform']}, snapshot is {platform}")
                worker, findings = findings, findings["findings"]
            if not isinstance(findings, list):
                return _fail("findings must be a JSON array or one audit-worker-result object")
            registry = load_control_registry(policy_root)
            registry.validate_findings(platform, findings)
            canonical = {entry.control_id: dict(entry.control_definition) for entry in registry.entries_for(platform)}
            used = sorted({str(finding["control_id"]) for finding in findings})
            bundle = {
                "schema_version": "1.0.0",
                "run_manifest": {
                    "schema_version": "1.0.0", "run_id": meta["run_id"], "started_at": meta["started_at"],
                    "scopes": meta["scopes"], "adapters": [{"platform": platform, "mode": "export"}], "sources": meta["sources"],
                    # Default to the operator-declared lifecycle classification; an explicit class must match it (upstream policy).
                    "privacy_class": meta["privacy_class"] or lifecycle["classification"], "data_lifecycle": lifecycle,
                    "worker_status": {platform: ("completed" if worker["status"] == "ok" else "failed") if worker else ("completed" if findings else "skipped")},
                    "completeness": meta["completeness"],
                },
                "account_snapshot": snapshot,
                "control_definitions": [canonical[control_id] for control_id in used],
                "findings": findings,
                "scoring": registry.score_platform(platform, findings).to_dict(),
            }
            if worker:
                bundle["contradictions"] = list(worker["contradictions"])
            validate_report_bundle_policy(bundle, registry)
            _emit(bundle)
            return 0
        return _fail(f"unknown bridge command: {command}")
    except (AdapterError, ContractError, RegistryError, KeyError, TypeError, ValueError) as exc:
        return _fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
