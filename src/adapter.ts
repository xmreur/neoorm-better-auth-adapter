import { readFile } from "node:fs/promises";
import type { BetterAuthOptions } from "@better-auth/core";
import type { BetterAuthDBSchema } from "@better-auth/core/db";
import {
	type AdapterFactoryCustomizeAdapterCreator,
	createAdapterFactory,
	type DBAdapter,
} from "@better-auth/core/db/adapter";
import { buildNeoOrmSchema, renderNeoOrmSchema } from "./create-schema.js";
import { mergeAuthSchema, resolveSchemaOutputPath } from "./schema-file.js";
import type {
	NeoOrmAdapterOptions,
	NeoOrmClientLike,
	NeoOrmFindArgs,
	NeoOrmRow,
	NeoOrmTableAccessor,
} from "./types.js";
import { convertWhere } from "./where.js";

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

const ADAPTER_ID = "neoorm";

function missingTableError(model: string, accessor: string, client: object) {
	const available = Object.keys(client)
		.filter((key) => !key.startsWith("$"))
		.sort();
	return new Error(
		`[neoorm-better-auth-adapter] The NeoORM client has no table accessor "${accessor}" for the Better Auth model "${model}". ` +
			`Available accessors: ${available.length > 0 ? available.join(", ") : "(none)"}. ` +
			"Check that your NeoORM schema defines this table, or use the `modelName` adapter option to map it.",
	);
}

function affectedCount(
	result: number | Record<string, number>,
	operation: string,
): number {
	if (typeof result === "number") return result;
	const first = Object.values(result)[0];
	if (typeof first === "number") return first;
	throw new Error(
		`[neoorm-better-auth-adapter] ${operation} did not return a row count.`,
	);
}

const createCustomAdapter = (
	getClient: () => NeoOrmClientLike,
	adapterOptions: NeoOrmAdapterOptions,
): AdapterFactoryCustomizeAdapterCreator => {
	return ({ getFieldName, getModelName }) => {
		const resolveAccessor = (model: string): string =>
			adapterOptions.modelName?.(model) ?? model;

		const table = (model: string): NeoOrmTableAccessor => {
			const client = getClient();
			const accessor = resolveAccessor(model);
			const repository = client[accessor];
			if (!repository) throw missingTableError(model, accessor, client);
			return repository as NeoOrmTableAccessor;
		};

		/** Re-read a row by primary key so hidden columns are included. */
		const refetch = async (
			repository: NeoOrmTableAccessor,
			row: NeoOrmRow | undefined,
			fallback: NeoOrmRow | null,
		): Promise<NeoOrmRow | null> => {
			const id = row?.id;
			if (id === undefined || id === null) return fallback;
			const full = await repository.findFirst({
				where: { id },
				includeHidden: true,
			});
			return full ?? fallback;
		};

		return {
			async create({ model, data }) {
				const repository = table(model);
				const created = (await repository.create({
					data,
					returnCreated: true,
				})) as NeoOrmRow;
				const full = await refetch(repository, created, created);
				return (full ?? created) as typeof data;
			},

			async findOne({ model, where }) {
				const repository = table(model);
				const clause = convertWhere(where);
				const args: NeoOrmFindArgs = { includeHidden: true };
				if (clause) args.where = clause;
				const row = await repository.findFirst(args);
				// biome-ignore lint/suspicious/noExplicitAny: CustomAdapter#findOne is generic
				return (row ?? null) as any;
			},

			async findMany({
				model,
				modelKey,
				where,
				limit,
				offset,
				select,
				sortBy,
			}) {
				const repository = table(model);
				const args: NeoOrmFindArgs = { includeHidden: true };
				const clause = convertWhere(where);
				if (clause) args.where = clause;
				if (typeof limit === "number") args.take = limit;
				if (typeof offset === "number") args.skip = offset;
				if (sortBy?.field) {
					// Better Auth does not map `sortBy.field`, so resolve the
					// physical field name ourselves.
					const field = getFieldName({
						model: modelKey ?? model,
						field: sortBy.field,
					});
					args.orderBy = { [field]: sortBy.direction ?? "asc" };
				}
				const rows = await repository.findMany(args);
				if (!select || select.length === 0) return rows as any;
				// The factory only applies `select` to `findOne`, so project here.
				const projection = select.map((field) =>
					getFieldName({ model: modelKey ?? model, field }),
				);
				return rows.map((row) =>
					Object.fromEntries(
						projection
							.filter((field) => field in row)
							.map((field) => [field, row[field]]),
					),
				) as any;
			},

			async update({ model, where, update }) {
				const repository = table(model);
				const clause = convertWhere(where);
				if (!clause) return null;
				const rows = await repository.updateManyAndReturn({
					where: clause,
					data: update as Record<string, unknown>,
				});
				const updated = rows[0];
				if (!updated) return null;
				return (await refetch(
					repository,
					updated,
					updated,
				)) as typeof update;
			},

			async updateMany({ model, where, update }) {
				const repository = table(model);
				const clause = convertWhere(where);
				const result = await repository.updateMany(
					clause ? { where: clause, data: update } : { data: update },
				);
				return affectedCount(result, "updateMany");
			},

			async delete({ model, where }) {
				const repository = table(model);
				const clause = convertWhere(where);
				await repository.deleteMany(clause ? { where: clause } : {});
			},

			async deleteMany({ model, where }) {
				const repository = table(model);
				const clause = convertWhere(where);
				const result = await repository.deleteMany(
					clause ? { where: clause } : {},
				);
				return affectedCount(result, "deleteMany");
			},

			async count({ model, where }) {
				const repository = table(model);
				const clause = convertWhere(where);
				const result = clause
					? await repository.count({ where: clause })
					: await repository.count();
				return affectedCount(result, "count");
			},

			async createSchema({ file, tables }) {
				const parts = buildNeoOrmSchema(tables as BetterAuthDBSchema, {
					modelName: (model) => resolveAccessor(getModelName(model)),
					fieldName: (model, field) => getFieldName({ model, field }),
				});
				const path = await resolveSchemaOutputPath({
					schemaPath: adapterOptions.schemaPath,
					cliFile: file,
				});
				let code = renderNeoOrmSchema(parts);
				try {
					const existing = await readFile(path, "utf8");
					code = mergeAuthSchema(existing, parts);
				} catch (error) {
					if (!isMissingFile(error)) throw error;
				}
				return { code, path };
			},
		};
	};
};

/**
 * Create a Better Auth database adapter backed by a NeoORM client.
 *
 * @param db - A NeoORM client, or a function returning the current client
 *   (useful when the client is rebuilt, e.g. in tests).
 *
 * @example
 * ```ts
 * betterAuth({
 *   database: neoormAdapter(db, { usePlural: true }),
 * });
 * ```
 */
export function neoormAdapter(
	db: NeoOrmClientLike | (() => NeoOrmClientLike),
	adapterOptions: NeoOrmAdapterOptions = {},
): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
	const getClient = (): NeoOrmClientLike => {
		const client = typeof db === "function" ? db() : db;
		if (!client) {
			throw new Error(
				"[neoorm-better-auth-adapter] The NeoORM client is not available. If you passed a function, make sure it returns a client.",
			);
		}
		return client;
	};

	let lazyOptions: BetterAuthOptions | undefined;

	const createFactory = (
		client: () => NeoOrmClientLike,
		transactions: boolean,
	): ((options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>) =>
		createAdapterFactory<BetterAuthOptions>({
			config: {
				adapterId: ADAPTER_ID,
				adapterName: "NeoORM Adapter",
				usePlural: adapterOptions.usePlural ?? false,
				...(adapterOptions.debugLogs !== undefined
					? { debugLogs: adapterOptions.debugLogs }
					: {}),
				supportsBooleans: true,
				supportsDates: true,
				supportsJSON: true,
				supportsArrays: true,
				supportsUUIDs: false,
				supportsNumericIds: false,
				transaction: transactions
					? (callback) =>
							client().$transaction((tx) =>
								callback(
									createFactory(
										() => tx as NeoOrmClientLike,
										false,
									)(lazyOptions as BetterAuthOptions),
								),
							)
					: false,
				// NeoORM can store bigints end-to-end, but Better Auth's
				// `number` fields expect `number` values.
				customTransformOutput: ({ data }) =>
					typeof data === "bigint" ? Number(data) : data,
			},
			adapter: createCustomAdapter(client, adapterOptions),
		});

	const factory = createFactory(
		getClient,
		adapterOptions.transaction !== false,
	);

	return (options: BetterAuthOptions) => {
		lazyOptions = options;
		return factory(options);
	};
}
