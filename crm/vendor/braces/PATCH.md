# Local security patch for braces 3.0.3

Original source: https://github.com/micromatch/braces/tree/3.0.3
Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

No patched upstream release exists as of 2026-10-18. This directory retains
upstream 3.0.3 source and MIT license and adds a fixed 100-level depth
bound in the parser and the compile, expand and stringify AST walkers. Excessive
brace/parenthesis nesting and preconstructed deep ASTs throw SyntaxError before
exhausting the JavaScript stack. Ordinary brace syntax and range limits remain
unchanged. This addresses this specific nesting advisory, not arbitrary expensive
patterns or unbounded regular expression execution.

The private local package is named @demiresults/braces, version 3.0.3-demi.1;
upstream's development-only scripts and dependencies are omitted. The root npm
override makes every transitive braces consumer use this reviewed local source.
npm audit has no advisory record for this private fork: its result alone
is not proof of remediation. tests/braces-security.test.ts verifies both the attack
inputs and ordinary behavior through the installed dependency chain.

Remove the override and this directory when an upstream fixed release is available,
then keep the regression tests against that release.
