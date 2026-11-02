/- Fixture for scripts/test-lean-axioms.sh (AIR-030): not in any lake root. native_decide adds a compiler axiom that lake check rejects. -/
theorem uses_native : 2 + 2 = 4 := by native_decide
