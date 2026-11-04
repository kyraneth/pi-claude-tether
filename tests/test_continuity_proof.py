"""Qualification rejects missing or divergent native accounting, not just PID counts."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "continuity_proof", Path(__file__).resolve().parents[1] / "scripts/continuity-proof.py"
)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class AccountingQualification(unittest.TestCase):
    def setUp(self):
        tokens = dict(input=14, output=7, cacheRead=31, cacheWrite=29)
        zero = {key: 0 for key in tokens}
        self.report = {
            "physicalTokens": tokens.copy(), "piMessageTokens": tokens.copy(),
            "scenarios": [{"name": "synthetic", "physicalTokens": tokens.copy(),
                           "piMessageTokens": tokens.copy(),
                           "piStatsBefore": {"tokens": zero}, "piStatsAfter": {"tokens": tokens.copy()}}],
        }

    def test_matching_observed_surfaces_pass(self):
        self.assertEqual(proof.accounting_failures(self.report), [])

    def test_zeroed_pi_input_is_not_qualified(self):
        seeded = copy.deepcopy(self.report)
        seeded["piMessageTokens"]["input"] = 0
        seeded["scenarios"][0]["piMessageTokens"]["input"] = 0
        self.assertTrue(proof.accounting_failures(seeded))

    def test_native_stat_disagreement_is_not_qualified(self):
        self.report["scenarios"][0]["piStatsAfter"]["tokens"]["output"] = 0
        self.assertTrue(proof.accounting_failures(self.report))

    def test_missing_stats_are_explicit_not_assumed_zero(self):
        del self.report["scenarios"][0]["piStatsAfter"]
        self.assertTrue(proof.accounting_failures(self.report))


class ImageReceiptQualification(unittest.TestCase):
    """Only retained synthetic records: this suite never launches Pi or CLI."""

    def qualify(self, changed_annotation=False):
        def image(width, height):
            header = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height)
            return {"type": "image", "mimeType": "image/png",
                    "data": base64.b64encode(header).decode()}
        expected = [{"type": "text", "text": "companion"}, image(2000, 1125),
                    {"type": "text", "text": "Pi coordinate annotation"}]
        observed = copy.deepcopy(expected)
        observed[1] = image(1600, 900)
        if changed_annotation:
            observed[-1]["text"] = "changed annotation"
        rpc = {"type": "tool_execution_end", "toolName": "continuity_tool", "toolCallId": "synthetic-id",
               "result": {"details": {"mode": "plain"}, "content": expected}}
        cli = {"type": "cli_stdout_metadata", "frameType": "user", "pid": 42, "seq": 1,
               "toolResults": [{"tool_use_id": "synthetic-id", "content": observed}]}
        measurements = {"scenarios": [{"name": "warm-followup", "physicalRequestPids": [42],
                                      "physicalTokens": {"cacheRead": 1}}]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "rpc-events.jsonl").write_text(json.dumps(rpc) + "\n")
            (output / "cli-metadata.jsonl").write_text(json.dumps(cli) + "\n")
            return proof.receipt_qualification(output, "image-derivative", measurements, {})

    def test_native_pi_annotation_is_compared_not_discarded(self):
        self.assertEqual(self.qualify(), [])
        self.assertIn("Physical image receipt lost block structure or exact companion text",
                      self.qualify(changed_annotation=True))


if __name__ == "__main__":
    unittest.main()
