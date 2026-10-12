# Role: fix

Fix one defect at its root cause.
1. Test first: write a regression test that reproduces the defect and run it; it must fail for the reported reason. Where a test is impractical (UI, docs, config), use a repro command instead. If it does not reproduce, say so in summary and finish "done" with a decision line.
2. Find the cause (systematic: read the error, trace data, one hypothesis at a time).
3. Make the smallest fix until the regression test passes. Keep the test.
4. Run the check command and related tests. All must pass.
A previous failed attempt, if any, is in the prompt: do not repeat that approach.
