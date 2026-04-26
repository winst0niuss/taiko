# Fix Plan: Navigation hang on Windows when using `intercept()`

## What the CI logs showed

Test `intercept.spec:38` — `Navigate to "https://localhost/employees/2/address"` — consistently hangs for 60 seconds on Windows. The `taiko:intercept` debug logs confirmed:

```
requestPaused url=https://localhost/employees/2/address       ← CDP event fired
matched interceptor url=...                                   ← interceptor found
calling fulfillRequest (object) responseCode=200 bodyLen=44  ← response sent, NO error
--- silence for 60 seconds ---
Navigation took more than 60000ms                            ← timeout
```

`fulfillRequest` completes without errors. This is not a network or interceptor issue.

## Root cause

`goto()` calls `handleNavigation()` in `pageHandler.js`, which:

1. Waits for `requestStarted` event → stores `requestId`
2. Waits for `responseReceived` event with matching `requestId` → resolves `responsePromise`
3. `await responsePromise` — **this is where it hangs**

On Windows, when `Fetch.fulfillRequest` is used, Chrome does not always emit
`Network.responseReceived` — or emits it before `requestStarted` has set `requestId`
(race condition). As a result `responsePromise` never resolves →
`handleNavigation` never returns → `await action()` in `doActionAwaitingNavigation`
hangs → navigation timeout.

The first request (`/employees/1/address`) succeeds because `Network.responseReceived`
arrives before the race window. The second request loses the race due to slightly
different Chrome internal state after the first navigation completes.

## Implementation

### Change 1 — `packages/taiko/lib/handlers/fetchHandler.js`

After a successful `fulfillRequest` for a Document resource, emit a synthetic
`responseReceived` event. This guarantees `responsePromise` in `handleNavigation`
gets the signal even if Chrome skips `Network.responseReceived` on Windows.

```js
case isObject(interceptor.action):
  options = mockResponse(interceptor.action, options);
  logIntercept(
    "calling fulfillRequest (object) for url=%s responseCode=%d bodyLen=%d",
    p.request.url,
    options.responseCode,
    options.body ? options.body.length : 0,
  );
  fetch.fulfillRequest(options)
    .then(() => {
      // Emit synthetic responseReceived for Document navigations so that
      // handleNavigation's responsePromise resolves on Windows where Chrome
      // sometimes skips Network.responseReceived after Fetch.fulfillRequest.
      if (p.resourceType === "Document") {
        logIntercept(
          "emitting synthetic responseReceived for url=%s",
          p.request.url,
        );
        eventHandler.emit("responseReceived", {
          requestId: p.networkId,
          response: {
            url: p.request.url,
            status: options.responseCode,
            statusText: options.responsePhrase || "",
          },
        });
      }
    })
    .catch(() => warnInterceptFailed(p));
  break;
```

**Key detail:** `p.networkId` is the `Network.RequestId` from `Fetch.requestPaused`.
It matches the `requestId` that `handleNavigation` stores from `requestStarted`.
If Chrome also sends the real `Network.responseReceived`, the second `resolveResponse`
call is a no-op (Promise already resolved).

`eventHandler` is already imported at the top of `fetchHandler.js`.

### Change 2 — `packages/taiko/lib/handlers/pageHandler.js` (defensive fallback)

Add a URL-based fallback inside `handleResponseStatus` for the case where `requestId`
is still `undefined` when `responseReceived` arrives (the `requestStarted` /
`responseReceived` ordering race on Windows):

```js
// before:
const handleResponseStatus = (response) => {
  if (requestId === response.requestId) {
    resolveResponse(response.response);
  }
};

// after:
const handleResponseStatus = (response) => {
  if (requestId === response.requestId) {
    resolveResponse(response.response);
  } else if (
    !requestId &&
    response.response &&
    isSameUrl(response.response.url, urlToNavigate)
  ) {
    resolveResponse(response.response);
  }
};
```

## Files to modify

| File | Location | Change |
|---|---|---|
| `packages/taiko/lib/handlers/fetchHandler.js` | `case isObject` block (~line 113) | Add `.then()` after `fulfillRequest` that emits `responseReceived` |
| `packages/taiko/lib/handlers/pageHandler.js` | `handleResponseStatus` (~line 198) | URL-based fallback when `requestId` not yet set |

## Context: how navigation waiting works

```
goto(url)
  └─ doActionAwaitingNavigation        [registers frameEvent/xhrEvent listeners]
       └─ await action()
            └─ handleNavigation(url)   [pageHandler.js:161]
                 ├─ listen requestStarted  → set requestId
                 ├─ listen responseReceived → resolveResponse when requestId matches
                 ├─ page.navigate(url)
                 └─ await responsePromise  ← HANGS HERE on Windows
```

Relevant files:
- `doActionAwaitingNavigation.js:62` — where `await action()` blocks
- `pageHandler.js:161–228` — `handleNavigation`, where `responsePromise` stalls
- `eventBus.js` — `eventHandler` EventEmitter used for all inter-handler events
- CDP `Fetch.requestPaused` event fields: `networkId`, `resourceType`, `request.url`

## Verification

1. Unit tests: `npm run test:unit:silent`
2. Intercept unit tests only: `npx mocha tests/unit-tests/intercept.test.js --reporter spec`
3. Add a unit test that verifies `responseReceived` is emitted after `fulfillRequest`
   for a Document resource
4. Push to `debug/intercept-logging` — CI runs 5 parallel Windows jobs
5. Expected: all 5 green
