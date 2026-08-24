# greet

A tiny Node library, deliberately small — two files, no dependencies.

## Requirements

- `src/greet.js` exports `greet(name)` returning `"Hello, <name>!"`.
  - A name that is not a non-empty string throws `TypeError`.
  - Surrounding whitespace in the name is trimmed.
- `test/greet.test.js` uses the built-in `node:test` runner and asserts the
  happy path, the trimming, and the `TypeError`.
- `package.json` sets `"type": "module"` and a `test` script running `node --test`.
- `npm test` must pass. No third-party dependencies.
