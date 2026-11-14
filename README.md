# neoorm-better-auth-adapter

Better Auth database adapter for [NeoORM](https://github.com/xmreur/neoorm). It runs Better Auth's queries through a NeoORM client and can generate the NeoORM schema those tables need.

PostgreSQL, SQLite, MySQL, and MariaDB all work. The adapter talks to the NeoORM client, so the database is whichever one that client is connected to.

Requires Node.js 22.5 or newer, or Bun.

## Install

```bash
bun add neoorm-better-auth-adapter neoorm better-auth
```

`@better-auth/core` and `neoorm` are peer dependencies. `better-auth` brings in `@better-auth/core`.

## Use

Generate a NeoORM client first (see [Schema](#schema)), then pass it to Better Auth:

```ts
import { betterAuth } from "better-auth";
import { createNeoOrmClient } from "neoorm";
import { neoormAdapter } from "neoorm-better-auth-adapter";
import { manifest } from "./neoorm/manifest.js";

const db = createNeoOrmClient(manifest, {
	connectionString: process.env.DATABASE_URL!,
});

export const auth = betterAuth({
	database: neoormAdapter(db),
	emailAndPassword: {
		enabled: true,
	},
});
```

You can pass a function instead of a client. The adapter calls it on every operation, which is what you want when tests rebuild the client:

```ts
database: neoormAdapter(() => db);
```

Accessor names on the client must be the Better Auth model names. The defaults are singular: `user`, `session`, `account`, `verification`.

### Plural accessors

Turn on `usePlural` when the NeoORM schema uses `users`, `sessions`, `accounts`, and `verifications`:

```ts
database: neoormAdapter(db, { usePlural: true });
```

Generate the schema with the same option. The CLI reads it from the adapter in your Better Auth config.

### Custom accessor names

`modelName` maps a Better Auth model to a different client accessor. It runs after pluralization.

```ts
database: neoormAdapter(db, {
	modelName: (model) => (model === "session" ? "userSessions" : model),
});
```

## Schema

Better Auth writes its tables into the schema file from `neoorm.config.ts`. Set the adapter up first, then generate:

```bash
npx @better-auth/cli generate
```

```ts
// neoorm.config.ts
import { defineConfig } from "neoorm";

export default defineConfig({
	schema: "./schema.ts",
	out: "./neoorm",
	datasource: {
		provider: "postgresql",
		url: process.env.DATABASE_URL!,
	},
});
```

`schema` is where the tables are written. Pass `schemaPath` to the adapter when that file should be somewhere else. The path given to the Better Auth CLI is used only when `neoorm.config.ts` is not there.

If `schema.ts` already exists, generation keeps your other tables and the `defineSchema` options. Auth tables are refreshed between `// better-auth:start` and `// better-auth:end`. A missing file is created at the config path.

```bash
bunx neoorm migrate dev
```

`neoorm generate` builds the typed client. `migrate dev` does that and applies the SQL. Import `manifest` from the generated output and create the client as in [Use](#use).

A generated table looks like this:

```ts
import { defineSchema, fk, table, text, timestamp } from "neoorm/schema";

export const schema = defineSchema({
	// better-auth:start
	user: table({
		id: text().primary(),
		email: text().notNull().unique(),
		createdAt: timestamp().notNull(),
		updatedAt: timestamp().notNull(),
	}),
	session: table({
		id: text().primary(),
		token: text().notNull().unique(),
		userId: fk("user.id")
			.as("user")
			.inverse("session_user")
			.notNull()
			.index()
			.onDelete("cascade"),
	}),
	// better-auth:end
});
```

The real file includes every model and field from your Better Auth config, including plugin tables. Re-run `npx @better-auth/cli generate` after you change that config.

You can also call `generateNeoOrmSchema` yourself. Pass the tables from `getAuthTables` in `better-auth/db`.

### Names

Schema property names are Better Auth's physical field names (`userId`, `email`, or a name you set with `fields`). NeoORM's `columnNaming` turns those into SQL names. The default is snake case, so a `userId` property becomes a `user_id` column. The client and this adapter keep using `userId`.

Foreign keys point at the referenced column (`fk("user.id")`, or `fk("user.email_address")` when that field is renamed). Each foreign key gets a relation name and an inverse name:

- A column ending in `Id` uses the prefix as the relation (`userId` → `user`).
- Any other column gets a `Rel` suffix (`one_to_one` → `one_to_oneRel`), so the relation does not shadow the column. NeoORM treats a filter on a relation name as a nested relation filter.
- The inverse is `{table}_{relation}` (`session_user`), so several tables can reference the same parent.

`onDelete` follows the Better Auth field. When the field does not set one, the generator writes `cascade`, same as the Drizzle adapter. NeoORM has no `set default` action, so a reference that asks for it is generated without an `onDelete` clause.

Models with `disableMigrations` are skipped. Composite indexes from the Better Auth schema are emitted as NeoORM table extras.

## Options

| Option        | Default                          |                                                                    |
| ------------- | -------------------------------- | ------------------------------------------------------------------ |
| `usePlural`   | `false`                          | Use plural accessors (`user` → `users`). Must match the schema.    |
| `modelName`   |                                  | Map a model name to a client accessor.                             |
| `transaction` | `true`                           | Wrap Better Auth's multi-step operations in `client.$transaction`. |
| `debugLogs`   |                                  | Better Auth adapter debug logs.                                    |
| `schemaPath`  | `schema` from `neoorm.config.ts` | Path written by `npx @better-auth/cli generate`.                   |

## Behavior

The adapter implements create, find, update, delete, and count on the NeoORM repository methods (`create`, `findFirst`, `findMany`, `updateMany`, `updateManyAndReturn`, `deleteMany`, `count`). Reads use `includeHidden: true`, so columns marked `.hidden()` (a password, for example) are still returned to Better Auth.

Transactions are on by default. The callback receives a NeoORM transaction client, and the nested adapter uses that client. Set `transaction: false` to run the steps sequentially.

Ids are text. Numeric ids (`generateId: "serial"`) are not supported. Dates, booleans, JSON, and arrays are stored with NeoORM's `timestamp`, `bool`, `jsonb`, `textArray`, and `intArray` columns. A `bigint` read back from the database is converted to a `number`, which is what Better Auth's number fields expect.

Where clauses support `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with`, and `ends_with`, including `mode: "insensitive"`. Case-insensitive `in` and `not_in` are expanded into an `OR` of equalities, because NeoORM does not apply `mode` to `in` / `notIn`.

Joins are returned fully populated. Better Auth loads each related model with its own query and attaches it to the parent, including when `advanced.database.joins` is enabled. Each join is a separate query.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```

`bun test` runs the Better Auth adapter suites (normal, joins, case-insensitive, transactions, and auth flow) against an in-memory SQLite database, once with singular accessors and once with plural accessors.

## Releasing

Bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

`.github/workflows/publish.yml` publishes that tag to npm. The workflow uses npm trusted publishing (GitHub Actions OIDC). On the package's npm Access settings, add a trusted publisher for repository `xmreur/neoorm-better-auth-adapter`, workflow `publish.yml`. An `NPM_TOKEN` repository secret also works if it is set; leave it unset when using a trusted publisher.

## License

MIT
