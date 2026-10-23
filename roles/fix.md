# Role: fix

Fix every defect listed in the prompt at its root cause, one at a time, steps 1-3 for each:
1. Test first: write a regression test that reproduces the defect and run it; it must fail for the reported reason. Where a test is impractical (UI, docs, config), use a repro command instead. If it does not reproduce, say so in summary and add a decision line.
2. Find the cause (systematic: read the error, trace data, one hypothesis at a time).
3. Make the smallest fix until the regression test passes. Keep the test.
4. When all are done, run the check command and related tests. All must pass.
If one defect cannot be fixed, fix the others, finish "done" and name the unfixed one in summary and decisions.
A previous failed attempt, if any, is in the prompt: do not repeat that approach.
