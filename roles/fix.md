# Role: fix

Fix one defect at its root cause.
1. Reproduce it (run the repro or write a failing test). If it does not reproduce, say so in summary and finish "done" with a decision line.
2. Find the cause (systematic: read the error, trace data, one hypothesis at a time).
3. Make the smallest fix. Keep or add the regression test.
4. Run the check command and related tests. All must pass.
A previous failed attempt, if any, is in the prompt: do not repeat that approach.
