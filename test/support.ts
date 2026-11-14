import { DatabaseSync } from "node:sqlite";
import type { BetterAuthOptions } from "@better-auth/core";
import { getAuthTables } from "better-auth/db";
import {
	createNeoOrmClientFromSqlite,
	diffManifest,
	emptyManifest,
	resolveMigrationSql,
	schemaToManifest,
	sqliteDialect,
} from "neoorm";
import * as neoormSchema from "neoorm/schema";
import { generateNeoOrmSchema } from "../src/create-schema.js";
import type { NeoOrmClientLike } from "../src/types.js";

/**
 * Run the generated schema module in-memory against the real NeoORM schema
 * builders and return the resulting schema definition.
 */
type GeneratedSchema = neoormSchema.SchemaDef<
	Record<string, neoormSchema.TableDef>
>;

function evaluateGeneratedSchema(code: string): GeneratedSchema {
	const importMatch = /^import \{([^}]+)\} from "neoorm\/schema";\s*$/m.exec(
		code,
	);
	if (!importMatch?.[1]) {
		throw new Error("Generated schema is missing the neoorm/schema import");
	}
	const names = importMatch[1]
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const body = code
		.replace(importMatch[0], "")
		.replace("export const schema =", "return");

	const builder = new Function(...names, body) as (
		...args: unknown[]
	) => GeneratedSchema;
	const args = names.map(
		(name) => (neoormSchema as Record<string, unknown>)[name],
	);
	return builder(...args);
}

export type TestDatabaseOptions = {
	usePlural?: boolean;
};

/** Create a harness that owns a fresh SQLite database per migration. */
export function createTestDatabase(options: TestDatabaseOptions = {}) {
	let currentDb: DatabaseSync | undefined;
	let currentClient: NeoOrmClientLike | undefined;

	const runMigrations = (authOptions: BetterAuthOptions): void => {
		const tables = getAuthTables(authOptions);
		const schema = evaluateGeneratedSchema(
			generateNeoOrmSchema(tables, {
				modelName: (model) => {
					const name = tables[model]?.modelName ?? model;
					return options.usePlural ? `${name}s` : name;
				},
			}),
		);
		const manifest = schemaToManifest(schema);

		const base = emptyManifest();
		const diff = diffManifest(base, manifest, sqliteDialect);
		const { sql, blocked } = resolveMigrationSql(
			diff,
			base,
			manifest,
			true,
			sqliteDialect,
		);
		if (blocked.length > 0) {
			throw new Error(
				`Destination schema is blocked: ${blocked
					.map((change) => change.kind)
					.join(", ")}`,
			);
		}

		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = OFF");
		for (const statement of sql) {
			db.exec(statement);
		}

		currentDb?.close();
		currentDb = db;
		currentClient = createNeoOrmClientFromSqlite(
			manifest,
			db,
		) as NeoOrmClientLike;
	};

	const getClient = (): NeoOrmClientLike => {
		if (!currentClient) {
			throw new Error("runMigrations() has not been called yet");
		}
		return currentClient;
	};

	const close = (): void => {
		currentDb?.close();
		currentDb = undefined;
		currentClient = undefined;
	};

	return { runMigrations, getClient, close };
}
