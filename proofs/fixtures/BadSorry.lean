/- Fixture for scripts/test-lean-axioms.sh (AIR-030): not in any lake root. lake build exits 0 with a warning, lake check must reject it. -/
theorem bad_sorry : 1 + 1 = 3 := by sorry
