# @workspacekit/core (test fixture)

A trimmed copy of the generated API page: only the sections that llms.mjs reads.

#### FileSystemAdapter

The storage behind the explorer. Only `list` and `read` are required; every other capability is optional
and the UI hides what an adapter cannot do.

##### Example

```ts
const adapter: FileSystemAdapter = httpAdapter('/api/files');
const entries = await adapter.list('', { depth: 2 });
```

##### Properties

###### upload?

> `optional` **upload?**: [`UploadTransport`](#uploadtransport)

##### Methods

###### copy()?

> `optional` **copy**(`from`, `to`, `opts?`): `Promise`\<[`Entry`](#entry-1)\>

###### Parameters

###### from

`string`

###### to

`string`

###### opts?

[`TransferOptions`](#transferoptions)

###### Returns

`Promise`\<[`Entry`](#entry-1)\>

###### create()?

> `optional` **create**(`path`, `kind`): `Promise`\<[`Entry`](#entry-1)\>

###### Parameters

###### path

`string`

###### kind

[`EntryKind`](#entrykind-1)

###### Returns

`Promise`\<[`Entry`](#entry-1)\>

###### delete()?

> `optional` **delete**(`path`): `Promise`\<`void`\>

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`void`\>

###### download()?

> `optional` **download**(`paths`): `Promise`\<`Blob` \| \{ `fileName?`: `string`; `url`: `string`; \}\>

###### Parameters

###### paths

`string`[]

###### Returns

`Promise`\<`Blob` \| \{ `fileName?`: `string`; `url`: `string`; \}\>

###### list()

> **list**(`path`, `opts`): `Promise`\<[`Entry`](#entry-1)[]\>

###### Parameters

###### path

`string`

###### opts

`object` & [`CallOptions`](#calloptions)

###### Returns

`Promise`\<[`Entry`](#entry-1)[]\>

###### move()?

> `optional` **move**(`from`, `to`, `opts?`): `Promise`\<[`Entry`](#entry-1)\>

###### Parameters

###### from

`string`

###### to

`string`

###### opts?

[`TransferOptions`](#transferoptions)

###### Returns

`Promise`\<[`Entry`](#entry-1)\>

###### read()

###### Call Signature

> **read**(`path`, `as`, `opts?`): `Promise`\<`string`\>

###### Parameters

###### path

`string`

###### as

`"text"`

###### opts?

[`CallOptions`](#calloptions)

###### Returns

`Promise`\<`string`\>

###### Call Signature

> **read**(`path`, `as`, `opts?`): `Promise`\<`Blob`\>

###### Parameters

###### path

`string`

###### as

`"blob"`

###### opts?

[`CallOptions`](#calloptions)

###### Returns

`Promise`\<`Blob`\>

###### Call Signature

> **read**(`path`, `as`, `opts?`): `Promise`\<`ArrayBuffer`\>

###### Parameters

###### path

`string`

###### as

`"arrayBuffer"`

###### opts?

[`CallOptions`](#calloptions)

###### Returns

`Promise`\<`ArrayBuffer`\>

###### search()?

> `optional` **search**(`query`, `opts?`): `Promise`\<[`Entry`](#entry-1)[]\>

###### Parameters

###### query

`string`

###### opts?

[`CallOptions`](#calloptions)

###### Returns

`Promise`\<[`Entry`](#entry-1)[]\>

###### stat()?

> `optional` **stat**(`path`, `opts?`): `Promise`\<[`Entry`](#entry-1) \| `null`\>

###### Parameters

###### path

`string`

###### opts?

[`CallOptions`](#calloptions)

###### Returns

`Promise`\<[`Entry`](#entry-1) \| `null`\>

###### url()?

> `optional` **url**(`entry`): `string` \| \{ `url`: `string`; `withCredentials?`: `boolean`; \}

###### Parameters

###### entry

[`Entry`](#entry-1)

###### Returns

`string` \| \{ `url`: `string`; `withCredentials?`: `boolean`; \}

###### watch()?

> `optional` **watch**(`onChange`): () => `void`

Delivers batches of events, so a burst of changes costs one render.

###### Parameters

###### onChange

(`events`) => `void`

###### Returns

() => `void`

###### write()?

> `optional` **write**(`path`, `text`, `opts?`): `Promise`\<[`Entry`](#entry-1)\>

###### Parameters

###### path

`string`

###### text

`string`

###### opts?

###### expectedMtimeMs?

`number`

###### Returns

`Promise`\<[`Entry`](#entry-1)\>


***

#### Entry

One file or directory, addressed by its normalized path (`/`-separated, no leading slash, root `''`).

##### Example

```ts
const entry: Entry = {
  path: 'src/main.ts',
  name: 'main.ts',
  kind: 'file',
  size: 120,
  mtimeMs: Date.now(),
};
```

##### Extended by

- [`FileInfo`](/api/react#fileinfo)

##### Properties

###### kind

> **kind**: [`EntryKind`](#entrykind-1)

###### meta?

> `optional` **meta?**: `Record`\<`string`, `unknown`\>

###### mtimeMs?

> `optional` **mtimeMs?**: `number`

###### name

> **name**: `string`

###### path

> **path**: `string`

###### size?

> `optional` **size?**: `number` \| `null`


***

#### EntryKind

> **EntryKind** = `"file"` \| `"directory"`

Whether an entry is a file or a directory.

##### Example

```ts
const kind: EntryKind = entry.kind;
```


***

#### CallOptions

Options every read accepts: an `AbortSignal` that cancels the request.

##### Example

```ts
await adapter.list('src', { depth: 1, signal: controller.signal });
```

##### Properties

###### signal?

> `optional` **signal?**: `AbortSignal`


***

#### TransferOptions

Options for `move` and `copy`: `overwrite` replaces an existing destination instead of failing with
`conflict`.

##### Example

```ts
await adapter.move?.('a.txt', 'b.txt', { overwrite: true });
```

##### Extended by

- [`TreeTransferOptions`](#treetransferoptions)

##### Properties

###### overwrite?

> `optional` **overwrite?**: `boolean`


***

#### ChangeEvent

One change reported by `FileSystemAdapter.watch`. `actor` is `'user'` for changes made through this client.

##### Example

```ts
adapter.watch?.((events) => events.filter((event) => event.type === 'deleted').forEach(forget));
```

##### Properties

###### actor?

> `optional` **actor?**: `string`

###### entry?

> `optional` **entry?**: [`Entry`](#entry-1)

created, updated, moved: the entry as it now exists; the store upserts it instead of reloading the
parent.

###### mtimeMs?

> `optional` **mtimeMs?**: `number`

###### oldPath?

> `optional` **oldPath?**: `string`

###### path

> **path**: `string`

###### type

> **type**: `"created"` \| `"updated"` \| `"deleted"` \| `"moved"` \| `"resync"`

`resync` (with `path` `''`): changes were missed; the client must reload every loaded folder.


***

#### FsError

The one error type every adapter, store and handler throws. `path` names the entry the failure concerns.

##### Example

```ts
throw new FsError('not_found', `not found: ${path}`, { path });
```

##### Extends

- `Error`

##### Constructors

###### Constructor

> **new FsError**(`kind`, `message?`, `opts?`): [`FsError`](#fserror)

###### Parameters

###### kind

[`FsErrorKind`](#fserrorkind-1)

###### message?

`string`

###### opts?

###### cause?

`unknown`

###### path?

`string`

###### status?

`number`

###### Returns

[`FsError`](#fserror)

###### Overrides

`Error.constructor`

##### Properties

###### cause?

> `optional` **cause?**: `unknown`

###### Inherited from

`Error.cause`

###### kind

> **kind**: [`FsErrorKind`](#fserrorkind-1)

What went wrong.

###### message

> **message**: `string`

###### Inherited from

`Error.message`

###### name

> **name**: `string`

###### Inherited from

`Error.name`

###### path?

> `optional` **path?**: `string`

The entry the failure concerns, when there is one.

###### stack?

> `optional` **stack?**: `string`

###### Inherited from

`Error.stack`

###### status?

> `optional` **status?**: `number`

The HTTP status, when the error came from a response.

###### stackTraceLimit

> `static` **stackTraceLimit**: `number`

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

###### Inherited from

`Error.stackTraceLimit`

##### Methods

###### captureStackTrace()

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

###### Parameters

###### targetObject

`object`

###### constructorOpt?

`Function`

###### Returns

`void`

###### Inherited from

`Error.captureStackTrace`

###### prepareStackTrace()

> `static` **prepareStackTrace**(`err`, `stackTraces`): `any`

###### Parameters

###### err

`Error`

###### stackTraces

`CallSite`[]

###### Returns

`any`

###### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

###### Inherited from

`Error.prepareStackTrace`

### Interfaces

#### CallOptions

Options every read accepts: an `AbortSignal` that cancels the request.

##### Example

```ts
await adapter.list('src', { depth: 1, signal: controller.signal });
```

##### Properties

###### signal?

> `optional` **signal?**: `AbortSignal`


***

#### FsErrorKind

> **FsErrorKind** = `"not_found"` \| `"conflict"` \| `"forbidden"` \| `"too_large"` \| `"invalid"` \| `"network"` \| `"timeout"` \| `"cancelled"` \| `"unknown"`

What went wrong, independent of transport. HTTP statuses map to kinds through `kindForStatus`.

##### Example

```ts
if (error.kind === 'conflict') askToOverwrite();
```


***

#### normalizePath()

Canonical form: NFC, `/`-separated, no leading/trailing slash, no `.`/`..`. Root is `''`.

***

#### joinPath()

Joins path parts and normalizes the result.

***

#### resolveUnder()

Join an untrusted relative path onto `base`; throws `forbidden` if the result leaves `base`.

***

#### parentPath()

The parent folder's path; `''` for top-level entries and for the root.

***

#### basename()

The last path segment.

***

#### extname()

Lowercase, no dot; `''` for dotfiles and extensionless names.

***

#### depthOf()

How many segments a path has; the root `''` has depth 0.

***

#### isSameOrDescendant()

Whether `path` is `ancestor` or lies below it. Every path lies below the root `''`.

***

#### remapPrefix()

Moves `path` from below `from` to below `to`; paths outside `from` are returned unchanged.

***

#### isFsError()

Whether `error` is an `FsError`.

***

#### toFsError()

Converts anything thrown into an `FsError`: aborts become `cancelled`, fetch network failures (`TypeError`)

***

#### statusForKind()

The HTTP status the server answers for an error kind (500 for kinds without one).

***

#### kindForStatus()

The error kind for an HTTP status (401 and 403 are both `forbidden`, 408 and 504 `timeout`).

***
