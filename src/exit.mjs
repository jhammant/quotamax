// Exit with `code` once everything already written to stdout has reached it.
// process.exit() straight after console.log drops output when stdout is a pipe (Node writes pipes
// asynchronously): `quotamax agent | jq` was cut off at 512 bytes whenever the exit code was non-zero,
// i.e. exactly when headroom was constrained or critical.
export function exitAfterFlush(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}
