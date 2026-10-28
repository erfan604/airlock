#!/usr/bin/env python3
"""AIR-029: tests of scripts/kani_parse.py against the two real Kani 0.68 logs in scripts/fixtures (make-kani-fixtures.sh
writes them). Every test runs the script through subprocess, with modified copies of the fixtures in a temp dir, and makes one
assertion on (exit code, output lines). The script is never imported. Run: python3 -m unittest -v scripts/test_kani_parse.py"""
import subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARSE = HERE / "kani_parse.py"
FIX = HERE / "fixtures"
OK_LOG, OK_TOML = FIX / "kani-probe-ok.log", FIX / "kani-probe-ok.toml"
ALL_LOG, ALL_TOML = FIX / "kani-probe.log", FIX / "kani-probe.toml"
OK_LINE = "KANI OK: 2 harnesses, 2 covers satisfied, 1 should_panic failed at the expected property"
TOOL_ERROR = "tool error (Status: ERROR, likely a missing solver), not a counterexample"


def edit(text, old, new, count=1):
    """text with `old` replaced; a fixture that no longer holds `old` is a broken test, not a pass"""
    assert old in text, f"fixture lacks {old!r}"
    return text.replace(old, new, count)


class KaniParse(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def run_parse(self, log, toml):
        """(exit code, output lines) of `kani_parse.py LOG TOML`; stderr is folded in so a crash shows its traceback"""
        p = subprocess.run([sys.executable, str(PARSE), str(log), str(toml)], capture_output=True, text=True)
        return p.returncode, (p.stdout + p.stderr).splitlines()

    def variant(self, log_text=None, toml_text=None, base="ok"):
        """write modified copies of a fixture pair (base "ok" or "all") and run the parser on them"""
        log, toml = (OK_LOG, OK_TOML) if base == "ok" else (ALL_LOG, ALL_TOML)
        (self.tmp / "k.log").write_text(log.read_text() if log_text is None else log_text, encoding="utf-8")
        (self.tmp / "k.toml").write_text(toml.read_text() if toml_text is None else toml_text, encoding="utf-8")
        return self.run_parse(self.tmp / "k.log", self.tmp / "k.toml")

    # the two fixture pairs
    def test_ok_log_prints_the_summary_and_exits_0(self):
        self.assertEqual(self.run_parse(OK_LOG, OK_TOML), (0, [OK_LINE]))

    def test_full_probe_log_exits_1_with_the_nine_sorted_lines(self):
        self.assertEqual(self.run_parse(ALL_LOG, ALL_TOML), (1, [
            "Complete says 6 verified harnesses, harnesses.toml has 8",
            'expected property "A naive thing exceeds the bound" not found in wrong_failure',
            'expected property "A tautology" not found in should_panic_but_passes',
            "no_checks: no checks at all (vacuous proof)",
            "plain_failure: expected VERIFICATION SUCCESSFUL, got FAILED",
            "should_panic_but_passes: should_panic harness did not fail as expected: "
            "FAILED (encountered no panics, but at least one was expected)",
            'unexpected failure in wrong_failure: "some other message"',
            'unreachable_cover: cover "dead branch" is UNREACHABLE',
            'unsat_cover: cover "never" is UNSATISFIABLE',
        ]))

    # the two sets must agree
    def test_toml_entry_the_log_lacks_is_harness_not_run(self):
        toml = OK_TOML.read_text() + '\n[[harness]]\nname = "ghost"\nexpect = "success"\nmin_covers = 0\n'
        self.assertEqual(self.variant(toml_text=toml), (1, [
            "Complete says 2 verified harnesses, harnesses.toml has 3", "harness not run: ghost"]))

    def test_log_harness_the_toml_lacks_is_named(self):
        toml = '[[harness]]\nname = "ok_with_cover"\nexpect = "success"\nmin_covers = 2\n'
        self.assertEqual(self.variant(toml_text=toml), (1, [
            "Complete says 2 verified harnesses, harnesses.toml has 1", "harness not in harnesses.toml: expected_failure"]))

    def test_complete_count_that_differs_from_the_toml_is_named(self):
        log = edit(OK_LOG.read_text(), "Complete - 2 successfully", "Complete - 1 successfully")
        self.assertEqual(self.variant(log_text=log), (1, ["Complete says 1 verified harnesses, harnesses.toml has 2"]))

    # covers
    def test_min_covers_above_the_satisfied_covers(self):
        toml = edit(OK_TOML.read_text(), "min_covers = 2", "min_covers = 3")
        self.assertEqual(self.variant(toml_text=toml), (1, ["ok_with_cover: 2 covers satisfied, min_covers is 3"]))

    # should_panic
    def test_changed_panic_message_gives_both_lines(self):
        toml = edit(OK_TOML.read_text(), "A naive thing exceeds the bound", "A different thing")
        self.assertEqual(self.variant(toml_text=toml), (1, [
            'expected property "A different thing" not found in expected_failure',
            'unexpected failure in expected_failure: "A naive thing exceeds the bound"']))

    def test_same_property_failing_at_two_sites_still_counts_as_the_expected_failure(self):
        # a should_panic assert inside an unrolled loop, or one message used twice, fails once per site
        dup = ('Check 2: proofs::expected_failure.assertion.2\n\t - Status: FAILURE\n'
               '\t - Description: ""A naive thing exceeds the bound""\n\t - Location: x\n\n')
        log = edit(OK_LOG.read_text(), "in function proofs::expected_failure\n\n", "in function proofs::expected_failure\n\n" + dup)
        self.assertEqual(self.variant(log_text=log), (0, [OK_LINE]))

    # log shape
    def test_log_from_another_kani_version(self):
        log = edit(OK_LOG.read_text(), "Kani Rust Verifier 0.68.0 (cargo plugin)", "Kani Rust Verifier 0.69.0 (cargo plugin)")
        self.assertEqual(self.variant(log_text=log), (1, ["kani version is not 0.68: Kani Rust Verifier 0.69.0 (cargo plugin)"]))

    def test_empty_log(self):
        self.assertEqual(self.variant(log_text=""), (1, [
            "harness not run: expected_failure", "harness not run: ok_with_cover",
            "kani version is not 0.68: ", "no Complete line in the log"]))

    # the log is read as Kani prints it
    def test_duplicate_harness_name_in_the_log(self):
        text = OK_LOG.read_text()
        block = text[text.index("Checking harness proofs::expected_failure..."):text.index("Checking harness proofs::ok_with_cover...")]
        log = edit(text, "Manual Harness Summary:", block.replace("proofs::", "other::") + "Manual Harness Summary:")
        self.assertEqual(self.variant(log_text=log), (1, ["duplicate harness name in log: expected_failure"]))

    def test_lines_after_the_summary_are_not_checks_of_the_last_harness(self):
        late = 'Check 99: late.cover.1\n\t - Status: UNSATISFIABLE\n\t - Description: "late"\n'
        log = edit(OK_LOG.read_text(), "Complete - 2 successfully", late + "Complete - 2 successfully")
        self.assertEqual(self.variant(log_text=log), (0, [OK_LINE]))

    def test_truncated_log_names_the_missing_verdict_and_complete_line(self):
        text = OK_LOG.read_text()
        log = text[:text.rindex("\t - Status: SUCCESS") + len("\t - Status: SUCCESS")]
        self.assertEqual(self.variant(log_text=log), (1, [
            "no Complete line in the log", "ok_with_cover: expected VERIFICATION SUCCESSFUL, got nothing"]))

    def test_success_harness_that_ends_with_the_should_panic_verdict(self):
        log = edit(OK_LOG.read_text(), "VERIFICATION:- SUCCESSFUL\n",
                   "VERIFICATION:- SUCCESSFUL (encountered one or more panics as expected)\n")
        self.assertEqual(self.variant(log_text=log), (1, [
            "ok_with_cover: expected VERIFICATION SUCCESSFUL, got SUCCESSFUL (encountered one or more panics as expected)"]))

    def test_harness_without_a_verification_line(self):
        log = edit(OK_LOG.read_text(), "VERIFICATION:- SUCCESSFUL\n", "")
        self.assertEqual(self.variant(log_text=log), (1, ["ok_with_cover: expected VERIFICATION SUCCESSFUL, got nothing"]))

    # only covers are covers
    def test_min_covers_defaults_to_zero(self):
        toml = edit(edit(OK_TOML.read_text(), "min_covers = 2\n", ""), "min_covers = 0\n", "")
        self.assertEqual(self.variant(toml_text=toml), (0, [OK_LINE]))

    def test_unreachable_library_checks_are_ignored_in_both_kinds_of_harness(self):
        lib = ("Check 90: core::fmt::Arguments::<'_>::from_str.assertion.1\n\t - Status: UNREACHABLE\n"
               '\t - Description: "assertion failed"\n\t - Location: x\n\n')
        log = edit(OK_LOG.read_text(), "in function proofs::expected_failure\n\n", "in function proofs::expected_failure\n\n" + lib)
        log = edit(log, "in function proofs::ok_with_cover\n\n", "in function proofs::ok_with_cover\n\n" + lib)
        self.assertEqual(self.variant(log_text=log), (0, [OK_LINE]))

    def test_only_an_id_ending_in_cover_k_is_a_cover(self):
        extra = ('Check 91: core::x.cover.1.assertion.2\n\t - Status: UNREACHABLE\n\t - Description: "not a cover"\n'
                 "\t - Location: x\n\n")
        log = edit(OK_LOG.read_text(), "in function proofs::ok_with_cover\n\n", "in function proofs::ok_with_cover\n\n" + extra)
        self.assertEqual(self.variant(log_text=log), (0, [OK_LINE]))

    def test_covers_are_not_failures_of_a_should_panic_harness(self):
        cover = ('Check 92: proofs::expected_failure.cover.1\n\t - Status: SATISFIED\n\t - Description: "reached"\n'
                 "\t - Location: x\n\n")
        log = edit(OK_LOG.read_text(), "in function proofs::expected_failure\n\n", "in function proofs::expected_failure\n\n" + cover)
        self.assertEqual(self.variant(log_text=log), (0, [OK_LINE]))

    # a harness that never ran (2026-10-23 note)
    def test_error_status_is_a_tool_error_not_a_counterexample(self):
        # plain_failure's one failing check becomes ERROR, the shape Kani prints when a solver binary is missing: the
        # verdict stays FAILED, and that harness is named once, as a tool error. Its other lines (the generic verdict line)
        # would send the reader after a counterexample, so they are not printed for it.
        log = edit(ALL_LOG.read_text(), '\t - Status: FAILURE\n\t - Description: ""plain fail""',
                   '\t - Status: ERROR\n\t - Description: ""plain fail""')
        self.assertEqual(self.variant(log_text=log, base="all"), (1, [
            "Complete says 6 verified harnesses, harnesses.toml has 8",
            'expected property "A naive thing exceeds the bound" not found in wrong_failure',
            'expected property "A tautology" not found in should_panic_but_passes',
            "no_checks: no checks at all (vacuous proof)",
            f"plain_failure: {TOOL_ERROR}",
            "should_panic_but_passes: should_panic harness did not fail as expected: "
            "FAILED (encountered no panics, but at least one was expected)",
            'unexpected failure in wrong_failure: "some other message"',
            'unreachable_cover: cover "dead branch" is UNREACHABLE',
            'unsat_cover: cover "never" is UNSATISFIABLE',
        ]))

    def test_one_error_check_among_passing_ones_still_names_the_harness(self):
        log = edit(OK_LOG.read_text(), "Check 5: proofs::ok_with_cover.assertion.1\n\t - Status: SUCCESS",
                   "Check 5: proofs::ok_with_cover.assertion.1\n\t - Status: ERROR")
        log = edit(log, "VERIFICATION:- SUCCESSFUL\n", "VERIFICATION:- FAILED\n")
        self.assertEqual(self.variant(log_text=log), (1, [f"ok_with_cover: {TOOL_ERROR}"]))

    def test_error_in_a_should_panic_harness_is_named_only_as_a_tool_error(self):
        log = edit(OK_LOG.read_text(), "Status: FAILURE", "Status: ERROR")
        log = edit(log, "VERIFICATION:- SUCCESSFUL (encountered one or more panics as expected)",
                   "VERIFICATION:- FAILED (encountered no panics, but at least one was expected)")
        self.assertEqual(self.variant(log_text=log), (1, [f"expected_failure: {TOOL_ERROR}"]))

    # the fixtures themselves
    def test_fixtures_hold_no_home_paths(self):
        # the privacy screen (AIR-252) must not see a home path in a committed log or toml
        bad = [f.name for f in sorted(FIX.glob("kani-probe*"))
               if f.is_file() and any(p in f.read_text() for p in ("/Users/", "/private/", "/home/", "/var/"))]
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
