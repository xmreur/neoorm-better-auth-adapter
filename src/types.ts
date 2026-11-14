import type { DBAdapterDebugLogOption } from "@better-auth/core/db/adapter";

/**
 * Structural type of a NeoORM client as used by this adapter.
 *
 * It is intentionally loose: generated NeoORM clients are generic over their
 * schema, and the adapter only relies on the shared repository surface.
 */
export type NeoOrmClientLike = {
	// biome-ignore lint/suspicious/noExplicitAny: mirrors NeoORM's generic overloads
	$transaction: (fn: (tx: any) => Promise<any>) => Promise<any>;
} & {
	[accessor: string]: any;
};

/** Options accepted by {@link neoormAdapter}. */
export type NeoOrmAdapterOptions = {
	/**
	 * Use plural model names (`user` → `users`).
	 *
	 * Must match the accessor names of your NeoORM schema. When your generated
	 * schema uses plural accessors (`users`, `sessions`, …) enable this.
	 *
	 * @default false
	 */
	usePlural?: boolean | undefined;
	/**
	 * Enable Better Auth adapter debug logs.
	 *
	 * @default false
	 */
	debugLogs?: DBAdapterDebugLogOption | undefined;
	/**
	 * Wrap Better Auth's multi-step operations in `client.$transaction`.
	 *
	 * @default true
	 */
	transaction?: boolean | undefined;
	/**
	 * Map a Better Auth model name to a different NeoORM client accessor.
	 *
	 * ```ts
	 * modelName: (model) => (model === "session" ? "userSessions" : model),
	 * ```
	 */
	modelName?: ((model: string) => string) | undefined;
	/**
	 * Output path used by Better Auth's `generate` command.
	 *
	 * When omitted, the path is `schema` from `neoorm.config.ts`. The CLI
	 * file argument is used only when that config is absent.
	 */
	schemaPath?: string | undefined;
};

/** A row returned by NeoORM. */
export type NeoOrmRow = Record<string, unknown>;

/** Arguments accepted by NeoORM `findFirst` / `findMany`. */
export type NeoOrmFindArgs = {
	where?: Record<string, unknown> | undefined;
	orderBy?: Record<string, "asc" | "desc"> | undefined;
	take?: number | undefined;
	skip?: number | undefined;
	includeHidden?: boolean | undefined;
};

/** The subset of a NeoORM table repository used by the adapter. */
export type NeoOrmTableAccessor = {
	findFirst(args?: NeoOrmFindArgs): Promise<NeoOrmRow | null>;
	findMany(args?: NeoOrmFindArgs): Promise<NeoOrmRow[]>;
	create(args: {
		data: Record<string, unknown>;
		returnCreated?: boolean | undefined;
	}): Promise<NeoOrmRow>;
	updateMany(args: {
		where?: Record<string, unknown> | undefined;
		data: Record<string, unknown>;
	}): Promise<number>;
	updateManyAndReturn(args: {
		where?: Record<string, unknown> | undefined;
		data: Record<string, unknown>;
	}): Promise<NeoOrmRow[]>;
	deleteMany(args?: {
		where?: Record<string, unknown> | undefined;
	}): Promise<number>;
	count(args?: {
		where?: Record<string, unknown> | undefined;
	}): Promise<number | Record<string, number>>;
};
