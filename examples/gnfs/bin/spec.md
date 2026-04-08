
## API for backing state `2-12-2026`

Methods:

```javascript
var gnfs = require('gnfs')

// Backingstate receives messages with these handlers:
gnfs.connect({subscribe, unsubscribe, update, delete})

// Backingstate sends updates to gnfs with:
gnfs.send({update: {path, body, headers, patches}})
gnfs.send({delete: {path, body, headers, patches}})
```

Handler Definitions:
- subscribe(path, {subscribe: true, body: true})
- unsubscribe(path)
- update(path, {body, headers, patches})    `// ignore patches for now`
- delete(path)

These four messages could go from gnfs to the backingstate.

And the `update` and `delete` messages can go from backingstate to gnfs.

Examples:
- When gnfs sends a `subscribe`, backingstate response with a stream of `update`s for each change
- If `body` is set, then `patches` will be undefined, and vice versa
- If gnfs sends a `subscribe` with `body=false`, the backingstate will just send headers back
- Headers can look like `{size, mtime, ctime, ...}` or whatever!

### Next steps
1. Build an adapter with this API (for a "Live FS" or "Statebus")
  - Implement a backingstore for it that connects to filesystem
    - We'll need to probably implement a filehandler in that adapter
  - <mark>Get greg adding braid-http to it to test and find unknown unknowns</mark>