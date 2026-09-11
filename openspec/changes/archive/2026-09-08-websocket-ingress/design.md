## One decoded-value boundary

The gateway owns complete JSON decoding at the wire boundary. Elysia 1.4's built-in parser runs before custom parse hooks and tests the first character, leaving whitespace-prefixed JSON as a raw string. Reparsing strings in a later hook cannot distinguish that raw text from an already decoded JSON string containing a command. A small public Bun adapter listen wrapper therefore envelopes each raw frame before dispatch through Elysia. The route parse hook unwraps and parses the original text exactly once. Malformed JSON and binary frames become an invalid value for the inbound schema; a missing internal envelope throws. The public dispatcher forwards nonstrings unchanged at runtime, which is the documented boundary for its narrow wire-type assertion. Open, close and other server hooks remain Elysia's.

## Validated dispatch

`WsClientFrame` in contracts validates the client control union and forwarding envelope, returning the original frame inside a control/forward discriminant. The discriminant preserves exact control types after validation because a regex-constrained extension tag still infers string in TypeScript. Extension fields survive on the original forwarded frame.

Recognized control tags are excluded from the forwarding branch. Resume maps refuse arrays and their sequence values are nonnegative safe integers; ArkType's string-index number map alone was measured accepting arrays and Infinity. The existing subscription-name refusal and backend-unavailable handling remain downstream of validation.
